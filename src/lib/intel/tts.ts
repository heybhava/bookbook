// Local speech synthesis to real WAV files. Order: Piper HTTP server (PIPER_URL) > Windows SAPI (System.Speech) > none.
// Nothing leaves the machine. Browser voices are used by the UI only for live playback.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assetDir, tmpDir } from '../db';

const exec = promisify(execFile);

export interface TtsItem { text: string; voice: string; rate?: number; out: string }
export type Engine = 'piper' | 'sapi' | 'none';

export function engine(): Engine {
  if (process.env.PIPER_URL) return 'piper';
  return process.platform === 'win32' ? 'sapi' : 'none';
}

const gv = globalThis as unknown as { __voices?: Promise<string[]> };
export function listVoices(): Promise<string[]> {
  if (engine() !== 'sapi') return Promise.resolve([]);
  return (gv.__voices ??= exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }"], { timeout: 30000 })
    .then((r) => r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)).catch(() => []));
}

/** Pick two clearly different voices (e.g. David + Zira) unless the user chose some. */
export async function hostVoices(a?: string, b?: string) {
  const v = await listVoices();
  return { A: a && v.includes(a) ? a : v[0] ?? '', B: b && v.includes(b) ? b : v.find((x) => x !== (a && v.includes(a) ? a : v[0])) ?? v[0] ?? '' };
}

const clean = (t: string) => t.replace(/\[[^\]]*\]/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);

export async function synth(items: TtsItem[]): Promise<void> {
  if (!items.length) return;
  const eng = engine();
  if (eng === 'none') throw new Error('No local speech engine for audio files on this system. Set PIPER_URL to a Piper server, or use browser voices for live playback.');
  for (const it of items) await fs.mkdir(path.dirname(it.out), { recursive: true });
  if (eng === 'piper') {
    for (const it of items) {
      const r = await fetch(process.env.PIPER_URL!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: clean(it.text), voice: it.voice }) });
      if (!r.ok) throw new Error(`Piper server error ${r.status}`);
      await fs.writeFile(it.out, Buffer.from(await r.arrayBuffer()));
    }
    return;
  }
  // SAPI: one PowerShell process for the whole batch (starting it per sentence would be far too slow)
  const dir = tmpDir(); await fs.mkdir(dir, { recursive: true });
  const id = Math.random().toString(36).slice(2);
  const list = path.join(dir, `${id}.json`), ps = path.join(dir, `${id}.ps1`);
  await fs.writeFile(list, JSON.stringify(items.map((i) => ({ text: clean(i.text), voice: i.voice, rate: Math.round(i.rate ?? 0), out: path.resolve(i.out) }))), 'utf8');
  await fs.writeFile(ps, [
    'param([string]$ListPath)',
    'Add-Type -AssemblyName System.Speech',
    '$items = Get-Content -Raw -Encoding UTF8 -Path $ListPath | ConvertFrom-Json',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'foreach ($it in $items) {',
    '  try { if ($it.voice) { $s.SelectVoice($it.voice) } } catch {}',
    '  $s.Rate = [int]$it.rate',
    '  $s.SetOutputToWaveFile($it.out)',
    '  $s.Speak([string]$it.text)',
    '  $s.SetOutputToNull()',
    '}',
    '$s.Dispose()',
  ].join('\r\n'), 'utf8');
  try { await exec('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps, list], { timeout: 20 * 60_000, maxBuffer: 1 << 24 }); }
  finally { await fs.rm(list, { force: true }); await fs.rm(ps, { force: true }); }
}

/** Duration (seconds) of a PCM WAV file, read from its header. */
export async function wavSeconds(file: string): Promise<number> {
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(4096); const { bytesRead } = await fh.read(head, 0, 4096, 0);
    if (bytesRead < 44 || head.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV file');
    let off = 12, byteRate = 0, dataSize = 0;
    while (off + 8 <= bytesRead) {
      const id = head.toString('ascii', off, off + 4), size = head.readUInt32LE(off + 4);
      if (id === 'fmt ') byteRate = head.readUInt32LE(off + 16);
      if (id === 'data') { dataSize = size; if (dataSize === 0xffffffff || dataSize === 0) dataSize = (await fh.stat()).size - off - 8; break; }
      off += 8 + size + (size % 2);
    }
    if (!byteRate || !dataSize) throw new Error('could not read WAV header');
    return dataSize / byteRate;
  } finally { await fh.close(); }
}

export async function ff(args: string[], timeout = 30 * 60_000) { return exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout, maxBuffer: 1 << 24 }); }
export async function hasFfmpeg() { try { await exec('ffmpeg', ['-version']); return true; } catch { return false; } }

/** Concatenate WAVs (with a short gap between) into one file; returns exact start/end offsets per input. */
export async function concatWavs(files: string[], out: string, gap = 0.35) {
  const secs = await Promise.all(files.map(wavSeconds));
  const gapFile = path.join(path.dirname(out), '_gap.wav');
  await ff(['-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', String(gap), gapFile]);
  const listFile = path.join(path.dirname(out), '_list.txt');
  await fs.writeFile(listFile, files.map((f, i) => `file '${path.resolve(f).replace(/\\/g, '/')}'${i < files.length - 1 ? `\nfile '${path.resolve(gapFile).replace(/\\/g, '/')}'` : ''}`).join('\n'));
  // normalise to one sample format so mixed sources concatenate cleanly
  await ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-ar', '22050', '-ac', '1', out]);
  await fs.rm(listFile, { force: true }); await fs.rm(gapFile, { force: true });
  let t = 0; const times = secs.map((s) => { const r = { start: t, end: t + s }; t += s + gap; return r; });
  return { times, total: t - gap };
}

export const vttTime = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x.toFixed(3).padStart(6, '0')}`; };
export const srtTime = (s: number) => vttTime(s).replace('.', ',');

/** Installed Windows SAPI voices with their cultures (e.g. "Microsoft David Desktop" en-US). */
export async function listVoiceInfo(): Promise<{ name: string; culture: string }[]> {
  if (engine() !== 'sapi') return [];
  try {
    const r = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }"], { timeout: 30000 });
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => { const [name, culture] = s.split('|'); return { name, culture }; });
  } catch { return []; }
}
