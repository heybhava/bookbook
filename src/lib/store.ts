'use client';
import { create } from 'zustand';

export type View = 'home' | 'reader' | 'vocab' | 'notes' | 'knowledge' | 'review' | 'settings' | 'inbox' | 'ask' | 'write' | 'live' | 'recall' | 'vault' | 'journal' | 'reading';
export interface RecallRun { then?: 'home'; title: string; sessionId: string; bookId: string | null; questions: any[]; range?: [number, number] }
export type TransMode = 'original' | 'translated' | 'bilingual';
export type TransLayout = 'stack' | 'stack-rev' | 'side';
export interface LangPrefs { reading?: string; explain?: string; audio?: string; podcast?: string; video?: string; vocab?: string; secondary?: string; ui?: string; showOriginal?: boolean; bilingual?: boolean; terms?: 'keep' | 'translate' | 'both' }
export type CaptureMode = 'sentences' | 'all' | 'highlight';
export interface Jump { bookId: string; page: number; start?: number | null; end?: number | null; text?: string; nonce: number }
export interface DiscWord { word: string; lemma: string; level: string; count: number; start: number; end: number; sentence: string; definition?: string; pos?: string; ipa?: string }
export interface Toast { msg: string; action?: { label: string; run: () => void } }
export type Theme = 'light' | 'dark' | 'sepia';
export type RightTab = 'understand' | 'ask' | 'word' | 'notes' | 'audio' | 'translate';

export interface ReaderPrefs { font: 'serif' | 'sans' | 'mono'; size: number; lineHeight: number; width: number; theme: Theme }
export interface Selection { text: string; page: number; start?: number; end?: number; sentence: string; rect?: { x: number; y: number; w: number; h: number } }
export interface AudioState {
  playing: boolean; engine: 'browser' | 'piper' | null; page: number | null;
  sentence: [number, number] | null; word: [number, number] | null; scope: string; rate: number;
}

interface S {
  view: View; bookId: string | null; page: number;
  go: (view: View, bookId?: string | null) => void;
  setPage: (p: number) => void;
  prefs: ReaderPrefs; setPrefs: (p: Partial<ReaderPrefs>) => void;
  selection: Selection | null; setSelection: (s: Selection | null) => void;
  rightTab: RightTab; setRightTab: (t: RightTab) => void; rightOpen: boolean; setRightOpen: (b: boolean) => void;
  leftOpen: boolean; setLeftOpen: (b: boolean) => void;
  audio: AudioState; setAudio: (a: Partial<AudioState>) => void;
  rev: number; bump: () => void; // forces annotation refetch
  toast: Toast | null; say: (m: string, action?: Toast['action']) => void;
  captureMode: CaptureMode; setCaptureMode: (m: CaptureMode) => void;
  vocabHints: boolean; setVocabHints: (b: boolean) => void;
  readingMode: string; setReadingMode: (m: string) => void;
  jump: Jump | null; openAt: (bookId: string, page: number, start?: number | null, end?: number | null, text?: string) => void;
  askQueue: string | null; ask: (q: string) => void; clearAsk: () => void;
  disc: DiscWord[]; setDisc: (d: DiscWord[]) => void;
  palette: boolean; setPalette: (b: boolean) => void;
  recall: RecallRun | null; setRecall: (r: RecallRun | null) => void;
  langPrefs: LangPrefs; setLangPrefsLocal: (p: LangPrefs) => void;
  transMode: TransMode; transTgt: string; transLayout: TransLayout; setTrans: (p: Partial<{ transMode: TransMode; transTgt: string; transLayout: TransLayout }>) => void;
}

const DEFAULT_PREFS: ReaderPrefs = { font: 'serif', size: 19, lineHeight: 1.7, width: 680, theme: 'light' };
const load = (): ReaderPrefs => {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('folio.prefs') ?? '{}') }; } catch { return DEFAULT_PREFS; }
};

export const useStore = create<S>((set, get) => ({
  view: 'home', bookId: null, page: 1,
  go: (view, bookId = null) => {
    set({ view, bookId: view === 'reader' ? bookId : null, selection: null });
    try { history.replaceState(null, '', view === 'reader' ? `#/read/${bookId}` : `#/${view}`); localStorage.setItem('folio.last', JSON.stringify({ view, bookId })); } catch { /* */ }
  },
  setPage: (page) => set({ page }),
  prefs: DEFAULT_PREFS,
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p }; set({ prefs });
    try {
      localStorage.setItem('folio.prefs', JSON.stringify(prefs));
      localStorage.setItem('folio.theme', prefs.theme);
      document.documentElement.dataset.theme = prefs.theme;
    } catch { /* */ }
  },
  selection: null, setSelection: (selection) => set({ selection }),
  rightTab: 'understand', setRightTab: (rightTab) => set({ rightTab, rightOpen: true }),
  rightOpen: true, setRightOpen: (rightOpen) => set({ rightOpen }),
  leftOpen: true, setLeftOpen: (leftOpen) => set({ leftOpen }),
  audio: { playing: false, engine: null, page: null, sentence: null, word: null, scope: 'book', rate: 1 },
  setAudio: (a) => set({ audio: { ...get().audio, ...a } }),
  rev: 0, bump: () => set({ rev: get().rev + 1 }),
  toast: null,
  say: (msg, action) => { const t = { msg, action }; set({ toast: t }); setTimeout(() => get().toast === t && set({ toast: null }), action ? 6000 : 3200); },
  captureMode: 'sentences', setCaptureMode: (captureMode) => { set({ captureMode }); try { localStorage.setItem('folio.capture', captureMode); } catch { /* */ } },
  vocabHints: true, setVocabHints: (vocabHints) => { set({ vocabHints }); try { localStorage.setItem('folio.vocabhints', vocabHints ? '1' : '0'); } catch { /* */ } },
  readingMode: 'normal', setReadingMode: (readingMode) => { set({ readingMode }); try { localStorage.setItem('folio.mode', readingMode); } catch { /* */ } },
  jump: null,
  openAt: (bookId, page, start, end, text) => {
    const jump: Jump = { bookId, page, start, end, text, nonce: Date.now() };
    if (get().view === 'reader' && get().bookId === bookId) set({ jump, page });
    else { set({ jump }); get().go('reader', bookId); }
  },
  askQueue: null, ask: (askQueue) => set({ askQueue, rightTab: 'ask', rightOpen: true }), clearAsk: () => set({ askQueue: null }),
  disc: [], setDisc: (disc) => set({ disc }),
  palette: false, setPalette: (palette) => set({ palette }),
  recall: null, setRecall: (recall) => set({ recall }),
  langPrefs: {}, setLangPrefsLocal: (langPrefs) => set({ langPrefs }),
  transMode: 'original', transTgt: 'te', transLayout: 'stack',
  setTrans: (p) => { set(p as any); try { const s = get(); localStorage.setItem('folio.trans', JSON.stringify({ transMode: s.transMode, transTgt: s.transTgt, transLayout: s.transLayout })); } catch { /* */ } },
}));

export function hydrateFromClient() {
  const s = useStore.getState();
  const prefs = load();
  const theme = (localStorage.getItem('folio.theme') as Theme | null) ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : prefs.theme);
  useStore.setState({ prefs: { ...prefs, theme } });
  try {
    const cm = localStorage.getItem('folio.capture'); if (cm === 'sentences' || cm === 'all' || cm === 'highlight') useStore.setState({ captureMode: cm });
    useStore.setState({ vocabHints: localStorage.getItem('folio.vocabhints') !== '0', readingMode: localStorage.getItem('folio.mode') ?? 'normal' });
  } catch { /* */ }
  document.documentElement.dataset.theme = theme;
  try { const t = JSON.parse(localStorage.getItem('folio.trans') ?? 'null'); if (t) useStore.setState({ transTgt: t.transTgt ?? 'te', transLayout: t.transLayout ?? 'stack' }); } catch { /* */ }
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('read/')) s.go('reader', h.slice(5));
  else if (['vocab', 'notes', 'knowledge', 'review', 'settings', 'inbox', 'ask', 'write', 'live', 'recall', 'vault', 'journal', 'reading'].includes(h)) s.go(h as View);
  else if (h === '') { try { const l = JSON.parse(localStorage.getItem('folio.last') ?? 'null'); if (l?.view === 'reader' && typeof l.bookId === 'string') s.go('reader', l.bookId); else if (l?.view && l.view !== 'home' && l.view !== 'reader') s.go(l.view); else if (s.view !== 'home') s.go('home'); } catch { /* */ } }
  else if (s.view !== 'home') s.go('home');
}
