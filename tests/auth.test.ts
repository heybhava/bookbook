// Authentication, sessions, CSRF, Host/Origin and rate-limit behaviour. Runs against the isolated test server (see scripts/run-tests.mjs).
import { Client, BASE, PASSWORD } from './_auth.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const up = await fetch(BASE + '/api/health').then((r) => r.ok).catch(() => false);
const rnd = () => Math.random().toString(36).slice(2, 9);
const sysDb = () => new DatabaseSync(path.join(process.env.TEST_DATA_DIR!, 'system', 'system.db'));
const rawHost = (host: string, p = '/api/health'): Promise<number> => new Promise((res, rej) => { const u = new URL(BASE); const r = http.request({ host: u.hostname, port: u.port, path: p, method: 'GET', headers: { host } }, (x) => { x.resume(); res(x.statusCode ?? 0); }); r.on('error', rej); r.end(); });

test('Authentication & request security', { skip: !up && 'server not running' }, async (t) => {
  await t.test('register → verification mail → login; unverified accounts cannot sign in; duplicate sign-up does not reveal the account', async () => {
    const c = new Client(); const email = `reg-${rnd()}@example.test`;
    const r = await c.json('/api/auth/register', { email, password: PASSWORD }); assert.equal(r.status, 202); assert.equal(r.body.needsVerification, true);
    const early = await c.json('/api/auth/login', { email, password: PASSWORD }); assert.equal(early.status, 403); assert.equal(early.body.code, 'unverified');
    const dup = await c.json('/api/auth/register', { email, password: PASSWORD }); assert.equal(dup.status, 202); assert.deepEqual(dup.body, r.body, 'same answer for an existing address');
    const mail = await c.latestMail(email); assert.match(mail.text, /\/#\/auth\/verify\//); const token = /verify\/([\w-]+)/.exec(mail.text)![1];
    assert.equal((await c.json('/api/auth/verify', { token: 'x'.repeat(30) })).status, 400); assert.equal((await c.json('/api/auth/verify', { token })).status, 200); assert.equal((await c.json('/api/auth/verify', { token })).status, 400, 'a verification link works once');
    const l = await c.json('/api/auth/login', { email, password: PASSWORD }); assert.equal(l.status, 200); assert.equal(l.body.user.email, email); assert.equal(l.body.user.emailVerified, true);
  });

  await t.test('input validation: weak or malformed credentials are refused', async () => {
    const c = new Client(); assert.equal((await c.json('/api/auth/register', { email: 'nope', password: PASSWORD })).status, 400);
    for (const pw of ['short1', 'password123', 'aaaaaaaaaaaa', '']) assert.equal((await c.json('/api/auth/register', { email: `v-${rnd()}@example.test`, password: pw })).status, 400, `weak: ${pw}`);
    assert.equal((await c.json('/api/auth/login', {})).status, 400);
  });

  await t.test('session cookie is HttpOnly + SameSite and the CSRF cookie is readable by the page', async () => {
    const c = new Client(); const email = `ck-${rnd()}@example.test`; await c.signUp(email); const r = await new Client().json('/api/auth/login', { email, password: PASSWORD }); const cookies = (r.headers as any).getSetCookie() as string[];
    const s = cookies.find((x) => x.startsWith('folio_session='))!, cs = cookies.find((x) => x.startsWith('folio_csrf='))!; assert.match(s, /HttpOnly/); assert.match(s, /SameSite=Lax/); assert.match(s, /Path=\//); assert.doesNotMatch(cs, /HttpOnly/);
    const stored = sysDb().prepare('SELECT id FROM sessions').all().map((x: any) => x.id); const token = /folio_session=([^;]+)/.exec(s)![1]; assert.ok(!stored.includes(token), 'the raw token is never stored'); assert.ok(stored.includes(crypto.createHash('sha256').update(token).digest('hex')), 'only its hash is');
  });

  await t.test('protected routes need a session; wrong-account, cookie-less and forged cookies are all 401', async () => {
    const anon = new Client(); for (const p of ['/api/books', '/api/journal/entries', '/api/vaults', '/api/notes', '/api/status', '/api/account/export']) assert.equal((await anon.fetch(p)).status, 401, p);
    anon.jar.set('folio_session', 'A'.repeat(43)); assert.equal((await anon.fetch('/api/books')).status, 401);
    assert.equal((await anon.json('/api/auth/session')).body.user, null); assert.equal((await anon.json('/api/health')).status, 200);
  });

  await t.test('CSRF: a signed-in write without (or with a wrong) token is refused; reads need none', async () => {
    const c = new Client(); await c.signUp(); const body = JSON.stringify({ title: 'x' });
    const no = await c.fetch('/api/goals', { method: 'POST', body, headers: { 'content-type': 'application/json' }, noCsrf: true }); assert.equal(no.status, 403); assert.equal((await no.json()).code, 'csrf');
    assert.equal((await c.fetch('/api/goals', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-csrf-token': 'wrong' + c.csrf.slice(5) } })).status, 403);
    assert.equal((await c.fetch('/api/goals', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 200);
    assert.equal((await c.fetch('/api/goals')).status, 200);
    const other = new Client(); await other.signUp(); assert.equal((await c.fetch('/api/goals', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-csrf-token': other.csrf } })).status, 403, 'another account\'s token is not valid');
  });

  await t.test('Origin / Fetch-Metadata / Host: cross-site writes and foreign Host headers are rejected', async () => {
    const c = new Client(); await c.signUp(); const json = { 'content-type': 'application/json' }, body = '{"title":"x"}';
    assert.equal((await c.fetch('/api/goals', { method: 'POST', body, headers: { ...json, origin: 'http://evil.example' } })).status, 403);
    assert.equal((await c.fetch('/api/goals', { method: 'POST', body, headers: { ...json, origin: 'null' } })).status, 403);
    assert.equal((await c.fetch('/api/goals', { method: 'POST', body, headers: { ...json, 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await c.fetch('/api/goals', { method: 'POST', body, headers: { ...json, origin: BASE } })).status, 200, 'same-origin still works');
    assert.equal((await c.json('/api/auth/login', { email: 'a@b.test', password: 'x' + PASSWORD }, 'POST')).status, 401);
    const evil = await new Client().fetch('/api/auth/login', { method: 'POST', body: '{}', headers: { ...json, origin: 'http://evil.example' } }); assert.equal(evil.status, 403, 'login CSRF');
    assert.equal(await rawHost('evil.example'), 421, 'DNS-rebinding style Host'); assert.equal(await rawHost('evil.example', '/api/books'), 421); assert.equal(await rawHost('localhost'), 200);
  });

  await t.test('logout revokes the session on the server; logout-all revokes every device; individual sessions can be revoked', async () => {
    const email = `lo-${rnd()}@example.test`; const a = new Client(); await a.signUp(email); const b = new Client(); assert.equal((await b.json('/api/auth/login', { email, password: PASSWORD })).status, 200);
    const stolen = a.cookieHeader(); assert.equal((await a.json('/api/auth/logout', {})).status, 200); const r = await fetch(BASE + '/api/books', { headers: { cookie: stolen } }); assert.equal(r.status, 401, 'the old cookie is dead server-side');
    assert.equal((await b.fetch('/api/books')).status, 200);
    const c = new Client(); await c.json('/api/auth/login', { email, password: PASSWORD }); const list = (await b.json('/api/auth/sessions')).body; assert.ok(list.length >= 2 && list.some((s: any) => s.current));
    const other = list.find((s: any) => !s.current); assert.equal((await b.json(`/api/auth/sessions/${other.ref}`, undefined, 'DELETE')).status, 200); assert.equal((await c.fetch('/api/books')).status, 401, 'revoked session stops working');
    assert.equal((await b.json('/api/auth/logout-all', {})).status, 200); assert.equal((await b.fetch('/api/books')).status, 401);
  });

  await t.test('session expiry: idle and absolute limits are enforced', async () => {
    const c = new Client(); await c.signUp(); assert.equal((await c.fetch('/api/books')).status, 200); const id = crypto.createHash('sha256').update(c.jar.get('folio_session')!).digest('hex');
    const db = sysDb(); db.prepare('UPDATE sessions SET idle_expires_at = ? WHERE id = ?').run(Date.now() - 1000, id); assert.equal((await c.fetch('/api/books')).status, 401, 'idle timeout');
    const d = new Client(); await d.signUp(); const id2 = crypto.createHash('sha256').update(d.jar.get('folio_session')!).digest('hex'); db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id2); assert.equal((await d.fetch('/api/books')).status, 401, 'absolute lifetime'); db.close();
  });

  await t.test('password reset: generic answer, single-use expiring token, weak password refused without burning the token, all sessions revoked', async () => {
    const email = `pw-${rnd()}@example.test`; const a = new Client(); await a.signUp(email);
    const known = await new Client().json('/api/auth/forgot', { email }); const unknown = await new Client().json('/api/auth/forgot', { email: `nobody-${rnd()}@example.test` }); assert.equal(known.status, 202); assert.deepEqual(known.body, unknown.body);
    const mail = await a.latestMail(email); const reset = [...(await (await fetch(`${BASE}/api/dev/outbox?to=${encodeURIComponent(email)}`)).json() as any[])].filter((m) => /auth\/reset\//.test(m.text)).pop()!; const token = /reset\/([\w-]+)/.exec(reset.text)![1]; void mail;
    assert.equal((await a.json('/api/auth/reset', { token, password: 'short' })).status, 400); const NEW = 'a-brand-new-passphrase-42';
    assert.equal((await a.json('/api/auth/reset', { token, password: NEW })).status, 200); assert.equal((await a.json('/api/auth/reset', { token, password: NEW + 'x' })).status, 400, 'token is single-use');
    assert.equal((await a.fetch('/api/books')).status, 401, 'old sessions were revoked'); assert.equal((await new Client().json('/api/auth/login', { email, password: PASSWORD })).status, 401); assert.equal((await new Client().json('/api/auth/login', { email, password: NEW })).status, 200);
    await new Client().json('/api/auth/forgot', { email }); const t2 = /reset\/([\w-]+)/.exec(((await (await fetch(`${BASE}/api/dev/outbox?to=${encodeURIComponent(email)}`)).json()) as any[]).filter((m) => /auth\/reset\//.test(m.text)).pop().text)![1];
    const db = sysDb(); db.prepare('UPDATE tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, crypto.createHash('sha256').update(t2).digest('hex')); db.close(); assert.equal((await new Client().json('/api/auth/reset', { token: t2, password: NEW + 'y' })).status, 400, 'expired');
  });

  await t.test('change password needs the current one and signs out other devices', async () => {
    const email = `cp-${rnd()}@example.test`; const a = new Client(); await a.signUp(email); const b = new Client(); await b.json('/api/auth/login', { email, password: PASSWORD });
    assert.equal((await a.json('/api/auth/change-password', { current: 'wrong-password-123', next: 'another-long-passphrase-1' })).status, 403); assert.equal((await a.json('/api/auth/change-password', { current: PASSWORD, next: 'another-long-passphrase-1' })).status, 200);
    assert.equal((await a.fetch('/api/books')).status, 200, 'this device stays signed in'); assert.equal((await b.fetch('/api/books')).status, 401, 'other devices are signed out');
  });

  await t.test('brute force: repeated wrong passwords lock the account for that sign-in, even with the right password', async () => {
    const email = `bf-${rnd()}@example.test`; const a = new Client(); await a.signUp(email); const att = new Client(); let last = 0;
    for (let i = 0; i < 9; i++) last = (await att.json('/api/auth/login', { email, password: `wrong-guess-${i}-xxxx` })).status; assert.equal(last, 429); const locked = await att.json('/api/auth/login', { email, password: PASSWORD }); assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get('retry-after')) > 0);
  });

  await t.test('registration is rate limited per source address', async () => {
    const c = new Client(); let last = 0; for (let i = 0; i < 12; i++) last = (await c.json('/api/auth/register', { email: `rl-${rnd()}@example.test`, password: PASSWORD })).status; assert.equal(last, 429);
  });

  await t.test('account export is a zip of the caller\'s data; deleting the account removes sessions and the whole data directory; others are unaffected', async () => {
    const JSZip = (await import('jszip')).default; const a = new Client(); const { user, email } = { user: (await a.signUp()).user, email: '' }; void email; const b = new Client(); await b.signUp();
    await a.json('/api/goals', { title: 'EXPORT-CANARY-' + user.id.slice(0, 6) }); const zip = await a.fetch('/api/account/export'); assert.equal(zip.status, 200); const z = await JSZip.loadAsync(Buffer.from(await zip.arrayBuffer())); assert.ok(z.file('app.db') && z.file('README.txt'));
    const dir = path.join(process.env.TEST_DATA_DIR!, 'users', user.id); assert.ok(fs.existsSync(dir)); const acct = new DatabaseSync(path.join(process.env.TEST_DATA_DIR!, 'system', 'system.db')).prepare('SELECT email FROM accounts WHERE id = ?').get(user.id) as any;
    assert.equal((await a.json('/api/account', { password: 'not-my-password-123', confirm: 'DELETE' }, 'DELETE')).status, 403); assert.equal((await a.json('/api/account', { password: PASSWORD }, 'DELETE')).status, 400, 'needs the typed confirmation');
    assert.equal((await a.json('/api/account', { password: PASSWORD, confirm: 'DELETE' }, 'DELETE')).status, 200); assert.equal((await a.fetch('/api/books')).status, 401); assert.ok(!fs.existsSync(dir), 'tenant directory is gone');
    assert.equal((await new Client().json('/api/auth/login', { email: acct.email, password: PASSWORD })).status, 401, 'the account no longer exists'); assert.equal((await b.fetch('/api/books')).status, 200, 'other users are untouched');
  });
});
