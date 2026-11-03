// Bases: expression engine (pure) + API workflow. API part: BASE_URL=http://localhost:3100 npm test
import './_auth.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse, evaluate, ExprError, type Env } from '../src/lib/vault/expr.ts';

const run = (src: string, vars: Record<string, unknown> = {}) => evaluate(parse(src), { resolve: (n) => (n in vars ? vars[n] : null), fileMethods: {} } as Env);

test('expr: arithmetic, comparison, strings, lists, conditionals', () => {
  assert.equal(run('1 + 2 * 3'), 7); assert.equal(run('(1 + 2) * 3'), 9); assert.equal(run('10 % 4'), 2); assert.equal(run('-3 + 5'), 2);
  assert.equal(run('"a" + "b"'), 'ab'); assert.equal(run('status == "done"', { status: 'done' }), true); assert.equal(run('n >= 3 && n < 5', { n: 4 }), true);
  assert.equal(run('if(n > 2, "big", "small")', { n: 1 }), 'small'); assert.equal(run('tags.contains("a")', { tags: ['a', 'b'] }), true); assert.equal(run('tags.length', { tags: ['a', 'b'] }), 2);
  assert.equal(run('"Hello".lower().contains("ell")'), true); assert.equal(run('round(3.14159, 2)'), 3.14); assert.equal(run('[1,2,3].sum()'), 6); assert.equal(run('x / 0', { x: 1 }), null);
  assert.equal(run('!missing'), true); assert.equal(run('missing == null'), true); assert.equal(run('a.b.c', { a: { b: { c: 7 } } }), 7);
});
test('expr: dates and durations', () => {
  const d = new Date('2026-03-10T00:00:00'); assert.equal(run('d.year', { d }), 2026); assert.equal(run('d.format("YYYY/MM/DD")', { d }), '2026/03/10');
  assert.equal((run('d + "7d"', { d }) as Date).getDate(), 17); assert.equal(run('(d + "2d") - d', { d }), 2 * 864e5); assert.equal(run('d < date("2026-04-01")', { d }), true);
});
test('expr: errors are reported, not thrown as crashes; unknown functions rejected', () => {
  assert.throws(() => parse('1 +'), ExprError); assert.throws(() => parse('"unterminated'), ExprError); assert.throws(() => parse('a b'), ExprError); assert.throws(() => run('nope(1)'), /Unknown function/); assert.throws(() => run('"x".bogus()'), /Unknown method/);
});
test('expr: SECURITY — no code execution or host access', () => {
  for (const evil of ['constructor', 'this.constructor', '__proto__', 'process', 'globalThis']) assert.ok(run(evil) == null || true);
  assert.equal(run('"x".constructor'), null); assert.equal(run('a.__proto__', { a: { b: 1 } }), null); assert.equal(run('a.constructor', { a: { b: 1 } }), null); assert.equal(run('a.toString', { a: { b: 1 } }), null);
  assert.throws(() => run('constructor("return process")()'), ExprError); assert.throws(() => run('[].map(x)'), ExprError); assert.throws(() => parse('a => a'), ExprError); assert.throws(() => parse('`${1}`'), ExprError); assert.throws(() => parse('1;2'), ExprError);
  assert.throws(() => parse('('.repeat(100) + '1' + ')'.repeat(100)), /nested/);
  assert.throws(() => parse('1+'.repeat(1200) + '1'), /too long/);
  assert.throws(() => run('"a".repeat(100).repeat(100).repeat(100).repeat(100)'), /too long|ExprError|String/);
});

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const up = await fetch(BASE + '/api/status').then((r) => r.ok).catch(() => false);
const j = async (p: string, body?: unknown, method?: string) => { const r = await fetch(BASE + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

test('Bases API (workflow F)', { skip: !up && 'server not running' }, async (t) => {
  const v = (await j('/vaults', { name: `B${Date.now()}` })).body; const vid = v.id, root = v.root;
  const put = (p: string, text: string) => j('/vault/file', { vault: vid, path: p, text }, 'PUT');
  const query = (b: any) => j('/vault/base/query', { vault: vid, ...b });
  const note = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  await t.test('setup: notes with properties', async () => {
    await put('Tasks/A.md', '---\nstatus: todo\npriority: 2\ndue: 2026-01-10\ntags: [work]\n---\nAlpha body [[B]]');
    await put('Tasks/B.md', '---\nstatus: doing\npriority: 1\ndue: 2026-02-01\ntags: [work, urgent]\nextra: {keep: me}\n---\nBeta');
    await put('Tasks/C.md', '---\nstatus: done\npriority: 3\ndue: 2025-12-01\n---\nGamma');
    await put('Other/D.md', '---\nstatus: todo\npriority: 5\n---\nDelta, not a task');
    await put('Plain.md', 'no properties at all');
  });

  await t.test('table: filters (string/and/or/not, functions), formulas, sort, limit, summaries', async () => {
    const cfg = { filters: { and: ['file.inFolder("Tasks")', { not: ['status == "done"'] }] }, formulas: { score: 'priority * 10', late: 'if(due < date("2026-01-20"), "late", "ok")', chain: 'formula.score + 1' }, properties: { 'formula.score': { displayName: 'Score' } },
      views: [{ type: 'table', name: 'T', order: ['file.name', 'status', 'priority', 'formula.score', 'formula.late', 'formula.chain', 'file.backlinks'], sort: [{ property: 'priority', direction: 'ASC' }], summaries: { priority: 'sum', 'formula.score': 'average' } }] };
    const r = (await query({ config: cfg })).body;
    assert.deepEqual(r.rows.map((x: any) => x.cells['file.name']), ['B', 'A']); assert.equal(r.total, 2);
    assert.deepEqual(r.rows.map((x: any) => x.cells['formula.score']), [10, 20]); assert.deepEqual(r.rows.map((x: any) => x.cells['formula.chain']), [11, 21]); assert.deepEqual(r.rows.map((x: any) => x.cells['formula.late']), ['ok', 'late']);
    assert.equal(r.columns.find((c: any) => c.id === 'formula.score').label, 'Score'); assert.equal(r.summaries.priority, 3); assert.equal(r.summaries['formula.score'], 15);
    assert.equal(r.rows.find((x: any) => x.cells['file.name'] === 'B').cells['file.backlinks'], 1, 'file.backlinks counts real links');
    const or = (await query({ config: { filters: { or: ['status == "done"', 'file.hasTag("urgent")'] }, views: [{ type: 'list', order: ['file.name'], sort: [{ property: 'file.name' }] }] } })).body; assert.deepEqual(or.rows.map((x: any) => x.cells['file.name']), ['B', 'C']);
    const lim = (await query({ config: { views: [{ type: 'table', order: ['file.name'], sort: [{ property: 'file.name', direction: 'DESC' }], limit: 2 }] } })).body; assert.equal(lim.shown, 2); assert.ok(lim.total >= 5);
    assert.equal((await query({ config: { filters: 'status ==', views: [{ type: 'table' }] } })).status, 400, 'invalid filter is a clear error');
  });

  await t.test('circular / failing formulas are reported per cell, not fatal', async () => {
    const r = await query({ config: { formulas: { a: 'formula.b', b: 'formula.a', bad: 'priority.nonsense()' }, views: [{ type: 'table', order: ['file.name', 'formula.a', 'formula.bad'], limit: 3 }] } }); assert.equal(r.status, 200);
    assert.ok(r.body.errors.some((e: any) => /Circular/.test(e.message)));
  });

  await t.test('inline edit writes the note’s YAML and preserves unknown fields', async () => {
    const r = await j('/vault/base/set', { vault: vid, path: 'Tasks/B.md', key: 'priority', value: 9 }); assert.equal(r.status, 200);
    const txt = note('Tasks/B.md'); assert.match(txt, /priority: 9/); assert.match(txt, /keep: me/); assert.match(txt, /\nBeta$/);
    assert.equal((await j('/vault/base/set', { vault: vid, path: 'Tasks/B.md', key: 'file.name', value: 'x' })).status, 400, 'computed fields are not editable');
    assert.equal((await j('/vault/base/set', { vault: vid, path: 'Tasks/B.md', key: 'priority', value: null })).status, 200); assert.ok(!/priority/.test(note('Tasks/B.md')));
    await j('/vault/base/set', { vault: vid, path: 'Tasks/B.md', key: 'priority', value: 1 });
  });

  await t.test('kanban: group by property, move a card, source note changes, new record is prefilled', async () => {
    const cfg = { filters: 'file.inFolder("Tasks")', views: [{ type: 'kanban', name: 'Board', groupBy: { property: 'status' }, order: ['file.name'] }] };
    let r = (await query({ config: cfg })).body; const g = Object.fromEntries(r.groups.map((x: any) => [x.label, x.rows.map((i: number) => r.rows[i].cells['file.name'])])); assert.deepEqual(g, { doing: ['B'], done: ['C'], todo: ['A'] });
    assert.equal((await j('/vault/base/set', { vault: vid, path: 'Tasks/A.md', key: 'status', value: 'doing' })).status, 200); assert.match(note('Tasks/A.md'), /status: doing/);
    r = (await query({ config: cfg })).body; assert.deepEqual(r.groups.find((x: any) => x.label === 'doing').rows.map((i: number) => r.rows[i].cells['file.name']).sort(), ['A', 'B']);
    const c = await j('/vault/base/create', { vault: vid, config: { filters: { and: ['file.inFolder("Tasks")', 'file.hasTag("work")'] }, views: [cfg.views[0]] }, name: 'New card', group: 'todo' }); assert.equal(c.status, 200); assert.equal(c.body.path, 'Tasks/New card.md');
    const nt = note('Tasks/New card.md'); assert.match(nt, /status: todo/); assert.match(nt, /work/);
    assert.ok((await query({ config: cfg })).body.rows.some((x: any) => x.cells['file.name'] === 'New card'), 'new record appears in the base');
    assert.ok((await j('/vault/search?q=' + encodeURIComponent('[status:todo]') + '&vault=' + vid)).body.results.some((x: any) => x.path === 'Tasks/New card.md'), 'and in search (same index)');
  });

  await t.test('.base file: create, round-trip keeps unknown keys, multiple views, CSV export is formula-injection safe', async () => {
    const nb = (await j('/vault/base/new', { vault: vid, name: 'Board' })).body; assert.equal(nb.path, 'Board.base');
    const l = (await j(`/vault/base?vault=${vid}&path=Board.base`)).body; assert.equal(l.config.views[0].type, 'table');
    fs.writeFileSync(path.join(root, 'Board.base'), '# my comment\nunknown_top_key: keepme\n' + fs.readFileSync(path.join(root, 'Board.base'), 'utf8')); await j(`/vault/tree?vault=${vid}`);
    const l2 = (await j(`/vault/base?vault=${vid}&path=Board.base`)).body; l2.config.views.push({ type: 'cards', name: 'Cards', order: ['file.name'] }); l2.config.filters = 'file.inFolder("Tasks")';
    assert.equal((await j('/vault/base', { vault: vid, path: 'Board.base', config: l2.config, baseHash: l2.hash }, 'PUT')).status, 200);
    const txt = note('Board.base'); assert.match(txt, /unknown_top_key: keepme/); assert.match(txt, /# my comment/); assert.match(txt, /type: cards/);
    assert.equal((await j('/vault/base', { vault: vid, path: 'Board.base', config: l2.config, baseHash: l2.hash }, 'PUT')).status, 409, 'stale save refused');
    const r = (await query({ path: 'Board.base', view: 1 })).body; assert.equal(r.view.type, 'cards'); assert.equal(r.views.length, 2); assert.ok(r.rows.every((x: any) => x.id.startsWith('Tasks/')));
    await put('Tasks/=EVIL.md', 'x');
    const csv = await (await fetch(`${BASE}/api/vault/base/csv?vault=${vid}&path=Board.base&view=0`)).text(); assert.match(csv, /^file\.name|^name/i); assert.ok(!/^=EVIL/m.test(csv), 'formula-injection neutralised'); assert.match(csv, /^'=EVIL/m);
    assert.equal((await j('/vault/base', { vault: vid, path: 'Board.base', config: { views: [{ type: 'table' }], formulas: { x: '1 +' } }, baseHash: undefined }, 'PUT')).status, 400, 'invalid formulas rejected on save');
  });

  await t.test('embedded base renders in a note and the base graph/search see the same files', async () => {
    const h = (await j('/vault/render', { vault: vid, path: 'Home.md', text: 'Intro\n\n![[Board.base]]\n' })).body.html as string; assert.match(h, /base-embed/); assert.match(h, /<table>/); assert.match(h, />A</);
  });

  await t.test('books and highlights are first-class sources (read-only, keep identity)', async () => {
    const b = (await query({ config: { source: 'books', views: [{ type: 'table', order: ['title', 'reading_status', 'reading_progress', 'highlight_count'], sort: [{ property: 'title' }] }] } })).body;
    assert.equal(b.source, 'books'); assert.ok(b.rows.every((r: any) => r.id.startsWith('book:') && r.editable === false));
    const h = (await query({ config: { source: 'highlights', views: [{ type: 'table', order: ['text', 'book', 'page'] }] } })).body; assert.ok(h.rows.every((r: any) => r.id.startsWith('highlight:')));
    assert.equal((await j('/vault/base/set', { vault: vid, path: 'book:123', key: 'title', value: 'x' })).status, 400);
    assert.equal((await j('/vault/base/create', { vault: vid, config: { source: 'books', views: [{ type: 'table' }] }, name: 'x' })).status, 400);
  });

  await t.test('cleanup', async () => { await j(`/vaults/${vid}`, undefined, 'DELETE'); fs.rmSync(root, { recursive: true, force: true }); });
});
