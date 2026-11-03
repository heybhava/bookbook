// Tenant context: every request and every background job runs "as" exactly one user. Storage (database file + directories) is resolved from that user,
// so code that forgets a WHERE clause still cannot read another tenant's rows or files.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export const DATA_DIR = path.resolve(process.env.BOOKREADER_DATA_DIR || './data');
export const FOLIO_ENV = (process.env.FOLIO_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development')) as 'production' | 'development' | 'test';

interface Ctx { userId: string; admin?: boolean }
const g = globalThis as unknown as { __folioAls?: AsyncLocalStorage<Ctx> };
const als = (g.__folioAls ??= new AsyncLocalStorage<Ctx>());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUserId = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

/** Run `fn` as `userId`. Everything awaited inside (and any job it starts) keeps that identity. */
export function runAs<T>(userId: string, fn: () => T, admin = false): T {
  if (!isUserId(userId)) throw new Error('Invalid user id');
  return als.run({ userId, admin }, fn);
}
/** The current user's id. Throws when called outside a user context: unscoped data access is a bug, not a default. */
export function me(): string {
  const c = als.getStore();
  if (!c) throw new Error('No user context: this code ran outside an authenticated request or user job.');
  return c.userId;
}
export const tryMe = (): string | null => als.getStore()?.userId ?? null;
export const isAdminCtx = (): boolean => !!als.getStore()?.admin;

// ───────────── per-user storage layout:  <DATA_DIR>/users/<uuid>/{app.db, files, covers, audio, assets, journal, vaults, vault-history, tmp} ─────────────
export const usersRoot = () => path.join(DATA_DIR, 'users');
export function userDir(uid = me()): string {
  if (!isUserId(uid)) throw new Error('Invalid user id');
  const d = path.join(usersRoot(), uid.toLowerCase());
  const rel = path.relative(usersRoot(), d); if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid tenant path');
  return d;
}
const sub = (name: string) => () => { const d = path.join(userDir(), name); fs.mkdirSync(d, { recursive: true }); return d; };
export const filesDir = sub('files');
export const coversDir = sub('covers');
export const audioDir = sub('audio');
export const assetDir = sub('assets');
export const journalDir = sub('journal');
export const vaultsDir = sub('vaults');
export const vaultHistoryDir = sub('vault-history');
export const tmpDir = sub('tmp');
export const listTenantIds = (): string[] => { try { return fs.readdirSync(usersRoot()).filter(isUserId); } catch { return []; } };
