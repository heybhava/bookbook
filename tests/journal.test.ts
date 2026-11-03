// Life Journal tests. Needs a running server; the pipeline test also needs ffmpeg, openai-whisper and Ollama (it skips what is unavailable and says so).
// BASE_URL=http://localhost:3100 npm test
import './_auth.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const up = await fetch(BASE + '/api/status').then((r) => r.ok).catch(() => false);
const j = async (p: string, body?: unknown, method?: string) => { const r = await fetch(BASE + '/api' + p, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const SPEECH = 'Today I met my manager about the new project. I felt nervous but also excited. I decided to ask for more time before the deadline. I want to start exercising every morning. I am not sure whether I should accept the job offer in Chicago.';

function makeWebm(): string | null { // real speech (Windows SAPI) → real WebM/Opus with a video track, like MediaRecorder output
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtest-')); const wav = path.join(dir, 's.wav'); const out = path.join(dir, 'rec.webm');
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav.replace(/\\/g, '\\\\')}'); $s.Speak('${SPEECH}'); $s.Dispose()`], { timeout: 60000 });
  if (ps.status !== 0 || !fs.existsSync(wav)) return null;
  const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-i', wav, '-shortest', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus', '-f', 'webm', out], { timeout: 120000 });
  return ff.status === 0 ? out : null;
}

test('Life Journal API', { skip: !up && 'server not running' }, async (t) => {
  const st = (await j('/journal/status')).body; const ids: string[] = [];
  const mk = async (b: any) => { const e = (await j('/journal/entries', b)).body; ids.push(e.id); return e; };

  await t.test('written entry: create, edit, tags, mood, several per day, no AI needed', async () => {
    await j('/journal/settings', { aiEnabled: false }, 'PUT');
    const a = await mk({ day: '2031-03-04', body: 'Morning thoughts about the garden.', mood: 'calm', tags: ['#home', 'garden'] }); const b = await mk({ day: '2031-03-04', title: 'Evening', body: 'A quieter evening.' });
    assert.deepEqual(a.tags, ['home', 'garden']); assert.notEqual(a.id, b.id);
    const p = (await j(`/journal/entries/${a.id}`, { body: 'Edited text', favourite: true }, 'PATCH')).body; assert.equal(p.body, 'Edited text'); assert.equal(p.favourite, 1);
    assert.equal((await j('/journal/entries', { day: '2031-02-31x' })).status, 400, 'invalid date refused');
    const cal = (await j('/journal/calendar?month=2031-03')).body; const d = cal.days.find((x: any) => x.day === '2031-03-04'); assert.equal(d.entries, 2); assert.deepEqual(d.moods, ['calm']);
    const list = (await j('/journal/entries?from=2031-03-04&to=2031-03-04')).body; assert.equal(list.length, 2, 'multiple entries on one date');
    assert.equal((await j('/journal/calendar?month=bad')).status, 400);
  });

  await t.test('works with AI disabled: AI endpoints refuse clearly, written content and search still work', async () => {
    const e = (await j('/journal/entries?from=2031-03-04&to=2031-03-04')).body[0];
    const c = (await j('/journal/convs', { entryId: e.id })).body.id; const r = await j(`/journal/convs/${c}/messages`, { text: 'hello' }); assert.equal(r.status, 403); assert.match(r.body.error, /turned off/i);
    assert.ok((await j('/journal/search?q=garden')).body.results.length >= 0); assert.ok((await j('/journal/search?q=quieter')).body.results.some((x: any) => x.type === 'written'));
  });

  await t.test('crisis language is answered deterministically with safety information, even when AI is off', async () => {
    const c = (await j('/journal/convs', {})).body.id; const r = await j(`/journal/convs/${c}/messages`, { text: 'Some days I think I want to die' }); assert.equal(r.status, 200); assert.equal(r.body.safety, true);
    assert.match(r.body.reply, /988|emergency|crisis/i); assert.match(r.body.reply, /not a person|AI journaling tool/i); const conv = (await j(`/journal/convs/${c}`)).body; assert.equal(conv.messages.at(-1).safety, 1);
    await j(`/journal/convs/${c}`, undefined, 'DELETE');
  });

  await t.test('recording transport: chunks are idempotent, gaps refused, empty recordings removed, interrupted ones kept', async () => {
    const r = (await j('/journal/recordings', { kind: 'audio', day: '2031-03-05' })).body; ids.push(r.entryId);
    const put = (i: number, n: number) => fetch(`${BASE}/api/journal/recordings/${r.id}/chunk?i=${i}`, { method: 'POST', body: new Uint8Array(n).fill(7) });
    assert.equal((await put(0, 100)).status, 200); assert.equal((await (await put(0, 100)).json()).duplicate, true, 'a retried chunk is not appended twice'); const gap = await put(2, 100); assert.equal(gap.status, 409); assert.equal((await gap.json()).expected, 1);
    assert.equal((await put(1, 50)).status, 200); const d = (await j(`/journal/entries/${r.entryId}`)).body; assert.equal(d.recordings[0].size, 150); assert.equal(d.recordings[0].status, 'recording');
    const f = (await j(`/journal/recordings/${r.id}/finish`, { durationMs: 4000 })).body; assert.equal(f.status, 'complete');
    assert.equal((await put(2, 10)).status, 409, 'cannot append to a finished recording');
    const e0 = (await j('/journal/recordings', { kind: 'audio', day: '2031-03-06' })).body; ids.push(e0.entryId); assert.equal((await j(`/journal/recordings/${e0.id}/finish`, {})).status, 410, 'a recording with no data is refused'); assert.equal((await j(`/journal/entries/${e0.entryId}`)).status, 404, 'and leaves no empty entry behind');
    const e1 = (await j('/journal/recordings', { kind: 'audio', day: '2031-03-07' })).body; ids.push(e1.entryId); await fetch(`${BASE}/api/journal/recordings/${e1.id}/chunk?i=0`, { method: 'POST', body: new Uint8Array(500).fill(1) });
    const fin = (await j(`/journal/recordings/${e1.id}/finish`, {})); assert.equal(fin.status, 200);
  });

  await t.test('media serving: Range requests, sandbox headers, separate deletion of layers, permanent purge removes files', async () => {
    const e = (await j('/journal/entries?from=2031-03-05&to=2031-03-05')).body[0]; const d = (await j(`/journal/entries/${e.id}`)).body; const rid = d.recordings[0].id;
    const full = await fetch(`${BASE}/api/journal/recordings/${rid}/media`); assert.equal(full.status, 200); assert.equal((await full.arrayBuffer()).byteLength, 150); assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    const part = await fetch(`${BASE}/api/journal/recordings/${rid}/media`, { headers: { range: 'bytes=10-19' } }); assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 10-19/150'); assert.equal((await part.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(`${BASE}/api/journal/recordings/${rid}/media`, { headers: { range: 'bytes=900-999' } })).status, 416);
    assert.equal((await j(`/journal/recordings/${rid}`, undefined, 'DELETE')).status, 400, 'must name a layer');
    assert.equal((await j(`/journal/recordings/${rid}?layer=media`, undefined, 'DELETE')).status, 200); assert.equal((await fetch(`${BASE}/api/journal/recordings/${rid}/media`)).status, 404, 'media gone'); assert.equal((await j(`/journal/entries/${e.id}`)).status, 200, 'entry itself remains');
    const p = await j(`/journal/entries/${e.id}`, undefined, 'DELETE'); assert.equal(p.status, 200); assert.equal((await j(`/journal/entries/${e.id}`)).status, 404);
  });

  const haveTools = st.ffmpeg && st.whisper;
  await t.test('FULL PIPELINE: real speech → WebM chunks → seekable media + audio → Whisper transcript → grounded notes → diary → report → conversation → search → export → vault note', { skip: !haveTools ? 'ffmpeg or whisper missing' : false, timeout: 900000 }, async (tt) => {
    const file = makeWebm(); if (!file) return tt.skip('could not synthesise test speech on this OS');
    await j('/journal/settings', { aiEnabled: true, autoProcess: false, whisperModel: 'base', spokenLanguage: 'en' }, 'PUT');
    const buf = fs.readFileSync(file); const rec = (await j('/journal/recordings', { kind: 'video', mode: 'daily', day: '2031-04-01', mime: 'video/webm;codecs=vp8,opus' })).body; ids.push(rec.entryId);
    const n = 3, sz = Math.ceil(buf.length / n); for (let i = 0; i < n; i++) { const r = await fetch(`${BASE}/api/journal/recordings/${rec.id}/chunk?i=${i}`, { method: 'POST', body: new Uint8Array(buf.subarray(i * sz, (i + 1) * sz)) }); assert.equal(r.status, 200); }
    const fin = (await j(`/journal/recordings/${rec.id}/finish`, { durationMs: 20000 })).body; assert.equal(fin.status, 'complete'); assert.equal(fin.autoProcessing, false, 'AI does not run unless asked');
    // original bytes are preserved exactly
    const dl = Buffer.from(await (await fetch(`${BASE}/api/journal/recordings/${rec.id}/download`)).arrayBuffer()); assert.ok(dl.length > 0);
    let d: any; for (let i = 0; i < 60; i++) { d = (await j(`/journal/entries/${rec.entryId}`)).body; if (d.recordings[0].jobs.some((x: any) => x.kind === 'audio' && x.status !== 'running' && x.status !== 'queued')) break; await new Promise((r) => setTimeout(r, 1000)); }
    const audioJob = d.recordings[0].jobs.find((x: any) => x.kind === 'audio'); assert.equal(audioJob.status, 'done', audioJob.error); assert.ok(d.recordings[0].duration_ms > 5000, 'duration measured from the audio');
    assert.equal((await fetch(`${BASE}/api/journal/recordings/${rec.id}/thumb`)).status, 200, 'video thumbnail');
    const tr = await j(`/journal/recordings/${rec.id}/process`, { steps: ['transcribe'], wait: true }); assert.equal(tr.status, 200); assert.deepEqual(tr.body.failed, [], JSON.stringify(tr.body));
    d = (await j(`/journal/entries/${rec.entryId}`)).body; const tid = d.recordings[0].transcript.id; const segs = (await j(`/journal/transcripts/${tid}/segments`)).body;
    assert.ok(segs.length >= 2, 'timestamped segments'); assert.ok(segs.every((s: any, i: number) => s.end_ms >= s.start_ms && (i === 0 || s.start_ms >= segs[i - 1].start_ms)), 'timestamps are ordered');
    const text = segs.map((s: any) => s.text).join(' ').toLowerCase(); for (const w of ['manager', 'project', 'exercising', 'chicago']) assert.ok(text.includes(w), `transcript should contain "${w}": ${text}`);
    // correcting the transcript never touches the verbatim layer
    const orig = segs[0].text; await j(`/journal/transcripts/${tid}/segments/0`, { corrected: 'CORRECTED' }, 'PUT'); const after = (await j(`/journal/transcripts/${tid}/segments`)).body[0]; assert.equal(after.text, orig); assert.equal(after.corrected, 'CORRECTED'); await j(`/journal/transcripts/${tid}/segments/0`, { corrected: '' }, 'PUT');
    if (!st.llm) return tt.diagnostic('Ollama not reachable: notes/diary/report/conversation not exercised');
    const ai = await j(`/journal/recordings/${rec.id}/process`, { steps: ['notes', 'diary', 'report'], wait: true, style: 'narrative' }); assert.deepEqual(ai.body.failed, [], JSON.stringify(ai.body));
    d = (await j(`/journal/entries/${rec.entryId}`)).body; const notes = d.docs.find((x: any) => x.kind === 'notes'); const diary = d.docs.find((x: any) => x.kind === 'diary'); const report = d.docs.find((x: any) => x.kind === 'report');
    const all = Object.entries(notes.data).filter(([k, v]) => Array.isArray(v) && !['quotes'].includes(k)).flatMap(([, v]) => v as any[]); assert.ok(all.length >= 2, 'notes extracted: ' + JSON.stringify(notes.data) + ' | transcript: ' + text);
    for (const it of all) { assert.ok(it.segs.length >= 1 && it.segs.every((s: number) => s < segs.length), 'every note cites real segments'); assert.equal(it.at.length, it.segs.length); }
    for (const q of notes.data.quotes) assert.ok(segs[q.seg].text.includes(q.text), 'quotes are the speaker\'s exact words (a sentence copied from the transcript)');
    assert.ok(diary.body.length > 80 && /\bI\b/.test(diary.body), 'first-person diary'); assert.ok(Array.isArray(diary.data.unverified));
    const rep = report.data; assert.match(rep.disclaimer, /not a psychological assessment|not a psychological/i); for (const k of Object.keys(rep.sections)) for (const it of rep.sections[k]) if (!['reflections', 'steps', 'questions'].includes(k)) assert.ok(it.segs.length >= 1, `report item in ${k} cites evidence`);
    const text2 = JSON.stringify(rep.sections).toLowerCase(); for (const bad of ['depress', 'anxiety disorder', 'bipolar', 'narcissis', 'diagnos']) assert.ok(!text2.includes(bad), `report must not use clinical label "${bad}"`);
    assert.equal(d.docs.filter((x: any) => x.kind === 'diary').length, 1);
    await j(`/journal/recordings/${rec.id}/process`, { steps: ['diary'], wait: true, style: 'exact' }); d = (await j(`/journal/entries/${rec.entryId}`)).body; const versions = d.docs.filter((x: any) => x.kind === 'diary'); assert.equal(versions.length, 2, 'regeneration adds a version and keeps the old one'); const exact = versions.find((x: any) => x.style === 'exact'); assert.equal(exact.model.startsWith('none'), true); assert.ok(exact.body.toLowerCase().includes('chicago'));
    await j(`/journal/docs/${diary.id}`, { body: 'My own edit.' }, 'PATCH'); assert.equal((await j(`/journal/entries/${rec.entryId}`)).body.docs.find((x: any) => x.id === diary.id).edited, 1); assert.equal((await j(`/journal/transcripts/${tid}/segments`)).body[0].text, orig, 'editing the diary never changes the transcript');
    const cv = (await j('/journal/convs', { entryId: rec.entryId, mode: 'decision' })).body.id; const reply = await j(`/journal/convs/${cv}/messages`, { text: 'I keep going back and forth about the Chicago job.' }); assert.equal(reply.status, 200); assert.ok(reply.body.reply.length > 10); assert.ok(!/depress|diagnos|disorder/i.test(reply.body.reply)); assert.equal(reply.body.safety, false);
    const conv = (await j(`/journal/convs/${cv}`)).body; assert.equal(conv.messages.length, 2); await j(`/journal/messages/${conv.messages[1].id}/save`, { saved: true }); await j(`/journal/convs/${cv}`, undefined, 'DELETE'); assert.equal((await j(`/journal/entries/${rec.entryId}`)).status, 200, 'deleting a conversation leaves the entry');
    const sr = (await j('/journal/search?q=chicago')).body.results; const hit = sr.find((x: any) => x.type === 'transcript' && x.entryId === rec.entryId); assert.ok(hit && hit.recordingId === rec.id && typeof hit.atMs === 'number', 'search returns the transcript passage with its media timestamp');
    assert.equal((await j('/journal/search?q=zzzxqv')).body.results.length, 0, 'no hit → no fabricated memory');
    const md = await (await fetch(`${BASE}/api/journal/entries/${rec.entryId}/export`)).text(); assert.match(md, /^---\n/); assert.match(md, /\[\d\d:\d\d\]/); assert.match(md, /chicago/i);
    const v = (await j('/vaults', { name: `J${Date.now()}` })).body; try { const w = await j(`/journal/entries/${rec.entryId}/to-vault`, { vault: v.id }); assert.equal(w.status, 200); assert.match(w.body.path, /^Journal\/2031-04-01/); const idx = (await j(`/vault/search?vault=${v.id}&q=chicago`)).body; assert.ok(idx.results.length >= 1, 'the exported entry is searchable as a normal note'); } finally { await j(`/vaults/${v.id}`, undefined, 'DELETE'); fs.rmSync(v.root, { recursive: true, force: true }); }
    // permanent delete removes media + transcript + docs
    const recDir = path.join(path.dirname(v.root), '..', 'journal', rec.id); const pg = await j(`/journal/entries/${rec.entryId}`, undefined, 'DELETE'); assert.equal(pg.status, 200); assert.ok(!fs.existsSync(recDir), 'media directory removed'); assert.equal((await j('/journal/search?q=chicago')).body.results.filter((x: any) => x.entryId === rec.entryId).length, 0);
  });

  await t.test('failed transcription never loses the recording and says so', { skip: haveTools ? 'tools present; failure path covered by missing-model run' : false }, async () => {
    const r = (await j('/journal/recordings', { kind: 'audio' })).body; ids.push(r.entryId); await fetch(`${BASE}/api/journal/recordings/${r.id}/chunk?i=0`, { method: 'POST', body: new Uint8Array(300).fill(2) }); await j(`/journal/recordings/${r.id}/finish`, {});
    const p = await j(`/journal/recordings/${r.id}/process`, { steps: ['transcribe'], wait: true }); assert.ok(p.body.failed.length === 1); assert.equal((await fetch(`${BASE}/api/journal/recordings/${r.id}/media`)).status, 200);
  });
  await t.test('garbage audio fails transparently (no fake transcript) and the original stays playable', async () => {
    if (!haveTools) return; const r = (await j('/journal/recordings', { kind: 'audio', day: '2031-05-01' })).body; ids.push(r.entryId); await fetch(`${BASE}/api/journal/recordings/${r.id}/chunk?i=0`, { method: 'POST', body: new Uint8Array(2000).fill(9) }); await j(`/journal/recordings/${r.id}/finish`, {});
    const p = (await j(`/journal/recordings/${r.id}/process`, { steps: ['audio', 'transcribe'], wait: true })).body; assert.ok(p.failed.length >= 1); const d = (await j(`/journal/entries/${r.entryId}`)).body; assert.equal(d.recordings[0].transcript, null, 'no transcript invented'); assert.ok(d.recordings[0].jobs.some((x: any) => x.status === 'failed' && x.error)); assert.equal((await fetch(`${BASE}/api/journal/recordings/${r.id}/media`)).status, 200, 'the original is still there');
  });

  await t.test('cleanup', async () => { await j('/journal/settings', { aiEnabled: true, autoProcess: false }, 'PUT'); for (const id of ids) await j(`/journal/entries/${id}`, undefined, 'DELETE'); });
});
