// Life Journal storage. Three layers are never merged: original media (files on disk), verbatim transcript (j_segments.text), AI writing (j_docs).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { all, get, run, uid, tx, DATA_DIR, LOCAL_USER } from '../db';
import { getLang } from '../lang/registry';

export class JError extends Error { constructor(msg: string, public status = 400) { super(msg); } }
export const JDIR = path.join(DATA_DIR, 'journal');
const now = () => Date.now();
export const dayOf = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00').getTime());

// ───────────── settings (stored in the existing preferences table) ─────────────
export interface JSettings { autoProcess: boolean; aiEnabled: boolean; whisperModel: 'tiny' | 'base' | 'small' | 'medium'; spokenLanguage: string; writingStyle: string; resurface: boolean; longitudinal: boolean; responseLanguage: string; videoQuality: 'low' | 'medium' | 'high' }
const DEFAULTS: JSettings = { autoProcess: false, aiEnabled: true, whisperModel: 'base', spokenLanguage: 'auto', writingStyle: 'narrative', resurface: true, longitudinal: false, responseLanguage: 'same', videoQuality: 'medium' };
export function settings(): JSettings { const v = get<{ value: string }>('SELECT value FROM preferences WHERE user_id = ? AND key = ?', LOCAL_USER, 'journal.settings')?.value; try { return { ...DEFAULTS, ...(v ? JSON.parse(v) : {}) }; } catch { return DEFAULTS; } }
export function saveSettings(p: Partial<JSettings>): JSettings {
  const cur = settings(); const n: JSettings = { ...cur };
  if (typeof p.autoProcess === 'boolean') n.autoProcess = p.autoProcess; if (typeof p.aiEnabled === 'boolean') n.aiEnabled = p.aiEnabled; if (typeof p.resurface === 'boolean') n.resurface = p.resurface; if (typeof p.longitudinal === 'boolean') n.longitudinal = p.longitudinal; if (typeof p.responseLanguage === 'string' && (p.responseLanguage === 'same' || getLang(p.responseLanguage))) n.responseLanguage = p.responseLanguage;
  if (p.whisperModel && ['tiny', 'base', 'small', 'medium'].includes(p.whisperModel)) n.whisperModel = p.whisperModel;
  if (typeof p.spokenLanguage === 'string' && /^(auto|[a-z]{2,3})$/.test(p.spokenLanguage)) n.spokenLanguage = p.spokenLanguage;
  if (typeof p.writingStyle === 'string' && STYLES.includes(p.writingStyle)) n.writingStyle = p.writingStyle;
  if (p.videoQuality && ['low', 'medium', 'high'].includes(p.videoQuality)) n.videoQuality = p.videoQuality;
  run('INSERT INTO preferences (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value = excluded.value', LOCAL_USER, 'journal.settings', JSON.stringify(n)); return n;
}
export const STYLES = ['exact', 'clean', 'narrative', 'detailed', 'concise', 'emotional', 'storytelling'];
export const MODES = ['daily', 'freeform', 'guided', 'weekly', 'monthly', 'milestone', 'emotional', 'idea', 'future'];

// ───────────── capabilities (honest detection, cached 60 s) ─────────────
let capCache: { at: number; v: any } | null = null;
export function capabilities(force = false) {
  if (!force && capCache && now() - capCache.at < 60_000) return capCache.v;
  const t = (cmd: string, args: string[]) => { try { const r = spawnSync(cmd, args, { timeout: 15000, encoding: 'utf8' }); return r.status === 0 ? (r.stdout || r.stderr).split('\n')[0].slice(0, 80) : null; } catch { return null; } };
  const ffmpeg = t('ffmpeg', ['-version']); const whisper = t('python', ['-c', 'import whisper;print("openai-whisper")']);
  const v = { ffmpeg: !!ffmpeg, whisper: !!whisper, notes: [!ffmpeg && 'ffmpeg not found: audio extraction and seekable remuxing are unavailable', !whisper && 'openai-whisper (Python) not found: transcription is unavailable; recordings and written entries still work'].filter(Boolean) };
  capCache = { at: now(), v }; return v;
}

// ───────────── entries ─────────────
export interface Entry { id: string; day: string; kind: string; mode: string | null; title: string | null; body: string; mood: string | null; tags: string[]; favourite: number; sensitive: number; created_at: number; updated_at: number }
const row2entry = (r: any): Entry => ({ ...r, tags: JSON.parse(r.tags || '[]') });
export function createEntry(o: { day?: string; kind?: string; mode?: string; title?: string; body?: string; mood?: string; tags?: string[] }): Entry {
  const day = o.day ?? dayOf(); if (!isDay(day)) throw new JError('Invalid date.');
  const kind = ['written', 'video', 'audio', 'mixed'].includes(o.kind ?? '') ? o.kind! : 'written'; const mode = o.mode && MODES.includes(o.mode) ? o.mode : o.mode ? String(o.mode).slice(0, 40) : null; // custom categories allowed
  const id = uid(); const t = now();
  run('INSERT INTO j_entries (id, user_id, day, kind, mode, title, body, mood, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, LOCAL_USER, day, kind, mode, o.title?.slice(0, 200) ?? null, (o.body ?? '').slice(0, 500_000), o.mood?.slice(0, 30) ?? null, JSON.stringify(cleanTags(o.tags)), t, t);
  return getEntry(id);
}
const cleanTags = (t?: string[]) => [...new Set((t ?? []).map((x) => String(x).replace(/^#/, '').trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
export function getEntry(id: string): Entry { const r = get<any>('SELECT * FROM j_entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, LOCAL_USER); if (!r) throw new JError('Entry not found.', 404); return row2entry(r); }
export function updateEntry(id: string, p: Partial<{ title: string | null; body: string; mood: string | null; tags: string[]; favourite: boolean; sensitive: boolean; day: string; mode: string | null }>) {
  const e = getEntry(id); const sets: string[] = []; const args: any[] = [];
  if (p.title !== undefined) { sets.push('title = ?'); args.push(p.title?.slice(0, 200) ?? null); } if (typeof p.body === 'string') { sets.push('body = ?'); args.push(p.body.slice(0, 500_000)); } if (p.mood !== undefined) { sets.push('mood = ?'); args.push(p.mood?.slice(0, 30) ?? null); }
  if (p.tags) { sets.push('tags = ?'); args.push(JSON.stringify(cleanTags(p.tags))); } if (p.favourite !== undefined) { sets.push('favourite = ?'); args.push(p.favourite ? 1 : 0); } if (p.sensitive !== undefined) { sets.push('sensitive = ?'); args.push(p.sensitive ? 1 : 0); } if (p.mode !== undefined) { sets.push('mode = ?'); args.push(p.mode?.slice(0, 40) ?? null); }
  if (p.day !== undefined) { if (!isDay(p.day)) throw new JError('Invalid date.'); sets.push('day = ?'); args.push(p.day); }
  if (sets.length) run(`UPDATE j_entries SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...args, now(), e.id); return getEntry(id);
}
export function listEntries(o: { from?: string; to?: string; kind?: string; q?: string; limit?: number } = {}) {
  let sql = `SELECT e.*, (SELECT COUNT(*) FROM j_recordings r WHERE r.entry_id = e.id) AS rec_count, (SELECT SUM(duration_ms) FROM j_recordings r WHERE r.entry_id = e.id) AS rec_ms,
    (SELECT r.id FROM j_recordings r WHERE r.entry_id = e.id AND r.kind = 'video' ORDER BY r.started_at LIMIT 1) AS video_id, (SELECT r.id FROM j_recordings r WHERE r.entry_id = e.id ORDER BY r.started_at LIMIT 1) AS first_rec,
    (SELECT 1 FROM j_segments s JOIN j_transcripts t ON t.id = s.transcript_id JOIN j_recordings r ON r.id = t.recording_id WHERE r.entry_id = e.id LIMIT 1) AS has_transcript FROM j_entries e WHERE e.user_id = ? AND e.deleted_at IS NULL`; const args: any[] = [LOCAL_USER];
  if (o.from) { sql += ' AND e.day >= ?'; args.push(o.from); } if (o.to) { sql += ' AND e.day <= ?'; args.push(o.to); } if (o.kind) { sql += ' AND e.kind = ?'; args.push(o.kind); }
  sql += ' ORDER BY e.day DESC, e.created_at DESC LIMIT ?'; args.push(Math.min(o.limit ?? 200, 1000));
  return all<any>(sql, ...args).map((r) => ({ ...row2entry(r), rec_count: r.rec_count, rec_ms: r.rec_ms, video_id: r.video_id, first_rec: r.first_rec, has_transcript: !!r.has_transcript }));
}
export function calendar(month: string) { // 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(month)) throw new JError('Invalid month.');
  const days = all<any>(`SELECT e.day, COUNT(DISTINCT e.id) entries, SUM(e.kind IN ('video','mixed')) videos, GROUP_CONCAT(DISTINCT e.mood) moods, MIN(CASE WHEN r.kind = 'video' THEN r.id END) video_id, SUM(r.duration_ms) ms FROM j_entries e LEFT JOIN j_recordings r ON r.entry_id = e.id WHERE e.user_id = ? AND e.deleted_at IS NULL AND e.day LIKE ? GROUP BY e.day`, LOCAL_USER, month + '-%');
  const all_days = all<{ day: string }>('SELECT DISTINCT day FROM j_entries WHERE user_id = ? AND deleted_at IS NULL ORDER BY day', LOCAL_USER).map((r) => r.day);
  // streak = consecutive days ending today or yesterday; never framed as failure in the UI
  let streak = 0; const set = new Set(all_days); const d = new Date(); if (!set.has(dayOf(d.getTime()))) d.setDate(d.getDate() - 1); while (set.has(dayOf(d.getTime()))) { streak++; d.setDate(d.getDate() - 1); }
  const tot = get<any>(`SELECT COUNT(*) n, (SELECT COALESCE(SUM(duration_ms),0) FROM j_recordings r JOIN j_entries e ON e.id = r.entry_id WHERE e.user_id = ? AND e.deleted_at IS NULL) ms FROM j_entries WHERE user_id = ? AND deleted_at IS NULL`, LOCAL_USER, LOCAL_USER);
  return { month, days: days.map((x) => ({ ...x, moods: x.moods ? String(x.moods).split(',') : [] })), stats: { streak, daysThisMonth: days.length, totalEntries: tot.n, recordedHours: Math.round((tot.ms / 3.6e6) * 10) / 10 } };
}

// ───────────── recordings ─────────────
const recDir = (id: string) => path.join(JDIR, id);
const rawPath = (id: string) => path.join(recDir(id), 'raw.webm');
export const mediaPath = (id: string) => { const d = recDir(id); const f = ['media.webm', 'raw.webm'].map((x) => path.join(d, x)).find((p) => fs.existsSync(p)); if (!f) throw new JError('Media file not found.', 404); return f; };
export function startRecording(o: { entryId?: string; kind: 'video' | 'audio'; mime?: string; mode?: string; day?: string; title?: string; quality?: string }) {
  if (!['video', 'audio'].includes(o.kind)) throw new JError('kind must be video or audio.');
  const e = o.entryId ? getEntry(o.entryId) : createEntry({ kind: o.kind, mode: o.mode, day: o.day, title: o.title });
  const id = uid(); fs.mkdirSync(recDir(id), { recursive: true }); fs.writeFileSync(rawPath(id), '');
  run('INSERT INTO j_recordings (id, entry_id, kind, mime, status, title, quality, started_at) VALUES (?,?,?,?,?,?,?,?)', id, e.id, o.kind, (o.mime ?? (o.kind === 'video' ? 'video/webm' : 'audio/webm')).slice(0, 80), 'recording', o.title?.slice(0, 200) ?? null, o.quality ?? null, now());
  if (o.entryId && e.kind !== o.kind && e.kind !== 'mixed') run("UPDATE j_entries SET kind = 'mixed', updated_at = ? WHERE id = ?", now(), e.id);
  return { id, entryId: e.id };
}
const getRec = (id: string) => { const r = get<any>('SELECT r.* FROM j_recordings r JOIN j_entries e ON e.id = r.entry_id WHERE r.id = ? AND e.user_id = ?', id, LOCAL_USER); if (!r) throw new JError('Recording not found.', 404); return r; };
export const recording = getRec;
/** Append one chunk. Idempotent for retries (same index again is ignored); a gap is refused so the file can never silently lose data. */
export function appendChunk(id: string, idx: number, data: Buffer) {
  const r = getRec(id); if (r.status !== 'recording') throw new JError('This recording is already finished.', 409);
  if (!Number.isInteger(idx) || idx < 0) throw new JError('Invalid chunk index.');
  if (idx < r.chunks) return { chunks: r.chunks, size: r.size, duplicate: true };
  if (idx > r.chunks) { const e = new JError(`Missing chunk ${r.chunks}.`, 409); (e as any).expected = r.chunks; throw e; }
  if (data.length === 0 || data.length > 64 * 1024 * 1024) throw new JError('Chunk size must be between 1 byte and 64 MB.', 413);
  const free = (() => { try { const s = (fs as any).statfsSync(JDIR); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; } })();
  if (free < data.length + 200 * 1024 * 1024) throw new JError('Disk space is almost full; the recording was stopped to protect existing data. Free some space and everything recorded so far is kept.', 507);
  fs.appendFileSync(rawPath(id), data); run('UPDATE j_recordings SET chunks = chunks + 1, size = size + ?, last_chunk_at = ? WHERE id = ?', data.length, now(), id);
  return { chunks: r.chunks + 1, size: r.size + data.length, duplicate: false };
}
export function finishRecording(id: string, durationMs?: number, status: 'complete' | 'interrupted' = 'complete') {
  const r = getRec(id); if (r.status !== 'recording') return getRec(id);
  const size = fs.existsSync(rawPath(id)) ? fs.statSync(rawPath(id)).size : 0;
  if (size === 0) { run('DELETE FROM j_recordings WHERE id = ?', id); fs.rmSync(recDir(id), { recursive: true, force: true }); cleanupEmpty(r.entry_id); throw new JError('Nothing was recorded.', 410); }
  run('UPDATE j_recordings SET status = ?, ended_at = ?, duration_ms = ?, size = ? WHERE id = ?', status, now(), durationMs && durationMs > 0 ? Math.round(durationMs) : r.last_chunk_at ? r.last_chunk_at - r.started_at : null, size, id);
  return getRec(id);
}
function cleanupEmpty(entryId: string) { const e = get<any>('SELECT body, title FROM j_entries WHERE id = ?', entryId); if (e && !e.body && !e.title && !get('SELECT 1 FROM j_recordings WHERE entry_id = ?', entryId)) run('DELETE FROM j_entries WHERE id = ?', entryId); }
/** Recordings left in "recording" state by a crash/closed tab are kept and marked interrupted so nothing recorded is lost. */
export function recoverInterrupted(staleMs = 60_000) {
  const stale = all<any>("SELECT id FROM j_recordings WHERE status = 'recording' AND COALESCE(last_chunk_at, started_at) < ?", now() - staleMs); const out: string[] = [];
  for (const s of stale) { try { finishRecording(s.id, undefined, 'interrupted'); out.push(s.id); } catch { /* empty recording removed */ } }
  for (const j of all<{ id: string }>("SELECT id FROM j_jobs WHERE status IN ('running','queued')")) run("UPDATE j_jobs SET status = 'failed', error = 'Interrupted by a restart — press Retry.', updated_at = ? WHERE id = ?", now(), j.id);
  return out;
}
export function entryDetail(id: string) {
  const e = getEntry(id);
  const recs = all<any>('SELECT * FROM j_recordings WHERE entry_id = ? ORDER BY started_at', id).map((r) => ({ ...r, transcript: get<any>('SELECT id, lang, model, created_at FROM j_transcripts WHERE recording_id = ? ORDER BY created_at DESC', r.id) ?? null, jobs: all('SELECT * FROM j_jobs WHERE recording_id = ? ORDER BY created_at DESC LIMIT 6', r.id), bookmarks: all('SELECT * FROM j_bookmarks WHERE recording_id = ? ORDER BY at_ms', r.id) }));
  const docs = all<any>('SELECT * FROM j_docs WHERE entry_id = ? ORDER BY created_at DESC', id).map((d) => ({ ...d, data: d.data ? JSON.parse(d.data) : null }));
  return { entry: e, recordings: recs, docs, conversations: all('SELECT * FROM j_convs WHERE entry_id = ? ORDER BY updated_at DESC', id) };
}
export const segments = (transcriptId: string) => all<any>('SELECT idx, start_ms, end_ms, text, corrected FROM j_segments WHERE transcript_id = ? ORDER BY idx', transcriptId);
export function correctSegment(transcriptId: string, idx: number, corrected: string | null) { run('UPDATE j_segments SET corrected = ? WHERE transcript_id = ? AND idx = ?', corrected?.slice(0, 5000) ?? null, transcriptId, idx); }
export function addBookmark(recId: string, atMs: number, label?: string) { getRec(recId); const id = uid(); run('INSERT INTO j_bookmarks (id, recording_id, at_ms, label, created_at) VALUES (?,?,?,?,?)', id, recId, Math.max(0, Math.round(atMs)), label?.slice(0, 120) ?? null, now()); return id; }
export function renameRecording(id: string, title: string) { getRec(id); run('UPDATE j_recordings SET title = ? WHERE id = ?', title.slice(0, 200), id); }

// ───────────── deletion: each layer separately, or everything ─────────────
export function deleteRecordingFile(id: string) { const r = getRec(id); fs.rmSync(recDir(id), { recursive: true, force: true }); run("UPDATE j_recordings SET status = 'deleted', size = 0 WHERE id = ?", id); return r; }
export function deleteTranscript(recId: string) { getRec(recId); run('DELETE FROM j_transcripts WHERE recording_id = ?', recId); }
export function deleteDoc(id: string) { run('DELETE FROM j_docs WHERE id = ? AND entry_id IN (SELECT id FROM j_entries WHERE user_id = ?)', id, LOCAL_USER); }
/** Permanent: media files, transcripts, AI documents, conversations about the entry. */
export function purgeEntry(id: string) {
  getEntry(id); const recs = all<{ id: string }>('SELECT id FROM j_recordings WHERE entry_id = ?', id);
  tx(() => { run('DELETE FROM j_convs WHERE entry_id = ?', id); run('DELETE FROM j_entries WHERE id = ?', id); }); // cascades recordings/transcripts/segments/docs/jobs/bookmarks
  for (const r of recs) fs.rmSync(recDir(r.id), { recursive: true, force: true });
  return { deletedRecordings: recs.length };
}

// ───────────── search (keyword over every layer, with media timestamps) ─────────────
export function search(q: string, limit = 60) {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1).slice(0, 8); if (!terms.length) return { results: [], terms };
  const like = (col: string) => terms.map(() => `lower(${col}) LIKE ?`).join(' AND '); const args = terms.map((t) => `%${t.replace(/[%_]/g, '')}%`);
  const out: any[] = [];
  for (const s of all<any>(`SELECT s.idx, s.start_ms, s.text, s.corrected, r.id rid, r.kind, e.id eid, e.day, e.title FROM j_segments s JOIN j_transcripts t ON t.id = s.transcript_id JOIN j_recordings r ON r.id = t.recording_id JOIN j_entries e ON e.id = r.entry_id WHERE e.user_id = ? AND e.deleted_at IS NULL AND ${like("COALESCE(s.corrected, s.text)")} ORDER BY e.day DESC LIMIT ?`, LOCAL_USER, ...args, limit)) out.push({ type: 'transcript', entryId: s.eid, day: s.day, title: s.title, recordingId: s.rid, atMs: s.start_ms, text: s.corrected ?? s.text });
  for (const s of all<any>(`SELECT x.idx, x.text, x.lang, s.start_ms, r.id rid, e.id eid, e.day, e.title FROM j_seg_trans x JOIN j_segments s ON s.transcript_id = x.transcript_id AND s.idx = x.idx JOIN j_transcripts t ON t.id = x.transcript_id JOIN j_recordings r ON r.id = t.recording_id JOIN j_entries e ON e.id = r.entry_id WHERE e.user_id = ? AND e.deleted_at IS NULL AND ${like('x.text')} ORDER BY e.day DESC LIMIT ?`, LOCAL_USER, ...args, limit)) out.push({ type: 'translation', entryId: s.eid, day: s.day, title: s.title, recordingId: s.rid, atMs: s.start_ms, text: s.text, lang: s.lang });
  for (const e of all<any>(`SELECT id, day, title, body FROM j_entries WHERE user_id = ? AND deleted_at IS NULL AND ${like("COALESCE(title,'') || ' ' || body")} ORDER BY day DESC LIMIT ?`, LOCAL_USER, ...args, limit)) out.push({ type: 'written', entryId: e.id, day: e.day, title: e.title, text: snippet(e.body, terms[0]) });
  for (const d of all<any>(`SELECT d.entry_id, d.kind, d.body, e.day, e.title FROM j_docs d JOIN j_entries e ON e.id = d.entry_id WHERE e.user_id = ? AND e.deleted_at IS NULL AND ${like('d.body')} ORDER BY e.day DESC LIMIT ?`, LOCAL_USER, ...args, limit)) out.push({ type: d.kind, entryId: d.entry_id, day: d.day, title: d.title, text: snippet(d.body, terms[0]) });
  for (const m of all<any>(`SELECT m.content, c.entry_id, c.title, e.day FROM j_messages m JOIN j_convs c ON c.id = m.conv_id LEFT JOIN j_entries e ON e.id = c.entry_id WHERE ${like('m.content')} ORDER BY m.id DESC LIMIT ?`, ...args, limit)) out.push({ type: 'conversation', entryId: m.entry_id, day: m.day, title: m.title, text: snippet(m.content, terms[0]) });
  return { results: out.sort((a, b) => String(b.day ?? '').localeCompare(String(a.day ?? ''))).slice(0, limit), terms };
}
const snippet = (t: string, term: string) => { const i = t.toLowerCase().indexOf(term); const s = Math.max(0, i - 80); return (s > 0 ? '…' : '') + t.slice(s, s + 220).replace(/\s+/g, ' ') + (s + 220 < t.length ? '…' : ''); };

// ───────────── export ─────────────
const ts = (ms: number) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
export const fmtTs = ts;
export function exportMarkdown(id: string) {
  const d = entryDetail(id); const e = d.entry; const L: string[] = [];
  L.push('---', `title: ${JSON.stringify(e.title ?? `Journal ${e.day}`)}`, `date: ${e.day}`, `type: journal`, `journal_kind: ${e.kind}`, ...(e.mood ? [`mood: ${JSON.stringify(e.mood)}`] : []), `tags: [journal${e.tags.length ? ', ' + e.tags.join(', ') : ''}]`, `source: folio-life-journal`, '---', '', `# ${e.title ?? `Journal — ${e.day}`}`, '');
  if (e.body.trim()) L.push(e.body.trim(), '');
  const diary = d.docs.find((x: any) => x.kind === 'diary'); if (diary) L.push(`## Diary (${diary.style}, AI-written from the transcript)`, '', diary.body.trim(), '');
  for (const r of d.recordings) { if (!r.transcript) continue; L.push(`## Transcript — ${r.kind} (${r.transcript.lang ?? '?'}, ${r.transcript.model})`, ''); for (const s of segments(r.transcript.id)) L.push(`- [${ts(s.start_ms)}] ${s.corrected ?? s.text}`); L.push(''); }
  const notes = d.docs.find((x: any) => x.kind === 'notes'); if (notes?.data) { L.push('## Notes (each item cites transcript timestamps)', ''); for (const [k, v] of Object.entries(notes.data as Record<string, any>)) if (Array.isArray(v) && v.length) { L.push(`### ${k}`); for (const it of v) L.push(`- ${it.text ?? it.name}${it.at?.length ? ` _(${it.at.map(ts).join(', ')})_` : ''}`); L.push(''); } }
  return L.join('\n');
}
void isDay;
