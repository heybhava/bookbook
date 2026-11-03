// Personal-intelligence endpoints (capture, vocabulary discovery, inbox, export/import).
// Registered into the same router as the original API; nothing here replaces an existing route.
import type { NextRequest } from 'next/server';
import { all, get, run, tx, uid, LOCAL_USER } from './db';
import { captureSelection } from './capture';
import { discover, knownWords } from './vocabdisc';
import { chat, parseJson, NoModelError } from './ollama';
import { SAFETY } from './rag';

export interface Kit {
  on: (m: string, pattern: string, h: (c: { req: NextRequest; p: Record<string, string>; q: URLSearchParams }) => unknown) => void;
  J: (d: unknown, status?: number) => Response;
  bad: (msg: string, status?: number) => Response;
  body: <T = any>(req: NextRequest) => Promise<T>;
  book: (id: string) => any;
  aiError: (e: any) => Response;
}

export const NOTE_KINDS = ['selection', 'note', 'quote', 'question', 'objective', 'action', 'concept', 'lesson', 'framework', 'formula', 'insight'] as const;
const now = () => Date.now();
const splitTags = (t: string | null | undefined) => (t ?? '').split(',').map((x) => x.trim()).filter(Boolean);

interface InboxItem {
  key: string; src: 'note' | 'highlight' | 'vocab' | 'concept'; id: string; type: string; title: string | null; body: string; tags: string[];
  book_id: string | null; book_title: string | null; author: string | null; page: number | null; chapter: string | null; section: string | null;
  context: string | null; start: number | null; end: number | null; created_at: number; collection: string | null; extra?: Record<string, unknown>;
}

export function inboxItems(): InboxItem[] {
  const items: InboxItem[] = [];
  for (const n of all<any>(`SELECT n.*, b.title AS book_title, b.author AS author FROM notes n LEFT JOIN books b ON b.id = n.book_id WHERE n.user_id = ?`, LOCAL_USER)) {
    items.push({ key: `note:${n.id}`, src: 'note', id: n.id, type: n.source === 'ai' && n.kind === 'note' ? 'ai' : n.kind, title: n.title, body: n.body, tags: splitTags(n.tags), book_id: n.book_id, book_title: n.book_title, author: n.author, page: n.page, chapter: n.chapter_title, section: n.section, context: n.context, start: n.start_offset, end: n.end_offset, created_at: n.created_at, collection: n.collection });
  }
  for (const h of all<any>(`SELECT h.*, b.title AS book_title, b.author AS author FROM highlights h JOIN books b ON b.id = h.book_id WHERE b.user_id = ?`, LOCAL_USER)) {
    items.push({ key: `highlight:${h.id}`, src: 'highlight', id: h.id, type: 'highlight', title: null, body: h.text, tags: [], book_id: h.book_id, book_title: h.book_title, author: h.author, page: h.page, chapter: null, section: null, context: h.note, start: h.start_offset, end: h.end_offset, created_at: h.created_at, collection: null, extra: { color: h.color } });
  }
  for (const v of all<any>(`SELECT v.*, b.title AS book_title, b.author AS author FROM vocabulary v LEFT JOIN books b ON b.id = v.book_id WHERE v.user_id = ?`, LOCAL_USER)) {
    items.push({ key: `vocab:${v.id}`, src: 'vocab', id: v.id, type: 'vocab', title: v.word, body: v.definition ?? '', tags: [], book_id: v.book_id, book_title: v.book_title, author: v.author, page: v.page, chapter: null, section: null, context: v.sentence, start: null, end: null, created_at: v.created_at, collection: null, extra: { ipa: v.ipa, pos: v.pos, status: v.status } });
  }
  for (const c of all<any>(`SELECT gc.*, c.name, c.summary, g.title AS goal_title, b.title AS book_title, b.author AS author FROM goal_concepts gc JOIN concepts c ON c.id = gc.concept_id JOIN goals g ON g.id = gc.goal_id LEFT JOIN books b ON b.id = gc.book_id WHERE g.user_id = ?`, LOCAL_USER)) {
    items.push({ key: `concept:${c.id}`, src: 'concept', id: c.id, type: c.category === 'concept' ? 'concept' : c.category.replace(/s$/, ''), title: c.name, body: c.detail || c.summary || '', tags: [c.goal_title], book_id: c.book_id, book_title: c.book_title, author: c.author, page: c.page, chapter: null, section: null, context: c.why, start: null, end: null, created_at: c.created_at, collection: null, extra: { goal: c.goal_title, concept_id: c.concept_id } });
  }
  return items;
}

const clozeCard = (text: string) => {
  const words = text.match(/[A-Za-z]{6,}/g) ?? [];
  const w = words.sort((a, b) => b.length - a.length)[0];
  return w ? { front: text.replace(new RegExp(`\\b${w}\\b`), '_____').slice(0, 800), back: `${w}\n\n${text}`.slice(0, 1800) } : { front: `Recall: ${text.slice(0, 80)}…`, back: text };
};

export function registerExtra({ on, J, bad, body, book, aiError }: Kit) {
  // ── 1. automatic selection capture ──
  on('POST', '/books/:id/captures', async ({ req, p }) => {
    const bk = book(p.id); if (!bk) return bad('Not found', 404);
    const b = await body(req);
    const page = Number(b.page);
    if (!Number.isInteger(page) || page < 1 || page > bk.page_count || typeof b.text !== 'string') return bad('page and text required');
    const r = captureSelection({ bookId: p.id, page, text: b.text, start: b.start ?? null, end: b.end ?? null });
    return { ...r, note: get('SELECT id, body, page, chapter_title, section FROM notes WHERE id = ?', r.id) };
  });
  on('PATCH', '/notes/:id', async ({ req, p }) => {
    const b = await body(req);
    if (!get('SELECT 1 FROM notes WHERE id = ? AND user_id = ?', p.id, LOCAL_USER)) return bad('Not found', 404);
    for (const k of ['title', 'body', 'tags', 'collection'] as const) if (typeof b[k] === 'string') run(`UPDATE notes SET ${k} = ?, updated_at = ? WHERE id = ?`, b[k].slice(0, 20000), now(), p.id);
    if (typeof b.kind === 'string' && (NOTE_KINDS as readonly string[]).includes(b.kind)) run('UPDATE notes SET kind = ?, updated_at = ? WHERE id = ?', b.kind, now(), p.id);
    return { ok: true };
  });
  on('POST', '/notes/:id/link', async ({ req, p }) => {
    const { to } = await body(req);
    if (!get('SELECT 1 FROM notes WHERE id = ? AND user_id = ?', p.id, LOCAL_USER) || !get('SELECT 1 FROM notes WHERE id = ? AND user_id = ?', to, LOCAL_USER) || to === p.id) return bad('Both notes must exist');
    run('INSERT OR IGNORE INTO note_links (a_id, b_id) VALUES (?,?)', p.id, to);
    return { ok: true };
  });
  on('GET', '/notes/:id/links', ({ p }) => all(`SELECT n.id, n.body, n.page, n.book_id FROM note_links l JOIN notes n ON n.id = CASE WHEN l.a_id = ? THEN l.b_id ELSE l.a_id END WHERE (l.a_id = ? OR l.b_id = ?) AND n.user_id = ?`, p.id, p.id, p.id, LOCAL_USER));

  // ── 2. vocabulary discovery ──
  on('GET', '/books/:id/vocab-discovery', async ({ p, q }) => {
    if (!book(p.id)) return bad('Not found', 404);
    const page = Number(q.get('page') ?? 1);
    const pg = get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', p.id, page);
    if (!pg) return [];
    return discover(pg.text, { limit: 14 });
  });
  on('POST', '/vocab/analyze', async ({ req }) => {
    const { text } = await body(req);
    if (typeof text !== 'string') return bad('text required');
    return discover(text.slice(0, 6000), { limit: 10, includeKnown: true });
  });
  on('POST', '/vocab/ignore', async ({ req }) => {
    const { word } = await body(req);
    if (typeof word !== 'string' || !word.trim()) return bad('word required');
    run('INSERT OR IGNORE INTO ignored_words (user_id, word) VALUES (?,?)', LOCAL_USER, word.trim().toLowerCase());
    return { ok: true };
  });
  on('POST', '/vocab/bulk', async ({ req }) => {
    const b = await body(req);
    const words: any[] = Array.isArray(b.words) ? b.words : [];
    let saved = 0, cards = 0;
    const { lookup } = await import('./dictionary');
    for (const w of words.slice(0, 60)) {
      const word = String(w.word ?? '').toLowerCase().trim(); if (!word) continue;
      const d = await lookup(word); const s = d.senses[0];
      const ex = run(`INSERT INTO vocabulary (id, user_id, word, definition, ipa, pos, sentence, book_id, page, created_at, due_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                      ON CONFLICT(user_id, word) DO NOTHING`, uid(), LOCAL_USER, word, s?.definition ?? null, d.ipa ?? null, s?.pos ?? null, w.sentence ?? null, w.book_id ?? null, w.page ?? null, now(), now());
      if (ex.changes) saved++;
      if (b.flashcards && s) {
        run('INSERT INTO flashcards (id, user_id, book_id, page, front, back, source_text, kind, created_at, due_at) VALUES (?,?,?,?,?,?,?,?,?,?)', uid(), LOCAL_USER, w.book_id ?? null, w.page ?? null, `What does “${word}” mean?${w.sentence ? `\n\n“${w.sentence}”` : ''}`, `${s.definition}${d.ipa ? `\n${d.ipa}` : ''}`, w.sentence ?? null, 'vocab', now(), now());
        cards++;
      }
    }
    return { saved, cards };
  });
  on('POST', '/ai/phrases', async ({ req }) => {
    const b = await body(req); const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
    const pg = get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', b.bookId, Number(b.page));
    if (!pg) return bad('page not found', 404);
    try {
      const r = await chat('vocabulary', [
        { role: 'system', content: `${SAFETY}\nFind idioms, figurative expressions, technical/domain terms and important multi-word phrases in the text. Only list phrases that literally appear in it (copy them exactly). Return ONLY JSON: {"items":[{"phrase":"exact text","kind":"idiom|term|phrase","meaning":"plain-English meaning in this context"}]} with at most 8 items; empty list if none.` },
        { role: 'user', content: `<book_excerpt>\n${pg.text.slice(0, 6000)}\n</book_excerpt>` }], { json: true, temperature: 0.1 });
      const items = (parseJson<any>(r.text)?.items ?? []).filter((i: any) => i?.phrase && pg.text.toLowerCase().includes(String(i.phrase).toLowerCase()));
      return { items, model: r.model };
    } catch (e) { return aiError(e); }
  });

  // ── 3. Knowledge Inbox ──
  on('GET', '/inbox', ({ q }) => {
    let items = inboxItems();
    const type = q.get('type'), text = (q.get('q') ?? '').toLowerCase().trim(), tag = q.get('tag'), bookId = q.get('book'), coll = q.get('collection');
    if (type && type !== 'all') items = items.filter((i) => i.type === type);
    if (bookId) items = items.filter((i) => i.book_id === bookId);
    if (tag) items = items.filter((i) => i.tags.includes(tag));
    if (coll) items = items.filter((i) => i.collection === coll);
    if (text) items = items.filter((i) => `${i.title ?? ''} ${i.body} ${i.context ?? ''} ${i.book_title ?? ''} ${i.tags.join(' ')}`.toLowerCase().includes(text));
    const sort = q.get('sort') ?? 'new';
    items.sort((a, b) => sort === 'old' ? a.created_at - b.created_at : sort === 'book' ? (a.book_title ?? '').localeCompare(b.book_title ?? '') || (a.page ?? 0) - (b.page ?? 0) : b.created_at - a.created_at);
    const all2 = inboxItems();
    const counts: Record<string, number> = {}; for (const i of all2) counts[i.type] = (counts[i.type] ?? 0) + 1;
    return { items: items.slice(0, 600), total: items.length, counts, tags: [...new Set(all2.flatMap((i) => i.tags))].sort(), collections: [...new Set(all2.map((i) => i.collection).filter(Boolean))].sort() };
  });
  on('DELETE', '/inbox/:src/:id', ({ p }) => {
    const sql: Record<string, string> = {
      note: 'DELETE FROM notes WHERE id = ? AND user_id = ?', vocab: 'DELETE FROM vocabulary WHERE id = ? AND user_id = ?',
      highlight: 'DELETE FROM highlights WHERE id = ? AND book_id IN (SELECT id FROM books WHERE user_id = ?)',
      concept: 'DELETE FROM goal_concepts WHERE id = ? AND goal_id IN (SELECT id FROM goals WHERE user_id = ?)',
    };
    if (!sql[p.src]) return bad('unknown source');
    run(sql[p.src], p.id, LOCAL_USER); return { ok: true };
  });
  on('POST', '/inbox/convert', async ({ req }) => {
    const { key, to, goalId } = await body(req);
    const item = inboxItems().find((i) => i.key === key);
    if (!item) return bad('Item not found', 404);
    const text = item.body || item.title || '';
    if (to === 'flashcard') {
      let card = clozeCard(text); let how = 'cloze';
      try {
        const r = await chat('knowledge', [{ role: 'system', content: `${SAFETY}\nWrite ONE study flashcard testing the single idea in the passage. Return ONLY JSON {"front":"question","back":"answer"}; answer must come from the passage.` }, { role: 'user', content: `<book_excerpt>\n${text.slice(0, 2500)}\n</book_excerpt>` }], { json: true, temperature: 0.2 });
        const j = parseJson<any>(r.text); if (j?.front && j?.back) { card = { front: String(j.front), back: String(j.back) }; how = 'ai'; }
      } catch (e) { if (!(e instanceof NoModelError)) throw e; }
      const id = uid();
      run('INSERT INTO flashcards (id, user_id, book_id, page, front, back, source_text, kind, created_at, due_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, LOCAL_USER, item.book_id, item.page, card.front, card.back, text.slice(0, 500), 'qa', now(), now());
      return { ok: true, id, how };
    }
    if (['note', 'question', 'objective', 'action', 'concept'].includes(to)) {
      let nid = item.src === 'note' ? item.id : '';
      if (item.src === 'note') run('UPDATE notes SET kind = ?, updated_at = ? WHERE id = ?', to, now(), item.id);
      else {
        nid = uid();
        run(`INSERT INTO notes (id, user_id, book_id, page, title, body, tags, source, created_at, kind, chapter_title, section, context, quote, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          nid, LOCAL_USER, item.book_id, item.page, item.title, text, item.tags.join(','), 'convert', now(), to, item.chapter, item.section, item.context, text, now());
      }
      if (to === 'concept') {
        const name = (item.title || text).replace(/\s+/g, ' ').slice(0, 100);
        const ex = get<{ id: string }>('SELECT id FROM concepts WHERE user_id = ? AND lower(name) = lower(?)', LOCAL_USER, name);
        const cid = ex?.id ?? uid();
        if (!ex) run('INSERT INTO concepts (id, user_id, name, summary, created_at) VALUES (?,?,?,?,?)', cid, LOCAL_USER, name, text.slice(0, 600), now());
        const gid = goalId ?? get<{ id: string }>('SELECT id FROM goals WHERE user_id = ? AND active = 1 ORDER BY created_at DESC', LOCAL_USER)?.id;
        if (gid) run('INSERT INTO goal_concepts (id, goal_id, concept_id, book_id, page, why, category, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?)', uid(), gid, cid, item.book_id, item.page, '', 'concept', text.slice(0, 600), now());
      }
      return { ok: true, id: nid };
    }
    return bad('unknown conversion');
  });

  // ── 15. export / import ──
  on('GET', '/export/data', ({ q }) => {
    const fmt = q.get('format') ?? 'json', what = q.get('what') ?? 'all';
    const data = {
      version: 1, exported_at: new Date().toISOString(), app: 'Folio',
      books: all('SELECT id, title, author, format, page_count FROM books WHERE user_id = ?', LOCAL_USER),
      notes: all('SELECT n.id, n.kind, n.title, n.body, n.tags, n.collection, n.page, n.chapter_title, n.section, n.context, n.start_offset, n.end_offset, n.created_at, n.book_id, b.title AS book_title, b.author FROM notes n LEFT JOIN books b ON b.id = n.book_id WHERE n.user_id = ?', LOCAL_USER),
      highlights: all('SELECT h.*, b.title AS book_title FROM highlights h JOIN books b ON b.id = h.book_id WHERE b.user_id = ?', LOCAL_USER),
      vocabulary: all('SELECT word, definition, ipa, pos, sentence, book_id, page, status, created_at FROM vocabulary WHERE user_id = ?', LOCAL_USER),
      flashcards: all('SELECT front, back, source_text, book_id, page, created_at FROM flashcards WHERE user_id = ?', LOCAL_USER),
      summaries: all('SELECT book_id, kind, page_start, page_end, content, model FROM summaries WHERE book_id IN (SELECT id FROM books WHERE user_id = ?)', LOCAL_USER),
      goals: all('SELECT * FROM goals WHERE user_id = ?', LOCAL_USER),
      knowledge: all('SELECT g.title AS goal, c.name, c.summary, gc.category, gc.why, gc.page, gc.book_id FROM goal_concepts gc JOIN concepts c ON c.id = gc.concept_id JOIN goals g ON g.id = gc.goal_id WHERE g.user_id = ?', LOCAL_USER),
      drafts: all('SELECT title, body, created_at, updated_at FROM drafts WHERE user_id = ?', LOCAL_USER),
      reading_history: all('SELECT b.title, s.started_at, s.seconds, s.pages FROM reading_sessions s JOIN books b ON b.id = s.book_id WHERE s.user_id = ? ORDER BY s.started_at DESC', LOCAL_USER),
    } as Record<string, any>;
    const pick = (k: string) => (what === 'all' ? data : { version: 1, [k]: data[k] });
    const dl = (content: string, type: string, ext: string) => new Response(content, { headers: { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename="folio-${what}.${ext}"` } });
    if (fmt === 'json') return dl(JSON.stringify(what === 'all' ? data : pick(what), null, 2), 'application/json', 'json');
    const csvEsc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const toCsv = (rows: Record<string, any>[]) => rows.length ? [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.keys(rows[0]).map((k) => csvEsc(r[k])).join(','))].join('\n') : '';
    if (fmt === 'csv') { const k = what === 'all' ? 'notes' : what; if (!Array.isArray(data[k])) return bad('unknown dataset'); return dl(toCsv(data[k]), 'text/csv', 'csv'); }
    const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const src = (n: any) => [n.book_title, n.author, n.chapter_title, n.page ? `p. ${n.page}` : ''].filter(Boolean).join(' · ');
    let md = '# Folio export\n\n', html = '<!doctype html><meta charset="utf-8"><title>Folio export</title><style>body{font:16px/1.6 Georgia,serif;max-width:46rem;margin:2rem auto;padding:0 1rem}blockquote{border-left:3px solid #999;margin:.5rem 0;padding-left:1rem}small{color:#666}</style><h1>Folio export</h1>';
    const sections: [string, any[]][] = [['Notes & captured passages', data.notes], ['Highlights', data.highlights], ['Vocabulary', data.vocabulary], ['Flashcards', data.flashcards], ['Knowledge', data.knowledge]];
    for (const [title, rows] of sections) {
      if (!rows.length || (what !== 'all' && !title.toLowerCase().startsWith(what))) continue;
      md += `## ${title}\n\n`; html += `<h2>${title}</h2>`;
      for (const r of rows) {
        const main = r.body ?? r.text ?? r.definition ?? r.back ?? r.summary ?? '';
        const head = r.word ?? r.front ?? r.name ?? r.title ?? '';
        const meta = src(r) || [r.book_title, r.page ? `p. ${r.page}` : ''].filter(Boolean).join(' · ');
        md += `- ${head ? `**${head}** — ` : ''}${String(main).replace(/\n/g, ' ')}${meta ? ` _(${meta})_` : ''}\n`;
        html += `<blockquote>${head ? `<b>${esc(head)}</b> — ` : ''}${esc(main)}${meta ? `<br><small>${esc(meta)}</small>` : ''}</blockquote>`;
      }
      md += '\n';
    }
    return fmt === 'html' ? dl(html, 'text/html', 'html') : dl(md, 'text/markdown', 'md');
  });
  on('POST', '/import', async ({ req }) => {
    const b = await body(req);
    let notes = 0, vocab = 0, cards = 0;
    tx(() => {
      if (b.format === 'markdown' && typeof b.text === 'string') {
        const title = String(b.title ?? 'Imported note').slice(0, 120);
        const parts = b.text.split(/\n{2,}/).map((s: string) => s.trim()).filter(Boolean).slice(0, 500);
        for (const part of parts) { run("INSERT INTO notes (id, user_id, title, body, tags, source, created_at, kind, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", uid(), LOCAL_USER, title, part, 'imported', 'import', now(), 'note', now()); notes++; }
      } else if (b.format === 'json' && b.data && typeof b.data === 'object') {
        const byTitle = new Map(all<any>('SELECT id, title FROM books WHERE user_id = ?', LOCAL_USER).map((x) => [String(x.title).toLowerCase(), x.id]));
        const bookFor = (n: any) => (n.book_title ? byTitle.get(String(n.book_title).toLowerCase()) ?? null : null);
        for (const n of b.data.notes ?? []) { if (!n?.body) continue; const bid = bookFor(n); run("INSERT INTO notes (id, user_id, book_id, page, title, body, tags, source, created_at, kind, chapter_title, section, context, collection, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", uid(), LOCAL_USER, bid, bid ? n.page ?? null : null, n.title ?? null, String(n.body).slice(0, 20000), n.tags ?? '', 'import', now(), (NOTE_KINDS as readonly string[]).includes(n.kind) ? n.kind : 'note', n.chapter_title ?? null, n.section ?? null, n.context ?? null, n.collection ?? null, now()); notes++; }
        for (const v of b.data.vocabulary ?? []) { if (!v?.word) continue; const r = run('INSERT INTO vocabulary (id, user_id, word, definition, ipa, pos, sentence, created_at, due_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, word) DO NOTHING', uid(), LOCAL_USER, String(v.word).toLowerCase(), v.definition ?? null, v.ipa ?? null, v.pos ?? null, v.sentence ?? null, now(), now()); vocab += Number(r.changes); }
        for (const c of b.data.flashcards ?? []) { if (!c?.front || !c?.back) continue; run('INSERT INTO flashcards (id, user_id, front, back, source_text, kind, created_at, due_at) VALUES (?,?,?,?,?,?,?,?)', uid(), LOCAL_USER, String(c.front), String(c.back), c.source_text ?? null, 'qa', now(), now()); cards++; }
      } else throw new Error('Unsupported import: send {format:"json", data} (a Folio export) or {format:"markdown", text}');
    });
    return { notes, vocab, cards };
  });
  void knownWords;
}
