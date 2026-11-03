// Processing pipeline (all local): remux/extract audio (ffmpeg) → transcribe (openai-whisper) → grounded notes → diary → reflection report / conversation.
// The original media and the verbatim transcript are never modified; everything generated is stored separately and cites transcript timestamps.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { all, get, run, uid, tx } from '../db';
import * as ollama from '../ollama';
import { SAFETY } from '../rag';
import { getLang, langName } from '../lang/registry';
import { JDIR, JError, mediaPath, settings, capabilities, segments, entryDetail, fmtTs } from './store';

const now = () => Date.now();
const dir = (id: string) => path.join(JDIR, id);
const setJob = (id: string, p: Partial<{ status: string; progress: number; detail: string | null; error: string | null }>) => { const sets: string[] = []; const a: any[] = []; for (const [k, v] of Object.entries(p)) { sets.push(`${k} = ?`); a.push(v); } run(`UPDATE j_jobs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...a, now(), id); };
const newJob = (recId: string, kind: string) => { const id = uid(); run('INSERT INTO j_jobs (id, recording_id, kind, status, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, recId, kind, 'queued', now(), now()); return id; };

let tail: Promise<unknown> = Promise.resolve(); // one heavy job at a time: transcription and the LLM share the same CPU/GPU
const enqueue = <T,>(fn: () => Promise<T>) => { const p = tail.then(fn, fn); tail = p.catch(() => undefined); return p; };

// ───────────── step 1: media (remux for seeking, 16 kHz mono wav, thumbnail, duration) ─────────────
function step(cmd: string, args: string[], timeout = 600_000) { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 }); return { ok: r.status === 0, out: r.stdout, err: (r.stderr ?? '').slice(-400) }; }
export async function prepareMedia(recId: string) {
  const jid = newJob(recId, 'audio'); setJob(jid, { status: 'running', progress: 0.1 });
  try {
    if (!capabilities().ffmpeg) throw new JError('ffmpeg is not installed, so audio cannot be extracted. The recording itself is safe and playable.');
    const raw = path.join(dir(recId), 'raw.webm'); if (!fs.existsSync(raw)) throw new JError('The original recording file is missing.');
    const rec = get<any>('SELECT kind, duration_ms FROM j_recordings WHERE id = ?', recId);
    const media = path.join(dir(recId), 'media.webm'); const rx = step('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-c', 'copy', media]); if (!rx.ok) { try { fs.rmSync(media, { force: true }); } catch { /* keep raw */ } }
    setJob(jid, { progress: 0.5 });
    const wav = path.join(dir(recId), 'audio.wav'); const ex = step('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-vn', '-ac', '1', '-ar', '16000', wav]); if (!ex.ok) throw new JError(`Audio extraction failed: ${ex.err}`);
    const pr = step('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]); const sec = Number(pr.out.trim()); if (pr.ok && sec > 0) run('UPDATE j_recordings SET duration_ms = ? WHERE id = ?', Math.round(sec * 1000), recId);
    if (rec.kind === 'video') step('ffmpeg', ['-y', '-v', 'error', '-ss', '0.5', '-i', raw, '-frames:v', '1', '-vf', 'scale=480:-2', path.join(dir(recId), 'thumb.jpg')], 60_000);
    setJob(jid, { status: 'done', progress: 1, detail: rx.ok ? 'Seekable copy and audio track created.' : 'Audio extracted (the original could not be remuxed; seeking may be limited).' });
  } catch (e: any) { setJob(jid, { status: 'failed', error: e.message }); throw e; }
}

// ───────────── step 2: transcription ─────────────
export async function transcribe(recId: string, opts: { model?: string; lang?: string } = {}) {
  const jid = newJob(recId, 'transcribe'); setJob(jid, { status: 'running', progress: 0.02 });
  try {
    if (!capabilities().whisper) throw new JError('Local transcription (openai-whisper for Python) is not available on this machine. Your recording is saved; install it and press Retry.');
    const wav = path.join(dir(recId), 'audio.wav'); if (!fs.existsSync(wav)) { await prepareMedia(recId); }
    const s = settings(); const model = opts.model ?? s.whisperModel; const lang = opts.lang ?? s.spokenLanguage; const out = path.join(dir(recId), `transcript.${now()}.json`);
    const dur = get<any>('SELECT duration_ms FROM j_recordings WHERE id = ?', recId)?.duration_ms ?? 60_000; const budget = Math.max(10 * 60_000, dur * 4);
    setJob(jid, { detail: `Transcribing locally with Whisper “${model}” (CPU speed varies; long recordings take a while).`, progress: 0.05 });
    const script = path.resolve(process.cwd(), 'scripts', 'transcribe.py');
    const code: number = await new Promise((resolve, reject) => { const p = spawn('python', [script, wav, out, model, lang], { stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; p.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); }); const tm = setTimeout(() => { p.kill(); reject(new JError('Transcription timed out. Try a smaller model, or a shorter recording.')); }, budget); const tick = setInterval(() => { const el = (now() - t0) / budget; setJob(jid, { progress: Math.min(0.9, 0.05 + el * 0.85) }); }, 5000); const t0 = now(); p.on('close', (c) => { clearTimeout(tm); clearInterval(tick); if (c !== 0) (p as any).__err = err; resolve(c ?? 1); }); p.on('error', (e) => { clearTimeout(tm); clearInterval(tick); reject(e); }); (p as any).__get = () => err; });
    if (code !== 0) throw new JError(code === 2 ? 'openai-whisper is not installed for Python.' : 'Transcription failed (the model may not fit in memory — try the “tiny” or “base” model).');
    const res = JSON.parse(fs.readFileSync(out, 'utf8')); fs.rmSync(out, { force: true });
    if (!res.segments?.length) { setJob(jid, { status: 'done', progress: 1, detail: 'No speech was detected in this recording, so no transcript was created.' }); return null; }
    const tid = uid();
    tx(() => { run('INSERT INTO j_transcripts (id, recording_id, lang, model, created_at) VALUES (?,?,?,?,?)', tid, recId, res.language ?? null, `whisper-${model}`, now()); run('UPDATE j_recordings SET lang = ? WHERE id = ?', res.language ?? null, recId); res.segments.forEach((g: any, i: number) => run('INSERT INTO j_segments (transcript_id, idx, start_ms, end_ms, text) VALUES (?,?,?,?,?)', tid, i, Math.round(g.start * 1000), Math.round(g.end * 1000), String(g.text).slice(0, 5000))); });
    setJob(jid, { status: 'done', progress: 1, detail: `${res.segments.length} timestamped segments, language: ${res.language ?? 'unknown'}.` }); return tid;
  } catch (e: any) { setJob(jid, { status: 'failed', error: e.message }); throw e; }
}

// ───────────── grounded generation helpers ─────────────
const STOP = new Set('that this with from have which their they there been when will would could about into than then also such these those because between while where what does should just like very really been being were your you are was and the for not but out had has its our his her she him them who how why can did'.split(' '));
const sig = (s: string) => new Set(s.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length > 3 && !STOP.has(w)).map((w) => w.slice(0, 5)));
const latin = (s: string) => /[A-Za-z]/.test(s) && !/[^\u0000-ɏ\s\d\p{P}]/u.test(s);
/** Share of an item's content words found in the transcript segments it cites. */
const support = (item: string, cited: string) => { const a = sig(item); if (!a.size) return 1; const b = sig(cited); let k = 0; for (const w of a) if (b.has(w)) k++; return k / a.size; };
interface Seg { idx: number; start_ms: number; end_ms: number; text: string }
const toSegs = (tid: string): Seg[] => segments(tid).map((s) => ({ idx: s.idx, start_ms: s.start_ms, end_ms: s.end_ms, text: s.corrected ?? s.text }));
const windows = (segs: Seg[], max = 5500): Seg[][] => { const out: Seg[][] = []; let cur: Seg[] = [], n = 0; for (const s of segs) { if (n + s.text.length > max && cur.length) { out.push(cur); cur = []; n = 0; } cur.push(s); n += s.text.length + 8; } if (cur.length) out.push(cur); return out; };
const numbered = (segs: Seg[]) => segs.map((s) => `[${s.idx}] (${fmtTs(s.start_ms)}) ${s.text}`).join('\n');
const latestTranscript = (recId: string) => get<any>('SELECT * FROM j_transcripts WHERE recording_id = ? ORDER BY created_at DESC LIMIT 1', recId);
/** Language the user wants AI writing in, or null = the speaker's own language. */
export const outLang = (): string | null => { const r = settings().responseLanguage; return r && r !== 'same' && getLang(r) ? r : null; };
const langRule = (keepOriginal = false) => { const r = keepOriginal ? null : outLang(); return r ? `Write ALL generated text in ${langName(r)}. Keep the speaker's names as spoken.` : `Write in the speaker's own language (if they mixed languages, keep the mix).`; };
const isCross = (tlang: string | null | undefined) => { const r = outLang(); return !!r && r !== (tlang ?? '').slice(0, 2); };
const requireAi = () => { if (!settings().aiEnabled) throw new JError('AI features are turned off in Journal settings. Your transcript and recording are unaffected.', 403); };
const lowRes = (e: any) => { throw new JError(/fetch failed|ECONNREFUSED|No .*model/i.test(String(e?.message)) ? 'The local language model (Ollama) is not reachable, or no model is installed. Your recording and transcript are safe — start Ollama and press Retry.' : e.message); };

export interface NoteItem { text: string; at: number[]; segs: number[]; verified: boolean }
const NOTE_KEYS = ['topics', 'key_thoughts', 'decisions', 'actions', 'questions', 'people', 'moments', 'gratitude', 'challenges', 'achievements'] as const;

export async function makeNotes(recId: string) {
  requireAi(); const t = latestTranscript(recId); if (!t) throw new JError('There is no transcript to analyse yet.', 409);
  const entryId = get<any>('SELECT entry_id FROM j_recordings WHERE id = ?', recId).entry_id; const jid = newJob(recId, 'notes'); setJob(jid, { status: 'running', progress: 0.05 });
  try {
    const segs = toSegs(t.id); type Unit = Seg & { seg: number }; const units: Unit[] = []; for (const g of segs) for (const part of g.text.split(/(?<=[.!?\u0964\u0965])\s+/).filter((x) => x.trim())) units.push({ idx: units.length, seg: g.idx, start_ms: g.start_ms, end_ms: g.end_ms, text: part.trim() }); const byIdx = new Map(units.map((u) => [u.idx, u])); const wins = windows(units); const merged: Record<string, NoteItem[]> = Object.fromEntries(NOTE_KEYS.map((k) => [k, []])); let title = ''; let dropped = 0; const quotes: { at: number; seg: number; text: string }[] = [];
    for (let w = 0; w < wins.length; w++) {
      const sys = `${SAFETY}\nYou organise a person's spoken journal. Use ONLY what the speaker actually said. Never add facts, feelings, names or advice that are not in the transcript. Each item must be written close to the speaker's meaning and cite the sentence numbers it came from.\n${langRule()}
Return ONLY JSON: {"title":"short title","topics":[{"text":"topic","segs":[n]}],"key_thoughts":[{"text":"...","segs":[n]}],"decisions":[{"text":"decisions made or being considered","segs":[n]}],"actions":[{"text":"concrete things the speaker said they will/should do","segs":[n]}],"questions":[{"text":"questions the speaker left unanswered","segs":[n]}],"people":[{"text":"name as spoken","segs":[n]}],"moments":[{"text":"important moments or events","segs":[n]}],"gratitude":[],"challenges":[],"achievements":[],"quotes":[n]}.\nBe thorough: write a separate item for EVERY distinct event, feeling, decision, plan, question and idea the speaker mentions, placed in the list where it belongs — never merge several into one. Use empty lists only when nothing applies. "quotes" lists sentence numbers of the most meaningful sentences (max 4).`;
      let j: any = null; let added = 0;
      for (let attempt = 0; attempt < 2 && added < Math.min(3, Math.floor(wins[w].reduce((n, x) => n + x.text.length, 0) / 80)); attempt++) { // small local models sometimes return nothing usable: one retry, never an invented result
      j = null; try { j = ollama.parseJson((await ollama.chat('comprehension', [{ role: 'system', content: sys }, { role: 'user', content: `Transcript (sentence numbers in [] and timestamps):\n${numbered(wins[w])}` }], { json: true, temperature: attempt ? 0.4 : 0.1 })).text); } catch (e) { lowRes(e); }
      if (!j) continue; if (!title && typeof j.title === 'string') title = j.title.slice(0, 120);
      for (const k of NOTE_KEYS) for (const it of Array.isArray(j[k]) ? j[k] : []) {
        const ids: number[] = (Array.isArray(it?.segs) ? it.segs : []).map(Number).filter((n: number) => byIdx.has(n)); const text = String(it?.text ?? '').trim().slice(0, 400);
        if (!text || !ids.length) { dropped++; continue; } // an item with no valid citation is discarded, never shown
        const cited = ids.map((n) => byIdx.get(n)!.text).join(' '); const lat = !isCross(t.lang) && latin(text) && latin(cited); const ok = lat ? support(text, cited) >= 0.2 : true; // cross-script items can't be lexically checked: shown as unverified
        if (lat && !ok) { dropped++; continue; }
        if (!merged[k].some((x) => x.text.toLowerCase() === text.toLowerCase())) { { const segIds = [...new Set(ids.map((n) => (byIdx.get(n) as Unit).seg))]; merged[k].push({ text, segs: segIds, at: segIds.map((g) => segs.find((x) => x.idx === g)!.start_ms), verified: lat }); added++; } }
      }
      }
      const target = Math.min(3, Math.floor(wins[w].reduce((n, x) => n + x.text.length, 0) / 80));
      if (added < target) { // the all-in-one answer was thin: ask small focused questions, one list at a time (more reliable on small models)
        const FOCUS: [string, string][] = [['key_thoughts', 'thoughts, feelings or opinions the speaker expressed'], ['decisions', 'decisions the speaker made or is considering'], ['actions', 'things the speaker said they want, plan or need to do'], ['questions', 'questions or uncertainties the speaker raised'], ['moments', 'events or things that happened']];
        for (const [k, desc] of FOCUS) { if (merged[k].length) continue; let r: any = null; try { r = ollama.parseJson((await ollama.chat('comprehension', [{ role: 'system', content: `${SAFETY}\nFrom the transcript, list ONLY the ${desc}. Use only what was said; one separate item per idea; cite the sentence numbers. ${langRule()}\nReturn ONLY JSON {"items":[{"text":"...","segs":[n]}]} (empty list if none).` }, { role: 'user', content: numbered(wins[w]) }], { json: true, temperature: 0.1 })).text); } catch (e) { lowRes(e); }
          for (const it of Array.isArray(r?.items) ? r.items : []) { const ids: number[] = (Array.isArray(it?.segs) ? it.segs : []).map(Number).filter((n: number) => byIdx.has(n)); const text = String(it?.text ?? '').trim().slice(0, 400); if (!text || !ids.length) { dropped++; continue; } const cited = ids.map((n) => byIdx.get(n)!.text).join(' '); const lat = !isCross(t.lang) && latin(text) && latin(cited); if (lat && support(text, cited) < 0.2) { dropped++; continue; } if (!merged[k].some((x) => x.text.toLowerCase() === text.toLowerCase())) { const segIds = [...new Set(ids.map((n) => (byIdx.get(n) as Unit).seg))]; merged[k].push({ text, segs: segIds, at: segIds.map((g) => segs.find((x) => x.idx === g)!.start_ms), verified: lat }); added++; } } }
      }
      for (const n of (Array.isArray(j?.quotes) ? j.quotes : []).map(Number)) if (byIdx.has(n) && !quotes.some((q) => q.text === byIdx.get(n)!.text) && quotes.length < 8) quotes.push({ seg: (byIdx.get(n) as Unit).seg, at: byIdx.get(n)!.start_ms, text: byIdx.get(n)!.text }); // quotes are the speaker's own words, copied from the transcript
      setJob(jid, { progress: 0.1 + 0.85 * ((w + 1) / wins.length) });
    }
    const data = { ...merged, quotes, dropped };
    const ver = (get<any>("SELECT MAX(version) v FROM j_docs WHERE entry_id = ? AND kind = 'notes'", entryId)?.v ?? 0) + 1;
    run('INSERT INTO j_docs (id, entry_id, recording_id, kind, version, body, data, model, created_at) VALUES (?,?,?,?,?,?,?,?,?)', uid(), entryId, recId, 'notes', ver, title, JSON.stringify(data), await ollama.modelFor('comprehension'), now());
    if (title) run("UPDATE j_entries SET title = COALESCE(NULLIF(title, ''), ?), updated_at = ? WHERE id = ?", title, now(), entryId);
    setJob(jid, { status: 'done', progress: 1, detail: `${NOTE_KEYS.reduce((n, k) => n + merged[k].length, 0)} cited items${dropped ? `; ${dropped} uncited or unsupported items were discarded` : ''}.` });
  } catch (e: any) { setJob(jid, { status: 'failed', error: e.message }); throw e; }
}

const STYLE_TEXT: Record<string, string> = {
  clean: 'Lightly clean up the spoken words: remove filler words and false starts, fix grammar, keep the speaker\'s own phrasing and order. Do not add anything.',
  narrative: 'Write a natural first-person diary entry ("I …") that keeps the speaker\'s voice, personality and order of thoughts. Warm and readable, not a report, not bullet points.',
  detailed: 'Write a detailed first-person personal reflection that keeps every substantive point the speaker made, in their voice.',
  concise: 'Write a concise first-person daily summary (3–6 sentences) of only what the speaker said.',
  emotional: 'Write a first-person reflection that foregrounds the feelings the speaker themselves put into words. Do not infer feelings they did not state.',
  storytelling: 'Tell what the speaker described as a first-person story, keeping events in the order they told them. Do not invent scenery, dialogue or details.',
};
export async function makeDiary(recId: string, style?: string) {
  const st = style ?? settings().writingStyle; const t = latestTranscript(recId); if (!t) throw new JError('There is no transcript to write from yet.', 409);
  const entryId = get<any>('SELECT entry_id FROM j_recordings WHERE id = ?', recId).entry_id; const segs = toSegs(t.id); const ver = (get<any>("SELECT MAX(version) v FROM j_docs WHERE entry_id = ? AND kind = 'diary'", entryId)?.v ?? 0) + 1;
  if (st === 'exact') { // no AI: paragraphs of the speaker's exact words
    const paras: string[] = []; let cur: string[] = []; let last = 0; for (const s of segs) { if (cur.length && (s.start_ms - last > 2500 || cur.join(' ').length > 500)) { paras.push(cur.join(' ')); cur = []; } cur.push(s.text); last = s.end_ms; } if (cur.length) paras.push(cur.join(' '));
    run('INSERT INTO j_docs (id, entry_id, recording_id, kind, style, version, body, data, model, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', uid(), entryId, recId, 'diary', 'exact', ver, paras.join('\n\n'), JSON.stringify({ unverified: [] }), 'none (verbatim)', now()); return;
  }
  requireAi(); const jid = newJob(recId, 'diary'); setJob(jid, { status: 'running', progress: 0.05 });
  try {
    const wins = windows(segs, 4500); const paras: string[] = []; const spans: { from: number; to: number }[] = [];
    for (let w = 0; w < wins.length; w++) {
      const sys = `${SAFETY}\nYou turn a person's spoken journal into their own diary. ${STYLE_TEXT[st] ?? STYLE_TEXT.narrative}\nRules: first person; use ONLY facts, names, numbers and feelings present in the transcript; do not add advice, morals, diagnoses or details; ${langRule(st === 'clean')} This is part ${w + 1} of ${wins.length}${w ? ', continue naturally without repeating an introduction' : ''}. Return ONLY the diary text itself — no title, no preface, no markdown.`;
      let txt = ''; for (let attempt = 0; attempt < 2 && txt.length < 20; attempt++) { try { txt = (await ollama.chat('comprehension', [{ role: 'system', content: sys }, { role: 'user', content: wins[w].map((s) => s.text).join(' ') }], { temperature: 0.4 })).text.replace(/^\s*```[a-z]*\s*|\s*```\s*$/g, '').trim(); } catch (e) { lowRes(e); } }
      if (txt.length < 20) throw new JError('The language model returned no diary text. Press Retry.'); paras.push(txt); spans.push({ from: wins[w][0].idx, to: wins[w].at(-1)!.idx }); setJob(jid, { progress: 0.1 + 0.85 * ((w + 1) / wins.length) });
    }
    const body = paras.join('\n\n'); const src = segs.map((s) => s.text).join(' ').toLowerCase();
    // details the diary states that the transcript never contains (numbers, capitalised names) are surfaced, not hidden
    const unverified = [...new Set([...(body.match(/\b\d[\d.,:]*\b/g) ?? []), ...(latin(body) && !isCross(t.lang) ? (body.match(/(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}\b/g) ?? []) : [])])].filter((x) => !src.includes(x.toLowerCase())).slice(0, 12);
    run('INSERT INTO j_docs (id, entry_id, recording_id, kind, style, version, body, data, model, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', uid(), entryId, recId, 'diary', st, ver, body, JSON.stringify({ unverified, spans }), await ollama.modelFor('comprehension'), now());
    setJob(jid, { status: 'done', progress: 1, detail: unverified.length ? `${unverified.length} detail(s) are not in the transcript — flagged for you to check.` : 'Every number and name appears in the transcript.' });
  } catch (e: any) { setJob(jid, { status: 'failed', error: e.message }); throw e; }
}

// ───────────── reflection report (tentative, evidence-linked, never clinical) ─────────────
export const REPORT_SECTIONS: [string, string][] = [['themes', 'What you talked about'], ['important', 'What seems important to you (values and priorities you stated)'], ['feelings', 'Feelings you put into words'], ['patterns', 'Possible thinking patterns (tentative observations)'], ['strengths', 'Strengths shown in your own examples'], ['challenges', 'Difficulties you described'], ['tensions', 'Possible tensions between two things you said'], ['questions', 'Questions worth exploring'], ['reflections', 'Prompts to reflect on'], ['steps', 'Small possible next steps']];
export async function makeReport(recId: string) {
  requireAi(); const t = latestTranscript(recId); if (!t) throw new JError('There is no transcript to reflect on yet.', 409);
  const entryId = get<any>('SELECT entry_id FROM j_recordings WHERE id = ?', recId).entry_id; const jid = newJob(recId, 'report'); setJob(jid, { status: 'running', progress: 0.1 });
  try {
    const segs = toSegs(t.id); const byIdx = new Map(segs.map((s) => [s.idx, s])); const text = numbered(segs); if (text.length > 14000) throw new JError('This recording is long; the reflection report currently covers up to about 14,000 characters of transcript. Create notes and a diary instead, or record shorter entries.');
    const base = `${SAFETY}\nYou write a private personal-reflection report for a journal. You are NOT a therapist or psychologist and must never diagnose, label disorders, or claim to know the speaker's inner state. Describe only what the speaker said, in tentative language ("you described…", "this may suggest…", "one possible reading…"). Every item MUST cite the transcript segment numbers that support it; if there is no support, leave it out. Strengths must reference what the speaker actually did or said — no generic compliments. For "tensions" only use two statements the speaker really made, and phrase as a question. ${langRule()}`;
    // small calls (3 sections each) are far more reliable on small local models than one large JSON document
    const j: Record<string, any[]> = {}; let okGroups = 0;
    for (let g = 0; g < REPORT_SECTIONS.length; g += 3) {
      const grp = REPORT_SECTIONS.slice(g, g + 3); const sys = `${base}\nFill ONLY these sections. Return ONLY JSON {${grp.map(([k, d]) => `"${k}":[{"text":"${d}","segs":[n]}]`).join(',')}} (empty lists when nothing is supported; at most 3 items each, each text under 40 words).`;
      for (let attempt = 0; attempt < 2; attempt++) { try { const r = ollama.parseJson<any>((await ollama.chat('comprehension', [{ role: 'system', content: sys }, { role: 'user', content: text }], { json: true, temperature: attempt ? 0.4 : 0.2 })).text); if (r) { Object.assign(j, r); okGroups++; break; } } catch (e: any) { if (attempt) { if (/fetch failed|ECONNREFUSED/i.test(String(e?.message))) lowRes(e); } } }
      setJob(jid, { progress: 0.1 + 0.8 * ((g + 3) / REPORT_SECTIONS.length) });
    }
    if (!okGroups) throw new JError('The language model could not produce a readable report. Press Retry, or try a different model in Settings.');
    const data: Record<string, any[]> = {}; let dropped = 0;
    for (const [k] of REPORT_SECTIONS) { data[k] = []; for (const it of Array.isArray(j[k]) ? j[k] : []) { const ids: number[] = (Array.isArray(it?.segs) ? it.segs : []).map(Number).filter((n: number) => byIdx.has(n)); const tx_ = String(it?.text ?? '').trim().slice(0, 500); if (!tx_ || (!ids.length && !['reflections', 'steps', 'questions'].includes(k))) { dropped++; continue; } const cited = ids.map((n) => byIdx.get(n)!.text).join(' '); if (ids.length && !isCross(t.lang) && latin(tx_) && latin(cited) && support(tx_, cited) < 0.12 && !['reflections', 'steps'].includes(k)) { dropped++; continue; } data[k].push({ text: tx_, segs: ids, at: ids.map((n) => byIdx.get(n)!.start_ms), evidence: ids.slice(0, 3).map((n) => byIdx.get(n)!.text.slice(0, 200)), basis: 'single entry' }); } }
    run('INSERT INTO j_docs (id, entry_id, recording_id, kind, version, body, data, model, created_at) VALUES (?,?,?,?,?,?,?,?,?)', uid(), entryId, recId, 'report', (get<any>("SELECT MAX(version) v FROM j_docs WHERE entry_id = ? AND kind = 'report'", entryId)?.v ?? 0) + 1, 'Personal reflection report', JSON.stringify({ sections: data, dropped, disclaimer: 'A reflection aid based only on this one entry. Not a psychological assessment or diagnosis; the observations are tentative and you are free to disagree.' }), await ollama.modelFor('comprehension'), now());
    setJob(jid, { status: 'done', progress: 1, detail: dropped ? `${dropped} unsupported observation(s) were discarded.` : undefined });
  } catch (e: any) { setJob(jid, { status: 'failed', error: e.message }); throw e; }
}

// ───────────── reflection conversation ─────────────
export const CONV_MODES: Record<string, string> = {
  companion: 'a reflective companion who listens first', deep: 'a guide for deeper self-reflection', cbt: 'a CBT-inspired thought-exploration guide (examine thoughts and evidence; this is an educational reflection frame, not therapy)', decision: 'a decision-making companion', coach: 'a personal-growth coach', gratitude: 'a gratitude-reflection guide', relationship: 'a relationship-reflection guide (never judge or profile the other people mentioned)', goals: 'a goals-and-ambition reflection guide', stress: 'a guide for stress and overwhelm (help break things down)', future: 'a conversation with the user\'s future self, grounded in what they said they want',
};
// Deterministic first line of defence: distress language is never routed to the language model alone.
const CRISIS = /\b(kill myself|killing myself|end my life|ending my life|suicid\w*|want to die|wanna die|don'?t want to (be alive|live)|better off dead|hurt myself|harm myself|self[- ]harm|cut myself|no reason to live|take my own life)\b/i;
export const CRISIS_REPLY = 'I’m really glad you said that out loud, and I’m sorry things feel this heavy. I’m an AI journaling tool, not a person and not a crisis service, so I can’t be the right support for this moment.\n\nIf you might act on these thoughts or you’re in immediate danger, please contact your local emergency number now, or reach a crisis line — in the US you can call or text 988; elsewhere, findahelpline.com lists free lines by country. If you can, tell someone near you how you’re feeling, or ask them to stay with you.\n\nYour journal will be here whenever you want it. Would you like to tell me whether you’re safe right now?';
export function startConversation(o: { entryId?: string; mode?: string; title?: string }) { const mode = o.mode && CONV_MODES[o.mode] ? o.mode : 'companion'; if (o.entryId) get('SELECT 1 FROM j_entries WHERE id = ?', o.entryId); const id = uid(); run('INSERT INTO j_convs (id, entry_id, mode, title, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, o.entryId ?? null, mode, o.title?.slice(0, 120) ?? null, now(), now()); return id; }
export async function converse(convId: string, userText: string) {
  const c = get<any>('SELECT * FROM j_convs WHERE id = ?', convId); if (!c) throw new JError('Conversation not found.', 404); const txt = userText.trim().slice(0, 4000); if (!txt) throw new JError('Say something first.');
  run('INSERT INTO j_messages (conv_id, role, content, created_at) VALUES (?,?,?,?)', convId, 'user', txt, now());
  if (CRISIS.test(txt)) { run('INSERT INTO j_messages (conv_id, role, content, safety, created_at) VALUES (?,?,?,?,?)', convId, 'assistant', CRISIS_REPLY, 1, now()); run('UPDATE j_convs SET updated_at = ? WHERE id = ?', now(), convId); return { reply: CRISIS_REPLY, safety: true }; }
  requireAi();
  let ctx = ''; if (c.entry_id) { const d = entryDetail(c.entry_id); const parts: string[] = []; if (d.entry.body.trim()) parts.push(`Written entry:\n${d.entry.body.slice(0, 3000)}`); for (const r of d.recordings) if (r.transcript) parts.push(`Transcript (${r.kind}):\n${numbered(toSegs(r.transcript.id)).slice(0, 7000)}`); ctx = parts.join('\n\n'); }
  const hist = all<any>('SELECT role, content FROM j_messages WHERE conv_id = ? ORDER BY id DESC LIMIT 14', convId).reverse();
  const sys = `${SAFETY}\nYou are ${CONV_MODES[c.mode]} inside a private journal. You are not a therapist, psychologist or doctor; never diagnose, label disorders, or claim to know how the person feels inside — only reflect what they have said. Listen before advising. Ask at most ONE meaningful question per reply, short and specific. Distinguish what they said ("you said…") from interpretation ("one possibility is… — does that fit?"). Quote their own words when helpful. Do not flatter, do not moralise, do not be generically motivational. If they disagree with you, accept it and adjust. Do not encourage dependence on you; encourage real-world support where fitting. ${outLang() ? `Reply in ${langName(outLang()!)}` : 'Reply in the language the user is writing in'}, in 2–5 sentences.\n${ctx ? `The journal entry being discussed (you may cite it; never invent beyond it):\n${ctx}` : 'There is no entry attached; only use what the user says here.'}`;
  let reply = ''; try { reply = (await ollama.chat('comprehension', [{ role: 'system', content: sys }, ...hist.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))], { temperature: 0.5 })).text.trim(); } catch (e) { lowRes(e); }
  if (!reply) throw new JError('The model returned nothing. Try again.'); reply = reply.slice(0, 2500);
  run('INSERT INTO j_messages (conv_id, role, content, created_at) VALUES (?,?,?,?)', convId, 'assistant', reply, now()); run('UPDATE j_convs SET updated_at = ? WHERE id = ?', now(), convId); return { reply, safety: false };
}


// ───────────── multilingual: translation layers and measured speech-recognition checks ─────────────
import { translateBatch } from '../lang/translate';
import { cer, wer, band, normText } from './langtest';
/** Translate every segment of the latest transcript. The verbatim transcript is untouched; translations live in their own table and are marked machine-made. */
export async function translateTranscript(recId: string, tgt: string) {
  if (!getLang(tgt)) throw new JError('Choose a language to translate into.'); const t = latestTranscript(recId); if (!t) throw new JError('There is no transcript to translate yet.', 409);
  if ((t.lang ?? '') === tgt) throw new JError('The transcript is already in that language.', 409);
  const jid = newJob(recId, 'translate'); setJob(jid, { status: 'running', progress: 0.02 });
  try {
    const segs = toSegs(t.id); const warnings = new Set<string>(); let route: any = null;
    for (let i = 0; i < segs.length; i += 10) {
      const chunk = segs.slice(i, i + 10); let r;
      try { r = await translateBatch(chunk.map((c) => c.text), { src: t.lang ?? undefined, tgt, context: 'A person speaking aloud in a private journal. Keep the first-person voice and the meaning; do not add anything.' }); } catch (e: any) { throw new JError(/fetch failed|ECONNREFUSED/i.test(String(e?.message)) ? 'The local language model (Ollama) is not reachable, so nothing could be translated. The original transcript is unchanged.' : e.message); }
      route = r.route; r.items.forEach((it, k) => { it.warnings.forEach((w) => warnings.add(w)); run('INSERT INTO j_seg_trans (transcript_id, idx, lang, text, model, warnings, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(transcript_id, idx, lang) DO UPDATE SET text = excluded.text, model = excluded.model, warnings = excluded.warnings, created_at = excluded.created_at', t.id, chunk[k].idx, tgt, it.translation, route?.model ?? null, JSON.stringify(it.warnings), now()); });
      setJob(jid, { progress: 0.05 + 0.9 * Math.min(1, (i + 10) / segs.length) });
    }
    setJob(jid, { status: 'done', progress: 1, detail: `Machine translation to ${langName(tgt)} via ${route?.model ?? 'local model'}. ${[...warnings][0] ?? ''}`.trim() });
  } catch (e: any) { setJob(jid, { status: 'failed', error: e.message }); throw e; }
}
export async function translateDoc(docId: string, tgt: string) {
  if (!getLang(tgt)) throw new JError('Choose a language to translate into.'); const d = get<any>('SELECT * FROM j_docs WHERE id = ?', docId); if (!d || !['diary', 'notes', 'report'].includes(d.kind) || d.kind === 'notes' || d.kind === 'report') { if (!d) throw new JError('Document not found.', 404); throw new JError('Only diary entries can be translated here; notes and reports are generated in your chosen writing language.'); }
  const paras = String(d.body).split(/\n{2,}/).filter((p) => p.trim()); let r; try { r = await translateBatch(paras, { tgt, context: 'A first-person diary entry.' }); } catch (e: any) { throw new JError(/fetch failed|ECONNREFUSED/i.test(String(e?.message)) ? 'The local language model (Ollama) is not reachable.' : e.message); }
  const id = uid(); const warnings = [...new Set(r.items.flatMap((x) => x.warnings))]; run('INSERT INTO j_docs (id, entry_id, recording_id, kind, style, version, body, data, model, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, d.entry_id, d.recording_id, 'translation', tgt, (get<any>("SELECT MAX(version) v FROM j_docs WHERE entry_id = ? AND kind = 'translation'", d.entry_id)?.v ?? 0) + 1, r.items.map((x) => x.translation).join('\n\n'), JSON.stringify({ sourceDoc: docId, sourceLang: r.src, tgt, warnings, route: r.route }), r.route.model, now()); return id;
}
/** Compare what Whisper heard with the sentence the person read. The result is stored per language and model: this is the only evidence of accuracy Folio shows. */
export async function runLanguageTest(recId: string, lang: string, expected: string, model?: string) {
  if (!getLang(lang)) throw new JError('Unknown language.'); if (!expected.trim()) throw new JError('There is no reference sentence to compare with.');
  const m = (model ?? settings().whisperModel) as string; await prepareMedia(recId).catch(() => undefined);
  const tid = await transcribe(recId, { lang, model: m }); const got = tid ? segments(tid).map((s: any) => s.text).join(' ') : '';
  const c = cer(expected, got), w = wer(expected, got); const id = uid(); const dur = get<any>('SELECT duration_ms FROM j_recordings WHERE id = ?', recId)?.duration_ms ?? null;
  run('INSERT INTO j_langtests (id, lang, model, expected, got, cer, wer, band, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, lang, `whisper-${m}`, expected, got, c, w, band(c), dur, now());
  return { id, lang, model: `whisper-${m}`, expected, got, cer: Math.round(c * 1000) / 1000, wer: Math.round(w * 1000) / 1000, band: band(c), heard: normText(got).length > 0 };
}

// ───────────── orchestration ─────────────
export type Step = 'audio' | 'transcribe' | 'notes' | 'diary' | 'report' | 'translate';
/** Runs the requested steps in order. A failed step never touches the original media or earlier results. */
export function runPipeline(recId: string, steps: Step[], o: { style?: string; lang?: string; model?: string; tgt?: string } = {}) {
  return enqueue(async () => {
    const done: string[] = []; const failed: { step: string; error: string }[] = [];
    for (const s of steps) {
      try { if (s === 'audio') await prepareMedia(recId); else if (s === 'transcribe') await transcribe(recId, { lang: o.lang, model: o.model }); else if (s === 'translate') await translateTranscript(recId, o.tgt ?? ''); else if (s === 'notes') await makeNotes(recId); else if (s === 'diary') await makeDiary(recId, o.style); else await makeReport(recId); done.push(s); }
      catch (e: any) { failed.push({ step: s, error: e.message }); break; }
    }
    return { done, failed };
  });
}
void all;
