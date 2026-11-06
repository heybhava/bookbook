// Builds the Folio server as a self-contained bundle and stages it into desktop/app for packaging.
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const HERE = import.meta.dirname, ROOT = path.resolve(HERE, '..'), OUT = path.join(HERE, 'bundle'), DIST = '.next-desktop';
const run = (cmd, args, env = {}) => { const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } }); if (r.status !== 0) { console.error(`failed: ${cmd} ${args.join(' ')}`); process.exit(r.status ?? 1); } };
run(process.execPath, [path.join(HERE, 'make-icon.mjs')]);
console.log('› building the server bundle…');
fs.rmSync(path.join(ROOT, DIST), { recursive: true, force: true });
run(process.execPath, [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], { FOLIO_STANDALONE: '1', NEXT_DIST_DIR: DIST, NEXT_TELEMETRY_DISABLED: '1' });
console.log('› staging…'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(path.join(ROOT, DIST, 'standalone'), OUT, { recursive: true });
fs.cpSync(path.join(ROOT, DIST, 'static'), path.join(OUT, DIST, 'static'), { recursive: true });
fs.cpSync(path.join(ROOT, 'public'), path.join(OUT, 'public'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'scripts'), { recursive: true }); for (const f of ['backup.mjs', 'restore.mjs', 'transcribe.py']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(OUT, 'scripts', f));
const legacy = path.join(ROOT, 'data'); if (fs.existsSync(path.join(legacy, 'bookreader.db'))) fs.writeFileSync(path.join(OUT, 'legacy-path.txt'), legacy);
// electron-builder never copies folders named node_modules into extraResources, so the server's modules ship as _nm and are found through NODE_PATH
if (fs.existsSync(path.join(OUT, 'node_modules'))) fs.renameSync(path.join(OUT, 'node_modules'), path.join(OUT, '_nm'));
if (!fs.existsSync(path.join(OUT, 'server.js'))) { console.error('server.js missing in standalone output'); process.exit(1); }
console.log('staged ' + OUT);
