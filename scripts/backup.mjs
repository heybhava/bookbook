#!/usr/bin/env node
// Consistent backup of the whole data directory (system DB, every tenant DB, uploaded files, media).
//   node scripts/backup.mjs [--data <dir>] [--out <dir>]
// SQLite files are copied with VACUUM INTO (safe while the server is running); everything else is copied as-is.
// A manifest.json with SHA-256 checksums is written so a restore can be verified.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const DATA = path.resolve(arg('--data', process.env.BOOKREADER_DATA_DIR || './data'));
const OUT_ROOT = path.resolve(arg('--out', path.join(DATA, '..', 'backups')));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(OUT_ROOT, `folio-${stamp}`);
const SKIP_DIRS = new Set(['backups', 'tmp']);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const manifest = { created: new Date().toISOString(), source: DATA, files: [] };

function walk(dir, rel = '') {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!(rel === '' && SKIP_DIRS.has(e.name))) walk(dir, r); continue; }
    if (!e.isFile() || /-(wal|shm)$/.test(e.name) || e.name.endsWith('.folio-tmp')) continue;
    const src = path.join(dir, r), dst = path.join(OUT, r); fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (e.name.endsWith('.db')) { const db = new DatabaseSync(src, { readOnly: true }); try { db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`); } finally { db.close(); } }
    else fs.copyFileSync(src, dst);
    manifest.files.push({ path: r, size: fs.statSync(dst).size, sha256: sha(dst) });
  }
}
if (!fs.existsSync(DATA)) { console.error(`No data directory at ${DATA}`); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true }); walk(DATA);
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`backup ok: ${OUT} (${manifest.files.length} files, ${(manifest.files.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1)} MB)`);
