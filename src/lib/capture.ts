// Automatic capture of reading selections into the Notes / Knowledge Inbox.
import { get, run, uid, me } from './db';
import { chapterOf } from './rag';

export const normKey = (text: string, start?: number | null) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 400) + (start != null && start >= 0 ? '' : '');

/** Nearest preceding short, unpunctuated line that looks like a heading (this page, else the chapter title). */
export function sectionFor(pageText: string, offset: number, fallback: string | null): string | null {
  const before = pageText.slice(0, Math.max(0, offset)).split('\n');
  for (let i = before.length - 2; i >= 0; i--) {
    const l = before[i].trim();
    if (l.length >= 3 && l.length <= 90 && !/[.,;:!?]$/.test(l) && (/^[A-Z0-9]/.test(l)) && l.split(/\s+/).length <= 12) return l;
  }
  return fallback;
}

/** The paragraph(s) around the selection, bounded in size. */
export function contextAround(pageText: string, start: number, end: number): string {
  const s = Math.max(0, start), e = Math.min(pageText.length, Math.max(end, s));
  let a = pageText.lastIndexOf('\n', s - 1); a = a < 0 ? 0 : a + 1;
  let b = pageText.indexOf('\n', e); if (b < 0) b = pageText.length;
  let ctx = pageText.slice(a, b);
  if (ctx.length < 200) { // very short paragraph: widen to neighbours
    a = Math.max(0, s - 300); b = Math.min(pageText.length, e + 300);
    ctx = pageText.slice(a, b);
  }
  return ctx.length > 1500 ? ctx.slice(Math.max(0, s - a - 600), s - a + (e - s) + 600) : ctx;
}

export interface CaptureInput { bookId: string; page: number; text: string; start?: number | null; end?: number | null; kind?: string }

/** Create (or return the existing) note for an exact passage at an exact place. The note body is the selected text only. */
export function captureSelection(inp: CaptureInput): { id: string; created: boolean } {
  const text = inp.text.replace(/\s+/g, ' ').trim().slice(0, 6000);
  if (!text) throw new Error('empty selection');
  const key = normKey(text);
  const existing = get<{ id: string }>('SELECT id FROM notes WHERE user_id = ? AND book_id = ? AND page = ? AND norm_key = ?', me(), inp.bookId, inp.page, key);
  if (existing) return { id: existing.id, created: false };
  const pg = get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', inp.bookId, inp.page);
  const pageText = pg?.text ?? '';
  let start = inp.start ?? -1, end = inp.end ?? -1;
  if (start < 0 || pageText.slice(start, end).replace(/\s+/g, ' ').trim() !== text) { // verify offsets against the real page text
    const i = pageText.replace(/\s+/g, ' ').indexOf(text);
    const raw = pageText.indexOf(text);
    start = raw >= 0 ? raw : i; end = start >= 0 ? start + text.length : -1;
  }
  const ch = chapterOf(inp.bookId, inp.page);
  const id = uid();
  const now = Date.now();
  run(`INSERT INTO notes (id, user_id, book_id, page, title, body, tags, source, created_at, kind, chapter_idx, chapter_title, section, start_offset, end_offset, context, quote, norm_key, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, me(), inp.bookId, inp.page, null, text, '', 'capture', now, inp.kind ?? 'selection', ch?.idx ?? null, ch?.title ?? null,
    start >= 0 ? sectionFor(pageText, start, ch?.title ?? null) : ch?.title ?? null, start >= 0 ? start : null, end >= 0 ? end : null,
    start >= 0 ? contextAround(pageText, start, end) : null, text, key, now);
  return { id, created: true };
}
