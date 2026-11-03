// Life intelligence: recurring themes across entries, period reports, people, goals, milestones and memories.
// Principles: every statement points at dated entries; "single entry" vs "recurring" is always shown; people/goals/milestones are only created when the user approves;
// entries marked sensitive are left out of every cross-entry analysis and out of resurfacing; cross-entry analysis only runs with the user's permission.
import { all, get, run, uid } from '../db';
import * as ollama from '../ollama';
import { SAFETY } from '../rag';
import { JError, settings, segments, dayOf } from './store';
import { getLang, langName } from '../lang/registry';

import { stems, jacc, shared, clusterThemes, basisOf, type Item, type Theme } from './cluster';
export { clusterThemes, stems };
export type { Item, Theme };
const now = () => Date.now();

// ───────────── gathering ─────────────
const need = () => { if (!settings().longitudinal) throw new JError('Cross-entry analysis is off. Turn on “Analyse patterns across my entries” in Journal settings first — it is your choice, and you can turn it off again.', 403); };
export function gatherItems(from: string, to: string): { items: Item[]; entries: number } {
  const docs = all<any>(`SELECT d.recording_id, d.entry_id, d.data, e.day FROM j_docs d JOIN j_entries e ON e.id = d.entry_id WHERE d.kind = 'notes' AND e.sensitive = 0 AND e.deleted_at IS NULL AND e.day BETWEEN ? AND ? ORDER BY d.created_at DESC`, from, to);
  const seen = new Set<string>(); const items: Item[] = []; const segCache = new Map<string, Map<number, string>>();
  const segsOf = (rid: string) => { let m = segCache.get(rid); if (!m) { const t = get<any>('SELECT id FROM j_transcripts WHERE recording_id = ? ORDER BY created_at DESC LIMIT 1', rid); m = new Map(t ? segments(t.id).map((s: any) => [s.idx, s.corrected ?? s.text] as [number, string]) : []); segCache.set(rid, m); } return m; };
  for (const d of docs) {
    if (!d.recording_id || seen.has(d.recording_id)) continue; seen.add(d.recording_id); const data = d.data ? JSON.parse(d.data) : {}; const sm = segsOf(d.recording_id);
    for (const kind of ['topics', 'key_thoughts', 'decisions', 'actions', 'questions', 'challenges', 'achievements', 'gratitude', 'moments']) for (const it of data[kind] ?? []) items.push({ entryId: d.entry_id, day: d.day, recordingId: d.recording_id, kind, text: String(it.text), atMs: it.at?.[0] ?? null, quote: it.segs?.[0] != null ? sm.get(it.segs[0]) ?? null : null });
  }
  return { items, entries: new Set(items.map((i) => i.entryId)).size };
}
const addDays = (d: string, n: number) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return dayOf(x.getTime()); };
export function periodFor(kind: string, to?: string, from?: string) {
  const end = to ?? dayOf(); if (kind === 'week') return { from: addDays(end, -6), to: end }; if (kind === 'month') return { from: addDays(end, -29), to: end }; if (kind === 'quarter') return { from: addDays(end, -89), to: end }; if (kind === 'year') return { from: addDays(end, -364), to: end };
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || from > end) throw new JError('Choose a valid date range.'); return { from, to: end };
}

export function insights(from: string, to: string) {
  need(); const { items, entries } = gatherItems(from, to);
  const themes = clusterThemes(items.filter((i) => ['topics', 'key_thoughts', 'challenges', 'questions', 'decisions', 'actions', 'achievements'].includes(i.kind)));
  const byKind = (k: string[]) => themes.filter((t) => k.includes(t.kind));
  const rows = all<any>("SELECT day, mood, tags, kind, mode, sensitive FROM j_entries WHERE deleted_at IS NULL AND sensitive = 0 AND day BETWEEN ? AND ?", from, to);
  const moods: Record<string, number> = {}; const tags: Record<string, Set<string>> = {}; let w = 0, v = 0, a = 0;
  for (const r of rows) { if (r.mood) moods[r.mood] = (moods[r.mood] ?? 0) + 1; for (const t of JSON.parse(r.tags || '[]')) (tags[t] ??= new Set()).add(r.day); if (r.kind === 'written') w++; else if (r.kind === 'video') v++; else if (r.kind === 'audio') a++; }
  const tagThemes = Object.entries(tags).map(([t, d]) => ({ tag: t, days: d.size, basis: basisOf(d.size) })).sort((x, y) => y.days - x.days).slice(0, 15);
  const unresolved = items.filter((i) => i.kind === 'questions').slice(0, 20);
  return { range: { from, to }, analysedEntries: entries, entries: rows.length, excludedSensitive: get<any>("SELECT COUNT(*) n FROM j_entries WHERE deleted_at IS NULL AND sensitive = 1 AND day BETWEEN ? AND ?", from, to).n, counts: { written: w, video: v, audio: a }, moods,
    themes: { recurring: byKind(['topics', 'key_thoughts']).filter((t) => t.entries >= 2).slice(0, 12), concerns: byKind(['challenges', 'questions']).filter((t) => t.entries >= 2).slice(0, 10), goalsReturnedTo: byKind(['actions', 'decisions']).filter((t) => t.entries >= 2).slice(0, 10), achievements: byKind(['achievements']).slice(0, 10) },
    tagThemes, unresolvedQuestions: unresolved, note: 'These groupings are made by matching similar wording across your own entries. They describe what you said and when; they are not conclusions about you. “Recurring” means three or more different entries.' };
}

export async function periodReport(kind: string, o: { from?: string; to?: string; narrative?: boolean }) {
  need(); const p = periodFor(kind, o.to, o.from); const ins = insights(p.from, p.to);
  const goals = all<any>("SELECT g.*, (SELECT COUNT(*) FROM j_goal_updates u WHERE u.goal_id = g.id AND date(u.created_at/1000,'unixepoch','localtime') BETWEEN ? AND ?) updates FROM j_goals g WHERE g.status = 'active' ORDER BY g.created_at", p.from, p.to);
  const milestones = all<any>('SELECT * FROM j_milestones WHERE day BETWEEN ? AND ? ORDER BY day', p.from, p.to);
  const people = peopleCounts(p.from, p.to);
  const data: any = { kind, ...p, ...ins, goals: goals.map((g) => ({ id: g.id, title: g.title, deadline: g.deadline, updatesInPeriod: g.updates })), milestones, people, reflectionQuestions: kind === 'week' || kind === 'month' ? ['What did you make progress on?', 'What was difficult?', 'What did you learn?', 'What would you like to change next ' + (kind === 'week' ? 'week' : 'month') + '?'] : ['What stands out when you read this back?', 'What do you want to carry forward?'], narrative: null, model: null };
  if (o.narrative) {
    if (!settings().aiEnabled) throw new JError('AI features are turned off in Journal settings.', 403);
    const pool: { n: number; item: Item }[] = []; let n = 1; const seen = new Set<string>();
    for (const grp of Object.values(ins.themes)) for (const t of grp as Theme[]) for (const e of t.evidence.slice(0, 3)) { const k = e.entryId + e.text; if (!seen.has(k) && pool.length < 60) { seen.add(k); pool.push({ n: n++, item: e }); } }
    if (pool.length < 2) data.narrative = { sections: [], dropped: 0, note: 'Not enough analysed entries in this period for a written summary. Create notes for more recordings first.' };
    else {
      const listing = pool.map((p2) => `[${p2.n}] (${p2.item.day}, ${p2.item.kind}) ${p2.item.text}`).join('\n');
      const sys = `${SAFETY}\nYou summarise a person's own journal over ${p.from} to ${p.to} for them. You are not a therapist; never diagnose or label them, never claim to know how they feel inside. Use ONLY the numbered items. Each statement must cite the item numbers it rests on, and say whether something repeats across entries only when the cited items come from different days. Use tentative wording ("you often mentioned…"). If items from earlier and later days differ, you may describe what changed, citing both. ${settings().responseLanguage !== 'same' && getLang(settings().responseLanguage) ? `Write in ${langName(settings().responseLanguage)}.` : 'Reply in the language of the items.'} Return ONLY JSON {"summary":[{"text":"...","items":[n]}],"changes":[{"text":"...","items":[n]}]} with at most 5 statements each.`;
      let j: any = null; for (let a = 0; a < 2 && !j; a++) { try { j = ollama.parseJson((await ollama.chat('comprehension', [{ role: 'system', content: sys }, { role: 'user', content: listing }], { json: true, temperature: 0.2 })).text); } catch (e: any) { if (a && /fetch failed|ECONNREFUSED/i.test(String(e?.message))) throw new JError('The local language model (Ollama) is not reachable. The report without a written summary is still saved.'); } }
      const byN = new Map(pool.map((p2) => [p2.n, p2.item])); let dropped = 0; const sections: any[] = [];
      for (const [key, label] of [['summary', 'What the period was about'], ['changes', 'What seems to have shifted']] as const) for (const s of Array.isArray(j?.[key]) ? j[key] : []) {
        const cited = (Array.isArray(s?.items) ? s.items : []).map(Number).filter((x: number) => byN.has(x)); const text = String(s?.text ?? '').trim().slice(0, 500); if (!text || !cited.length) { dropped++; continue; }
        const src = cited.map((x: number) => byN.get(x)!.text).join(' '); const a = stems(text), b = stems(src); if (settings().responseLanguage === 'same' && /[A-Za-z]/.test(text) && a.size && shared(a, b) / a.size < 0.15) { dropped++; continue; }
        const ents = new Set(cited.map((x: number) => byN.get(x)!.entryId)); sections.push({ section: label, text, basis: basisOf(ents.size), evidence: cited.slice(0, 4).map((x: number) => byN.get(x)) });
      }
      data.narrative = { sections, dropped }; data.model = await ollama.modelFor('comprehension');
    }
  }
  const id = uid(); run('INSERT INTO j_reports (id, kind, from_day, to_day, data, model, created_at) VALUES (?,?,?,?,?,?,?)', id, kind, p.from, p.to, JSON.stringify(data), data.model, now()); return { id, ...data };
}
export const listReports = () => all<any>('SELECT id, kind, from_day, to_day, model, created_at FROM j_reports ORDER BY created_at DESC LIMIT 100');
export const getReport = (id: string) => { const r = get<any>('SELECT * FROM j_reports WHERE id = ?', id); if (!r) throw new JError('Report not found.', 404); return { id: r.id, created_at: r.created_at, ...JSON.parse(r.data) }; };

// ───────────── suggestions (nothing is created until the user accepts) ─────────────
const GOALISH = /\b(i want to|i need to|i should|i will|i'm going to|i am going to|i plan to|my goal|i wish i could|i'd like to|i would like to|i have to)\b/i;
export function suggestions() {
  const dismissed = new Set(all<{ key: string }>('SELECT key FROM j_dismissed').map((r) => r.key));
  const docs = all<any>(`SELECT d.recording_id, d.entry_id, d.data, e.day, e.title FROM j_docs d JOIN j_entries e ON e.id = d.entry_id WHERE d.kind = 'notes' AND e.deleted_at IS NULL AND e.sensitive = 0 ORDER BY d.created_at DESC`);
  const seen = new Set<string>(); const people: any[] = [], goals: any[] = [], milestones: any[] = []; const have = new Set(all<{ name: string }>('SELECT name FROM j_people').map((r) => r.name.toLowerCase())); const haveGoal = all<{ title: string }>('SELECT title FROM j_goals').map((r) => stems(r.title));
  for (const d of docs) {
    if (!d.recording_id || seen.has(d.recording_id)) continue; seen.add(d.recording_id); const data = JSON.parse(d.data ?? '{}');
    const mk = (kind: string, it: any) => { const key = `${kind}:${d.entry_id}:${String(it.text).toLowerCase().slice(0, 80)}`; return dismissed.has(key) ? null : { key, text: String(it.text), entryId: d.entry_id, recordingId: d.recording_id, day: d.day, atMs: it.at?.[0] ?? null, segs: it.segs ?? [], verified: !!it.verified }; };
    for (const it of data.people ?? []) { const s = mk('person', it); if (s && !have.has(s.text.toLowerCase().trim())) people.push(s); }
    for (const it of [...(data.actions ?? []), ...(data.key_thoughts ?? []).filter((x: any) => GOALISH.test(x.text))]) { const s = mk('goal', it); if (s && !haveGoal.some((g) => jacc(g, stems(s.text)) > 0.5)) goals.push(s); }
    for (const it of [...(data.achievements ?? []), ...(data.moments ?? [])]) { const s = mk('milestone', it); if (s) milestones.push(s); }
  }
  return { people: people.slice(0, 40), goals: goals.slice(0, 40), milestones: milestones.slice(0, 40), note: 'Suggestions come from your own notes and nothing is added until you accept it.' };
}
export const dismiss = (key: string) => { run('INSERT OR IGNORE INTO j_dismissed (key, created_at) VALUES (?,?)', String(key).slice(0, 300), now()); };

// ───────────── people ─────────────
export const listPeople = () => all<any>('SELECT * FROM j_people ORDER BY name COLLATE NOCASE');
export function savePerson(o: { id?: string; name?: string; aliases?: string; relationship?: string; notes?: string }) {
  const name = o.name?.trim(); if (!o.id && !name) throw new JError('A person needs a name.');
  if (o.id) { const p = get<any>('SELECT * FROM j_people WHERE id = ?', o.id); if (!p) throw new JError('Person not found.', 404); run('UPDATE j_people SET name = ?, aliases = ?, relationship = ?, notes = ?, updated_at = ? WHERE id = ?', (name ?? p.name).slice(0, 100), (o.aliases ?? p.aliases).slice(0, 300), o.relationship !== undefined ? o.relationship?.slice(0, 80) || null : p.relationship, (o.notes ?? p.notes).slice(0, 20000), now(), o.id); return o.id; }
  if (get('SELECT 1 FROM j_people WHERE lower(name) = lower(?)', name)) throw new JError('That person is already in your list.', 409);
  const id = uid(); run('INSERT INTO j_people (id, name, aliases, relationship, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', id, name!.slice(0, 100), (o.aliases ?? '').slice(0, 300), o.relationship?.slice(0, 80) ?? null, (o.notes ?? '').slice(0, 20000), now(), now()); return id;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Where the user's own words mention this person. Plain name matching only — no inference about the person. */
export function personMentions(id: string) {
  const p = get<any>('SELECT * FROM j_people WHERE id = ?', id); if (!p) throw new JError('Person not found.', 404);
  const names = [p.name, ...String(p.aliases).split(',').map((x: string) => x.trim())].filter((n) => n.length > 1); const latin = names.every((n) => /^[\u0000-ɏ]+$/.test(n));
  const rx = latin ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'iu') : new RegExp(names.map(esc).join('|'), 'u'); const out: any[] = [];
  for (const s of all<any>(`SELECT s.start_ms, s.text, s.corrected, r.id rid, e.id eid, e.day, e.title FROM j_segments s JOIN j_transcripts t ON t.id = s.transcript_id JOIN j_recordings r ON r.id = t.recording_id JOIN j_entries e ON e.id = r.entry_id WHERE e.deleted_at IS NULL ORDER BY e.day DESC`)) { const tx = s.corrected ?? s.text; if (rx.test(tx)) out.push({ type: 'transcript', entryId: s.eid, day: s.day, title: s.title, recordingId: s.rid, atMs: s.start_ms, text: tx }); if (out.length >= 150) break; }
  for (const e of all<any>("SELECT id, day, title, body FROM j_entries WHERE deleted_at IS NULL AND body != '' ORDER BY day DESC")) { const m = rx.exec(e.body); if (m) out.push({ type: 'written', entryId: e.id, day: e.day, title: e.title, text: e.body.slice(Math.max(0, m.index - 80), m.index + 160).replace(/\s+/g, ' ') }); }
  const entries = new Set(out.map((x) => x.entryId)); return { person: p, mentions: out.sort((a, b) => b.day.localeCompare(a.day)), entries: entries.size };
}
function peopleCounts(from: string, to: string) {
  const out: { id: string; name: string; entries: number }[] = []; for (const p of listPeople()) { const m = personMentions(p.id).mentions.filter((x) => x.day >= from && x.day <= to && !get<any>('SELECT sensitive FROM j_entries WHERE id = ?', x.entryId)?.sensitive); const n = new Set(m.map((x) => x.entryId)).size; if (n) out.push({ id: p.id, name: p.name, entries: n }); } return out.sort((a, b) => b.entries - a.entries);
}

// ───────────── goals ─────────────
export const listGoals = () => all<any>("SELECT g.*, (SELECT COUNT(*) FROM j_goal_updates u WHERE u.goal_id = g.id) updates FROM j_goals g ORDER BY CASE g.status WHEN 'active' THEN 0 ELSE 1 END, g.created_at DESC");
export function saveGoal(o: { id?: string; title?: string; description?: string; deadline?: string | null; status?: string; obstacles?: string; sourceEntryId?: string; sourceAtMs?: number }) {
  if (o.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(o.deadline)) throw new JError('Deadline must be a date.'); if (o.status && !['active', 'done', 'dropped', 'paused'].includes(o.status)) throw new JError('Unknown status.');
  if (o.id) { const g = get<any>('SELECT * FROM j_goals WHERE id = ?', o.id); if (!g) throw new JError('Goal not found.', 404); run('UPDATE j_goals SET title = ?, description = ?, deadline = ?, status = ?, obstacles = ?, updated_at = ? WHERE id = ?', (o.title?.trim() || g.title).slice(0, 200), (o.description ?? g.description).slice(0, 5000), o.deadline === undefined ? g.deadline : o.deadline, o.status ?? g.status, (o.obstacles ?? g.obstacles).slice(0, 5000), now(), o.id); if (o.status && o.status !== g.status) run('INSERT INTO j_goal_updates (id, goal_id, kind, body, created_at) VALUES (?,?,?,?,?)', uid(), o.id, 'status', `Marked ${o.status}`, now()); return o.id; }
  if (!o.title?.trim()) throw new JError('A goal needs a title.'); if (o.sourceEntryId && !get('SELECT 1 FROM j_entries WHERE id = ?', o.sourceEntryId)) throw new JError('Source entry not found.', 404);
  const id = uid(); run('INSERT INTO j_goals (id, title, description, deadline, obstacles, source_entry_id, source_at_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)', id, o.title.trim().slice(0, 200), (o.description ?? '').slice(0, 5000), o.deadline ?? null, (o.obstacles ?? '').slice(0, 5000), o.sourceEntryId ?? null, o.sourceAtMs ?? null, now(), now()); return id;
}
export function addGoalUpdate(goalId: string, o: { body: string; kind?: string; entryId?: string }) { if (!get('SELECT 1 FROM j_goals WHERE id = ?', goalId)) throw new JError('Goal not found.', 404); if (!o.body?.trim()) throw new JError('Write a short update.'); const id = uid(); run('INSERT INTO j_goal_updates (id, goal_id, kind, body, entry_id, created_at) VALUES (?,?,?,?,?,?)', id, goalId, ['progress', 'obstacle', 'milestone', 'achievement', 'reflection'].includes(o.kind ?? '') ? o.kind : 'progress', o.body.trim().slice(0, 3000), o.entryId ?? null, now()); run('UPDATE j_goals SET updated_at = ? WHERE id = ?', now(), goalId); return id; }
export const goalDetail = (id: string) => { const g = get<any>('SELECT * FROM j_goals WHERE id = ?', id); if (!g) throw new JError('Goal not found.', 404); return { goal: g, updates: all('SELECT * FROM j_goal_updates WHERE goal_id = ? ORDER BY created_at DESC', id), source: g.source_entry_id ? get('SELECT id, day, title FROM j_entries WHERE id = ?', g.source_entry_id) : null }; };

// ───────────── milestones & memories ─────────────
export function saveMilestone(o: { day?: string; title?: string; kind?: string; entryId?: string; recordingId?: string; atMs?: number }) { const day = o.day ?? dayOf(); if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new JError('Invalid date.'); if (!o.title?.trim()) throw new JError('A milestone needs a title.'); const id = uid(); run('INSERT INTO j_milestones (id, day, title, kind, entry_id, recording_id, at_ms, created_at) VALUES (?,?,?,?,?,?,?,?)', id, day, o.title.trim().slice(0, 200), o.kind?.slice(0, 40) || 'milestone', o.entryId ?? null, o.recordingId ?? null, o.atMs ?? null, now()); return id; }
export const listMilestones = () => all<any>('SELECT * FROM j_milestones ORDER BY day DESC');
/** Gentle resurfacing: only if the user allows it, never sensitive entries or emotional-reflection recordings. */
export function memories(today = dayOf()) {
  if (!settings().resurface) return { enabled: false, items: [] as any[], note: 'Memory resurfacing is turned off in settings.' };
  const [y, m, d] = today.split('-').map(Number); const items: any[] = []; const add = (label: string, from: string, to: string) => { for (const e of all<any>("SELECT id, day, title, kind, mood, body FROM j_entries WHERE deleted_at IS NULL AND sensitive = 0 AND COALESCE(mode,'') != 'emotional' AND day BETWEEN ? AND ? ORDER BY day", from, to)) items.push({ label, entryId: e.id, day: e.day, title: e.title, kind: e.kind, excerpt: e.body.slice(0, 140) }); };
  for (let k = 1; k <= 10; k++) { const same = `${y - k}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; if (new Date(same + 'T00:00:00').getDate() !== d) continue; add(k === 1 ? 'This day last year' : `This day ${k} years ago`, same, same); }
  add('A week ago', addDays(today, -7), addDays(today, -7)); add('A month ago', addDays(today, -30), addDays(today, -30)); const ly = addDays(`${y - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, 0); add('This week last year', addDays(ly, -3), addDays(ly, 3));
  const seen = new Set<string>(); return { enabled: true, items: items.filter((i) => (seen.has(i.entryId) ? false : seen.add(i.entryId))), milestones: listMilestones().filter((x) => x.day.slice(5) === today.slice(5) && x.day !== today), note: 'Entries you mark “keep out of memories & insights” are never shown here.' };
}
export function timeline(limit = 200) {
  const ents = all<any>("SELECT id, day, title, kind, mood, favourite FROM j_entries WHERE deleted_at IS NULL AND sensitive = 0 ORDER BY day DESC, created_at DESC LIMIT ?", limit).map((e) => ({ type: 'entry', ...e })); const ms = listMilestones().map((m) => ({ type: 'milestone', ...m }));
  return [...ents, ...ms].sort((a: any, b: any) => b.day.localeCompare(a.day));
}
