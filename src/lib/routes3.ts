// Learning engine: reading modes, concept mastery, teach-it-back, concept quizzes, goal gap analysis, reports.
import { all, get, run, uid, LOCAL_USER } from './db';
import * as ollama from './ollama';
import { pageText, chapterOf, SAFETY } from './rag';
import { retrieveLibrary } from './library';
import type { Kit } from './routes2';

const now = () => Date.now();
const wrap = (t: string) => `<book_excerpt>\n${t}\n</book_excerpt>`;

export const MODES: Record<string, { label: string; prompt: string }> = {
  learning: { label: 'Learning', prompt: 'Identify the 4-6 concepts on this page worth retaining, each with a one-line explanation, then the vocabulary a learner might not know, then one sentence on what to remember.' },
  deep: { label: 'Deep understanding', prompt: 'Explain the difficult ideas on this page step by step, how they relate to each other, and why each step follows. Use plain language and flag anything the page assumes the reader already knows.' },
  critical: { label: 'Critical thinking', prompt: "Identify the author's assumptions, the arguments made, the evidence offered, weaknesses or gaps in reasoning, and counter-arguments a sceptic could raise. Separate what the text claims from your own critique." },
  exam: { label: 'Exam', prompt: 'List the definitions, formulas, key facts and lists a student should memorise from this page, then write 4 likely exam questions (with short model answers drawn from the text).' },
  research: { label: 'Research', prompt: 'Extract the claims, the supporting evidence for each, any references or sources the text mentions, and the unresolved questions or limits the page leaves open.' },
  goal: { label: 'Goal', prompt: 'Using the reader\'s active goal(s), say what on this page matters for them, how they could apply it, and what is irrelevant to the goal.' },
  language: { label: 'Language learning', prompt: 'Pick out the useful vocabulary, collocations and idiomatic expressions, explain 2-3 interesting grammatical constructions or sentence patterns found in the text, and note any pronunciation traps.' },
};

const clamp = (n: unknown) => Math.max(0, Math.min(100, Number(n) || 0));

export function updateMastery(conceptId: string, kind: string, score: number, detail?: string) {
  const cur = get<{ score: number; attempts: number }>('SELECT score, attempts FROM concept_mastery WHERE concept_id = ?', conceptId);
  const next = cur && cur.attempts > 0 ? cur.score * 0.6 + score * 0.4 : score * 0.7;
  run(`INSERT INTO concept_mastery (concept_id, score, attempts, last_at) VALUES (?,?,?,?) ON CONFLICT(concept_id) DO UPDATE SET score = excluded.score, attempts = attempts + 1, last_at = excluded.last_at`, conceptId, next, 1, now());
  run('INSERT INTO concept_events (concept_id, kind, score, detail, created_at) VALUES (?,?,?,?,?)', conceptId, kind, score, detail ?? null, now());
  return next;
}

function conceptSource(conceptId: string) {
  const c = get<any>('SELECT * FROM concepts WHERE id = ? AND user_id = ?', conceptId, LOCAL_USER);
  if (!c) return null;
  const gc = all<any>(`SELECT gc.book_id, gc.page, gc.why, gc.detail, b.title AS book_title FROM goal_concepts gc LEFT JOIN books b ON b.id = gc.book_id WHERE gc.concept_id = ? ORDER BY gc.created_at LIMIT 3`, conceptId);
  const passages = gc.filter((g) => g.book_id && g.page).map((g) => ({ book_id: g.book_id, page: g.page, title: g.book_title, text: pageText(g.book_id, g.page, g.page, 3500) }));
  return { concept: c, links: gc, passages };
}

export function registerAnalytics({ on, J, bad, body, book, aiError }: Kit) {
  // ── reading modes ──
  on('GET', '/modes', () => Object.entries(MODES).map(([id, m]) => ({ id, label: m.label })));
  on('POST', '/ai/mode-analysis', async ({ req }) => {
    const b = await body(req); const bk = book(b.bookId); if (!bk) return bad('Not found', 404);
    const mode = MODES[b.mode]; if (!mode) return bad('unknown mode');
    const page = Math.min(Math.max(1, Number(b.page) || 1), bk.page_count);
    const goals = all<any>('SELECT title, description, outcome FROM goals WHERE user_id = ? AND active = 1', LOCAL_USER);
    if (b.mode === 'goal' && !goals.length) return bad('Create a goal first (Goal Lens) — Goal mode filters the page through your active goals.');
    const ch = chapterOf(b.bookId, page);
    try {
      const r = await ollama.chat('comprehension', [
        { role: 'system', content: `${SAFETY}\nYou analyse one page of "${bk.title}"${ch ? ` (chapter "${ch.title}")` : ''} in "${mode.label}" mode. Use only the page text; do not add facts. Cite page as (p. ${page}). Be concise and structured in Markdown.${b.mode === 'goal' ? `\nActive goals: ${goals.map((g) => `${g.title}${g.outcome ? ` → ${g.outcome}` : ''}`).join('; ')}` : ''}` },
        { role: 'user', content: `${mode.prompt}\n\n${wrap(pageText(b.bookId, page, page, 7000))}` }], { temperature: 0.25 });
      return { text: r.text, model: r.model };
    } catch (e) { return aiError(e); }
  });

  // ── concept mastery, quiz, teach-back ──
  on('GET', '/mastery', () => all(`SELECT c.id, c.name, c.summary, COALESCE(m.score, 0) AS score, COALESCE(m.attempts, 0) AS attempts, m.last_at,
      (SELECT GROUP_CONCAT(DISTINCT g.title) FROM goal_concepts gc JOIN goals g ON g.id = gc.goal_id WHERE gc.concept_id = c.id) AS goals,
      (SELECT b.title FROM goal_concepts gc JOIN books b ON b.id = gc.book_id WHERE gc.concept_id = c.id LIMIT 1) AS book_title,
      (SELECT gc.page FROM goal_concepts gc WHERE gc.concept_id = c.id LIMIT 1) AS page
    FROM concepts c LEFT JOIN concept_mastery m ON m.concept_id = c.id WHERE c.user_id = ? ORDER BY COALESCE(m.last_at, 0) ASC, c.created_at DESC LIMIT 300`, LOCAL_USER));
  on('DELETE', '/concepts/:id', ({ p }) => { run('DELETE FROM concepts WHERE id = ? AND user_id = ?', p.id, LOCAL_USER); return { ok: true }; });
  on('GET', '/concepts/:id', ({ p }) => {
    const s = conceptSource(p.id); if (!s) return bad('Not found', 404);
    return { ...s.concept, links: s.links, mastery: get('SELECT * FROM concept_mastery WHERE concept_id = ?', p.id) ?? null,
      events: all('SELECT kind, score, created_at FROM concept_events WHERE concept_id = ? ORDER BY created_at DESC LIMIT 20', p.id),
      teachbacks: all('SELECT explanation, feedback, accuracy, depth, created_at FROM teachbacks WHERE concept_id = ? ORDER BY created_at DESC LIMIT 5', p.id) };
  });
  on('POST', '/ai/concept-quiz', async ({ req }) => {
    const b = await body(req);
    const ids: string[] = Array.isArray(b.conceptIds) && b.conceptIds.length ? b.conceptIds
      : all<any>(`SELECT DISTINCT gc.concept_id AS id FROM goal_concepts gc JOIN goals g ON g.id = gc.goal_id LEFT JOIN concept_mastery m ON m.concept_id = gc.concept_id
          WHERE g.user_id = ? ${b.goalId ? 'AND g.id = ?' : ''} ORDER BY COALESCE(m.score, 0) ASC LIMIT 5`, LOCAL_USER, ...(b.goalId ? [b.goalId] : [])).map((r) => r.id);
    const src = ids.map((id) => conceptSource(id)).filter(Boolean) as NonNullable<ReturnType<typeof conceptSource>>[];
    if (!src.length) return bad('Save some concepts with Goal Lens first.');
    try {
      const material = src.map((s, i) => `### Concept ${i + 1}: ${s.concept.name}\nSaved summary: ${s.concept.summary ?? ''}\n${s.passages[0] ? `Source passage (${s.passages[0].title}, p. ${s.passages[0].page}):\n${s.passages[0].text.slice(0, 1800)}` : ''}`).join('\n\n');
      const r = await ollama.chat('knowledge', [
        { role: 'system', content: `${SAFETY}\nWrite one quiz question per concept (mix mcq, tf, short), answerable from the provided summary/passage only. Return ONLY JSON {"questions":[{"concept":N (1-based),"type":"mcq"|"tf"|"short","q":"","options":["A","B","C","D"] (mcq only),"answer":"mcq: exact correct option; tf: true|false; short: model answer","explanation":""}]}` },
        { role: 'user', content: wrap(material) }], { json: true, temperature: 0.3 });
      const qs = (ollama.parseJson<any>(r.text)?.questions ?? []).filter((q: any) => q?.q && q?.answer && src[Number(q.concept) - 1])
        .map((q: any) => ({ ...q, conceptId: src[Number(q.concept) - 1].concept.id, conceptName: src[Number(q.concept) - 1].concept.name }));
      if (!qs.length) return bad('The model could not produce usable questions. Try again.', 502);
      const id = uid();
      run('INSERT INTO quizzes VALUES (?,?,?,?,?,?,?)', id, LOCAL_USER, null, 'Concept quiz', 'concepts', JSON.stringify(qs), now());
      return { id, questions: qs, model: r.model };
    } catch (e) { return aiError(e); }
  });
  on('POST', '/mastery/record', async ({ req }) => {
    const b = await body(req);
    const results: { conceptId: string; correct: boolean }[] = Array.isArray(b.results) ? b.results : [];
    const out: Record<string, number> = {};
    for (const r of results) if (r.conceptId && get('SELECT 1 FROM concepts WHERE id = ? AND user_id = ?', r.conceptId, LOCAL_USER)) out[r.conceptId] = updateMastery(r.conceptId, 'quiz', r.correct ? 100 : 0);
    return { updated: out };
  });
  on('POST', '/ai/teach-back', async ({ req }) => {
    const b = await body(req);
    const explanation = String(b.explanation ?? '').trim().slice(0, 4000);
    if (explanation.split(/\s+/).length < 8) return bad('Explain it in a few sentences first.');
    const s = conceptSource(b.conceptId); if (!s) return bad('Concept not found', 404);
    try {
      const r = await ollama.chat('comprehension', [
        { role: 'system', content: `${SAFETY}\nYou evaluate a learner's own-words explanation of a concept against the SOURCE material only. Be fair and specific; do not reward fluent but wrong answers; do not penalise correct paraphrase. Return ONLY JSON {"accuracy":0-100,"depth":0-100,"application":0-100,"missing":["important points absent"],"misunderstandings":["things stated incorrectly vs the source"],"feedback":"2-4 sentences, second person","followUps":["2 probing questions"]}` },
        { role: 'user', content: `Concept: ${s.concept.name}\nSaved summary: ${s.concept.summary ?? ''}\n${s.passages.map((p) => `Source (${p.title}, p. ${p.page}):\n${p.text.slice(0, 2500)}`).join('\n\n')}\n\nLearner's explanation:\n${wrap(explanation)}` }], { json: true, temperature: 0.2 });
      const j = ollama.parseJson<any>(r.text); if (!j) return bad('The model returned an unreadable evaluation. Try again.', 502);
      const accuracy = clamp(j.accuracy), depth = clamp(j.depth), application = clamp(j.application);
      const mastery = updateMastery(s.concept.id, 'teach-back', accuracy * 0.5 + depth * 0.3 + application * 0.2, explanation.slice(0, 200));
      run('INSERT INTO teachbacks (id, concept_id, explanation, feedback, accuracy, depth, created_at) VALUES (?,?,?,?,?,?,?)', uid(), s.concept.id, explanation, String(j.feedback ?? ''), accuracy, depth, now());
      return { accuracy, depth, application, missing: j.missing ?? [], misunderstandings: j.misunderstandings ?? [], feedback: j.feedback ?? '', followUps: j.followUps ?? [], mastery, model: r.model, evaluatedAgainst: s.passages.map((p) => `${p.title} p. ${p.page}`) };
    } catch (e) { return aiError(e); }
  });

  // ── goal intelligence 2.0 ──
  on('GET', '/goals/:id/gaps', ({ p }) => {
    const v = get<{ value: string }>('SELECT value FROM preferences WHERE user_id = ? AND key = ?', LOCAL_USER, `gaps.${p.id}`)?.value;
    return v ? JSON.parse(v) : null;
  });
  on('POST', '/goals/:id/gaps', async ({ p }) => {
    const g = get<any>('SELECT * FROM goals WHERE id = ? AND user_id = ?', p.id, LOCAL_USER); if (!g) return bad('Not found', 404);
    const have = all<any>(`SELECT c.name, gc.category, COALESCE(m.score, 0) AS mastery FROM goal_concepts gc JOIN concepts c ON c.id = gc.concept_id LEFT JOIN concept_mastery m ON m.concept_id = c.id WHERE gc.goal_id = ? GROUP BY c.id LIMIT 80`, p.id);
    try {
      const r = await ollama.chat('knowledge', [
        { role: 'system', content: `You are a curriculum designer. Given a learner's goal and the concepts they have SAVED so far, list the topics a person needs to master to reach the goal, mark each as "covered" (clearly present in their saved concepts), "partial" (only touched on) or "gap" (absent). Saved concepts show only what they captured, NOT that they understand it — never claim mastery. Then give an ordered learning path and practical exercises. Return ONLY JSON {"topics":[{"name":"","status":"covered|partial|gap","why":"why it matters for this goal"}],"path":[{"step":1,"topic":"","action":"what to study/do"}],"exercises":["concrete practice task"],"actions":["actionable lesson to apply"]} with 8-12 topics, 5-7 path steps, 3-5 exercises.` },
        { role: 'user', content: `GOAL: ${g.title}\nDescription: ${g.description ?? ''}\nLevel: ${g.level}\nDesired outcome: ${g.outcome ?? ''}${g.deadline ? `\nDeadline: ${g.deadline}` : ''}\n\nSaved concepts (${have.length}): ${have.map((h) => `${h.name}${h.mastery ? ` (mastery ${Math.round(h.mastery)}%)` : ''}`).join('; ') || 'none yet'}` }], { json: true, temperature: 0.3 });
      const j = ollama.parseJson<any>(r.text); if (!j?.topics) return bad('The model returned an unreadable analysis. Try again.', 502);
      // Reading recommendations come from real retrieval over the library, not from the model.
      const wanted = (j.topics as any[]).filter((t) => t.status !== 'covered').slice(0, 6);
      const byBook = new Map<string, { book_id: string; title: string; author: string | null; topics: string[]; pages: number[]; score: number }>();
      for (const t of wanted) {
        const { hits } = await retrieveLibrary(`${t.name} ${g.title}`, { k: 4 });
        for (const h of hits.slice(0, 3)) {
          const e = byBook.get(h.book_id) ?? { book_id: h.book_id, title: h.book_title, author: h.author, topics: [], pages: [], score: 0 };
          if (!e.topics.includes(t.name)) e.topics.push(t.name);
          if (!e.pages.includes(h.page_start)) e.pages.push(h.page_start);
          e.score += h.score; byBook.set(h.book_id, e);
        }
      }
      const out = { topics: j.topics, path: j.path ?? [], exercises: j.exercises ?? [], actions: j.actions ?? [], nextReads: [...byBook.values()].sort((a, b) => b.score - a.score).slice(0, 5).map((x) => ({ ...x, pages: x.pages.sort((a, b) => a - b).slice(0, 5) })), savedConcepts: have.length, model: r.model, generated_at: now(),
        note: 'Coverage reflects only what you have saved or extracted, not what you understand. Use quizzes and Teach it back to measure understanding.' };
      run('INSERT INTO preferences (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value = excluded.value', LOCAL_USER, `gaps.${p.id}`, JSON.stringify(out));
      return out;
    } catch (e) { return aiError(e); }
  });

  // ── analytics: what was actually learned ──
  on('GET', '/report', ({ q }) => {
    const days = q.get('period') === 'month' ? 30 : 7;
    const since = now() - days * 86_400_000;
    const n = (sql: string, ...a: any[]) => get<{ n: number | null }>(sql, ...a)?.n ?? 0;
    const sess = get<{ s: number; p: number }>('SELECT COALESCE(SUM(seconds),0) s, COALESCE(SUM(pages),0) p FROM reading_sessions WHERE user_id = ? AND started_at >= ?', LOCAL_USER, since)!;
    const reviews = all<{ grade: number }>('SELECT grade FROM flashcard_reviews WHERE reviewed_at >= ?', since);
    const vreviews = all<{ grade: number }>('SELECT grade FROM vocabulary_reviews WHERE reviewed_at >= ?', since);
    return {
      days, since,
      reading: { seconds: sess.s, pages: sess.p, pagesPerHour: sess.s > 120 ? Math.round((sess.p / sess.s) * 3600 * 10) / 10 : null,
        books: all('SELECT b.id, b.title, SUM(s.seconds) AS seconds, SUM(s.pages) AS pages FROM reading_sessions s JOIN books b ON b.id = s.book_id WHERE s.user_id = ? AND s.started_at >= ? GROUP BY b.id ORDER BY seconds DESC LIMIT 8', LOCAL_USER, since) },
      captured: { passages: n("SELECT COUNT(*) n FROM notes WHERE user_id = ? AND created_at >= ? AND kind = 'selection'", LOCAL_USER, since), notes: n("SELECT COUNT(*) n FROM notes WHERE user_id = ? AND created_at >= ? AND kind != 'selection'", LOCAL_USER, since), highlights: n('SELECT COUNT(*) n FROM highlights WHERE created_at >= ? AND book_id IN (SELECT id FROM books WHERE user_id = ?)', since, LOCAL_USER) },
      vocabulary: { saved: n('SELECT COUNT(*) n FROM vocabulary WHERE user_id = ? AND created_at >= ?', LOCAL_USER, since), reviewed: vreviews.length, recall: vreviews.length ? vreviews.filter((r) => r.grade >= 2).length / vreviews.length : null, mastered: n("SELECT COUNT(*) n FROM vocabulary WHERE user_id = ? AND status = 'mastered'", LOCAL_USER) },
      cards: { reviewed: reviews.length, retention: reviews.length ? reviews.filter((r) => r.grade >= 2).length / reviews.length : null },
      concepts: { discovered: n('SELECT COUNT(*) n FROM concepts WHERE user_id = ? AND created_at >= ?', LOCAL_USER, since), tested: n('SELECT COUNT(DISTINCT concept_id) n FROM concept_events WHERE created_at >= ?', since), teachbacks: n('SELECT COUNT(*) n FROM teachbacks WHERE created_at >= ?', since),
        strongest: all('SELECT c.name, m.score FROM concept_mastery m JOIN concepts c ON c.id = m.concept_id WHERE c.user_id = ? AND m.last_at >= ? ORDER BY m.score DESC LIMIT 5', LOCAL_USER, since),
        weakest: all('SELECT c.name, m.score FROM concept_mastery m JOIN concepts c ON c.id = m.concept_id WHERE c.user_id = ? AND m.attempts > 0 ORDER BY m.score ASC LIMIT 5', LOCAL_USER) },
      quizzes: { attempts: n('SELECT COUNT(*) n FROM quiz_attempts WHERE created_at >= ?', since) },
      goals: all(`SELECT g.title, COUNT(gc.id) AS items FROM goals g JOIN goal_concepts gc ON gc.goal_id = g.id WHERE g.user_id = ? AND gc.created_at >= ? GROUP BY g.id ORDER BY items DESC`, LOCAL_USER, since),
    };
  });
  on('GET', '/vocab/insights', () => ({
    byStatus: all("SELECT status, COUNT(*) n FROM vocabulary WHERE user_id = ? GROUP BY status", LOCAL_USER),
    byBook: all('SELECT b.title, COUNT(*) n FROM vocabulary v JOIN books b ON b.id = v.book_id WHERE v.user_id = ? GROUP BY b.id ORDER BY n DESC LIMIT 10', LOCAL_USER),
    forgotten: all('SELECT v.word, COUNT(*) AS lapses FROM vocabulary_reviews r JOIN vocabulary v ON v.id = r.vocabulary_id WHERE r.grade = 0 AND v.user_id = ? GROUP BY v.id ORDER BY lapses DESC LIMIT 10', LOCAL_USER),
  }));
}
