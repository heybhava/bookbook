// Test helper: gives every test file its own account on the isolated server and makes plain `fetch(BASE + '/api/...')` calls authenticated
// (cookie jar + CSRF header). Import it FIRST in a test file:  import './_auth.ts';
// It also exports Client for tests that need several independent accounts.
import path from 'node:path';

export const BASE = process.env.BASE_URL || 'http://localhost:3100';
export const BASE_PROD = process.env.BASE_URL_PROD || '';
const realFetch = globalThis.fetch.bind(globalThis);
const rand = () => Math.random().toString(36).slice(2, 10);
export const PASSWORD = 'correct-horse-battery-9';

export class Client {
  jar = new Map<string, string>(); csrf = ''; user: any = null; ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`; // each client looks like a different machine to the rate limiter
  base: string; constructor(base = BASE) { this.base = base; }
  private store(res: Response) { for (const c of (res.headers as any).getSetCookie?.() ?? []) { const [kv, ...attrs] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim(); if (/max-age=0/i.test(attrs.join(';')) || v === '') this.jar.delete(k); else this.jar.set(k, v); if (/csrf$/.test(k)) this.csrf = v; } }
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  /** fetch with this client's session; `path` like '/api/books' */
  async fetch(p: string, init: RequestInit & { noCsrf?: boolean; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers as any) }; const ck = this.cookieHeader(); if (ck) headers.cookie = ck; headers['x-forwarded-for'] ??= this.ip;
    const m = (init.method ?? 'GET').toUpperCase(); if (!['GET', 'HEAD'].includes(m) && this.csrf && !init.noCsrf && !headers['x-csrf-token']) headers['x-csrf-token'] = this.csrf;
    const res = await realFetch(this.base + p, { ...init, headers }); this.store(res); return res;
  }
  async json(p: string, body?: unknown, method?: string) { const r = await this.fetch(p, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any, headers: r.headers }; }
  /** register → read the verification mail from the dev outbox → verify → sign in */
  async signUp(email = `u-${rand()}@example.test`, password = PASSWORD) {
    const r = await this.json('/api/auth/register', { email, password, name: 'Test User' }); if (r.status !== 202 && r.status !== 200) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
    if (r.status === 202) { const mail = await this.latestMail(email); const token = /\/auth\/verify\/([\w-]+)/.exec(mail.text)?.[1]; if (!token) throw new Error('no verification token in mail'); const v = await this.json('/api/auth/verify', { token }); if (v.status !== 200) throw new Error('verify failed'); const l = await this.json('/api/auth/login', { email, password }); if (l.status !== 200) throw new Error(`login failed ${l.status}`); this.user = l.body.user; this.csrf = l.body.csrf ?? this.csrf; }
    else { this.user = r.body.user; this.csrf = r.body.csrf ?? this.csrf; }
    return { email, password, user: this.user as { id: string } };
  }
  async latestMail(to: string) { for (let i = 0; i < 20; i++) { const r = await realFetch(`${this.base}/api/dev/outbox?to=${encodeURIComponent(to)}`); const list = (await r.json()) as any[]; if (list.length) return list[list.length - 1]; await new Promise((res) => setTimeout(res, 100)); } throw new Error('no mail for ' + to); }
  tenantDb() { if (!this.user) throw new Error('not signed in'); return path.join(process.env.TEST_DATA_DIR!, 'users', this.user.id, 'app.db'); }
}

// ── default account for legacy test files: every plain fetch to BASE gets this session ──
export const me = new Client(BASE);
let ready: Promise<void> | null = null;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(BASE + '/api/') || url.startsWith(BASE + '/api/auth/') || url.startsWith(BASE + '/api/dev/') || url.startsWith(BASE + '/api/health')) return realFetch(input, init);
  ready ??= me.signUp().then(() => undefined); await ready;
  const headers: Record<string, string> = {}; new Headers(init.headers ?? {}).forEach((v, k) => (headers[k] = v));
  return me.fetch(url.slice(BASE.length), { ...init, headers });
}) as typeof fetch;
/** Path of the default test account's tenant database (for tests that seed rows directly). */
export async function tenantDbPath() { ready ??= me.signUp().then(() => undefined); await ready; return me.tenantDb(); }
