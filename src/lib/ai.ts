import { all, get, run, uid, tx, me } from './db';
import { chat, parseJson } from './ollama';
import { pageText, chapterOf, SAFETY } from './rag';

export const SUMMARY_KINDS: Record<string, string> = {
  quick: 'QUICK SUMMARY: 3–5 concise bullet points.',
  detailed: 'DETAILED SUMMARY: explain all important ideas and how they relate to each other.',
  simple: 'SIMPLE EXPLANATION: explain in beginner-friendly language with an analogy if helpful.',
  technical: 'TECHNICAL SUMMARY: preserve technical terminology, formulas and assumptions.',
  takeaways: 'KEY TAKEAWAYS: the important lessons, as a short bulleted list.',
  terms: 'IMPORTANT TERMS: list the key terms that appear, each with a one-line definition based on how the text uses it.',
  arguments: "ARGUMENTS: the author's claims, evidence, assumptions and conclusions.",
  connections: 'CONNECTIONS: how this passage connects to other parts of the book (use only the supplied related excerpts).',
  memory: 'MEMORY: what is most important to remember, and a suggested mnemonic or one-line recall cue.',
};

const wrap = (t: string) => `<book_excerpt>\n${t}\n</book_excerpt>`;

const GROUP_CHARS = 9000;
const MAX_GROUPS = 16;

/** Summarise a selection or page range. Ranges too long for the model's context are summarised
 *  section by section and then combined (map-reduce); if even that is too long, sections are sampled
 *  evenly and the result says so — it never silently truncates. */
export async function summarize(bookId: string, kind: string, from: number, to: number, selection?: string, related?: string): Promise<{ text: string; model: string; note?: string }> {
  const book = get<any>('SELECT title, author FROM books WHERE id = ?', bookId);
  const spec = SUMMARY_KINDS[kind] ?? SUMMARY_KINDS.quick;
  const scope = selection ? 'the selected passage' : from === to ? `page ${from}` : `pages ${from}–${to}`;
  const ch = chapterOf(bookId, from);
  const sys = `${SAFETY}
You summarise only from the supplied text of "${book?.title}"${book?.author ? ` by ${book.author}` : ''}${ch ? ` (chapter: ${ch.title})` : ''}. Do not add facts that are not in the text. If the text is too short or empty to answer, say so. Cite page numbers as (p. N) where the text provides [Page N] markers. Format in Markdown.`;
  const ask = (text: string, extra = '') => chat('summary', [{ role: 'system', content: sys }, { role: 'user', content: `${spec}

Summarise ${scope}.${extra}

${wrap(text)}${related ? `

Related excerpts from elsewhere in the book:
${wrap(related)}` : ''}` }], { temperature: 0.2 });

  if (selection) return ask(selection);
  const rows = all<{ page: number; text: string }>('SELECT page, text FROM pages WHERE book_id = ? AND page BETWEEN ? AND ? ORDER BY page', bookId, from, to);
  const full = rows.map((r) => `[Page ${r.page}]
${r.text}`).join('\n\n');
  if (full.length <= 12000) return ask(full);

  // map: group pages into ~9k char sections
  const groups: { from: number; to: number; text: string }[] = [];
  let cur: { from: number; to: number; text: string } | null = null;
  for (const r of rows) {
    const t = `[Page ${r.page}]
${r.text}

`;
    if (!cur || cur.text.length + t.length > GROUP_CHARS) { cur = { from: r.page, to: r.page, text: '' }; groups.push(cur); }
    cur.text += t; cur.to = r.page;
  }
  let used = groups; let note: string | undefined;
  if (groups.length > MAX_GROUPS) {
    const step = groups.length / MAX_GROUPS;
    used = Array.from({ length: MAX_GROUPS }, (_, i) => groups[Math.floor(i * step)]);
    note = `Very long range: summarised ${MAX_GROUPS} evenly spaced sections out of ${groups.length}; the rest was skipped.`;
  }
  const partials: string[] = []; let model = '';
  for (const g of used) {
    const r = await chat('summary', [{ role: 'system', content: sys }, { role: 'user', content: `Summarise pages ${g.from}–${g.to} in 4-6 bullet points keeping page citations (p. N).

${wrap(g.text)}` }], { temperature: 0.2 });
    model = r.model; partials.push(`### Pages ${g.from}–${g.to}
${r.text}`);
  }
  const combined = partials.join('\n\n');
  const final = await chat('summary', [{ role: 'system', content: sys }, { role: 'user', content: `${spec}

Below are summaries of consecutive sections of ${scope}. Combine them into one coherent result for the whole range, keeping page citations. Use only what the section summaries say.

${wrap(combined.slice(0, 14000))}` }], { temperature: 0.2 });
  return { text: final.text, model: model || final.model, note };
}

export const GOAL_SECTIONS = ['concepts', 'principles', 'applications', 'frameworks', 'terminology', 'examples', 'lessons', 'connections', 'questions'] as const;

export const EXTRA_KINDS = ['definitions', 'formulas', 'mentalModels', 'arguments', 'evidence', 'assumptions', 'people', 'processes', 'caseStudies', 'insights'] as const;

export async function extractForGoal(bookId: string, goalId: string, page: number, types?: string[]) {
  const goal = get<any>('SELECT * FROM goals WHERE id = ? AND user_id = ?', goalId, me());
  if (!goal) throw new Error('Goal not found');
  const text = pageText(bookId, page, page, 7000);
  const ch = chapterOf(bookId, page);
  const sys = `${SAFETY}
You extract knowledge from a book page that is specifically relevant to ONE learner goal. Use only the page text. Skip anything irrelevant to the goal instead of padding; at most 4 items per list; keep each item under 25 words.
Reply with ONLY a JSON object with exactly these keys: "concepts" (list of objects with "name", "why" (why it matters for THIS goal), "summary"), "principles", "applications", "frameworks", "examples", "lessons", "connections", "questions" (each a list of short strings), and "terminology" (list of objects with "term", "meaning").
Example of the shape: {"concepts":[{"name":"Unit economics","why":"shows whether each sale makes or loses money","summary":"Revenue and cost per customer."}],"principles":["Growth cannot fix negative margins"],"applications":[],"frameworks":[],"examples":[],"lessons":[],"connections":[],"questions":[],"terminology":[{"term":"CAC","meaning":"cost to acquire a customer"}]}
Use empty lists when the page has nothing relevant.
Extra optional keys (each a list of short strings, only when asked for): definitions, formulas, mentalModels, arguments, evidence, assumptions, people, processes, caseStudies, insights.${types?.length ? `
The reader only wants these types: ${types.join(', ')}. Fill ONLY those keys and set every other key to an empty list.` : ''}`;
  const user = `GOAL: ${goal.title}
Description: ${goal.description ?? ''}
Current level: ${goal.level}
Desired outcome: ${goal.outcome ?? ''}${goal.deadline ? `
Deadline: ${goal.deadline}` : ''}

Chapter: ${ch?.title ?? 'n/a'}

${wrap(text)}`;
  let r = await chat('knowledge', [{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, temperature: 0.3 }).catch(() => null);
  if (!r || !parseJson(r.text)) r = await chat('knowledge', [{ role: 'system', content: sys }, { role: 'user', content: user }], { json: false, temperature: 0.2 });
  const j = parseJson<any>(r.text);
  if (!j) throw new Error('The model did not return valid JSON. Try again or choose a stronger model in Settings.');
  // Small models sometimes wrap list items in objects; flatten to plain strings so UI + storage stay simple.
  const flat = (it: any): string => (typeof it === 'string' ? it : it && typeof it === 'object' ? String(it.name ?? it.text ?? it.lesson ?? it.item ?? Object.values(it).find((v) => typeof v === 'string') ?? '') : String(it ?? ''));
  for (const k of ['principles', 'applications', 'frameworks', 'examples', 'lessons', 'connections', 'questions', ...EXTRA_KINDS]) j[k] = (Array.isArray(j[k]) ? j[k] : []).map(flat).filter(Boolean);
  j.concepts = (Array.isArray(j.concepts) ? j.concepts : []).filter((c: any) => c && typeof c === 'object' && c.name);
  j.terminology = (Array.isArray(j.terminology) ? j.terminology : []).filter((c: any) => c && c.term);
  return { goal, extract: j, model: r.model };
}

/** Persist concepts from an extract into the knowledge library and auto-link related concepts. */
export function saveExtract(goalId: string, bookId: string, page: number, extract: any) {
  const created: string[] = [];
  tx(() => {
    const now = Date.now();
    const ids: string[] = [];
    for (const c of extract.concepts ?? []) {
      const name = String(c.name ?? '').trim().slice(0, 120); if (!name) continue;
      const existing = get<{ id: string }>('SELECT id FROM concepts WHERE user_id = ? AND lower(name) = lower(?)', me(), name);
      const cid = existing?.id ?? uid();
      if (!existing) run('INSERT INTO concepts (id, user_id, name, summary, created_at) VALUES (?,?,?,?,?)', cid, me(), name, String(c.summary ?? ''), now);
      run('INSERT INTO goal_concepts (id, goal_id, concept_id, book_id, page, why, category, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?)', uid(), goalId, cid, bookId, page, String(c.why ?? ''), 'concept', String(c.summary ?? ''), now);
      ids.push(cid); created.push(name);
    }
    for (const sec of ['principles', 'frameworks', 'applications', 'lessons', 'examples', ...EXTRA_KINDS] as const) {
      for (const item of extract[sec] ?? []) {
        const name = String(typeof item === 'string' ? item : item?.name ?? '').trim().slice(0, 140); if (!name) continue;
        const existing = get<{ id: string }>('SELECT id FROM concepts WHERE user_id = ? AND lower(name) = lower(?)', me(), name);
        const cid = existing?.id ?? uid();
        if (!existing) run('INSERT INTO concepts (id, user_id, name, summary, kind, created_at) VALUES (?,?,?,?,?,?)', cid, me(), name, '', sec.replace(/s$/, ''), now);
        run('INSERT INTO goal_concepts (id, goal_id, concept_id, book_id, page, why, category, created_at) VALUES (?,?,?,?,?,?,?,?)', uid(), goalId, cid, bookId, page, '', sec, now);
        created.push(name);
      }
    }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++)
      run("INSERT OR IGNORE INTO concept_relationships (id, a_id, b_id, kind) VALUES (?,?,?,'co-occurs')", uid(), ids[i], ids[j]);
  });
  return created;
}

export async function generateCards(bookId: string, from: number, to: number, count = 6) {
  const text = pageText(bookId, from, to, 8000);
  const sys = `${SAFETY}\nCreate ${count} high-quality study flashcards strictly from the text. Each must be answerable from the text, test one idea, and include the exact short source quote. Return ONLY JSON: {"cards":[{"front":"question","back":"answer","quote":"short verbatim quote from the text","page":N}]}`;
  const r = await chat('knowledge', [{ role: 'system', content: sys }, { role: 'user', content: wrap(text) }], { json: true, temperature: 0.3 });
  const j = parseJson<any>(r.text);
  const cards = (j?.cards ?? []).filter((c: any) => c.front && c.back);
  if (!cards.length) throw new Error('No flashcards could be generated from this text.');
  return { cards, model: r.model };
}

export async function generateQuiz(bookId: string, from: number, to: number, count = 5) {
  const text = pageText(bookId, from, to, 9000);
  const sys = `${SAFETY}\nWrite a quiz of ${count} questions strictly from the text, mixing types. Return ONLY JSON: {"questions":[{"type":"mcq"|"tf"|"short","q":"","options":["A","B","C","D"] (mcq only),"answer":"for mcq the exact correct option text; for tf 'true' or 'false'; for short a model answer","explanation":"why","page":N}]}`;
  const r = await chat('knowledge', [{ role: 'system', content: sys }, { role: 'user', content: wrap(text) }], { json: true, temperature: 0.4 });
  const j = parseJson<any>(r.text);
  const questions = (j?.questions ?? []).filter((q: any) => q.q && q.answer);
  if (!questions.length) throw new Error('No quiz could be generated from this text.');
  return { questions, model: r.model };
}

export async function explainWord(word: string, sentence: string, mode: 'word' | 'phrase') {
  const sys = `${SAFETY}\nYou are a precise language tutor. Be concise. Return ONLY JSON.`;
  const user = mode === 'word'
    ? `Word: "${word}"\nSentence it appears in: "${sentence}"\nReturn {"contextual_meaning":"what it means in THIS sentence","etymology":"brief etymology if you are confident, else empty string","examples":["2 new example sentences"],"related":["3 related words"],"translation_hint":""}`
    : `Phrase: "${word}"\nContext: "${sentence}"\nReturn {"simplified":"plain-language meaning","idioms":"any idiom explained, else empty","difficult_expressions":"hard words/expressions explained","grammar":"brief grammar note","examples":["2 alternative example sentences using similar structure"]}`;
  const r = await chat('vocabulary', [{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, temperature: 0.2 });
  // Small models sometimes return nested objects/arrays where a string was asked for; flatten so the UI never renders an object.
  const flat = (v: any): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(flat).filter(Boolean).join('; ') : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${flat(x)}`).join('; ') : v == null ? '' : String(v));
  const j = parseJson<any>(r.text) ?? {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(j)) out[k] = k === 'examples' || k === 'related' ? (Array.isArray(v) ? v.map(flat).filter(Boolean) : flat(v) ? [flat(v)] : []) : flat(v);
  return { ...out, model: r.model };
}

export async function translate(text: string, lang: string) {
  const r = await chat('vocabulary', [{ role: 'system', content: 'Translate the user text. Output only the translation.' }, { role: 'user', content: `Translate into ${lang}:\n${text}` }], { temperature: 0.1 });
  return r;
}

export const saveConversationMessage = (convId: string, role: string, content: string, citations?: unknown, model?: string) =>
  run('INSERT INTO messages (conversation_id, role, content, citations, model, created_at) VALUES (?,?,?,?,?,?)', convId, role, content, citations ? JSON.stringify(citations) : null, model ?? null, Date.now());

export { all };
