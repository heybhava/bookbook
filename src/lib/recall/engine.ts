// Active recall & long-term memory engine. Everything here is evidence-based: nothing is shown as "learned" without recorded attempts.
import crypto from 'node:crypto';
import { all, get, run, tx, uid, LOCAL_USER } from '../db';
import * as ollama from '../ollama';
import { SAFETY } from '../rag';
import { evaluate as evalExpr } from '../scene/expr';
import { detectLanguage, getLang, langName } from '../lang/registry';
import { retrieveLibrary } from '../library';
import { review, newCard, ratingFromScore, retrievabilityNow, type Card, type Rating } from './fsrs';

const now = () => Date.now();
const DAY = 86_400_000;
export const TYPES = ['factual', 'conceptual', 'explain', 'why_how', 'application', 'scenario', 'comparison', 'critical', 'formula', 'problem', 'cause_effect', 'connection', 'definition', 'prediction', 'teach_back', 'mcq', 'numeric'] as const;
export type QType = (typeof TYPES)[number];
export const LEVEL_NAME = ['', 'Recognition', 'Recall', 'Understanding', 'Application', 'Analysis', 'Creation'];
export const TIME: Record<string, number> = { mcq: 0.5, numeric: 2, factual: 1, definition: 1, formula: 1.2, conceptual: 2, explain: 2.5, why_how: 2.5, application: 3, scenario: 3, problem: 3.5, comparison: 3, critical: 3.5, cause_effect: 2.5, connection: 3, prediction: 2, teach_back: 4 };

export interface Settings { trigger: string; perSession: number; retention: number; dailyMinutes: number; feedbackLang: string; allowVoice: boolean }
export const DEFAULT_SETTINGS: Settings = { trigger: 'pages3', perSession: 3, retention: 0.9, dailyMinutes: 10, feedbackLang: '', allowVoice: false };
export function settings(): Settings {
  const v = get<{ value: string }>('SELECT value FROM preferences WHERE user_id = ? AND key = ?', LOCAL_USER, 'recall.settings')?.value;
  return { ...DEFAULT_SETTINGS, ...(v ? JSON.parse(v) : {}) };
}
export function saveSettings(p: Partial<Settings>) {
  const next = { ...settings(), ...p };
  next.perSession = Math.min(10, Math.max(1, Math.round(next.perSession))); next.retention = Math.min(0.97, Math.max(0.7, next.retention)); next.dailyMinutes = Math.min(120, Math.max(3, Math.round(next.dailyMinutes)));
  run('INSERT INTO preferences (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value = excluded.value', LOCAL_USER, 'recall.settings', JSON.stringify(next));
  return next;
}

export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
export const toks = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 3));
export const jacc = (a: Set<string>, b: Set<string>) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / Math.max(1, a.size + b.size - i); };
const hash = (t: string) => crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);
export const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num01 = (x: unknown) => Math.max(0, Math.min(1, Number(x) / 100 || 0));

// ───────────── question quality checker ─────────────
export interface Quality { ok: boolean; issues: string[]; grounded: number; answerable: boolean; duplicate: boolean; quoteVerified: boolean }
const REFERS_TO_TEXT = /\b(this page|the passage|the text above|passage above|according to the (text|passage|excerpt)|in the (excerpt|passage|text) (above|below)|as shown above)\b/i;

export function groundedness(points: string[], source: string) {
  const src = toks(source); if (!points.length) return 0;
  let ok = 0; for (const p of points) { const t = [...toks(p)]; if (!t.length) continue; if (t.filter((w) => src.has(w)).length / t.length >= 0.55) ok++; }
  return ok / points.length;
}
export function bestSentence(source: string, ref: string) {
  const want = toks(ref); let best = '', score = -1;
  for (const s of source.split(/(?<=[.!?])\s+|\n+/)) { const sc = jacc(want, toks(s)); if (sc > score && s.trim().length > 20) { score = sc; best = s.trim(); } }
  return best.slice(0, 400);
}

export function checkQuestion(q: any, source: string, existing: string[]): Quality {
  const issues: string[] = [];
  const text = String(q.question ?? ''), kp: string[] = q.key_points ?? [];
  if (text.length < 15 || text.length > 500) issues.push('question is too short or too long');
  if (REFERS_TO_TEXT.test(text)) issues.push('refers to the page, which is hidden during recall');
  if (!kp.length) issues.push('no expected key points');
  const grounded = groundedness([...kp, String(q.expected ?? '')], source);
  if (grounded < 0.5) issues.push('expected answer is not supported by the source text (would need outside knowledge)');
  const mine = toks(text); const duplicate = existing.some((e) => jacc(mine, toks(e)) > 0.6);
  if (duplicate) issues.push('duplicates another question');
  if (q.type === 'mcq') { const o = q.options; if (!Array.isArray(o) || o.length < 3 || new Set(o.map(norm)).size !== o.length || !Number.isInteger(q.correct_index) || q.correct_index < 0 || q.correct_index >= o.length) issues.push('invalid multiple-choice options'); }
  const quoteVerified = !!q.source_quote && norm(source).includes(norm(String(q.source_quote)));
  return { ok: !issues.length, issues, grounded: Math.round(grounded * 100) / 100, answerable: grounded >= 0.5, duplicate, quoteVerified };
}

function verifyNumeric(n: any): { expr: string; answer: number; unit?: string; tolerance: number } | null {
  try {
    if (!n?.expr) return null; const v = evalExpr(String(n.expr), {}); if (!Number.isFinite(v)) return null;
    const said = Number(n.answer); if (Number.isFinite(said) && Math.abs(said - v) > Math.max(1e-6, Math.abs(v) * 0.02)) return null; // the model's own arithmetic disagrees with ours: reject
    return { expr: String(n.expr).slice(0, 200), answer: v, unit: n.unit ? String(n.unit).slice(0, 12) : undefined, tolerance: Math.min(0.1, Math.max(0.005, Number(n.tolerance) || 0.01)) };
  } catch { return null; }
}

export const pageText = (bookId: string, p: number) => get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', bookId, p)?.text ?? '';

const GEN_SYS = `${SAFETY}
You write ACTIVE-RECALL questions for a learner who has just read the text and will answer with the book CLOSED. Test understanding, not recognition.
Rules:
- Prefer scenario, application, why/how, cause-and-effect, comparison, prediction and explain-in-your-own-words questions. Avoid bare "What is X?" (at most one definition question).
- Each question must be answerable from the text alone and must stand alone: never say "this page", "the passage" or "the text above".
- Give "key_points": 2-4 short statements a good answer MUST contain, taken from the text. "expected": a model answer in 1-3 sentences.
- "source_quote": a short VERBATIM quote from the text that supports the answer.
- "level": 1 recognition, 2 recall, 3 understanding, 4 application, 5 analysis, 6 creation. "difficulty": 1-5. Mix levels; at least half must be level 3 or higher.
- type is one of: ${TYPES.join(', ')}. For "mcq" give "options" (4, one correct) and "correct_index". For "numeric" the question must state all numbers and give "numeric": {"expr":"arithmetic expression using only numbers and + - * / ^ ( )","answer":number,"unit":"…","tolerance":0.01}.
Return ONLY JSON: {"questions":[{"type":"","level":3,"difficulty":3,"concept":"short concept name","objective":"what the learner should be able to do","question":"","expected":"","key_points":["",""],"source_quote":"","options":[],"correct_index":0,"numeric":null}]}`;

export interface GenResult { created: number; rejected: { question: string; issues: string[] }[]; model: string | null; cached: boolean }

export async function generateForPages(bookId: string, from: number, to: number, opts: { count?: number; scope?: 'page' | 'section' | 'chapter' | 'book'; force?: boolean; hardOnly?: boolean } = {}): Promise<GenResult> {
  const scope = opts.scope ?? (from === to ? 'page' : 'section');
  const pages: number[] = []; for (let p = from; p <= to; p++) pages.push(p);
  const text = pages.map((p) => pageText(bookId, p)).join('\n\n');
  const h = hash(text + scope);
  const have = all<any>(`SELECT id, content_hash FROM recall_questions WHERE user_id = ? AND book_id = ? AND scope = ? AND page = ? AND page_end = ? AND status = 'active'`, LOCAL_USER, bookId, scope, from, to);
  if (have.length && have.every((q) => q.content_hash === h) && !opts.force) return { created: 0, rejected: [], model: null, cached: true };
  if (text.trim().length < 200) throw new Error('This page has too little text to ask about.');
  if (opts.force || have.length) run(`UPDATE recall_questions SET status = 'retired' WHERE user_id = ? AND book_id = ? AND scope = ? AND page = ? AND page_end = ? AND status = 'active' AND content_hash != ?`, LOCAL_USER, bookId, scope, from, to, h);
  const existing = all<{ question: string }>(`SELECT question FROM recall_questions WHERE user_id = ? AND book_id = ? AND status = 'active' AND ((page BETWEEN ? AND ?) OR scope != 'page')`, LOCAL_USER, bookId, from, to).map((r) => r.question);
  const bk = get<any>('SELECT title, language FROM books WHERE id = ?', bookId);
  const ch = get<any>('SELECT idx, title FROM chapters WHERE book_id = ? AND start_page <= ? ORDER BY start_page DESC LIMIT 1', bookId, from);
  const n = opts.count ?? (scope === 'page' ? 5 : scope === 'section' ? 6 : scope === 'chapter' ? 8 : 10);
  const sample = text.length > 9000 ? pages.map((p) => pageText(bookId, p).slice(0, Math.floor(9000 / pages.length))).join('\n\n') : text; // long ranges are sampled evenly, not truncated
  const rejected: GenResult['rejected'] = []; let created = 0; let defs = 0; let r: any = null;
  // A second pass tops up when the quality checker rejected too many (small local models are inconsistent), telling the model why.
  for (let pass = 0; pass < 2 && (pass === 0 || created < Math.min(3, n)); pass++) {
  r = await ollama.chat('knowledge', [{ role: 'system', content: GEN_SYS + (scope !== 'page' ? `\nThis is a ${scope}-level quiz: favour questions that connect ideas across the whole text (levels 3-5).` : '') + (opts.hardOnly ? '\nUse levels 4-6 only.' : '') + (pass ? `\nYour previous questions were rejected for: ${[...new Set(rejected.flatMap((x) => x.issues))].slice(0, 4).join('; ')}. Make every key point and the model answer come straight from the text, and never refer to "the text" or "the passage".` : '') },
    { role: 'user', content: `Book: "${bk?.title}"${ch ? `, chapter "${ch.title}"` : ''}. Write ${n} questions.\n<book_excerpt>\n${sample}\n</book_excerpt>` }], { json: true, temperature: pass ? 0.3 : 0.4 });
  const raw = ollama.parseJson<any>(r.text)?.questions;
  if (!Array.isArray(raw)) { if (pass) break; throw new Error('The model returned unreadable questions. Try again.'); }
  for (const q of raw.slice(0, n + 3)) {
    if (!q || typeof q !== 'object') continue;
    const type = (TYPES as readonly string[]).includes(q.type) ? q.type : 'conceptual';
    const level = Math.min(6, Math.max(1, Math.round(Number(q.level)) || 3));
    const item: any = { ...q, type, question: clip(q.question, 500), expected: clip(q.expected, 700), key_points: (Array.isArray(q.key_points) ? q.key_points : []).map((k: unknown) => clip(k, 200)).filter(Boolean).slice(0, 5), source_quote: clip(q.source_quote, 400) };
    let numeric = null as any;
    if (type === 'numeric') { numeric = verifyNumeric(q.numeric); if (!numeric) { rejected.push({ question: item.question, issues: ['numeric answer could not be verified by calculation'] }); continue; } item.key_points = item.key_points.length ? item.key_points : [`${numeric.answer}`]; }
    if (type === 'definition' || level === 1) { if (++defs > 1) { rejected.push({ question: item.question, issues: ['too many definition-level questions'] }); continue; } }
    const quality = checkQuestion(item, text, existing);
    if (!quality.ok) { rejected.push({ question: item.question, issues: quality.issues }); continue; }
    if (!quality.quoteVerified) item.source_quote = bestSentence(text, `${item.expected} ${item.key_points.join(' ')}`); // never keep an unverified quote
    const pg = pages.find((p) => item.source_quote && norm(pageText(bookId, p)).includes(norm(item.source_quote))) ?? from;
    const id = uid();
    tx(() => {
      run(`INSERT INTO recall_questions (id, user_id, book_id, scope, page, page_end, chapter_idx, concept, objective, type, level, difficulty, question, expected, key_points, options, correct_index, numeric, source_quote, sources, quality, content_hash, lang, model, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, LOCAL_USER, bookId, scope, from, to, ch?.idx ?? null, clip(q.concept, 80) || 'General', clip(q.objective, 200), type, level, Math.min(5, Math.max(1, Math.round(Number(q.difficulty)) || 3)), item.question, item.expected,
        JSON.stringify(item.key_points), type === 'mcq' ? JSON.stringify(q.options.map((o: unknown) => clip(o, 160))) : null, type === 'mcq' ? q.correct_index : null, numeric ? JSON.stringify(numeric) : null,
        item.source_quote, JSON.stringify([{ book_id: bookId, page: pg, quote: item.source_quote }]), JSON.stringify(quality), h, bk?.language ?? 'en', r.model, now());
      run('INSERT INTO recall_state (question_id, due_at) VALUES (?, ?)', id, now());
    });
    existing.push(item.question); created++;
  }
  }
  return { created, rejected, model: r?.model ?? null, cached: false };
}

/** Questions combining two or more books on a shared topic; every question cites passages from each source. */
export async function generateCrossBook(topic: string, bookIds?: string[]): Promise<GenResult> {
  const { hits } = await retrieveLibrary(topic, { bookIds, k: 8 });
  const books = new Set(hits.map((h) => h.book_id));
  if (books.size < 2) throw new Error('Cross-book questions need at least two books that discuss this topic.');
  const ctx = hits.map((h, i) => `[S${i + 1}] ${h.book_title}${h.author ? ` — ${h.author}` : ''}, p. ${h.page_start}\n${h.text.slice(0, 700)}`).join('\n\n');
  const r = await ollama.chat('knowledge', [{ role: 'system', content: `${SAFETY}\nWrite 3 ACTIVE-RECALL questions that REQUIRE ideas from at least two different sources (compare approaches, combine principles, find a conflict, or explain without referring to either). Answerable from the sources only. Return ONLY JSON {"questions":[{"type":"comparison|connection|critical|application","level":4,"difficulty":4,"concept":"${topic.slice(0, 40)}","objective":"","question":"","expected":"","key_points":["",""],"uses":[1,2]}]} where "uses" lists the [S#] numbers each question needs.` },
    { role: 'user', content: `<book_excerpt>\n${ctx}\n</book_excerpt>` }], { json: true, temperature: 0.4 });
  const raw = ollama.parseJson<any>(r.text)?.questions; if (!Array.isArray(raw)) throw new Error('unreadable model output');
  const rejected: GenResult['rejected'] = []; let created = 0;
  const existing = all<{ question: string }>(`SELECT question FROM recall_questions WHERE user_id = ? AND scope = 'cross' AND status = 'active'`, LOCAL_USER).map((x) => x.question);
  for (const q of raw.slice(0, 4)) {
    const uses: number[] = (Array.isArray(q.uses) ? q.uses : []).map(Number).filter((n: number) => hits[n - 1]);
    const bs = new Set(uses.map((n) => hits[n - 1].book_id));
    const item = { ...q, question: clip(q.question, 500), expected: clip(q.expected, 700), key_points: (Array.isArray(q.key_points) ? q.key_points : []).map((k: unknown) => clip(k, 200)).filter(Boolean).slice(0, 5), type: (['comparison', 'connection', 'critical', 'application'] as string[]).includes(q.type) ? q.type : 'comparison' };
    const quality = checkQuestion(item, hits.map((h) => h.text).join('\n'), existing);
    if (bs.size < 2) quality.issues.push('does not actually use two different books');
    if (!quality.ok || bs.size < 2) { rejected.push({ question: item.question, issues: quality.issues }); continue; }
    const sources = uses.map((n) => ({ book_id: hits[n - 1].book_id, book_title: hits[n - 1].book_title, page: hits[n - 1].page_start, quote: hits[n - 1].text.slice(0, 240) }));
    const id = uid();
    tx(() => {
      run(`INSERT INTO recall_questions (id, user_id, book_id, scope, page, page_end, concept, objective, type, level, difficulty, question, expected, key_points, source_quote, sources, quality, lang, model, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, LOCAL_USER, sources[0].book_id, 'cross', sources[0].page, sources[0].page, clip(q.concept, 80) || topic, clip(q.objective, 200), item.type, 5, 4, item.question, item.expected, JSON.stringify(item.key_points), sources[0].quote, JSON.stringify(sources), JSON.stringify(quality), 'en', r.model, now());
      run('INSERT INTO recall_state (question_id, due_at) VALUES (?, ?)', id, now());
    });
    existing.push(item.question); created++;
  }
  return { created, rejected, model: r.model, cached: false };
}

// ───────────── presenting questions without leaking answers ─────────────
export const parseQ = (r: any) => ({ ...r, key_points: JSON.parse(r.key_points || '[]'), options: r.options ? JSON.parse(r.options) : null, numeric: r.numeric ? JSON.parse(r.numeric) : null, sources: JSON.parse(r.sources || '[]'), quality: JSON.parse(r.quality || '{}') });
/** What the learner may see BEFORE answering. */
export const publicQ = (r: any) => { const q = parseQ(r); return { id: q.id, book_id: q.book_id, scope: q.scope, page: q.page, page_end: q.page_end, chapter_idx: q.chapter_idx, concept: q.concept, objective: q.objective, type: q.type, level: q.level, levelName: LEVEL_NAME[q.level], difficulty: q.difficulty, question: q.question, options: q.options, unit: q.numeric?.unit ?? null, lang: q.lang, est: TIME[q.type] ?? 2, book_title: r.book_title }; };
/** Revealed only AFTER an attempt. */
export const answerKey = (r: any) => { const q = parseQ(r); return { expected: q.expected, key_points: q.key_points, source_quote: q.source_quote, sources: q.sources, correct_index: q.correct_index, numeric: q.numeric ? { answer: q.numeric.answer, unit: q.numeric.unit } : null, quality: q.quality }; };

// ───────────── evaluation ─────────────
export interface Evaluation {
  score: number; scores: { accuracy: number; completeness: number; understanding: number | null; application: number | null };
  points: { point: string; status: 'covered' | 'partial' | 'missing' | 'contradicted' }[]; got_right: string[]; missed: string[]; wrong: string[]; remember: string; improve: string; follow_up?: string;
  method: 'deterministic' | 'model'; model?: string; feedbackLang: string; autoRating: Rating;
}
const DIGITS: Record<string, string> = { '౦': '0', '౧': '1', '౨': '2', '౩': '3', '౪': '4', '౫': '5', '౬': '6', '౭': '7', '౮': '8', '౯': '9', '௦': '0', '௧': '1', '௨': '2', '௩': '3', '௪': '4', '௫': '5', '௬': '6', '௭': '7', '௮': '8', '௯': '9', '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
export const parseNumber = (s: string) => { const t = s.replace(/[౦-౯௦-௯०-९]/g, (c) => DIGITS[c] ?? c).replace(/(\d),(?=\d{3}\b)/g, '$1'); const m = t.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/i); return m ? Number(m[0]) : NaN; };

export async function evaluateAnswer(q: any, answer: string, o: { confidence?: number; feedbackLang?: string } = {}): Promise<Evaluation> {
  const pq = parseQ(q); const ans = answer.trim();
  const fl = o.feedbackLang || settings().feedbackLang || detectLanguage(ans || pq.question).code;
  if (pq.type === 'mcq') {
    const idx = Number.isInteger(Number(ans)) ? Number(ans) : pq.options.findIndex((x: string) => norm(x) === norm(ans)); const ok = idx === pq.correct_index;
    return { score: ok ? 1 : 0, scores: { accuracy: ok ? 1 : 0, completeness: ok ? 1 : 0, understanding: null, application: null }, points: [], got_right: ok ? ['You chose the correct option.'] : [], missed: [], wrong: ok ? [] : [`You chose “${pq.options[idx] ?? '—'}”.`], remember: pq.expected, improve: ok ? '' : `The correct option is “${pq.options[pq.correct_index]}”. ${pq.expected}`, method: 'deterministic', feedbackLang: 'en', autoRating: ratingFromScore(ok ? 1 : 0, o.confidence) };
  }
  if (pq.type === 'numeric' && pq.numeric) { // deterministic verification, no LLM involved
    const v = parseNumber(ans); const want = pq.numeric.answer; const ok = Number.isFinite(v) && Math.abs(v - want) <= Math.abs(want) * pq.numeric.tolerance + 1e-9;
    return { score: ok ? 1 : 0, scores: { accuracy: ok ? 1 : 0, completeness: ok ? 1 : 0, understanding: null, application: ok ? 1 : 0 }, points: [], got_right: ok ? [`${v}${pq.numeric.unit ? ' ' + pq.numeric.unit : ''} is correct (checked by calculation).`] : [], missed: [], wrong: ok ? [] : [Number.isFinite(v) ? `${v} is not within ${pq.numeric.tolerance * 100}% of the correct value.` : 'No number found in your answer.'], remember: pq.expected, improve: ok ? '' : `Correct value: ${Math.round(want * 1e6) / 1e6}${pq.numeric.unit ? ' ' + pq.numeric.unit : ''} (${pq.numeric.expr}).`, method: 'deterministic', feedbackLang: 'en', autoRating: ratingFromScore(ok ? 1 : 0, o.confidence) };
  }
  const src = pq.sources.map((s: any) => `${s.book_title ? s.book_title + ', ' : ''}p. ${s.page}: ${s.quote}`).join('\n');
  const sys = `${SAFETY}
You grade a learner's answer to a recall question against the BOOK's key points. The learner answered with the book closed and may write in ANY language or mix languages: judge MEANING, not wording or language; equivalent explanations and different terminology are correct. Be strict about accuracy: length earns nothing; wrong statements cost points.
Generic statements that could apply to any topic ("cash is important", "managers must plan") do NOT cover a specific key point; the learner must state the specific idea.
Grade EVERY numbered key point: "covered" = the learner states or clearly implies the idea (in any words or language), "partial" = only part of it, "missing" = absent, "contradicted" = the learner says the opposite.
Return ONLY JSON: {"points":[{"n":1,"status":"covered|partial|missing|contradicted"}],"wrong":["each incorrect statement the learner made, quoted briefly"],"understanding":0-100,"application":0-100 or null,"got_right":["…"],"missed":["important ideas absent"],"remember":"one sentence to remember","improve":"how to improve this answer","follow_up":"one probing question"}
"understanding" = does the answer show real understanding (reasoning, not just terms). "application" only for scenario/application/problem questions, else null. Write got_right/missed/wrong/remember/improve/follow_up in ${langName(fl)}; keep technical terms recognisable.`;
  const user = `Question: ${pq.question}\nKey points the answer should contain:\n${pq.key_points.map((k: string, i: number) => `${i + 1}. ${k}`).join('\n')}\nModel answer: ${pq.expected}\nSource evidence:\n${src}\n\nLearner's answer:\n<learner_answer>\n${ans.slice(0, 3000)}\n</learner_answer>`;
  const r = await ollama.chat('comprehension', [{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, temperature: 0.1 });
  const j = ollama.parseJson<any>(r.text);
  if (!j || !Array.isArray(j.points)) throw new Error('The evaluator returned an unreadable result. Please submit again.');
  const stat = new Map<number, string>(j.points.map((p: any, i: number) => [Number.isInteger(Number(p.n)) ? Number(p.n) : i + 1, String(p.status)]));
  const points = pq.key_points.map((k: string, i: number) => { const s = stat.get(i + 1) ?? 'missing'; return { point: k, status: (['covered', 'partial', 'missing', 'contradicted'].includes(s) ? s : 'missing') as 'covered' | 'partial' | 'missing' | 'contradicted' }; });
  // Length/generic-answer guard: when the answer and the book are in the same Latin-script language, a key point only counts if the answer
  // actually contains its content words (the model alone is not trusted to grade waffle). Cross-language answers are judged by meaning only.
  const ansLang = detectLanguage(ans).code;
  if (getLang(ansLang)?.script === 'Latn' && getLang(pq.lang)?.script === 'Latn') {
    const stem = (w: string) => w.slice(0, 5); const STOPW = new Set('that this with from have which their they there been when will would could about into than then also such these those because between while where what does should'.split(' '));
    const sig = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 3 && !STOPW.has(w)).map(stem));
    const a = sig(ans);
    for (const p of points) {
      const ps = sig(p.point); if (!ps.size) continue; let k = 0; for (const w of ps) if (a.has(w)) k++; const support = k / ps.size;
      if (p.status === 'covered' && support < 0.12) p.status = 'missing'; else if (p.status === 'covered' && support < 0.25) p.status = 'partial'; else if (p.status === 'partial' && support < 0.1) p.status = 'missing';
    }
  }
  const completeness = points.reduce((a: number, p: any) => a + (p.status === 'covered' ? 1 : p.status === 'partial' ? 0.5 : 0), 0) / Math.max(1, points.length);
  const wrong: string[] = (Array.isArray(j.wrong) ? j.wrong : []).map((w: unknown) => clip(w, 200)).filter(Boolean).slice(0, 5);
  const contradicted = points.filter((p: any) => p.status === 'contradicted').length;
  const accuracy = Math.max(0, Math.min(1, completeness + 0.0 - 0.25 * Math.max(wrong.length, contradicted)));
  const cap = (v: unknown) => Math.min(num01(v), completeness + 0.15); // judged understanding can never exceed the evidence of covered points
  const understanding = cap(j.understanding); const application = j.application == null ? null : cap(j.application);
  const words = ans.split(/\s+/).filter(Boolean).length;
  const needsApp = ['application', 'scenario', 'problem', 'prediction', 'critical', 'connection'].includes(pq.type) && application != null;
  let score = needsApp ? 0.4 * completeness + 0.25 * accuracy + 0.35 * (application as number) : ['factual', 'definition', 'formula'].includes(pq.type) ? 0.7 * completeness + 0.3 * accuracy : 0.45 * completeness + 0.25 * accuracy + 0.3 * understanding;
  if (words < 4) score *= 0.5; if (!ans) score = 0;
  score = Math.max(0, Math.min(1, score));
  return { score, scores: { accuracy, completeness, understanding, application: needsApp ? application : null }, points, got_right: (Array.isArray(j.got_right) ? j.got_right : []).map((x: unknown) => clip(x, 220)).slice(0, 5), missed: (Array.isArray(j.missed) ? j.missed : []).map((x: unknown) => clip(x, 220)).slice(0, 5), wrong, remember: clip(j.remember, 300), improve: clip(j.improve, 400), follow_up: clip(j.follow_up, 250), method: 'model', model: r.model, feedbackLang: fl, autoRating: ratingFromScore(score, o.confidence) };
}

// ───────────── attempts + FSRS ─────────────
export function startSession(kind: string, bookId: string | null, scope: unknown, planned: number) {
  const id = uid(); run('INSERT INTO recall_sessions (id, user_id, book_id, kind, scope, planned, started_at) VALUES (?,?,?,?,?,?,?)', id, LOCAL_USER, bookId, kind, JSON.stringify(scope ?? {}), planned, now()); return id;
}
export function endSession(id: string, status: 'completed' | 'skipped' | 'abandoned') {
  run('UPDATE recall_sessions SET status = ?, ended_at = ? WHERE id = ? AND user_id = ?', status, now(), id, LOCAL_USER);
}
export function skipRecall(bookId: string, scope: unknown) { const id = startSession('trigger', bookId, scope, 0); endSession(id, 'skipped'); return id; }

export function saveAttempt(sessionId: string | null, q: any, answer: string, ev: Evaluation, o: { confidence?: number; modality?: string; timeMs?: number }) {
  const id = uid();
  run(`INSERT INTO recall_attempts (id, session_id, question_id, user_id, answer, answer_lang, modality, confidence, score, scores, evaluation, rating, auto_rating, time_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, sessionId, q.id, LOCAL_USER, answer.slice(0, 6000), detectLanguage(answer).code, o.modality ?? 'text', o.confidence ?? null, ev.score, JSON.stringify(ev.scores), JSON.stringify({ ...ev, applied: false }), ev.autoRating, ev.autoRating, o.timeMs ?? null, now());
  if (sessionId) run('UPDATE recall_sessions SET answered = answered + 1 WHERE id = ?', sessionId);
  return id;
}

/** Apply the learner's final rating (self-rating overrides the automatic one) to FSRS exactly once. */
export function applyRating(attemptId: string, rating: Rating) {
  const a = get<any>('SELECT * FROM recall_attempts WHERE id = ? AND user_id = ?', attemptId, LOCAL_USER); if (!a) throw new Error('attempt not found');
  const ev = JSON.parse(a.evaluation); if (ev.applied) return getState(a.question_id);
  const st = get<any>('SELECT * FROM recall_state WHERE question_id = ?', a.question_id);
  const card: Card = st ? { stability: st.stability, difficulty: st.difficulty, reps: st.reps, lapses: st.lapses, state: st.state, lastReview: st.last_review, due: st.due_at } : newCard();
  const next = review(card, rating, now(), settings().retention);
  run(`INSERT INTO recall_state (question_id, stability, difficulty, reps, lapses, state, first_at, last_review, due_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(question_id) DO UPDATE SET stability = excluded.stability, difficulty = excluded.difficulty, reps = excluded.reps, lapses = excluded.lapses, state = excluded.state, last_review = excluded.last_review, due_at = excluded.due_at, first_at = COALESCE(recall_state.first_at, excluded.first_at)`,
    a.question_id, next.stability, next.difficulty, next.reps, next.lapses, next.state, now(), next.lastReview, next.due);
  run('UPDATE recall_attempts SET rating = ?, evaluation = ? WHERE id = ?', rating, JSON.stringify({ ...ev, applied: true }), attemptId);
  return getState(a.question_id);
}
export const getState = (qid: string) => { const s = get<any>('SELECT * FROM recall_state WHERE question_id = ?', qid); return s && { ...s, retrievability: retrievabilityNow({ stability: s.stability, difficulty: s.difficulty, reps: s.reps, lapses: s.lapses, state: s.state, lastReview: s.last_review, due: s.due_at }), dueInDays: Math.round(((s.due_at - now()) / DAY) * 10) / 10 }; };

// ───────────── mastery (evidence-based, per dimension) ─────────────
const DIM = (level: number, type: string) => (type === 'teach_back' || level === 3 ? 'understanding' : level <= 1 ? 'recognition' : level === 2 ? 'recall' : level >= 4 ? 'application' : 'recall');
export interface ConceptMastery { book_id: string; book_title: string; concept: string; chapter_idx: number | null; page: number | null; questions: number; attempts: number; dims: Record<string, number | null>; retention: number | null; confidenceGap: number | null; lapses: number; status: string; lastAt: number | null; due: number }

export function mastery(bookId?: string | null): ConceptMastery[] {
  const qs = all<any>(`SELECT q.id, q.book_id, q.concept, q.chapter_idx, q.page, q.level, q.type, b.title AS book_title, s.stability, s.difficulty, s.reps, s.lapses, s.state, s.last_review, s.due_at FROM recall_questions q JOIN books b ON b.id = q.book_id LEFT JOIN recall_state s ON s.question_id = q.id
      WHERE q.user_id = ? AND q.status = 'active' ${bookId ? 'AND q.book_id = ?' : ''}`, LOCAL_USER, ...(bookId ? [bookId] : []));
  const att = all<any>(`SELECT a.question_id, a.score, a.confidence, a.created_at, q.level, q.type FROM recall_attempts a JOIN recall_questions q ON q.id = a.question_id WHERE a.user_id = ? ${bookId ? 'AND q.book_id = ?' : ''} ORDER BY a.created_at`, LOCAL_USER, ...(bookId ? [bookId] : []));
  const byQ = new Map<string, any[]>(); for (const a of att) byQ.set(a.question_id, [...(byQ.get(a.question_id) ?? []), a]);
  const groups = new Map<string, any[]>(); for (const q of qs) groups.set(`${q.book_id}|${q.concept.toLowerCase()}`, [...(groups.get(`${q.book_id}|${q.concept.toLowerCase()}`) ?? []), q]);
  const out: ConceptMastery[] = [];
  for (const [, g] of groups) {
    const attempts = g.flatMap((q) => byQ.get(q.id) ?? []); const sums: Record<string, number[]> = { recognition: [], recall: [], understanding: [], application: [] };
    // most recent attempts weigh more (last 3 per dimension)
    for (const a of attempts) sums[DIM(a.level, a.type)].push(a.score);
    const dims = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, v.length ? Math.round((v.slice(-3).reduce((x, y) => x + y, 0) / Math.min(3, v.length)) * 100) / 100 : null]));
    const reviewed = g.filter((q) => q.reps > 0);
    const retention = reviewed.length ? Math.round((reviewed.reduce((s, q) => s + retrievabilityNow({ stability: q.stability, difficulty: q.difficulty, reps: q.reps, lapses: q.lapses, state: q.state, lastReview: q.last_review, due: q.due_at }), 0) / reviewed.length) * 100) / 100 : null;
    const withConf = attempts.filter((a) => a.confidence != null);
    const confidenceGap = withConf.length >= 3 ? Math.round((withConf.reduce((s, a) => s + (a.confidence - 1) / 4 - a.score, 0) / withConf.length) * 100) / 100 : null; // >0 = overconfident
    const hasApp = g.some((q) => DIM(q.level, q.type) === 'application');
    const d = dims as Record<string, number | null>;
    let status = 'untested';
    if (attempts.length) {
      status = 'recognising';
      if ((d.recall ?? 0) >= 0.6) status = 'recalling';
      if ((d.understanding ?? 0) >= 0.6 && (d.recall ?? 0) >= 0.5) status = 'understanding';
      if ((d.application ?? 0) >= 0.6 && (d.understanding ?? 0) >= 0.5) status = 'applying';
      if ((d.recall ?? 0) >= 0.75 && (d.understanding ?? 0) >= 0.75 && (!hasApp || (d.application ?? 0) >= 0.7) && (retention ?? 0) >= 0.7 && attempts.length >= 4) status = 'mastered';
    }
    out.push({ book_id: g[0].book_id, book_title: g[0].book_title, concept: g[0].concept, chapter_idx: g[0].chapter_idx, page: Math.min(...g.map((q) => q.page ?? 1e9)), questions: g.length, attempts: attempts.length, dims, retention, confidenceGap, lapses: g.reduce((s, q) => s + (q.lapses ?? 0), 0), status, lastAt: attempts.at(-1)?.created_at ?? null, due: Math.min(...g.map((q) => q.due_at ?? now())) });
  }
  return out.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
}

export function gaps(bookId?: string | null) {
  const ms = mastery(bookId); const composite = (m: ConceptMastery) => { const v = Object.values(m.dims).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const weak = ms.filter((m) => m.attempts >= 2 && ((composite(m) ?? 1) < 0.55 || m.lapses >= 2)).map((m) => ({ ...m, why: m.lapses >= 2 ? `forgotten ${m.lapses} times` : `average score ${Math.round((composite(m) ?? 0) * 100)}%` }));
  const forgotten = ms.filter((m) => m.retention != null && m.retention < 0.6).map((m) => ({ ...m, why: `estimated recall ${Math.round((m.retention ?? 0) * 100)}%` }));
  const unread = (bk: string) => get<{ page: number }>('SELECT page FROM reading_progress WHERE book_id = ?', bk)?.page ?? 0;
  const untested = ms.filter((m) => m.attempts === 0 && (m.page ?? 1e9) <= unread(m.book_id)).map((m) => ({ ...m, why: 'read but never tested' }));
  const prerequisites = weak.flatMap((w) => ms.filter((m) => m.book_id === w.book_id && (m.page ?? 0) < (w.page ?? 0) && m.chapter_idx === w.chapter_idx && ((composite(m) ?? 0) < 0.6)).slice(-2).map((m) => ({ concept: m.concept, forWeak: w.concept, page: m.page, why: `earlier in the same chapter and ${m.attempts ? 'also weak' : 'untested'}` })));
  const sessions = [
    weak.length && { kind: 'weak', label: `Practise ${weak.length} weak concept${weak.length > 1 ? 's' : ''}`, concepts: weak.slice(0, 6).map((w) => w.concept), minutes: Math.min(20, 3 + weak.length * 2) },
    forgotten.length && { kind: 'forgotten', label: `Refresh ${forgotten.length} fading concept${forgotten.length > 1 ? 's' : ''}`, concepts: forgotten.slice(0, 6).map((w) => w.concept), minutes: Math.min(15, 2 + forgotten.length * 2) },
    untested.length && { kind: 'untested', label: `Test yourself on ${untested.length} concept${untested.length > 1 ? 's' : ''} you have read`, concepts: untested.slice(0, 6).map((w) => w.concept), minutes: Math.min(15, 2 + untested.length * 2) },
  ].filter(Boolean);
  return { weak, forgotten, untested, prerequisites, sessions };
}

// ───────────── daily session builder ─────────────
export function buildSession(minutes: number, bookId?: string | null) {
  const qrows = all<any>(`SELECT q.*, b.title AS book_title, s.stability, s.difficulty AS s_diff, s.reps, s.lapses, s.state, s.last_review, s.due_at FROM recall_questions q JOIN books b ON b.id = q.book_id LEFT JOIN recall_state s ON s.question_id = q.id
      WHERE q.user_id = ? AND q.status = 'active' ${bookId ? 'AND q.book_id = ?' : ''}`, LOCAL_USER, ...(bookId ? [bookId] : []));
  const progress = new Map(all<any>('SELECT book_id, page FROM reading_progress').map((r) => [r.book_id, r.page]));
  const t = now();
  const R = (q: any) => retrievabilityNow({ stability: q.stability ?? 0, difficulty: q.s_diff ?? 0, reps: q.reps ?? 0, lapses: q.lapses ?? 0, state: q.state ?? 'new', lastReview: q.last_review ?? null, due: q.due_at ?? t }, t);
  const due = qrows.filter((q) => (q.reps ?? 0) > 0 && q.due_at <= t).sort((a, b) => R(a) - R(b)); // most-forgotten first
  const fresh = qrows.filter((q) => !(q.reps > 0) && (q.scope !== 'page' || (q.page ?? 1) <= (progress.get(q.book_id) ?? 0))).sort((a, b) => (b.page ?? 0) - (a.page ?? 0));
  const ordered: any[] = []; const budget = minutes; let spent = 0;
  const take = (arr: any[], cap: number) => { let n = 0; for (const q of arr) { const c = TIME[q.type] ?? 2; if (spent + c > budget || n >= cap || ordered.length >= 40) break; ordered.push(q); spent += c; n++; } return n; };
  const nDue = take(due, Math.ceil(budget / 1.8)); const nNew = take(fresh, Math.max(2, Math.ceil(budget / 3)));
  // interleave concepts/books instead of blocks
  const buckets = new Map<string, any[]>(); for (const q of ordered) buckets.set(`${q.book_id}|${q.concept}`, [...(buckets.get(`${q.book_id}|${q.concept}`) ?? []), q]);
  const mixed: any[] = []; const lists = [...buckets.values()]; while (lists.some((l) => l.length)) for (const l of lists) if (l.length) mixed.push(l.shift());
  return { questions: mixed.map(publicQ), plan: { minutes, estimated: Math.round(spent * 10) / 10, due: nDue, new: nNew, overdueTotal: due.length, newAvailable: fresh.length, books: new Set(mixed.map((q) => q.book_id)).size } };
}

export function dueSummary() {
  const t = now();
  const due = get<{ n: number }>(`SELECT COUNT(*) n FROM recall_state s JOIN recall_questions q ON q.id = s.question_id WHERE q.user_id = ? AND q.status = 'active' AND s.reps > 0 AND s.due_at <= ?`, LOCAL_USER, t)?.n ?? 0;
  const fresh = get<{ n: number }>(`SELECT COUNT(*) n FROM recall_questions q LEFT JOIN recall_state s ON s.question_id = q.id LEFT JOIN reading_progress p ON p.book_id = q.book_id WHERE q.user_id = ? AND q.status = 'active' AND COALESCE(s.reps, 0) = 0 AND (q.scope != 'page' OR q.page <= COALESCE(p.page, 0))`, LOCAL_USER)?.n ?? 0;
  return { due, fresh, total: get<{ n: number }>(`SELECT COUNT(*) n FROM recall_questions WHERE user_id = ? AND status = 'active'`, LOCAL_USER)?.n ?? 0 };
}

// ───────────── blurting ─────────────
export async function blurt(bookId: string, from: number, to: number, answer: string, feedbackLang?: string) {
  const text = Array.from({ length: to - from + 1 }, (_, i) => pageText(bookId, from + i)).join('\n\n').slice(0, 9000);
  if (text.trim().length < 150) throw new Error('Not enough text on those pages.');
  const fl = feedbackLang || settings().feedbackLang || detectLanguage(answer).code;
  const r = await ollama.chat('comprehension', [{ role: 'system', content: `${SAFETY}\nThe learner wrote everything they remember (book closed) about the text. First list the 6-12 key ideas of the TEXT. Then judge each against the learner's writing by MEANING (any language). Quantity of words earns nothing; wrong statements are reported. Return ONLY JSON {"ideas":[{"idea":"…","status":"remembered|partial|missing"}],"wrong":["incorrect statements the learner made"],"extra":["accurate connections or ideas beyond the text"],"summary":"2 sentences"} — write wrong/extra/summary in ${langName(fl)}; ideas in the language of the text.` },
    { role: 'user', content: `<book_excerpt>\n${text}\n</book_excerpt>\n\n<learner_writing>\n${answer.slice(0, 5000)}\n</learner_writing>` }], { json: true, temperature: 0.1 });
  const j = ollama.parseJson<any>(r.text); if (!j?.ideas?.length) throw new Error('Could not analyse your writing. Try again.');
  const ideas = j.ideas.slice(0, 14).map((i: any) => ({ idea: clip(i.idea, 200), status: ['remembered', 'partial', 'missing'].includes(i.status) ? i.status : 'missing' }));
  const wrong = (Array.isArray(j.wrong) ? j.wrong : []).map((x: unknown) => clip(x, 200)).slice(0, 6);
  const covered = ideas.reduce((a: number, i: any) => a + (i.status === 'remembered' ? 1 : i.status === 'partial' ? 0.5 : 0), 0) / ideas.length;
  const coverage = Math.max(0, covered - 0.1 * wrong.length);
  const result = { ideas, wrong, extra: (Array.isArray(j.extra) ? j.extra : []).map((x: unknown) => clip(x, 200)).slice(0, 5), summary: clip(j.summary, 400), coverage: Math.round(coverage * 100) / 100, words: answer.split(/\s+/).filter(Boolean).length, model: r.model };
  const id = uid(); run('INSERT INTO blurts (id, user_id, book_id, page_from, page_to, answer, result, created_at) VALUES (?,?,?,?,?,?,?,?)', id, LOCAL_USER, bookId, from, to, answer, JSON.stringify(result), now());
  return { id, ...result };
}

// ───────────── analytics ─────────────
export function analytics() {
  const att = all<any>(`SELECT a.score, a.rating, a.created_at, a.modality, q.level, q.type, q.chapter_idx, q.book_id, q.concept, s.reps FROM recall_attempts a JOIN recall_questions q ON q.id = a.question_id LEFT JOIN recall_state s ON s.question_id = q.id WHERE a.user_id = ? ORDER BY a.created_at`, LOCAL_USER);
  const pct = (xs: number[]) => (xs.length ? Math.round((xs.filter((x) => x >= 0.65).length / xs.length) * 100) / 100 : null);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  const byDim: Record<string, number[]> = { recognition: [], recall: [], understanding: [], application: [] }; for (const a of att) byDim[DIM(a.level, a.type)].push(a.score);
  const days = new Map<string, number[]>(); for (const a of att) { const d = new Date(a.created_at).toISOString().slice(0, 10); days.set(d, [...(days.get(d) ?? []), a.score]); }
  const weeks = new Map<string, number[]>(); for (const a of att.filter((x) => (x.reps ?? 0) > 1)) { const d = new Date(a.created_at); const k = new Date(d.getTime() - d.getUTCDay() * DAY).toISOString().slice(0, 10); weeks.set(k, [...(weeks.get(k) ?? []), a.score]); }
  const sess = all<any>(`SELECT status, COUNT(*) n FROM recall_sessions WHERE user_id = ? GROUP BY status`, LOCAL_USER);
  const chapters = new Map<string, number[]>(); for (const a of att) { const k = `${a.book_id}|${a.chapter_idx ?? 0}`; chapters.set(k, [...(chapters.get(k) ?? []), a.score]); }
  const titles = new Map(all<any>('SELECT id, title FROM books').map((b) => [b.id, b.title]));
  const chTitle = (bk: string, idx: number) => get<any>('SELECT title FROM chapters WHERE book_id = ? AND idx = ?', bk, idx)?.title ?? `Section ${idx + 1}`;
  return {
    attempts: att.length, correct: att.filter((a) => a.score >= 0.65).length, accuracy: pct(att.map((a) => a.score)), avgScore: avg(att.map((a) => a.score)), voice: att.filter((a) => a.modality === 'voice').length,
    dimensions: Object.fromEntries(Object.entries(byDim).map(([k, v]) => [k, { attempts: v.length, accuracy: pct(v), avg: avg(v) }])),
    daily: [...days.entries()].slice(-30).map(([date, v]) => ({ date, attempts: v.length, accuracy: pct(v) })),
    retentionTrend: [...weeks.entries()].slice(-12).map(([week, v]) => ({ week, reviews: v.length, retained: pct(v) })),
    sessions: Object.fromEntries(sess.map((s) => [s.status, s.n])),
    chapters: [...chapters.entries()].map(([k, v]) => { const [bk, idx] = k.split('|'); return { book: titles.get(bk), chapter: chTitle(bk, Number(idx)), attempts: v.length, avg: avg(v) }; }).sort((a, b) => (a.avg ?? 0) - (b.avg ?? 0)).slice(0, 20),
    note: 'These numbers describe your answers to the questions generated for your books. They are evidence about retrieval, not a measure of intelligence or permanent memory.',
  };
}
void tx; void getLang;
