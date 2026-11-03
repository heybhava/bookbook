#!/usr/bin/env node
// Test runner: ALWAYS uses an isolated server and a throw-away data directory. It never touches the development or production data directory.
//   npm test                 build (if sources changed) + start two servers (test env and production env) + run tests/*.test.ts + clean up
//   npm test -- tests/auth.test.ts    run selected files
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = '.next-test';
const NEXT = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const files = process.argv.slice(2).filter((a) => a.endsWith('.ts')); const targets = files.length ? files : fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.ts')).map((f) => path.join('tests', f));

const newest = (dir) => { let t = 0; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs); } return t; };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const wait = async (url, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 300)); } throw new Error(`server did not start: ${url}`); };

const buildId = path.join(ROOT, DIST, 'BUILD_ID');
const srcTime = Math.max(newest(path.join(ROOT, 'src')), fs.statSync(path.join(ROOT, 'package.json')).mtimeMs, fs.statSync(path.join(ROOT, 'next.config.mjs')).mtimeMs);
if (!fs.existsSync(buildId) || fs.statSync(buildId).mtimeMs < srcTime) {
  console.log('› building (sources changed)…');
  const b = spawnSync(process.execPath, [NEXT, 'build'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NEXT_DIST_DIR: DIST, FOLIO_ENV: 'test' } });
  if (b.status !== 0) { console.error('build failed'); process.exit(b.status ?? 1); }
}
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-test-')); const dataProd = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-test-prod-'));
const [p1, p2] = [await freePort(), await freePort()]; const servers = [];
const start = (port, env, label) => { const p = spawn(process.execPath, [NEXT, 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: ROOT, env: { ...process.env, NEXT_DIST_DIR: DIST, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); p.stdout.on('data', () => {}); p.stderr.on('data', (d) => { if (process.env.TEST_VERBOSE) process.stderr.write(`[${label}] ${d}`); }); servers.push(p); return p; };
const cleanup = () => { for (const s of servers) { try { s.kill(); } catch { /* gone */ } } try { fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(dataProd, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on('SIGINT', () => { cleanup(); process.exit(130); });
let code = 1;
try {
  start(p1, { BOOKREADER_DATA_DIR: data, FOLIO_ENV: 'test', FOLIO_API_RATE_PER_MIN: '100000' }, 'test');
  start(p2, { BOOKREADER_DATA_DIR: dataProd, FOLIO_ENV: 'production', FOLIO_PUBLIC_URL: 'https://folio.example.test', FOLIO_ALLOWED_HOSTS: 'localhost,127.0.0.1', FOLIO_REQUIRE_EMAIL_VERIFICATION: 'false' }, 'prod');
  await Promise.all([wait(`http://127.0.0.1:${p1}/api/health`), wait(`http://127.0.0.1:${p2}/api/health`)]);
  console.log(`› isolated test server http://127.0.0.1:${p1} (data ${data}); production-mode server :${p2}`);
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=1', ...targets], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, BASE_URL: `http://127.0.0.1:${p1}`, BASE_URL_PROD: `http://127.0.0.1:${p2}`, TEST_DATA_DIR: data, TEST_DATA_DIR_PROD: dataProd } });
  code = r.status ?? 1;
} catch (e) { console.error(e.message); } finally { cleanup(); }
process.exit(code);
