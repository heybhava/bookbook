// Bases: database views over files. The data stays in the notes' own frontmatter; a .base file only stores the query/view definition (YAML, Obsidian-style keys).
// bookbook extension: `source: books | highlights` makes a Base over the reading library (read-only rows that keep their identity).
import YAML from 'yaml';
import { all, me } from '../db';
import { parse, evaluate, truthy, compareValues, toDate, isDate, fmtDate, ExprError, type Env, type Node } from './expr';
import { readFile, writeFile, getFileSet, VaultError, type Vault } from './store';

export type Source = 'notes' | 'books' | 'highlights';
export interface ViewCfg { type: 'table' | 'cards' | 'list' | 'kanban'; name?: string; filters?: unknown; order?: string[]; sort?: { property: string; direction?: 'ASC' | 'DESC' }[]; groupBy?: { property: string; direction?: 'ASC' | 'DESC' }; limit?: number; summaries?: Record<string, string>; image?: string; cardWidth?: number; columnWidths?: Record<string, number>; hideEmptyGroups?: boolean }
export interface BaseCfg { source?: Source; filters?: unknown; formulas?: Record<string, string>; properties?: Record<string, { displayName?: string }>; views: ViewCfg[]; [k: string]: unknown }
const KNOWN = ['source', 'filters', 'formulas', 'properties', 'views'];
const VIEW_TYPES = ['table', 'cards', 'list', 'kanban'];

export function parseBase(text: string): { config: BaseCfg; error: string | null } {
  let raw: any = {}; let error: string | null = null;
  try { const d = YAML.parseDocument(text); if (d.errors.length) error = d.errors[0].message; else raw = d.toJS() ?? {}; } catch (e: any) { error = e.message; }
  if (typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const views: ViewCfg[] = (Array.isArray(raw.views) ? raw.views : []).filter((v: any) => v && typeof v === 'object').map((v: any) => ({ ...v, type: VIEW_TYPES.includes(v.type) ? v.type : 'table' }));
  if (!views.length) views.push({ type: 'table', name: 'Table' });
  return { config: { ...raw, views }, error };
}
/** Write config back, keeping unknown top-level keys and comments from the existing file. */
export function saveBase(v: Vault, rel: string, config: BaseCfg, baseHash?: string) {
  const f = readFile(v, rel); if (baseHash && baseHash !== f.hash) throw new VaultError('This base changed on disk since you opened it.', 409);
  validate(config);
  const doc = f.text.trim() ? YAML.parseDocument(f.text) : new YAML.Document({}); if (doc.errors.length) throw new VaultError('The .base file has invalid YAML; fix it first.');
  if (!doc.contents || !YAML.isMap(doc.contents)) doc.contents = doc.createNode({}) as any;
  for (const k of KNOWN) { const val = (config as any)[k]; if (val === undefined || val === null || (typeof val === 'object' && !Array.isArray(val) && !Object.keys(val).length)) doc.delete(k); else doc.set(k, doc.createNode(val)); }
  return writeFile(v, rel, String(doc), { baseHash: f.hash, reason: 'base' });
}
export function validate(c: BaseCfg) {
  if (!Array.isArray(c.views) || !c.views.length) throw new VaultError('A base needs at least one view.');
  if (c.source && !['notes', 'books', 'highlights'].includes(c.source)) throw new VaultError('Unknown source.');
  const chk = (s: string, where: string) => { try { parse(s); } catch (e: any) { throw new VaultError(`${where}: ${e.message}`); } };
  for (const [k, e] of Object.entries(c.formulas ?? {})) { if (!/^[\p{L}_][\p{L}\p{N}_ -]*$/u.test(k)) throw new VaultError(`Invalid formula name "${k}".`); chk(String(e), `Formula "${k}"`); }
  const walk = (f: unknown, where: string) => { if (f == null) return; if (typeof f === 'string') { if (f.trim()) chk(f, where); return; } if (typeof f === 'object') { for (const k of ['and', 'or', 'not']) { const a = (f as any)[k]; if (a !== undefined) { if (!Array.isArray(a)) throw new VaultError(`${where}: "${k}" must be a list.`); a.forEach((x) => walk(x, where)); } } return; } throw new VaultError(`${where}: invalid filter.`); };
  walk(c.filters, 'Filter'); c.views.forEach((v, i) => { walk(v.filters, `View ${i + 1} filter`); if (v.limit != null && !(Number(v.limit) >= 0)) throw new VaultError('Limit must be a number.'); });
}

// ───────────── rows ─────────────
interface Row { id: string; kind: 'note' | 'book' | 'highlight'; props: Record<string, unknown>; file: Record<string, unknown>; formulaCache: Map<string, unknown>; editable: boolean }
const toVal = (v: string, type: string): unknown => { let x: unknown; try { x = JSON.parse(v); } catch { x = v; } if ((type === 'date' || type === 'datetime') && typeof x === 'string') return toDate(x) ?? x; return x; };

function noteRows(v: Vault): Row[] {
  const files = all<{ path: string; name: string; ext: string; size: number; mtime: number }>("SELECT path, name, ext, size, mtime FROM vfiles WHERE vault_id = ? AND ext = 'md'", v.id);
  const props = new Map<string, Record<string, unknown>>(); for (const r of all<{ path: string; key: string; value: string; type: string }>('SELECT path, key, value, type FROM vprops WHERE vault_id = ?', v.id)) (props.get(r.path) ?? props.set(r.path, {}).get(r.path)!)[r.key] = toVal(r.value, r.type);
  const tags = new Map<string, string[]>(); for (const r of all<{ path: string; tag: string }>('SELECT path, tag FROM vtags WHERE vault_id = ?', v.id)) (tags.get(r.path) ?? tags.set(r.path, []).get(r.path)!).push(r.tag);
  const links = new Map<string, string[]>(), back = new Map<string, number>();
  for (const r of all<{ src: string; raw: string; target: string | null }>('SELECT src, raw, target FROM vlinks WHERE vault_id = ?', v.id)) { (links.get(r.src) ?? links.set(r.src, []).get(r.src)!).push(r.target ?? r.raw); if (r.target && r.target !== r.src) back.set(r.target, (back.get(r.target) ?? 0) + 1); }
  return files.map((f) => ({ id: f.path, kind: 'note' as const, editable: true, props: props.get(f.path) ?? {}, formulaCache: new Map(),
    file: { __file: true, name: f.name, path: f.path, folder: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '', ext: 'md', size: f.size, mtime: new Date(f.mtime), tags: tags.get(f.path) ?? [], links: links.get(f.path) ?? [], backlinks: back.get(f.path) ?? 0 } }));
}
function bookRows(): Row[] {
  const hc = new Map(all<{ book_id: string; n: number; a: number }>('SELECT book_id, COUNT(*) n, SUM(CASE WHEN note IS NOT NULL AND note != \'\' THEN 1 ELSE 0 END) a FROM highlights GROUP BY book_id').map((r) => [r.book_id, r]));
  const cols = new Map<string, string[]>(); for (const r of all<{ book_id: string; name: string }>('SELECT bc.book_id, c.name FROM book_collections bc JOIN collections c ON c.id = bc.collection_id')) (cols.get(r.book_id) ?? cols.set(r.book_id, []).get(r.book_id)!).push(r.name);
  return all<any>('SELECT b.*, p.percent, p.updated_at AS read_at FROM books b LEFT JOIN reading_progress p ON p.book_id = b.id WHERE b.user_id = ?', me()).map((b) => {
    const pct = Math.round((b.percent ?? 0) * (b.percent <= 1 ? 100 : 1)); const tags = String(b.tags ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    return { id: `book:${b.id}`, kind: 'book' as const, editable: false, formulaCache: new Map(),
      props: { title: b.title, author: b.author ?? null, language: b.language ?? null, format: b.format, page_count: b.page_count, reading_progress: pct, reading_status: pct >= 98 ? 'finished' : pct > 0 ? 'reading' : 'to-read', added: new Date(b.created_at), last_opened: b.last_opened_at ? new Date(b.last_opened_at) : null, highlight_count: hc.get(b.id)?.n ?? 0, annotation_count: hc.get(b.id)?.a ?? 0, tags, collections: cols.get(b.id) ?? [] },
      file: { __file: true, name: b.title, path: `book:${b.id}`, folder: '', ext: b.format, size: 0, mtime: new Date(b.last_opened_at ?? b.created_at), tags, links: [], backlinks: 0 } };
  });
}
function highlightRows(): Row[] {
  return all<any>('SELECT h.*, b.title AS book_title, b.author AS author FROM highlights h JOIN books b ON b.id = h.book_id WHERE b.user_id = ?', me()).map((h) => ({
    id: `highlight:${h.id}`, kind: 'highlight' as const, editable: false, formulaCache: new Map(),
    props: { text: h.text, color: h.color, book: h.book_title, author: h.author ?? null, page: h.page, annotation: h.note ?? null, has_annotation: !!h.note, created: new Date(h.created_at), book_id: h.book_id },
    file: { __file: true, name: String(h.text).slice(0, 70), path: `highlight:${h.id}`, folder: h.book_title, ext: '', size: 0, mtime: new Date(h.created_at), tags: [], links: [], backlinks: 0 } }));
}

// ───────────── evaluation ─────────────
const astCache = new Map<string, Node>();
const astOf = (s: string) => { let a = astCache.get(s); if (!a) { a = parse(s); if (astCache.size > 500) astCache.clear(); astCache.set(s, a); } return a; };
function envFor(row: Row, formulas: Record<string, string>, errors: Map<string, string>): Env {
  const evalFormula = (name: string, stack: string[]): unknown => {
    if (row.formulaCache.has(name)) return row.formulaCache.get(name);
    if (stack.includes(name)) { errors.set(`formula.${name}`, 'Circular formula'); return null; }
    let val: unknown = null; try { val = evaluate(astOf(formulas[name]), mk([...stack, name])); } catch (e: any) { errors.set(`formula.${name}`, e.message); }
    row.formulaCache.set(name, val); return val;
  };
  const prop = (k: string) => { if (k in row.props) return row.props[k]; const f = Object.keys(row.props).find((x) => x.toLowerCase() === k.toLowerCase()); return f ? row.props[f] : null; };
  const mk = (stack: string[]): Env => ({
    resolve: (name) => name === 'file' ? row.file : name === 'note' ? row.props : name === 'formula' ? new Proxy({}, { get: (_t, k) => (typeof k === 'string' && k in formulas ? evalFormula(k, stack) : null), has: (_t, k) => typeof k === 'string' && k in formulas, ownKeys: () => Object.keys(formulas), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }) : prop(name),
    fileMethods: {
      hasTag: (...t) => { const tags = row.file.tags as string[]; return t.some((x) => { const s = String(x).replace(/^#/, '').toLowerCase(); return tags.some((y) => y.toLowerCase() === s || y.toLowerCase().startsWith(s + '/')); }); },
      hasLink: (x) => (row.file.links as string[]).some((l) => l.toLowerCase() === String(x).toLowerCase() || l.toLowerCase().replace(/\.md$/, '').endsWith('/' + String(x).toLowerCase().replace(/\.md$/, '')) || l.toLowerCase().replace(/\.md$/, '') === String(x).toLowerCase().replace(/\.md$/, '')),
      inFolder: (f) => { const folder = String(row.file.folder).toLowerCase(), q = String(f).replace(/^\/|\/$/g, '').toLowerCase(); return folder === q || folder.startsWith(q + '/'); },
      hasProperty: (k) => prop(String(k)) != null,
    },
  });
  return mk([]);
}
/** Resolve a property id used by columns/sort/group: file.x, formula.x, note.x or a bare frontmatter key. */
function evalProp(row: Row, id: string, formulas: Record<string, string>, errors: Map<string, string>): unknown {
  if (id.startsWith('formula.')) { const n = id.slice(8); return n in formulas ? (envFor(row, formulas, errors).resolve('formula') as any)[n] : null; }
  if (id.startsWith('file.')) { const v = row.file[id.slice(5)]; return v ?? null; }
  const k = id.startsWith('note.') ? id.slice(5) : id; if (k in row.props) return row.props[k]; const f = Object.keys(row.props).find((x) => x.toLowerCase() === k.toLowerCase()); return f ? row.props[f] : null;
}
const flatFilters = (f: unknown): { kind: 'and' | 'or' | 'not'; items: (string | any)[] } | string | null => (f == null || f === '' ? null : typeof f === 'string' ? f : (() => { const o = f as any; if (o.and) return { kind: 'and' as const, items: o.and }; if (o.or) return { kind: 'or' as const, items: o.or }; if (o.not) return { kind: 'not' as const, items: o.not }; return null; })());
function passes(f: unknown, row: Row, formulas: Record<string, string>, errors: Map<string, string>): boolean {
  const x = flatFilters(f); if (x == null) return true;
  if (typeof x === 'string') { try { return truthy(evaluate(astOf(x), envFor(row, formulas, errors))); } catch (e: any) { errors.set(`filter: ${x}`, e.message); return false; } }
  const rs = x.items.map((i) => passes(i, row, formulas, errors));
  return x.kind === 'and' ? rs.every(Boolean) : x.kind === 'or' ? rs.some(Boolean) : !rs.some(Boolean);
}

// ───────────── output ─────────────
export const toCell = (v: unknown): unknown => v == null ? null : isDate(v) ? (v.getHours() || v.getMinutes() ? fmtDate(v, 'YYYY-MM-DD HH:mm') : fmtDate(v)) : Array.isArray(v) ? v.map(toCell) : typeof v === 'object' ? (v as any).__file ? (v as any).name : JSON.stringify(v) : v;
const SUMS = ['count', 'filled', 'empty', 'unique', 'sum', 'average', 'min', 'max', 'median'];
function summarise(fn: string, vals: unknown[]): unknown {
  const nonNull = vals.filter((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
  const nums = nonNull.filter((v): v is number => typeof v === 'number');
  switch (fn) {
    case 'count': return vals.length; case 'filled': return nonNull.length; case 'empty': return vals.length - nonNull.length; case 'unique': return new Set(nonNull.map((v) => JSON.stringify(toCell(v)))).size;
    case 'sum': return nums.reduce((a, b) => a + b, 0); case 'average': return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000 : null;
    case 'min': case 'max': { if (!nonNull.length) return null; const s = [...nonNull].sort(compareValues); return toCell(fn === 'min' ? s[0] : s[s.length - 1]); }
    case 'median': { if (!nums.length) return null; const s = [...nums].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  }
  return null;
}
export interface BaseResult { source: Source; view: ViewCfg & { index: number }; columns: { id: string; label: string }[]; rows: { id: string; kind: string; editable: boolean; cells: Record<string, unknown>; ref?: { bookId: string; page?: number } }[]; groups: { key: string | null; label: string; rows: number[]; summaries?: Record<string, unknown> }[] | null; summaries: Record<string, unknown>; total: number; shown: number; errors: { where: string; message: string }[]; views: { name: string; type: string }[] }

export function runBase(v: Vault, cfg: BaseCfg, viewIndex = 0): BaseResult {
  validate(cfg); const source: Source = cfg.source ?? 'notes'; const view = cfg.views[Math.min(Math.max(0, viewIndex), cfg.views.length - 1)];
  const formulas = Object.fromEntries(Object.entries(cfg.formulas ?? {}).map(([k, e]) => [k, String(e)])); const errors = new Map<string, string>();
  let rows = source === 'books' ? bookRows() : source === 'highlights' ? highlightRows() : noteRows(v);
  rows = rows.filter((r) => passes(cfg.filters, r, formulas, errors) && passes(view.filters, r, formulas, errors));
  const total = rows.length;
  // columns
  let order = (view.order ?? []).filter((c) => typeof c === 'string');
  if (!order.length) { const freq = new Map<string, number>(); for (const r of rows) for (const k of Object.keys(r.props)) freq.set(k, (freq.get(k) ?? 0) + 1); order = [source === 'notes' ? 'file.name' : source === 'books' ? 'title' : 'text', ...[...freq].sort((a, b) => b[1] - a[1]).map(([k]) => k).filter((k) => !['title', 'text', 'book_id'].includes(k)).slice(0, 5)]; }
  const label = (id: string) => cfg.properties?.[id]?.displayName ?? cfg.properties?.[id.replace(/^note\./, '')]?.displayName ?? (id.startsWith('file.') ? id.slice(5) : id.startsWith('formula.') ? id.slice(8) : id.replace(/^note\./, ''));
  // sort
  const cache = new Map<string, Map<string, unknown>>(); const val = (r: Row, id: string) => { let m = cache.get(id); if (!m) cache.set(id, (m = new Map())); if (!m.has(r.id)) m.set(r.id, evalProp(r, id, formulas, errors)); return m.get(r.id); };
  const sorts = [...(view.groupBy ? [{ property: view.groupBy.property, direction: view.groupBy.direction }] : []), ...(view.sort ?? [])].filter((s) => s && typeof s.property === 'string');
  if (sorts.length) rows.sort((a, b) => { for (const s of sorts) { const x = val(a, s.property), y = val(b, s.property); const c = x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : (s.direction === 'DESC' ? -1 : 1) * compareValues(x, y); if (c) return c; } return a.id.localeCompare(b.id); });
  const limit = view.limit && view.limit > 0 ? Math.min(view.limit, 10000) : 5000; const shownRows = rows.slice(0, limit);
  const cellsOf = (r: Row) => Object.fromEntries(order.map((c) => [c, toCell(val(r, c))]));
  const out = shownRows.map((r) => ({ id: r.id, kind: r.kind, editable: r.editable, cells: cellsOf(r), ref: r.kind === 'highlight' ? { bookId: String(r.props.book_id), page: Number(r.props.page) } : r.kind === 'book' ? { bookId: r.id.slice(5) } : undefined }));
  // groups
  let groups: BaseResult['groups'] = null;
  if (view.groupBy?.property) {
    const m = new Map<string, number[]>(); const order2: string[] = [];
    shownRows.forEach((r, i) => { const g = val(r, view.groupBy!.property); const keys = Array.isArray(g) && g.length ? g.map((x) => String(toCell(x))) : [g == null || g === '' ? '\u0000none' : String(toCell(g))]; for (const k of keys) { if (!m.has(k)) { m.set(k, []); order2.push(k); } m.get(k)!.push(i); } });
    groups = order2.map((k) => ({ key: k === '\u0000none' ? null : k, label: k === '\u0000none' ? '(none)' : k, rows: m.get(k)! }));
  }
  const sumFor = (idx: number[] | null) => Object.fromEntries(Object.entries(view.summaries ?? {}).filter(([c, fn]) => SUMS.includes(String(fn).toLowerCase()) && order.includes(c)).map(([c, fn]) => [c, summarise(String(fn).toLowerCase(), (idx ?? shownRows.map((_, i) => i)).map((i) => val(shownRows[i], c)))]));
  if (groups) for (const g of groups) g.summaries = sumFor(g.rows);
  return { source, view: { ...view, index: cfg.views.indexOf(view), order }, columns: order.map((id) => ({ id, label: label(id) })), rows: out, groups, summaries: sumFor(null), total, shown: out.length,
    errors: [...errors].slice(0, 20).map(([where, message]) => ({ where, message })), views: cfg.views.map((x, i) => ({ name: x.name ?? `${x.type[0].toUpperCase()}${x.type.slice(1)} ${i + 1}`, type: x.type })) };
}

export function loadBase(v: Vault, rel: string) { const f = readFile(v, rel); const { config, error } = parseBase(f.text); return { config, error, raw: f.text, hash: f.hash }; }

// ───────────── export / create helpers ─────────────
const csvCell = (x: unknown): string => { let s = x == null ? '' : Array.isArray(x) ? x.join('; ') : String(x); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; /* spreadsheet formula injection */ return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (r: BaseResult) => [r.columns.map((c) => csvCell(c.label)).join(','), ...r.rows.map((row) => r.columns.map((c) => csvCell(row.cells[c.id])).join(','))].join('\r\n') + '\r\n';
/** What a new record in this view should be pre-filled with, derived from simple equality / tag / folder filters. */
export function prefillFor(cfg: BaseCfg, view: ViewCfg): { props: Record<string, unknown>; tags: string[]; folder: string } {
  const props: Record<string, unknown> = {}; const tags: string[] = []; let folder = '';
  const strs: string[] = []; const walk = (f: unknown) => { const x = flatFilters(f); if (!x) return; if (typeof x === 'string') strs.push(x); else if (x.kind === 'and') x.items.forEach(walk); };
  walk(cfg.filters); walk(view.filters);
  for (const s of strs) { let m: RegExpExecArray | null; if ((m = /^\s*(?:note\.)?([\p{L}_][\p{L}\p{N}_ -]*?)\s*==\s*"([^"]*)"\s*$/u.exec(s))) props[m[1]] = m[2]; else if ((m = /^\s*(?:note\.)?([\p{L}_][\p{L}\p{N}_-]*)\s*==\s*(-?\d+(?:\.\d+)?|true|false)\s*$/u.exec(s))) props[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]); else if ((m = /^\s*file\.hasTag\("#?([^"]+)"\)\s*$/.exec(s))) tags.push(m[1]); else if ((m = /^\s*file\.inFolder\("([^"]+)"\)\s*$/.exec(s))) folder = m[1].replace(/^\/|\/$/g, ''); }
  return { props, tags, folder };
}
export function defaultBase(source: Source = 'notes'): string {
  const c: BaseCfg = source === 'books' ? { source, views: [{ type: 'table', name: 'Library', order: ['title', 'author', 'reading_status', 'reading_progress', 'highlight_count'], sort: [{ property: 'title', direction: 'ASC' }] }, { type: 'kanban', name: 'Reading board', groupBy: { property: 'reading_status' }, order: ['title', 'author'] }] }
    : source === 'highlights' ? { source, views: [{ type: 'table', name: 'Highlights', order: ['text', 'book', 'page', 'annotation'], sort: [{ property: 'created', direction: 'DESC' }] }] }
    : { views: [{ type: 'table', name: 'All notes', order: ['file.name', 'file.folder', 'file.mtime'], sort: [{ property: 'file.mtime', direction: 'DESC' }] }] };
  return String(new YAML.Document(c));
}
void getFileSet;
export { ExprError };
