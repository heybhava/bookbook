// Cross-book question answering, universal search, writing workspace.
import { all, get, run, uid, LOCAL_USER } from './db';
import * as ollama from './ollama';
import { SAFETY } from './rag';
import { retrieveLibrary, relatedNotes, relatedVocab, ftsMatch } from './library';
import type { Kit } from './routes2';
import { queryVariants, languageInstruction } from './lang/translate';

const now = () => Date.now();

const MODES: Record<string, string> = {
  answer: 'Answer the question using the sources. Synthesise across books where they relate.',
  compare: 'Compare how the different books/authors treat this topic. Give one short section per book/author, then "Where they agree" and "Where they differ". Only compare what the sources actually say.',
  contradictions: 'Identify genuine contradictions or tensions between the sources, and separately any consensus. If the sources do not clearly disagree, say so plainly instead of inventing a conflict.',
  teach: 'Teach the topic step by step as a tutor, building from basics, using only what the sources support. End with 3 check-your-understanding questions.',
  learned: 'Summarise what the reader has learned about this topic, organised by theme. Mention which of their own saved notes (marked "your note") support each point.',
};

export function registerLibrary({ on, J, bad, body, book, aiError }: Kit) {
  on('POST', '/ai/library-ask', async ({ req }) => {
    const b = await body(req);
    const question = String(b.question ?? '').trim().slice(0, 2000);
    if (!question) return bad('question required');
    const bookIds: string[] = Array.isArray(b.bookIds) ? b.bookIds.filter((id: string) => book(id)) : [];
    const mode = MODES[b.mode] ? b.mode : 'answer';
    const model = await ollama.modelFor('comprehension');
    if (!model) { const st = await ollama.status(); return J({ error: new ollama.NoModelError(st.online ? 'no-model' : 'offline').message, code: st.online ? 'no-model' : 'offline' }, 503); }

    const qv = await queryVariants(question);
    const { hits, semantic, booksSearched } = await retrieveLibrary(qv.combined, { bookIds, k: mode === 'compare' || mode === 'contradictions' ? 12 : 8 });
    const notes = relatedNotes(question, 5).filter((n) => !bookIds.length || !n.book_id || bookIds.includes(n.book_id));
    const vocab = relatedVocab(question, 5);
    const sources = hits.map((h, i) => ({ n: i + 1, own: false, book_id: h.book_id, book_title: h.book_title, author: h.author, chapter: h.chapter_title, page_start: h.page_start, page_end: h.page_end, quote: h.text, via: h.via }));
    for (const n of notes) sources.push({ n: sources.length + 1, own: true, book_id: n.book_id, book_title: n.book_title ?? 'Your notes', author: null, chapter: null, page_start: n.page ?? 0, page_end: n.page ?? 0, quote: n.body, via: ['your note'] });

    const distinctBooks = new Set(hits.map((h) => h.book_id)).size;
    const limitations = [
      !hits.length ? 'No passages in your library matched this question.' : `Based on ${hits.length} passage${hits.length > 1 ? 's' : ''} from ${distinctBooks} of ${booksSearched} book${booksSearched === 1 ? '' : 's'}${notes.length ? ` and ${notes.length} of your notes` : ''}.`,
      semantic ? 'Hybrid search (keyword + meaning).' : 'Keyword search only (no embedding model or books not yet embedded) — related passages worded differently may be missed.',
      distinctBooks < 2 && (mode === 'compare' || mode === 'contradictions') ? 'Fewer than two books matched, so a real comparison is limited.' : '',
      'Local models can misread sources: check the quoted passages.',
    ].filter(Boolean);
    const confidence = !hits.length ? 'none' : distinctBooks >= 2 && hits.length >= 5 && semantic ? 'moderate-high' : hits.length >= 3 ? 'moderate' : 'low';

    const sys = `You are a research assistant over the reader's own personal library. ${MODES[mode]}
${SAFETY}
Write the answer in your OWN words. Never copy the source labels, headers or <book_excerpt> tags into your answer, and never paste whole source passages: quote at most one short phrase (under 15 words) per source, inside quotation marks.
Use ONLY the numbered sources. Cite every claim inline as [S1], [S2] etc.; never invent a citation, quotation, page number, author or title. Sources marked "your note" are the reader's own notes, not the books' words — say so when you rely on them.
${languageInstruction(String(b.lang || (qv.lang !== 'en' && qv.confidence >= 0.4 ? qv.lang : 'en')), qv.lang)}
Format in Markdown with exactly two parts: "## Evidence from your sources" (what the sources say, with citations) then "## Interpretation" (your own synthesis, clearly labelled as interpretation and not source content). If the sources do not answer the question, say that instead of guessing; you may add a short "General knowledge (not from your library)" note if useful.`;
    const srcBlock = sources.map((s) => `[S${s.n}] ${s.own ? 'your note' : `${s.book_title}${s.author ? ` — ${s.author}` : ''}${s.chapter ? `, ${s.chapter}` : ''}, p. ${s.page_start}${s.page_end !== s.page_start ? `–${s.page_end}` : ''}`}\n<book_excerpt>\n${s.quote.slice(0, 800)}\n</book_excerpt>`).join('\n\n');
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctrl) {
        const send = (o: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n'));
        let full = '';
        try {
          send({ type: 'meta', model, sources, vocab, limitations, confidence });
          if (!sources.length) { send({ type: 'delta', text: 'I found nothing in your library that matches this question. Try different wording, add the relevant book, or check that your books have finished indexing.' }); send({ type: 'done', cited: [], invalid: [] }); return ctrl.close(); }
          for await (const d of ollama.chatStream('comprehension', [{ role: 'system', content: sys }, { role: 'user', content: `Sources:\n${srcBlock}\n\nQuestion: ${question}` }], 0.3)) if (d.delta) { full += d.delta; send({ type: 'delta', text: d.delta }); }
          const cited = [...new Set([...full.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])))];
          send({ type: 'done', cited, invalid: cited.filter((n) => !sources.some((s) => s.n === n)) });
        } catch (e: any) { send({ type: 'error', error: e?.message ?? String(e) }); }
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
  });

  // universal search (command palette): books, inbox, vocabulary, passages from every book
  on('GET', '/search', async ({ q }) => {
    const s = (q.get('q') ?? '').trim();
    if (s.length < 2) return { books: [], notes: [], vocab: [], passages: [] };
    const like = `%${s}%`;
    const qv = await queryVariants(s); const en = qv.english; const likeEn = en ? `%${en}%` : like; // cross-language: also search the English meaning of a non-English query
    const m = ftsMatch(qv.combined);
    return {
      books: all('SELECT id, title, author, format FROM books WHERE user_id = ? AND (title LIKE ? OR author LIKE ?) LIMIT 6', LOCAL_USER, like, like),
      notes: all(`SELECT n.id, n.body, n.kind, n.page, n.book_id, b.title AS book_title FROM notes n LEFT JOIN books b ON b.id = n.book_id WHERE n.user_id = ? AND (n.body LIKE ? OR n.title LIKE ? OR n.body LIKE ?) ORDER BY n.created_at DESC LIMIT 8`, LOCAL_USER, like, like, likeEn),
      vocab: all('SELECT id, word, definition FROM vocabulary WHERE user_id = ? AND (word LIKE ? OR definition LIKE ? OR word LIKE ? OR definition LIKE ?) LIMIT 6', LOCAL_USER, like, like, likeEn, likeEn),
      passages: m ? all(`SELECT c.book_id, c.page_start AS page, b.title AS book_title, snippet(chunks_fts, 0, '[', ']', '…', 18) AS snippet FROM chunks_fts f JOIN chunks c ON c.id = f.rowid JOIN books b ON b.id = c.book_id WHERE chunks_fts MATCH ? AND b.user_id = ? ORDER BY bm25(chunks_fts) LIMIT 8`, m, LOCAL_USER) : [],
    };
  });

  // writing & thinking workspace
  on('GET', '/drafts', () => all('SELECT id, title, substr(body,1,160) AS preview, updated_at FROM drafts WHERE user_id = ? ORDER BY updated_at DESC', LOCAL_USER));
  on('GET', '/drafts/:id', ({ p }) => get('SELECT * FROM drafts WHERE id = ? AND user_id = ?', p.id, LOCAL_USER) ?? bad('Not found', 404));
  on('POST', '/drafts', async ({ req }) => { const b = await body(req); const id = uid(); run('INSERT INTO drafts (id, user_id, title, body, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, LOCAL_USER, String(b.title ?? 'Untitled').slice(0, 200), String(b.body ?? ''), now(), now()); return { id }; });
  on('PATCH', '/drafts/:id', async ({ req, p }) => {
    const b = await body(req);
    if (!get('SELECT 1 FROM drafts WHERE id = ? AND user_id = ?', p.id, LOCAL_USER)) return bad('Not found', 404);
    if (typeof b.title === 'string') run('UPDATE drafts SET title = ? WHERE id = ?', b.title.slice(0, 200), p.id);
    if (typeof b.body === 'string') run('UPDATE drafts SET body = ? WHERE id = ?', b.body.slice(0, 500000), p.id);
    run('UPDATE drafts SET updated_at = ? WHERE id = ?', now(), p.id);
    return { ok: true };
  });
  on('DELETE', '/drafts/:id', ({ p }) => { run('DELETE FROM drafts WHERE id = ? AND user_id = ?', p.id, LOCAL_USER); return { ok: true }; });
  // AI help grounded in the library; returns real source records the editor can insert as references
  on('POST', '/ai/draft-assist', async ({ req }) => {
    const b = await body(req);
    const instruction = String(b.instruction ?? '').trim().slice(0, 1500); if (!instruction) return bad('instruction required');
    try {
      const { hits } = await retrieveLibrary(`${instruction} ${String(b.draft ?? '').slice(0, 300)}`, { bookIds: Array.isArray(b.bookIds) ? b.bookIds : [], k: 8 });
      const notes = relatedNotes(instruction, 4);
      const sources = hits.map((h, i) => ({ n: i + 1, book_title: h.book_title, author: h.author, page: h.page_start, quote: h.text.slice(0, 600) }));
      const r = await ollama.chat('assistant', [
        { role: 'system', content: `${SAFETY}\nYou help the reader write. Follow the instruction. Where you use a source, cite it as [S#]; never invent quotations, page numbers or bibliographic details. Do not quote text that is not in a source. Reader's draft so far is provided for context.` },
        { role: 'user', content: `Instruction: ${instruction}\n\nDraft so far:\n${String(b.draft ?? '').slice(-3000)}\n\nSources:\n${sources.map((s) => `[S${s.n}] ${s.book_title}, p. ${s.page}\n<book_excerpt>\n${s.quote}\n</book_excerpt>`).join('\n\n')}\n\nReader's notes:\n${notes.map((n) => `- ${n.body.slice(0, 300)}`).join('\n')}` }], { temperature: 0.4 });
      const used = [...new Set([...r.text.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => sources[n - 1]);
      const refs = used.map((n) => `[S${n}] ${sources[n - 1].book_title}${sources[n - 1].author ? `, ${sources[n - 1].author}` : ''}, p. ${sources[n - 1].page}`);
      return { text: r.text, refs, sources, model: r.model };
    } catch (e) { return aiError(e); }
  });
}
