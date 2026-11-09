'use client';
// Deterministic, user-controlled reading preferences (no inference, no AI). Global defaults, optional per-book overrides, individual resets.
import { create } from 'zustand';

export type Mode = 'deep' | 'flow' | 'sprint' | 'skim' | 'spotlight' | 'rsvp';
export type Family = 'georgia' | 'palatino' | 'charter' | 'sans' | 'accessible' | 'mono';

export const FAMILIES: Record<Family, { label: string; stack: string }> = {
  georgia: { label: 'Georgia', stack: 'Georgia, "Iowan Old Style", "Palatino Linotype", serif' },
  palatino: { label: 'Palatino', stack: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif' },
  charter: { label: 'Charter', stack: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif' },
  sans: { label: 'Sans', stack: 'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif' },
  accessible: { label: 'Accessible (Verdana)', stack: 'Verdana, Tahoma, "Segoe UI", sans-serif' },
  mono: { label: 'Mono', stack: 'ui-monospace, Consolas, "Courier New", monospace' },
};
export const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'deep', label: 'Deep', hint: 'Immersive pages with unrestricted rereading' },
  { id: 'flow', label: 'Flow', hint: 'Continuous scroll with an optional moving guide' },
  { id: 'sprint', label: 'Sprint', hint: 'A timed session at a pace you choose' },
  { id: 'skim', label: 'Skim', hint: 'First sentences stand out; everything stays readable' },
  { id: 'spotlight', label: 'Spotlight', hint: 'Light on the line or paragraph you are reading' },
  { id: 'rsvp', label: 'RSVP', hint: 'Words shown one at a time in a fixed spot' },
];

export interface ReadPrefs {
  mode: Mode; layout: 'book' | 'page' | 'scroll';
  family: Family; weight: number; letterSpacing: number; wordSpacing: number; paraSpacing: number; margin: number; maxPageWidth: number;
  align: 'left' | 'justify'; hyphens: boolean; customBg: string; customInk: string; brightness: number;
  motion: 'physics' | 'simple' | 'none'; autoHide: boolean; tapZones: boolean;
  pacer: boolean; wpm: number; guide: 'underline' | 'line' | 'band'; autoTurn: boolean;
  spotKind: 'line' | 'paragraph'; spotSize: number; spotDim: number;
  rsvpWpm: number; rsvpChunk: number; rsvpPause: boolean; rsvpOrp: boolean;
  sprintMinutes: number; sprintWpm: number;
  sessionMinutes: number; breakEvery: number;
  restDays: number[]; remind: boolean;
}

export const DEFAULTS: ReadPrefs = {
  mode: 'deep', layout: 'book',
  family: 'georgia', weight: 400, letterSpacing: 0, wordSpacing: 0, paraSpacing: 0.6, margin: 38, maxPageWidth: 560,
  align: 'left', hyphens: true, customBg: '', customInk: '', brightness: 1,
  motion: 'physics', autoHide: true, tapZones: true,
  pacer: false, wpm: 250, guide: 'underline', autoTurn: false,
  spotKind: 'line', spotSize: 2, spotDim: 0.7,
  rsvpWpm: 300, rsvpChunk: 1, rsvpPause: true, rsvpOrp: true,
  sprintMinutes: 10, sprintWpm: 300,
  sessionMinutes: 0, breakEvery: 0,
  restDays: [], remind: false,
};
// settings that may differ per book
export const BOOK_KEYS: (keyof ReadPrefs)[] = ['layout', 'family', 'weight', 'letterSpacing', 'wordSpacing', 'paraSpacing', 'margin', 'maxPageWidth', 'align', 'hyphens', 'customBg', 'customInk', 'brightness'];

const GKEY = 'folio.read.v1', BKEY = (id: string) => `folio.read.book.${id}`;
const rd = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; } };
const wr = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable: settings still apply for this session */ } };

interface RS {
  global: ReadPrefs; book: Partial<ReadPrefs>; bookId: string | null; p: ReadPrefs;
  load: () => void; attach: (id: string | null) => void;
  set: (patch: Partial<ReadPrefs>) => void; setScope: (scope: 'global' | 'book') => void; scope: 'global' | 'book';
  reset: (keys?: (keyof ReadPrefs)[]) => void;
}
const merge = (g: ReadPrefs, b: Partial<ReadPrefs>): ReadPrefs => ({ ...g, ...b });

export const useRead = create<RS>((set, get) => ({
  global: DEFAULTS, book: {}, bookId: null, p: DEFAULTS, scope: 'global',
  load: () => { const g = rd<ReadPrefs>(GKEY, DEFAULTS); set({ global: g, p: merge(g, get().book) }); },
  attach: (id) => { const b = id ? rd<Partial<ReadPrefs>>(BKEY(id), {}) : {}; const has = Object.keys(b).length > 0; set({ bookId: id, book: has ? b : {}, scope: has ? 'book' : 'global', p: merge(get().global, has ? b : {}) }); },
  set: (patch) => {
    const s = get();
    const perBook = s.scope === 'book' && s.bookId;
    const bookPatch: Partial<ReadPrefs> = {}; const globalPatch: Partial<ReadPrefs> = {};
    for (const [k, v] of Object.entries(patch)) (perBook && BOOK_KEYS.includes(k as keyof ReadPrefs) ? bookPatch : globalPatch)[k as never] = v as never;
    const global = { ...s.global, ...globalPatch }; const book = { ...s.book, ...bookPatch };
    if (Object.keys(globalPatch).length) wr(GKEY, global); if (perBook && Object.keys(bookPatch).length) wr(BKEY(s.bookId!), book);
    set({ global, book, p: merge(global, book) });
  },
  setScope: (scope) => {
    const s = get(); if (!s.bookId) return;
    if (scope === 'book') { const b: Partial<ReadPrefs> = {}; for (const k of BOOK_KEYS) b[k as never] = s.p[k] as never; wr(BKEY(s.bookId), b); set({ scope, book: b, p: merge(s.global, b) }); }
    else { try { localStorage.removeItem(BKEY(s.bookId)); } catch { /* */ } set({ scope, book: {}, p: s.global }); }
  },
  reset: (keys) => {
    const s = get(); const ks = keys ?? (Object.keys(DEFAULTS) as (keyof ReadPrefs)[]);
    const global = { ...s.global }; const book = { ...s.book };
    for (const k of ks) { (global as any)[k] = DEFAULTS[k]; delete (book as any)[k]; }
    wr(GKEY, global); if (s.bookId && s.scope === 'book') wr(BKEY(s.bookId), book);
    set({ global, book, p: merge(global, book) });
  },
}));

/** CSS custom properties that every page layout (book spread, single page, scroll) and the pagination measurer read. */
export function readVars(p: ReadPrefs, size: number, lineHeight: number): Record<string, string> {
  return {
    '--book-font': FAMILIES[p.family].stack, '--book-size': `${size}px`, '--book-lh': String(lineHeight), '--book-weight': String(p.weight),
    '--book-ls': `${p.letterSpacing / 100}em`, '--book-ws': `${p.wordSpacing / 100}em`, '--book-ps': `${p.paraSpacing}em`,
    '--book-align': p.align, '--book-hyph': p.hyphens ? 'auto' : 'manual',
    ...(p.customBg ? { '--page': p.customBg } : {}), ...(p.customInk ? { '--ink': p.customInk } : {}),
  };
}
