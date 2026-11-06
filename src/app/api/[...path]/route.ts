import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { all, get, run, tx, uid, db, ownBook, filesDir, coversDir, audioDir, assetDir, journalDir, vaultsDir, tmpDir, me } from '@/lib/db';
import { indexBook, saveUpload, checkUpload, enqueue, resumeQueue, deleteBook, embedBook, capabilities } from '@/lib/ingest';
import * as ollama from '@/lib/ollama';
import { lookup } from '@/lib/dictionary';
import { retrieve, pageText, chapterOf, PERSONAS, SAFETY } from '@/lib/rag';
import { summarize, extractForGoal, saveExtract, generateCards, generateQuiz, explainWord, translate, saveConversationMessage } from '@/lib/ai';
import { schedule } from '@/lib/srs';
import { registerExtra, NOTE_KINDS } from '@/lib/routes2';
import { registerAnalytics } from '@/lib/routes3';
import { registerLibrary } from '@/lib/routes4';
import { registerLang } from '@/lib/routes6';
import { registerRecall } from '@/lib/routes7';
import { registerVault } from '@/lib/routes8';
import { registerJournal } from '@/lib/routes9';
import { registerMemory } from '@/lib/routes10';
import { queryVariants, languageInstruction } from '@/lib/lang/translate';
import { recoverTasks } from '@/lib/intel/tasks';
import { handleAuth, authenticate, originOk, csrfOk, SAFE } from '@/lib/auth/routes';
import { hostAllowed, cfg } from '@/lib/auth/config';
import { runAs, listTenantIds, isAdminCtx, FOLIO_ENV } from '@/lib/tenant';
import { apiBucket, checkQuota, usedBytes } from '@/lib/limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Ctx = { req: NextRequest; p: Record<string, string>; q: URLSearchParams };
type Handler = (c: Ctx) => Promise<Response | unknown> | Response | unknown;
const routes: { m: string; re: RegExp; keys: string[]; h: Handler }[] = [];
function on(m: string, pattern: string, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ m, re, keys, h });
}
const J = (d: unknown, status = 200) => Response.json(d, { status });
const bad = (msg: string, status = 400) => J({ error: msg }, status);
const body = async <T = any>(req: NextRequest): Promise<T> => { try { return await req.json(); } catch { return {} as T; } };
const book = (id: string) => ownBook(id);
const now = () => Date.now();

let booted = false;
/** After a (re)start, resume half-finished work for every tenant — each inside that tenant's own context. */
function boot() { if (booted) return; booted = true; setTimeout(() => { for (const uid of listTenantIds()) { try { runAs(uid, () => { resumeQueue(); recoverTasks(); }); } catch (e) { console.error('boot recovery failed for a tenant', (e as Error).message); } } }, 0); }

// ───────────────────────── system ─────────────────────────
on('GET', '/status', async () => {
  const [st, caps] = [await ollama.status(), await capabilities()];
  const models: Record<string, string | null> = {};
  for (const t of ollama.TASKS) models[t] = await ollama.modelFor(t);
  return { ollama: st, resolved: models, prefs: ollama.allPrefs(), recommended: ollama.RECOMMENDED, caps, piper: !!process.env.PIPER_URL, ocrRemote: !!process.env.UNLIMITED_OCR_URL };
});
on('PUT', '/prefs', async ({ req }) => { const b = await body(req); if (typeof b.key !== 'string' || typeof b.value !== 'string') return bad('key/value required'); ollama.setPref(b.key, b.value); return { ok: true }; });
on('POST', '/ollama/pull', async ({ req }) => {
  if (!isAdminCtx()) return bad('Only an administrator can download models onto the server.', 403);
  const { model } = await body(req);
  if (!/^[\w.\-:/]+$/.test(model ?? '')) return bad('invalid model name');
  const r = await fetch(`${ollama.OLLAMA_URL}/api/pull`, { method: 'POST', body: JSON.stringify({ model, stream: true }) }).catch(() => null);
  if (!r?.ok || !r.body) return bad('Ollama is not reachable', 502);
  return new Response(r.body, { headers: { 'content-type': 'application/x-ndjson' } });
});

// ───────────────────────── library ─────────────────────────
on('GET', '/books', ({ q }) => {
  const s = (q.get('q') ?? '').trim();
  const rows = all<any>(
    `SELECT b.id, b.title, b.author, b.format, b.tags, b.page_count, b.status, b.status_detail, b.created_at, b.last_opened_at, b.cover_path IS NOT NULL AS has_cover,
            COALESCE(p.page,1) AS page, COALESCE(p.percent,0) AS percent,
            (SELECT GROUP_CONCAT(collection_id) FROM book_collections bc WHERE bc.book_id = b.id) AS collections
       FROM books b LEFT JOIN reading_progress p ON p.book_id = b.id
      WHERE b.user_id = ? ${s ? 'AND (b.title LIKE ? OR b.author LIKE ? OR b.tags LIKE ?)' : ''}
      ORDER BY COALESCE(b.last_opened_at, b.created_at) DESC`, me(), ...(s ? [`%${s}%`, `%${s}%`, `%${s}%`] : []));
  return rows.map((r) => ({ ...r, collections: r.collections ? r.collections.split(',') : [] }));
});
on('POST', '/books', async ({ req }) => {
  const fd = await req.formData();
  const out: { name: string; id?: string; error?: string }[] = [];
  for (const f of fd.getAll('files')) {
    if (!(f instanceof File)) continue;
    const err = checkUpload(f.name, f.size);
    if (err) { out.push({ name: f.name, error: err }); continue; }
    try { checkQuota(f.size); } catch (e: any) { out.push({ name: f.name, error: e.message }); continue; }
    out.push({ name: f.name, id: await saveUpload(f.name, Buffer.from(await f.arrayBuffer())) });
  }
  return J({ results: out }, out.some((o) => o.id) ? 201 : 400);
});
on('GET', '/books/:id', ({ p }) => {
  const b = book(p.id); if (!b) return bad('Not found', 404);
  const doc = get<any>('SELECT original_name, size, sha256 FROM documents WHERE book_id = ?', p.id);
  run('UPDATE books SET last_opened_at = ? WHERE id = ?', now(), p.id);
  return { ...b, doc, chapters: all('SELECT idx, title, start_page FROM chapters WHERE book_id = ? ORDER BY idx', p.id), progress: get('SELECT * FROM reading_progress WHERE book_id = ?', p.id) ?? null };
});
on('PATCH', '/books/:id', async ({ req, p }) => {
  if (!book(p.id)) return bad('Not found', 404);
  const b = await body(req);
  for (const k of ['title', 'author', 'tags'] as const) if (typeof b[k] === 'string') run(`UPDATE books SET ${k} = ? WHERE id = ?`, b[k].slice(0, 300), p.id);
  if (Array.isArray(b.collections)) tx(() => { run('DELETE FROM book_collections WHERE book_id = ?', p.id); for (const c of b.collections) run('INSERT OR IGNORE INTO book_collections VALUES (?,?)', p.id, c); });
  return { ok: true };
});
on('DELETE', '/books/:id', async ({ p }) => { if (!book(p.id)) return bad('Not found', 404); await deleteBook(p.id); return { ok: true }; });
on('POST', '/books/:id/reprocess', ({ p }) => { if (!book(p.id)) return bad('Not found', 404); run("UPDATE books SET status='queued' WHERE id = ?", p.id); enqueue(p.id); return { ok: true }; });
on('POST', '/books/:id/embed', async ({ p }) => { if (!book(p.id)) return bad('Not found', 404); return { embedded: await embedBook(p.id) }; });
on('GET', '/books/:id/file', async ({ p }) => {
  const b = book(p.id); const d = get<any>('SELECT * FROM documents WHERE book_id = ?', p.id);
  if (!b || !d) return bad('Not found', 404);
  const buf = await fs.readFile(path.join(filesDir(), d.file_path));
  const mime = b.format === 'pdf' ? 'application/pdf' : 'application/octet-stream';
  return new Response(new Uint8Array(buf), { headers: { 'content-type': mime, 'content-length': String(buf.length), 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(d.original_name)}`, 'x-content-type-options': 'nosniff' } });
});
on('PUT', '/books/:id/cover', async ({ req, p }) => {
  if (!book(p.id)) return bad('Not found', 404);
  const buf = Buffer.from(await req.arrayBuffer());
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8, isPng = buf[0] === 0x89 && buf[1] === 0x50;
  if (buf.length < 100 || buf.length > 3_000_000 || !(isJpg || isPng)) return bad('JPEG or PNG under 3 MB required');
  const name = p.id + (isPng ? '.png' : '.jpg');
  await fs.writeFile(path.join(coversDir(), name), buf);
  run('UPDATE books SET cover_path = ? WHERE id = ?', name, p.id);
  return { ok: true };
});
on('GET', '/books/:id/cover', async ({ p }) => {
  const b = book(p.id); if (!b?.cover_path) return bad('No cover', 404);
  const ext = path.extname(b.cover_path).toLowerCase();
  const buf = await fs.readFile(path.join(coversDir(), b.cover_path));
  return new Response(new Uint8Array(buf), { headers: { 'content-type': ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
});
on('GET', '/books/:id/pages', ({ p, q }) => {
  if (!book(p.id)) return bad('Not found', 404);
  const from = Math.max(1, Number(q.get('from') ?? 1)); const to = Math.min(from + 49, Number(q.get('to') ?? from));
  return all('SELECT page, chapter_idx, text, html FROM pages WHERE book_id = ? AND page BETWEEN ? AND ? ORDER BY page', p.id, from, to);
});
on('GET', '/books/:id/scanned', ({ p }) => {
  if (!book(p.id)) return bad('Not found', 404);
  return all<{ page: number }>("SELECT page FROM pages WHERE book_id = ? AND trim(text) = '' AND ocr = 0 ORDER BY page", p.id).map((r) => r.page);
});
on('PUT', '/books/:id/pages/:page/ocr', async ({ req, p }) => {
  if (!book(p.id)) return bad('Not found', 404);
  const { text } = await body(req);
  if (typeof text !== 'string' || text.length > 200000) return bad('text required');
  run('UPDATE pages SET text = ?, ocr = 1 WHERE book_id = ? AND page = ?', text.replace(/[ 	]+/g, ' ').trim(), p.id, Number(p.page));
  return { ok: true };
});
// Optional: forward a page image to a local Unlimited-OCR server (SGLang, OpenAI-compatible API).
on('POST', '/ocr/remote', async ({ req }) => {
  const base = process.env.UNLIMITED_OCR_URL?.replace(/\/$/, '');
  if (!base) return bad('UNLIMITED_OCR_URL is not configured', 501);
  const { image } = await body(req);
  if (typeof image !== 'string' || !image.startsWith('data:image/') || image.length > 40_000_000) return bad('image data URL required');
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10 * 60_000),
    body: JSON.stringify({
      model: process.env.UNLIMITED_OCR_MODEL || 'Unlimited-OCR-2', stream: false, temperature: 0,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: process.env.UNLIMITED_OCR_PROMPT || '<image>\nMulti page parsing.' }] }],
    }),
  }).catch(() => null);
  if (!r?.ok) return bad(`Unlimited-OCR server error${r ? ' ' + r.status + ': ' + (await r.text()).slice(0, 300) : ': unreachable'}`, 502);
  const j = await r.json();
  return { text: String(j.choices?.[0]?.message?.content ?? '').replace(/<\/?PAGE>/g, '').trim() };
});
on('POST', '/books/:id/reindex', ({ p }) => {
  if (!book(p.id)) return bad('Not found', 404);
  run("UPDATE books SET status = 'readable', status_detail = 'Re-indexing after OCR…' WHERE id = ?", p.id);
  void indexBook(p.id).then(() => run("UPDATE books SET status = 'ready', status_detail = 'Some pages were read with OCR; accuracy depends on scan quality.' WHERE id = ?", p.id));
  return { ok: true };
});
on('GET', '/books/:id/search', ({ p, q }) => {
  if (!book(p.id)) return bad('Not found', 404);
  const s = (q.get('q') ?? '').trim(); if (s.length < 2) return [];
  const rows = all<{ page: number; text: string }>("SELECT page, text FROM pages WHERE book_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY page LIMIT 100", p.id, `%${s.replace(/[\\%_]/g, '\\$&')}%`);
  return rows.map((r) => { const i = r.text.toLowerCase().indexOf(s.toLowerCase()); return { page: r.page, snippet: (i > 60 ? '…' : '') + r.text.slice(Math.max(0, i - 60), i + s.length + 80).replace(/\s+/g, ' ') }; });
});
on('GET', '/books/:id/progress', ({ p }) => get('SELECT * FROM reading_progress WHERE book_id = ?', p.id) ?? null);
on('PUT', '/books/:id/progress', async ({ req, p }) => {
  const b = book(p.id); if (!b) return bad('Not found', 404);
  const x = await body(req);
  const page = Math.min(Math.max(1, Number(x.page) || 1), Math.max(1, b.page_count));
  run(`INSERT INTO reading_progress (book_id, page, scroll, percent, audio_page, audio_sentence, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(book_id) DO UPDATE SET page=excluded.page, scroll=excluded.scroll, percent=excluded.percent, audio_page=COALESCE(excluded.audio_page, audio_page), audio_sentence=COALESCE(excluded.audio_sentence, audio_sentence), updated_at=excluded.updated_at`,
    p.id, page, Number(x.scroll) || 0, b.page_count ? page / b.page_count : 0, x.audio_page ?? null, x.audio_sentence ?? null, now());
  return { ok: true };
});

// annotations: bookmarks / highlights / notes
on('GET', '/books/:id/annotations', ({ p }) => {
  if (!book(p.id)) return bad('Not found', 404);
  return {
    bookmarks: all('SELECT * FROM bookmarks WHERE book_id = ? ORDER BY page', p.id),
    highlights: all('SELECT * FROM highlights WHERE book_id = ? ORDER BY page, start_offset', p.id),
    notes: all('SELECT * FROM notes WHERE book_id = ? ORDER BY created_at DESC', p.id),
  };
});
on('POST', '/books/:id/bookmarks', async ({ req, p }) => { if (!book(p.id)) return bad('Not found', 404); const b = await body(req); const id = uid(); run('INSERT INTO bookmarks VALUES (?,?,?,?,?)', id, p.id, Number(b.page) || 1, String(b.label ?? '').slice(0, 200), now()); return { id }; });
on('DELETE', '/bookmarks/:id', ({ p }) => { run('DELETE FROM bookmarks WHERE id = ? AND book_id IN (SELECT id FROM books WHERE user_id = ?)', p.id, me()); return { ok: true }; });
const COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'orange']);
on('POST', '/books/:id/highlights', async ({ req, p }) => {
  if (!book(p.id)) return bad('Not found', 404);
  const b = await body(req); if (!b.text || !b.page) return bad('text and page required');
  const id = uid();
  run('INSERT INTO highlights (id, book_id, page, text, color, start_offset, end_offset, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, p.id, Number(b.page), String(b.text).slice(0, 5000), COLORS.has(b.color) ? b.color : 'yellow', b.start ?? null, b.end ?? null, b.note ?? null, now());
  return { id };
});
on('PATCH', '/highlights/:id', async ({ req, p }) => {
  const b = await body(req);
  if (typeof b.note === 'string') run('UPDATE highlights SET note = ? WHERE id = ?', b.note, p.id);
  if (COLORS.has(b.color)) run('UPDATE highlights SET color = ? WHERE id = ?', b.color, p.id);
  return { ok: true };
});
on('DELETE', '/highlights/:id', ({ p }) => { run('DELETE FROM highlights WHERE id = ? AND book_id IN (SELECT id FROM books WHERE user_id = ?)', p.id, me()); return { ok: true }; });
on('POST', '/notes', async ({ req }) => {
  const b = await body(req); if (!String(b.body ?? '').trim()) return bad('body required');
  if (b.book_id && !book(b.book_id)) return bad('Not found', 404);
  const id = uid();
  run('INSERT INTO notes (id, user_id, book_id, page, title, body, tags, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, me(), b.book_id ?? null, b.page ?? null, b.title ?? null, String(b.body).slice(0, 20000), b.tags ?? '', b.source === 'ai' ? 'ai' : 'user', now());
  if (typeof b.kind === 'string' && (NOTE_KINDS as readonly string[]).includes(b.kind)) run('UPDATE notes SET kind = ?, updated_at = ? WHERE id = ?', b.kind, now(), id);
  return { id };
});
on('GET', '/notes', ({ q }) => {
  const s = (q.get('q') ?? '').trim();
  if (s) { const m = (s.match(/[\w]{2,}/g) ?? []).map((t) => `"${t}"*`).join(' OR '); if (!m) return []; return all("SELECT n.*, b.title AS book_title FROM notes_fts f JOIN notes n ON n.rowid = f.rowid LEFT JOIN books b ON b.id = n.book_id WHERE notes_fts MATCH ? AND n.user_id = ? ORDER BY rank LIMIT 100", m, me()); }
  return all('SELECT n.*, b.title AS book_title FROM notes n LEFT JOIN books b ON b.id = n.book_id WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 500', me());
});
on('DELETE', '/notes/:id', ({ p }) => { run('DELETE FROM notes WHERE id = ? AND user_id = ?', p.id, me()); return { ok: true }; });
on('GET', '/highlights', () => all('SELECT h.*, b.title AS book_title FROM highlights h JOIN books b ON b.id = h.book_id WHERE b.user_id = ? ORDER BY h.created_at DESC LIMIT 500', me()));

on('GET', '/collections', () => all('SELECT * FROM collections WHERE user_id = ? ORDER BY name', me()));
on('POST', '/collections', async ({ req }) => { const b = await body(req); if (!String(b.name ?? '').trim()) return bad('name required'); const id = uid(); run('INSERT INTO collections VALUES (?,?,?,?)', id, me(), String(b.name).slice(0, 100), now()); return { id }; });
on('DELETE', '/collections/:id', ({ p }) => { run('DELETE FROM collections WHERE id = ? AND user_id = ?', p.id, me()); return { ok: true }; });

on('POST', '/sessions', async ({ req }) => {
  const b = await body(req); if (!book(b.bookId)) return bad('Not found', 404);
  run('INSERT INTO reading_sessions VALUES (?,?,?,?,?,?)', uid(), me(), b.bookId, now() - 1000 * (Number(b.seconds) || 0), Math.min(86400, Number(b.seconds) || 0), Number(b.pages) || 0);
  return { ok: true };
});

// ───────────────────────── vocabulary ─────────────────────────
on('GET', '/define', async ({ q }) => lookup(q.get('word') ?? ''));
on('GET', '/vocab', ({ q }) => all(`SELECT v.*, b.title AS book_title FROM vocabulary v LEFT JOIN books b ON b.id = v.book_id WHERE v.user_id = ? ${q.get('due') ? 'AND v.due_at <= ?' : ''} ORDER BY v.created_at DESC`, me(), ...(q.get('due') ? [now()] : [])));
on('POST', '/vocab', async ({ req }) => {
  const b = await body(req); const word = String(b.word ?? '').trim().toLowerCase().slice(0, 80); if (!word) return bad('word required');
  const id = uid();
  run(`INSERT INTO vocabulary (id, user_id, word, definition, ipa, pos, sentence, book_id, page, created_at, due_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, word) DO UPDATE SET sentence = excluded.sentence, book_id = excluded.book_id, page = excluded.page`,
    id, me(), word, b.definition ?? null, b.ipa ?? null, b.pos ?? null, b.sentence ?? null, b.book_id ?? null, b.page ?? null, now(), now());
  return { ok: true };
});
on('DELETE', '/vocab/:id', ({ p }) => { run('DELETE FROM vocabulary WHERE id = ? AND user_id = ?', p.id, me()); return { ok: true }; });
on('POST', '/vocab/:id/review', async ({ req, p }) => {
  const v = get<any>('SELECT * FROM vocabulary WHERE id = ? AND user_id = ?', p.id, me()); if (!v) return bad('Not found', 404);
  const { grade } = await body(req); const s = schedule(v, Number(grade));
  run("UPDATE vocabulary SET ease=?, interval_days=?, reps=?, due_at=?, status=? WHERE id=?", s.ease, s.interval_days, s.reps, s.due_at, s.interval_days >= 21 ? 'mastered' : s.reps > 0 ? 'learning' : 'new', p.id);
  run('INSERT INTO vocabulary_reviews (vocabulary_id, grade, reviewed_at) VALUES (?,?,?)', p.id, Number(grade), now());
  return { ok: true, next: s.due_at };
});

// ───────────────────────── AI ─────────────────────────
function aiError(e: any) {
  if (e instanceof ollama.NoModelError) return J({ error: e.message, code: e.reason }, 503);
  return J({ error: e?.message ?? String(e) }, 500);
}
on('POST', '/ai/word', async ({ req }) => {
  const b = await body(req);
  try { return await explainWord(String(b.word).slice(0, 300), String(b.sentence ?? '').slice(0, 1000), b.mode === 'phrase' ? 'phrase' : 'word'); } catch (e) { return aiError(e); }
});
on('POST', '/ai/translate', async ({ req }) => {
  const b = await body(req);
  try { const r = await translate(String(b.text).slice(0, 3000), String(b.lang ?? 'Spanish').slice(0, 40)); return { text: r.text, model: r.model }; } catch (e) { return aiError(e); }
});
on('POST', '/ai/summary', async ({ req }) => {
  const b = await body(req); const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
  const from = Math.max(1, Number(b.from) || 1); const to = Math.min(Number(b.to) || from, bk.page_count);
  const kind = String(b.kind ?? 'quick');
  const sel = typeof b.selection === 'string' && b.selection.trim() ? b.selection.slice(0, 8000) : undefined;
  if (!sel && !b.force) {
    const c = get<any>('SELECT content, model FROM summaries WHERE book_id=? AND scope=? AND kind=? AND page_start=? AND page_end=?', b.bookId, 'pages', kind, from, to);
    if (c) return { text: c.content, model: c.model, cached: true };
  }
  try {
    let related: string | undefined;
    if (kind === 'connections') {
      const r = await retrieve(b.bookId, pageText(b.bookId, from, from, 600), { k: 5, nearPage: -1000 });
      related = r.hits.filter((h) => h.page_end < from || h.page_start > to).map((h) => `[Pages ${h.page_start}-${h.page_end}] ${h.text}`).join('\n---\n') || undefined;
    }
    const r = await summarize(b.bookId, kind, from, to, sel, related);
    if (!sel) run('INSERT OR REPLACE INTO summaries (id, book_id, scope, kind, page_start, page_end, content, model, created_at) VALUES (?,?,?,?,?,?,?,?,?)', uid(), b.bookId, 'pages', kind, from, to, r.text, r.model, now());
    return { text: r.text, model: r.model, cached: false, note: r.note };
  } catch (e) { return aiError(e); }
});
on('POST', '/ai/chat', async ({ req }) => {
  const b = await body(req); const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
  const message = String(b.message ?? '').trim().slice(0, 4000); if (!message) return bad('message required');
  const page = Math.min(Math.max(1, Number(b.page) || 1), Math.max(1, bk.page_count));
  const persona = PERSONAS[b.persona] ?? PERSONAS.professor;
  const model = await ollama.modelFor('comprehension');
  if (!model) { const st = await ollama.status(); return J({ error: new ollama.NoModelError(st.online ? 'no-model' : 'offline').message, code: st.online ? 'no-model' : 'offline' }, 503); }

  let convId: string = b.conversationId;
  if (!convId || !get('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?', convId, me())) {
    convId = uid(); run('INSERT INTO conversations VALUES (?,?,?,?,?,?)', convId, me(), b.bookId, message.slice(0, 80), b.persona ?? 'professor', now());
  }
  const history = all<{ role: string; content: string }>('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 8', convId).reverse();

  const sel = typeof b.selection === 'string' ? b.selection.slice(0, 3000) : '';
  const qv = await queryVariants(message, bk.language ?? 'en');
  const gp = JSON.parse(get<{ value: string }>('SELECT value FROM preferences WHERE user_id = ? AND key = ?', me(), `lang.book.${b.bookId}`)?.value ?? get<{ value: string }>('SELECT value FROM preferences WHERE user_id = ? AND key = ?', me(), 'lang.global')?.value ?? '{}');
  const answerLang: string = b.lang || (qv.lang !== 'en' && qv.confidence >= 0.4 ? qv.lang : gp.explain || 'en');
  const { hits, semantic } = await retrieve(b.bookId, `${qv.combined} ${sel}`.trim(), { k: 5, nearPage: page });
  const cur = pageText(b.bookId, page, page, 3500);
  const sources: { n: number; page_start: number; page_end: number; text: string; kind: string }[] = [{ n: 1, page_start: page, page_end: page, text: cur.replace(/^\[Page \d+\]\n/, ''), kind: 'current page' }];
  hits.forEach((h) => { if (!(h.page_start === page && h.page_end === page)) sources.push({ n: sources.length + 1, page_start: h.page_start, page_end: h.page_end, text: h.text, kind: h.via.join('+') }); });
  // neighbouring pages are real, citable context
  const prevPg = page > 1 ? get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', b.bookId, page - 1) : undefined;
  const nextPg = page < bk.page_count ? get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', b.bookId, page + 1) : undefined;
  if (prevPg?.text.trim()) sources.push({ n: sources.length + 1, page_start: page - 1, page_end: page - 1, text: prevPg.text.slice(-900), kind: 'previous page (end)' });
  if (nextPg?.text.trim()) sources.push({ n: sources.length + 1, page_start: page + 1, page_end: page + 1, text: nextPg.text.slice(0, 900), kind: 'next page (start)' });
  const pageVocab = all<any>('SELECT word FROM vocabulary WHERE book_id = ? AND page = ? LIMIT 12', b.bookId, page).map((v) => v.word);
  const ch = chapterOf(b.bookId, page);
  const goals = all<any>('SELECT title FROM goals WHERE user_id = ? AND active = 1', me()).map((g) => g.title);
  const notes = all<any>('SELECT body FROM notes WHERE book_id = ? ORDER BY created_at DESC LIMIT 3', b.bookId).map((n) => n.body.slice(0, 200));

  const system = `${persona}
${SAFETY}
You are a reading companion for the book "${bk.title}"${bk.author ? ` by ${bk.author}` : ''}. The reader is on page ${page}${ch ? ` (chapter "${ch.title}")` : ''}. Use the numbered sources as your PRIMARY knowledge. Cite them inline like [S1], [S2] using only the numbers provided; never invent a citation or page number.
When the sources do not contain the answer, say so explicitly and clearly separate:
- **From the book** (supported by cited sources),
- **General knowledge** (not from this book), and
- **My interpretation** (your own reasoning).
Omit a label if it does not apply. Be concise unless asked for depth.${languageInstruction(answerLang, qv.lang)}${b.style ? `
Explanation style: ${String(b.style).slice(0, 40)}.` : ''}${goals.length ? `\nThe reader's active goals: ${goals.join('; ')}.` : ''}${notes.length ? `\nRecent reader notes on this book: ${notes.join(' | ')}` : ''}${pageVocab.length ? `\nWords the reader saved on this page: ${pageVocab.join(', ')}.` : ''}${ollama.getPref('ai.instructions') ? `\nReader's standing instructions: ${ollama.getPref('ai.instructions')!.slice(0, 600)}` : ''}${ollama.getPref('ai.length') === 'short' ? '\nKeep answers brief (under 120 words).' : ollama.getPref('ai.length') === 'long' ? '\nGive thorough, detailed answers.' : ''}`;
  const srcBlock = sources.map((s) => `[S${s.n}] (pages ${s.page_start}${s.page_end !== s.page_start ? `–${s.page_end}` : ''}; ${s.kind})\n<book_excerpt>\n${s.text}\n</book_excerpt>`).join('\n\n');
  const user = `${sel ? `Selected text: "${sel}"\n\n` : ''}Sources:\n${srcBlock}\n\nQuestion: ${message}`;

  saveConversationMessage(convId, 'user', message);
  const citations = sources.map((s) => ({ n: s.n, page_start: s.page_start, page_end: s.page_end, quote: s.text.slice(0, 220).replace(/\s+/g, ' ') }));
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      let full = '';
      try {
        send({ type: 'meta', conversationId: convId, citations, model, retrieval: semantic ? 'hybrid (keyword + semantic)' : 'keyword only (no embedding model)' });
        for await (const d of ollama.chatStream('comprehension', [{ role: 'system', content: system }, ...history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })), { role: 'user', content: user }])) {
          if (d.delta) { full += d.delta; send({ type: 'delta', text: d.delta }); }
        }
        const cited = [...new Set([...full.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])))];
        const invalid = cited.filter((n) => !sources.some((s) => s.n === n));
        saveConversationMessage(convId, 'assistant', full, citations.filter((c) => cited.includes(c.n)), model);
        send({ type: 'done', cited, invalid });
      } catch (e: any) { send({ type: 'error', error: e?.message ?? String(e) }); }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
});
on('GET', '/books/:id/conversations', ({ p }) => all('SELECT * FROM conversations WHERE book_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20', p.id, me()));
on('GET', '/conversations/:id', ({ p }) => {
  if (!get('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?', p.id, me())) return bad('Not found', 404);
  return all('SELECT role, content, citations, model FROM messages WHERE conversation_id = ? ORDER BY id', p.id).map((m: any) => ({ ...m, citations: m.citations ? JSON.parse(m.citations) : [] }));
});

// ───────────────────────── goals / knowledge ─────────────────────────
on('GET', '/goals', () => all(`SELECT g.*, (SELECT COUNT(*) FROM goal_concepts gc WHERE gc.goal_id = g.id) AS concept_count FROM goals g WHERE user_id = ? ORDER BY created_at DESC`, me()));
on('POST', '/goals', async ({ req }) => {
  const b = await body(req); if (!String(b.title ?? '').trim()) return bad('title required');
  const id = uid();
  run('INSERT INTO goals (id, user_id, title, description, level, outcome, deadline, active, created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, me(), String(b.title).slice(0, 200), b.description ?? '', b.level ?? 'beginner', b.outcome ?? '', b.deadline || null, 1, now());
  return { id };
});
on('PATCH', '/goals/:id', async ({ req, p }) => {
  const b = await body(req);
  for (const k of ['title', 'description', 'level', 'outcome', 'deadline'] as const) if (k in b) run(`UPDATE goals SET ${k} = ? WHERE id = ? AND user_id = ?`, b[k] || null, p.id, me());
  if ('active' in b) run('UPDATE goals SET active = ? WHERE id = ? AND user_id = ?', b.active ? 1 : 0, p.id, me());
  return { ok: true };
});
on('DELETE', '/goals/:id', ({ p }) => { run('DELETE FROM goals WHERE id = ? AND user_id = ?', p.id, me()); return { ok: true }; });
on('POST', '/ai/goal-extract', async ({ req }) => {
  const b = await body(req); if (!book(b.bookId)) return bad('Not found', 404);
  try { const { extract, model } = await extractForGoal(b.bookId, b.goalId, Number(b.page) || 1, Array.isArray(b.types) ? b.types.map(String).slice(0, 30) : undefined); return { extract, model }; } catch (e) { return aiError(e); }
});
on('POST', '/goals/:id/save-extract', async ({ req, p }) => {
  const b = await body(req); if (!book(b.bookId) || !get('SELECT 1 FROM goals WHERE id = ? AND user_id = ?', p.id, me())) return bad('Not found', 404);
  return { saved: saveExtract(p.id, b.bookId, Number(b.page) || 1, b.extract ?? {}) };
});
on('GET', '/knowledge', ({ q }) => {
  const goal = q.get('goal'); const s = (q.get('q') ?? '').trim();
  return all(`SELECT gc.id, gc.page, gc.why, gc.category, c.id AS concept_id, c.name, c.summary, g.id AS goal_id, g.title AS goal_title, b.id AS book_id, b.title AS book_title
     FROM goal_concepts gc JOIN concepts c ON c.id = gc.concept_id JOIN goals g ON g.id = gc.goal_id LEFT JOIN books b ON b.id = gc.book_id
     WHERE g.user_id = ? ${goal ? 'AND g.id = ?' : ''} ${s ? 'AND (c.name LIKE ? OR c.summary LIKE ? OR gc.why LIKE ?)' : ''} ORDER BY gc.created_at DESC LIMIT 500`,
    me(), ...(goal ? [goal] : []), ...(s ? [`%${s}%`, `%${s}%`, `%${s}%`] : []));
});
on('DELETE', '/knowledge/:id', ({ p }) => { run('DELETE FROM goal_concepts WHERE id = ? AND goal_id IN (SELECT id FROM goals WHERE user_id = ?)', p.id, me()); return { ok: true }; });

on('GET', '/graph', () => {
  const nodes: { id: string; label: string; type: string }[] = [];
  const edges: { a: string; b: string; kind: string }[] = [];
  const add = (id: string, label: string, type: string) => { if (!nodes.some((n) => n.id === id)) nodes.push({ id, label, type }); };
  for (const g of all<any>('SELECT id, title FROM goals WHERE user_id = ?', me())) add('g:' + g.id, g.title, 'goal');
  for (const r of all<any>(`SELECT DISTINCT gc.goal_id, c.id cid, c.name, gc.book_id, b.title bt FROM goal_concepts gc JOIN concepts c ON c.id = gc.concept_id LEFT JOIN books b ON b.id = gc.book_id WHERE c.user_id = ? AND gc.category = 'concept' LIMIT 400`, me())) {
    add('c:' + r.cid, r.name, 'concept'); edges.push({ a: 'g:' + r.goal_id, b: 'c:' + r.cid, kind: 'goal' });
    if (r.book_id) { add('b:' + r.book_id, r.bt, 'book'); edges.push({ a: 'b:' + r.book_id, b: 'c:' + r.cid, kind: 'mentions' }); }
  }
  for (const r of all<any>('SELECT a_id, b_id, kind FROM concept_relationships LIMIT 800')) if (nodes.some((n) => n.id === 'c:' + r.a_id) && nodes.some((n) => n.id === 'c:' + r.b_id)) edges.push({ a: 'c:' + r.a_id, b: 'c:' + r.b_id, kind: r.kind });
  // Cross-book connection: a concept seen in 2+ books is a bridge
  for (const r of all<any>(`SELECT concept_id, COUNT(DISTINCT book_id) n FROM goal_concepts WHERE book_id IS NOT NULL GROUP BY concept_id HAVING n > 1`)) {
    const nd = nodes.find((x) => x.id === 'c:' + r.concept_id); if (nd) nd.type = 'bridge';
  }
  for (const r of all<any>('SELECT id, word FROM vocabulary WHERE user_id = ? LIMIT 100', me())) add('v:' + r.id, r.word, 'vocab');
  return { nodes, edges };
});

// ───────────────────────── learning ─────────────────────────
on('POST', '/ai/cards', async ({ req }) => {
  const b = await body(req); const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
  const from = Number(b.from) || 1; const to = Math.min(Number(b.to) || from, from + 9);
  try {
    const { cards, model } = await generateCards(b.bookId, from, to, Math.min(Number(b.count) || 6, 12));
    return { cards: cards.map((c: any) => ({ ...c, page: Number(c.page) >= from && Number(c.page) <= to ? Number(c.page) : from })), model };
  } catch (e) { return aiError(e); }
});
on('POST', '/cards', async ({ req }) => {
  const b = await body(req); const list: any[] = Array.isArray(b.cards) ? b.cards : [];
  let n = 0;
  tx(() => { for (const c of list) { if (!c.front || !c.back) continue; run('INSERT INTO flashcards (id, user_id, book_id, page, front, back, source_text, kind, created_at, due_at) VALUES (?,?,?,?,?,?,?,?,?,?)', uid(), me(), c.book_id ?? null, c.page ?? null, String(c.front).slice(0, 1000), String(c.back).slice(0, 2000), c.quote ?? null, c.kind ?? 'qa', now(), now()); n++; } });
  return { saved: n };
});
on('GET', '/cards', ({ q }) => all(`SELECT f.*, b.title AS book_title FROM flashcards f LEFT JOIN books b ON b.id = f.book_id WHERE f.user_id = ? ${q.get('due') ? 'AND f.due_at <= ?' : ''} ORDER BY f.due_at LIMIT 500`, me(), ...(q.get('due') ? [now()] : [])));
on('DELETE', '/cards/:id', ({ p }) => { run('DELETE FROM flashcards WHERE id = ? AND user_id = ?', p.id, me()); return { ok: true }; });
on('POST', '/cards/:id/review', async ({ req, p }) => {
  const f = get<any>('SELECT * FROM flashcards WHERE id = ? AND user_id = ?', p.id, me()); if (!f) return bad('Not found', 404);
  const { grade } = await body(req); const s = schedule(f, Number(grade));
  run('UPDATE flashcards SET ease=?, interval_days=?, reps=?, lapses=?, due_at=? WHERE id=?', s.ease, s.interval_days, s.reps, s.lapses, s.due_at, p.id);
  run('INSERT INTO flashcard_reviews (flashcard_id, grade, reviewed_at) VALUES (?,?,?)', p.id, Number(grade), now());
  return { ok: true, next: s.due_at };
});
on('POST', '/ai/quiz', async ({ req }) => {
  const b = await body(req); const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
  const from = Number(b.from) || 1; const to = Math.min(Number(b.to) || from, from + 14);
  try {
    const { questions, model } = await generateQuiz(b.bookId, from, to, Math.min(Number(b.count) || 5, 12));
    const id = uid();
    run('INSERT INTO quizzes VALUES (?,?,?,?,?,?,?)', id, me(), b.bookId, `${bk.title} — pp. ${from}–${to}`, `${from}-${to}`, JSON.stringify(questions), now());
    return { id, questions, model };
  } catch (e) { return aiError(e); }
});
on('POST', '/quizzes/:id/attempt', async ({ req, p }) => {
  if (!get('SELECT 1 FROM quizzes WHERE id = ? AND user_id = ?', p.id, me())) return bad('Not found', 404);
  const b = await body(req); run('INSERT INTO quiz_attempts VALUES (?,?,?,?,?,?)', uid(), p.id, Number(b.score) || 0, Number(b.total) || 0, JSON.stringify(b.answers ?? []), now()); return { ok: true };
});
on('GET', '/stats', () => {
  const n = (sql: string, ...a: any[]) => get<{ n: number }>(sql, ...a)?.n ?? 0;
  return {
    books: n('SELECT COUNT(*) n FROM books WHERE user_id = ?', me()),
    completed: n('SELECT COUNT(*) n FROM reading_progress p JOIN books b ON b.id = p.book_id WHERE b.user_id = ? AND p.percent >= 0.98', me()),
    readingSeconds: n('SELECT COALESCE(SUM(seconds),0) n FROM reading_sessions WHERE user_id = ?', me()),
    vocab: n('SELECT COUNT(*) n FROM vocabulary WHERE user_id = ?', me()), vocabMastered: n("SELECT COUNT(*) n FROM vocabulary WHERE user_id = ? AND status='mastered'", me()), vocabDue: n('SELECT COUNT(*) n FROM vocabulary WHERE user_id = ? AND due_at <= ?', me(), now()),
    cards: n('SELECT COUNT(*) n FROM flashcards WHERE user_id = ?', me()), cardsDue: n('SELECT COUNT(*) n FROM flashcards WHERE user_id = ? AND due_at <= ?', me(), now()),
    reviews: n('SELECT COUNT(*) n FROM flashcard_reviews'), retention: (() => { const t = n('SELECT COUNT(*) n FROM flashcard_reviews'); return t ? n('SELECT COUNT(*) n FROM flashcard_reviews WHERE grade >= 2') / t : null; })(),
    concepts: n('SELECT COUNT(*) n FROM concepts WHERE user_id = ?', me()), goals: n('SELECT COUNT(*) n FROM goals WHERE user_id = ? AND active = 1', me()),
    quizAvg: get<{ a: number | null }>('SELECT AVG(score * 1.0 / NULLIF(total,0)) a FROM quiz_attempts')?.a ?? null, quizAttempts: n('SELECT COUNT(*) n FROM quiz_attempts'),
    goalProgress: all('SELECT g.id, g.title, COUNT(gc.id) concepts, COUNT(DISTINCT gc.book_id) books, COUNT(DISTINCT gc.book_id || \':\' || gc.page) pages FROM goals g LEFT JOIN goal_concepts gc ON gc.goal_id = g.id WHERE g.user_id = ? GROUP BY g.id', me()),
  };
});

// ───────────────────────── TTS ─────────────────────────
on('POST', '/tts', async ({ req }) => {
  const piper = process.env.PIPER_URL;
  if (!piper) return bad('Piper TTS server not configured. Set PIPER_URL (see README). Browser speech is used instead.', 501);
  const b = await body(req); const text = String(b.text ?? '').slice(0, 4000); if (!text) return bad('text required');
  const voice = String(b.voice ?? '');
  const hash = crypto.createHash('sha256').update(`piper|${voice}|${text}`).digest('hex');
  const cached = get<any>('SELECT file_path FROM generated_audio WHERE text_hash = ?', hash);
  if (cached) return new Response(new Uint8Array(await fs.readFile(path.join(audioDir(), cached.file_path))), { headers: { 'content-type': 'audio/wav', 'x-cache': 'hit' } });
  const r = await fetch(piper, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice }) }).catch(() => null);
  if (!r?.ok) return bad('Piper server unreachable', 502);
  const buf = Buffer.from(await r.arrayBuffer()); const fn = `${hash}.wav`;
  await fs.writeFile(path.join(audioDir(), fn), buf);
  run('INSERT OR IGNORE INTO generated_audio VALUES (?,?,?,?,?,?,?,?)', uid(), b.bookId ?? null, b.page ?? null, 'piper', voice, hash, fn, now());
  return new Response(new Uint8Array(buf), { headers: { 'content-type': 'audio/wav', 'x-cache': 'miss' } });
});

// ───────────────────────── export / backup ─────────────────────────
on('GET', '/export', () => {
  let md = '# Book Reader export\n\n';
  for (const b of all<any>('SELECT id, title, author FROM books WHERE user_id = ?', me())) {
    const hs = all<any>('SELECT * FROM highlights WHERE book_id = ? ORDER BY page', b.id); const ns = all<any>('SELECT * FROM notes WHERE book_id = ? ORDER BY page', b.id);
    if (!hs.length && !ns.length) continue;
    md += `## ${b.title}${b.author ? ` — ${b.author}` : ''}\n\n`;
    for (const h of hs) md += `- (p. ${h.page}, ${h.color}) “${h.text.replace(/\s+/g, ' ')}”${h.note ? `\n  - Note: ${h.note}` : ''}\n`;
    for (const n of ns) md += `- Note${n.page ? ` (p. ${n.page})` : ''}: ${n.body}\n`;
    md += '\n';
  }
  md += '## Vocabulary\n\n' + all<any>('SELECT * FROM vocabulary WHERE user_id = ?', me()).map((v) => `- **${v.word}**${v.ipa ? ` ${v.ipa}` : ''} — ${v.definition ?? ''}${v.sentence ? ` _“${v.sentence}”_` : ''}`).join('\n') + '\n\n## Knowledge library\n\n';
  for (const g of all<any>('SELECT * FROM goals WHERE user_id = ?', me())) {
    md += `### Goal: ${g.title}\n`;
    for (const c of all<any>('SELECT c.name, c.summary, gc.page, gc.category, b.title bt FROM goal_concepts gc JOIN concepts c ON c.id = gc.concept_id LEFT JOIN books b ON b.id = gc.book_id WHERE gc.goal_id = ?', g.id)) md += `- [${c.category}] **${c.name}**${c.summary ? `: ${c.summary}` : ''} _(${c.bt ?? ''} p. ${c.page ?? ''})_\n`;
    md += '\n';
  }
  return new Response(md, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="book-reader-export.md"' } });
});
// The caller's own data as a zip: database + every file they own (books, covers, journal media, vaults). Used for backups and "download my data".
const exportMine = async () => {
  const tmp = path.join(tmpDir(), `export-${Date.now()}.db`);
  db().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const zip = new JSZip(); zip.file('app.db', await fs.readFile(tmp)); await fs.rm(tmp, { force: true });
  const add = async (dir: string, rel: string): Promise<void> => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) await add(p, `${rel}/${e.name}`); else if (e.isFile()) zip.file(`${rel}/${e.name}`, await fs.readFile(p)); } };
  if (usedBytes(true) > 1.5 * 1024 ** 3) return bad('Your data is larger than 1.5 GB: ask the administrator to run scripts/backup.mjs for you.', 413);
  for (const [dir, name] of [[filesDir(), 'files'], [coversDir(), 'covers'], [journalDir(), 'journal'], [vaultsDir(), 'vaults'], [audioDir(), 'audio'], [assetDir(), 'assets']] as const) await add(dir, name);
  zip.file('README.txt', `Folio export created ${new Date().toISOString()}\nContents: app.db (SQLite), files/ (uploaded books), covers/, journal/ (recordings, transcripts are in app.db), vaults/ (plain Markdown notes), audio/, assets/.\n`);
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return new Response(Buffer.from(out), { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="folio-export-${new Date().toISOString().slice(0, 10)}.zip"`, 'x-content-type-options': 'nosniff' } });
};
on('GET', '/backup', exportMine);
on('GET', '/account/export', exportMine);

registerExtra({ on, J, bad, body, book, aiError });
registerAnalytics({ on, J, bad, body, book, aiError });
registerLibrary({ on, J, bad, body, book, aiError });
registerLang({ on, J, bad, body, book, aiError });
registerRecall({ on, J, bad, body, book, aiError });
registerVault({ on, J, bad, body, book, aiError });
registerJournal({ on, J, bad, body, book, aiError });
registerMemory({ on, J, bad, body, book, aiError });

// ───────────────────────── dispatcher ─────────────────────────
async function dispatch(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  boot();
  if (!hostAllowed(req.headers.get('host'))) return J({ error: 'Unknown host' }, 421); // DNS-rebinding / host-header poisoning
  const segs = (await ctx.params).path;
  const pathname = '/' + segs.join('/');
  const pre = await handleAuth(req, pathname); // /auth/*, /account, /health, /dev/*: public or session-managed endpoints
  if (pre) return pre;
  const auth = authenticate(req);
  if (!auth) return J({ error: 'Sign in required.', code: 'auth' }, 401);
  if (!SAFE.has(req.method)) { if (!originOk(req)) return J({ error: 'Cross-origin request blocked' }, 403); if (!csrfOk(req, auth)) return J({ error: 'CSRF check failed. Reload the page and try again.', code: 'csrf' }, 403); }
  const rl = apiBucket(auth.account.id); if (!rl.ok) return Response.json({ error: 'Too many requests', retryAfterSec: rl.retryAfterSec }, { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } });
  return runAs(auth.account.id, async () => {
    for (const r of routes) {
      if (r.m !== req.method) continue;
      const m = pathname.match(r.re); if (!m) continue;
      const p: Record<string, string> = {};
      r.keys.forEach((k, i) => (p[k] = decodeURIComponent(m[i + 1])));
      try {
        const out = await r.h({ req, p, q: req.nextUrl.searchParams });
        return out instanceof Response ? out : J(out ?? { ok: true });
      } catch (e: any) {
        if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) return J({ error: e.message }, e.status); // typed, user-facing errors (quota, archive, vault, journal)
        if (FOLIO_ENV === 'production') { const ref = crypto.randomBytes(4).toString('hex'); console.error(`[${ref}] ${req.method} ${pathname}:`, e); return J({ error: `Something went wrong (ref ${ref}).` }, 500); } // never leak internals to clients
        return J({ error: e?.message ?? String(e) }, 500);
      }
    }
    return J({ error: `No route ${req.method} ${pathname}` }, 404);
  }, !!auth.account.is_admin);
}
export { dispatch as GET, dispatch as POST, dispatch as PUT, dispatch as PATCH, dispatch as DELETE };
