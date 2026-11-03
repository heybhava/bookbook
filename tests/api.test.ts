// Integration tests against a running server:  npm run dev  (or npm start)  then  npm test
import './_auth.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const up = await fetch(BASE + '/api/status').then((r) => r.ok).catch(() => false);
const j = async (p: string, init?: RequestInit) => {
  const r = await fetch(BASE + '/api' + p, init);
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const send = (p: string, body: unknown, method = 'POST') => j(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('API integration', { skip: !up && 'server not running' }, async (t) => {
  let id = '';
  await t.test('upload markdown; unsupported types are rejected', async () => {
    const fd = new FormData();
    fd.append('files', new File(['# One\n\nThe serendipitous fox. ' + 'Filler sentence here. '.repeat(30) + '\n\n## Two\n\nSecond chapter text about ephemeral cash flow.'], 'itest.md', { type: 'text/markdown' }));
    fd.append('files', new File(['MZ'], 'bad.exe'));
    const r = await j('/books', { method: 'POST', body: fd });
    assert.equal(r.status, 201);
    id = r.body.results.find((x: any) => x.name === 'itest.md').id;
    assert.ok(id);
    assert.match(r.body.results.find((x: any) => x.name === 'bad.exe').error, /Unsupported/);
  });

  await t.test('background processing makes it readable; chapters extracted', async () => {
    let b: any;
    for (let i = 0; i < 60; i++) {
      b = (await j('/books/' + id)).body;
      if (['readable', 'ready', 'error'].includes(b.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(['readable', 'ready'].includes(b.status), b.status_detail);
    assert.equal(b.chapters.length, 2);
    assert.ok(b.page_count >= 2);
  });

  await t.test('in-book search returns page refs', async () => {
    const r = await j(`/books/${id}/search?q=serendipitous`);
    assert.ok(r.body.length >= 1);
    assert.equal(r.body[0].page, 1);
  });

  await t.test('progress persists and is clamped to the page count', async () => {
    await send(`/books/${id}/progress`, { page: 2, scroll: 0.4 }, 'PUT');
    const p = (await j('/books/' + id)).body.progress;
    assert.equal(p.page, 2);
    assert.equal(p.scroll, 0.4);
    await send(`/books/${id}/progress`, { page: 9999 }, 'PUT');
    const b = (await j('/books/' + id)).body;
    assert.equal(b.progress.page, b.page_count);
  });

  await t.test('highlights, bookmarks, notes CRUD', async () => {
    const h = await send(`/books/${id}/highlights`, { page: 1, text: 'serendipitous', color: 'green', start: 4, end: 17 });
    assert.ok(h.body.id);
    await send(`/books/${id}/bookmarks`, { page: 1, label: 'x' });
    await send('/notes', { book_id: id, page: 1, body: 'my note' });
    const a = (await j(`/books/${id}/annotations`)).body;
    assert.equal(a.highlights.length, 1);
    assert.equal(a.bookmarks.length, 1);
    assert.equal(a.notes.length, 1);
    await j('/highlights/' + h.body.id, { method: 'DELETE' });
    assert.equal((await j(`/books/${id}/annotations`)).body.highlights.length, 0);
  });

  await t.test('vocabulary save and spaced-repetition review', async () => {
    await send('/vocab', { word: 'itestword', definition: 'd', book_id: id, page: 1 });
    const v = (await j('/vocab')).body.find((x: any) => x.word === 'itestword');
    assert.ok(v);
    const r = await send(`/vocab/${v.id}/review`, { grade: 2 });
    assert.ok(r.body.next > Date.now());
    await j('/vocab/' + v.id, { method: 'DELETE' });
  });

  await t.test('goals and flashcard scheduling', async () => {
    const g = await send('/goals', { title: 'itest goal' });
    assert.ok(g.body.id);
    await send('/cards', { cards: [{ front: 'Q?', back: 'A', book_id: id, page: 1 }] });
    const c = (await j('/cards?due=1')).body.find((x: any) => x.front === 'Q?');
    assert.ok(c);
    await send(`/cards/${c.id}/review`, { grade: 3 });
    assert.equal((await j('/cards?due=1')).body.some((x: any) => x.id === c.id), false);
    await j('/cards/' + c.id, { method: 'DELETE' });
    await j('/goals/' + g.body.id, { method: 'DELETE' });
  });

  await t.test('AI fails honestly without a model; otherwise returns text', async () => {
    const st = (await j('/status')).body;
    const r = await send('/ai/summary', { bookId: id, kind: 'quick', from: 1, to: 1, force: true });
    if (!st.resolved.summary) {
      assert.equal(r.status, 503);
      assert.ok(r.body.error);
    } else {
      assert.equal(r.status, 200);
      assert.ok(r.body.text.length > 10);
    }
  });

  await t.test('security: cross-origin writes blocked; unknown book is 404', async () => {
    const r = await fetch(BASE + '/api/goals', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{"title":"x"}' });
    assert.equal(r.status, 403);
    assert.equal((await j('/books/does-not-exist')).status, 404);
  });

  await t.test('delete removes the book and its data', async () => {
    assert.equal((await j('/books/' + id, { method: 'DELETE' })).status, 200);
    assert.equal((await j('/books/' + id)).status, 404);
  });
});
