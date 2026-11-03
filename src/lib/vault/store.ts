// Vault: a folder of plain files (source of truth) plus a rebuildable SQLite index (links, tags, properties, headings, tasks, full text).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run, uid, tx, db, DATA_DIR, LOCAL_USER } from '../db';
import { parseNote, editFrontmatter, headingKey, maskCode, type ParsedLink } from './parse';

export class VaultError extends Error { constructor(msg: string, public status = 400, public extra?: unknown) { super(msg); } }
const now = () => Date.now();
const MAX_INDEX_BYTES = 5 * 1024 * 1024;
const HISTORY_DIR = path.join(DATA_DIR, 'vault-history');
export const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const posix = (p: string) => p.split(path.sep).join('/');
const isMd = (p: string) => /\.md$/i.test(p);

export interface Vault { id: string; name: string; root: string; created_at: number; last_opened: number | null }

// ───────────── registry ─────────────
export const listVaults = () => all<Vault>('SELECT * FROM vaults WHERE user_id = ? ORDER BY COALESCE(last_opened, created_at) DESC', LOCAL_USER);
export function getVault(id: string | null | undefined): Vault {
  const v = id ? get<Vault>('SELECT * FROM vaults WHERE id = ? AND user_id = ?', id, LOCAL_USER) : listVaults()[0];
  if (!v) throw new VaultError('No vault yet. Create one first.', 404);
  if (!fs.existsSync(v.root)) throw new VaultError(`The vault folder is missing: ${v.root}`, 410);
  return v;
}
const cleanName = (n: string) => n.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 80);
export function createVault(name: string, root?: string, mustExist = false): Vault {
  const nm = cleanName(name); if (!nm) throw new VaultError('A vault needs a name.');
  let dir: string;
  if (root) { dir = path.resolve(root); if (mustExist && !(fs.existsSync(dir) && fs.statSync(dir).isDirectory())) throw new VaultError('That folder does not exist.'); }
  else dir = path.join(DATA_DIR, 'vaults', nm);
  if (!root && fs.existsSync(dir)) throw new VaultError('A vault with that name already exists.');
  if (get('SELECT 1 FROM vaults WHERE user_id = ? AND root = ?', LOCAL_USER, dir)) throw new VaultError('That folder is already a vault.');
  fs.mkdirSync(dir, { recursive: true });
  const id = uid(); run('INSERT INTO vaults (id, user_id, name, root, created_at, last_opened) VALUES (?,?,?,?,?,?)', id, LOCAL_USER, nm, dir, now(), now());
  const v = getVault(id); scan(v); return v;
}
export function renameVault(id: string, name: string) { const nm = cleanName(name); if (!nm) throw new VaultError('A vault needs a name.'); run('UPDATE vaults SET name = ? WHERE id = ? AND user_id = ?', nm, id, LOCAL_USER); }
/** Forget a vault. Never deletes files. */
export function forgetVault(id: string) { run('DELETE FROM vaults WHERE id = ? AND user_id = ?', id, LOCAL_USER); fileSets.delete(id); }
export const touchVault = (id: string) => run('UPDATE vaults SET last_opened = ? WHERE id = ?', now(), id);

// ───────────── safe paths ─────────────
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Resolve a vault-relative path; rejects traversal, absolute paths, NULs, reserved names and symlinks that leave the vault. */
export function safePath(v: Vault, rel: string): string {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new VaultError('Invalid path.');
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) throw new VaultError('Absolute paths are not allowed.');
  const parts = norm.split('/'); if (parts.some((p) => p === '..' || p === '' && parts.length > 1 && false)) throw new VaultError('Path traversal is not allowed.');
  for (const p of parts) { if (p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || RESERVED.test(p) || /[. ]$/.test(p)) throw new VaultError(`Invalid file name: ${p}`); }
  const full = path.resolve(v.root, ...parts);
  const rootReal = fs.realpathSync(v.root);
  let probe = full; while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  const real = fs.realpathSync(probe);
  const rel2 = path.relative(rootReal, real);
  if (rel2.startsWith('..') || path.isAbsolute(rel2)) throw new VaultError('That path escapes the vault.', 403);
  const lex = path.relative(v.root, full); if (lex.startsWith('..') || path.isAbsolute(lex)) throw new VaultError('Path traversal is not allowed.', 403);
  return full;
}

// ───────────── file set + link resolution ─────────────
interface FileSet { paths: string[]; byName: Map<string, string[]>; byFile: Map<string, string[]>; byPath: Map<string, string>; alias: Map<string, string[]> }
const fileSets = new Map<string, FileSet>();
function fileSet(v: Vault): FileSet {
  const c = fileSets.get(v.id); if (c) return c;
  const paths = all<{ path: string }>('SELECT path FROM vfiles WHERE vault_id = ?', v.id).map((r) => r.path);
  const byName = new Map<string, string[]>(), byFile = new Map<string, string[]>(), byPath = new Map<string, string>(), alias = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, p: string) => { const a = m.get(k); if (a) a.push(p); else m.set(k, [p]); };
  for (const p of paths) { byPath.set(p.toLowerCase(), p); const base = p.split('/').pop()!; push(byFile, base.toLowerCase(), p); if (isMd(p)) push(byName, base.replace(/\.md$/i, '').toLowerCase(), p); }
  for (const r of all<{ path: string; value: string }>("SELECT path, value FROM vprops WHERE vault_id = ? AND key IN ('aliases','alias')", v.id)) { try { const a = JSON.parse(r.value); for (const x of Array.isArray(a) ? a : [a]) if (x) push(alias, String(x).toLowerCase(), r.path); } catch { /* ignore */ } }
  const fs_: FileSet = { paths, byName, byFile, byPath, alias }; fileSets.set(v.id, fs_); return fs_;
}
const pick = (cands: string[], src: string): { target: string; ambiguous: boolean } => {
  if (cands.length === 1) return { target: cands[0], ambiguous: false };
  const dir = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : '';
  const sameDir = cands.filter((c) => (c.includes('/') ? c.slice(0, c.lastIndexOf('/')) : '') === dir);
  const pool = sameDir.length ? sameDir : cands;
  return { target: [...pool].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0], ambiguous: true };
};
export function resolveIn(fsx: FileSet, src: string, raw: string, md: boolean): { target: string | null; ambiguous: boolean } {
  let r = raw.trim().replace(/\\/g, '/'); if (!r) return { target: src, ambiguous: false };
  const lower = r.toLowerCase();
  if (md || r.startsWith('./') || r.startsWith('../')) { // relative to the linking note, then vault-root
    const dir = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : '';
    const joined = path.posix.normalize(dir ? `${dir}/${r}` : r).replace(/^\.\//, '');
    for (const c of [joined, `${joined}.md`, r, `${r}.md`]) { const hit = fsx.byPath.get(c.toLowerCase()); if (hit) return { target: hit, ambiguous: false }; }
  }
  if (lower.includes('/')) {
    const want = [lower, `${lower}.md`]; const cands = fsx.paths.filter((p) => want.some((w) => p.toLowerCase() === w || p.toLowerCase().endsWith('/' + w)));
    if (cands.length) return pick(cands, src);
  } else {
    const hasExt = /\.[a-z0-9]{1,6}$/i.test(lower) && !/\.md$/i.test(lower);
    const cands = hasExt ? fsx.byFile.get(lower) : fsx.byName.get(lower.replace(/\.md$/i, ''));
    if (cands?.length) return pick(cands, src);
    if (hasExt === false) { const al = fsx.alias.get(lower); if (al?.length) return pick(al, src); }
  }
  return { target: null, ambiguous: false };
}

// ───────────── indexing ─────────────
function indexFile(v: Vault, rel: string, text: string) {
  const p = parseNote(text); const fsx = fileSet(v);
  tx(() => {
    for (const t of ['vlinks', 'vtags', 'vprops', 'vheads', 'vtasks'] as const) run(`DELETE FROM ${t} WHERE vault_id = ? AND ${t === 'vlinks' ? 'src' : 'path'} = ?`, v.id, rel);
    for (const l of p.links) { const r = resolveIn(fsx, rel, l.raw, l.md); run('INSERT INTO vlinks (vault_id, src, raw, target, embed, anchor, alias, md, line, ambiguous) VALUES (?,?,?,?,?,?,?,?,?,?)', v.id, rel, l.raw, r.target, l.embed ? 1 : 0, l.anchor, l.alias, l.md ? 1 : 0, l.line, r.ambiguous ? 1 : 0); }
    for (const t of p.tags) run('INSERT INTO vtags (vault_id, path, tag) VALUES (?,?,?)', v.id, rel, t);
    for (const x of p.props) run('INSERT INTO vprops (vault_id, path, key, value, type) VALUES (?,?,?,?,?)', v.id, rel, x.key, JSON.stringify(x.value instanceof Date ? x.value.toISOString() : x.value ?? null), x.type);
    for (const h of p.headings) run('INSERT INTO vheads (vault_id, path, level, text, line) VALUES (?,?,?,?,?)', v.id, rel, h.level, h.text, h.line);
    for (const t of p.tasks) run('INSERT INTO vtasks (vault_id, path, line, done, text) VALUES (?,?,?,?,?)', v.id, rel, t.line, t.done ? 1 : 0, t.text);
    run('INSERT INTO vcontent (vault_id, path, body) VALUES (?,?,?) ON CONFLICT(vault_id, path) DO UPDATE SET body = excluded.body', v.id, rel, text);
  });
  return p;
}
function reresolveAll(v: Vault) {
  fileSets.delete(v.id); const fsx = fileSet(v);
  const rows = all<{ rowid: number; src: string; raw: string; md: number }>('SELECT rowid, src, raw, md FROM vlinks WHERE vault_id = ?', v.id);
  tx(() => { for (const r of rows) { const x = resolveIn(fsx, r.src, r.raw, !!r.md); run('UPDATE vlinks SET target = ?, ambiguous = ? WHERE rowid = ?', x.target, x.ambiguous ? 1 : 0, r.rowid); } });
}
const IGNORED = new Set(['.trash', '.git', 'node_modules', '.folio']);
function walk(root: string, rel = '', out: { rel: string; full: string; st: fs.Stats }[] = []) {
  let ents: fs.Dirent[]; try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.') || IGNORED.has(e.name) || e.name.endsWith('.folio-tmp')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name; const full = path.join(root, r);
    if (e.isSymbolicLink()) { try { const real = fs.realpathSync(full); if (path.relative(fs.realpathSync(root), real).startsWith('..')) continue; } catch { continue; } }
    let st: fs.Stats; try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(root, r, out); else if (st.isFile()) out.push({ rel: r, full, st });
  }
  return out;
}
/** Bring the index in line with the disk: add new files, re-index changed ones, drop deleted ones. Cheap when nothing changed. */
export function scan(v: Vault, opts: { full?: boolean } = {}) {
  const disk = walk(v.root); const known = new Map(all<{ path: string; mtime: number; size: number }>('SELECT path, mtime, size FROM vfiles WHERE vault_id = ?', v.id).map((r) => [r.path, r]));
  const seen = new Set<string>(); const added: string[] = [], changed: string[] = [], removed: string[] = []; const errors: { path: string; error: string }[] = [];
  const pending: { rel: string; text: string | null }[] = [];
  for (const f of disk) {
    seen.add(f.rel); const k = known.get(f.rel); const mt = Math.floor(f.st.mtimeMs);
    const same = k && k.mtime === mt && k.size === f.st.size && !opts.full;
    if (same) continue;
    let text: string | null = null, hash: string | null = null;
    try { if (isMd(f.rel) && f.st.size <= MAX_INDEX_BYTES) { text = fs.readFileSync(f.full, 'utf8'); hash = sha(text); } } catch (e: any) { errors.push({ path: f.rel, error: e.message }); continue; }
    run('INSERT INTO vfiles (vault_id, path, name, ext, mtime, size, hash) VALUES (?,?,?,?,?,?,?) ON CONFLICT(vault_id, path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, hash = excluded.hash',
      v.id, f.rel, path.basename(f.rel).replace(/\.[^.]+$/, ''), path.extname(f.rel).slice(1).toLowerCase(), mt, f.st.size, hash);
    (k ? changed : added).push(f.rel); if (text != null) pending.push({ rel: f.rel, text });
  }
  for (const p of known.keys()) if (!seen.has(p)) { removed.push(p); for (const t of ['vfiles', 'vtags', 'vprops', 'vheads', 'vtasks', 'vcontent'] as const) run(`DELETE FROM ${t} WHERE vault_id = ? AND path = ?`, v.id, p); run('DELETE FROM vlinks WHERE vault_id = ? AND src = ?', v.id, p); }
  const setChanged = added.length > 0 || removed.length > 0;
  if (setChanged || pending.length) fileSets.delete(v.id);
  for (const x of pending) { try { indexFile(v, x.rel, x.text!); } catch (e: any) { errors.push({ path: x.rel, error: e.message }); } }
  if (setChanged || pending.some((x) => parseNote(x.text!).aliases.length)) reresolveAll(v); // new/removed files change what links resolve to
  return { added, changed, removed, errors, files: disk.length };
}

// ───────────── file operations ─────────────
export interface FileEntry { path: string; name: string; ext: string; size: number; mtime: number }
export const listFiles = (v: Vault): FileEntry[] => all<FileEntry>('SELECT path, name, ext, size, mtime FROM vfiles WHERE vault_id = ? ORDER BY path COLLATE NOCASE', v.id);
export function listFolders(v: Vault): string[] { const out: string[] = []; const rec = (rel: string) => { for (const e of fs.readdirSync(path.join(v.root, rel), { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && !IGNORED.has(e.name)) { const r = rel ? `${rel}/${e.name}` : e.name; out.push(r); rec(r); } }; rec(''); return out; }

export function readFile(v: Vault, rel: string) {
  const full = safePath(v, rel); if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new VaultError('File not found.', 404);
  const text = fs.readFileSync(full, 'utf8'); const st = fs.statSync(full);
  return { path: rel, text, hash: sha(text), mtime: Math.floor(st.mtimeMs), size: st.size };
}
function atomicWrite(full: string, text: string) { fs.mkdirSync(path.dirname(full), { recursive: true }); const tmp = `${full}.${process.pid}.folio-tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, full); }

function snapshot(v: Vault, rel: string, text: string, reason: string, throttleMs = 0) {
  const h = sha(text); const last = get<{ hash: string; created_at: number }>('SELECT hash, created_at FROM vhistory WHERE vault_id = ? AND path = ? ORDER BY created_at DESC LIMIT 1', v.id, rel);
  if (last?.hash === h) return; if (throttleMs && last && now() - last.created_at < throttleMs) return;
  const id = uid(); fs.mkdirSync(path.join(HISTORY_DIR, v.id), { recursive: true }); fs.writeFileSync(path.join(HISTORY_DIR, v.id, id), text);
  run('INSERT INTO vhistory (id, vault_id, path, hash, size, reason, created_at) VALUES (?,?,?,?,?,?,?)', id, v.id, rel, h, Buffer.byteLength(text), reason, now());
  const old = all<{ id: string }>('SELECT id FROM vhistory WHERE vault_id = ? AND path = ? ORDER BY created_at DESC LIMIT -1 OFFSET 60', v.id, rel);
  for (const o of old) { try { fs.unlinkSync(path.join(HISTORY_DIR, v.id, o.id)); } catch { /* gone */ } run('DELETE FROM vhistory WHERE id = ?', o.id); }
}
/** Save a file. If `baseHash` is given and the disk copy no longer matches it (edited elsewhere), nothing is written and a 409 is raised. */
export function writeFile(v: Vault, rel: string, text: string, o: { baseHash?: string | null; reason?: string; create?: boolean } = {}) {
  if (typeof text !== 'string') throw new VaultError('text required');
  if (Buffer.byteLength(text) > 20 * 1024 * 1024) throw new VaultError('File too large (20 MB limit).', 413);
  const full = safePath(v, rel); const exists = fs.existsSync(full);
  if (exists && fs.statSync(full).isDirectory()) throw new VaultError('That path is a folder.');
  if (o.create && exists) throw new VaultError('A file with that name already exists.', 409);
  let prev: string | null = null; if (exists) prev = fs.readFileSync(full, 'utf8');
  if (exists && o.baseHash != null && sha(prev!) !== o.baseHash) throw new VaultError('This file changed on disk since you opened it.', 409, { disk: { text: prev, hash: sha(prev!) } });
  if (prev != null && prev !== text) snapshot(v, rel, prev, o.reason ?? 'edit', o.reason ? 0 : 45_000);
  atomicWrite(full, text);
  const st = fs.statSync(full); const hash = sha(text);
  run('INSERT INTO vfiles (vault_id, path, name, ext, mtime, size, hash) VALUES (?,?,?,?,?,?,?) ON CONFLICT(vault_id, path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, hash = excluded.hash', v.id, rel, path.basename(rel).replace(/\.[^.]+$/, ''), path.extname(rel).slice(1).toLowerCase(), Math.floor(st.mtimeMs), st.size, hash);
  if (!exists) fileSets.delete(v.id);
  const parsed = isMd(rel) ? indexFile(v, rel, text) : null;
  if (!exists || (parsed && parsed.aliases.length) || prev != null && parseNote(prev).aliases.join() !== (parsed?.aliases ?? []).join()) reresolveAll(v);
  return { path: rel, hash, mtime: Math.floor(st.mtimeMs), created: !exists };
}
export function writeBinary(v: Vault, rel: string, data: Buffer) {
  const full = safePath(v, rel); if (fs.existsSync(full)) throw new VaultError('A file with that name already exists.', 409);
  if (data.length > 100 * 1024 * 1024) throw new VaultError('Attachment too large (100 MB limit).', 413);
  fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, data); scan(v); return { path: rel };
}
export function makeFolder(v: Vault, rel: string) { const full = safePath(v, rel); if (fs.existsSync(full)) throw new VaultError('That already exists.', 409); fs.mkdirSync(full, { recursive: true }); }

/** Soft delete: files go to <vault>/.trash so they are never lost. */
export function deletePath(v: Vault, rel: string) {
  const full = safePath(v, rel); if (!fs.existsSync(full)) throw new VaultError('Not found.', 404);
  const trash = path.join(v.root, '.trash'); let dest = path.join(trash, rel); if (fs.existsSync(dest)) dest = `${dest}.${now()}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (isMd(rel) && fs.statSync(full).isFile()) snapshot(v, rel, fs.readFileSync(full, 'utf8'), 'delete');
  fs.renameSync(full, dest); return scan(v);
}

/** Rename or move a file/folder and rewrite every link that pointed at it. */
export function movePath(v: Vault, from: string, to: string) {
  const src = safePath(v, from); const dst = safePath(v, to);
  if (!fs.existsSync(src)) throw new VaultError('Not found.', 404); if (fs.existsSync(dst)) throw new VaultError('Something with that name already exists.', 409);
  if (dst.startsWith(src + path.sep)) throw new VaultError('Cannot move a folder into itself.');
  scan(v); const oldSet = fileSet(v); const isDir = fs.statSync(src).isDirectory();
  const moves = new Map<string, string>();
  for (const p of oldSet.paths) { if (p === from) moves.set(p, to); else if (isDir && p.startsWith(from + '/')) moves.set(p, to + p.slice(from.length)); }
  fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(src, dst);
  const newPaths = oldSet.paths.map((p) => moves.get(p) ?? p);
  const nameCount = new Map<string, number>(); for (const p of newPaths) { const k = p.split('/').pop()!.replace(/\.md$/i, '').toLowerCase(); nameCount.set(k, (nameCount.get(k) ?? 0) + 1); }
  let rewritten = 0;
  for (const oldSrc of oldSet.paths.filter((p) => isMd(p))) {
    const newSrc = moves.get(oldSrc) ?? oldSrc; const fp = path.join(v.root, newSrc); let text: string; try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    const links = parseNote(text); const body = links.body; const off = links.bodyOffset; let out = ''; let cur = 0; let any = false;
    for (const l of links.links) {
      const target = resolveIn(oldSet, oldSrc, l.raw, l.md).target; if (!target) continue;
      const newTarget = moves.get(target) ?? target;
      if (newTarget === target && newSrc === oldSrc) continue; if (!l.md && newTarget === target) continue; // wikilinks are path-independent unless the target moved
      const rep = rewriteLink(l, newTarget, newSrc, nameCount, target !== newTarget); if (rep == null || rep === l.text) continue;
      out += body.slice(cur, l.start) + rep; cur = l.end; any = true;
    }
    if (!any) continue; out += body.slice(cur);
    const next = text.slice(0, off) + out; snapshot(v, newSrc, text, 'link-update'); atomicWrite(fp, next); rewritten++;
  }
  for (const [o, n] of moves) run('UPDATE vhistory SET path = ? WHERE vault_id = ? AND path = ?', n, v.id, o);
  const r = scan(v); return { moved: [...moves.entries()], rewritten, ...r };
}
function rewriteLink(l: ParsedLink, newTarget: string, newSrc: string, nameCount: Map<string, number>, targetMoved: boolean): string | null {
  const noExt = (p: string) => p.replace(/\.md$/i, '');
  if (!l.md) {
    const base = newTarget.split('/').pop()!; const isNote = isMd(newTarget); const key = noExt(base).toLowerCase();
    const raw = isNote ? ((nameCount.get(key) ?? 1) > 1 || l.raw.includes('/') ? noExt(newTarget) : noExt(base)) : (l.raw.includes('/') ? newTarget : base);
    return `${l.embed ? '!' : ''}[[${raw}${l.anchor ? '#' + l.anchor : ''}${l.alias ? '|' + l.alias : ''}]]`;
  }
  void targetMoved;
  let rel = path.posix.relative(path.posix.dirname(newSrc), newTarget); if (!rel.startsWith('.')) rel = rel; if (isMd(newTarget)) rel = noExt(rel) + '.md';
  const enc = rel.split('/').map(encodeURIComponent).join('/');
  return `${l.embed ? '!' : ''}[${l.alias ?? ''}](${enc}${l.anchor ? '#' + encodeURIComponent(l.anchor) : ''})`;
}

// ───────────── history ─────────────
export const history = (v: Vault, rel: string) => all<{ id: string; hash: string; size: number; reason: string; created_at: number }>('SELECT id, hash, size, reason, created_at FROM vhistory WHERE vault_id = ? AND path = ? ORDER BY created_at DESC', v.id, rel);
export function historyText(v: Vault, id: string) { const h = get<{ path: string }>('SELECT path FROM vhistory WHERE id = ? AND vault_id = ?', id, v.id); if (!h) throw new VaultError('Version not found.', 404); return { path: h.path, text: fs.readFileSync(path.join(HISTORY_DIR, v.id, id), 'utf8') }; }
/** Restoring is itself reversible: the current text is snapshotted first. */
export function restore(v: Vault, id: string) { const h = historyText(v, id); const cur = fs.existsSync(safePath(v, h.path)) ? readFile(v, h.path) : null; return writeFile(v, h.path, h.text, { reason: 'restore', baseHash: cur?.hash ?? null }); }

// ───────────── relationships ─────────────
export const outgoing = (v: Vault, rel: string) => all<any>('SELECT raw, target, embed, anchor, alias, line, ambiguous FROM vlinks WHERE vault_id = ? AND src = ? ORDER BY line', v.id, rel);
const lineText = (body: string, line: number) => (body.split('\n')[line] ?? '').trim().slice(0, 240);
export function backlinks(v: Vault, rel: string) {
  const rows = all<any>('SELECT l.src, l.raw, l.alias, l.embed, l.line, l.anchor, c.body FROM vlinks l JOIN vcontent c ON c.vault_id = l.vault_id AND c.path = l.src WHERE l.vault_id = ? AND l.target = ? AND l.src != ? ORDER BY l.src, l.line', v.id, rel, rel);
  const linked = rows.map((r) => ({ src: r.src, line: r.line, embed: !!r.embed, anchor: r.anchor, context: lineText(parseNote(r.body).body, r.line) }));
  const self = get<any>('SELECT name FROM vfiles WHERE vault_id = ? AND path = ?', v.id, rel);
  if (!self || !isMd(rel)) return { linked, unlinked: [] };
  const names = [self.name, ...(all<{ value: string }>("SELECT value FROM vprops WHERE vault_id = ? AND path = ? AND key IN ('aliases','alias')", v.id, rel).flatMap((r) => { try { const a = JSON.parse(r.value); return Array.isArray(a) ? a : [a]; } catch { return []; } }))].filter((n) => n && String(n).length > 1).map(String);
  const linkedSrc = new Set(rows.map((r) => r.src)); const unlinked: { src: string; line: number; context: string; term: string }[] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  for (const c of all<{ path: string; body: string }>('SELECT path, body FROM vcontent WHERE vault_id = ? AND path != ?', v.id, rel)) {
    if (linkedSrc.has(c.path) || unlinked.length >= 60) continue;
    const body = parseNote(c.body).body; if (!rx.test(body)) continue;
    const stripped = maskCode(body).replace(/!?\[\[[^\]]*\]\]/g, (m) => ' '.repeat(m.length)).replace(/!?\[[^\]]*\]\([^)]*\)/g, (m) => ' '.repeat(m.length));
    const lines = stripped.split('\n'); for (let i = 0; i < lines.length; i++) { const m = rx.exec(lines[i]); if (m) { unlinked.push({ src: c.path, line: i, context: lineText(body, i), term: m[0] }); break; } }
  }
  return { linked, unlinked };
}
export function linkUnmentioned(v: Vault, src: string, target: string, line: number, term: string) {
  const f = readFile(v, src); const p = parseNote(f.text); const lines = p.body.split('\n'); const i = lines[line]?.toLowerCase().indexOf(term.toLowerCase()); if (i == null || i < 0) throw new VaultError('The mention moved; refresh.', 409);
  const base = target.split('/').pop()!.replace(/\.md$/i, ''); const actual = lines[line].slice(i, i + term.length);
  lines[line] = lines[line].slice(0, i) + (actual === base ? `[[${base}]]` : `[[${base}|${actual}]]`) + lines[line].slice(i + term.length);
  return writeFile(v, src, f.text.slice(0, p.bodyOffset) + lines.join('\n'), { baseHash: f.hash, reason: 'link-mention' });
}
export function tagTree(v: Vault) {
  const rows = all<{ tag: string; n: number }>('SELECT tag, COUNT(DISTINCT path) n FROM vtags WHERE vault_id = ? GROUP BY tag ORDER BY tag', v.id);
  const counts = new Map<string, number>(); for (const r of rows) { const parts = r.tag.split('/'); for (let i = 1; i <= parts.length; i++) { const k = parts.slice(0, i).join('/'); counts.set(k, 0); } }
  for (const k of counts.keys()) counts.set(k, get<{ n: number }>('SELECT COUNT(DISTINCT path) n FROM vtags WHERE vault_id = ? AND (tag = ? OR tag LIKE ? ESCAPE \'\\\')', v.id, k, k.replace(/[%_\\]/g, '\\$&') + '/%')?.n ?? 0);
  return [...counts.entries()].map(([tag, n]) => ({ tag, n })).sort((a, b) => a.tag.localeCompare(b.tag));
}
export const filesWithTag = (v: Vault, tag: string) => all<{ path: string }>("SELECT DISTINCT path FROM vtags WHERE vault_id = ? AND (tag = ? OR tag LIKE ? ESCAPE '\\')", v.id, tag, tag.replace(/[%_\\]/g, '\\$&') + '/%').map((r) => r.path);
export function propSummary(v: Vault) {
  const rows = all<{ key: string; type: string; n: number }>('SELECT key, type, COUNT(*) n FROM vprops WHERE vault_id = ? GROUP BY key, type ORDER BY n DESC', v.id);
  return rows.map((r) => ({ ...r, values: all<{ value: string }>('SELECT DISTINCT value FROM vprops WHERE vault_id = ? AND key = ? LIMIT 25', v.id, r.key).map((x) => { try { return JSON.parse(x.value); } catch { return x.value; } }) }));
}
export const fileProps = (v: Vault, rel: string) => { const f = readFile(v, rel); const p = parseNote(f.text); return { path: rel, props: p.props.map((x) => ({ key: x.key, type: x.type, value: x.value instanceof Date ? x.value.toISOString() : x.value })), raw: p.fmRaw, error: p.fmError, hash: f.hash }; };

export function setProps(v: Vault, rel: string, o: { set?: Record<string, unknown>; remove?: string[]; rename?: Record<string, string>; raw?: string; baseHash?: string }) {
  const f = readFile(v, rel); if (o.baseHash && o.baseHash !== f.hash) throw new VaultError('This file changed on disk since you opened it.', 409);
  let next: string;
  if (typeof o.raw === 'string') { const YAML = parseNote(`---\n${o.raw}\n---\n`); if (YAML.fmError) throw new VaultError(`Invalid YAML: ${YAML.fmError}`); const { body } = parseNote(f.text); next = o.raw.trim() ? `---\n${o.raw.trimEnd()}\n---\n${body}` : body; }
  else next = editFrontmatter(f.text, (doc) => {
    for (const [a, b] of Object.entries(o.rename ?? {})) { if (doc.has(a)) { if (doc.has(b)) throw new VaultError(`Property "${b}" already exists.`); const val = doc.get(a); doc.delete(a); doc.set(b, val); } }
    for (const [k, val] of Object.entries(o.set ?? {})) { if (!k.trim() || /[:\n]/.test(k)) throw new VaultError(`Invalid property name: ${k}`); doc.set(k, doc.createNode(val)); }
    for (const k of o.remove ?? []) doc.delete(k);
  });
  return writeFile(v, rel, next, { baseHash: f.hash, reason: 'properties' });
}

// ───────────── search ─────────────
interface Q { must: ((c: Cand) => boolean)[]; terms: string[] }
interface Cand { path: string; name: string; body: string; tags: string[]; props: Record<string, unknown> }
export function parseQuery(q: string): { alts: Q[]; terms: string[] } {
  const tokens: string[] = []; const re = /-?(?:"[^"]*"|\/(?:[^/\\]|\\.)+\/[a-z]*|\[[^\]]*\]|[a-z-]+:(?:"[^"]*"|\([^)]*\)|\S+)|\S+)/gi;
  for (const m of q.matchAll(re)) tokens.push(m[0]);
  const groups: string[][] = [[]]; for (const t of tokens) { if (t === 'OR') groups.push([]); else groups.at(-1)!.push(t); }
  let matchCase = false; if (tokens.includes('match-case:')) matchCase = true;
  const all_terms: string[] = [];
  const alts = groups.map((g) => {
    const must: Q['must'] = []; const terms: string[] = [];
    for (let t of g) {
      let neg = false; if (t.startsWith('-') && t.length > 1) { neg = true; t = t.slice(1); }
      const wrap = (f: (c: Cand) => boolean) => must.push(neg ? (c) => !f(c) : f);
      const norm = (s: string) => (matchCase ? s : s.toLowerCase());
      const unq = (s: string) => s.replace(/^["(]|[")]$/g, '');
      let m: RegExpExecArray | null;
      if (t === 'match-case:' || t === 'ignore-case:') { matchCase = t === 'match-case:'; continue; }
      if ((m = /^\[([^:\]]+):?(.*)\]$/.exec(t))) { const key = m[1].trim().toLowerCase(); const val = m[2].trim().toLowerCase(); wrap((c) => { const e = Object.entries(c.props).find(([k]) => k.toLowerCase() === key); if (!e) return false; if (!val) return true; const v = e[1]; return Array.isArray(v) ? v.some((x) => String(x).toLowerCase() === val || String(x).toLowerCase().includes(val)) : String(v).toLowerCase().includes(val); }); continue; }
      if ((m = /^\/((?:[^/\\]|\\.)+)\/([a-z]*)$/.exec(t))) { let rx: RegExp; try { rx = new RegExp(m[1], m[2] || (matchCase ? '' : 'i')); } catch { throw new VaultError('Invalid regular expression.'); } wrap((c) => rx.test(c.body) || rx.test(c.name)); continue; }
      if ((m = /^(file|path|content|tag|line|section|block|task|task-todo|task-done):(.+)$/i.exec(t))) {
        const op = m[1].toLowerCase(); const val = unq(m[2]); const nv = norm(val);
        if (op === 'file') wrap((c) => norm(c.name + '.md').includes(nv) || norm(c.name).includes(nv));
        else if (op === 'path') wrap((c) => norm(c.path).includes(nv));
        else if (op === 'content') { wrap((c) => norm(c.body).includes(nv)); if (!neg) terms.push(val); }
        else if (op === 'tag') { const tg = val.replace(/^#/, '').toLowerCase(); wrap((c) => c.tags.some((x) => x.toLowerCase() === tg || x.toLowerCase().startsWith(tg + '/'))); }
        else if (op === 'line') { const ps = unq(val).split(/\s+/).map(norm); wrap((c) => c.body.split('\n').some((l) => ps.every((p) => norm(l).includes(p)))); }
        else if (op === 'section') wrap((c) => { const ps = norm(val); const lines = c.body.split('\n'); return lines.some((l) => /^#{1,6}\s/.test(l) && norm(l).includes(ps)); });
        else if (op === 'block') wrap((c) => c.body.split('\n').some((l) => /\^[\w-]+\s*$/.test(l) && norm(l).includes(nv)));
        else wrap((c) => { const rx = op === 'task' ? /^\s*[-*+]\s+\[.\]\s+(.*)$/ : op === 'task-todo' ? /^\s*[-*+]\s+\[ \]\s+(.*)$/ : /^\s*[-*+]\s+\[[xX]\]\s+(.*)$/; return c.body.split('\n').some((l) => { const mm = rx.exec(l); return !!mm && norm(mm[1]).includes(nv); }); });
        continue;
      }
      const term = t.replace(/^"|"$/g, ''); if (!term) continue;
      wrap((c) => norm(c.body).includes(norm(term)) || norm(c.name).includes(norm(term))); if (!neg) terms.push(term);
    }
    all_terms.push(...terms); return { must, terms };
  });
  return { alts, terms: all_terms };
}
export function search(v: Vault, query: string, o: { limit?: number; folder?: string; sort?: 'relevance' | 'name' | 'date' } = {}) {
  const { alts, terms } = parseQuery(query); if (!query.trim()) return { results: [], total: 0 };
  const tags = new Map<string, string[]>(); for (const r of all<{ path: string; tag: string }>('SELECT path, tag FROM vtags WHERE vault_id = ?', v.id)) { const a = tags.get(r.path); if (a) a.push(r.tag); else tags.set(r.path, [r.tag]); }
  const props = new Map<string, Record<string, unknown>>(); for (const r of all<{ path: string; key: string; value: string }>('SELECT path, key, value FROM vprops WHERE vault_id = ?', v.id)) { let val: unknown; try { val = JSON.parse(r.value); } catch { val = r.value; } (props.get(r.path) ?? props.set(r.path, {}).get(r.path)!)[r.key] = val; }
  const mt = new Map(all<{ path: string; mtime: number }>('SELECT path, mtime FROM vfiles WHERE vault_id = ?', v.id).map((r) => [r.path, r.mtime]));
  // cheap SQL prefilter on plain terms when the query is a single conjunction
  const plain = alts.length === 1 ? terms.filter((t) => t.length > 1) : [];
  let sql = 'SELECT path, body FROM vcontent WHERE vault_id = ?'; const args: any[] = [v.id];
  if (o.folder) { sql += " AND path LIKE ? ESCAPE '\\'"; args.push(o.folder.replace(/[%_\\]/g, '\\$&').replace(/\/?$/, '/') + '%'); }
  for (const t of plain) { sql += ' AND (instr(lower(body), ?) > 0 OR instr(lower(path), ?) > 0)'; args.push(t.toLowerCase(), t.toLowerCase()); }
  const out: { path: string; name: string; score: number; mtime: number; matches: { line: number; text: string }[] }[] = [];
  for (const r of all<{ path: string; body: string }>(sql, ...args)) {
    const c: Cand = { path: r.path, name: r.path.split('/').pop()!.replace(/\.md$/i, ''), body: r.body, tags: tags.get(r.path) ?? [], props: props.get(r.path) ?? {} };
    if (!alts.some((a) => a.must.every((f) => f(c)))) continue;
    const lc = c.body.toLowerCase(); let score = 0; const matches: { line: number; text: string }[] = [];
    for (const t of terms) { const tl = t.toLowerCase(); if (c.name.toLowerCase().includes(tl)) score += 10; let i = -1, n = 0; while ((i = lc.indexOf(tl, i + 1)) >= 0 && n < 50) { n++; if (matches.length < 5) { const ls = c.body.lastIndexOf('\n', i) + 1; const le = c.body.indexOf('\n', i); const text = c.body.slice(ls, le < 0 ? undefined : le).trim().slice(0, 220); if (!matches.some((m) => m.text === text)) matches.push({ line: c.body.slice(0, i).split('\n').length - 1, text }); } } score += Math.min(n, 20); }
    out.push({ path: r.path, name: c.name, score, mtime: mt.get(r.path) ?? 0, matches });
  }
  const sort = o.sort ?? 'relevance';
  out.sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name) : sort === 'date' ? (a, b) => b.mtime - a.mtime : (a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { results: out.slice(0, o.limit ?? 100), total: out.length, terms };
}
/** Quick switcher: fuzzy match on file name/path/alias. */
export function quickSwitch(v: Vault, q: string, limit = 20) {
  const ql = q.toLowerCase().replace(/\s+/g, ''); const rows = all<{ path: string; name: string; ext: string }>('SELECT path, name, ext FROM vfiles WHERE vault_id = ?', v.id);
  const aliasOf = fileSet(v).alias; const al = new Map<string, string>(); for (const [a, ps] of aliasOf) for (const p of ps) al.set(p, a);
  const score = (hay: string) => { if (!ql) return 1; const h = hay.toLowerCase(); const i = h.indexOf(ql); if (i >= 0) return 100 - i - (h.length - ql.length) * 0.1; let j = 0, s = 0; for (const ch of h) { if (ch === ql[j]) { j++; s += 1; if (j === ql.length) return s * 0.5 - h.length * 0.05; } } return 0; };
  return rows.map((r) => { const a = al.get(r.path); const s = Math.max(score(r.name), score(r.path) * 0.8, a ? score(a) * 0.9 : 0); return { path: r.path, name: r.name, ext: r.ext, alias: a && score(a) > score(r.name) ? a : null, s }; }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.name.localeCompare(b.name)).slice(0, limit);
}

// ───────────── graph ─────────────
export function graph(v: Vault, o: { center?: string; depth?: number; tag?: string; folder?: string; orphans?: boolean; attachments?: boolean; unresolved?: boolean } = {}) {
  let files = all<{ path: string; name: string; ext: string }>('SELECT path, name, ext FROM vfiles WHERE vault_id = ?', v.id);
  if (!o.attachments) files = files.filter((f) => f.ext === 'md');
  if (o.folder) files = files.filter((f) => f.path.startsWith(o.folder!.replace(/\/?$/, '/')));
  if (o.tag) { const s = new Set(filesWithTag(v, o.tag.replace(/^#/, ''))); files = files.filter((f) => s.has(f.path)); }
  const ids = new Set(files.map((f) => f.path)); const tags = new Map<string, string[]>(); for (const r of all<{ path: string; tag: string }>('SELECT path, tag FROM vtags WHERE vault_id = ?', v.id)) { const a = tags.get(r.path); if (a) a.push(r.tag); else tags.set(r.path, [r.tag]); }
  const edges = new Map<string, { source: string; target: string; embed: boolean }>(); const unres = new Map<string, string>();
  for (const l of all<any>('SELECT src, raw, target, embed FROM vlinks WHERE vault_id = ?', v.id)) {
    if (!ids.has(l.src)) continue;
    if (l.target) { if (l.target === l.src || !ids.has(l.target)) continue; edges.set(`${l.src}\u0000${l.target}`, { source: l.src, target: l.target, embed: !!l.embed }); }
    else if (o.unresolved !== false && l.raw) { const k = `?${l.raw.toLowerCase()}`; unres.set(k, l.raw); edges.set(`${l.src}\u0000${k}`, { source: l.src, target: k, embed: !!l.embed }); }
  }
  let nodes = [...files.map((f) => ({ id: f.path, label: f.name, kind: f.ext === 'md' ? 'note' : 'attachment', tags: tags.get(f.path) ?? [], exists: true })), ...[...unres].map(([id, label]) => ({ id, label, kind: 'unresolved', tags: [] as string[], exists: false }))];
  let es = [...edges.values()];
  if (o.center) { const depth = Math.max(1, Math.min(o.depth ?? 1, 4)); const keep = new Set([o.center]); let frontier = [o.center]; for (let d = 0; d < depth; d++) { const nx: string[] = []; for (const e of es) { if (frontier.includes(e.source) && !keep.has(e.target)) { keep.add(e.target); nx.push(e.target); } if (frontier.includes(e.target) && !keep.has(e.source)) { keep.add(e.source); nx.push(e.source); } } frontier = nx; } nodes = nodes.filter((n) => keep.has(n.id)); es = es.filter((e) => keep.has(e.source) && keep.has(e.target)); }
  if (o.orphans === false) { const linked = new Set(es.flatMap((e) => [e.source, e.target])); nodes = nodes.filter((n) => linked.has(n.id) || n.id === o.center); }
  const deg = new Map<string, number>(); for (const e of es) { deg.set(e.source, (deg.get(e.source) ?? 0) + 1); deg.set(e.target, (deg.get(e.target) ?? 0) + 1); }
  return { nodes: nodes.map((n) => ({ ...n, degree: deg.get(n.id) ?? 0 })), edges: es };
}

export function stats(v: Vault) {
  const n = (sql: string) => get<{ n: number }>(sql, v.id)?.n ?? 0;
  return { notes: n("SELECT COUNT(*) n FROM vfiles WHERE vault_id = ? AND ext = 'md'"), attachments: n("SELECT COUNT(*) n FROM vfiles WHERE vault_id = ? AND ext != 'md'"), links: n('SELECT COUNT(*) n FROM vlinks WHERE vault_id = ?'), unresolved: n('SELECT COUNT(*) n FROM vlinks WHERE vault_id = ? AND target IS NULL'), tags: n('SELECT COUNT(DISTINCT tag) n FROM vtags WHERE vault_id = ?') };
}
export function unresolvedLinks(v: Vault) { return all<{ raw: string; n: number; sources: string }>('SELECT raw, COUNT(*) n, group_concat(DISTINCT src) sources FROM vlinks WHERE vault_id = ? AND target IS NULL AND raw != \'\' GROUP BY lower(raw) ORDER BY n DESC LIMIT 200', v.id).map((r) => ({ raw: r.raw, count: r.n, sources: r.sources.split(',').slice(0, 5) })); }
export function sectionOf(text: string, heading: string): string | null {
  const body = parseNote(text).body; const lines = body.split('\n'); const key = headingKey(heading); let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) { const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]); if (m && headingKey(m[2]) === key) { start = i; level = m[1].length; break; } }
  if (start < 0) return null; let end = lines.length; for (let i = start + 1; i < lines.length; i++) { const m = /^(#{1,6})\s/.exec(lines[i]); if (m && m[1].length <= level) { end = i; break; } }
  return lines.slice(start, end).join('\n');
}
export function blockOf(text: string, id: string): string | null {
  const lines = parseNote(text).body.split('\n'); const rx = new RegExp(`\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  const i = lines.findIndex((l) => rx.test(l)); if (i < 0) return null; let s = i; while (s > 0 && lines[s - 1].trim() !== '') s--; return lines.slice(s, i + 1).join('\n').replace(rx, '').trimEnd();
}
void db;

export const getFileSet = fileSet;
export type { FileSet };
