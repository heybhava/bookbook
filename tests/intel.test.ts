// Tests for the personal-intelligence features. Run against a live server: BASE_URL=http://localhost:3100 npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const up = await fetch(BASE + '/api/status').then((r) => r.ok).catch(() => false);
const j = async (p: string, init?: RequestInit) => {
  const r = await fetch(BASE + '/api' + p, init);
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, body: ct.includes('json') ? await r.json().catch(() => null) : await r.text() } as { status: number; body: any };
};
const send = (p: string, body: unknown, method = 'POST') => j(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const SENT = 'Serendipitous discoveries often reward the perspicacious reader who notices ephemeral details.';
const MD = `# Chapter One\n\nIntroductory paragraph about reading.\n\n## The Method\n\n${SENT} A second sentence follows here for context.\n\n# Chapter Two\n\nCash flow is not profit.`;

test('Personal intelligence', { skip: !up && 'server not running' }, async (t) => {
  let id = ''; let noteId = '';
  await t.test('setup: upload and wait for processing', async () => {
    const fd = new FormData(); fd.append('files', new File([MD], 'intel.md', { type: 'text/markdown' }));
    id = (await j('/books', { method: 'POST', body: fd })).body.results[0].id;
    for (let i = 0; i < 60; i++) { const b = (await j('/books/' + id)).body; if (['readable', 'ready'].includes(b.status)) break; await new Promise((r) => setTimeout(r, 500)); }
    assert.ok(id);
  });

  await t.test('selecting a sentence creates a note with full source metadata and the exact text', async () => {
    const pageRow = (await j(`/books/${id}/pages?from=1&to=3`)).body;
    const pg = pageRow.find((p: any) => p.text.includes(SENT));
    assert.ok(pg, 'page containing sentence');
    const start = pg.text.indexOf(SENT);
    const r = await send(`/books/${id}/captures`, { page: pg.page, text: SENT, start, end: start + SENT.length });
    assert.equal(r.status, 200); assert.equal(r.body.created, true);
    noteId = r.body.id;
    const n = (await j('/notes')).body.find((x: any) => x.id === noteId);
    assert.equal(n.body, SENT);                         // the selection itself, no invented AI text
    assert.equal(n.page, pg.page);
    assert.equal(n.kind, 'selection');
    assert.equal(n.start_offset, start); assert.equal(n.end_offset, start + SENT.length);
    assert.match(n.chapter_title, /Chapter One|The Method/);
    assert.equal(n.section, 'The Method');              // nearest heading
    assert.ok(n.context.includes('A second sentence'));   // surrounding passage
  });

  await t.test('repeated selection of the same passage does not duplicate', async () => {
    const pg = (await j(`/books/${id}/pages?from=1&to=3`)).body.find((p: any) => p.text.includes(SENT));
    const again = await send(`/books/${id}/captures`, { page: pg.page, text: '  ' + SENT.toUpperCase() + ' ', start: 0, end: 0 });
    assert.equal(again.body.created, false); assert.equal(again.body.id, noteId);
    const count = (await j('/notes')).body.filter((x: any) => x.book_id === id && x.kind === 'selection').length;
    assert.equal(count, 1);
  });

  await t.test('bad offsets are corrected against the real page text; invalid pages rejected', async () => {
    const pg = (await j(`/books/${id}/pages?from=1&to=3`)).body.find((p: any) => p.text.includes('Cash flow is not profit'));
    const r = await send(`/books/${id}/captures`, { page: pg.page, text: 'Cash flow is not profit.', start: 3, end: 9 });
    const n = (await j('/notes')).body.find((x: any) => x.id === r.body.id);
    assert.equal(pg.text.slice(n.start_offset, n.end_offset), 'Cash flow is not profit.');
    assert.equal((await send(`/books/${id}/captures`, { page: 999, text: 'x y z' })).status, 400);
  });

  await t.test('vocabulary discovery finds rare words, not common ones; save appears in vocabulary', async () => {
    const pg = (await j(`/books/${id}/pages?from=1&to=3`)).body.find((p: any) => p.text.includes(SENT));
    const d = (await j(`/books/${id}/vocab-discovery?page=${pg.page}`)).body;
    const words = d.map((w: any) => w.word);
    assert.ok(words.includes('serendipitous') || words.includes('perspicacious') || words.includes('ephemeral'), `got ${words}`);
    assert.ok(!words.includes('reader') && !words.includes('details'));
    const w = d.find((x: any) => x.word === 'perspicacious') ?? d[0];
    assert.ok(w.definition && typeof w.start === 'number');
    assert.equal(pg.text.slice(w.start, w.end).toLowerCase(), w.word);
    const r = await send('/vocab/bulk', { flashcards: true, words: [{ word: w.word, sentence: SENT, book_id: id, page: pg.page }] });
    assert.equal(r.body.saved, 1); assert.equal(r.body.cards, 1);
    const again = (await j(`/books/${id}/vocab-discovery?page=${pg.page}`)).body.map((x: any) => x.word);
    assert.ok(!again.includes(w.word), 'saved words are no longer suggested');
    assert.ok((await j('/vocab')).body.some((v: any) => v.word === w.word && v.book_id === id));
    await send('/vocab/ignore', { word: 'serendipitous' });
    assert.ok(!(await j(`/books/${id}/vocab-discovery?page=${pg.page}`)).body.some((x: any) => x.word === 'serendipitous'));
  });

  await t.test('selection analysis returns difficult words with IPA', async () => {
    const r = (await send('/vocab/analyze', { text: SENT })).body;
    assert.ok(r.length >= 1 && r.some((x: any) => x.ipa));
  });

  await t.test('inbox unifies notes, highlights and vocabulary with sources; filters and search work', async () => {
    await send(`/books/${id}/highlights`, { page: 1, text: 'reading', color: 'blue' });
    const all = (await j('/inbox')).body;
    const types = new Set(all.items.map((i: any) => i.type));
    assert.ok(types.has('selection') && types.has('highlight') && types.has('vocab'));
    const sel = all.items.find((i: any) => i.id === noteId);
    assert.equal(sel.book_title, 'intel'); assert.ok(sel.page);
    assert.equal((await j('/inbox?type=highlight')).body.items.every((i: any) => i.type === 'highlight'), true);
    assert.ok((await j('/inbox?q=perspicacious')).body.items.some((i: any) => i.id === noteId));
    assert.equal((await j('/inbox?q=zzzznomatch')).body.items.length, 0);
  });

  await t.test('edit, tag and link notes; convert to question/concept/flashcard', async () => {
    await send(`/notes/${noteId}`, { tags: 'method,reading', body: SENT + ' (my thought)' }, 'PATCH');
    assert.ok((await j('/inbox?tag=method')).body.items.some((i: any) => i.id === noteId));
    const other = (await send('/notes', { body: 'second', kind: 'note' })).body.id;
    assert.equal((await send(`/notes/${noteId}/link`, { to: other })).status, 200);
    assert.equal((await j(`/notes/${noteId}/links`)).body.length, 1);
    assert.equal((await send('/inbox/convert', { key: `note:${other}`, to: 'question' })).status, 200);
    assert.equal((await j('/inbox?type=question')).body.items.length >= 1, true);
    const c = await send('/inbox/convert', { key: `note:${noteId}`, to: 'flashcard' });
    assert.equal(c.status, 200); assert.ok(['ai', 'cloze'].includes(c.body.how));
    await send('/goals', { title: 'intel goal' });
    assert.equal((await send('/inbox/convert', { key: `note:${noteId}`, to: 'concept' })).status, 200);
  });

  await t.test('concept mastery changes only from tested interactions', async () => {
    const mine = (await j('/mastery')).body.filter((c: any) => c.name.startsWith('Serendipitous'));
    assert.equal(mine.length, 1);
    assert.ok(mine[0].score === 0 && mine[0].attempts === 0, 'untested concepts start at zero');
    const cid = mine[0].id;
    await send('/mastery/record', { results: [{ conceptId: cid, correct: true }] });
    const a = (await j('/mastery')).body.find((c: any) => c.id === cid);
    assert.equal(a.attempts, 1); assert.ok(a.score > 0 && a.score < 100);
    await send('/mastery/record', { results: [{ conceptId: cid, correct: false }] });
    assert.ok((await j('/mastery')).body.find((c: any) => c.id === cid).score < a.score);
    assert.equal((await send('/ai/teach-back', { conceptId: cid, explanation: 'short' })).status, 400);
  });

  await t.test('universal search spans books, notes, vocabulary and passages', async () => {
    const r = (await j('/search?q=perspicacious')).body;
    assert.ok(r.notes.length >= 1); assert.ok(r.passages.length >= 1); assert.equal(r.passages[0].book_title, 'intel');
  });

  await t.test('cross-book Q&A returns real sources (or fails honestly without a model)', async () => {
    const st = (await j('/status')).body;
    const r = await fetch(BASE + '/api/ai/library-ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'What is said about perspicacious readers?', mode: 'answer' }) });
    if (!st.resolved.comprehension) return assert.equal(r.status, 503);
    assert.equal(r.status, 200);
    const text = await r.text();
    const meta = JSON.parse(text.split('\n')[0]);
    assert.equal(meta.type, 'meta');
    assert.ok(meta.sources.some((s: any) => s.book_title === 'intel' && s.page_start >= 1));
    assert.ok(meta.limitations.length >= 2 && ['low', 'moderate', 'moderate-high', 'none'].includes(meta.confidence));
    const done = text.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.type === 'done');
    assert.ok(done && done.invalid.length === 0 || done.invalid.every((n: number) => !meta.sources.some((s: any) => s.n === n)));
  });

  await t.test('export (json/csv/md/html) and import round-trip', async () => {
    const js = (await j('/export/data?format=json&what=all')).body;
    assert.ok(js.notes.some((n: any) => n.body.includes('perspicacious')) && js.vocabulary.length >= 1);
    const csv = (await j('/export/data?format=csv&what=notes')).body as string;
    assert.match(csv.split('\n')[0], /body/); assert.ok(csv.includes('perspicacious'));
    assert.match((await j('/export/data?format=html&what=all')).body as string, /<blockquote>/);
    assert.match((await j('/export/data?format=md&what=all')).body as string, /Notes & captured passages/);
    const imp = await send('/import', { format: 'markdown', title: 'imported-test', text: 'Para one.\n\nPara two.' });
    assert.equal(imp.body.notes, 2);
    assert.equal((await send('/import', { format: 'yaml' })).status, 500);
  });

  await t.test('learning report and drafts', async () => {
    const r = (await j('/report?period=week')).body;
    assert.ok(r.captured.passages >= 1 && r.vocabulary.saved >= 1);
    const d = (await send('/drafts', { title: 'T', body: 'hello' })).body.id;
    await send(`/drafts/${d}`, { body: 'hello world' }, 'PATCH');
    assert.equal((await j(`/drafts/${d}`)).body.body, 'hello world');
    await j(`/drafts/${d}`, { method: 'DELETE' });
  });

  await t.test('existing features still work: original notes API, highlights, progress', async () => {
    const n = (await send('/notes', { book_id: id, page: 1, body: 'legacy-style note' })).body.id;
    assert.ok((await j(`/books/${id}/annotations`)).body.notes.some((x: any) => x.id === n));
  });

  await t.test('cleanup', async () => {
    for (const c of (await j('/mastery')).body.filter((x: any) => x.name.startsWith('Serendipitous'))) await j('/concepts/' + c.id, { method: 'DELETE' });
    for (const g of (await j('/goals')).body.filter((x: any) => x.title === 'intel goal')) await j('/goals/' + g.id, { method: 'DELETE' });
    for (const v of (await j('/vocab')).body.filter((x: any) => x.book_id === id)) await j('/vocab/' + v.id, { method: 'DELETE' });
    for (const n of (await j('/notes')).body.filter((x: any) => ['second', 'Para one.', 'Para two.'].includes(x.body) || x.book_id === id)) await j('/notes/' + n.id, { method: 'DELETE' });
    for (const c of (await j('/cards')).body.filter((x: any) => x.book_id === id)) await j('/cards/' + c.id, { method: 'DELETE' });
    assert.equal((await j('/books/' + id, { method: 'DELETE' })).status, 200);
  });
});
