'use client';
import { useStore } from './store';
import { api } from './api';

export interface Sentence { start: number; end: number; text: string }

export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /[^.!?\n]+(?:[.!?]+["')\]”’]*|\n+|$)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t.length) out.push({ start: m.index + lead, end: m.index + lead + t.length, text: t });
  }
  // merge abbreviations ("Dr.") and tiny fragments into the following sentence
  const merged: Sentence[] = [];
  let carry: Sentence | null = null;
  for (const s of out) {
    const cur: Sentence = carry ? { start: carry.start, end: s.end, text: text.slice(carry.start, s.end) } : { ...s };
    carry = null;
    if (/\b(Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e|No|Fig)\.$/.test(cur.text) || cur.text.length < 6) carry = cur;
    else merged.push(cur);
  }
  if (carry) merged.push(carry);
  return merged;
}

export function browserVoices(): SpeechSynthesisVoice[] {
  return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
}

export const ACCENTS = [
  { id: '', label: 'Auto' }, { id: 'en-GB', label: 'British' }, { id: 'en-US', label: 'American' }, { id: 'en-AU', label: 'Australian' },
];

export function pickVoice(accent: string, name?: string): SpeechSynthesisVoice | undefined {
  const vs = browserVoices();
  if (name) { const v = vs.find((x) => x.name === name); if (v) return v; }
  if (accent) return vs.find((v) => v.lang.replace('_', '-').toLowerCase() === accent.toLowerCase());
  return vs.find((v) => v.lang.startsWith('en') && v.default) ?? vs.find((v) => v.lang.startsWith('en'));
}

/** Speak a single word (pronunciation). Returns false if the requested accent has no installed voice. */
export function speakWord(word: string, accent = '', rate = 0.9): boolean {
  if (typeof speechSynthesis === 'undefined') return false;
  const v = pickVoice(accent);
  if (accent && !v) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(word);
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
  u.rate = rate;
  speechSynthesis.speak(u);
  return true;
}

export type Scope = 'sentence' | 'paragraph' | 'page' | 'chapter' | 'book';
interface PageData { page: number; text: string; chapter_idx: number }

class Reader {
  private gen = 0;
  private sleep: ReturnType<typeof setTimeout> | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private cache = new Map<string, PageData>();
  voice = ''; accent = ''; rate = 1; volume = 1; piperVoice = '';

  private async page(bookId: string, n: number): Promise<PageData | null> {
    const key = `${bookId}:${n}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const rows = await api<PageData[]>(`/books/${bookId}/pages?from=${n}&to=${n + 4}`).catch(() => [] as PageData[]);
    rows.forEach((r) => this.cache.set(`${bookId}:${r.page}`, r));
    return this.cache.get(key) ?? null;
  }

  stop() {
    this.gen++;
    try { speechSynthesis.cancel(); } catch { /* */ }
    if (this.audioEl) { this.audioEl.pause(); this.audioEl = null; }
    useStore.getState().setAudio({ playing: false, sentence: null, word: null });
  }
  pause() { try { speechSynthesis.pause(); } catch { /* */ } this.audioEl?.pause(); useStore.getState().setAudio({ playing: false }); }
  resume() { try { speechSynthesis.resume(); } catch { /* */ } void this.audioEl?.play(); useStore.getState().setAudio({ playing: true }); }
  setSleep(min: number, onFire: () => void) {
    if (this.sleep) clearTimeout(this.sleep);
    this.sleep = min > 0 ? setTimeout(() => { this.stop(); onFire(); }, min * 60_000) : null;
  }

  async play(bookId: string, page: number, scope: Scope, opts: { engine: 'browser' | 'piper'; startOffset?: number; onPosition?: (page: number, sentenceStart: number) => void; checkpoint?: { every: number; run: (page: number, offset: number) => Promise<void> } }) {
    const my = ++this.gen; let heard = 0;
    try { speechSynthesis.cancel(); } catch { /* */ }
    useStore.getState().setAudio({ playing: true, engine: opts.engine, scope });
    const first = await this.page(bookId, page);
    if (!first) return this.stop();
    const startCh = first.chapter_idx;
    let n = page; let firstPage = true;
    while (my === this.gen) {
      const pd = await this.page(bookId, n);
      if (!pd || (scope === 'chapter' && pd.chapter_idx !== startCh)) break;
      useStore.getState().setPage(n);
      useStore.getState().setAudio({ page: n });
      const sents = splitSentences(pd.text);
      let i = 0;
      if (firstPage) { const idx = sents.findIndex((s) => s.end > (opts.startOffset ?? 0)); i = idx < 0 ? 0 : idx; }
      firstPage = false;
      for (; i < sents.length && my === this.gen; i++) {
        const s = sents[i];
        useStore.getState().setAudio({ sentence: [s.start, s.end], word: null });
        opts.onPosition?.(n, s.start);
        await (opts.engine === 'piper' ? this.speakPiper(bookId, n, s, my) : this.speakBrowser(s, my));
        if (my !== this.gen) return;
        if (opts.checkpoint && ++heard >= opts.checkpoint.every && sents[i + 1]) { heard = 0; await opts.checkpoint.run(n, s.end); if (my !== this.gen) return; }
        if (scope === 'sentence') return this.stop();
        if (scope === 'paragraph' && sents[i + 1] && /\n\n/.test(pd.text.slice(s.end, sents[i + 1].start))) return this.stop();
      }
      if (scope === 'page' || scope === 'paragraph') return my === this.gen ? this.stop() : undefined;
      n++;
    }
    if (my === this.gen) this.stop();
  }

  private speakBrowser(s: Sentence, my: number): Promise<void> {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(s.text);
      const v = pickVoice(this.accent, this.voice);
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = this.rate; u.volume = this.volume;
      u.onboundary = (e) => {
        if (my !== this.gen || e.name !== 'word') return;
        const len = e.charLength || (s.text.slice(e.charIndex).match(/^\S+/)?.[0].length ?? 1);
        useStore.getState().setAudio({ word: [s.start + e.charIndex, s.start + e.charIndex + len] });
      };
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  private async speakPiper(bookId: string, page: number, s: Sentence, my: number): Promise<void> {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: s.text, voice: this.piperVoice, bookId, page }) });
    if (!r.ok) { useStore.getState().say('Piper unavailable — pick Browser voice in the Audio tab'); this.stop(); return; }
    if (my !== this.gen) return;
    const url = URL.createObjectURL(await r.blob());
    await new Promise<void>((resolve) => {
      const a = new Audio(url); this.audioEl = a; a.playbackRate = this.rate; a.volume = this.volume;
      a.onended = () => resolve(); a.onerror = () => resolve(); void a.play().catch(() => resolve());
    });
    URL.revokeObjectURL(url);
  }
}

export const reader: Reader = typeof window !== 'undefined' ? (((window as any).__folioReader ??= new Reader()) as Reader) : (null as unknown as Reader);

/** Does the browser/OS have a voice for this language? (Telugu/Tamil voices exist only if a Windows language-pack voice or similar is installed.) */
export function voiceFor(code: string): SpeechSynthesisVoice | undefined {
  const base = code.toLowerCase().split('-')[0];
  const vs = browserVoices();
  return vs.find((v) => v.lang.replace('_', '-').toLowerCase() === code.toLowerCase()) ?? vs.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === base);
}
export function speakIn(text: string, code: string, rate = 1): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') return resolve(false);
    const v = voiceFor(code); if (!v) return resolve(false);
    const u = new SpeechSynthesisUtterance(text); u.voice = v; u.lang = v.lang; u.rate = rate;
    u.onend = () => resolve(true); u.onerror = () => resolve(true);
    speechSynthesis.speak(u);
  });
}
