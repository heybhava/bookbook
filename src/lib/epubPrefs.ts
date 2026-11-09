'use client';
// Appearance of the real-book (EPUB) view, modelled on Apple Books: publisher fonts by default, optional font override,
// paged or scrolling, one page or automatic two-page spreads. Text size and theme come from the shared reader prefs.
import { create } from 'zustand';

export type EpubFont = 'original' | 'georgia' | 'palatino' | 'charter' | 'sans' | 'accessible';
export interface EpubPrefs { font: EpubFont; flow: 'paged' | 'scroll'; twoPage: boolean }

const KEY = 'folio.epub.v1';
const DEFAULTS: EpubPrefs = { font: 'original', flow: 'paged', twoPage: true };
const read = (): EpubPrefs => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULTS; } };

interface S { p: EpubPrefs; load: () => void; set: (patch: Partial<EpubPrefs>) => void }
export const useEpubPrefs = create<S>((set, get) => ({
  p: DEFAULTS,
  load: () => set({ p: read() }),
  set: (patch) => {
    const p = { ...get().p, ...patch }; set({ p });
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable: the choice still applies for this session */ }
  },
}));
