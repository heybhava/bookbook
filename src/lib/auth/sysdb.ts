// System database: accounts, sessions, one-time tokens, rate-limit events, audit trail. Contains NO user content (books, notes, journals live in tenant databases).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../tenant';

type DB = import('node:sqlite').DatabaseSync;
const MIGRATIONS: { id: number; sql: string }[] = [
  { id: 1, sql: `
CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT, password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER, password_changed_at INTEGER);
CREATE TABLE sessions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL, idle_expires_at INTEGER NOT NULL, revoked_at INTEGER, ip TEXT, user_agent TEXT);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE TABLE tokens (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX tokens_account ON tokens(account_id, kind);
CREATE TABLE rate_events (key TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX rate_key ON rate_events(key, ts);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, kind TEXT NOT NULL, ip TEXT, detail TEXT, ts INTEGER NOT NULL);
CREATE INDEX audit_account ON audit(account_id, ts);
` },
];

const g = globalThis as unknown as { __sysdb?: DB };
export function sys(): DB {
  if (g.__sysdb) return g.__sysdb;
  const dir = path.join(DATA_DIR, 'system'); fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const d = new DatabaseSync(path.join(dir, 'system.db'));
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  d.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set((d.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((r) => r.id));
  for (const m of MIGRATIONS) { if (applied.has(m.id)) continue; d.exec('BEGIN'); try { d.exec(m.sql); d.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?,?)').run(m.id, Date.now()); d.exec('COMMIT'); } catch (e) { d.exec('ROLLBACK'); throw e; } }
  g.__sysdb = d; return d;
}
export const sall = <T = Record<string, any>>(sql: string, ...p: any[]) => sys().prepare(sql).all(...p) as T[];
export const sget = <T = Record<string, any>>(sql: string, ...p: any[]) => sys().prepare(sql).get(...p) as T | undefined;
export const srun = (sql: string, ...p: any[]) => sys().prepare(sql).run(...p);
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const audit = (kind: string, accountId: string | null, ip: string | null, detail?: string) => { try { srun('INSERT INTO audit (account_id, kind, ip, detail, ts) VALUES (?,?,?,?,?)', accountId, kind, ip, detail?.slice(0, 300) ?? null, Date.now()); } catch { /* auditing must never break a request */ } };

/** Sliding-window limiter persisted in the system DB (shared by every worker process on this host). */
export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number; count: number } {
  const now = Date.now(); const since = now - windowMs;
  srun('DELETE FROM rate_events WHERE key = ? AND ts < ?', key, since);
  const row = sget<{ n: number; first: number }>('SELECT COUNT(*) n, MIN(ts) first FROM rate_events WHERE key = ?', key)!;
  if (row.n >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((row.first ?? now) + windowMs - now) / 1000)), count: row.n };
  srun('INSERT INTO rate_events (key, ts) VALUES (?,?)', key, now);
  return { ok: true, retryAfterSec: 0, count: row.n + 1 };
}
export const rateCount = (key: string, windowMs: number) => (sget<{ n: number }>('SELECT COUNT(*) n FROM rate_events WHERE key = ? AND ts >= ?', key, Date.now() - windowMs)?.n ?? 0);
export const rateRecord = (key: string) => { srun('INSERT INTO rate_events (key, ts) VALUES (?,?)', key, Date.now()); };
export const rateClear = (key: string) => { srun('DELETE FROM rate_events WHERE key = ?', key); };
export const purgeOld = () => { const now = Date.now(); srun('DELETE FROM rate_events WHERE ts < ?', now - 24 * 3600_000); srun('DELETE FROM sessions WHERE expires_at < ? OR idle_expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', now, now, now - 7 * 86400_000); srun('DELETE FROM tokens WHERE expires_at < ?', now - 86400_000); };
