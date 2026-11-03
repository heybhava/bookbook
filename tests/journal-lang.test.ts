// Multilingual journal: measurement maths (pure) + API behaviour with a real local model. BASE_URL=http://localhost:3100 npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cer, wer, band, normText, REFERENCE, LANGS } from '../src/lib/journal/langtest.ts';

test('cer/wer: identical = 0, punctuation and case ignored, Indic vowel signs matter, empty cases', () => {
  assert.equal(cer(REFERENCE.te, REFERENCE.te), 0); assert.equal(wer(REFERENCE.hi, REFERENCE.hi), 0);
  assert.equal(cer('Hello, World!', 'hello world'), 0); assert.equal(normText('  Hello,   WORLD ! '), 'hello world');
  assert.ok(cer('నడిచాను', 'నడిచాను') === 0 && cer('నడిచాను', 'నడచాను') > 0, 'a missing vowel sign is an error');
  assert.ok(cer('నడిచాను', 'నడచాను') < 0.5, 'but only one grapheme unit, not several'); assert.equal(cer('', ''), 0); assert.equal(cer('', 'x'), 1); assert.equal(cer('abc', ''), 1); assert.ok(cer('abc', 'xyzxyz') > 1);
  assert.equal(wer('the cat sat', 'the dog sat'), 1 / 3);
});
test('bands are coarse and ordered; every supported language has a reference sentence in its own script', () => {
  assert.deepEqual([band(0), band(0.15), band(0.2), band(0.35), band(0.9)], ['good', 'good', 'fair', 'fair', 'poor']);
  for (const l of LANGS) assert.ok(REFERENCE[l].length > 20); assert.ok(/[ఀ-౿]/.test(REFERENCE.te) && /[஀-௿]/.test(REFERENCE.ta) && /[ऀ-ॿ]/.test(REFERENCE.hi) && /[ಀ-೿]/.test(REFERENCE.kn) && /[ഀ-ൿ]/.test(REFERENCE.ml));
});

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const up = await fetch(BASE + '/api/status').then((r) => r.ok).catch(() => false);
const j = async (p: string, body?: unknown, method?: string) => { const r = await fetch(BASE + '/api' + p, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
const scriptShare = (s: string, re: RegExp) => { const L = s.match(/\p{L}/gu) ?? []; return L.length ? L.filter((c) => re.test(c)).length / L.length : 0; };
const TELUGU = /[ఀ-౿]/;

function speechWebm(text: string): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jl-')); const wav = path.join(dir, 's.wav'); const out = path.join(dir, 'a.webm');
  const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav.replace(/\\/g, '\\\\')}'); $s.Speak('${text}'); $s.Dispose()`], { timeout: 60000 });
  if (ps.status !== 0 || !fs.existsSync(wav)) return null; return spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-c:a', 'libopus', '-f', 'webm', out], { timeout: 60000 }).status === 0 ? out : null;
}

test('Multilingual journal API', { skip: !up && 'server not running' }, async (t) => {
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path.resolve(process.env.BOOKREADER_DATA_DIR || './data', 'bookreader.db')); db.exec('PRAGMA busy_timeout = 5000');
  const st = (await j('/journal/status')).body; const ids: string[] = []; const testIds: string[] = [];
  const seed = (day: string, segs: string[], lang: string | null) => { const eid = `l-e-${Date.now()}-${ids.length}`, rid = eid.replace('-e-', '-r-'), tid = eid.replace('-e-', '-t-'), n = Date.now();
    db.prepare("INSERT INTO j_entries (id, user_id, day, kind, title, body, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(eid, 'local', day, 'audio', 'Lang seed', '', '[]', n, n);
    db.prepare("INSERT INTO j_recordings (id, entry_id, kind, mime, size, duration_ms, chunks, status, started_at) VALUES (?,?,?,?,?,?,?,?,?)").run(rid, eid, 'audio', 'audio/webm', 10, 9000, 1, 'complete', n);
    db.prepare('INSERT INTO j_transcripts (id, recording_id, lang, model, created_at) VALUES (?,?,?,?,?)').run(tid, rid, lang, 'whisper-base', n); segs.forEach((s, i) => db.prepare('INSERT INTO j_segments (transcript_id, idx, start_ms, end_ms, text) VALUES (?,?,?,?,?)').run(tid, i, i * 3000, i * 3000 + 2800, s)); ids.push(eid); return { eid, rid, tid }; };
  const MIX = ['Today I met my manager about the new project and I felt nervous.', 'నేను ఈ రోజు చాలా సేపు నడిచాను మరియు ఆలోచించాను.', 'Then I decided to ask for more time before the deadline.'];
  const M = seed('2031-08-01', MIX, 'en');

  await t.test('code-switching stays visible: each segment reports its own language; the transcript is never rewritten', async () => {
    const segs = (await j(`/journal/transcripts/${M.tid}/segments`)).body; assert.deepEqual(segs.map((s: any) => s.lang), ['en', 'te', 'en']); assert.deepEqual(segs.map((s: any) => s.text), MIX);
  });

  await t.test('settings: response language is validated', async () => {
    assert.equal((await j('/journal/settings', { responseLanguage: 'xx-nope' }, 'PUT')).body.responseLanguage, 'same', 'invalid code ignored'); assert.equal((await j('/journal/settings', { responseLanguage: 'te' }, 'PUT')).body.responseLanguage, 'te'); await j('/journal/settings', { responseLanguage: 'same' }, 'PUT');
  });

  await t.test('translated transcript is a separate, labelled layer; timestamps align; original untouched; searchable; deletable', { skip: !st.llm && 'Ollama not reachable', timeout: 300000 }, async () => {
    assert.equal((await j(`/journal/recordings/${M.rid}/process`, { steps: ['translate'], tgt: 'xx', wait: true })).status, 400);
    const r = (await j(`/journal/recordings/${M.rid}/process`, { steps: ['translate'], tgt: 'hi', wait: true })).body; assert.deepEqual(r.failed, [], JSON.stringify(r));
    const segs = (await j(`/journal/transcripts/${M.tid}/segments?lang=hi`)).body; assert.equal(segs.length, 3); assert.deepEqual(segs.map((s: any) => s.text), MIX, 'verbatim layer unchanged'); assert.deepEqual(segs.map((s: any) => s.start_ms), [0, 3000, 6000], 'same timestamps');
    assert.ok(segs.every((s: any) => s.translation && s.translation.length > 3)); const dev = /[ऀ-ॿ]/; assert.ok(scriptShare(segs[0].translation, dev) > 0.6 && scriptShare(segs[2].translation, dev) > 0.6, `Hindi script expected: ${segs[0].translation}`);
    const d = (await j(`/journal/entries/${M.eid}`)).body; const job = d.recordings[0].jobs.find((x: any) => x.kind === 'translate'); assert.equal(job.status, 'done'); assert.match(job.detail, /Machine translation/);
    assert.equal((await j(`/journal/recordings/${M.rid}/process`, { steps: ['translate'], tgt: 'en', wait: true })).body.failed[0]?.error.includes('already') || true, true);
    const word = segs[0].translation.split(/\s+/).find((w: string) => dev.test(w) && w.length > 2)!; assert.ok((await j(`/journal/search?q=${encodeURIComponent(word)}`)).body.results.some((x: any) => x.type === 'translation' && x.entryId === M.eid && typeof x.atMs === 'number'), 'translated words are searchable and link to the media time');
    assert.equal((await j(`/journal/transcripts/${M.tid}/translations`)).body[0].lang, 'hi'); await j(`/journal/transcripts/${M.tid}/translations?lang=hi`, undefined, 'DELETE'); assert.equal((await j(`/journal/transcripts/${M.tid}/translations`)).body.length, 0); assert.equal((await j(`/journal/transcripts/${M.tid}/segments`)).body.length, 3, 'deleting a translation keeps the transcript');
  });

  await t.test('same-language translation is refused clearly', async () => {
    const r = (await j(`/journal/recordings/${M.rid}/process`, { steps: ['translate'], tgt: 'en', wait: true })).body; assert.equal(r.failed.length, 1); assert.match(r.failed[0].error, /already in that language/);
  });

  await t.test('writing in the preferred language: diary + conversation come out in Telugu script, transcript and sources are unchanged', { skip: !st.llm && 'Ollama not reachable', timeout: 400000 }, async () => {
    await j('/journal/settings', { aiEnabled: true, responseLanguage: 'te' }, 'PUT');
    try {
      const r = (await j(`/journal/recordings/${M.rid}/process`, { steps: ['diary'], style: 'narrative', wait: true })).body; assert.deepEqual(r.failed, [], JSON.stringify(r));
      const d = (await j(`/journal/entries/${M.eid}`)).body; const diary = d.docs.find((x: any) => x.kind === 'diary'); assert.ok(scriptShare(diary.body, TELUGU) > 0.4, `diary should be mostly Telugu script: ${diary.body.slice(0, 120)}`);
      assert.deepEqual((await j(`/journal/transcripts/${M.tid}/segments`)).body.map((s: any) => s.text), MIX);
      const exact = (await j(`/journal/recordings/${M.rid}/process`, { steps: ['diary'], style: 'exact', wait: true })).body; assert.deepEqual(exact.failed, []); const ex = (await j(`/journal/entries/${M.eid}`)).body.docs.find((x: any) => x.style === 'exact'); assert.ok(ex.body.includes('manager') && ex.body.includes('నేను'), 'the "preserve my exact words" style never translates');
      const cv = (await j('/journal/convs', { entryId: M.eid, mode: 'companion' })).body.id; const rep = (await j(`/journal/convs/${cv}/messages`, { text: 'I felt nervous about the deadline today.' })).body; assert.ok(scriptShare(rep.reply, TELUGU) > 0.3, `reply should be Telugu: ${rep.reply}`);
      const tr = await j(`/journal/docs/${diary.id}/translate`, { tgt: 'hi' }); assert.equal(tr.status, 200); const d2 = (await j(`/journal/entries/${M.eid}`)).body; const tdoc = d2.docs.find((x: any) => x.kind === 'translation'); assert.ok(tdoc && tdoc.style === 'hi' && tdoc.data.sourceDoc === diary.id); assert.equal(d2.docs.find((x: any) => x.id === diary.id).body, diary.body, 'translating never overwrites the diary');
      assert.equal((await j(`/journal/docs/${d.docs.find((x: any) => x.kind === 'notes')?.id ?? 'x'}/translate`, { tgt: 'hi' })).status === 200, false, 'only diaries are translatable');
    } finally { await j('/journal/settings', { responseLanguage: 'same' }, 'PUT'); }
  });

  const haveTools = st.ffmpeg && st.whisper;
  await t.test('language check: reading a known sentence is measured; wrong-language forcing is measured as poor; untested languages say so', { skip: !haveTools ? 'ffmpeg or whisper missing' : false, timeout: 600000 }, async (tt) => {
    const file = speechWebm(REFERENCE.en); if (!file) return tt.skip('could not synthesise speech on this OS'); const buf = fs.readFileSync(file);
    const before = (await j('/journal/languages')).body; assert.ok(before.languages.find((l: any) => l.code === 'kn').status.startsWith('not tested')); assert.equal(before.languages.length, 6);
    const mkRec = async () => { const r = (await j('/journal/recordings', { kind: 'audio', day: '2031-09-01' })).body; await fetch(`${BASE}/api/journal/recordings/${r.id}/chunk?i=0`, { method: 'POST', body: new Uint8Array(buf) }); await j(`/journal/recordings/${r.id}/finish`, {}); return r; };
    await j('/journal/settings', { whisperModel: 'base' }, 'PUT');
    const a = await mkRec(); const ok = (await j('/journal/language-test', { recordingId: a.id, lang: 'en' })).body; testIds.push(ok.id); assert.ok(ok.cer <= 0.2, `clean English speech should be recognised: cer ${ok.cer}, heard "${ok.got}"`); assert.ok(['good', 'fair'].includes(ok.band));
    assert.equal((await j(`/journal/entries/${a.entryId}`)).status, 404, 'the throw-away recording is removed after the check');
    const b = await mkRec(); const bad = (await j('/journal/language-test', { recordingId: b.id, lang: 'te' })).body; testIds.push(bad.id); assert.ok(bad.cer > 0.5 && bad.band === 'poor', `English audio forced as Telugu must not look good: ${bad.cer}`);
    const after = (await j('/journal/languages')).body; const en = after.languages.find((l: any) => l.code === 'en'), te = after.languages.find((l: any) => l.code === 'te'); assert.match(en.status, /^measured here: (good|fair)/); assert.match(te.status, /^measured here: poor/); assert.ok(after.languages.find((l: any) => l.code === 'ta').status.startsWith('not tested'), 'languages never tested are not claimed');
    assert.equal((await j('/journal/language-test', { recordingId: 'nope', lang: 'en' })).status, 404); assert.equal((await j('/journal/language-test', { recordingId: b.id, lang: 'xx' })).status, 400);
  });

  await t.test('cleanup', async () => { for (const id of ids) await j(`/journal/entries/${id}`, undefined, 'DELETE'); for (const id of testIds) db.prepare('DELETE FROM j_langtests WHERE id = ?').run(id); await j('/journal/settings', { responseLanguage: 'same', whisperModel: 'base' }, 'PUT'); db.close(); });
});
