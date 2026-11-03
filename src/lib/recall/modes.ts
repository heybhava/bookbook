// Additional recall modes: Socratic dialogue, blind mind-mapping, recall while listening (predict / explain), and the exam-date planner.
import { all, get, run, uid, me } from '../db';
import * as ollama from '../ollama';
import { SAFETY } from '../rag';
import { detectLanguage, getLang, langName } from '../lang/registry';
import { ratingFromScore } from './fsrs';
import * as R from './engine';
import { TIME, pageText, norm, toks, jacc, clip } from './engine';

const now = () => Date.now();
const DAY = 86_400_000;

// ───────────── Socratic recall ─────────────
const STOPW = new Set('that this with from have which their they there been when will would could about into than then also such these those because between while where what does should'.split(' '));
const sig = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 3 && !STOPW.has(w)).map((w) => w.slice(0, 5)));
/** Share of a key point's content words that appear in the learner's text. */
const support = (point: string, text: string) => { const p = sig(point), a = sig(text); if (!p.size) return 1; let k = 0; for (const w of p) if (a.has(w)) k++; return k / p.size; };

export interface SocraticTurn { role: 'tutor' | 'learner'; content: string }
export interface SocraticResult { reply: string; covered: number[]; done: boolean; turns: number; stuck: number; reveal?: { key_points: string[]; expected: string; quote: string }; score?: number; attemptId?: string; autoRating?: 1 | 2 | 3 | 4; feedbackLang: string }

export async function socraticTurn(q: any, transcript: SocraticTurn[], answer: string, sessionId: string): Promise<SocraticResult> {
  const pq = R.parseQ(q); const kp: string[] = pq.key_points;
  const learnerText = [...transcript.filter((t) => t.role === 'learner').map((t) => t.content), answer].join('\n');
  const turns = transcript.filter((t) => t.role === 'learner').length + 1;
  const fl = detectLanguage(answer).code;
  const src = pq.sources.map((s: any) => `p. ${s.page}: ${s.quote}`).join('\n');
  const sys = `${SAFETY}
You are a SOCRATIC tutor. The learner studied a text and is now answering from memory. Your hidden goal is that they themselves discover and explain these key ideas:
${kp.map((k: string, i: number) => `${i + 1}. ${k}`).join('\n')}
Rules: ask ONE short question at a time. NEVER state, quote or paraphrase a key idea or the model answer. If the learner is partly right, acknowledge it briefly and ask a question that pushes toward the next missing idea. If wrong, ask a question that exposes the contradiction or gives the smallest possible hint. If they have been stuck for two turns, give a stronger hint — still as a question. Mark a key idea as covered only when the learner's own words show they understand it (judge by meaning, any language). Reply in ${langName(fl)}.
Return ONLY JSON: {"reply":"your next message","covered":[numbers of key ideas the learner has now shown across the whole conversation],"stuck":true|false}`;
  const history = transcript.map((t) => `${t.role === 'tutor' ? 'TUTOR' : 'LEARNER'}: ${t.content}`).join('\n');
  const call = async (extra = '') => ollama.parseJson<any>((await ollama.chat('comprehension', [{ role: 'system', content: sys + extra }, { role: 'user', content: `Opening question: ${pq.question}\nSource evidence (for you only):\n${src}\n\nConversation so far:\n${history}\nLEARNER: ${answer}` }], { json: true, temperature: 0.3 })).text);
  let j = await call(); if (!j?.reply) throw new Error('The tutor returned an unreadable reply. Try again.');
  const leaks = (text: string, covered: Set<number>) => kp.some((k, i) => !covered.has(i + 1) && jacc(toks(k), toks(text)) > 0.55);
  const claimed = new Set<number>((Array.isArray(j.covered) ? j.covered : []).map(Number).filter((n: number) => n >= 1 && n <= kp.length));
  // never trust a claimed key idea that the learner's words do not support (Latin-script answers; cross-language answers are judged by meaning only)
  const latin = getLang(fl)?.script === 'Latn' && getLang(pq.lang)?.script === 'Latn';
  const covered = new Set([...claimed].filter((n) => !latin || support(kp[n - 1], learnerText) >= 0.2));
  if (leaks(String(j.reply), covered)) { j = (await call('\nYour last draft revealed a key idea. Ask a question instead and reveal nothing.')) ?? j; if (leaks(String(j?.reply ?? ''), covered)) j = { reply: fl === 'en' ? 'Can you say more about why that happens, in your own words?' : '…', stuck: true }; }
  const stuck = transcript.filter((t) => t.role === 'tutor').length >= 2 && covered.size < Math.ceil(kp.length / 2) ? 1 : 0;
  const allDone = covered.size >= kp.length; const done = allDone || turns >= 6;
  const base: SocraticResult = { reply: clip(j.reply, 500), covered: [...covered].sort((a, b) => a - b), done, turns, stuck, feedbackLang: fl };
  if (!done) return base;
  const score = Math.max(0, Math.min(1, (covered.size / Math.max(1, kp.length)) * (turns > 4 ? 0.85 : 1))); // needing many hints lowers the score a little
  const rating = ratingFromScore(score);
  const ev: R.Evaluation = { score, scores: { accuracy: score, completeness: covered.size / Math.max(1, kp.length), understanding: score, application: null }, points: kp.map((k, i) => ({ point: k, status: covered.has(i + 1) ? 'covered' : 'missing' })), got_right: kp.filter((_, i) => covered.has(i + 1)), missed: kp.filter((_, i) => !covered.has(i + 1)), wrong: [], remember: pq.expected, improve: allDone ? '' : 'Review the ideas you did not reach on your own.', method: 'model', model: 'socratic dialogue', feedbackLang: fl, autoRating: rating };
  const attemptId = R.saveAttempt(sessionId, q, learnerText, ev, { modality: 'text' });
  return { ...base, reply: allDone ? (fl === 'en' ? 'You worked it out yourself — well done. Here is the full picture.' : base.reply) : (fl === 'en' ? 'Let us stop here. Here is the full picture.' : base.reply), score, attemptId, autoRating: rating, reveal: { key_points: kp, expected: pq.expected, quote: pq.source_quote } };
}

// ───────────── blind mind map ─────────────
export interface MapNode { id: string; label: string; parent?: string | null }
export interface MapLink { from: string; to: string; label?: string }

export async function mindMapCompare(bookId: string, from: number, to: number, topic: string, nodes: MapNode[], links: MapLink[], feedbackLang?: string) {
  const text = Array.from({ length: to - from + 1 }, (_, i) => pageText(bookId, from + i)).join('\n\n').slice(0, 8000);
  if (text.trim().length < 150) throw new Error('Not enough text on those pages.');
  const ns = nodes.slice(0, 40).map((n, i) => ({ id: clip(n.id || `l${i}`, 20), label: clip(n.label, 80), parent: n.parent ? clip(n.parent, 20) : null })).filter((n) => n.label);
  if (ns.length < 2) throw new Error('Add at least two branches to your map first.');
  const ids = new Set(ns.map((n) => n.id)); const ls = links.slice(0, 40).filter((l) => ids.has(l.from) && ids.has(l.to)).map((l) => ({ from: l.from, to: l.to, label: clip(l.label, 40) }));
  const edges = [...ns.filter((n) => n.parent && ids.has(n.parent)).map((n) => ({ from: n.parent as string, to: n.id, label: '' })), ...ls];
  const fl = feedbackLang || R.settings().feedbackLang || detectLanguage(ns.map((n) => n.label).join(' ')).code;
  // 1) the book's own concept structure for the topic (what the learner should have recalled)
  const ref = ollama.parseJson<any>((await ollama.chat('knowledge', [{ role: 'system', content: `${SAFETY}\nExtract the concept map of the TEXT around the topic "${topic}": 5-10 nodes (key concepts) and the relationships between them, using only the text. Return ONLY JSON {"nodes":[{"id":"r1","label":"short concept"}],"edges":[{"from":"r1","to":"r2","label":"verb phrase"}]}.` }, { role: 'user', content: `<book_excerpt>\n${text}\n</book_excerpt>` }], { json: true, temperature: 0.1 })).text);
  if (!Array.isArray(ref?.nodes) || ref.nodes.length < 3) throw new Error('Could not extract a reference map from those pages.');
  const rn = ref.nodes.slice(0, 12).map((n: any, i: number) => ({ id: clip(n.id || `r${i + 1}`, 10), label: clip(n.label, 80) })); const rids = new Set(rn.map((n: any) => n.id));
  const re = (Array.isArray(ref.edges) ? ref.edges : []).filter((e: any) => rids.has(e?.from) && rids.has(e?.to)).slice(0, 20).map((e: any) => ({ from: e.from, to: e.to, label: clip(e.label, 50) }));
  // 2) judge each learner node on its own (small focused calls: a 4B model cannot compare a whole map reliably in one go)
  const refList = rn.map((n: any) => `${n.id}: ${n.label}`).join('\n');
  const isRoot = (n: MapNode) => !n.parent;
  const nodeV: { learner: string; ref: string | null; verdict: 'correct' | 'partly' | 'wrong' | 'unsupported' }[] = [];
  for (const n of ns) {
    if (isRoot(n)) continue;
    const j = ollama.parseJson<any>((await ollama.chat('comprehension', [{ role: 'system', content: `${SAFETY}\nA learner drew a mind map from memory. Judge ONE of their branches against the book, by MEANING (any language, different wording is fine).\nReference concepts from the book:\n${refList}\nReturn ONLY JSON {"ref":"<id of the reference concept it matches, or null>","verdict":"correct|partly|wrong|unsupported"}.\ncorrect = states a concept or fact that the text supports. partly = related but vague or incomplete. unsupported = plausible but the text does not say it. wrong = contradicts the text OR has nothing to do with the topic.` },
      { role: 'user', content: `Topic: ${topic}\nLearner's branch: "${n.label}"\n\n<book_excerpt>\n${text.slice(0, 3000)}\n</book_excerpt>` }], { json: true, temperature: 0 })).text);
    let ref: string | null = rids.has(j?.ref) ? j.ref : null; let verdict = ['correct', 'partly', 'wrong', 'unsupported'].includes(j?.verdict) ? j.verdict : 'unsupported';
    // a branch that shares no word with the page cannot be called correct (Latin-script learners only; cross-language answers rely on the model's judgement)
    if ((verdict === 'correct' || verdict === 'partly') && getLang(detectLanguage(n.label).code)?.script === 'Latn' && getLang(detectLanguage(text).code)?.script === 'Latn' && support(n.label, text) < 0.15 && !ref) verdict = 'unsupported';
    if (verdict === 'wrong') ref = null;
    nodeV.push({ learner: n.id, ref, verdict });
  }
  const verdictOf = new Map(nodeV.map((v) => [v.learner, v]));
  const foundRef = new Map<string, number>(); for (const v of nodeV) if (v.ref && (v.verdict === 'correct' || v.verdict === 'partly')) foundRef.set(v.ref, Math.max(foundRef.get(v.ref) ?? 0, v.verdict === 'correct' ? 1 : 0.5));
  // the topic itself is the root the learner was given, so it is not "missing"
  const topicLike = (l: string) => jacc(toks(l), toks(topic)) >= 0.5 || norm(topic).includes(norm(l)) || norm(l).includes(norm(topic));
  const target = rn.filter((n: any) => !topicLike(n.label)); const denom = Math.max(1, target.length);
  const missing = target.filter((n: any) => !foundRef.has(n.id));
  const coverage = target.reduce((s: number, n: any) => s + (foundRef.get(n.id) ?? 0), 0) / denom;
  // 3) links between non-root branches: valid only if both ends are sound and the text relates them
  const refEdge = (a: string | null, b: string | null) => !!a && !!b && (a === b || re.some((e: any) => (e.from === a && e.to === b) || (e.from === b && e.to === a)));
  const nodeById = new Map(ns.map((n) => [n.id, n]));
  const edgeV: { from: string; to: string; verdict: 'correct' | 'unsupported' | 'wrong'; note: string }[] = []; let asked = 0;
  for (const e of edges) {
    const a = nodeById.get(e.from), b = nodeById.get(e.to); if (!a || !b) continue;
    const va = verdictOf.get(a.id), vb = verdictOf.get(b.id); const parentIsRoot = a && isRoot(a);
    if (vb?.verdict === 'wrong' || va?.verdict === 'wrong') { edgeV.push({ from: e.from, to: e.to, verdict: 'wrong', note: 'One end of this link is not supported by the text.' }); continue; }
    if (parentIsRoot) { edgeV.push({ from: e.from, to: e.to, verdict: vb && (vb.verdict === 'correct' || vb.verdict === 'partly') ? 'correct' : 'unsupported', note: '' }); continue; }
    if (refEdge(va?.ref ?? null, vb?.ref ?? null)) { edgeV.push({ from: e.from, to: e.to, verdict: 'correct', note: '' }); continue; }
    if (asked++ >= 10) { edgeV.push({ from: e.from, to: e.to, verdict: 'unsupported', note: 'Not checked (too many links).' }); continue; }
    const q = ollama.parseJson<any>((await ollama.chat('comprehension', [{ role: 'system', content: `${SAFETY}\nDoes the text support a direct relationship between concept A and concept B (one belongs to, causes, defines or depends on the other)? Return ONLY JSON {"related":true|false,"note":"one short clause"}.` }, { role: 'user', content: `A: ${a.label}\nB: ${b.label}\n\n<book_excerpt>\n${text.slice(0, 3000)}\n</book_excerpt>` }], { json: true, temperature: 0 })).text);
    edgeV.push({ from: e.from, to: e.to, verdict: q?.related === true ? 'correct' : 'unsupported', note: clip(q?.note, 160) });
  }
  const wrongNodes = nodeV.filter((v) => v.verdict === 'wrong').length, wrongEdges = edgeV.filter((e) => e.verdict === 'wrong').length;
  const judged = Math.max(1, nodeV.length);
  const accuracy = Math.max(0, 1 - wrongNodes / judged); // adding nodes never raises the score by itself; wrong ones lower it
  const correctEdges = edgeV.filter((e) => e.verdict === 'correct').length;
  const facts = `Branches drawn: ${nodeV.length}; correct ${nodeV.filter((v) => v.verdict === 'correct').length}, partly ${nodeV.filter((v) => v.verdict === 'partly').length}, wrong ${wrongNodes}. Book concepts found ${foundRef.size} of ${target.length}. Missing: ${missing.map((m: any) => m.label).join(', ') || 'none'}.`;
  let summary = `${Math.round(coverage * 100)}% of the book's concepts appear in your map; ${wrongNodes} branch${wrongNodes === 1 ? ' is' : 'es are'} not supported by the text.`;
  try { const s = ollama.parseJson<any>((await ollama.chat('comprehension', [{ role: 'system', content: `Write 2 encouraging, specific sentences in ${langName(fl)} summarising this mind-map result for the learner. Use only these facts. Return ONLY JSON {"summary":"..."}.` }, { role: 'user', content: facts }], { json: true, temperature: 0.2 })).text); if (s?.summary) summary = clip(s.summary, 500); } catch { /* keep the deterministic summary */ }
  const result = { coverage: Math.round(coverage * 100) / 100, accuracy: Math.round(accuracy * 100) / 100, score: Math.round(coverage * accuracy * 100) / 100, reference: { nodes: rn, edges: re }, nodeVerdicts: nodeV, edgeVerdicts: edgeV, missing, wrongNodes, wrongEdges, correctEdges, summary, model: ollama.getPref('model.comprehension') ?? 'local model' };
  const id = uid(); run('INSERT INTO mind_maps (id, user_id, book_id, topic, map, result, created_at) VALUES (?,?,?,?,?,?,?)', id, me(), bookId, topic.slice(0, 120), JSON.stringify({ nodes: ns, links: ls, from, to }), JSON.stringify(result), now());
  return { id, ...result };
}

// ───────────── recall while listening ─────────────
export async function listenCheck(bookId: string, page: number, offset: number, kind: 'predict' | 'explain', answer: string, feedbackLang?: string) {
  const full = pageText(bookId, page); if (!full) throw new Error('page not found');
  const before = full.slice(Math.max(0, offset - 900), offset).trim(), after = full.slice(offset, offset + 700).trim();
  const source = kind === 'predict' ? after : before;
  if (source.length < 60) throw new Error('Not enough text here for a check.');
  const fl = feedbackLang || R.settings().feedbackLang || detectLanguage(answer).code;
  const sys = kind === 'predict'
    ? `${SAFETY}\nThe learner is listening to a text and was asked to PREDICT what comes next. Compare their prediction with what the text actually says next, by meaning (any language). A prediction is good if it names the ideas the text actually develops; a plausible different direction earns partial credit. Return ONLY JSON {"score":0-100,"matched":["ideas they predicted that appear"],"missed":["main ideas of the actual next passage they did not predict"],"plausible":true|false,"feedback":"2 sentences in ${langName(fl)}"}`
    : `${SAFETY}\nThe learner just heard a passage and was asked to EXPLAIN it from memory. Grade by meaning (any language); generic statements earn nothing. Return ONLY JSON {"score":0-100,"matched":["ideas they explained correctly"],"missed":["important ideas they left out"],"plausible":true,"feedback":"2 sentences in ${langName(fl)}"}`;
  const j = ollama.parseJson<any>((await ollama.chat('comprehension', [{ role: 'system', content: sys }, { role: 'user', content: `Text${kind === 'predict' ? ' that actually comes next' : ' just heard'}:\n<book_excerpt>\n${source}\n</book_excerpt>\n\nLearner's answer:\n<learner_answer>\n${answer.slice(0, 2000)}\n</learner_answer>` }], { json: true, temperature: 0.1 })).text);
  if (!j || j.score == null) throw new Error('The check was unreadable. Try again.');
  let score = Math.max(0, Math.min(1, Number(j.score) / 100));
  if (getLang(detectLanguage(answer).code)?.script === 'Latn' && support(source, answer) < 0.05) score = Math.min(score, 0.25); // an answer with no overlap with the passage cannot score well
  if (answer.trim().split(/\s+/).length < 4) score = Math.min(score, 0.2);
  if (kind === 'predict' && j.plausible && score < 0.45 && score > 0.1) score = Math.min(0.45, score + 0.1); // plausible alternative direction: small credit only
  // recorded as evidence (analytics) but kept out of the daily queue: a prediction cannot be re-asked meaningfully
  const ch = get<any>('SELECT idx, title FROM chapters WHERE book_id = ? AND start_page <= ? ORDER BY start_page DESC LIMIT 1', bookId, page);
  const qid = uid();
  run(`INSERT INTO recall_questions (id, user_id, book_id, scope, page, page_end, chapter_idx, concept, type, level, difficulty, question, expected, key_points, source_quote, sources, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    qid, me(), bookId, 'listen', page, page, ch?.idx ?? null, ch?.title ?? 'Listening', kind === 'predict' ? 'prediction' : 'explain', kind === 'predict' ? 4 : 3, 3, kind === 'predict' ? 'Predict what comes next.' : 'Explain what you just heard.', source.slice(0, 500), '[]', source.slice(0, 300), JSON.stringify([{ book_id: bookId, page, quote: source.slice(0, 240) }]), 'retired', now());
  const ev: R.Evaluation = { score, scores: { accuracy: score, completeness: score, understanding: kind === 'explain' ? score : null, application: kind === 'predict' ? score : null }, points: [], got_right: (j.matched ?? []).map((x: unknown) => clip(x, 200)).slice(0, 4), missed: (j.missed ?? []).map((x: unknown) => clip(x, 200)).slice(0, 4), wrong: [], remember: '', improve: clip(j.feedback, 400), method: 'model', feedbackLang: fl, autoRating: ratingFromScore(score) };
  const sid = R.startSession('listen', bookId, { page, offset, kind }, 1); R.saveAttempt(sid, { id: qid }, answer, ev, {}); R.endSession(sid, 'completed');
  return { score, matched: ev.got_right, missed: ev.missed, feedback: ev.improve, reveal: source, kind };
}

// ───────────── exam-date planner ─────────────
export interface PlanTask { kind: 'new' | 'review' | 'weak' | 'mock' | 'light'; label: string; minutes: number; chapterIdx?: number; from?: number; to?: number; concepts?: string[] }
export interface PlanDay { date: string; daysLeft: number; tasks: PlanTask[]; minutes: number }

export function planExam(bookId: string, examDate: string, minutesPerDay: number, chapterIdxs?: number[]) {
  const bk = get<any>('SELECT id, title, page_count FROM books WHERE id = ? AND user_id = ?', bookId, me()); if (!bk) throw new Error('book not found');
  const end = new Date(examDate + 'T00:00:00'); if (isNaN(end.getTime())) throw new Error('Choose a valid exam date.');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((end.getTime() - today.getTime()) / DAY); if (days < 1) throw new Error('The exam date must be in the future.');
  const chs = all<any>('SELECT idx, title, start_page FROM chapters WHERE book_id = ? ORDER BY idx', bookId).map((c, i, a) => ({ ...c, end_page: (a[i + 1]?.start_page ?? bk.page_count + 1) - 1 })).filter((c) => !chapterIdxs?.length || chapterIdxs.includes(c.idx));
  const attempts = (from: number, to: number) => get<{ n: number }>('SELECT COUNT(DISTINCT a.question_id) n FROM recall_attempts a JOIN recall_questions q ON q.id = a.question_id WHERE q.book_id = ? AND q.page >= ? AND q.page_end <= ? AND q.status = \'active\'', bookId, from, to)?.n ?? 0;
  const qcount = (from: number, to: number) => get<{ n: number }>('SELECT COUNT(*) n FROM recall_questions WHERE book_id = ? AND status = \'active\' AND page >= ? AND page_end <= ?', bookId, from, to)?.n ?? 0;
  const mast = R.mastery(bookId);
  const rows = chs.map((c) => { const pages = c.end_page - c.start_page + 1; const have = qcount(c.start_page, c.end_page); const q = have || Math.max(4, pages * 3); const tested = attempts(c.start_page, c.end_page);
    const avg = 2.2; const minutes = Math.max(6, Math.round(q * avg * (tested ? 0.4 : 1))); return { ...c, pages, questions: have, needsGeneration: !have, tested, minutes, weak: mast.filter((m) => m.chapter_idx === c.idx && m.attempts >= 2 && Object.values(m.dims).filter((x): x is number => x != null).reduce((a, b, _, arr) => a + b / arr.length, 0) < 0.55).map((m) => m.concept) }; });
  const firstPass = rows.reduce((s, r) => s + r.minutes, 0);
  const mockMin = Math.min(40, Math.max(15, Math.round(rows.reduce((s, r) => s + r.questions, 0) > 0 ? 25 : 20)));
  const budgetDays = days >= 3 ? days - 1 : days; // last day reserved for light review
  const learnDays = Math.max(1, Math.ceil(budgetDays * 0.65)); const needPerDay = Math.ceil(firstPass / learnDays);
  const feasible = needPerDay <= minutesPerDay;
  // distribute chapters over learning days (hardest/untested first), then fill remaining time with reviews, weak topics and mocks
  const order = [...rows].sort((a, b) => (a.tested ? 1 : 0) - (b.tested ? 1 : 0) || a.idx - b.idx);
  const sched: PlanDay[] = []; let ci = 0; let carry = 0;
  for (let d = 0; d < days; d++) {
    const date = new Date(today.getTime() + d * DAY); const dl = days - d; const tasks: PlanTask[] = []; let left = minutesPerDay;
    const isLast = dl === 1 && days >= 3;
    if (isLast) { tasks.push({ kind: 'light', label: 'Light review of due items and weak concepts only — rest well', minutes: Math.min(left, 20) }); left -= 20; }
    else {
      if (d < learnDays) {
        while (ci < order.length && left >= 6) { const r = order[ci]; const m = Math.min(left, r.minutes - carry); tasks.push({ kind: 'new', label: `${r.tested ? 'Re-test' : 'Learn & test'}: ${r.title}`, minutes: m, chapterIdx: r.idx, from: r.start_page, to: r.end_page }); left -= m; carry += m; if (carry >= r.minutes) { ci++; carry = 0; } else break; }
      }
      const mockDay = (dl === 2 && days >= 4) || (days >= 10 && dl === Math.round(days / 2));
      if (mockDay && left >= mockMin) { tasks.push({ kind: 'mock', label: 'Timed mock exam (closed book)', minutes: mockMin }); left -= mockMin; }
      const weak = rows.flatMap((r) => r.weak).slice(0, 6); if (weak.length && left >= 8 && d >= 2) { tasks.push({ kind: 'weak', label: 'Targeted practice on weak concepts', minutes: 8, concepts: weak }); left -= 8; }
      if (left >= 5 && d > 0) { tasks.push({ kind: 'review', label: 'Spaced review of everything due (FSRS)', minutes: left }); left = 0; }
    }
    sched.push({ date: date.toISOString().slice(0, 10), daysLeft: dl, tasks, minutes: tasks.reduce((s, t) => s + t.minutes, 0) });
  }
  const plan = { bookId, title: bk.title, examDate, days, minutesPerDay, chapters: rows.map((r) => ({ idx: r.idx, title: r.title, pages: [r.start_page, r.end_page], questions: r.questions, needsGeneration: r.needsGeneration, tested: r.tested, estMinutes: r.minutes })),
    firstPassMinutes: firstPass, requiredPerDay: needPerDay, feasible, schedule: sched, note: feasible ? 'Reviews are scheduled by FSRS, so the exact items each day depend on your answers; this plan allocates time and topics.' : `The first pass alone needs about ${needPerDay} min/day for ${learnDays} days. Raise your daily time to ${needPerDay} min, choose fewer chapters, or accept that later chapters will only get a light pass.`, generated_at: now() };
  run('INSERT INTO preferences (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value = excluded.value', me(), `recall.plan.${bookId}`, JSON.stringify(plan));
  void TIME;
  return plan;
}
export const savedPlan = (bookId: string) => { const v = get<{ value: string }>('SELECT value FROM preferences WHERE user_id = ? AND key = ?', me(), `recall.plan.${bookId}`)?.value; return v ? JSON.parse(v) : null; };
