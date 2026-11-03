// Cross-book retrieval: hybrid (BM25 + local embeddings, RRF) over every book in the library, plus the user's own notes.
import { all, me } from './db';
import { embed } from './ollama';

export interface LibHit {
  id: number; book_id: string; book_title: string; author: string | null; chapter_title: string | null;
  page_start: number; page_end: number; text: string; score: number; via: string[];
}

const STOP = new Set('a an the of to in on for and or is are was were be been it this that with as at by from what how why who when which do does did can could should would about into than then so if not no me my i have has had all any across between books book learned learn'.split(' '));
export const ftsMatch = (q: string) => {
  const t = [...new Set((q.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter((x) => !STOP.has(x)))];
  return t.length ? t.map((x) => `"${x}"`).join(' OR ') : null;
};

// Keyed by TENANT + chunk id: chunk ids are small integers that repeat in every tenant database, so an unscoped key would mix users' embeddings.
const vecCache = new Map<string, Float32Array>();
function vecOf(id: number, blob: Uint8Array) {
  const key = `${me()}:${id}`; let v = vecCache.get(key);
  if (!v) { v = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)); if (vecCache.size > 150_000) vecCache.clear(); vecCache.set(key, v); }
  return v;
}
function cosine(a: Float32Array, b: Float32Array) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

export async function retrieveLibrary(query: string, opts: { bookIds?: string[]; k?: number } = {}): Promise<{ hits: LibHit[]; semantic: boolean; booksSearched: number }> {
  const k = opts.k ?? 10;
  const ids = opts.bookIds?.length ? opts.bookIds : null;
  const inList = ids ? ` AND c.book_id IN (${ids.map(() => '?').join(',')})` : '';
  const m = ftsMatch(query);
  const kw = m ? all<{ id: number }>(`SELECT c.id AS id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid JOIN books b ON b.id = c.book_id WHERE chunks_fts MATCH ? AND b.user_id = ?${inList} ORDER BY bm25(chunks_fts) LIMIT 60`, m, me(), ...(ids ?? [])) : [];
  let sem: { id: number }[] = [];
  const rows = all<{ id: number; embedding: Uint8Array; embed_model: string }>(`SELECT c.id, c.embedding, c.embed_model FROM chunks c JOIN books b ON b.id = c.book_id WHERE c.embedding IS NOT NULL AND b.user_id = ?${inList}`, me(), ...(ids ?? []));
  if (rows.length) {
    const qe = await embed([query]);
    if (qe) {
      const qv = new Float32Array(qe.vectors[0]);
      sem = rows.filter((r) => r.embed_model === qe.model).map((r) => ({ id: r.id, s: cosine(qv, vecOf(r.id, r.embedding)) })).sort((a, b) => b.s - a.s).slice(0, 60);
    }
  }
  const score = new Map<number, { s: number; via: Set<string> }>();
  const add = (list: { id: number }[], via: string) => list.forEach((x, rank) => { const e = score.get(x.id) ?? { s: 0, via: new Set<string>() }; e.s += 1 / (60 + rank); e.via.add(via); score.set(x.id, e); });
  add(kw, 'keyword'); add(sem, 'semantic');
  const idsAll = [...score.keys()];
  const booksSearched = ids ? ids.length : (all<{ n: number }>('SELECT COUNT(*) n FROM books WHERE user_id = ? AND status IN (\'readable\',\'ready\')', me())[0]?.n ?? 0);
  if (!idsAll.length) return { hits: [], semantic: sem.length > 0, booksSearched };
  const found = all<any>(`SELECT c.id, c.book_id, c.page_start, c.page_end, c.text, b.title AS book_title, b.author, ch.title AS chapter_title
      FROM chunks c JOIN books b ON b.id = c.book_id LEFT JOIN chapters ch ON ch.book_id = c.book_id AND ch.idx = c.chapter_idx
      WHERE c.id IN (${idsAll.map(() => '?').join(',')})`, ...idsAll);
  const ranked: LibHit[] = found.map((r) => ({ ...r, score: score.get(r.id)!.s, via: [...score.get(r.id)!.via] })).sort((a, b) => b.score - a.score);
  // diversity: at most ceil(k/2) per book when searching several books, so comparisons see every author
  const cap = ids && ids.length === 1 ? k : Math.max(2, Math.ceil(k / 2));
  const per = new Map<string, number>(); const hits: LibHit[] = [];
  for (const h of ranked) { const n = per.get(h.book_id) ?? 0; if (n >= cap) continue; per.set(h.book_id, n + 1); hits.push(h); if (hits.length >= k) break; }
  return { hits, semantic: sem.length > 0, booksSearched };
}

export function relatedNotes(query: string, limit = 6) {
  const m = ftsMatch(query); if (!m) return [];
  try {
    return all<any>(`SELECT n.id, n.body, n.page, n.book_id, n.kind, b.title AS book_title FROM notes_fts f JOIN notes n ON n.rowid = f.rowid LEFT JOIN books b ON b.id = n.book_id WHERE notes_fts MATCH ? AND n.user_id = ? ORDER BY rank LIMIT ?`, m, me(), limit);
  } catch { return []; }
}

export function relatedVocab(query: string, limit = 6) {
  const terms = [...new Set((query.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((x) => !STOP.has(x)))].slice(0, 8);
  if (!terms.length) return [];
  return all<any>(`SELECT word, definition, book_id, page FROM vocabulary WHERE user_id = ? AND (${terms.map(() => 'lower(word) = ? OR lower(definition) LIKE ?').join(' OR ')}) LIMIT ?`, me(), ...terms.flatMap((t) => [t, `%${t}%`]), limit);
}
