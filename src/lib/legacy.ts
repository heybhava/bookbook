// One-time import of a pre-multi-user data folder (single database at <dir>/bookreader.db plus files/covers/journal/vaults…) into a tenant.
// The legacy folder is only READ; a copy is made, so nothing is lost if anything goes wrong.
import fs from 'node:fs';
import path from 'node:path';
import { userDir } from './tenant';
import { DatabaseSync } from 'node:sqlite';

const DIRS = ['files', 'covers', 'audio', 'assets', 'journal', 'vaults', 'vault-history'];
const copyDir = (a: string, b: string) => { if (!fs.existsSync(a)) return 0; fs.cpSync(a, b, { recursive: true, force: false, errorOnExist: false }); return 1; };

export function legacyAvailable(dir: string | undefined): boolean { return !!dir && fs.existsSync(path.join(dir, 'bookreader.db')); }

/** Copy the legacy database + files into `userDir(uid)` and re-own every row. Returns counts for logging. */
export function claimLegacy(uid: string, legacyDir: string): { books: number; vaults: number } {
  const dst = userDir(uid); fs.mkdirSync(dst, { recursive: true });
  const target = path.join(dst, 'app.db'); if (fs.existsSync(target)) throw new Error('This account already has data; refusing to overwrite it.');
  const tmp = target + '.importing'; fs.rmSync(tmp, { force: true });
  const src = new DatabaseSync(path.join(legacyDir, 'bookreader.db'), { readOnly: true });
  try { src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { src.close(); } // consistent snapshot even if the old server is running
  for (const d of DIRS) copyDir(path.join(legacyDir, d), path.join(dst, d));
  const db = new DatabaseSync(tmp); db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) { const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name); if (cols.includes('user_id')) db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id = 'local'`).run(uid); }
    db.prepare("UPDATE users SET id = ? WHERE id = 'local'").run(uid);
    // vault folders moved into the tenant directory: re-point roots, and drop index rows that belonged to vaults no longer registered
    const vroot = path.join(dst, 'vaults');
    for (const v of db.prepare('SELECT id, name, root FROM vaults').all() as { id: string; name: string; root: string }[]) { const moved = path.join(vroot, path.basename(v.root)); if (fs.existsSync(moved)) db.prepare('UPDATE vaults SET root = ? WHERE id = ?').run(moved, v.id); else db.prepare('DELETE FROM vaults WHERE id = ?').run(v.id); }
    for (const t of ['vfiles', 'vlinks', 'vtags', 'vprops', 'vheads', 'vtasks', 'vcontent', 'vhistory']) db.exec(`DELETE FROM ${t} WHERE vault_id NOT IN (SELECT id FROM vaults)`);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } db.close(); fs.rmSync(tmp, { force: true }); throw e; }
  const bad = db.prepare('PRAGMA foreign_key_check').all().length; const ok = (db.prepare('PRAGMA integrity_check').get() as any).integrity_check === 'ok';
  const books = (db.prepare('SELECT COUNT(*) n FROM books').get() as any).n; const vaults = (db.prepare('SELECT COUNT(*) n FROM vaults').get() as any).n; db.close();
  if (!ok || bad) { fs.rmSync(tmp, { force: true }); throw new Error(`Imported database failed its integrity check (${bad} foreign-key problems).`); }
  fs.renameSync(tmp, target); return { books, vaults };
}

/** Idempotent: imports the legacy folder once. If an earlier attempt was interrupted (empty tenant database, no marker), the empty database is set aside and the import is retried. */
export function ensureLegacyImported(uid: string, legacyDir: string | undefined): { books: number; vaults: number } | { error: string } | null {
  if (!legacyAvailable(legacyDir)) return null;
  const dir = userDir(uid); const marker = path.join(dir, 'legacy-imported.json'); if (fs.existsSync(marker)) return null;
  const db = path.join(dir, 'app.db');
  try {
    if (fs.existsSync(db)) {
      const d = new DatabaseSync(db, { readOnly: true }); const n = (d.prepare('SELECT COUNT(*) n FROM books').get() as any).n; const notes = (d.prepare('SELECT COUNT(*) n FROM notes').get() as any).n; d.close();
      if (n > 0 || notes > 0) { fs.writeFileSync(marker, JSON.stringify({ skipped: 'tenant already has data', at: Date.now() })); return null; } // never overwrite real data
      const stamp = Date.now(); for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(db + ext)) fs.renameSync(db + ext, `${db}${ext}.empty-${stamp}`);
    }
    fs.rmSync(db + '.importing', { force: true });
    const r = claimLegacy(uid, legacyDir!); fs.writeFileSync(marker, JSON.stringify({ ...r, from: legacyDir, at: Date.now() })); return r;
  } catch (e: any) { return { error: e.message }; }
}
