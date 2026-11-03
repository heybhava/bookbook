// Active recall endpoints: question generation, close-book sessions, evaluation, FSRS rating, mastery, gaps, daily plan, blurt, exams, OpenUI composition.
import { all, get, run, uid, LOCAL_USER } from './db';
import * as ollama from './ollama';
import { SAFETY } from './rag';
import { langName, detectLanguage } from './lang/registry';
import * as R from './recall/engine';
import * as M from './recall/modes';
// (the OpenUI component library is React code: the browser builds its prompt and sends it; the server supplies facts and calls the model)
import { createParser } from '@openuidev/lang-core';
import type { Kit } from './routes2';

const now = () => Date.now();
const rows = (ids: string[]) => ids.length ? all<any>(`SELECT q.*, b.title AS book_title FROM recall_questions q JOIN books b ON b.id = q.book_id WHERE q.user_id = ? AND q.id IN (${ids.map(() => '?').join(',')})`, LOCAL_USER, ...ids) : [];
const qrow = (id: string) => get<any>('SELECT q.*, b.title AS book_title FROM recall_questions q JOIN books b ON b.id = q.book_id WHERE q.id = ? AND q.user_id = ?', id, LOCAL_USER);

export function registerRecall({ on, J, bad, body, book, aiError }: Kit) {
  on('GET', '/recall/settings', () => R.settings());
  on('PUT', '/recall/settings', async ({ req }) => R.saveSettings(await body(req)));
  on('GET', '/recall/summary', () => ({ ...R.dueSummary(), settings: R.settings(), skipped: get<{ n: number }>("SELECT COUNT(*) n FROM recall_sessions WHERE user_id = ? AND status = 'skipped'", LOCAL_USER)?.n ?? 0, completed: get<{ n: number }>("SELECT COUNT(*) n FROM recall_sessions WHERE user_id = ? AND status = 'completed'", LOCAL_USER)?.n ?? 0 }));

  on('POST', '/recall/generate', async ({ req }) => {
    const b = await body(req); const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
    const from = Math.max(1, Number(b.from) || 1), to = Math.min(bk.page_count, Number(b.to) || from);
    try { return await R.generateForPages(b.bookId, from, to, { scope: b.scope, count: b.count, force: !!b.force, hardOnly: !!b.hardOnly }); } catch (e) { return aiError(e); }
  });
  on('GET', '/books/:id/recall-questions', ({ p, q }) => {
    if (!book(p.id)) return bad('Not found', 404);
    return all<any>(`SELECT q.*, b.title AS book_title FROM recall_questions q JOIN books b ON b.id = q.book_id WHERE q.book_id = ? AND q.user_id = ? AND q.status = 'active' ${q.get('page') ? 'AND q.page <= ? AND q.page_end >= ?' : ''} ORDER BY q.page, q.level`, p.id, LOCAL_USER, ...(q.get('page') ? [Number(q.get('page')), Number(q.get('page'))] : [])).map(R.publicQ);
  });

  // start a session: the client receives questions WITHOUT answers
  on('POST', '/recall/sessions', async ({ req }) => {
    const b = await body(req); const set = R.settings();
    let questions: any[] = []; let kind = String(b.kind ?? 'page');
    try {
      if (kind === 'daily') { const s = R.buildSession(Number(b.minutes) || set.dailyMinutes, b.bookId ?? null); const id = R.startSession('daily', b.bookId ?? null, { minutes: b.minutes }, s.questions.length); return { sessionId: id, questions: s.questions, plan: s.plan }; }
      if (kind === 'concepts') { const names: string[] = (b.concepts ?? []).map((x: string) => String(x).toLowerCase()); const ids = all<any>(`SELECT id FROM recall_questions WHERE user_id = ? AND status = 'active' AND lower(concept) IN (${names.map(() => '?').join(',') || "''"}) LIMIT 30`, LOCAL_USER, ...names).map((r) => r.id); questions = rows(ids); }
      else {
        const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
        const from = Math.max(1, Number(b.from) || 1), to = Math.min(bk.page_count, Number(b.to) || from);
        const scope = to > from ? (kind === 'chapter' ? 'chapter' : 'section') : 'page';
        if (!all('SELECT 1 FROM recall_questions WHERE user_id = ? AND book_id = ? AND status = \'active\' AND page = ? AND page_end = ? AND scope = ?', LOCAL_USER, b.bookId, from, to, scope).length) await R.generateForPages(b.bookId, from, to, { scope });
        const pool = all<any>(`SELECT q.*, b.title AS book_title, s.reps, s.due_at, s.stability FROM recall_questions q JOIN books b ON b.id = q.book_id LEFT JOIN recall_state s ON s.question_id = q.id WHERE q.user_id = ? AND q.book_id = ? AND q.status = 'active' AND q.page >= ? AND q.page_end <= ?`, LOCAL_USER, b.bookId, from, to);
        const level = (q: any) => q.level; const n = Math.min(Number(b.count) || set.perSession, 12);
        // prefer unseen, then due; spread across levels (understanding/application first) so a short session is not all definitions
        pool.sort((a, c) => (a.reps ?? 0) - (c.reps ?? 0) || level(c) - level(a) || (a.due_at ?? 0) - (c.due_at ?? 0));
        const picked: any[] = []; const seenC = new Set<string>();
        for (const q of pool) { if (picked.length >= n) break; if (seenC.has(q.concept) && pool.length > n * 1.5) continue; picked.push(q); seenC.add(q.concept); }
        for (const q of pool) { if (picked.length >= n) break; if (!picked.includes(q)) picked.push(q); }
        questions = picked;
      }
    } catch (e) { return aiError(e); }
    if (!questions.length) return bad('No questions are available for that selection yet.', 404);
    const id = R.startSession(kind, b.bookId ?? null, { from: b.from, to: b.to }, questions.length);
    return { sessionId: id, questions: questions.map(R.publicQ) };
  });
  on('POST', '/recall/sessions/:id/end', async ({ req, p }) => { const b = await body(req); R.endSession(p.id, ['completed', 'skipped', 'abandoned'].includes(b.status) ? b.status : 'completed'); return { ok: true }; });
  on('POST', '/recall/skip', async ({ req }) => { const b = await body(req); if (!book(b.bookId)) return bad('Not found', 404); return { id: R.skipRecall(b.bookId, { from: b.from, to: b.to }) }; });

  on('POST', '/recall/sessions/:id/answer', async ({ req, p }) => {
    const b = await body(req); const q = qrow(String(b.questionId)); if (!q) return bad('Question not found', 404);
    const answer = String(b.answer ?? '').slice(0, 6000);
    if (!answer.trim()) return bad('Write or say an answer first (you can say "I don\'t know" to see the answer).');
    try {
      const ev = await R.evaluateAnswer(q, answer, { confidence: Number(b.confidence) || undefined, feedbackLang: b.feedbackLang });
      const attemptId = R.saveAttempt(p.id, q, answer, ev, { confidence: Number(b.confidence) || undefined, modality: b.modality === 'voice' ? 'voice' : 'text', timeMs: Number(b.timeMs) || undefined });
      return { attemptId, evaluation: ev, key: R.answerKey(q), question: R.publicQ(q) }; // the answer is revealed only now, after the attempt
    } catch (e) { return aiError(e); }
  });
  on('POST', '/recall/attempts/:id/rate', async ({ req, p }) => {
    const b = await body(req); const r = Math.round(Number(b.rating));
    if (![1, 2, 3, 4].includes(r)) return bad('rating must be 1-4 (Again, Hard, Good, Easy)');
    const st = R.applyRating(p.id, r as 1 | 2 | 3 | 4); return { state: st };
  });

  on('GET', '/recall/daily', ({ q }) => R.buildSession(Number(q.get('minutes')) || R.settings().dailyMinutes, q.get('book')));
  on('GET', '/recall/mastery', ({ q }) => R.mastery(q.get('book')));
  on('GET', '/recall/gaps', ({ q }) => R.gaps(q.get('book')));
  on('GET', '/recall/analytics', () => R.analytics());
  on('GET', '/recall/history', ({ q }) => all(`SELECT a.id, a.score, a.rating, a.created_at, a.modality, a.answer, qq.question, qq.concept, qq.type, qq.level, qq.page, b.title AS book_title FROM recall_attempts a JOIN recall_questions qq ON qq.id = a.question_id JOIN books b ON b.id = qq.book_id WHERE a.user_id = ? ${q.get('question') ? 'AND a.question_id = ?' : ''} ORDER BY a.created_at DESC LIMIT 100`, LOCAL_USER, ...(q.get('question') ? [q.get('question')] : [])));

  on('POST', '/recall/blurt', async ({ req }) => {
    const b = await body(req); const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
    if (String(b.answer ?? '').trim().length < 20) return bad('Write what you remember first.');
    try { return await R.blurt(b.bookId, Math.max(1, Number(b.from) || 1), Math.min(bk.page_count, Number(b.to) || Number(b.from) || 1), String(b.answer), b.feedbackLang); } catch (e) { return aiError(e); }
  });
  on('POST', '/recall/cross', async ({ req }) => { const b = await body(req); if (!String(b.topic ?? '').trim()) return bad('topic required'); try { return await R.generateCrossBook(String(b.topic).slice(0, 120), Array.isArray(b.bookIds) ? b.bookIds : undefined); } catch (e) { return aiError(e); } });

  // ── extra modes: Socratic dialogue, blind mind map, recall while listening, exam-date planner ──
  on('POST', '/recall/socratic', async ({ req }) => {
    const b = await body(req); const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
    const from = Math.max(1, Number(b.from) || 1), to = Math.min(bk.page_count, Number(b.to) || from);
    try {
      const pick = () => all<any>(`SELECT q.*, b.title AS book_title, (SELECT COUNT(*) FROM recall_attempts a WHERE a.question_id = q.id) AS tries FROM recall_questions q JOIN books b ON b.id = q.book_id WHERE q.user_id = ? AND q.book_id = ? AND q.status = 'active' AND q.type NOT IN ('mcq','numeric') AND q.page >= ? AND q.page_end <= ? ORDER BY q.level DESC, tries ASC`, LOCAL_USER, b.bookId, from, to).filter((q) => R.parseQ(q).key_points.length >= 2);
      let pool = pick(); if (!pool.length) { await R.generateForPages(b.bookId, from, to, {}); pool = pick(); }
      if (!pool.length) return bad('No open-ended question could be made for those pages. Try a longer range.');
      const q = pool[0]; const sessionId = R.startSession('socratic', b.bookId, { from, to, questionId: q.id }, 1);
      return { sessionId, question: R.publicQ(q), maxTurns: 6 };
    } catch (e) { return aiError(e); }
  });
  on('POST', '/recall/socratic/:sid/turn', async ({ req, p }) => {
    const b = await body(req); const q = qrow(String(b.questionId)); if (!q) return bad('question not found', 404);
    if (!get('SELECT 1 FROM recall_sessions WHERE id = ? AND user_id = ? AND kind = ?', p.sid, LOCAL_USER, 'socratic')) return bad('session not found', 404);
    const answer = String(b.answer ?? '').trim(); if (!answer) return bad('answer required');
    const transcript = (Array.isArray(b.transcript) ? b.transcript : []).slice(-12).map((t: any) => ({ role: t.role === 'tutor' ? 'tutor' : 'learner', content: String(t.content ?? '').slice(0, 1500) }));
    try { const r = await M.socraticTurn(q, transcript, answer.slice(0, 2500), p.sid); if (r.done) R.endSession(p.sid, 'completed'); return r; } catch (e) { return aiError(e); }
  });
  on('POST', '/recall/mindmap', async ({ req }) => {
    const b = await body(req); const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
    const from = Math.max(1, Number(b.from) || 1), to = Math.min(bk.page_count, Number(b.to) || from, from + 5);
    if ((Array.isArray(b.nodes) ? b.nodes : []).filter((n: any) => String(n?.label ?? '').trim()).length < 2) return bad('Add at least two branches to your map first.');
    try { return await M.mindMapCompare(b.bookId, from, to, String(b.topic ?? bk.title).slice(0, 120), Array.isArray(b.nodes) ? b.nodes : [], Array.isArray(b.links) ? b.links : [], b.feedbackLang); } catch (e) { return aiError(e); }
  });
  on('GET', '/recall/mindmaps', () => all<any>('SELECT id, book_id, topic, result, created_at FROM mind_maps WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', LOCAL_USER).map((r) => { const x = JSON.parse(r.result); return { id: r.id, book_id: r.book_id, topic: r.topic, score: x.score, coverage: x.coverage, accuracy: x.accuracy, created_at: r.created_at }; }));
  on('POST', '/recall/listen', async ({ req }) => {
    const b = await body(req); if (!book(b.bookId)) return bad('Not found', 404);
    const kind = b.kind === 'predict' ? 'predict' : 'explain'; const answer = String(b.answer ?? '').trim(); if (!answer) return bad('answer required');
    try { return await M.listenCheck(b.bookId, Math.max(1, Number(b.page) || 1), Math.max(0, Number(b.offset) || 0), kind, answer, b.feedbackLang); } catch (e) { return aiError(e); }
  });
  on('POST', '/recall/plan', async ({ req }) => {
    const b = await body(req); if (!book(b.bookId)) return bad('Not found', 404);
    try { return M.planExam(b.bookId, String(b.examDate ?? ''), Math.min(480, Math.max(10, Number(b.minutesPerDay) || 30)), Array.isArray(b.chapters) ? b.chapters.map(Number) : undefined); } catch (e) { return bad((e as Error).message); }
  });
  on('GET', '/recall/plan', ({ q }) => { const id = q.get('book'); return { plan: (id && M.savedPlan(id)) || null }; });
  on('DELETE', '/recall/plan', ({ q }) => { const id = q.get('book'); if (id) run('DELETE FROM preferences WHERE user_id = ? AND key = ?', LOCAL_USER, `recall.plan.${id}`); return { ok: true }; });

  // ── exams: chapter / book / custom scope; questions come from the grounded question bank ──
  on('POST', '/recall/exams', async ({ req }) => {
    const b = await body(req); const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
    let from = 1, to = bk.page_count, title = `${bk.title} — full exam`;
    if (b.chapterIdx != null) { const ch = get<any>('SELECT idx, title, start_page FROM chapters WHERE book_id = ? AND idx = ?', b.bookId, Number(b.chapterIdx)); const nx = get<any>('SELECT start_page FROM chapters WHERE book_id = ? AND idx > ? ORDER BY idx LIMIT 1', b.bookId, Number(b.chapterIdx)); if (!ch) return bad('chapter not found', 404); from = ch.start_page; to = (nx?.start_page ?? bk.page_count + 1) - 1; title = `${bk.title} — ${ch.title}`; }
    else if (b.from) { from = Math.max(1, Number(b.from)); to = Math.min(bk.page_count, Number(b.to) || from); title = `${bk.title} — pp. ${from}–${to}`; }
    const n = Math.min(Math.max(Number(b.count) || 8, 3), 20);
    try {
      const have = () => all<any>(`SELECT q.*, b.title AS book_title FROM recall_questions q JOIN books b ON b.id = q.book_id WHERE q.user_id = ? AND q.book_id = ? AND q.status = 'active' AND q.page >= ? AND q.page_end <= ?`, LOCAL_USER, b.bookId, from, to);
      let pool = have();
      if (pool.length < n) {
        if (to - from + 1 <= 12) await R.generateForPages(b.bookId, from, to, { scope: from === to ? 'page' : 'section', count: n });
        else { await R.generateForPages(b.bookId, from, to, { scope: 'chapter', count: Math.ceil(n / 2) }); // plus questions sampled from across the range so it covers multiple pages
          const step = Math.max(1, Math.floor((to - from) / Math.ceil(n / 2))); for (let p = from; p <= to && have().length < n * 1.3; p += step) { try { await R.generateForPages(b.bookId, p, p, { scope: 'page', count: 2 }); } catch { /* skip thin pages */ } } }
        pool = have();
      }
      const fmt = b.format ? String(b.format) : 'mixed';
      let sel = pool.filter((q) => fmt === 'mcq' ? q.type === 'mcq' : fmt === 'short' ? !['mcq', 'numeric'].includes(q.type) && q.level <= 3 : fmt === 'long' ? q.level >= 4 : true);
      if (sel.length < Math.min(n, 3)) sel = pool;
      sel.sort((a, c) => (a.page ?? 0) - (c.page ?? 0)); const step = sel.length / Math.min(n, sel.length); sel = Array.from({ length: Math.min(n, sel.length) }, (_, i) => sel[Math.floor(i * step)]); // spread across the whole range
      if (!sel.length) return bad('No exam questions could be generated for this range.', 404);
      const id = uid();
      run('INSERT INTO exams (id, user_id, book_id, title, scope, question_ids, time_limit_sec, started_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, LOCAL_USER, b.bookId, title, JSON.stringify({ from, to, format: fmt }), JSON.stringify(sel.map((q) => q.id)), b.timeLimitMin ? Number(b.timeLimitMin) * 60 : null, now(), now());
      return { examId: id, title, pages: [from, to], timeLimitSec: b.timeLimitMin ? Number(b.timeLimitMin) * 60 : null, questions: sel.map(R.publicQ), coveragePages: [...new Set(sel.map((q) => q.page))] };
    } catch (e) { return aiError(e); }
  });
  on('POST', '/recall/exams/:id/submit', async ({ req, p }) => {
    const ex = get<any>('SELECT * FROM exams WHERE id = ? AND user_id = ?', p.id, LOCAL_USER); if (!ex) return bad('Not found', 404);
    const b = await body(req); const ids: string[] = JSON.parse(ex.question_ids); const answers: Record<string, string> = b.answers ?? {};
    const session = R.startSession('exam', ex.book_id, { examId: p.id }, ids.length);
    const enc = new TextEncoder();
    return new Response(new ReadableStream({
      async start(ctrl) {
        const send = (o: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n'));
        const results: any[] = [];
        try {
          for (let i = 0; i < ids.length; i++) {
            const q = qrow(ids[i]); if (!q) continue; const ans = String(answers[ids[i]] ?? '').trim();
            send({ type: 'progress', i, total: ids.length });
            let ev: R.Evaluation;
            if (!ans) ev = { score: 0, scores: { accuracy: 0, completeness: 0, understanding: null, application: null }, points: [], got_right: [], missed: ['No answer given.'], wrong: [], remember: q.expected, improve: '', method: 'deterministic', feedbackLang: 'en', autoRating: 1 };
            else ev = await R.evaluateAnswer(q, ans, {});
            const attemptId = R.saveAttempt(session, q, ans || '(no answer)', ev, {}); R.applyRating(attemptId, ev.autoRating);
            const item = { question: R.publicQ(q), key: R.answerKey(q), evaluation: ev, answer: ans, attemptId }; results.push(item); send({ type: 'item', ...item });
          }
          const score = results.reduce((s, r) => s + r.evaluation.score, 0) / Math.max(1, results.length);
          const byConcept = new Map<string, number[]>(); for (const r of results) byConcept.set(r.question.concept, [...(byConcept.get(r.question.concept) ?? []), r.evaluation.score]);
          const summary = { score, correct: results.filter((r) => r.evaluation.score >= 0.65).length, total: results.length, seconds: Number(b.seconds) || null, pages: [...new Set(results.map((r) => r.question.page))].sort((a: any, c: any) => a - c), concepts: [...byConcept.entries()].map(([concept, v]) => ({ concept, score: v.reduce((a, c) => a + c, 0) / v.length })).sort((a, c) => a.score - c.score) };
          run('UPDATE exams SET finished_at = ?, score = ?, result = ? WHERE id = ?', now(), score, JSON.stringify(summary), p.id); R.endSession(session, 'completed'); send({ type: 'done', ...summary });
        } catch (e: any) { send({ type: 'error', error: e?.message ?? String(e) }); }
        ctrl.close();
      },
    }), { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
  });
  on('GET', '/recall/exams', () => all(`SELECT e.id, e.title, e.score, e.finished_at, e.started_at, e.scope, b.title AS book_title FROM exams e LEFT JOIN books b ON b.id = e.book_id WHERE e.user_id = ? ORDER BY e.created_at DESC LIMIT 30`, LOCAL_USER));

  // ── OpenUI: the local model composes a presentation of the (already computed) evaluation or study plan ──
  on('POST', '/recall/compose', async ({ req }) => {
    const b = await body(req); const lang = String(b.lang || R.settings().feedbackLang || 'en');
    let facts = '';
    if (b.kind === 'plan') {
      const g = R.gaps(b.bookId ?? null); const sum = R.dueSummary();
      facts = JSON.stringify({ due_reviews: sum.due, new_questions: sum.fresh, weak: g.weak.slice(0, 5).map((w) => ({ concept: w.concept, book: w.book_title, why: w.why })), forgotten: g.forgotten.slice(0, 5).map((w) => ({ concept: w.concept, why: w.why })), untested: g.untested.slice(0, 5).map((w) => w.concept), suggested_sessions: g.sessions });
    } else {
      const a = get<any>('SELECT * FROM recall_attempts WHERE id = ? AND user_id = ?', String(b.attemptId), LOCAL_USER); if (!a) return bad('attempt not found', 404);
      const q = qrow(a.question_id)!; const ev = JSON.parse(a.evaluation); const key = R.answerKey(q);
      facts = JSON.stringify({ question: q.question, learner_answer: a.answer.slice(0, 600), got_right: ev.got_right, missed: ev.missed, wrong: ev.wrong, key_points: key.key_points, model_answer: key.expected, source: { quote: key.source_quote, page: q.page, book: q.book_title }, remember: ev.remember, improve: ev.improve });
    }
    try {
      const sys = String(b.system ?? '');
      if (sys.length < 200 || sys.length > 30000 || !/root\s*=\s*Panel/.test(sys)) return bad('An OpenUI system prompt built from the component library is required.');
      const system = `${sys}\n${SAFETY}\nWrite all visible text in ${langName(lang)}.`;
      // Validate with OpenUI's own parser (schema supplied by the browser's component library), retry with the errors,
      // and verify that every Quote/Formula is verbatim from the facts (a 4B model otherwise invents them).
      const parser = b.schema && typeof b.schema === 'object' ? createParser(b.schema, 'Panel') : null;
      const nf = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const factsN = nf(facts);
      const check = (text: string): string[] => {
        const errs: string[] = [];
        if (!/^\s*root\s*=/m.test(text)) errs.push('there is no `root = Panel([...])` line');
        if (/^\s*\w+\.\w+\s*=/m.test(text)) errs.push('property assignment like `name.children = ...` is not allowed');
        if (/\(\s*\w+\s*=\s*["\[\d]|,\s*\w+\s*=\s*["\[\d]/.test(text)) errs.push('named arguments are not allowed; use positional arguments only');
        if (parser) {
          try {
            const res: any = parser.parse(text); const m = res?.meta ?? {};
            if (!res?.root) errs.push('the program has no valid root');
            for (const e of m.errors ?? []) errs.push(typeof e === 'string' ? e : e?.message ?? JSON.stringify(e));
            if (m.orphaned?.length) errs.push(`unused names: ${m.orphaned.join(', ')}`);
            if (m.unresolved?.length) errs.push(`undefined names: ${m.unresolved.join(', ')}`);
          } catch (e: any) { errs.push(`parse error: ${String(e?.message ?? e).slice(0, 120)}`); }
        }
        for (const m of text.matchAll(/(?:Quote|Formula)\(\s*"((?:[^"\\]|\\.)*)"/g)) {
          const t = nf(m[1].replace(/[“”]/g, '').replace(/\\"/g, '"'));
          if (!factsN.includes(t)) errs.push(`a Quote/Formula ("${m[1].slice(0, 50)}…") is not verbatim from the facts; remove it or copy the source exactly`);
        }
        return errs;
      };
      let last = '', problems: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await ollama.chat('assistant', [{ role: 'system', content: system }, { role: 'user', content: `Facts (JSON):\n${facts}\n\n${problems.length ? `Your previous program was rejected: ${problems.join('; ')}. Fix every problem. ` : ''}Write the OpenUI Lang program now. Output only the program, no code fences, no explanations.` }], { temperature: attempt === 1 ? 0.1 : 0.3 });
        last = r.text.replace(/```[a-z]*\n?|```/g, '').trim(); problems = check(last);
        if (!problems.length) return { openui: last, model: r.model, attempts: attempt };
      }
      return J({ error: `The local model could not produce a valid OpenUI panel (${problems.slice(0, 2).join('; ')}).`, lastProgram: last }, 422);
    } catch (e) { return aiError(e); }
  });
  void detectLanguage;
}
