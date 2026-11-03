// Page Intelligence Engine: a deterministic pass (instant, every page) + an optional local-model pass (progressive, resumable).
import crypto from 'node:crypto';
import { all, get, run, tx } from '../db';
import { chat, parseJson, NoModelError } from '../ollama';
import { SAFETY } from '../rag';
import { discover } from '../vocabdisc';
import { registerTask, type Ctx } from './tasks';

export const METHODS = ['simulation', '3d_visualisation', 'timeline', 'calculator', 'concept_map', 'argument_map', 'worked_example', 'algorithm_trace', 'debate', 'flashcards', 'exercise', 'video', 'podcast'] as const;
export type Method = (typeof METHODS)[number];

const LEX: Record<string, string[]> = {
  physics: 'force energy velocity mass acceleration momentum joule newton watt wave frequency voltage current resistance magnetic field thermodynamic pressure temperature gravity kinetic potential friction torque charge electron photon'.split(' '),
  mathematics: 'theorem proof lemma equation derivative integral function matrix vector probability polynomial graph limit sequence variable coefficient geometry angle'.split(' '),
  finance: 'cash revenue profit margin equity debt asset liability valuation invest capital interest dividend balance statement earnings cost return risk portfolio stock bond'.split(' '),
  economics: 'supply demand price inflation market gdp elasticity monetary fiscal equilibrium unemployment tariff consumer producer scarcity recession'.split(' '),
  history: 'war empire century king revolution treaty dynasty battle colonial army emperor republic independence ancient medieval reign'.split(' '),
  philosophy: 'argument premise ethics moral metaphysics reason virtue consciousness truth existence knowledge belief justice freedom obligation conclusion'.split(' '),
  programming: 'algorithm variable code array compiler loop recursion function class api database program software data structure syntax runtime'.split(' '),
  biology: 'cell organism gene protein dna evolution species tissue enzyme ecosystem membrane metabolism bacteria organ'.split(' '),
  chemistry: 'molecule atom reaction bond compound acid electron element solution catalyst oxidation ion periodic'.split(' '),
  engineering: 'circuit load stress beam signal design system thermal mechanical voltage transistor sensor control material tolerance'.split(' '),
  business: 'strategy customers competitive startup brand product marketing sales revenue unit economics management leadership company industry'.split(' '),
};

export interface PageBasic {
  words: number; subjects: { id: string; score: number }[]; formulas: string[]; tables: number; figures: { label: string; caption: string }[];
  years: { year: number; sentence: string }[]; definitions: { term: string; sentence: string }[]; isReference: boolean;
  terms: { word: string; level: string }[]; methodHints: { method: Method; why: string }[]; numbers: number;
}
export interface PageAI {
  main_concept?: string; supporting_concepts?: string[]; difficulty?: number; simple?: string; previous?: string; next?: string;
  questions?: string[]; teaching_methods?: { method: string; why: string }[]; needs?: string[];
}

const hash = (t: string) => crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);
const sentenceAt = (t: string, i: number) => { let s = i; while (s > 0 && !/[.!?\n]/.test(t[s - 1])) s--; let e = i; while (e < t.length && !/[.!?\n]/.test(t[e])) e++; return t.slice(s, e + 1).trim().slice(0, 300); };

export async function basicAnalysis(text: string): Promise<PageBasic> {
  const words = (text.match(/[A-Za-z']+/g) ?? []);
  const lower = words.map((w) => w.toLowerCase());
  const subjects = Object.entries(LEX).map(([id, kw]) => ({ id, score: Math.round((lower.filter((w) => kw.includes(w)).length / Math.max(60, words.length)) * 1000) / 10 }))
    .filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);

  const formulas: string[] = [];
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.length < 5 || l.length > 140) continue;
    const mathy = /[=≈≠≤≥∑∫√±×÷∂Δπσμλθ^]/.test(l);
    if (/=/.test(l) && mathy && /[A-Za-zΑ-Ωα-ω]\s*[\w()\[\]^_]*\s*=/.test(l) && (l.match(/[A-Za-z]{4,}/g) ?? []).length <= 8) formulas.push(l);
    else if (/[∑∫√±∂Δ]/.test(l) && l.split(/\s+/).length < 24) formulas.push(l);
  }

  const lines = text.split('\n');
  let tables = 0, run3 = 0;
  for (const l of lines) { const nums = (l.match(/[$€£]?\d[\d,.]*%?/g) ?? []).length; if (nums >= 3) { if (++run3 === 3) tables++; } else run3 = 0; }

  const figures: PageBasic['figures'] = [];
  for (const l of lines) { const m = l.match(/\b(Fig(?:ure)?\.?|Table|Exhibit|Chart|Diagram)\s*(\d+(?:[.\-]\d+)?)/i); if (m && figures.length < 8) figures.push({ label: `${m[1]} ${m[2]}`, caption: l.trim().slice(0, 160) }); }

  const years: PageBasic['years'] = [];
  const yr = /\b(1[0-9]{3}|20[0-4][0-9])\b/g; let m: RegExpExecArray | null;
  while ((m = yr.exec(text)) && years.length < 12) if (!years.some((y) => y.year === Number(m![1]))) years.push({ year: Number(m[1]), sentence: sentenceAt(text, m.index) });

  const definitions: PageBasic['definitions'] = [];
  const def = /\b([A-Z][A-Za-z\- ]{2,40}?|[a-z][a-z\- ]{3,30}?)\s+(?:is|are)\s+(?:defined as|called|known as|referred to as|the term for)\b|\b([A-Za-z][A-Za-z\- ]{2,30}?)\s+refers to\b/g;
  while ((m = def.exec(text)) && definitions.length < 8) definitions.push({ term: (m[1] ?? m[2]).trim(), sentence: sentenceAt(text, m.index) });

  const head = text.slice(0, 160).toLowerCase();
  const cites = (text.match(/\(\s*[A-Z][A-Za-z]+(?: et al\.)?,?\s+(?:19|20)\d{2}\s*\)|\[\d{1,3}\]/g) ?? []).length;
  const isReference = /^(references|bibliography|further reading|works cited|index)\b/.test(head.trim()) || cites >= 8;

  const terms = (await discover(text, { limit: 8, withDefs: false })).map((t) => ({ word: t.word, level: t.level }));
  const numbers = (text.match(/\b\d[\d,.]*\b/g) ?? []).length;

  // rule-based teaching-method hints; the AI pass can refine them
  const top = subjects[0]?.id; const h: PageBasic['methodHints'] = [];
  if (formulas.length && (top === 'physics' || top === 'engineering')) h.push({ method: 'simulation', why: 'physical formulas that can be explored by changing variables' });
  if (formulas.length && top === 'mathematics') h.push({ method: 'worked_example', why: 'equations to walk through step by step' });
  if (years.length >= 3 && (top === 'history' || !top)) h.push({ method: 'timeline', why: `${years.length} dated events` });
  if ((top === 'finance' || top === 'business' || top === 'economics') && numbers >= 6) h.push({ method: 'calculator', why: 'quantities that can be modelled with adjustable inputs' });
  if (top === 'philosophy') h.push({ method: 'argument_map', why: 'argumentative reasoning' });
  if (top === 'programming') h.push({ method: 'algorithm_trace', why: 'programming/algorithm content' });
  if (definitions.length >= 2) h.push({ method: 'flashcards', why: `${definitions.length} definitions to remember` });
  if (!h.length && words.length > 150) h.push({ method: 'concept_map', why: 'general conceptual content' });
  return { words: words.length, subjects, formulas: formulas.slice(0, 10), tables, figures, years, definitions, isReference, terms, methodHints: h, numbers };
}

/** Run the deterministic pass for every page that is new or whose text changed. Fast; safe to call repeatedly. */
export async function ensureBasic(bookId: string): Promise<number> {
  const pages = all<{ page: number; text: string }>('SELECT page, text FROM pages WHERE book_id = ? ORDER BY page', bookId);
  const have = new Map(all<{ page: number; content_hash: string }>('SELECT page, content_hash FROM page_intel WHERE book_id = ?', bookId).map((r) => [r.page, r.content_hash]));
  let n = 0;
  for (const p of pages) {
    const h = hash(p.text);
    if (have.get(p.page) === h) continue;
    const basic = await basicAnalysis(p.text);
    run(`INSERT INTO page_intel (book_id, page, content_hash, level, data, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(book_id, page) DO UPDATE SET content_hash = excluded.content_hash, level = 'basic', data = excluded.data, model = NULL, error = NULL, updated_at = excluded.updated_at`,
      bookId, p.page, h, 'basic', JSON.stringify({ basic }), Date.now());
    n++;
  }
  return n;
}

export const pageIntel = (bookId: string, page: number) => {
  const r = get<any>('SELECT * FROM page_intel WHERE book_id = ? AND page = ?', bookId, page);
  return r ? { ...r, data: JSON.parse(r.data) } : null;
};

const clip = (s: unknown, n = 300) => String(s ?? '').slice(0, n);

export async function aiAnalysePage(bookId: string, page: number): Promise<PageAI> {
  const cur = get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', bookId, page);
  if (!cur || cur.text.trim().length < 80) throw new Error('page has too little text');
  const prev = get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', bookId, page - 1);
  const next = get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', bookId, page + 1);
  const sys = `${SAFETY}\nYou analyse ONE book page for a learning platform. Use only the page text (plus the short previous/next snippets for relationships). Return ONLY JSON:
{"main_concept":"short phrase","supporting_concepts":["..."],"difficulty":1-5,"simple":"1-2 sentence plain-language explanation","previous":"how this connects to the previous page (or empty)","next":"how it leads to the next page (or empty)","questions":["2 comprehension questions answerable from the page"],"teaching_methods":[{"method":"one of ${METHODS.join('|')}","why":"short reason"}],"needs":["subset of: visualisation, animation, simulation, worked_example, debate, exercise, repetition, none"]}
Choose teaching methods that truly fit the content (a formula-heavy physics page → simulation; dated events → timeline; an argument → debate/argument_map). Do not invent facts.`;
  const r = await chat('comprehension', [{ role: 'system', content: sys }, { role: 'user', content: `<book_excerpt>\nPREVIOUS (end): ${prev?.text.slice(-300) ?? ''}\n\nPAGE ${page}:\n${cur.text.slice(0, 5000)}\n\nNEXT (start): ${next?.text.slice(0, 300) ?? ''}\n</book_excerpt>` }], { json: true, temperature: 0.2 });
  const j = parseJson<any>(r.text);
  if (!j?.main_concept) throw new Error('unreadable model output');
  const ai: PageAI = {
    main_concept: clip(j.main_concept, 120), supporting_concepts: (Array.isArray(j.supporting_concepts) ? j.supporting_concepts : []).map((x: unknown) => clip(x, 80)).slice(0, 8),
    difficulty: Math.min(5, Math.max(1, Number(j.difficulty) || 3)), simple: clip(j.simple, 400), previous: clip(j.previous, 200), next: clip(j.next, 200),
    questions: (Array.isArray(j.questions) ? j.questions : []).map((x: unknown) => clip(x, 200)).slice(0, 3),
    teaching_methods: (Array.isArray(j.teaching_methods) ? j.teaching_methods : []).filter((m: any) => METHODS.includes(m?.method)).map((m: any) => ({ method: m.method, why: clip(m.why, 160) })).slice(0, 4),
    needs: (Array.isArray(j.needs) ? j.needs : []).map((x: unknown) => clip(x, 30)).slice(0, 6),
  };
  const rec = pageIntel(bookId, page);
  run(`UPDATE page_intel SET level = 'ai', data = ?, model = ?, error = NULL, updated_at = ? WHERE book_id = ? AND page = ?`, JSON.stringify({ ...(rec?.data ?? {}), ai }), r.model, Date.now(), bookId, page);
  return ai;
}

/** Progressive AI pass over the whole book. Resumable: pages already at level 'ai' (unchanged text) are skipped. */
registerTask('analyse-book', async ({ task, payload, update, cancelled }: Ctx) => {
  const bookId = task.book_id as string;
  update(0.01, 'Analysing page structure…', 'analysing');
  await ensureBasic(bookId);
  if (payload.basicOnly) return update(1, 'Structure analysed');
  const todo = all<{ page: number }>(`SELECT p.page FROM pages p LEFT JOIN page_intel i ON i.book_id = p.book_id AND i.page = p.page
      WHERE p.book_id = ? AND (i.level IS NULL OR i.level != 'ai') AND length(p.text) >= 80 ORDER BY p.page`, bookId);
  const total = get<{ n: number }>('SELECT COUNT(*) n FROM pages WHERE book_id = ?', bookId)?.n ?? 1;
  const done0 = total - todo.length;
  let i = 0;
  for (const { page } of todo) {
    if (cancelled()) return;
    update((done0 + i) / total, `Understanding page ${page} (${done0 + i + 1}/${total})…`, 'analysing');
    try { await aiAnalysePage(bookId, page); }
    catch (e: any) {
      if (e instanceof NoModelError) throw e;
      run('UPDATE page_intel SET error = ?, updated_at = ? WHERE book_id = ? AND page = ?', String(e?.message ?? e).slice(0, 200), Date.now(), bookId, page);
    }
    i++;
  }
});

void tx;
