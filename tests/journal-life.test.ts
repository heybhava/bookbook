// Life Journal phase 5: recurring themes, reports, people, goals, milestones, memories. Pure tests always run; API tests need a server.
// Fixtures that would otherwise need many slow transcriptions (notes documents) are written straight into the app's SQLite file, exactly in the shape the pipeline produces.
import { tenantDbPath, me as acct } from './_auth.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { clusterThemes, stems, type Item } from '../src/lib/journal/cluster.ts';

const it = (entryId: string, day: string, text: string, kind = 'topics'): Item => ({ entryId, day, recordingId: null, kind, text, atMs: 0, quote: null });

test('clustering: similar wording across DIFFERENT entries forms a theme; one entry never does; basis is honest', () => {
  const t = clusterThemes([it('a', '2031-06-01', 'starting to exercise every morning'), it('b', '2031-06-05', 'I should exercise in the morning more'), it('c', '2031-06-09', 'morning exercise routine slipping again'), it('d', '2031-06-10', 'worried about the quarterly budget report'), it('d', '2031-06-10', 'budget report worries again')]);
  const ex = t.find((x) => /exercise/i.test(x.label))!; assert.equal(ex.entries, 3); assert.equal(ex.basis, 'recurring'); assert.equal(ex.first, '2031-06-01'); assert.equal(ex.last, '2031-06-09'); assert.equal(ex.evidence.length, 3);
  const bud = t.filter((x) => /budget/i.test(x.label)); assert.ok(bud.every((x) => x.entries === 1 && x.basis === 'single entry'), 'two statements in one entry are not a recurring pattern');
});
test('clustering: unrelated items stay apart; kinds are not mixed; two entries = "two entries"', () => {
  const t = clusterThemes([it('a', '2031-01-01', 'my sister birthday party planning'), it('b', '2031-01-02', 'quarterly tax filing deadline'), it('a', '2031-01-01', 'sleeping badly this week', 'challenges'), it('b', '2031-01-02', 'sleeping badly again this week', 'challenges')]);
  assert.equal(t.filter((x) => x.kind === 'topics').length, 2); const sl = t.find((x) => x.kind === 'challenges')!; assert.equal(sl.basis, 'two entries');
});
test('clustering works on non-Latin text (Telugu words) without crashing', () => {
  const t = clusterThemes([it('a', '2031-01-01', 'ఉదయం వ్యాయామం చేయాలి'), it('b', '2031-01-02', 'ఉదయం వ్యాయామం మళ్ళీ మిస్ అయ్యింది')]); assert.ok(t.length >= 1); assert.ok(stems('ఉదయం వ్యాయామం').size > 0);
});

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const up = await fetch(BASE + '/api/status').then((r) => r.ok).catch(() => false);
const j = async (p: string, body?: unknown, method?: string) => { const r = await fetch(BASE + '/api' + p, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

test('Life intelligence API', { skip: !up && 'server not running' }, async (t) => {
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(await tenantDbPath()); db.exec('PRAGMA busy_timeout = 5000');
  const UID = acct.user.id; const ids: string[] = []; let seq = 0; const ms: string[] = [];
  const seed = (day: string, sentences: string[], notes: Record<string, string[]>, o: { sensitive?: number; mode?: string } = {}) => { // an entry + recording + transcript + notes doc, as the pipeline would leave them
    const eid = `t-e-${Date.now()}-${seq++}`, rid = `t-r-${Date.now()}-${seq}`, tid = `t-t-${Date.now()}-${seq}`; const n = Date.now();
    db.prepare("INSERT INTO j_entries (id, user_id, day, kind, mode, title, body, tags, sensitive, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(eid, UID, day, 'audio', o.mode ?? 'daily', `Seed ${day}`, '', '[]', o.sensitive ?? 0, n, n);
    db.prepare("INSERT INTO j_recordings (id, entry_id, kind, mime, size, duration_ms, chunks, status, started_at) VALUES (?,?,?,?,?,?,?,?,?)").run(rid, eid, 'audio', 'audio/webm', 10, 5000, 1, 'complete', n);
    db.prepare('INSERT INTO j_transcripts (id, recording_id, lang, model, created_at) VALUES (?,?,?,?,?)').run(tid, rid, 'en', 'whisper-base', n); sentences.forEach((s, i) => db.prepare('INSERT INTO j_segments (transcript_id, idx, start_ms, end_ms, text) VALUES (?,?,?,?,?)').run(tid, i, i * 1000, i * 1000 + 900, s));
    const data: any = { quotes: [], dropped: 0 }; for (const [k, v] of Object.entries(notes)) data[k] = v.map((text, i) => ({ text, segs: [Math.min(i, sentences.length - 1)], at: [Math.min(i, sentences.length - 1) * 1000], verified: true }));
    db.prepare("INSERT INTO j_docs (id, entry_id, recording_id, kind, version, body, data, created_at) VALUES (?,?,?,?,?,?,?,?)").run(`t-d-${eid}`, eid, rid, 'notes', 1, 'x', JSON.stringify(data), n); ids.push(eid); return { eid, rid };
  };
  const A = seed('2031-06-01', ['I want to start exercising every morning.', 'My sister Priya called me today.'], { topics: ['starting to exercise every morning', 'phone call with Priya'], actions: ['start exercising every morning'], people: ['Priya'], achievements: ['finished the first draft of the report'], challenges: ['sleeping badly this week'] });
  seed('2031-06-05', ['Morning exercise did not happen again.', 'I keep sleeping badly.'], { topics: ['morning exercise routine slipping'], challenges: ['sleeping badly again'] });
  seed('2031-06-09', ['I exercised in the morning twice this week.', 'Priya and I talked about the move.'], { topics: ['exercise in the morning twice this week', 'talking with Priya about the move'], challenges: ['sleeping badly still'] });
  const S = seed('2031-06-10', ['Something private about exercise and sleep.'], { topics: ['private exercise sleep worry'], challenges: ['sleeping badly private'] }, { sensitive: 1 });
  const E = seed('2031-06-11', ['A very hard evening.'], { topics: ['hard evening'] }, { mode: 'emotional' });

  await t.test('cross-entry analysis needs permission and says why', async () => {
    await j('/journal/settings', { longitudinal: false, aiEnabled: true }, 'PUT');
    const r = await j('/journal/insights?from=2031-06-01&to=2031-06-30'); assert.equal(r.status, 403); assert.match(r.body.error, /Analyse patterns|your choice/i);
    assert.equal((await j('/journal/reports', { kind: 'week' })).status, 403);
  });

  await t.test('insights: recurring theme with dated evidence and quotes; sensitive entries excluded; basis honest', async () => {
    await j('/journal/settings', { longitudinal: true }, 'PUT'); const r = (await j('/journal/insights?from=2031-06-01&to=2031-06-30')).body;
    assert.equal(r.analysedEntries, 4 - 1 + 1 /* three plain + the emotional-mode one (mode is only about resurfacing) */, JSON.stringify(r.range));
    const ex = r.themes.recurring.find((x: any) => /exercis/i.test(x.label)); assert.ok(ex, JSON.stringify(r.themes.recurring.map((x: any) => x.label))); assert.equal(ex.entries, 3); assert.equal(ex.basis, 'recurring'); assert.deepEqual(ex.evidence.map((e: any) => e.day), ['2031-06-01', '2031-06-05', '2031-06-09']); assert.ok(ex.evidence.every((e: any) => e.entryId && typeof e.quote === 'string' && e.quote.length > 5), 'each piece of evidence carries the speaker\'s own sentence');
    const sl = r.themes.concerns.find((x: any) => /sleep/i.test(x.label)); assert.equal(sl.entries, 3, 'the sensitive entry is not counted'); assert.ok(!JSON.stringify(r).includes('private exercise'), 'sensitive content never appears'); assert.equal(r.excludedSensitive, 1);
    assert.match(r.note, /not conclusions about you/);
  });

  await t.test('period report: deterministic parts without AI; milestones, goals, people counted; narrative statements must cite real items', async () => {
    const rep = (await j('/journal/reports', { kind: 'custom', from: '2031-06-01', to: '2031-06-30', narrative: false })).body; assert.ok(rep.id); assert.equal(rep.narrative, null); assert.ok(rep.reflectionQuestions.length >= 2);
    assert.equal((await j('/journal/reports', { kind: 'custom', from: '2031-07-01', to: '2031-06-01' })).status, 400, 'bad range refused');
    const wk = (await j('/journal/reports', { kind: 'week', to: '2031-06-09' })).body; assert.equal(wk.from, '2031-06-03'); assert.deepEqual(wk.reflectionQuestions.slice(0, 2), ['What did you make progress on?', 'What was difficult?']);
    assert.equal((await j(`/journal/reports/${rep.id}`)).body.id, rep.id); assert.ok((await j('/journal/reports')).body.some((x: any) => x.id === rep.id));
    const st = (await j('/journal/status')).body; if (st.llm) { const n = (await j('/journal/reports', { kind: 'custom', from: '2031-06-01', to: '2031-06-30', narrative: true })).body; for (const s of n.narrative.sections) { assert.ok(s.evidence.length >= 1 && s.evidence.every((e: any) => e.entryId && e.day), 'every statement is backed by dated entries'); assert.ok(['recurring', 'two entries', 'single entry'].includes(s.basis)); } assert.ok(!/depress|disorder|diagnos/i.test(JSON.stringify(n.narrative))); }
  });

  await t.test('suggestions come from notes; accepting creates things, dismissing hides them, nothing is created automatically', async () => {
    assert.equal((await j('/journal/people')).body.filter((p: any) => p.name === 'Priya').length, 0, 'no person was auto-created');
    let s = (await j('/journal/suggestions')).body; const pp = s.people.find((x: any) => x.text === 'Priya'); assert.ok(pp && pp.entryId && pp.day); assert.ok(s.goals.some((x: any) => /exercis/i.test(x.text))); assert.ok(s.milestones.some((x: any) => /first draft/i.test(x.text)));
    assert.ok(!JSON.stringify(s).includes('private exercise'), 'sensitive entries are not mined');
    const pid = (await j('/journal/people', { name: 'Priya', relationship: 'sister' })).body.id; assert.equal((await j('/journal/people', { name: 'priya' })).status, 409, 'no duplicates');
    const g = (await j('/journal/goals', { title: 'Exercise every morning', sourceEntryId: ids[0], sourceAtMs: 0, deadline: '2031-12-31' })).body.id;
    s = (await j('/journal/suggestions')).body; assert.ok(!s.people.some((x: any) => x.text === 'Priya'), 'accepted person no longer suggested'); assert.ok(!s.goals.some((x: any) => /^start exercising every morning$/i.test(x.text)), 'similar goal no longer suggested');
    const ms = s.milestones[0]; await j('/journal/suggestions/dismiss', { key: ms.key }); assert.ok(!(await j('/journal/suggestions')).body.milestones.some((x: any) => x.key === ms.key), 'dismissed');
    // person profile: mentions are plain name matches in the user's own words, with timestamps
    const pr = (await j(`/journal/people/${pid}`)).body; assert.equal(pr.entries, 2, JSON.stringify(pr.mentions.map((m: any) => m.day))); assert.ok(pr.mentions.every((m: any) => m.type === 'transcript' && typeof m.atMs === 'number' && /Priya/.test(m.text)));
    await j(`/journal/people/${pid}`, { notes: 'My own note about Priya.', aliases: 'Pri' }, 'PATCH'); assert.equal((await j(`/journal/people/${pid}`)).body.person.notes, 'My own note about Priya.');
    // goal lifecycle
    assert.equal((await j('/journal/goals', { title: 'x', deadline: 'soon' })).status, 400); await j(`/journal/goals/${g}/updates`, { body: 'Walked for 20 minutes', kind: 'progress' }); await j(`/journal/goals/${g}/updates`, { body: 'Rain made it hard', kind: 'obstacle' }); await j(`/journal/goals/${g}`, { status: 'done' }, 'PATCH');
    const gd = (await j(`/journal/goals/${g}`)).body; assert.equal(gd.goal.status, 'done'); assert.equal(gd.updates.length, 3, 'two updates + the status change'); assert.equal(gd.source.id, ids[0]); assert.equal((await j(`/journal/goals/${g}/updates`, { body: ' ' })).status, 400);
    await j(`/journal/goals/${g}`, undefined, 'DELETE'); await j(`/journal/people/${pid}`, undefined, 'DELETE'); assert.equal((await j(`/journal/entries/${ids[0]}`)).status, 200, 'deleting a person/goal never touches entries');
  });

  await t.test('milestones and memories: resurfacing honours the setting, sensitive entries and emotional reflections', async () => {
    const mid = (await j('/journal/milestones', { day: '2030-06-12', title: 'Moved to a new city', entryId: ids[0], atMs: 1000 })).body.id; assert.equal((await j('/journal/milestones', { title: '' })).status, 400);
    await j('/journal/settings', { resurface: true }, 'PUT'); const m = (await j('/journal/memories?today=2032-06-09')).body; assert.equal(m.enabled, true);
    const last = m.items.filter((x: any) => x.label === 'This day last year'); assert.deepEqual(last.map((x: any) => x.entryId), [ids[2]], 'same calendar day a year earlier');
    const m2 = (await j('/journal/memories?today=2032-06-11')).body; assert.ok(!m2.items.some((x: any) => x.entryId === E.eid), 'emotional-reflection entries are not resurfaced'); const m3 = (await j('/journal/memories?today=2032-06-10')).body; assert.ok(!m3.items.some((x: any) => x.entryId === S.eid), 'sensitive entries are not resurfaced');
    const m4 = (await j('/journal/memories?today=2031-06-12')).body; assert.ok(m4.milestones.some((x: any) => x.title === 'Moved to a new city'), 'milestones on this date in earlier years');
    await j('/journal/settings', { resurface: false }, 'PUT'); const off = (await j('/journal/memories?today=2032-06-09')).body; assert.equal(off.enabled, false); assert.equal(off.items.length, 0); await j('/journal/settings', { resurface: true }, 'PUT');
    const tl = (await j('/journal/timeline')).body; assert.ok(tl.some((x: any) => x.type === 'milestone' && x.id === mid)); assert.ok(!tl.some((x: any) => x.id === S.eid), 'sensitive entries stay off the timeline'); await j(`/journal/milestones/${mid}`, undefined, 'DELETE');
  });

  await t.test('marking an entry sensitive removes it from analysis immediately', async () => {
    await j(`/journal/entries/${ids[1]}`, { sensitive: true }, 'PATCH'); const r = (await j('/journal/insights?from=2031-06-01&to=2031-06-30')).body; const ex = r.themes.recurring.find((x: any) => /exercis/i.test(x.label)); assert.ok(!ex || ex.entries < 3, 'theme is no longer "recurring" without that entry'); await j(`/journal/entries/${ids[1]}`, { sensitive: false }, 'PATCH');
  });

  await t.test('cleanup', async () => { for (const id of ids) await j(`/journal/entries/${id}`, undefined, 'DELETE'); for (const r of (await j('/journal/reports')).body) if (r.from_day.startsWith('2031')) await j(`/journal/reports/${r.id}`, undefined, 'DELETE'); await j('/journal/settings', { longitudinal: false }, 'PUT'); db.close(); });
});
