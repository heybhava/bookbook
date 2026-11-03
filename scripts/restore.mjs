#!/usr/bin/env node
// Restore a backup made by scripts/backup.mjs.
//   node scripts/restore.mjs <backup-dir> <target-data-dir> [--force]
// Every file is verified against manifest.json BEFORE anything is written. The target must be empty unless --force is given;
// with --force an existing target is first moved aside (never deleted).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const [src, target] = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((p) => p && path.resolve(p));
const force = process.argv.includes('--force');
if (!src || !target) { console.error('usage: restore.mjs <backup-dir> <target-data-dir> [--force]'); process.exit(2); }
const man = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
for (const f of man.files) {
  const p = path.join(src, f.path); const rel = path.relative(src, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { console.error(`unsafe path in manifest: ${f.path}`); process.exit(1); }
  if (!fs.existsSync(p) || sha(p) !== f.sha256) { console.error(`CHECKSUM MISMATCH or missing: ${f.path}`); process.exit(1); }
}
if (fs.existsSync(target) && fs.readdirSync(target).length) {
  if (!force) { console.error(`target ${target} is not empty (use --force to move it aside first)`); process.exit(1); }
  const aside = `${target}.before-restore-${Date.now()}`; fs.renameSync(target, aside); console.log(`existing data moved to ${aside}`);
}
fs.mkdirSync(target, { recursive: true });
for (const f of man.files) { const d = path.join(target, f.path); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(src, f.path), d); }
for (const f of man.files.filter((x) => x.path.endsWith('.db'))) { const db = new DatabaseSync(path.join(target, f.path), { readOnly: true }); const r = db.prepare('PRAGMA integrity_check').get(); db.close(); if (r.integrity_check !== 'ok') { console.error(`integrity check failed for ${f.path}`); process.exit(1); } }
console.log(`restore ok: ${man.files.length} files verified and restored to ${target}`);
