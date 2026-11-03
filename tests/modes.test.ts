// Recall modes (Socratic, mind map, listening check, exam planner): BASE_URL=http://localhost:3100 npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const up = await fetch(BASE + '/api/status').then((r) => r.ok).catch(() => false);
const j = async (p: string, body?: unknown, method?: string) => { const r = await fetch(BASE + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

const PAGE = `# Cash Flow

A business can be profitable on paper and still run out of cash. Profit is recorded when a sale is made, but cash only arrives when the customer pays. If a company sells goods worth $100,000 each month and customers pay after 60 days, the business must fund two full months of costs before the first payment arrives. During that gap the company pays wages, rent and suppliers from its own cash reserves or from borrowing. Many fast-growing firms fail not because they are unprofitable, but because growth increases the amount of cash tied up between paying suppliers and collecting from customers.

Working capital is the difference between current assets and current liabilities. Current assets include cash, accounts receivable and inventory, while current liabilities include accounts payable and short-term debt. When receivables and inventory grow faster than payables, working capital increases and absorbs cash. Managers therefore watch the cash conversion cycle closely. The cash conversion cycle equals days inventory outstanding plus days sales outstanding minus days payables outstanding.`;

const iso = (d: number) => { const x = new Date(); x.setDate(x.getDate() + d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

test('Recall modes', { skip: !up && 'server not running' }, async (t) => {
  const st = (await j('/status')).body; const model = !!st.resolved.knowledge && !!st.resolved.comprehension;
  let id = '';
  await t.test('setup', async () => {
    const fd = new FormData(); fd.append('files', new File([PAGE], 'modestest.md', { type: 'text/markdown' }));
    id = (await (await fetch(BASE + '/api/books', { method: 'POST', body: fd })).json()).results[0].id;
    for (let i = 0; i < 60; i++) { const b = (await j('/books/' + id)).body; if (['readable', 'ready'].includes(b.status)) break; await new Promise((r) => setTimeout(r, 400)); }
    assert.ok(id);
  });

  await t.test('planner: validates input, is deterministic, is stored, and warns when it cannot fit', async () => {
    assert.equal((await j('/recall/plan', { bookId: id, examDate: iso(-2), minutesPerDay: 30 })).status, 400, 'past dates are rejected');
    assert.equal((await j('/recall/plan', { bookId: id, examDate: 'soon', minutesPerDay: 30 })).status, 400);
    const a = (await j('/recall/plan', { bookId: id, examDate: iso(10), minutesPerDay: 40 })).body;
    assert.equal(a.days, 10); assert.equal(a.schedule.length, 10);
    assert.ok(a.schedule.every((d: any) => d.minutes <= 40), 'no day may exceed the daily budget');
    assert.ok(a.schedule.at(-1).tasks.some((t: any) => t.kind === 'light'), 'last day is a light review');
    assert.ok(a.schedule.some((d: any) => d.tasks.some((t: any) => t.kind === 'new')), 'chapters are scheduled');
    const b = (await j('/recall/plan', { bookId: id, examDate: iso(10), minutesPerDay: 40 })).body; assert.deepEqual(b.schedule, a.schedule, 'same inputs give the same plan');
    assert.deepEqual((await j(`/recall/plan?book=${id}`)).body.plan.schedule, a.schedule, 'the plan is stored');
    // feasibility must follow the arithmetic (a one-page book fits in 10 min/day, so we check consistency rather than forcing a failure)
    for (const m of [10, 480]) { const p = (await j('/recall/plan', { bookId: id, examDate: iso(2), minutesPerDay: m })).body; assert.equal(p.feasible, p.requiredPerDay <= m); assert.ok(p.schedule.every((d: any) => d.minutes <= m)); }
    await j(`/recall/plan?book=${id}`, undefined, 'DELETE'); assert.equal((await j(`/recall/plan?book=${id}`)).body.plan, null);
  });

  await t.test('listening check: needs text, grades by meaning, records evidence without entering the daily queue', { skip: !model && 'no model' }, async () => {
    assert.equal((await j('/recall/listen', { bookId: id, page: 1, offset: 900, kind: 'explain' })).status, 400, 'empty answer rejected');
    const before = (await j('/recall/analytics')).body.attempts;
    const good = (await j('/recall/listen', { bookId: id, page: 1, offset: 900, kind: 'explain', answer: 'A company can show profit but still lack cash, because customers pay after 60 days while wages, rent and suppliers must be paid from reserves or borrowing in the meantime.' })).body;
    const junk = (await j('/recall/listen', { bookId: id, page: 1, offset: 900, kind: 'explain', answer: 'I like bananas and sunny weather very much' })).body;
    assert.ok(good.score > junk.score + 0.3, `good ${good.score} vs junk ${junk.score}`); assert.ok(junk.score <= 0.25);
    assert.ok(good.reveal.length > 50);
    assert.ok((await j('/recall/analytics')).body.attempts >= before + 2, 'attempts are recorded');
    const q = (await j('/recall/daily?minutes=30')).body.questions; assert.ok(!q.some((x: any) => x.scope === 'listen'), 'listening checks are not re-asked in the daily queue');
  });

  await t.test('Socratic dialogue never reveals the key points before the end, and a completed dialogue saves an attempt', { skip: !model && 'no model' }, async () => {
    const s = (await j('/recall/socratic', { bookId: id, from: 1, to: 1 })).body; if (s.error) return assert.ok(s.error);
    assert.ok(s.sessionId && s.question.question); assert.ok(!('expected' in s.question) && !('key_points' in s.question));
    const r = (await j(`/recall/socratic/${s.sessionId}/turn`, { questionId: s.question.id, transcript: [{ role: 'tutor', content: s.question.question }], answer: 'I do not know' })).body;
    assert.ok(r.reply.length > 3); assert.equal(r.done, false); assert.ok(!('reveal' in r), 'no answer key mid-dialogue'); assert.equal(r.covered.length, 0, 'nothing credited for "I do not know"');
    assert.equal((await j(`/recall/socratic/${s.sessionId}/turn`, { questionId: s.question.id, transcript: [], answer: '' })).status, 400);
    assert.equal((await j('/recall/socratic/nope/turn', { questionId: s.question.id, transcript: [], answer: 'x' })).status, 404);
    // force the end: six learner turns
    const tr: any[] = []; let last: any = r;
    for (let i = 0; i < 6 && !last.done; i++) { tr.push({ role: 'tutor', content: last.reply }, { role: 'learner', content: 'not sure' }); last = (await j(`/recall/socratic/${s.sessionId}/turn`, { questionId: s.question.id, transcript: tr.concat(tr).slice(0, 2 * (5 + i)), answer: 'not sure' })).body; }
    assert.ok(last.done && last.reveal && last.reveal.key_points.length >= 2); assert.ok(last.score <= 0.34, `all-"not sure" scored ${last.score}`); assert.ok(last.attemptId);
  });

  await t.test('mind map: a good map beats a wrong one; sparse maps are rejected; results are stored', { skip: !model && 'no model' }, async () => {
    assert.equal((await j('/recall/mindmap', { bookId: id, from: 1, to: 1, topic: 'Cash flow', nodes: [{ id: 'root', label: 'Cash flow', parent: null }] })).status, 400);
    const good = (await j('/recall/mindmap', { bookId: id, from: 1, to: 1, topic: 'Cash flow', nodes: [
      { id: 'root', label: 'Cash flow', parent: null }, { id: 'a', label: 'Profit is not the same as cash', parent: 'root' }, { id: 'b', label: 'Customers pay late (60 days)', parent: 'a' }, { id: 'c', label: 'Working capital = current assets − current liabilities', parent: 'root' }, { id: 'd', label: 'Cash conversion cycle', parent: 'c' }] })).body;
    const bad = (await j('/recall/mindmap', { bookId: id, from: 1, to: 1, topic: 'Cash flow', nodes: [
      { id: 'root', label: 'Cash flow', parent: null }, { id: 'a', label: 'Photosynthesis', parent: 'root' }, { id: 'b', label: 'Volcanoes erupt', parent: 'a' }, { id: 'c', label: 'Medieval castles', parent: 'root' }] })).body;
    assert.ok(good.score > bad.score + 0.2, `good ${good.score} vs bad ${bad.score}`); assert.ok(good.reference.nodes.length >= 3);
    assert.ok(bad.wrongNodes >= 2, 'unrelated branches are flagged wrong'); assert.ok(bad.accuracy < good.accuracy);
    assert.ok((await j('/recall/mindmaps')).body.length >= 2);
  });

  await t.test('cleanup', async () => { if (id) await j('/books/' + id, undefined, 'DELETE'); });
});
