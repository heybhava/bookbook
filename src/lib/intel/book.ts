// Book Intelligence: aggregate the page records into a structured, source-linked knowledge representation + coverage tracker.
import { all, get, me } from '../db';
import { coverageByKind } from './assets';
import type { PageBasic, PageAI } from './pageintel';

interface Row { page: number; level: string; error: string | null; data: { basic?: PageBasic; ai?: PageAI } }
const rows = (bookId: string): Row[] => all<any>('SELECT page, level, error, data FROM page_intel WHERE book_id = ? ORDER BY page', bookId).map((r) => ({ ...r, data: JSON.parse(r.data) }));

export function coverage(bookId: string) {
  const total = get<{ n: number }>('SELECT COUNT(*) n FROM pages WHERE book_id = ?', bookId)?.n ?? 0;
  const rs = rows(bookId);
  const byKind = coverageByKind(bookId);
  const failedTasks = get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE book_id = ? AND status = 'failed'", bookId)?.n ?? 0;
  const running = all<any>("SELECT id, kind, status, progress, detail FROM tasks WHERE book_id = ? AND status IN ('queued','analysing','generating','rendering')", bookId);
  const ai = rs.filter((r) => r.level === 'ai').length;
  return {
    total, structure: rs.length, ai, awaitingAi: Math.max(0, total - ai), failedPages: rs.filter((r) => r.error && r.level !== 'ai').map((r) => ({ page: r.page, error: r.error })),
    visual: byKind.visual.length, audio: byKind.audio.length, podcast: byKind.podcast.length, video: byKind.video.length, exercises: byKind.exercise.length, course: byKind.course.length,
    pagesBy: byKind, failedTasks, running,
    note: total && ai < total ? `Only ${ai} of ${total} pages have had the full AI analysis. Generated experiences use what has been analysed and the raw page text; nothing is claimed beyond that.` : null,
  };
}

const share = (m: Map<string, number>, id: string, total: number) => (total ? (m.get(id) ?? 0) / total : 0);

export function bookProfile(bookId: string) {
  const book = get<any>('SELECT id, title, author, page_count, format FROM books WHERE id = ? AND user_id = ?', bookId, me());
  if (!book) return null;
  const rs = rows(bookId).filter((r) => r.data.basic);
  const chapters = all<any>('SELECT idx, title, start_page FROM chapters WHERE book_id = ? ORDER BY idx', bookId)
    .map((c, i, a) => ({ ...c, end_page: (a[i + 1]?.start_page ?? book.page_count + 1) - 1 }));

  const subj = new Map<string, number>(); let formulas = 0, tables = 0, figures = 0, years = 0, defs = 0, refPages: number[] = [];
  const formulaList: { page: number; text: string }[] = []; const defList: { page: number; term: string; sentence: string }[] = []; const figList: { page: number; label: string; caption: string }[] = [];
  const yearEvents: { page: number; year: number; sentence: string }[] = [];
  for (const r of rs) {
    const b = r.data.basic!; if (b.isReference) { refPages.push(r.page); continue; }
    if (b.subjects[0]) subj.set(b.subjects[0].id, (subj.get(b.subjects[0].id) ?? 0) + 1);
    formulas += b.formulas.length; tables += b.tables; figures += b.figures.length; years += b.years.length; defs += b.definitions.length;
    b.formulas.forEach((t) => formulaList.length < 200 && formulaList.push({ page: r.page, text: t }));
    b.definitions.forEach((d) => defList.length < 200 && defList.push({ page: r.page, ...d }));
    b.figures.forEach((f) => figList.length < 100 && figList.push({ page: r.page, ...f }));
    b.years.forEach((y) => yearEvents.length < 300 && yearEvents.push({ page: r.page, ...y }));
  }
  const content = rs.filter((r) => !r.data.basic!.isReference).length;
  const subjects = [...subj.entries()].map(([id, n]) => ({ id, pages: n, share: Math.round((n / Math.max(1, content)) * 100) / 100 })).sort((a, b) => b.pages - a.pages);

  // concept index from AI-analysed pages (each with its page, so every concept is source-linked)
  const cmap = new Map<string, { name: string; pages: number[]; difficulty: number[] }>();
  for (const r of rs) {
    const a = r.data.ai; if (!a?.main_concept) continue;
    for (const c of [a.main_concept, ...(a.supporting_concepts ?? [])]) {
      const k = c.toLowerCase().trim(); if (k.length < 3) continue;
      const e = cmap.get(k) ?? { name: c, pages: [], difficulty: [] }; e.pages.push(r.page); if (a.difficulty) e.difficulty.push(a.difficulty); cmap.set(k, e);
    }
  }
  const concepts = [...cmap.values()].sort((a, b) => b.pages.length - a.pages.length).slice(0, 80).map((c) => ({ name: c.name, pages: [...new Set(c.pages)].slice(0, 12), difficulty: c.difficulty.length ? Math.round((c.difficulty.reduce((x, y) => x + y, 0) / c.difficulty.length) * 10) / 10 : null }));

  const need = new Map<string, number[]>();
  for (const r of rs) for (const n of r.data.ai?.needs ?? []) { if (n === 'none') continue; need.set(n, [...(need.get(n) ?? []), r.page]); }
  const learningOpportunities = [...need.entries()].map(([need, pages]) => ({ need, count: pages.length, pages: pages.slice(0, 20) })).sort((a, b) => b.count - a.count);

  const top = subjects[0]?.id; const tshare = (id: string) => share(subj, id, content);
  const rec: { id: string; kind: string; title: string; why: string; params: Record<string, unknown> }[] = [];
  rec.push({ id: 'podcast', kind: 'podcast', title: `Two-host podcast: ${book.title}`, why: `${chapters.length || 1} chapter${chapters.length === 1 ? '' : 's'} to discuss; a conversation is a good first way into any book.`, params: { format: 'overview' } });
  if (chapters.length > 1) rec.push({ id: 'video-chapter', kind: 'video', title: 'Short video for a chapter', why: `Your book has ${chapters.length} chapters; start with one.`, params: { preset: 'short' } });
  if (['physics', 'engineering'].includes(top ?? '') || (tshare('physics') + tshare('engineering') > 0.25 && formulas > 5)) rec.push({ id: 'sim-physics', kind: 'visual', title: 'Interactive physics laboratory', why: `${formulas} formula-like lines and ${Math.round((tshare('physics') + tshare('engineering')) * 100)}% of pages are physics/engineering.`, params: { method: 'simulation' } });
  if (['finance', 'business', 'economics'].some((s) => tshare(s) > 0.2)) rec.push({ id: 'calc', kind: 'visual', title: 'Interactive financial / business model', why: `${Math.round((tshare('finance') + tshare('business') + tshare('economics')) * 100)}% of pages are finance, business or economics.`, params: { method: 'calculator' } });
  if (years >= 15 && (top === 'history' || yearEvents.length >= 25)) rec.push({ id: 'timeline', kind: 'visual', title: 'Interactive timeline', why: `${years} dated references across the book.`, params: { method: 'timeline' } });
  if (tshare('mathematics') > 0.2 || (top === 'mathematics' && formulas > 3)) rec.push({ id: 'math', kind: 'visual', title: 'Interactive mathematical demonstration', why: `${formulas} equation-like lines.`, params: { method: 'worked_example' } });
  if (tshare('philosophy') > 0.2) rec.push({ id: 'debate', kind: 'podcast', title: 'Debate podcast and argument map', why: 'Argument-driven content is best explored by opposing views.', params: { format: 'debate' } });
  if (tshare('programming') > 0.2) rec.push({ id: 'algo', kind: 'visual', title: 'Algorithm step-through', why: 'Programming content.', params: { method: 'algorithm_trace' } });
  if (defs >= 8) rec.push({ id: 'flash', kind: 'course', title: 'Revision flashcards from definitions', why: `${defs} definitions detected.`, params: {} });
  rec.push({ id: 'course', kind: 'course', title: 'Chapter-based course', why: chapters.length > 1 ? `Follows the book's real ${chapters.length} chapters.` : 'Single-section book: a short guided course.', params: {} });

  return {
    book, structure: { chapters, pages: book.page_count, tables, figures, referencePages: refPages.slice(0, 40), formulas, definitions: defs, datedReferences: years },
    subjects, concepts, definitions: defList.slice(0, 60), formulas: formulaList.slice(0, 60), figures: figList.slice(0, 40), events: yearEvents.slice(0, 80),
    learningOpportunities, recommendations: rec, coverage: coverage(bookId),
    limits: 'Subject detection, formulas, tables and figures are heuristics over extracted text. Images/diagrams are not visually analysed; equations in image form are invisible to this analysis.',
  };
}
