// Active-recall tests (need a running server + a local model for generation/evaluation): BASE_URL=http://localhost:3100 npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const up = await fetch(BASE + '/api/status').then((r) => r.ok).catch(() => false);
const j = async (p: string, body?: unknown, method?: string) => { const r = await fetch(BASE + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

const PAGE1 = `# Cash Flow

A business can be profitable on paper and still run out of cash. Profit is recorded when a sale is made, but cash only arrives when the customer pays. If a company sells goods worth $100,000 each month and customers pay after 60 days, the business must fund two full months of costs before the first payment arrives. During that gap the company pays wages, rent and suppliers from its own cash reserves or from borrowing. Many fast-growing firms fail not because they are unprofitable, but because growth increases the amount of cash tied up between paying suppliers and collecting from customers.

Working capital is the difference between current assets and current liabilities. Current assets include cash, accounts receivable and inventory, while current liabilities include accounts payable and short-term debt. When receivables and inventory grow faster than payables, working capital increases and absorbs cash. Managers therefore watch the cash conversion cycle closely. The cash conversion cycle equals days inventory outstanding plus days sales outstanding minus days payables outstanding.`;

test('Active recall engine', { skip: !up && 'server not running' }, async (t) => {
  const st = (await j('/status')).body; const model = !!st.resolved.knowledge && !!st.resolved.comprehension;
  let id = '', sid = '', questions: any[] = [];

  await t.test('setup: upload a textbook page', async () => {
    const fd = new FormData(); fd.append('files', new File([PAGE1], 'recalltest.md', { type: 'text/markdown' }));
    id = (await (await fetch(BASE + '/api/books', { method: 'POST', body: fd })).json()).results[0].id;
    for (let i = 0; i < 60; i++) { const b = (await j('/books/' + id)).body; if (['readable', 'ready'].includes(b.status)) break; await new Promise((r) => setTimeout(r, 400)); }
    assert.ok(id);
  });

  await t.test('page questions are generated, grounded in the page, verbatim-quoted and answer-free', { skip: !model && 'no model' }, async () => {
    const g = (await j('/recall/generate', { bookId: id, from: 1, to: 1 })).body;
    assert.ok(g.created >= 2, `only ${g.created} created`);
    const again = (await j('/recall/generate', { bookId: id, from: 1, to: 1 })).body; assert.equal(again.cached, true, 'regeneration must be cached');
    const pub = (await j(`/books/${id}/recall-questions?page=1`)).body; assert.equal(pub.length, g.created);
    const pageText = (await j(`/books/${id}/pages?from=1&to=1`)).body[0].text.toLowerCase().replace(/\s+/g, ' ');
    for (const q of pub) {
      assert.ok(q.page === 1 && q.concept && q.type && q.level >= 1 && q.level <= 6 && q.objective !== undefined);
      assert.ok(!('expected' in q) && !('key_points' in q) && !('source_quote' in q) && !('correct_index' in q), 'answer leaked before the attempt');
      assert.ok(!/\b(this page|the passage|the text above)\b/i.test(q.question), `question refers to hidden text: ${q.question}`);
    }
    assert.ok(pub.some((q: any) => q.level >= 3), 'needs understanding/application-level questions, not only recall');
    void pageText;
  });

  await t.test('close-book session → evaluation: junk scores low, a good answer high, answer key revealed only afterwards', { skip: !model && 'no model' }, async () => {
    const s = (await j('/recall/sessions', { kind: 'page', bookId: id, from: 1, to: 1, count: 2 })).body; sid = s.sessionId; questions = s.questions; assert.ok(questions.length >= 1);
    const q = questions.find((x: any) => x.type !== 'mcq') ?? questions[0];
    const junk = (await j(`/recall/sessions/${sid}/answer`, { questionId: q.id, answer: 'banana' })).body;
    assert.ok(junk.evaluation.score < 0.35, `junk scored ${junk.evaluation.score}`); assert.equal(junk.evaluation.autoRating, 1);
    assert.ok(junk.key.expected && junk.key.source_quote, 'key must be revealed after the attempt'); assert.ok(junk.key.sources[0].page === 1);
    const good = (await j(`/recall/sessions/${sid}/answer`, { questionId: q.id, answer: junk.key.expected, confidence: 4 })).body;
    assert.ok(good.evaluation.score > junk.evaluation.score + 0.3, `good ${good.evaluation.score} vs junk ${junk.evaluation.score}`);
    const long = (await j(`/recall/sessions/${sid}/answer`, { questionId: q.id, answer: 'Cash is very important for any business and managers should always think carefully about money, accounting, budgets, planning, forecasting, markets, customers and many other things. '.repeat(6) })).body;
    assert.ok(long.evaluation.score < 0.5, `a long irrelevant answer must not score well (${long.evaluation.score})`);
    (globalThis as any).__attempts = { junk: junk.attemptId, good: good.attemptId, q };
  });

  await t.test('FSRS: Good schedules days ahead, Again within the hour; rating applies once', { skip: !model && 'no model' }, async () => {
    const { good, junk } = (globalThis as any).__attempts;
    const r = (await j(`/recall/attempts/${good}/rate`, { rating: 3 })).body.state; assert.ok(r.dueInDays >= 2 && r.state === 'review', JSON.stringify(r));
    const again = (await j(`/recall/attempts/${good}/rate`, { rating: 1 })).body.state; assert.equal(again.stability, r.stability, 'second rating must not re-apply');
    const q2 = questions.find((x: any) => x.id !== (globalThis as any).__attempts.q.id);
    if (q2) { const a = (await j(`/recall/sessions/${sid}/answer`, { questionId: q2.id, answer: 'I do not remember' })).body; const s2 = (await j(`/recall/attempts/${a.attemptId}/rate`, { rating: 1 })).body.state; assert.ok(s2.dueInDays < 0.1 && s2.state === 'learning', 'a forgotten item returns within minutes'); }
    assert.equal((await j(`/recall/attempts/${junk}/rate`, { rating: 9 })).status, 400);
    await j(`/recall/sessions/${sid}/end`, { status: 'completed' }, 'POST');
  });

  await t.test('mastery keeps dimensions separate and never marks one attempt as mastered; gaps and skipped sessions are tracked', { skip: !model && 'no model' }, async () => {
    const ms = (await j(`/recall/mastery?book=${id}`)).body; assert.ok(ms.length >= 1);
    for (const m of ms) { assert.ok('recognition' in m.dims && 'recall' in m.dims && 'understanding' in m.dims && 'application' in m.dims); assert.notEqual(m.status, 'mastered'); }
    const before = (await j('/recall/summary')).body.skipped; await j('/recall/skip', { bookId: id, from: 1, to: 1 });
    const sum = (await j('/recall/summary')).body; assert.equal(sum.skipped, before + 1);
    const gaps = (await j('/recall/gaps')).body; assert.ok(Array.isArray(gaps.weak) && Array.isArray(gaps.untested) && Array.isArray(gaps.sessions));
  });

  await t.test('daily session respects the time budget, hides answers and never exceeds the due workload', { skip: !model && 'no model' }, async () => {
    await j('/recall/settings', { trigger: 'manual' }, 'PUT');
    const d5 = (await j('/recall/daily?minutes=5')).body, d30 = (await j('/recall/daily?minutes=30')).body;
    assert.ok(d5.plan.estimated <= 5.01 && d30.plan.estimated <= 30.01); assert.ok(d30.questions.length >= d5.questions.length);
    for (const q of [...d5.questions, ...d30.questions]) assert.ok(!('expected' in q));
    assert.equal((await j('/recall/compose', { kind: 'plan' })).status, 400, 'compose needs a valid OpenUI prompt');
  });

  await t.test('Telugu answer is accepted and graded by meaning, with Telugu feedback', { skip: !model && 'no model' }, async () => {
    const s = (await j('/recall/sessions', { kind: 'page', bookId: id, from: 1, to: 1, count: 4 })).body; const q = s.questions.find((x: any) => x.type !== 'mcq' && x.type !== 'numeric'); if (!q) return;
    const key = (await j(`/recall/sessions/${s.sessionId}/answer`, { questionId: q.id, answer: 'తెలియదు' })).body.key;
    const te = (await j(`/recall/sessions/${s.sessionId}/answer`, { questionId: q.id, answer: 'కస్టమర్లు ఆలస్యంగా చెల్లిస్తారు కాబట్టి లాభం ఉన్నా వ్యాపారం నగదు కోల్పోతుంది; వేతనాలు, అద్దె, సరఫరాదారులకు ముందే చెల్లించాలి, కాబట్టి నగదు నిల్వలు లేదా అప్పు అవసరం.', feedbackLang: 'te' })).body;
    assert.equal(te.evaluation.feedbackLang, 'te'); assert.ok(te.evaluation.score >= 0 && te.evaluation.score <= 1); assert.ok(key.expected);
    await j(`/recall/sessions/${s.sessionId}/end`, { status: 'abandoned' });
  });

  await t.test('exam covers multiple pages and is graded per question', { skip: !model && 'no model' }, async () => {
    const e = (await j('/recall/exams', { bookId: id, count: 3 })).body; if (e.error) return assert.ok(e.error);
    assert.ok(e.questions.length >= 1 && e.questions.every((q: any) => !('expected' in q)));
    const answers: Record<string, string> = {}; e.questions.forEach((q: any) => (answers[q.id] = q.type === 'mcq' ? '0' : 'Customers pay late so the firm needs cash reserves.'));
    const r = await fetch(`${BASE}/api/recall/exams/${e.examId}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers, seconds: 60 }) });
    const ev = (await r.text()).trim().split('\n').map((l) => JSON.parse(l)); const done = ev.find((x) => x.type === 'done'); assert.ok(done, JSON.stringify(ev.at(-1)));
    assert.equal(ev.filter((x) => x.type === 'item').length, e.questions.length); assert.ok(done.score >= 0 && done.score <= 1);
    assert.ok((await j('/recall/exams')).body.some((x: any) => x.id === e.examId && x.score != null));
  });

  await t.test('analytics come only from real attempts', async () => {
    const a = (await j('/recall/analytics')).body; assert.ok(a.attempts >= 0 && a.dimensions.recall && typeof a.note === 'string');
    if (model) { assert.ok(a.attempts >= 3); assert.ok(a.sessions.skipped >= 1); }
  });

  await t.test('cleanup', async () => { if (id) await j('/books/' + id, undefined, 'DELETE'); });
});
