'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, post, put, del, patch } from '@/lib/api';
import { useStore, type RightTab } from '@/lib/store';
import { Icon, Spinner, ErrorNote } from '../ui';
import { TextPage, type Hl } from './TextPage';
import { PdfPage } from './PdfPage';
import { RightPanel } from './Panels';
import { OcrBar } from './OcrBar';
import { BilingualPage } from '../Lang';
import { RecallBanner } from '../Recall';
import { getLang, detectLanguage, fontFor, isRtl } from '@/lib/lang/registry';
import { reader } from '@/lib/tts';

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
  const [textView, setTextView] = useState(false);
  useEffect(() => { try { setTextView(localStorage.getItem('folio.pdftext') === '1'); } catch { /* */ } }, []);
  const [ocrTick, setOcrTick] = useState(0);
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
      requestAnimationFrame(() => { ready.current = true; if (!jumping && b.progress?.scroll && center.current) center.current.scrollTop = b.progress.scroll * center.current.scrollHeight; });
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
    void put(`/books/${bookId}/progress`, { page, scroll: el && el.scrollHeight ? el.scrollTop / el.scrollHeight : 0 }).catch(() => {});
  }, [bookId, page]);
  useEffect(() => { const t = setTimeout(saveProgress, 500); pagesTurned.current++; return () => clearTimeout(t); }, [saveProgress]);
  useEffect(() => {
    const h = () => { if (document.visibilityState === 'hidden') saveProgress(); };
    document.addEventListener('visibilitychange', h); window.addEventListener('beforeunload', saveProgress);
    return () => { document.removeEventListener('visibilitychange', h); window.removeEventListener('beforeunload', saveProgress); };
  }, [saveProgress]);
  useEffect(() => () => {
    if (!bookId) return;
    const seconds = Math.round((Date.now() - startedAt.current) / 1000);
    if (seconds > 5) void post('/sessions', { bookId, seconds, pages: Math.max(0, pagesTurned.current - 1) }).catch(() => {});
  }, [bookId]);

  // ── active recall: configurable triggers (READ → CLOSE → RECALL). Never blocks reading; skips are recorded separately. ──
  const rs = useRef<any>(null); const readFrom = useRef<number | null>(null); const lastPage = useRef<number | null>(null); const hard = useRef<Record<number, boolean>>({});
  const [offer, setOffer] = useState<{ from: number; to: number; label: string } | null>(null); const [offerBusy, setOfferBusy] = useState(false);
  useEffect(() => { api('/recall/settings').then((s) => { rs.current = s; }).catch(() => {}); }, [bookId]);
  useEffect(() => { if (row) hard.current[page] = disc.length >= 5 || (row.text.match(/=/g) ?? []).length >= 2; }, [row, disc, page]);
  useEffect(() => {
    if (!book) return; const s = rs.current; const last = lastPage.current; lastPage.current = page;
    if (last == null || page - last !== 1) { readFrom.current = page; return; } // jumps restart the count
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
  const goPage = useCallback((p: number) => { const n = Math.min(Math.max(1, p), total); if (n !== page) { reader?.stop(); setSelection(null); setPage(n); center.current?.scrollTo({ top: 0 }); } }, [page, total, setPage, setSelection]);

  // keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); goPage(page + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPage(page - 1); }
      else if (e.key === 'f') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); }
      else if (e.key === 'b') toggleBookmark();
      else if (e.key === '/') { e.preventDefault(); setLeftOpen(true); setLeftTab('search'); setTimeout(() => document.getElementById('book-search')?.focus(), 50); }
      else if (e.key === ']') setRightOpen(!rightOpen);
      else if (e.key === '[') setLeftOpen(!leftOpen);
      else if (e.key === 'Escape') { setSelection(null); setHlPop(null); }
      else if (e.key === ' ' && useStore.getState().audio.engine) { e.preventDefault(); useStore.getState().audio.playing ? reader.pause() : reader.resume(); }
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
    await post(`/books/${bookId}/highlights`, { page: selection.page, text: selection.text, color, start: selection.start ?? null, end: selection.end ?? null });
    window.getSelection()?.removeAllRanges(); setSelection(null); bump();
  }

  const pageHl = useMemo(() => annots.highlights.filter((h) => h.page === page), [annots.highlights, page]);
  const onSelect = useCallback((s: { text: string; start: number; end: number; sentence: string; rect: DOMRect } | null) => {
    if (capTimer.current) clearTimeout(capTimer.current);
    if (!s) return setSelection(null);
    setHlPop(null);
    const st = useStore.getState();
    const pg = st.page;
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

  async function doSearch(v: string) { setQ(v); if (v.trim().length < 2 || !bookId) return setHits([]); setHits(await api(`/books/${bookId}/search?q=${encodeURIComponent(v)}`)); }

  if (error) return <div className="p-8 max-w-lg mx-auto"><ErrorNote error={error} /><button className="btn mt-3" onClick={() => go('home')}>Back to library</button></div>;
  if (!book) return <div className="p-8"><Spinner label="Opening…" /></div>;
  const chIdx = row?.chapter_idx ?? 0;
  const fontFamily = prefs.font === 'serif' ? 'Georgia, "Iowan Old Style", "Palatino Linotype", serif' : prefs.font === 'sans' ? 'ui-sans-serif, system-ui, "Segoe UI", sans-serif' : 'ui-monospace, Consolas, monospace';
  const isPdf = book.format === 'pdf';
  const showPdf = isPdf && !textView;

  return (
    <div className="h-screen flex flex-col" style={{ ['--book-font' as any]: fontFamily, ['--book-size' as any]: `${prefs.size}px`, ['--book-lh' as any]: prefs.lineHeight }}>
      <header className="h-12 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--line)] bg-[var(--panel)]">
        <button className="btn btn-ghost" onClick={leave} aria-label="Back to library"><Icon n="left" /> <span className="hidden sm:inline">Library</span></button>
        <button className="btn btn-ghost" onClick={() => setLeftOpen(!leftOpen)} aria-label="Toggle contents ([)"><Icon n="menu" /></button>
        <div className="min-w-0 flex-1 text-center"><div className="text-sm font-medium truncate">{book.title}</div><div className="text-[11px] text-[var(--ink3)] truncate">{book.chapters[chIdx]?.title}</div></div>
        <select className="input !w-auto !py-1 !text-xs hidden md:block" value={readingMode} onChange={(e) => { setReadingMode(e.target.value); if (e.target.value !== 'normal') setRightTab('understand'); }} aria-label="Reading mode" title="Reading mode — changes what the companion looks for; the document itself is never altered">
          {[['normal', 'Normal'], ['learning', 'Learning'], ['deep', 'Deep understanding'], ['critical', 'Critical thinking'], ['exam', 'Exam'], ['research', 'Research'], ['goal', 'Goal'], ['language', 'Language learning']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className={`btn btn-ghost text-xs ${transMode !== 'original' ? '!text-[var(--accent)]' : ''}`} title="Translate this book (original → bilingual → translated)" onClick={() => { const next = transMode === 'original' ? 'bilingual' : transMode === 'bilingual' ? 'translated' : 'original'; setTrans({ transMode: next }); if (next !== 'original') setRightTab('translate'); }} aria-label="Translation mode"><Icon n="type" size={15} /> {transMode === 'original' ? 'Translate' : transMode === 'bilingual' ? `Bilingual · ${transTgt}` : `${transTgt}`}</button>
        {isPdf && <button className="btn btn-ghost text-xs" aria-pressed={textView} title="Switch between the original PDF page and reflowed text (better for scans/odd fonts)" onClick={() => { const v = !textView; setTextView(v); try { localStorage.setItem('folio.pdftext', v ? '1' : '0'); } catch { /* */ } }}>{textView ? 'PDF view' : 'Text view'}</button>}
        <TypeMenu isPdf={showPdf} zoom={zoom} setZoom={setZoom} />
        <button className="btn btn-ghost text-xs" onClick={() => startRecall(page, page)} disabled={offerBusy} title="Close the book and test yourself on this page" aria-label="Recall this page"><Icon n="cards" size={15} /> <span className="hidden md:inline">Recall</span></button>
        <button className="btn btn-ghost" onClick={toggleBookmark} aria-label="Bookmark page (b)" aria-pressed={!!bookmarked}><Icon n="bookmark" className={bookmarked ? 'fill-current text-[var(--accent)]' : ''} /></button>
        <button className="btn btn-ghost hidden sm:inline-flex" onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()} aria-label="Fullscreen (f)"><Icon n="full" /></button>
        <button className="btn btn-ghost" onClick={() => setRightOpen(!rightOpen)} aria-label="Toggle companion (])"><Icon n="sparkle" /></button>
      </header>

      <div className="flex-1 flex min-h-0 relative">
        {leftOpen && (
          <aside className="w-64 shrink-0 border-r border-[var(--line)] bg-[var(--panel)] flex flex-col max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:shadow-xl" aria-label="Book navigation">
            <div className="flex border-b border-[var(--line)] text-xs">
              {([['toc', 'Contents'], ['marks', 'Marks'], ['search', 'Search']] as const).map(([k, l]) => <button key={k} onClick={() => setLeftTab(k)} className={`flex-1 py-2.5 ${leftTab === k ? 'font-semibold border-b-2 border-[var(--accent)]' : 'text-[var(--ink2)]'}`}>{l}</button>)}
            </div>
            <div className="flex-1 overflow-auto p-2 text-sm">
              {leftTab === 'toc' && book.chapters.map((c) => (
                <button key={c.idx} onClick={() => goPage(c.start_page)} className={`w-full text-left px-2 py-1.5 rounded-md hover:bg-[var(--panel2)] flex justify-between gap-2 ${c.idx === chIdx ? 'bg-[var(--panel2)] font-medium' : ''}`}><span className="truncate">{c.title}</span><span className="text-[var(--ink3)] text-xs">{c.start_page}</span></button>
              ))}
              {leftTab === 'marks' && (
                <div className="space-y-3">
                  <div><div className="label mb-1 px-1">Bookmarks</div>{annots.bookmarks.length === 0 && <div className="text-xs text-[var(--ink3)] px-1">Press B to bookmark this page.</div>}{annots.bookmarks.map((b) => <button key={b.id} onClick={() => goPage(b.page)} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[var(--panel2)] flex justify-between"><span>{b.label || `Page ${b.page}`}</span><span className="text-xs text-[var(--ink3)]">{b.page}</span></button>)}</div>
                  <div><div className="label mb-1 px-1">Highlights</div>{annots.highlights.length === 0 && <div className="text-xs text-[var(--ink3)] px-1">Select text to highlight it.</div>}{annots.highlights.map((h) => <button key={h.id} onClick={() => goPage(h.page)} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[var(--panel2)]"><mark className={`hl hl-${h.color} text-xs line-clamp-3`}>{h.text}</mark><div className="text-[10px] text-[var(--ink3)] mt-0.5">p. {h.page}{h.note ? ` · ${h.note}` : ''}</div></button>)}</div>
                </div>
              )}
              {leftTab === 'search' && (
                <div><input id="book-search" className="input" placeholder="Search in book ( / )" value={q} onChange={(e) => void doSearch(e.target.value)} />
                  <div className="mt-2 space-y-1">{hits.map((h, i) => <button key={i} onClick={() => goPage(h.page)} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[var(--panel2)] text-xs"><span className="font-semibold">p. {h.page}</span> {h.snippet}</button>)}{q.length > 1 && hits.length === 0 && <div className="text-xs text-[var(--ink3)] px-1">No matches.</div>}</div></div>
              )}
            </div>
          </aside>
        )}

        <main ref={center} className="flex-1 overflow-auto bg-[var(--page)] relative" onScroll={() => { setHlPop(null); }} id="reader-scroll">
          {book.status === 'readable' && <div className="sticky top-0 z-10 text-center text-xs py-1 bg-[var(--panel2)] text-[var(--ink2)]">{book.status_detail ?? 'Indexing for search and AI…'} You can keep reading.</div>}
          <div className="mx-auto px-5 py-8 md:py-12" style={{ maxWidth: showPdf ? undefined : prefs.width + 40 }}>
            {!row ? <Spinner /> : showPdf
              ? <>
                <PdfPage bookId={book.id} page={page} zoom={zoom} pageText={row.text} highlights={pageHl} onSelect={onSelect} onHighlightClick={onHighlightClick} jump={jumpHere} />
                <OcrBar bookId={book.id} page={page} pageHasText={!!row.text.trim()} onDone={() => setOcrTick((n) => n + 1)} />
              </>
                    : transMode !== 'original' && row.text.trim() ? <BilingualPage key={`${page}-${transTgt}-${transMode}`} bookId={book.id} page={page} text={row.text} tgt={transTgt} mode={transMode} layout={transLayout} srcLang={book.language && getLang(book.language) ? getLang(book.language)!.code : detectLanguage(row.text).code} onSelect={onSelect} />
      : <TextPage key={page} page={page} text={row.text} highlights={pageHl} onSelect={onSelect} onHighlightClick={onHighlightClick} searchTerm={leftTab === 'search' ? q : undefined} hints={hints} jump={jumpHere} onHintClick={onHintClick} />}
          </div>
        </main>

        {rightOpen && <RightPanel book={book} page={page} text={row?.text ?? ''} annots={annots} goPage={goPage} chapterIdx={chIdx} className="max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:shadow-xl" />}
      </div>

      <footer className="h-11 shrink-0 flex items-center gap-3 px-3 border-t border-[var(--line)] bg-[var(--panel)]">
        <button className="btn btn-ghost" onClick={() => goPage(page - 1)} disabled={page <= 1} aria-label="Previous page"><Icon n="left" /></button>
        <input type="range" min={1} max={total} value={page} onChange={(e) => goPage(Number(e.target.value))} className="flex-1 accent-[var(--accent)]" aria-label="Page slider" />
        <form onSubmit={(e) => { e.preventDefault(); const v = Number((e.currentTarget.elements.namedItem('pg') as HTMLInputElement).value); if (v) goPage(v); }} className="text-xs text-[var(--ink2)] flex items-center gap-1">
          <input name="pg" key={page} defaultValue={page} className="input !w-14 !py-1 text-center" aria-label="Go to page" /> / {total} <span className="hidden sm:inline">· {Math.round((page / total) * 100)}%</span>
        </form>
        <button className="btn btn-ghost" onClick={() => goPage(page + 1)} disabled={page >= total} aria-label="Next page"><Icon n="right" /></button>
      </footer>
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

function TypeMenu({ isPdf, zoom, setZoom }: { isPdf: boolean; zoom: number; setZoom: (z: number) => void }) {
  const { prefs, setPrefs } = useStore();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button className="btn btn-ghost" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Reading settings"><Icon n="type" /></button>
      {open && (
        <div className="absolute right-0 top-10 z-40 card p-4 w-72 shadow-xl space-y-3 fade-in text-sm">
          <div className="flex gap-1">{(['light', 'sepia', 'dark'] as const).map((t) => <button key={t} onClick={() => setPrefs({ theme: t })} className={`btn flex-1 justify-center ${prefs.theme === t ? 'btn-primary' : ''}`}>{t}</button>)}</div>
          {isPdf ? (
            <label className="block"><span className="label">Zoom {Math.round(zoom * 100)}%</span><input type="range" min={0.6} max={2} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-full accent-[var(--accent)]" /></label>
          ) : (<>
            <div className="flex gap-1">{(['serif', 'sans', 'mono'] as const).map((f) => <button key={f} onClick={() => setPrefs({ font: f })} className={`btn flex-1 justify-center ${prefs.font === f ? 'btn-primary' : ''}`}>{f}</button>)}</div>
            <label className="block"><span className="label">Size {prefs.size}px</span><input type="range" min={14} max={32} value={prefs.size} onChange={(e) => setPrefs({ size: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></label>
            <label className="block"><span className="label">Line spacing {prefs.lineHeight.toFixed(1)}</span><input type="range" min={1.2} max={2.4} step={0.1} value={prefs.lineHeight} onChange={(e) => setPrefs({ lineHeight: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></label>
            <label className="block"><span className="label">Width {prefs.width}px</span><input type="range" min={420} max={1000} step={20} value={prefs.width} onChange={(e) => setPrefs({ width: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></label>
          </>)}
          <p className="text-[11px] text-[var(--ink3)]">Keys: ← → pages · B bookmark · / search · F fullscreen · [ ] panels · Space audio</p>
        </div>
      )}
    </div>
  );
}

export type { RightTab };
