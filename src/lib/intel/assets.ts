// Unified asset store for every generated experience. Versioned; cached by spec; always linked to source pages.
import { all, get, run, uid, LOCAL_USER } from '../db';

export const KINDS = ['visual', 'podcast', 'video', 'course', 'study-guide', 'conversation'] as const;
export type AssetKind = (typeof KINDS)[number];

/** Which "Experience" section each kind lives in. */
export const SECTION: Record<string, string> = { visual: 'EXPLORE', podcast: 'LISTEN', video: 'WATCH', course: 'PRACTICE', 'study-guide': 'UNDERSTAND', conversation: 'DISCUSS' };

export interface Source { page: number; quote?: string; book_id?: string }

export function createAsset(a: { bookId: string | null; kind: string; title: string; spec?: unknown; meta?: Record<string, unknown>; groupId?: string; version?: number; status?: string }) {
  const id = uid();
  run(`INSERT INTO assets (id, user_id, book_id, kind, title, status, spec, meta, version, group_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, LOCAL_USER, a.bookId, a.kind, a.title, a.status ?? 'completed', JSON.stringify(a.spec ?? {}), JSON.stringify({ pages: [], sources: [], ...(a.meta ?? {}) }), a.version ?? 1, a.groupId ?? id, Date.now(), Date.now());
  return id;
}

export const parseAsset = (r: any) => r && ({ ...r, spec: JSON.parse(r.spec || '{}'), meta: JSON.parse(r.meta || '{}'), files: JSON.parse(r.files || '{}') });

export function getAsset(id: string) {
  return parseAsset(get<any>('SELECT * FROM assets WHERE id = ? AND user_id = ?', id, LOCAL_USER));
}

export function updateAsset(id: string, patch: { title?: string; status?: string; progress?: number; detail?: string | null; spec?: unknown; meta?: Record<string, unknown>; files?: Record<string, unknown>; error?: string | null }) {
  const cur = getAsset(id); if (!cur) return;
  run(`UPDATE assets SET title = ?, status = ?, progress = ?, detail = ?, spec = ?, meta = ?, files = ?, error = ?, updated_at = ? WHERE id = ?`,
    patch.title ?? cur.title, patch.status ?? cur.status, patch.progress ?? cur.progress, patch.detail === undefined ? cur.detail : patch.detail,
    JSON.stringify(patch.spec ?? cur.spec), JSON.stringify({ ...cur.meta, ...(patch.meta ?? {}) }), JSON.stringify({ ...cur.files, ...(patch.files ?? {}) }),
    patch.error === undefined ? cur.error : patch.error, Date.now(), id);
}

/** Latest version of each asset group for a book (or all books). */
export function listAssets(bookId?: string | null) {
  const rows = all<any>(`SELECT * FROM assets WHERE user_id = ? ${bookId ? 'AND book_id = ?' : ''} ORDER BY updated_at DESC`, LOCAL_USER, ...(bookId ? [bookId] : []));
  const latest = new Map<string, any>();
  for (const r of rows) { const cur = latest.get(r.group_id); if (!cur || r.version > cur.version) latest.set(r.group_id, r); }
  return [...latest.values()].map((r) => { const a = parseAsset(r); return { ...a, spec: a.kind === 'visual' ? { kind: a.spec.kind, title: a.spec.title } : undefined, section: SECTION[a.kind] ?? 'CREATE', versions: rows.filter((x: any) => x.group_id === r.group_id).length }; }).sort((a, b) => b.updated_at - a.updated_at);
}

export const versionsOf = (groupId: string) => all<any>('SELECT id, version, title, status, created_at FROM assets WHERE group_id = ? AND user_id = ? ORDER BY version DESC', groupId, LOCAL_USER);

/** New version of an existing asset (regeneration keeps history). */
export function newVersion(id: string, spec: unknown, meta?: Record<string, unknown>) {
  const cur = getAsset(id); if (!cur) throw new Error('asset not found');
  const top = get<{ v: number }>('SELECT MAX(version) v FROM assets WHERE group_id = ?', cur.group_id)?.v ?? 1;
  return createAsset({ bookId: cur.book_id, kind: cur.kind, title: cur.title, spec, meta: { ...cur.meta, ...(meta ?? {}) }, groupId: cur.group_id, version: top + 1 });
}

/** Coverage by experience: which pages are included in which kinds of generated assets (only completed ones count). */
export function coverageByKind(bookId: string) {
  const out: Record<string, Set<number>> = { visual: new Set(), podcast: new Set(), video: new Set(), course: new Set(), audio: new Set(), exercise: new Set() };
  for (const r of all<any>(`SELECT kind, meta, files, status FROM assets WHERE book_id = ? AND user_id = ? AND status = 'completed'`, bookId, LOCAL_USER)) {
    const m = JSON.parse(r.meta || '{}'); const pages: number[] = m.pages ?? [];
    const f = JSON.parse(r.files || '{}');
    if (out[r.kind]) pages.forEach((p) => out[r.kind].add(p));
    if ((r.kind === 'podcast' || r.kind === 'video') && (f.audio || f.mp4)) pages.forEach((p) => out.audio.add(p));
    if (r.kind === 'course') pages.forEach((p) => out.exercise.add(p));
    if (r.kind === 'visual' && m.hasPractice) pages.forEach((p) => out.exercise.add(p));
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
}
