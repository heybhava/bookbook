// /api/auth/*, /api/account (public + session endpoints), request authentication and CSRF helpers used by the main dispatcher.
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { NextRequest } from 'next/server';
import { sget, sall, srun, sha256, randomToken, rateLimit, rateCount, rateRecord, rateClear, audit, purgeOld } from './sysdb';
import { cfg, hostAllowed } from './config';
import { hashPassword, verifyPassword, burnTime, passwordProblem, emailValid } from './password';
import { createSession, lookupSession, revokeSession, revokeAll, listSessions, revokeByRef, parseCookies, SESSION_COOKIE, CSRF_COOKIE, sessionCookies, clearCookies, type Account, type SessionInfo } from './session';
import { sendMail, mailConfigured, readOutbox, linkBase } from './mail';
import { userDir, DATA_DIR } from '../tenant';
import { closeTenantDb } from '../db';
import { ensureLegacyImported } from '../legacy';

export const clientIp = (req: Request): string => (cfg.trustProxy ? (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown' : 'direct');
const json = (data: unknown, status = 200, cookies: string[] = [], extra: Record<string, string> = {}) => { const h = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }); for (const c of cookies) h.append('set-cookie', c); return new Response(JSON.stringify(data), { status, headers: h }); };
const err = (msg: string, status = 400, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => json({ error: msg, ...extra }, status, [], headers);
const limited = (r: { retryAfterSec: number }) => err('Too many attempts. Try again later.', 429, { retryAfterSec: r.retryAfterSec }, { 'retry-after': String(r.retryAfterSec) });

export interface AuthCtx { account: Account; session: SessionInfo }
export function authenticate(req: Request): AuthCtx | null {
  const tok = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE()]; const s = lookupSession(tok); return s ? { account: s.account, session: s.session } : null;
}
/** Origin / Fetch-Metadata check: a browser request from another site is refused even if it carries our cookie. */
export function originOk(req: Request): boolean {
  const host = req.headers.get('host'); if (!hostAllowed(host)) return false;
  const origin = req.headers.get('origin');
  if (origin && origin !== 'null') { try { const o = new URL(origin); if (!hostAllowed(o.host) || o.host.toLowerCase() !== (host ?? '').toLowerCase()) return false; } catch { return false; } }
  else if (origin === 'null') return false;
  const site = req.headers.get('sec-fetch-site'); if (site && !['same-origin', 'none'].includes(site)) return false;
  return true;
}
export function csrfOk(req: Request, a: AuthCtx): boolean {
  const t = req.headers.get('x-csrf-token') ?? ''; const want = a.session.csrf; return t.length === want.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(want));
}
export const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

const publicUser = (a: Account) => ({ id: a.id, email: a.email, name: a.name, emailVerified: !!a.email_verified, isAdmin: !!a.is_admin });
async function body(req: Request): Promise<any> { try { const t = await req.text(); return t.length > 20_000 ? {} : JSON.parse(t || '{}'); } catch { return {}; } }
const normEmail = (e: string) => e.trim().toLowerCase();

async function issueToken(accountId: string, kind: 'verify' | 'reset'): Promise<string> {
  const token = randomToken(32); srun('UPDATE tokens SET used_at = ? WHERE account_id = ? AND kind = ? AND used_at IS NULL', Date.now(), accountId, kind);
  srun('INSERT INTO tokens (id, account_id, kind, expires_at, created_at) VALUES (?,?,?,?,?)', sha256(token), accountId, kind, Date.now() + (kind === 'verify' ? 24 * 3600_000 : 3600_000), Date.now()); return token;
}
function takeToken(token: unknown, kind: string): { account_id: string } | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const t = sget<any>('SELECT * FROM tokens WHERE id = ? AND kind = ?', sha256(token), kind); if (!t || t.used_at || t.expires_at < Date.now()) return null;
  srun('UPDATE tokens SET used_at = ? WHERE id = ?', Date.now(), t.id); return { account_id: t.account_id };
}
async function startSession(req: Request, a: Account) { const s = createSession(a.id, clientIp(req), req.headers.get('user-agent')); srun('UPDATE accounts SET last_login_at = ? WHERE id = ?', Date.now(), a.id); return json({ user: publicUser(a), csrf: s.csrf }, 200, sessionCookies(s.token, s.csrf, s.maxAgeSec)); }

export async function handleAuth(req: NextRequest, path: string): Promise<Response | null> {
  const m = req.method; const ip = clientIp(req);
  if (path === '/health' && m === 'GET') return json({ ok: true });
  // Desktop app only: the Electron main process (which alone knows this launch's random secret) signs the single local owner in. Absent outside the desktop build.
  if (path === '/desktop/login' && m === 'POST') {
    const secret = process.env.FOLIO_DESKTOP_SECRET; if (!secret) return err('Not found', 404);
    const given = Buffer.from(req.headers.get('x-folio-desktop') ?? ''), want = Buffer.from(secret); if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return err('Forbidden', 403);
    let a = sget<any>('SELECT * FROM accounts ORDER BY created_at LIMIT 1'); let imported: unknown = null;
    if (!a) {
      const id = crypto.randomUUID(); srun('INSERT INTO accounts (id, email, name, password_hash, email_verified, is_admin, created_at, password_changed_at) VALUES (?,?,?,?,?,?,?,?)', id, 'owner@folio.local', 'Owner', await hashPassword(randomToken(32)), 1, 1, Date.now(), Date.now());
      a = sget<any>('SELECT * FROM accounts WHERE id = ?', id);
    }
    closeTenantDb(a.id); // Windows cannot rename/replace a database file that this process still has open
    imported = ensureLegacyImported(a.id, process.env.FOLIO_LEGACY_DATA_DIR); if (imported && (imported as any).error) console.error('legacy import failed:', (imported as any).error);
    revokeAll(a.id); // one live desktop session at a time
    const s = createSession(a.id, 'desktop', 'bookbook desktop'); srun('UPDATE accounts SET last_login_at = ? WHERE id = ?', Date.now(), a.id);
    return json({ user: publicUser(a), csrf: s.csrf, imported, cookies: sessionCookies(s.token, s.csrf, s.maxAgeSec) }, 200, sessionCookies(s.token, s.csrf, s.maxAgeSec));
  }
  if (path === '/dev/outbox' && m === 'GET') return cfg.devEndpoints ? json(readOutbox(req.nextUrl.searchParams.get('to') ?? undefined)) : err('Not found', 404);
  if (!path.startsWith('/auth/') && path !== '/account') return null;
  if (Math.random() < 0.01) { try { purgeOld(); } catch { /* housekeeping only */ } }
  const lim = rateLimit(`auth:ip:${ip}`, 240, 60_000); if (!lim.ok) return limited(lim);
  if (!SAFE.has(m) && !originOk(req)) return err('Cross-origin request blocked', 403);

  if (path === '/auth/config' && m === 'GET') return json({ registration: cfg.allowRegistration, verification: cfg.requireVerification, mail: mailConfigured() });

  if (path === '/auth/register' && m === 'POST') {
    if (!cfg.allowRegistration) return err('Registration is closed on this server.', 403);
    const r = rateLimit(`register:ip:${ip}`, 10, 3600_000); if (!r.ok) return limited(r);
    const b = await body(req); if (!emailValid(b.email)) return err('Enter a valid email address.'); const email = normEmail(b.email);
    const pp = passwordProblem(b.password, email); if (pp) return err(pp);
    if (cfg.requireVerification && !mailConfigured()) return err('This server cannot send verification email yet (SMTP_URL is not configured).', 503);
    const existing = sget<any>('SELECT id FROM accounts WHERE email = ?', email); const generic = { ok: true, needsVerification: cfg.requireVerification };
    if (existing) { await sendMail({ to: email, subject: 'bookbook sign-up attempt', text: `Someone tried to create a bookbook account with this address, but one already exists.\nIf it was you, sign in or reset your password at ${linkBase(req)}/.\nIf not, ignore this message.` }).catch(() => {}); audit('register-duplicate', existing.id, ip); return json(generic, 202); }
    const id = crypto.randomUUID(); const hash = await hashPassword(b.password); const admin = cfg.adminEmails.includes(email) ? 1 : 0;
    srun('INSERT INTO accounts (id, email, name, password_hash, email_verified, is_admin, created_at, password_changed_at) VALUES (?,?,?,?,?,?,?,?)', id, email, typeof b.name === 'string' ? b.name.trim().slice(0, 80) || null : null, hash, cfg.requireVerification ? 0 : 1, admin, Date.now(), Date.now());
    audit('register', id, ip);
    if (cfg.requireVerification) { const t = await issueToken(id, 'verify'); await sendMail({ to: email, subject: 'Verify your bookbook email', text: `Welcome to bookbook.\nConfirm your email: ${linkBase(req)}/#/auth/verify/${t}\nThis link works once and expires in 24 hours.` }); return json(generic, 202); }
    return startSession(req, sget<Account>('SELECT * FROM accounts WHERE id = ?', id)!);
  }
  if (path === '/auth/verify' && m === 'POST') {
    const t = takeToken((await body(req)).token, 'verify'); if (!t) return err('This verification link is invalid or has expired.', 400);
    srun('UPDATE accounts SET email_verified = 1 WHERE id = ?', t.account_id); audit('verify', t.account_id, ip); return json({ ok: true });
  }
  if (path === '/auth/resend' && m === 'POST') {
    const b = await body(req); const r = rateLimit(`resend:ip:${ip}`, 10, 3600_000); if (!r.ok) return limited(r);
    if (emailValid(b.email)) { const e = normEmail(b.email); const rr = rateLimit(`resend:e:${e}`, 3, 3600_000); if (!rr.ok) return limited(rr); const a = sget<any>('SELECT id, email_verified FROM accounts WHERE email = ?', e); if (a && !a.email_verified && mailConfigured()) { const t = await issueToken(a.id, 'verify'); await sendMail({ to: e, subject: 'Verify your bookbook email', text: `Confirm your email: ${linkBase(req)}/#/auth/verify/${t}` }).catch(() => {}); } }
    return json({ ok: true }, 202);
  }
  if (path === '/auth/login' && m === 'POST') {
    const b = await body(req); if (typeof b.email !== 'string' || typeof b.password !== 'string' || !b.email || b.password.length > 200) return err('Email and password required.');
    const email = normEmail(b.email); const ipl = rateLimit(`login:ip:${ip}`, 60, 15 * 60_000); if (!ipl.ok) return limited(ipl);
    const fails = rateCount(`login:fail:${email}`, 15 * 60_000); if (fails >= 8) return limited({ retryAfterSec: 15 * 60 });
    const a = sget<any>('SELECT * FROM accounts WHERE email = ?', email);
    const ok = a ? await verifyPassword(b.password, a.password_hash) : (await burnTime(b.password), false);
    if (!ok || a.disabled) { rateRecord(`login:fail:${email}`); audit('login-fail', a?.id ?? null, ip); return err('Incorrect email or password.', 401); }
    if (cfg.requireVerification && !a.email_verified) return err('Please verify your email first. Check your inbox, or request a new link.', 403, { code: 'unverified' });
    rateClear(`login:fail:${email}`); audit('login', a.id, ip); return startSession(req, a);
  }
  if (path === '/auth/forgot' && m === 'POST') {
    const b = await body(req); const r = rateLimit(`forgot:ip:${ip}`, 20, 3600_000); if (!r.ok) return limited(r);
    if (emailValid(b.email)) { const e = normEmail(b.email); const rr = rateLimit(`forgot:e:${e}`, 3, 3600_000); if (!rr.ok) return limited(rr); const a = sget<any>('SELECT id FROM accounts WHERE email = ? AND disabled = 0', e); if (a && mailConfigured()) { const t = await issueToken(a.id, 'reset'); audit('forgot', a.id, ip); await sendMail({ to: e, subject: 'Reset your bookbook password', text: `Reset your password: ${linkBase(req)}/#/auth/reset/${t}\nThe link works once and expires in 1 hour. If you did not ask for this, ignore it — your password is unchanged.` }).catch(() => {}); } }
    return json({ ok: true }, 202); // identical answer whether or not the account exists
  }
  if (path === '/auth/reset' && m === 'POST') {
    const b = await body(req); const rl = rateLimit(`reset:ip:${ip}`, 20, 3600_000); if (!rl.ok) return limited(rl);
    const t = takeToken(b.token, 'reset'); if (!t) return err('This reset link is invalid or has expired.', 400);
    const acc = sget<any>('SELECT email FROM accounts WHERE id = ?', t.account_id)!; const pp = passwordProblem(b.password, acc.email); if (pp) { srun('UPDATE tokens SET used_at = NULL WHERE id = ?', sha256(b.token)); return err(pp); }
    srun('UPDATE accounts SET password_hash = ?, email_verified = 1, password_changed_at = ? WHERE id = ?', await hashPassword(b.password), Date.now(), t.account_id); revokeAll(t.account_id); audit('reset', t.account_id, ip);
    return json({ ok: true });
  }
  if (path === '/auth/session' && m === 'GET') { const a = authenticate(req); return a ? json({ user: publicUser(a.account), csrf: a.session.csrf }) : json({ user: null }); }

  // ── everything below needs a session (and, for writes, the CSRF token) ──
  const a = authenticate(req); if (!a) return err('Sign in required.', 401, { code: 'auth' });
  if (!SAFE.has(m) && !csrfOk(req, a)) return err('CSRF check failed. Reload the page and try again.', 403, { code: 'csrf' });
  if (path === '/auth/logout' && m === 'POST') { revokeSession(a.session.id); audit('logout', a.account.id, ip); return json({ ok: true }, 200, clearCookies()); }
  if (path === '/auth/logout-all' && m === 'POST') { revokeAll(a.account.id); audit('logout-all', a.account.id, ip); return json({ ok: true }, 200, clearCookies()); }
  if (path === '/auth/sessions' && m === 'GET') return json(listSessions(a.account.id, a.session.id));
  const sm = /^\/auth\/sessions\/([a-f0-9]{8,64})$/.exec(path); if (sm && m === 'DELETE') { const r = revokeByRef(a.account.id, sm[1], a.session.id); return r ? json({ ok: true }, 200, r === 'self' ? clearCookies() : []) : err('Session not found.', 404); }
  if (path === '/auth/change-password' && m === 'POST') {
    const b = await body(req); const r = rateLimit(`chpw:${a.account.id}`, 10, 3600_000); if (!r.ok) return limited(r);
    const acc = sget<any>('SELECT * FROM accounts WHERE id = ?', a.account.id)!; if (typeof b.current !== 'string' || !(await verifyPassword(b.current, acc.password_hash))) return err('Current password is incorrect.', 403);
    const pp = passwordProblem(b.next, acc.email); if (pp) return err(pp);
    srun('UPDATE accounts SET password_hash = ?, password_changed_at = ? WHERE id = ?', await hashPassword(b.next), Date.now(), acc.id); revokeAll(acc.id, a.session.id); audit('change-password', acc.id, ip); return json({ ok: true });
  }
  if (path === '/account' && m === 'DELETE') { // irreversible: removes the account, every session and the tenant's whole data directory
    const b = await body(req); const r = rateLimit(`delacct:${a.account.id}`, 5, 3600_000); if (!r.ok) return limited(r);
    const acc = sget<any>('SELECT * FROM accounts WHERE id = ?', a.account.id)!; if (typeof b.password !== 'string' || !(await verifyPassword(b.password, acc.password_hash))) return err('Password is incorrect.', 403);
    if (b.confirm !== 'DELETE') return err('Type DELETE to confirm.');
    closeTenantDb(acc.id); const dir = userDir(acc.id); fs.rmSync(dir, { recursive: true, force: true });
    srun('DELETE FROM accounts WHERE id = ?', acc.id); audit('account-deleted', null, ip, acc.id); return json({ ok: true, deleted: true }, 200, clearCookies());
  }
  void DATA_DIR; void CSRF_COOKIE; void sall;
  return err('Not found', 404);
}
