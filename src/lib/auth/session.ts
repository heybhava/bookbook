// Sessions: random 256-bit token in an HttpOnly cookie; only its SHA-256 is stored. Idle + absolute expiry, revocation, per-session CSRF secret.
import { sget, sall, srun, sha256, randomToken } from './sysdb';
import { cfg } from './config';

export interface Account { id: string; email: string; name: string | null; email_verified: number; is_admin: number; disabled: number; created_at: number }
export interface SessionInfo { id: string; accountId: string; csrf: string; expiresAt: number }
export const SESSION_COOKIE = () => (cfg.secureCookies ? '__Host-folio_session' : 'folio_session');
export const CSRF_COOKIE = () => (cfg.secureCookies ? '__Host-folio_csrf' : 'folio_csrf');

export function parseCookies(h: string | null): Record<string, string> {
  const out: Record<string, string> = {}; for (const part of (h ?? '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return out;
}
const attrs = (maxAge: number, httpOnly: boolean) => `Path=/; Max-Age=${maxAge}; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}${cfg.secureCookies ? '; Secure' : ''}`;
export const sessionCookies = (token: string, csrf: string, maxAgeSec: number): string[] => [`${SESSION_COOKIE()}=${token}; ${attrs(maxAgeSec, true)}`, `${CSRF_COOKIE()}=${csrf}; ${attrs(maxAgeSec, false)}`];
export const clearCookies = (): string[] => [`${SESSION_COOKIE()}=; ${attrs(0, true)}`, `${CSRF_COOKIE()}=; ${attrs(0, false)}`];

export function createSession(accountId: string, ip: string | null, ua: string | null) {
  const token = randomToken(32), csrf = randomToken(24), now = Date.now();
  const abs = now + cfg.sessionAbsSec * 1000, idle = now + cfg.sessionIdleSec * 1000;
  srun('INSERT INTO sessions (id, account_id, csrf, created_at, last_seen, expires_at, idle_expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?,?)', sha256(token), accountId, csrf, now, now, abs, idle, ip, ua?.slice(0, 200) ?? null);
  return { token, csrf, maxAgeSec: Math.min(cfg.sessionAbsSec, cfg.sessionIdleSec) };
}
/** Valid, unrevoked, unexpired session for this token (and its account), or null. Slides the idle window at most once a minute. */
export function lookupSession(token: string | undefined): { session: SessionInfo; account: Account } | null {
  if (!token || token.length < 20 || token.length > 200) return null;
  const id = sha256(token); const now = Date.now();
  const s = sget<any>('SELECT * FROM sessions WHERE id = ?', id);
  if (!s || s.revoked_at || s.expires_at <= now || s.idle_expires_at <= now) return null;
  const a = sget<Account>('SELECT id, email, name, email_verified, is_admin, disabled, created_at FROM accounts WHERE id = ?', s.account_id);
  if (!a || a.disabled) return null;
  if (now - s.last_seen > 60_000) srun('UPDATE sessions SET last_seen = ?, idle_expires_at = ? WHERE id = ?', now, Math.min(s.expires_at, now + cfg.sessionIdleSec * 1000), id);
  return { session: { id, accountId: s.account_id, csrf: s.csrf, expiresAt: s.expires_at }, account: a };
}
export const revokeSession = (id: string) => { srun('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), id); };
export const revokeAll = (accountId: string, exceptId?: string) => { srun('UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL AND id != ?', Date.now(), accountId, exceptId ?? ''); };
export const listSessions = (accountId: string, currentId: string) => sall<any>('SELECT id, created_at, last_seen, expires_at, ip, user_agent FROM sessions WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ? AND idle_expires_at > ? ORDER BY last_seen DESC', accountId, Date.now(), Date.now()).map((s) => ({ ref: s.id.slice(0, 16), created_at: s.created_at, last_seen: s.last_seen, ip: s.ip, user_agent: s.user_agent, current: s.id === currentId }));
export function revokeByRef(accountId: string, ref: string, currentId: string) { const s = sget<{ id: string }>('SELECT id FROM sessions WHERE account_id = ? AND id LIKE ? AND revoked_at IS NULL', accountId, ref.replace(/[^a-f0-9]/gi, '') + '%'); if (!s) return false; revokeSession(s.id); return s.id === currentId ? 'self' : true; }
