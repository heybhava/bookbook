// Folio desktop shell. Runs the Folio server as a supervised child process on loopback, signs the single local owner in automatically,
// keeps itself alive (tray, auto-start, crash recovery, daily backups) and remembers its window.
'use strict';
const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage, powerMonitor, dialog, ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.FOLIO_PORT || 38417);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const packaged = app.isPackaged;
const APP_DIR = packaged ? path.join(process.resourcesPath, 'bundle') : path.join(__dirname, 'bundle');
const USER = app.getPath('userData');                      // %APPDATA%\Folio
const DATA = path.join(USER, 'data');
const LOGS = path.join(USER, 'logs');
const BACKUPS = path.join(USER, 'backups');
for (const d of [DATA, LOGS, BACKUPS]) fs.mkdirSync(d, { recursive: true });
const SECRET = crypto.randomBytes(32).toString('hex');      // known only to this process and its server child
const hidden = process.argv.includes('--hidden');
let win = null, tray = null, server = null, quitting = false, restarting = false, healthFails = 0, lastBackupCheck = 0, serverReady = false;

// ── logging (rotates at 2 MB) ──
function log(file, msg) { try { const f = path.join(LOGS, file); if (fs.existsSync(f) && fs.statSync(f).size > 2_000_000) fs.renameSync(f, f + '.1'); fs.appendFileSync(f, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* logging must never crash the app */ } }
process.on('uncaughtException', (e) => log('main.log', `uncaught: ${e && e.stack || e}`));
process.on('unhandledRejection', (e) => log('main.log', `unhandled rejection: ${e && e.stack || e}`));

// ── single instance ──
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', () => showWindow());
}

// ── window state (position, size, maximised) ──
const STATE = path.join(USER, 'window-state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function saveState() { if (!win || win.isDestroyed()) return; try { const b = win.isMaximized() || win.isFullScreen() ? (loadState().bounds ?? win.getNormalBounds()) : win.getBounds(); fs.writeFileSync(STATE, JSON.stringify({ bounds: b, maximized: win.isMaximized() })); } catch { /* */ } }

// ── the server child ──
function serverEnv() {
  const legacyFile = path.join(APP_DIR, 'legacy-path.txt'); let legacy = process.env.FOLIO_LEGACY_DATA_DIR || '';
  if (!legacy && fs.existsSync(legacyFile)) legacy = fs.readFileSync(legacyFile, 'utf8').trim();
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: path.join(APP_DIR, '_nm'), NODE_ENV: 'production', PORT: String(PORT), HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1',
    BOOKREADER_DATA_DIR: DATA, FOLIO_ENV: 'production', FOLIO_DESKTOP_SECRET: SECRET, FOLIO_LEGACY_DATA_DIR: legacy, FOLIO_SECURE_COOKIES: '0', FOLIO_ALLOW_REGISTRATION: 'false', FOLIO_REQUIRE_EMAIL_VERIFICATION: 'false',
    FOLIO_SESSION_IDLE_SECONDS: String(365 * 86400), FOLIO_SESSION_ABSOLUTE_SECONDS: String(365 * 86400), FOLIO_API_RATE_PER_MIN: '60000', FOLIO_USER_QUOTA_MB: String(200_000) };
}
function startServer() {
  return new Promise((resolve, reject) => {
    const script = path.join(APP_DIR, 'server.js'); if (!fs.existsSync(script)) return reject(new Error(`server bundle missing: ${script}`));
    server = spawn(process.execPath, [script], { cwd: APP_DIR, env: serverEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = (d) => log('server.log', String(d).trimEnd()); server.stdout.on('data', out); server.stderr.on('data', out);
    server.on('exit', (code, sig) => { log('main.log', `server exited code=${code} sig=${sig}`); server = null; if (!quitting && !restarting) { superviseRestart('server process exited'); } });
    waitHealthy(60_000).then(resolve, reject);
  });
}
const ping = (p = '/api/health') => new Promise((res) => { const r = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000, headers: { host: `127.0.0.1:${PORT}` } }, (x) => { x.resume(); res(x.statusCode === 200); }); r.on('timeout', () => { r.destroy(); res(false); }); r.on('error', () => res(false)); });
async function waitHealthy(ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await ping()) return; await new Promise((r) => setTimeout(r, 300)); } throw new Error('Folio server did not become ready'); }
async function stopServer() { const s = server; if (!s) return; server = null; try { s.kill(); } catch { /* */ } await new Promise((r) => setTimeout(r, 400)); if (process.platform === 'win32' && s.pid) { try { spawnSync('taskkill', ['/pid', String(s.pid), '/T', '/F'], { windowsHide: true }); } catch { /* */ } } }
let restartDelay = 1000;
async function superviseRestart(reason) {
  if (restarting || quitting) return; restarting = true; serverReady = false; log('main.log', `restarting server: ${reason}`); showStatusPage('Folio is restarting its engine…');
  try { await stopServer(); await new Promise((r) => setTimeout(r, restartDelay)); await startServer(); await signIn(); serverReady = true; restartDelay = 1000; healthFails = 0; if (win && !win.isDestroyed()) win.loadURL(ORIGIN + '/'); log('main.log', 'server recovered'); }
  catch (e) { log('main.log', `restart failed: ${e.message}`); restartDelay = Math.min(restartDelay * 2, 30_000); restarting = false; setTimeout(() => superviseRestart('retry'), restartDelay); return; }
  restarting = false;
}
setInterval(async () => { if (quitting || restarting || !server || !serverReady) return; /* the watchdog only judges a server that has finished starting */ if (await ping()) { healthFails = 0; return; } if (++healthFails >= 3) superviseRestart('health check failed 3×'); }, 5000);

// ── automatic sign-in of the local owner (no password screen on your own computer) ──
async function signIn() {
  let r; for (let i = 0; i < 8; i++) { try { r = await fetch(ORIGIN + '/api/desktop/login', { method: 'POST', headers: { 'x-folio-desktop': SECRET, 'content-type': 'application/json' }, body: '{}' }); break; } catch (e) { if (i === 7) throw e; await new Promise((res) => setTimeout(res, 800)); } }
  if (!r.ok) throw new Error(`desktop sign-in failed (${r.status})`); const j = await r.json(); if (j.imported) log('main.log', `legacy import: ${JSON.stringify(j.imported)}`);
  const ses = session.fromPartition('persist:folio'); const exp = Math.floor(Date.now() / 1000) + 365 * 86400;
  for (const c of j.cookies) { const [kv, ...attrs] = c.split(';'); const i = kv.indexOf('='); const name = kv.slice(0, i).trim(), value = kv.slice(i + 1).trim(); await ses.cookies.set({ url: ORIGIN, name, value, path: '/', httpOnly: attrs.some((a) => /httponly/i.test(a)), secure: false, sameSite: 'lax', expirationDate: exp }); }
}

// ── daily automatic backup (keeps the 7 newest) ──
function backupIfDue() {
  const now = Date.now(); if (now - lastBackupCheck < 3600_000) return; lastBackupCheck = now;
  try { const dirs = fs.readdirSync(BACKUPS).filter((d) => d.startsWith('folio-')).sort(); const last = dirs.length ? fs.statSync(path.join(BACKUPS, dirs[dirs.length - 1])).mtimeMs : 0; if (now - last < 22 * 3600_000) return;
    const s = path.join(APP_DIR, 'scripts', 'backup.mjs'); if (!fs.existsSync(s)) return;
    const p = spawn(process.execPath, [s, '--data', DATA, '--out', BACKUPS], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => log('main.log', `backup: ${String(d).trim()}`)); p.stderr.on('data', () => {});
    p.on('exit', (c) => { if (c === 0) { const all = fs.readdirSync(BACKUPS).filter((d) => d.startsWith('folio-')).sort(); for (const old of all.slice(0, Math.max(0, all.length - 7))) fs.rmSync(path.join(BACKUPS, old), { recursive: true, force: true }); } else log('main.log', `backup failed (code ${c})`); });
  } catch (e) { log('main.log', `backup error: ${e.message}`); }
}
setInterval(backupIfDue, 3600_000);

// ── keep the local AI runtime (Ollama) running if it is installed ──
const pingOllama = () => new Promise((res) => { const r = http.get({ host: '127.0.0.1', port: 11434, path: '/api/tags', timeout: 2000 }, (x) => { x.resume(); res(x.statusCode === 200); }); r.on('timeout', () => { r.destroy(); res(false); }); r.on('error', () => res(false)); });
async function ensureOllama() {
  if (await pingOllama()) return;
  const cands = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'), path.join(process.env['ProgramFiles'] || '', 'Ollama', 'ollama.exe')].filter((p) => fs.existsSync(p));
  if (!cands.length) { log('main.log', 'Ollama not found; AI features need it (https://ollama.com)'); return; }
  try { const p = spawn(cands[0], ['serve'], { detached: true, windowsHide: true, stdio: 'ignore' }); p.unref(); log('main.log', 'started Ollama'); } catch (e) { log('main.log', `could not start Ollama: ${e.message}`); }
}
setInterval(ensureOllama, 60_000);

// ── window ──
function statusHtml(msg) { return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Folio</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#17171a;color:#e8e6e1;font:16px system-ui"><div style="text-align:center"><div style="font:700 28px Georgia">Folio</div><p style="opacity:.7">${msg}</p></div>`); }
function showStatusPage(msg) { if (win && !win.isDestroyed()) win.loadURL(statusHtml(msg)); }
function showWindow() { if (!win || win.isDestroyed()) return createWindow(false); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function createWindow(startHidden) {
  const st = loadState(); const ses = session.fromPartition('persist:folio');
  win = new BrowserWindow({ width: st.bounds?.width ?? 1360, height: st.bounds?.height ?? 880, x: st.bounds?.x, y: st.bounds?.y, minWidth: 420, minHeight: 600, show: false, backgroundColor: '#17171a', title: 'Folio', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true } });
  win.setMenuBarVisibility(false);
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.on('close', (e) => { saveState(); if (!quitting) { e.preventDefault(); win.hide(); } });  // closing hides to the tray; Quit in the tray menu really exits
  win.on('resize', saveState); win.on('move', saveState);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url) && !url.startsWith(ORIGIN)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN) && !url.startsWith('data:text/html')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('render-process-gone', (_e, d) => { log('main.log', `renderer gone: ${d.reason}`); if (!quitting) setTimeout(() => win && !win.isDestroyed() && win.loadURL(ORIGIN + '/'), 500); });
  win.webContents.on('unresponsive', () => { log('main.log', 'window unresponsive'); setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 8000); });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => { if (code === -3 || !url.startsWith(ORIGIN)) return; log('main.log', `load failed ${code} ${desc}`); setTimeout(() => !quitting && win && !win.isDestroyed() && win.loadURL(ORIGIN + '/'), 1500); });
  win.loadURL(ORIGIN + '/');
}
// camera/microphone only for Folio itself (journal recordings); everything else denied
function setupPermissions() {
  const ses = session.fromPartition('persist:folio'); const ok = (wc, perm) => wc && wc.getURL().startsWith(ORIGIN) && ['media', 'mediaKeySystem', 'clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(perm);
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(!!ok(wc, perm))); ses.setPermissionCheckHandler((wc, perm) => !!ok(wc, perm));
}

// ── tray ──
const AUTOSTART = path.join(USER, 'autostart.json');
const autostartWanted = () => { try { return JSON.parse(fs.readFileSync(AUTOSTART, 'utf8')).enabled !== false; } catch { return true; } };
function applyAutostart() { try { app.setLoginItemSettings({ openAtLogin: autostartWanted(), args: ['--hidden'] }); } catch (e) { log('main.log', `autostart: ${e.message}`); } }
function loginItem() { return autostartWanted(); }
function buildTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 20, height: 20 }); tray = new Tray(img); tray.setToolTip('Folio — running');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Folio', click: showWindow }, { type: 'separator' },
    { label: 'Start Folio when I sign in to Windows', type: 'checkbox', checked: loginItem(), click: (i) => { fs.writeFileSync(AUTOSTART, JSON.stringify({ enabled: i.checked })); applyAutostart(); } },
    { label: 'Restart engine', click: () => superviseRestart('manual') }, { label: 'Open my data folder', click: () => shell.openPath(DATA) }, { label: 'Open logs', click: () => shell.openPath(LOGS) }, { label: 'Back up now', click: () => { lastBackupCheck = 0; try { for (const d of fs.readdirSync(BACKUPS)) { const p = path.join(BACKUPS, d); if (d.startsWith('folio-')) fs.utimesSync(p, new Date(0), new Date(0)); } } catch { /* */ } backupIfDue(); } },
    { type: 'separator' }, { label: 'Quit Folio', click: () => { quitting = true; app.quit(); } }]);
  tray.setContextMenu(menu()); tray.on('click', showWindow); tray.on('double-click', showWindow);
}

app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('before-quit', () => { quitting = true; saveState(); });
app.on('will-quit', (e) => { if (server) { e.preventDefault(); stopServer().finally(() => app.exit(0)); } });
app.on('activate', showWindow);

app.whenReady().then(async () => {
  if (!app.hasSingleInstanceLock()) return;
  applyAutostart(); // starts with Windows by default (re-pointed at THIS exe on every launch, so reinstalling/moving never leaves a dead startup entry); switch off in the tray menu
  setupPermissions(); buildTray(); createWindow(hidden); showStatusPage('Starting Folio…');
  ensureOllama();
  try { await startServer(); await signIn(); serverReady = true; win && !win.isDestroyed() && win.loadURL(ORIGIN + '/'); log('main.log', `Folio ready on ${ORIGIN}`); setTimeout(backupIfDue, 30_000); }
  catch (e) { log('main.log', `startup failed: ${e.stack || e.message}`); showStatusPage(`Folio could not start: ${e.message}. See the logs in ${LOGS}`); setTimeout(() => superviseRestart('startup failure'), 5000); }
  powerMonitor.on('resume', async () => { log('main.log', 'resumed from sleep'); if (!(await ping())) superviseRestart('after resume'); else if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache(); ensureOllama(); });
});
void dialog; void ipcMain;
