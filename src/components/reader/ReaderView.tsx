'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, post, put, del, patch } from '@/lib/api';
import { useStore, type RightTab } from '@/lib/store';
import { Icon, Spinner, ErrorNote } from '../ui';
import { TextPage, type Hl } from './TextPage';
import { PdfPage } from './PdfPage';
import { WordPop, cleanWord } from './WordPop';
import { BookSpread, type BookApi, type VP } from './Book';
import { RightPanel } from './Panels';
import { OcrBar } from './OcrBar';
import { BilingualPage } from '../Lang';
import { RecallBanner } from '../Recall';
import { getLang, detectLanguage, fontFor, isRtl } from '@/lib/lang/registry';
import { reader } from '@/lib/tts';
import { useRead, FAMILIES, MODES } from '@/lib/readPrefs';
import { readVars } from '@/lib/readPrefs';
import { useReadSession } from '@/lib/useReadSession';
import { ReaderSettings } from './ReaderSettings';
import { Pacer, Spotlight, RSVP, Calibrate, SprintBar } from './FocusTools';
import { ContinuousView } from './ContinuousView';
import { EpubReader, PAPER, type EpubApi, type TocItem } from './EpubReader';
import { EpubAppearance } from './EpubAppearance';
import { useEpubPrefs } from '@/lib/epubPrefs';

interface Book {
  language?: string | null; id: string; title: string; author: string | null; format: string; page_count: number; status: string; status_detail: string | null;
  chapters: { idx: number; title: string; start_page: number }[]; progress: { page: number; scroll: number } | null;
}
interface Annots { bookmarks: { id: string; page: number; label: string }[]; highlights: (Hl & { page: number })[]; notes: any[] }
interface PageRow { page: number; text: string; html: string | null; chapter_idx: number }

const COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'] as const;

export function ReaderView() {
  const { bookId, go, page, setPage, prefs, setPrefs, selection, setSelection, rightOpen, setRightOpen, leftOpen, setLeftOpen, setRightTab, rev, bump, say, vocabHints, disc, setDisc, jump, readingMode, setReadingMode, transMode, transTgt, transLayout, setTrans } = useStore();
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCap = useRef('');
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [annots, setAnnots] = useState<Annots>({ bookmarks: [], highlights: [], notes: [] });
  const [row, setRow] = useState<PageRow | null>(null);
  const [zoom, setZoom] = useState(1);
  const textView = false; // PDFs always show the real page, never a reflowed text rendition
  const [ocrTick, setOcrTick] = useState(0);
  const epubApi = useRef<EpubApi | null>(null); const [toc, setToc] = useState<TocItem[]>([]); const [epubSec, setEpubSec] = useState(0); const [epubHits, setEpubHits] = useState<{ cfi: string; excerpt: string }[]>([]); const [epubHl, setEpubHl] = useState<Record<string, string>>({});
  const loadEpub = useEpubPrefs((x) => x.load);
  const [leftTab, setLeftTab] = useState<'toc' | 'marks' | 'search'>('toc');
  const [q, setQ] = useState(''); const [hits, setHits] = useState<{ page: number; snippet: string }[]>([]);
  const [hlPop, setHlPop] = useState<{ id: string; x: number; y: number } | null>(null);
  const center = useRef<HTMLDivElement>(null);
  const ready = useRef(false);
  const startedAt = useRef(Date.now()); const pagesTurned = useRef(0);

  // small screens: start with the book alone; panels open as overlays on demand
  useEffect(() => {
    if (window.innerWidth < 1024) setRightOpen(false);
    if (window.innerWidth < 768) setLeftOpen(false);
  }, [bookId, setRightOpen, setLeftOpen]);

  // load book + restore exact reading position
  useEffect(() => {
    if (!bookId) return;
    ready.current = false;
    api<Book>(`/books/${bookId}`).then((b) => {
      const j = useStore.getState().jump; // opened from a note/citation: land on its exact page
      const jumping = !!j && j.bookId === b.id;
      setBook(b); setPage(jumping ? Math.min(Math.max(1, j!.page), Math.max(1, b.page_count)) : b.progress?.page ?? 1);
      requestAnimationFrame(() => { ready.current = true; if (!jumping && b.progress?.scroll && center.current && useRead.getState().p.layout === 'page') center.current.scrollTop = b.progress.scroll * center.current.scrollHeight; });
    }).catch((e) => setError(e.message));
    return () => { reader?.stop(); };
  }, [bookId, setPage]);

  // keep highlight/bookmark array identity when unchanged, so capturing a note never re-renders the page text (which would drop the user's selection)
  const loadAnnots = useCallback(() => {
    if (!bookId) return;
    api<Annots>(`/books/${bookId}/annotations`).then((a) => setAnnots((prev) => ({
      ...a,
      highlights: JSON.stringify(prev.highlights) === JSON.stringify(a.highlights) ? prev.highlights : a.highlights,
      bookmarks: JSON.stringify(prev.bookmarks) === JSON.stringify(a.bookmarks) ? prev.bookmarks : a.bookmarks,
    }))).catch(() => {});
  }, [bookId]);
  useEffect(loadAnnots, [loadAnnots, rev]);
  useEffect(() => { loadEpub(); }, [loadEpub]);
  useEffect(() => { setToc([]); setEpubSec(0); setEpubHits([]); try { setEpubHl(JSON.parse(localStorage.getItem('folio.epubhl.' + bookId) ?? '{}')); } catch { setEpubHl({}); } }, [bookId]);

  // clear the "jump to source" flash target after it has played
  useEffect(() => { if (!jump) return; const t = setTimeout(() => { if (useStore.getState().jump?.nonce === jump.nonce) useStore.setState({ jump: null }); }, 4200); return () => clearTimeout(t); }, [jump]);

  // automatic vocabulary discovery for the page being read
  useEffect(() => {
    if (!bookId || !book) return;
    let live = true;
    setDisc([]);
    api<any[]>(`/books/${bookId}/vocab-discovery?page=${page}`).then((d) => live && setDisc(d)).catch(() => {});
    return () => { live = false; };
  }, [bookId, book, page, ocrTick, setDisc]);
  const hints = useMemo(() => (vocabHints ? disc.map((d) => ({ start: d.start, end: d.end, word: d.word })) : []), [vocabHints, disc]);

  useEffect(() => {
    if (!bookId || !book) return;
    let live = true;
    api<PageRow[]>(`/books/${bookId}/pages?from=${page}&to=${page}`).then((r) => live && setRow(r[0] ?? null)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [bookId, book, page, ocrTick]);

  // persist progress (debounced) + reading time
  const saveProgress = useCallback(() => {
    if (!bookId || !ready.current) return;
    const el = center.current;
    const lay = useRead.getState().p; const frac = lay.layout === 'page' && lay.mode !== 'flow';
    void put(`/books/${bookId}/progress`, { page, scroll: frac && el && el.scrollHeight ? el.scrollTop / el.scrollHeight : 0 }).catch(() => {});
  }, [bookId, page]);
  useEffect(() => { const t = setTimeout(saveProgress, 500); pagesTurned.current++; return () => clearTimeout(t); }, [saveProgress]);
  useEffect(() => {
    const h = () => { if (document.visibilityState === 'hidden') saveProgress(); };
    document.addEventListener('visibilitychange', h); window.addEventListener('beforeunload', saveProgress);
    return () => { document.removeEventListener('visibilitychange', h); window.removeEventListener('beforeunload', saveProgress); };
  }, [saveProgress]);
  // ── active recall: configurable triggers (READ → CLOSE → RECALL). Never blocks reading; skips are recorded separately. ──
  const rs = useRef<any>(null); const readFrom = useRef<number | null>(null); const lastPage = useRef<number | null>(null); const hard = useRef<Record<number, boolean>>({});
  const [offer, setOffer] = useState<{ from: number; to: number; label: string } | null>(null); const [offerBusy, setOfferBusy] = useState(false);
  useEffect(() => { api('/recall/settings').then((s) => { rs.current = s; }).catch(() => {}); }, [bookId]);
  useEffect(() => { if (row) hard.current[page] = disc.length >= 5 || (row.text.match(/=/g) ?? []).length >= 2; }, [row, disc, page]);
  useEffect(() => {
    if (!book) return; const s = rs.current; const last = lastPage.current; lastPage.current = page;
    if (last == null || (page - last !== 1 && page - last !== 2)) { readFrom.current = page; return; } // jumps restart the count
    if (readFrom.current == null) readFrom.current = last;
    if (!s || ['off', 'manual', 'session'].includes(s.trigger) || offer) return;
    const done = page - 1, from = readFrom.current; const n = done - from + 1; const need: Record<string, number> = { page: 1, pages2: 2, pages3: 3, pages5: 5 };
    if (s.trigger in need && n >= need[s.trigger]) setOffer({ from, to: done, label: n === 1 ? 'You finished page ' + done + '. Recall it with the book closed?' : 'You read pages ' + from + '–' + done + '. Recall them with the book closed?' });
    else if (s.trigger === 'chapter' && book.chapters.some((c) => c.start_page === page)) setOffer({ from, to: done, label: 'End of a chapter. Recall it with the book closed?' });
    else if (s.trigger === 'difficult' && hard.current[done]) setOffer({ from: done, to: done, label: 'That page was dense. Test yourself on it?' });
  }, [page, book]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!bookId || !row || !rs.current || ['off', 'manual', 'session'].includes(rs.current.trigger)) return; const t = setTimeout(() => { void post('/recall/generate', { bookId, from: page, to: page }).catch(() => {}); }, 4000); return () => clearTimeout(t); }, [bookId, page, row?.text]); // eslint-disable-line react-hooks/exhaustive-deps
  async function startRecall(from: number, to: number, then?: 'home') {
    if (!bookId) return; setOfferBusy(true);
    try {
      const r = await post('/recall/sessions', { kind: to > from ? 'section' : 'page', bookId, from, to, count: rs.current?.perSession ?? 3 });
      reader?.stop(); setOffer(null); readFrom.current = null; useStore.getState().setRecall({ then, title: book ? book.title + ' · ' + (from === to ? 'page ' + from : 'pp. ' + from + '–' + to) : 'Recall', sessionId: r.sessionId, bookId, questions: r.questions, range: [from, to] });
    } catch (e: any) { say(e.message); }
    setOfferBusy(false);
  }
  async function leave() {
    const s = rs.current; const from = readFrom.current;
    if (s?.trigger === 'session' && from != null && page >= from && window.confirm('Test yourself on pp. ' + from + '–' + page + ' before you leave?')) return startRecall(from, page, 'home');
    go('home');
  }
  const total = book?.page_count ?? 1;
  const goPage = useCallback((p: number) => { const n = Math.min(Math.max(1, p), total); setSubSt({ page: 0, sub: 0 }); if (n !== page) { reader?.stop(); setSelection(null); setPage(n); center.current?.scrollTo({ top: 0 }); } }, [page, total, setPage, setSelection]);

  // ── page turning: arrows / edge buttons / drag or swipe. The page folds about its spine, the next one settles in. ──
  const [turn, setTurn] = useState({ ang: 0, dur: 0, op: 1 });
  const flipping = useRef<null | 'fwd' | 'back'>(null); const failsafe = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = useRef(false); useEffect(() => { try { reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* */ } }, []);
  const flipTo = useCallback((dir: 1 | -1) => {
    const n = page + dir; if (n < 1 || n > total || flipping.current) return;
    if (reduced.current) { goPage(n); return; }
    flipping.current = dir > 0 ? 'fwd' : 'back';
    setTurn(dir > 0 ? { ang: -88, dur: 260, op: 1 } : { ang: 0, dur: 140, op: 0 });
    setTimeout(() => goPage(n), dir > 0 ? 260 : 140);
    if (failsafe.current) clearTimeout(failsafe.current);
    failsafe.current = setTimeout(() => { flipping.current = null; setTurn({ ang: 0, dur: 0, op: 1 }); }, 2000);
  }, [page, total, goPage]);
  const shownPage = row?.page;
  useEffect(() => { // the new page has arrived: play the second half of the turn
    const f = flipping.current; if (!f) return;
    const raf2 = (fn: () => void) => setTimeout(fn, 40); // timer, not rAF: still fires when the window is in the background
    if (f === 'fwd') { setTurn({ ang: 0, dur: 0, op: 0 }); raf2(() => setTurn({ ang: 0, dur: 240, op: 1 })); }
    else { setTurn({ ang: -88, dur: 0, op: 1 }); raf2(() => setTurn({ ang: 0, dur: 380, op: 1 })); }
    if (failsafe.current) clearTimeout(failsafe.current);
    failsafe.current = setTimeout(() => { flipping.current = null; }, 420);
  }, [shownPage]);
  const drag = useRef<{ x: number; y: number; t: number; w: number; on: boolean } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || flipping.current) return;
    const el = e.target as HTMLElement; if (e.pointerType === 'mouse' && !el.dataset.turn) return; // mouse: drag from the page margin (text keeps normal selection); touch: anywhere
    drag.current = { x: e.clientX, y: e.clientY, t: Date.now(), w: Math.max(300, (el.closest('[data-sheet]') as HTMLElement | null)?.offsetWidth ?? center.current?.clientWidth ?? 600), on: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.on) { if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) { d.on = true; try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ } window.getSelection()?.removeAllRanges(); } else return; }
    if (dx < 0 && page < total) setTurn({ ang: Math.max(-88, (dx / d.w) * 110), dur: 0, op: 1 });
    else if (dx > 0 && page > 1) setTurn({ ang: Math.min(14, (dx / d.w) * 30), dur: 0, op: 1 });
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null; if (!d?.on) return;
    const dx = e.clientX - d.x, v = Math.abs(dx) / Math.max(1, Date.now() - d.t);
    const go = Math.abs(dx) > d.w * 0.22 || (Math.abs(dx) > 40 && v > 0.5);
    if (go && dx < 0 && page < total) flipTo(1); else if (go && dx > 0 && page > 1) flipTo(-1); else setTurn({ ang: 0, dur: 260, op: 1 });
  };

  // ── reading preferences, layout & modes ──
  const { p: rp, set: setRp, load: loadRp, attach: attachRp } = useRead();
  useEffect(() => { loadRp(); try { if (localStorage.getItem('folio.read.v1') == null && localStorage.getItem('folio.spread') === '0') setRp({ layout: 'page' }); } catch { /* */ } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { attachRp(bookId); }, [bookId, attachRp]);
  const [mainW, setMainW] = useState(0);
  useEffect(() => { const el = center.current; if (!el) return; const ro = new ResizeObserver(() => setMainW(el.clientWidth)); ro.observe(el); setMainW(el.clientWidth); return () => ro.disconnect(); }, [!!book]);
  const isEpub = book?.format === 'epub' && transMode === 'original'; // the real book, exactly as published
  const canFlow = !isEpub && !(book?.format === 'pdf' && !textView) && transMode === 'original'; // reflowable text can be paginated or scrolled; PDF pages and translations stay as they are
  const layoutNow = rp.mode === 'flow' ? 'scroll' : rp.layout;
  const spread = canFlow && layoutNow === 'book' && mainW >= 640;
  const scrollLayout = canFlow && layoutNow === 'scroll';
  const [subSt, setSubSt] = useState({ page: 0, sub: 0 }); const sub = subSt.page === page ? subSt.sub : 0; // which printed page of this section is on the left
  const [bk, setBk] = useState<Record<number, string>>({}); const bkFor = useRef('');
  useEffect(() => {
    if (!(spread || scrollLayout) || !bookId || !book) return;
    const key = bookId + ':' + ocrTick; if (bkFor.current !== key) { bkFor.current = key; setBk({}); }
    const from = Math.max(1, page - 2), to = Math.min(book.page_count, page + 3); let live = true;
    api<PageRow[]>(`/books/${bookId}/pages?from=${from}&to=${to}`).then((r) => live && setBk((p) => { const n = { ...p }; for (const x of r) n[x.page] = x.text; return n; })).catch(() => {});
    return () => { live = false; };
  }, [spread, scrollLayout, bookId, book, page, ocrTick]);
  const bookApi = useRef<BookApi | null>(null);

  // ── whole-book text (exact page numbers, time left, continuous scroll) ──
  useEffect(() => {
    if (!(spread || scrollLayout) || !bookId || !book) return; let live = true;
    (async () => {
      for (let from = 1; from <= book.page_count && live; from += 50) {
        try { const r = await api<PageRow[]>(`/books/${bookId}/pages?from=${from}&to=${Math.min(book.page_count, from + 49)}`); if (!live) return; setBk((p) => { const n = { ...p }; for (const x of r) n[x.page] = x.text; return n; }); } catch { return; }
        await new Promise((r) => setTimeout(r, 30));
      }
    })();
    return () => { live = false; };
  }, [spread, scrollLayout, bookId, book, ocrTick]);
  const [st, setSt] = useState<{ printed: number; total: number; exact: boolean } | null>(null); const stAt = useRef<((db: number) => number) | null>(null);
  useEffect(() => {
    if (!spread) return;
    const id = setInterval(() => { const s = bookApi.current?.stats(); if (!s) return; stAt.current = s.at; setSt((p) => (p && p.printed === s.printed && p.total === s.total && p.exact === s.exact ? p : { printed: s.printed, total: s.total, exact: s.exact })); }, 400);
    return () => clearInterval(id);
  }, [spread]);
  const wcache = useRef<Record<number, number>>({}); useEffect(() => { wcache.current = {}; }, [bookId]);
  const words = useMemo(() => {
    const per: number[] = []; let known = 0, n = 0;
    for (let d = 1; d <= total; d++) { const t = bk[d]; if (t != null) { const w = (wcache.current[d] ??= t.split(/\s+/).length); per[d] = w; known += w; n++; } }
    const avg = n ? known / n : 300; let rest = 0, tot = 0;
    for (let d = 1; d <= total; d++) { const w = per[d] ?? avg; tot += w; if (d >= page) rest += w; }
    return { rest, tot, per, avg };
  }, [bk, total, page]);

  // ── activity, streak, measured speed ──
  const sess = useReadSession({ bookId, mode: rp.mode, restDays: rp.restDays, say });
  const wpmRef = useRef(230); const lastTurn = useRef(0); const prevPos = useRef<{ page: number; printed: number } | null>(null);
  useEffect(() => { try { const w = Number(localStorage.getItem('folio.wpm')); if (w > 80 && w < 900) wpmRef.current = w; } catch { /* */ } }, []);
  useEffect(() => { // pages and words moved past (an estimate from section sizes) feed the statistics; turns 6–240 s apart refine the speed used for "time left"
    const s = spread ? bookApi.current?.stats() : null; const printed = s?.printed ?? 0; const prev = prevPos.current; prevPos.current = { page, printed };
    const now = Date.now(); const dt = (now - lastTurn.current) / 1000; const first = lastTurn.current === 0; lastTurn.current = now; if (!prev || first) return;
    let adv = 0, wAdv = 0;
    if (spread && s && printed && prev.printed) { const d = printed - prev.printed; if (d >= 1 && d <= 4) { adv = d; wAdv = d * (words.tot / Math.max(1, s.total)); } }
    else if (!spread && page - prev.page === 1) { adv = 1; wAdv = words.per[prev.page] ?? words.avg; }
    if (!adv) return; sess.addPages(adv); sess.addWords(wAdv);
    if (dt >= 6 && dt <= 240 && wAdv > 20) { const sample = Math.max(80, Math.min(900, wAdv / (dt / 60))); wpmRef.current = 0.88 * wpmRef.current + 0.12 * sample; try { localStorage.setItem('folio.wpm', String(Math.round(wpmRef.current))); } catch { /* */ } }
  }, [page, sub]); // eslint-disable-line react-hooks/exhaustive-deps
  const prevCh = useRef(-1); const chNow = row?.chapter_idx ?? 0;
  useEffect(() => {
    if (!book) return; const p = prevCh.current; prevCh.current = chNow; if (p < 0 || chNow <= p) return;
    const ch = book.chapters[chNow]; if (!ch) return; const end = (book.chapters[chNow + 1]?.start_page ?? total + 1) - 1; let w = 0; for (let d = ch.start_page; d <= end; d++) w += words.per[d] ?? words.avg;
    say(`Chapter finished. Next: ${ch.title} · about ${Math.max(1, Math.round(w / wpmRef.current))} min`);
  }, [chNow]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── focus: auto-hide, zen, pacer, sprint, spotlight, RSVP, calibration, timers, history ──
  const [idle, setIdle] = useState(false); const [zen, setZen] = useState(false); const [settingsBusy, setSettingsBusy] = useState(false);
  useEffect(() => {
    if (!rp.autoHide && !zen) { setIdle(false); return; } let t: ReturnType<typeof setTimeout>;
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 3500); };
    wake(); window.addEventListener('mousemove', wake); window.addEventListener('keydown', wake); window.addEventListener('pointerdown', wake);
    return () => { clearTimeout(t); window.removeEventListener('mousemove', wake); window.removeEventListener('keydown', wake); window.removeEventListener('pointerdown', wake); };
  }, [rp.autoHide, zen]);
  const hideChrome = (rp.autoHide || zen) && idle && !selection && !settingsBusy;
  const [host, setHost] = useState<HTMLElement | null>(null); const [sheetEl, setSheetEl] = useState<HTMLElement | null>(null); const [flowHost, setFlowHost] = useState<HTMLElement | null>(null);
  const hostEl = spread ? host : scrollLayout ? flowHost : sheetEl;
  const [sprintRun, setSprintRun] = useState(false); const [calibrating, setCalibrating] = useState(false);
  const pacerOn = (rp.pacer || sprintRun) && !!hostEl && rp.mode !== 'rsvp';
  const hist = useRef<{ page: number; sub: number }[]>([]); const [histN, setHistN] = useState(0);
  const jumpTo = useCallback((p: number) => { if (Math.abs(p - page) > 2) { hist.current.push({ page, sub }); if (hist.current.length > 30) hist.current.shift(); setHistN(hist.current.length); } goPage(p); }, [page, sub, goPage]);
  const goBack = useCallback(() => { const h = hist.current.pop(); setHistN(hist.current.length); if (!h) return; goPage(h.page); setSubSt({ page: h.page, sub: h.sub }); }, [goPage]);
  const turnPage = useCallback((dir: 1 | -1) => {
    if (isEpub) epubApi.current?.[dir > 0 ? 'next' : 'prev']();
    else if (spread) bookApi.current?.turn(dir);
    else if (scrollLayout) center.current?.scrollBy({ top: dir * (center.current.clientHeight * 0.85), behavior: rp.motion === 'none' ? 'auto' : 'smooth' });
    else flipTo(dir);
  }, [isEpub, spread, scrollLayout, flipTo, rp.motion]);
  const chapterJump = useCallback((dir: 1 | -1) => {
    if (!book) return; const cs = book.chapters; const cur = Math.max(0, cs.reduce((a, c, i) => (c.start_page <= page ? i : a), 0));
    const t = dir > 0 ? cs[cur + 1] : (page > cs[cur].start_page ? cs[cur] : cs[cur - 1]); if (t) jumpTo(t.start_page);
  }, [book, page, jumpTo]);

  // keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable || e.ctrlKey || e.metaKey) return;
      if (rp.mode === 'rsvp' || calibrating) return; // those screens handle their own keys
      const k = e.key;
      if (e.altKey && k === 'ArrowRight') { e.preventDefault(); chapterJump(1); }
      else if (e.altKey && k === 'ArrowLeft') { e.preventDefault(); chapterJump(-1); }
      else if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); turnPage(1); }
      else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); turnPage(-1); }
      else if (k === ' ' && useStore.getState().audio.engine) { e.preventDefault(); useStore.getState().audio.playing ? reader.pause() : reader.resume(); }
      else if (k === ' ') { e.preventDefault(); turnPage(e.shiftKey ? -1 : 1); }
      else if (k === 'Home') { e.preventDefault(); jumpTo(1); } else if (k === 'End') { e.preventDefault(); jumpTo(total); }
      else if (k === 'Backspace' && hist.current.length) { e.preventDefault(); goBack(); }
      else if (/^[1-6]$/.test(k)) setRp({ mode: MODES[Number(k) - 1].id });
      else if (k === 'p') setRp({ pacer: !rp.pacer });
      else if (k === 'z') setZen((z) => !z);
      else if (k === '+' || k === '=') setPrefs({ size: Math.min(32, prefs.size + 1) });
      else if (k === '-') setPrefs({ size: Math.max(14, prefs.size - 1) });
      else if (k === 't') window.dispatchEvent(new CustomEvent('folio:settings'));
      else if (k === 'f') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); }
      else if (k === 'b') toggleBookmark();
      else if (k === '/') { e.preventDefault(); setLeftOpen(true); setLeftTab('search'); setTimeout(() => document.getElementById('book-search')?.focus(), 50); }
      else if (k === ']') setRightOpen(!rightOpen);
      else if (k === '[') setLeftOpen(!leftOpen);
      else if (k === 'Escape') { if (zen) setZen(false); setSelection(null); setHlPop(null); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  const bookmarked = annots.bookmarks.find((b) => b.page === page);
  async function toggleBookmark() {
    if (!bookId) return;
    const cur = useStore.getState().page;
    const ex = annots.bookmarks.find((b) => b.page === cur);
    if (ex) await del(`/bookmarks/${ex.id}`); else await post(`/books/${bookId}/bookmarks`, { page: cur, label: `Page ${cur}` });
    bump(); say(ex ? 'Bookmark removed' : 'Bookmarked');
  }

  async function highlight(color: string) {
    if (!selection || !bookId) return;
    const cfi = isEpub ? epubApi.current?.selectionCfi() ?? null : null; // in the real book a highlight is anchored by its exact location
    const r = await post(`/books/${bookId}/highlights`, { page: selection.page, text: selection.text, color, start: selection.start ?? null, end: selection.end ?? null });
    if (cfi && r?.id) setEpubHl((m) => { const n = { ...m, [r.id]: cfi }; try { localStorage.setItem('folio.epubhl.' + bookId, JSON.stringify(n)); } catch { /* */ } return n; });
    epubApi.current?.clearSelection(); window.getSelection()?.removeAllRanges(); setSelection(null); bump();
  }

  const pageHl = useMemo(() => annots.highlights.filter((h) => h.page === page), [annots.highlights, page]);
  const epubHls = useMemo(() => annots.highlights.filter((h) => epubHl[h.id]).map((h) => ({ id: h.id, color: h.color, cfi: epubHl[h.id] })), [annots.highlights, epubHl]);
  const onSelect = useCallback((s: { text: string; start: number; end: number; sentence: string; rect: DOMRect } | null, pgArg?: number) => {
    if (capTimer.current) clearTimeout(capTimer.current);
    if (!s) return setSelection(null);
    setHlPop(null);
    const st = useStore.getState();
    const pg = pgArg ?? st.page;
    setSelection({ text: s.text, page: pg, start: s.start, end: s.end, sentence: s.sentence, rect: { x: s.rect.left + s.rect.width / 2, y: s.rect.top, w: s.rect.width, h: s.rect.height } });
    const isWord = s.text.trim().split(/\s+/).length <= 2;
    if (isWord) setRightTab('word'); // single words prioritise vocabulary lookup
    else if (st.rightOpen && (st.rightTab === 'understand' || st.rightTab === 'word')) st.setRightTab('word'); // sentences: show difficult words in context, never steal the Ask/Audio tab
    const mode = st.captureMode;
    if (!bookId || s.text.length < 3 || !(mode === 'all' || (mode === 'sentences' && !isWord))) return;
    const key = `${pg}:${s.start}:${s.text}`;
    // debounce so dragging/extending a selection saves one note, and the same passage is never re-saved
    capTimer.current = setTimeout(async () => {
      if (lastCap.current === key) return;
      try {
        const r = await post(`/books/${bookId}/captures`, { page: pg, text: s.text, start: s.start, end: s.end });
        lastCap.current = key;
        useStore.getState().say(r.created ? 'Saved to Notes' : 'Already in your Notes', r.created ? { label: 'Undo', run: () => { void del(`/notes/${r.id}`).then(() => { lastCap.current = ''; loadAnnots(); }); } } : undefined);
        loadAnnots();
      } catch { /* capture is best-effort; the selection itself is untouched */ }
    }, 800);
  }, [setSelection, setRightTab, bookId, loadAnnots]);
  const onHintClick = useCallback((word: string, sentence: string) => {
    setSelection({ text: word, page: useStore.getState().page, sentence });
    setRightTab('word');
  }, [setSelection, setRightTab]);
  const jumpHere = jump && book && jump.bookId === book.id && jump.page === page ? jump : null;
  const onHighlightClick = useCallback((id: string, r: DOMRect) => { if (!window.getSelection()?.toString()) setHlPop({ id, x: r.left + r.width / 2, y: r.top }); }, []);

  async function runEpubSearch() { if (q.trim().length < 2) return setEpubHits([]); setEpubHits(await (epubApi.current?.search(q) ?? Promise.resolve([]))); }
  async function doSearch(v: string) { setQ(v); if (v.trim().length < 2 || !bookId) return setHits([]); setHits(await api(`/books/${bookId}/search?q=${encodeURIComponent(v)}`)); }

  if (error) return <div className="p-8 max-w-lg mx-auto"><ErrorNote error={error} /><button className="btn mt-3" onClick={() => go('home')}>Back to library</button></div>;
  if (!book) return <div className="p-8"><Spinner label="Opening…" /></div>;
  const chIdx = row?.chapter_idx ?? 0;
  const chapterTitle = isEpub && toc.length ? (toc.filter((t) => t.index <= epubSec).pop() ?? toc[0]).label : book.chapters[chIdx]?.title;
  const vars = readVars(rp, Math.max(14, Math.min(32, prefs.size)), prefs.lineHeight);
  const atStart = spread || scrollLayout ? false : page <= 1, atEnd = spread || scrollLayout ? false : page >= total;
  const headOf = (n: number) => { let t = ''; for (const ch of book.chapters) if (ch.start_page <= n) t = ch.title; return t; };
  const renderLive = (vp: VP, slice: string, base: number, full: string) => {
    const n = vp.db; const jn = jump && jump.bookId === book.id && jump.page === n ? jump : null;
    return <TextPage key={n + ':' + vp.sub} page={n} text={slice} base={base} fullText={full} highlights={annots.highlights.filter((h) => h.page === n)} onSelect={(s) => onSelect(s, n)} onHighlightClick={onHighlightClick} searchTerm={leftTab === 'search' ? q : undefined} hints={n === page ? hints : undefined} skim={rp.mode === 'skim'} jump={jn} onHintClick={(word, sentence) => { setSelection({ text: word, page: n, sentence }); setRightTab('word'); }} />;
  };
  const isPdf = book.format === 'pdf';
  const showPdf = isPdf && !textView;
  const renderSection = (n: number) => { const t = bk[n]; if (t == null) return <Spinner />; const jn = jump && jump.bookId === book.id && jump.page === n ? jump : null; return <TextPage key={n} page={n} text={t} highlights={annots.highlights.filter((h) => h.page === n)} onSelect={(s) => onSelect(s, n)} onHighlightClick={onHighlightClick} searchTerm={leftTab === 'search' ? q : undefined} hints={n === page ? hints : undefined} skim={rp.mode === 'skim'} jump={jn} onHintClick={(word, sentence) => { setSelection({ text: word, page: n, sentence }); setRightTab('word'); }} />; };
  const focusLayer = hostEl ? (<>
    {rp.mode === 'spotlight' && <Spotlight host={hostEl} kind={rp.spotKind} size={rp.spotSize} dim={rp.spotDim} resetKey={spread ? `${page}:${sub}` : String(page)} />}
    {pacerOn && <Pacer host={hostEl} scroller={spread ? null : center.current} active wpm={sprintRun ? rp.sprintWpm : rp.wpm} guide={rp.guide} autoTurn={sprintRun || rp.autoTurn} onEnd={() => turnPage(1)} resetKey={spread ? `${page}:${sub}` : scrollLayout ? 'flow' : String(page)} />}
  </>) : null;

  return (
    <div className="h-screen flex flex-col" style={{ ...(vars as React.CSSProperties), ...(isEpub ? { background: PAPER[prefs.theme].bg } : {}) }}>
      <div className="sr-only" aria-live="polite" role="status">{st ? `Page ${st.printed} of ${st.total}` : `Page ${page} of ${total}`}</div>
      <header className={`h-12 shrink-0 flex items-center gap-1 px-2 ${isEpub ? '' : 'border-b border-[var(--line)] bg-[var(--panel)]'}`} style={{ opacity: hideChrome ? 0 : 1, transition: 'opacity .6s', ...(zen ? { display: 'none' } : {}) }}>
        <button className="btn btn-ghost" onClick={leave} aria-label="Back to library"><Icon n="left" /> <span className="hidden sm:inline">Library</span></button>
        <button className="btn btn-ghost" onClick={() => setLeftOpen(!leftOpen)} aria-label="Toggle contents ([)"><Icon n="menu" /></button>
        <div className="min-w-0 flex-1 text-center"><div className="text-sm font-medium truncate">{book.title}</div><div className="text-[11px] text-[var(--ink3)] truncate">{chapterTitle}</div></div>
        {!isEpub && <select className="input !w-auto !py-1 !text-xs hidden md:block" value={readingMode} onChange={(e) => { setReadingMode(e.target.value); if (e.target.value !== 'normal') setRightTab('understand'); }} aria-label="Reading mode" title="Reading mode — changes what the companion looks for; the document itself is never altered">
          {[['normal', 'Normal'], ['learning', 'Learning'], ['deep', 'Deep understanding'], ['critical', 'Critical thinking'], ['exam', 'Exam'], ['research', 'Research'], ['language', 'Language learning']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>}
        <button className={`btn btn-ghost text-xs ${transMode !== 'original' ? '!text-[var(--accent)]' : ''}`} title="Translate this book (original → bilingual → translated)" onClick={() => { const next = transMode === 'original' ? 'bilingual' : transMode === 'bilingual' ? 'translated' : 'original'; setTrans({ transMode: next }); if (next !== 'original') setRightTab('translate'); }} aria-label="Translation mode"><Icon n="type" size={15} /> {transMode === 'original' ? 'Translate' : transMode === 'bilingual' ? `Bilingual · ${transTgt}` : `${transTgt}`}</button>
        {!isEpub && <ModeMenu onCalibrate={() => setCalibrating(true)} />}
        {isEpub ? <EpubAppearance onOpen={setSettingsBusy} /> : <ReaderSettings isPdf={showPdf} zoom={zoom} setZoom={setZoom} bookId={book.id} onCalibrate={() => setCalibrating(true)} onOpen={setSettingsBusy} />}
        <button className="btn btn-ghost text-xs" onClick={() => startRecall(page, page)} disabled={offerBusy} title="Close the book and test yourself on this page" aria-label="Recall this page"><Icon n="cards" size={15} /> <span className="hidden md:inline">Recall</span></button>
        <button className="btn btn-ghost" onClick={toggleBookmark} aria-label="Bookmark page (b)" aria-pressed={!!bookmarked}><Icon n="bookmark" className={bookmarked ? 'fill-current text-[var(--accent)]' : ''} /></button>
        <button className="btn btn-ghost hidden sm:inline-flex" onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()} aria-label="Fullscreen (f)"><Icon n="full" /></button>
        <button className="btn btn-ghost text-xs hidden sm:inline-flex" onClick={() => setZen(true)} aria-label="Zen mode (z)" title="Zen mode: hide everything except the book (z)">Zen</button>
        <button className="btn btn-ghost" onClick={() => setRightOpen(!rightOpen)} aria-label="Toggle companion (])"><Icon n="sparkle" /></button>
      </header>

      <div className="flex-1 flex min-h-0 relative">
        {leftOpen && !zen && (
          <aside className="w-64 shrink-0 border-r border-[var(--line)] bg-[var(--panel)] flex flex-col max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:shadow-xl" aria-label="Book navigation">
            <div className="flex border-b border-[var(--line)] text-xs">
              {([['toc', 'Contents'], ['marks', 'Marks'], ['search', 'Search']] as const).map(([k, l]) => <button key={k} onClick={() => setLeftTab(k)} className={`flex-1 py-2.5 ${leftTab === k ? 'font-semibold border-b-2 border-[var(--accent)]' : 'text-[var(--ink2)]'}`}>{l}</button>)}
            </div>
            <div className="flex-1 overflow-auto p-2 text-sm">
              {leftTab === 'toc' && (isEpub && toc.length ? toc.map((t, i) => { const cur = toc.reduce((a, x, j) => (x.index <= epubSec ? j : a), -1) === i; return (
                <button key={i} onClick={() => epubApi.current?.goHref(t.href)} style={{ paddingLeft: 8 + t.depth * 14 }} className={`w-full text-left pr-2 py-1.5 rounded-md hover:bg-[var(--panel2)] ${cur ? 'bg-[var(--panel2)] font-medium' : ''}`}><span className="line-clamp-2">{t.label}</span></button>
              ); }) : book.chapters.map((c) => (
                <button key={c.idx} onClick={() => jumpTo(c.start_page)} className={`w-full text-left px-2 py-1.5 rounded-md hover:bg-[var(--panel2)] flex justify-between gap-2 ${c.idx === chIdx ? 'bg-[var(--panel2)] font-medium' : ''}`}><span className="truncate">{c.title}</span><span className="text-[var(--ink3)] text-xs">{c.start_page}</span></button>
              )))}
              {leftTab === 'marks' && (
                <div className="space-y-3">
                  <div><div className="label mb-1 px-1">Bookmarks</div>{annots.bookmarks.length === 0 && <div className="text-xs text-[var(--ink3)] px-1">Press B to bookmark this page.</div>}{annots.bookmarks.map((b) => <button key={b.id} onClick={() => jumpTo(b.page)} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[var(--panel2)] flex justify-between"><span>{b.label || `Page ${b.page}`}</span><span className="text-xs text-[var(--ink3)]">{b.page}</span></button>)}</div>
                  <div><div className="label mb-1 px-1">Highlights</div>{annots.highlights.length === 0 && <div className="text-xs text-[var(--ink3)] px-1">Select text to highlight it.</div>}{annots.highlights.map((h) => <button key={h.id} onClick={() => (isEpub && epubHl[h.id] ? epubApi.current?.goCfi(epubHl[h.id]) : jumpTo(h.page))} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[var(--panel2)]"><mark className={`hl hl-${h.color} text-xs line-clamp-3`}>{h.text}</mark><div className="text-[10px] text-[var(--ink3)] mt-0.5">p. {h.page}{h.note ? ` · ${h.note}` : ''}</div></button>)}</div>
                </div>
              )}
              {leftTab === 'search' && (
                <div><form onSubmit={(e) => { e.preventDefault(); if (isEpub) void runEpubSearch(); }}><input id="book-search" className="input" placeholder={isEpub ? 'Search in book ( / ) — press Enter' : 'Search in book ( / )'} value={q} onChange={(e) => (isEpub ? setQ(e.target.value) : void doSearch(e.target.value))} /></form>
                  {isEpub ? <div className="mt-2 space-y-1">{epubHits.map((h, i) => <button key={i} onClick={() => epubApi.current?.goCfi(h.cfi)} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[var(--panel2)] text-xs">{h.excerpt}</button>)}{q.length > 1 && epubHits.length === 0 && <div className="text-xs text-[var(--ink3)] px-1">Press Enter to search; no matches yet.</div>}</div> :
                  <div className="mt-2 space-y-1">{hits.map((h, i) => <button key={i} onClick={() => jumpTo(h.page)} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[var(--panel2)] text-xs"><span className="font-semibold">p. {h.page}</span> {h.snippet}</button>)}{q.length > 1 && hits.length === 0 && <div className="text-xs text-[var(--ink3)] px-1">No matches.</div>}</div>}</div>
              )}
            </div>
          </aside>
        )}

        <div className="flex-1 min-w-0 relative flex turn-zone">
          <main ref={center} className={`flex-1 ${spread || isEpub ? 'overflow-hidden' : 'overflow-auto'} bg-[var(--bg)] relative`} style={isEpub ? { background: PAPER[prefs.theme].bg } : undefined} onScroll={() => { setHlPop(null); }} id="reader-scroll" data-turn={isEpub ? undefined : '1'} onPointerDown={isEpub ? undefined : onDown} onPointerMove={isEpub ? undefined : onMove} onPointerUp={isEpub ? undefined : onUp} onPointerCancel={isEpub ? undefined : onUp}>
            {book.status === 'readable' && <div className="sticky top-0 z-10 text-center text-xs py-1 bg-[var(--panel2)] text-[var(--ink2)]">{book.status_detail ?? 'Indexing for search and AI…'} You can keep reading.</div>}
            {isEpub ? <EpubReader key={book.id} bookId={book.id} total={total} page={page} onPage={setPage} theme={prefs.theme} size={prefs.size} pageText={row?.text ?? ''} highlights={epubHls} onSelect={(s) => onSelect(s)} onHighlightClick={onHighlightClick} apiRef={epubApi} onToc={setToc} onSection={setEpubSec} jump={jump && jump.bookId === book.id ? { text: jump.text, page: jump.page, nonce: jump.nonce } : null} /> : spread ? <div className="absolute inset-0"><BookSpread key={book.id} pos={{ db: page, sub }} total={total} texts={bk} title={book.title} headOf={headOf} vars={vars} padX={rp.margin} maxPageW={rp.maxPageWidth} motion={rp.motion} edgeClicks={rp.tapZones} hostRef={setHost} overlay={focusLayer} renderLive={renderLive} onCommit={(p) => { goPage(p.db); setSubSt({ page: p.db, sub: p.sub }); }} apiRef={bookApi} /></div> : scrollLayout ? (
              <ContinuousView total={total} page={page} chapterAt={(n) => book.chapters.find((ch) => ch.start_page === n)?.title ?? null} hasText={(n) => bk[n] != null} renderSection={renderSection} onVisible={(n) => setPage(n)} hostRef={setFlowHost} maxWidth={prefs.width} overlay={focusLayer} />
            ) : (
            <div className="mx-auto px-3 sm:px-8 py-6 md:py-10" style={{ maxWidth: showPdf ? undefined : prefs.width + 120, perspective: 2200 }} data-turn="1">
              <div ref={setSheetEl} data-sheet="1" data-turn="1" lang={book.language || undefined} className={`paper ${showPdf ? '' : 'paper-text'} pt-9 pb-8`} style={{ paddingLeft: Math.max(18, rp.margin + 10), paddingRight: Math.max(18, rp.margin + 10), minHeight: 'min(78vh, 1100px)', touchAction: 'pan-y', transformOrigin: 'left center', transform: `rotateY(${turn.ang}deg)`, opacity: turn.op, transition: turn.dur ? `transform ${turn.dur}ms cubic-bezier(.45,.05,.3,1), opacity ${turn.dur}ms ease` : 'none' }}>
                <div className="flex justify-between gap-4 text-[11px] tracking-[.14em] uppercase text-[var(--ink3)] mb-7 select-none pointer-events-none" aria-hidden><span className="truncate">{book.title}</span><span className="truncate">{book.chapters[chIdx]?.title}</span></div>
                {!row ? <Spinner /> : showPdf
                  ? <>
                    <PdfPage bookId={book.id} page={page} zoom={zoom} pageText={row.text} highlights={pageHl} onSelect={onSelect} onHighlightClick={onHighlightClick} jump={jumpHere} />
                    <OcrBar bookId={book.id} page={page} pageHasText={!!row.text.trim()} onDone={() => setOcrTick((n) => n + 1)} />
                  </>
                  : transMode !== 'original' && row.text.trim() ? <BilingualPage key={`${page}-${transTgt}-${transMode}`} bookId={book.id} page={page} text={row.text} tgt={transTgt} mode={transMode} layout={transLayout} srcLang={book.language && getLang(book.language) ? getLang(book.language)!.code : detectLanguage(row.text).code} onSelect={onSelect} />
                  : <TextPage key={page} page={page} text={row.text} highlights={pageHl} onSelect={onSelect} onHighlightClick={onHighlightClick} searchTerm={leftTab === 'search' ? q : undefined} hints={hints} skim={rp.mode === 'skim'} jump={jumpHere} onHintClick={onHintClick} />}
                {focusLayer}
                <div className="mt-10 text-center text-xs text-[var(--ink3)] tabular-nums select-none pointer-events-none" aria-hidden>{page}</div>
                {turn.ang < 0 && <div className="paper-shade" style={{ opacity: Math.min(1, Math.abs(turn.ang) / 60) }} />}
              </div>
            </div>)}
          </main>
          <button className="turn-btn left-2" onClick={() => turnPage(-1)} disabled={atStart} aria-label="Previous page (←)"><Icon n="left" /></button>
          <button className="turn-btn right-2" onClick={() => turnPage(1)} disabled={atEnd} aria-label="Next page (→)"><Icon n="right" /></button>
          {rp.mode === 'rsvp' && <RSVP bookId={book.id} total={total} startPage={page} wpm={rp.rsvpWpm} chunk={rp.rsvpChunk} pausePunct={rp.rsvpPause} orp={rp.rsvpOrp} onSet={setRp} onClose={(pg) => { setRp({ mode: 'deep' }); goPage(pg); }} onWords={(w) => sess.addWords(w)} />}
          {rp.mode === 'sprint' && <SprintBar minutes={rp.sprintMinutes} wpm={rp.sprintWpm} onSet={setRp} getWords={sess.getWords} onRunning={setSprintRun} />}
          {rp.mode === 'skim' && <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 card px-3 py-1.5 text-[11px] text-[var(--ink2)] flex items-center gap-2" style={{ opacity: hideChrome ? 0 : 1, transition: 'opacity .6s' }}><button className="btn btn-ghost !py-0.5" onClick={() => chapterJump(-1)}>← chapter</button>First sentences are emphasised; hover a paragraph to read it fully<button className="btn btn-ghost !py-0.5" onClick={() => chapterJump(1)}>chapter →</button></div>}
          {zen && <button className="absolute top-3 right-3 z-20 btn text-xs" style={{ opacity: hideChrome ? 0 : 0.9, transition: 'opacity .6s' }} onClick={() => setZen(false)}>Exit zen (Esc)</button>}
        </div>

        {rightOpen && !zen && <RightPanel book={book} page={page} text={row?.text ?? ''} annots={annots} goPage={goPage} chapterIdx={chIdx} className="max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:shadow-xl" />}
      </div>

      <footer className={`group shrink-0 flex items-center gap-3 px-3 ${isEpub ? 'h-12' : `border-t border-[var(--line)] bg-[var(--panel)] ${spread ? 'h-12' : 'h-11'}`}`} style={{ opacity: hideChrome ? 0.25 : 1, transition: 'opacity .6s', ...(zen ? { display: 'none' } : {}) }}>
        {!isEpub && <button className="btn btn-ghost" onClick={() => turnPage(-1)} disabled={atStart} aria-label="Previous page"><Icon n="left" /></button>}
        {histN > 0 && <button className="btn btn-ghost text-xs whitespace-nowrap" onClick={goBack} title="Back to where you were (Backspace)">↩ Back</button>}
        {isEpub ? (
          <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-1">
            <input type="range" min={1} max={total} value={page} onChange={(e) => jumpTo(Number(e.target.value))} className="w-full max-w-md h-1 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity accent-[var(--ink3)]" aria-label="Page slider" />
            <div className="text-[11px] tabular-nums select-none" style={{ color: PAPER[prefs.theme].dim }}>Page {page} of {total}</div>
          </div>
        ) : spread && st ? (() => {
          const fmtMin = (m: number) => (m >= 90 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.max(1, Math.round(m))} min`);
          const at = stAt.current; const nextStart = book.chapters.find((ch) => ch.start_page > page)?.start_page; const chLeft = at ? Math.max(0, (nextStart ? at(nextStart) : st.total + 1) - (st.printed + 2)) : 0;
          const minsLeft = words.rest / wpmRef.current; const pct = Math.min(100, Math.round((st.printed / Math.max(1, st.total)) * 100));
          return (
            <div className="flex-1 min-w-0">
              <div className="relative h-1.5 rounded-full bg-[var(--panel2)] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Book progress"><div className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)] transition-all duration-500" style={{ width: pct + '%' }} />{book.chapters.slice(1).map((ch) => at ? <span key={ch.idx} className="absolute top-0 bottom-0 w-px bg-[var(--bg)]" style={{ left: Math.min(99, (at(ch.start_page) / Math.max(1, st.total)) * 100) + '%' }} /> : null)}</div>
              <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-[var(--ink2)] whitespace-nowrap overflow-hidden">
                <span><b className="text-[var(--ink)] tabular-nums">Page {st.printed}</b> of {st.total}{st.exact ? '' : '…'} · {pct}%</span>
                <span className="hidden sm:inline">{chLeft > 0 ? `${chLeft} page${chLeft === 1 ? '' : 's'} to the end of this chapter` : 'Last pages of this chapter'}</span>
                <span className="hidden md:inline" title="Estimate from your measured reading speed">≈ {fmtMin(minsLeft)} left in the book</span>
              </div>
            </div>
          );
        })() : (<>
          <input type="range" min={1} max={total} value={page} onChange={(e) => jumpTo(Number(e.target.value))} className="flex-1 accent-[var(--accent)]" aria-label="Page slider" />
          <form onSubmit={(e) => { e.preventDefault(); const v = Number((e.currentTarget.elements.namedItem('pg') as HTMLInputElement).value); if (v) jumpTo(v); }} className="text-xs text-[var(--ink2)] flex items-center gap-1">
            <input name="pg" key={page} defaultValue={page} className="input !w-14 !py-1 text-center" aria-label="Go to page" /> / {total} <span className="hidden sm:inline">· {Math.round((page / total) * 100)}%</span>
          </form>
        </>)}
        <span className="hidden md:flex items-center gap-3 text-[11px] text-[var(--ink2)] whitespace-nowrap">
          <SessionClock limitMin={rp.sessionMinutes} breakEvery={rp.breakEvery} getActive={sess.getActive} say={say} />
          {!isEpub && <span title="Reading time today">{Math.floor(sess.today.secs / 60)} min today</span>}
          {!isEpub && sess.streak > 1 && <span title="Consecutive days with reading (rest days never break it)">{sess.streak}-day streak</span>}
        </span>
        {!isEpub && <button className="btn btn-ghost" onClick={() => turnPage(1)} disabled={atEnd} aria-label="Next page"><Icon n="right" /></button>}
      </footer>

      {rp.brightness < 1 && <div className="reading-brightness" style={{ opacity: 1 - rp.brightness }} aria-hidden />}
      {calibrating && <Calibrate text={row?.text ?? ''} onDone={(w) => { wpmRef.current = w; try { localStorage.setItem('folio.wpm', String(w)); } catch { /* */ } setRp({ wpm: w, sprintWpm: w }); }} onClose={() => setCalibrating(false)} />}
      {offer && !selection && <RecallBanner label={offer.label} busy={offerBusy} onStart={() => startRecall(offer.from, offer.to)} onLater={() => { setOffer(null); readFrom.current = page; }} onSkip={() => { void post('/recall/skip', { bookId, from: offer.from, to: offer.to }).catch(() => {}); setOffer(null); readFrom.current = null; }} />}

      {selection?.rect && !hlPop && (
        <div className="fixed z-40 card flex items-center gap-1 p-1 shadow-xl fade-in" style={{ left: Math.max(8, Math.min(selection.rect.x - 150, window.innerWidth - 320)), top: Math.max(8, selection.rect.y - 48) }} onMouseDown={(e) => e.preventDefault()} role="toolbar" aria-label="Selection actions">
          {COLORS.map((c) => <button key={c} onClick={() => highlight(c)} className={`w-5 h-5 rounded-full border border-[var(--line)] hl-${c}`} style={{ background: `var(--hl-${c[0]})` }} aria-label={`Highlight ${c}`} />)}
          <span className="w-px h-5 bg-[var(--line)] mx-1" />
          <button className="btn btn-ghost !px-2" onClick={() => setRightTab('word')}>Define</button>
          <button className="btn btn-ghost !px-2" onClick={() => setRightTab('ask')}>Ask</button>
          <button className="btn btn-ghost !px-2" onClick={() => setRightTab('notes')}>Note</button>
          <button className="btn btn-ghost !px-2" onClick={() => { reader.accent = ''; void reader.play(book.id, selection.page, 'sentence', { engine: 'browser', startOffset: Math.max(0, selection.start ?? 0) }); }} aria-label="Listen"><Icon n="sound" /></button>
        </div>
      )}
      {selection?.rect && !hlPop && /^\S+$/.test(selection.text.trim()) && cleanWord(selection.text).length > 1 && (
        <WordPop word={cleanWord(selection.text)} rect={selection.rect} bookId={book.id} page={selection.page} sentence={selection.sentence} onMore={() => { setRightOpen(true); setRightTab('word'); }} onClose={() => { window.getSelection()?.removeAllRanges(); setSelection(null); }} />
      )}
      {hlPop && (
        <div className="fixed z-40 card p-1 flex gap-1 shadow-xl fade-in" style={{ left: Math.max(8, hlPop.x - 90), top: Math.max(8, hlPop.y - 44) }}>
          {COLORS.map((c) => <button key={c} onClick={async () => { await patch(`/highlights/${hlPop.id}`, { color: c }); setHlPop(null); bump(); }} className="w-5 h-5 rounded-full border border-[var(--line)] my-auto" style={{ background: `var(--hl-${c[0]})` }} aria-label={c} />)}
          <button className="btn btn-ghost !px-2" onClick={async () => { const n = prompt('Annotation'); if (n !== null) await patch(`/highlights/${hlPop.id}`, { note: n }); setHlPop(null); bump(); }}>Note</button>
          <button className="btn btn-ghost !px-2" style={{ color: 'var(--danger)' }} onClick={async () => { await del(`/highlights/${hlPop.id}`); setHlPop(null); bump(); }}><Icon n="trash" size={14} /></button>
        </div>
      )}
    </div>
  );
}

function ModeMenu({ onCalibrate }: { onCalibrate: () => void }) {
  const { p, set } = useRead(); const [open, setOpen] = useState(false); const cur = MODES.find((m) => m.id === p.mode) ?? MODES[0];
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [open]);
  return (
    <div className="relative">
      <button className="btn btn-ghost text-xs" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" aria-label={`Reading style: ${cur.label}`} title="Reading style (1–6)"><Icon n="play" size={14} /> <span className="hidden md:inline">{cur.label}</span></button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-50 card w-72 p-1 shadow-xl fade-in">
          {MODES.map((m, i) => (
            <button key={m.id} role="menuitemradio" aria-checked={p.mode === m.id} onClick={() => { set({ mode: m.id }); setOpen(false); }} className={`w-full text-left px-3 py-2 rounded-md hover:bg-[var(--panel2)] flex items-start gap-2 ${p.mode === m.id ? 'bg-[var(--panel2)]' : ''}`}>
              <kbd className="text-[10px] text-[var(--ink3)] mt-0.5 font-mono">{i + 1}</kbd><span><span className="block text-sm font-medium">{m.label}</span><span className="block text-[11px] text-[var(--ink3)] leading-snug">{m.hint}</span></span>
            </button>
          ))}
          <div className="border-t border-[var(--line)] mt-1 pt-1 px-2 pb-1 flex items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5 flex-1"><input type="checkbox" checked={p.pacer} onChange={(e) => set({ pacer: e.target.checked })} className="accent-[var(--accent)]" /> Pacer <span className="text-[var(--ink3)]">{p.wpm} wpm</span></label>
            <button className="btn btn-ghost !py-0.5 text-[11px]" onClick={() => { setOpen(false); onCalibrate(); }}>Measure speed</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Session timer and break reminder: only visible when you turned them on, and never a modal. */
function SessionClock({ limitMin, breakEvery, getActive, say }: { limitMin: number; breakEvery: number; getActive: () => number; say: (m: string) => void }) {
  const [s, setS] = useState(0); const start = useRef(getActive()); const done = useRef(false); const lastBreak = useRef(0);
  useEffect(() => { start.current = getActive(); done.current = false; lastBreak.current = 0; }, [limitMin, breakEvery]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setInterval(() => {
      const a = getActive() - start.current; setS(a);
      if (limitMin && !done.current && a >= limitMin * 60) { done.current = true; say(`Session complete — ${limitMin} minutes of reading.`); }
      if (breakEvery && a - lastBreak.current >= breakEvery * 60) { lastBreak.current = a; say('Time for a short break: rest your eyes on something far away for 20 seconds.'); }
    }, 1000);
    return () => clearInterval(id);
  }, [limitMin, breakEvery, getActive, say]);
  if (!limitMin) return null; const left = Math.max(0, limitMin * 60 - s);
  return <span className="tabular-nums" title="Session timer (counts active reading only)">{left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'session complete'}</span>;
}

export type { RightTab };
