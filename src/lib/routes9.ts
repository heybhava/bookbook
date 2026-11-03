// Life Journal API. Private by default: nothing is shared, and nothing is sent anywhere (all processing is local).
import fs from "node:fs";
import path from "node:path";
import type { Kit } from './routes2';
import * as S from './journal/store';
import * as A from './journal/ai';
import * as L from './journal/life';
import { LANGS, REFERENCE } from './journal/langtest';
import { getLang, detectLanguage } from './lang/registry';
import { routeFor } from './lang/translate';
import { all, get, run } from './db';
import * as V from './vault/store';
import { tx } from './db';

const PROMPTS: Record<string, string[]> = {
  daily: ['What stood out about today?', 'What are you thinking about right now?', 'What was the most meaningful moment today?', 'What would you do differently?', 'What did you notice today that you usually miss?'],
  growth: ['What have you been avoiding?', 'What is something you recently realised?', 'What belief are you questioning?', 'What are you proud of?'],
  gratitude: ['What made today better?', 'Who had a positive impact on your day?', 'What small thing do you appreciate right now?'],
  future: ['What do you want your life to look like in one year?', 'What would your future self thank you for doing today?', 'What should you stop postponing?'],
  weekly: ['What happened this week?', 'What challenged you?', 'What improved?', 'What do you want to carry into next week?'],
  monthly: ['What changed this month?', 'What are you glad you did?', 'What do you want next month to be about?'],
  emotional: ['What is weighing on you? Take your time.', 'What do you wish someone understood about today?'],
  idea: ['What idea won’t leave you alone?', 'What would you build or try if it could not fail?'],
};

export function registerJournal({ on, J, bad, body }: Kit) {
  const wrap = (h: (c: any) => unknown) => async (c: any) => { try { return await h(c); } catch (e: any) { if (e instanceof S.JError) return J({ error: e.message, ...(e as any).expected !== undefined ? { expected: (e as any).expected } : {} }, e.status); if (e instanceof V.VaultError) return J({ error: e.message }, e.status); throw e; } };
  const rng = (req: Request, size: number) => { const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? ''); if (!m) return null; let s = m[1] ? Number(m[1]) : NaN, e = m[2] ? Number(m[2]) : NaN; if (isNaN(s)) { s = Math.max(0, size - e); e = size - 1; } else if (isNaN(e) || e >= size) e = size - 1; return s > e || s >= size ? 'bad' : { s, e }; };

  on('GET', '/journal/status', wrap(async () => { S.recoverInterrupted(); const caps = S.capabilities(); let models: string[] = []; try { const r = await fetch((process.env.OLLAMA_URL || 'http://localhost:11434') + '/api/tags', { signal: AbortSignal.timeout(2500) }); models = ((await r.json()).models ?? []).map((m: any) => m.name); } catch { /* offline */ } return { ...caps, settings: S.settings(), llm: models.length > 0, models, styles: S.STYLES, modes: S.MODES, convModes: Object.keys(A.CONV_MODES) }; }));
  on('GET', '/journal/settings', () => S.settings());
  on('PUT', '/journal/settings', wrap(async ({ req }) => S.saveSettings(await body(req))));
  on('GET', '/journal/prompts', ({ q }) => { const k = q.get('mode') ?? 'daily'; const list = PROMPTS[k] ?? PROMPTS.daily; return { mode: k, prompts: list, pick: list[Math.floor(Math.random() * list.length)], kinds: Object.keys(PROMPTS) }; });

  // ── entries ──
  on('GET', '/journal/entries', wrap(({ q }) => S.listEntries({ from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, kind: q.get('kind') ?? undefined, limit: Number(q.get('limit')) || 200 })));
  on('POST', '/journal/entries', wrap(async ({ req }) => S.createEntry(await body(req))));
  on('GET', '/journal/entries/:id', wrap(({ p }) => S.entryDetail(p.id)));
  on('PATCH', '/journal/entries/:id', wrap(async ({ req, p }) => S.updateEntry(p.id, await body(req))));
  on('DELETE', '/journal/entries/:id', wrap(({ p }) => S.purgeEntry(p.id))); // permanent: media files, transcripts, AI documents and conversations about it
  on('GET', '/journal/calendar', wrap(({ q }) => S.calendar(q.get('month') ?? S.dayOf().slice(0, 7))));
  on('GET', '/journal/search', wrap(({ q }) => S.search(q.get('q') ?? '')));

  // ── recordings ──
  on('POST', '/journal/recordings', wrap(async ({ req }) => S.startRecording(await body(req))));
  on('POST', '/journal/recordings/:id/chunk', wrap(async ({ req, p, q }) => S.appendChunk(p.id, Number(q.get('i')), Buffer.from(await req.arrayBuffer()))));
  on('POST', '/journal/recordings/:id/finish', wrap(async ({ req, p }) => {
    const b = await body(req).catch(() => ({})); const r = S.finishRecording(p.id, Number(b.durationMs) || undefined);
    const st = S.settings(); void A.runPipeline(r.id, st.autoProcess ? ['audio', 'transcribe', ...(st.aiEnabled ? ['notes', 'diary'] as A.Step[] : [])] : ['audio']).catch(() => undefined); // audio prep always; AI steps only if the user opted in
    return { id: r.id, entryId: r.entry_id, status: r.status, size: r.size, autoProcessing: st.autoProcess };
  }));
  on('GET', '/journal/recordings/:id/media', wrap(({ req, p }) => {
    const r = S.recording(p.id); const f = S.mediaPath(p.id); const size = fs.statSync(f).size; const range = rng(req, size);
    const h: Record<string, string> = { 'content-type': r.mime.split(';')[0], 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store' };
    if (range === 'bad') return new Response(null, { status: 416, headers: { ...h, 'content-range': `bytes */${size}` } });
    const { s, e } = range ?? { s: 0, e: size - 1 }; const buf = Buffer.alloc(e - s + 1); const fd = fs.openSync(f, 'r'); try { fs.readSync(fd, buf, 0, buf.length, s); } finally { fs.closeSync(fd); }
    return new Response(new Uint8Array(buf), { status: range ? 206 : 200, headers: { ...h, 'content-length': String(buf.length), ...(range ? { 'content-range': `bytes ${s}-${e}/${size}` } : {}) } });
  }));
  on('GET', '/journal/recordings/:id/download', wrap(({ p }) => { const r = S.recording(p.id); const f = S.mediaPath(p.id); const ext = r.mime.includes('mp4') ? 'mp4' : 'webm'; return new Response(new Uint8Array(fs.readFileSync(f)), { headers: { 'content-type': r.mime.split(';')[0], 'content-disposition': `attachment; filename="journal-${p.id.slice(0, 8)}.${ext}"`, 'x-content-type-options': 'nosniff' } }); }));
  on('GET', '/journal/recordings/:id/thumb', wrap(({ p }) => { S.recording(p.id); const f = path.join(S.journalDir(), p.id, 'thumb.jpg'); if (!fs.existsSync(f)) return J({ error: 'No thumbnail' }, 404); return new Response(new Uint8Array(fs.readFileSync(f)), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } }); }));
  on('PATCH', '/journal/recordings/:id', wrap(async ({ req, p }) => { const b = await body(req); if (typeof b.title === 'string') S.renameRecording(p.id, b.title); return { ok: true }; }));
  on('DELETE', '/journal/recordings/:id', wrap(({ p, q }) => { // layers are deleted separately: ?layer=media | transcript
    const layer = q.get('layer'); if (layer === 'transcript') { S.deleteTranscript(p.id); return { ok: true, deleted: 'transcript' }; } if (layer === 'media') { S.deleteRecordingFile(p.id); return { ok: true, deleted: 'media' }; } throw new S.JError('Choose layer=media or layer=transcript. To remove everything, delete the entry.'); }));
  on('POST', '/journal/recordings/:id/bookmarks', wrap(async ({ req, p }) => { const b = await body(req); return { id: S.addBookmark(p.id, Number(b.atMs) || 0, b.label) }; }));
  on('POST', '/journal/recordings/:id/process', wrap(async ({ req, p }) => {
    const b = await body(req); const steps = (Array.isArray(b.steps) ? b.steps : ['audio', 'transcribe']).filter((s: string) => ['audio', 'transcribe', 'notes', 'diary', 'report', 'translate'].includes(s)) as A.Step[];
    if (steps.includes('translate') && !getLang(b.tgt)) throw new S.JError('Choose a language to translate into.'); if (b.lang && b.lang !== 'auto' && !getLang(b.lang)) throw new S.JError('Unknown spoken language.');
    const opts = { style: b.style, lang: b.lang, model: ['tiny', 'base', 'small', 'medium'].includes(b.model) ? b.model : undefined, tgt: b.tgt }; if (!steps.length) throw new S.JError('No valid steps.');
    S.recording(p.id); if (b.wait) return A.runPipeline(p.id, steps, opts); void A.runPipeline(p.id, steps, opts).catch(() => undefined); return { started: steps };
  }));

  // ── transcript ──
  on('GET', '/journal/transcripts/:id/segments', wrap(({ p, q }) => { // each segment carries its own detected script/language (so code-switching is visible) and, when asked, its translation
    const tl = q.get('lang'); const tr = tl ? new Map(all<any>('SELECT idx, text, warnings FROM j_seg_trans WHERE transcript_id = ? AND lang = ?', p.id, tl).map((r) => [r.idx, r])) : null;
    return S.segments(p.id).map((s: any) => { const d = (s.corrected ?? s.text).trim().length >= 8 ? detectLanguage(s.corrected ?? s.text) : null; return { ...s, lang: d && d.confidence >= 0.5 ? d.code : null, translation: tr?.get(s.idx)?.text ?? null }; });
  }));
  on('GET', '/journal/transcripts/:id/translations', wrap(({ p }) => all('SELECT lang, COUNT(*) n, MAX(model) model, MAX(created_at) at FROM j_seg_trans WHERE transcript_id = ? GROUP BY lang', p.id)));
  on('DELETE', '/journal/transcripts/:id/translations', wrap(({ p, q }) => { run('DELETE FROM j_seg_trans WHERE transcript_id = ? AND lang = ?', p.id, q.get('lang') ?? ''); return { ok: true }; }));
  on('POST', '/journal/docs/:id/translate', wrap(async ({ req, p }) => ({ id: await A.translateDoc(p.id, String((await body(req)).tgt ?? '')) })));
  on('GET', '/journal/languages', wrap(async () => {
    const tests = all<any>('SELECT * FROM j_langtests ORDER BY created_at DESC'); const st = S.settings();
    return { responseLanguage: st.responseLanguage, spokenLanguage: st.spokenLanguage, whisperModel: st.whisperModel, languages: await Promise.all(LANGS.map(async (code) => { const l = getLang(code)!; const rt = code === 'en' ? null : await routeFor('en', code).catch(() => null); const mine = tests.filter((t) => t.lang === code); const latest = mine.find((t) => t.model === `whisper-${st.whisperModel}`) ?? null;
      return { code, name: l.en, native: l.native, script: l.script, reference: REFERENCE[code], tested: latest ? { model: latest.model, cer: latest.cer, band: latest.band, at: latest.created_at, got: latest.got, expected: latest.expected } : null, testedOtherModels: mine.filter((t) => t !== latest).map((t) => ({ model: t.model, cer: t.cer, band: t.band })).slice(0, 4), translation: rt ? { model: rt.model, quality: rt.quality, note: rt.reason } : null, status: latest ? `measured here: ${latest.band} (character error ${Math.round(latest.cer * 100)}% on one sentence)` : 'not tested on this machine — read the reference sentence aloud to measure it' }; })) };
  }));
  on('POST', '/journal/language-test', wrap(async ({ req }) => { // the person's own reading of a known sentence; the recording is a throwaway and is removed afterwards unless keep:true
    const b = await req.json().catch(() => ({})); if (!getLang(b.lang)) throw new S.JError('Choose a language.'); const rec = S.recording(String(b.recordingId ?? '')); const expected = String(b.expected ?? REFERENCE[b.lang] ?? '');
    const r = await A.runLanguageTest(rec.id, b.lang, expected, ['tiny', 'base', 'small', 'medium'].includes(b.model) ? b.model : undefined); if (!b.keep) S.purgeEntry(rec.entry_id); return r;
  }));
  on('DELETE', '/journal/language-tests', wrap(({ q }) => { run('DELETE FROM j_langtests WHERE lang = ?', q.get('lang') ?? ''); return { ok: true }; })); // results are the person's own measurements; they can clear them
  on('GET', '/journal/language-tests',() => all('SELECT * FROM j_langtests ORDER BY created_at DESC LIMIT 100'));
  on('PUT', '/journal/transcripts/:id/segments/:idx', wrap(async ({ req, p }) => { const b = await body(req); S.correctSegment(p.id, Number(p.idx), typeof b.corrected === 'string' && b.corrected.trim() ? b.corrected : null); return { ok: true }; })); // writes `corrected`; the verbatim text column is never modified
  on('PATCH', '/journal/docs/:id', wrap(async ({ req, p }) => { const b = await body(req); if (typeof b.body !== 'string') throw new S.JError('body required'); run('UPDATE j_docs SET body = ?, edited = 1 WHERE id = ?', b.body.slice(0, 500000), p.id); return { ok: true }; }));
  on('DELETE', '/journal/docs/:id', wrap(({ p }) => { S.deleteDoc(p.id); return { ok: true }; }));

  // ── conversations ──
  on('GET', '/journal/convs', ({ q }) => all(q.get('entry') ? 'SELECT * FROM j_convs WHERE entry_id = ? ORDER BY updated_at DESC' : 'SELECT * FROM j_convs ORDER BY updated_at DESC LIMIT 100', ...(q.get('entry') ? [q.get('entry')] : [])));
  on('POST', '/journal/convs', wrap(async ({ req }) => ({ id: A.startConversation(await body(req)) })));
  on('GET', '/journal/convs/:id', wrap(({ p }) => ({ conv: get('SELECT * FROM j_convs WHERE id = ?', p.id), messages: all('SELECT * FROM j_messages WHERE conv_id = ? ORDER BY id', p.id) })));
  on('POST', '/journal/convs/:id/messages', wrap(async ({ req, p }) => A.converse(p.id, String((await body(req)).text ?? ''))));
  on('POST', '/journal/messages/:id/save', wrap(async ({ req, p }) => { const b = await body(req); run('UPDATE j_messages SET saved = ? WHERE id = ?', b.saved === false ? 0 : 1, p.id); return { ok: true }; }));
  on('DELETE', '/journal/convs/:id', wrap(({ p }) => { run('DELETE FROM j_convs WHERE id = ?', p.id); return { ok: true }; })); // independent of the entry

  // ── life intelligence (phase 5) ──
  on('GET', '/journal/insights', wrap(({ q }) => { const p = L.periodFor(q.get('kind') ?? 'custom', q.get('to') ?? undefined, q.get('from') ?? undefined); return L.insights(p.from, p.to); }));
  on('POST', '/journal/reports', wrap(async ({ req }) => { const b = await body(req); return L.periodReport(String(b.kind ?? 'week'), { from: b.from, to: b.to, narrative: !!b.narrative }); }));
  on('GET', '/journal/reports', () => L.listReports());
  on('GET', '/journal/reports/:id', wrap(({ p }) => L.getReport(p.id)));
  on('DELETE', '/journal/reports/:id', wrap(({ p }) => { run('DELETE FROM j_reports WHERE id = ?', p.id); return { ok: true }; }));
  on('GET', '/journal/suggestions', wrap(() => L.suggestions()));
  on('POST', '/journal/suggestions/dismiss', wrap(async ({ req }) => { L.dismiss(String((await body(req)).key ?? '')); return { ok: true }; }));
  on('GET', '/journal/people', () => L.listPeople());
  on('POST', '/journal/people', wrap(async ({ req }) => ({ id: L.savePerson(await body(req)) })));
  on('PATCH', '/journal/people/:id', wrap(async ({ req, p }) => ({ id: L.savePerson({ ...(await body(req)), id: p.id }) })));
  on('GET', '/journal/people/:id', wrap(({ p }) => L.personMentions(p.id)));
  on('DELETE', '/journal/people/:id', wrap(({ p }) => { run('DELETE FROM j_people WHERE id = ?', p.id); return { ok: true }; })); // removes the profile only; entries are untouched
  on('GET', '/journal/goals', () => L.listGoals());
  on('POST', '/journal/goals', wrap(async ({ req }) => ({ id: L.saveGoal(await body(req)) })));
  on('PATCH', '/journal/goals/:id', wrap(async ({ req, p }) => ({ id: L.saveGoal({ ...(await body(req)), id: p.id }) })));
  on('GET', '/journal/goals/:id', wrap(({ p }) => L.goalDetail(p.id)));
  on('POST', '/journal/goals/:id/updates', wrap(async ({ req, p }) => ({ id: L.addGoalUpdate(p.id, await body(req)) })));
  on('DELETE', '/journal/goals/:id', wrap(({ p }) => { run('DELETE FROM j_goals WHERE id = ?', p.id); return { ok: true }; }));
  on('GET', '/journal/milestones', () => L.listMilestones());
  on('POST', '/journal/milestones', wrap(async ({ req }) => ({ id: L.saveMilestone(await body(req)) })));
  on('DELETE', '/journal/milestones/:id', wrap(({ p }) => { run('DELETE FROM j_milestones WHERE id = ?', p.id); return { ok: true }; }));
  on('GET', '/journal/memories', wrap(({ q }) => L.memories(q.get('today') ?? undefined)));
  on('GET', '/journal/timeline', wrap(() => L.timeline()));

  // ── export / knowledge integration ──
  on('GET', '/journal/entries/:id/export', wrap(({ p }) => new Response(S.exportMarkdown(p.id), { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="journal-${S.getEntry(p.id).day}.md"`, 'x-content-type-options': 'nosniff' } })));
  on('POST', '/journal/entries/:id/to-vault', wrap(async ({ req, p }) => { // the entry becomes a real note in a vault: it then has backlinks, tags, graph, search and Bases like any other note
    const b = await body(req).catch(() => ({})); const v = V.getVault(b.vault); const e = S.getEntry(p.id); const name = `${e.day} ${(e.title ?? 'Journal').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').slice(0, 60)}`.trim();
    let rel = `Journal/${name}.md`; for (let i = 2; fs.existsSync(V.safePath(v, rel)); i++) rel = `Journal/${name} ${i}.md`;
    return V.writeFile(v, rel, S.exportMarkdown(p.id), { create: true });
  }));
  void tx;
}
