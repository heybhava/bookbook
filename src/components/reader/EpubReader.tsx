'use client';
// The real book. Renders the original EPUB (publisher CSS, fonts, images, covers) with epub.js, paginated like Apple Books:
// one page, or two facing pages on a wide window. The extracted-text "page" the rest of the app uses (notes, AI, audio,
// bookmarks) is kept in step through the book's reading position, so citations such as "p. 57" still mean something.
import { useEffect, useRef, useState } from 'react';
import { useEpubPrefs } from '@/lib/epubPrefs';
import { FAMILIES } from '@/lib/readPrefs';
import { Spinner, ErrorNote } from '../ui';

export type PaperTheme = 'light' | 'dark' | 'sepia';
export const PAPER: Record<PaperTheme, { bg: string; ink: string; link: string; sel: string; dim: string }> = {
  light: { bg: '#ffffff', ink: '#1c1c1e', link: '#0a60ff', sel: 'rgba(10,96,255,.22)', dim: '#8e8e93' },
  sepia: { bg: '#f7f0df', ink: '#40342a', link: '#9a5b13', sel: 'rgba(154,91,19,.22)', dim: '#9b8c75' },
  dark: { bg: '#1c1c1e', ink: '#e2e2e6', link: '#6cb2ff', sel: 'rgba(108,178,255,.32)', dim: '#7c7c82' },
};
const HL: Record<string, string> = { yellow: '#ffd60a', green: '#30d158', blue: '#0a84ff', pink: '#ff375f', orange: '#ff9f0a' };

export interface TocItem { label: string; href: string; depth: number; index: number }
export interface EpubHl { id: string; color: string; cfi: string }
export interface EpubApi {
  next(): void; prev(): void;
  goHref(href: string): void; goCfi(cfi: string): void;
  search(q: string): Promise<{ cfi: string; excerpt: string }[]>;
  selectionCfi(): string | null; clearSelection(): void;
}
export interface EpubSel { text: string; start: number; end: number; sentence: string; rect: DOMRect }
interface Props {
  bookId: string; total: number; page: number; onPage: (n: number) => void;
  theme: PaperTheme; size: number; pageText: string;
  highlights: EpubHl[];
  onSelect: (s: EpubSel | null) => void;
  onHighlightClick: (id: string, r: DOMRect) => void;
  apiRef: React.MutableRefObject<EpubApi | null>;
  onToc: (t: TocItem[]) => void; onSection: (index: number) => void;
  jump?: { text?: string; page: number; nonce: number } | null;
}

function skinCss(theme: PaperTheme, font: string | null) {
  const c = PAPER[theme]; const recolor = theme !== 'light';
  return `
html, body { background: ${c.bg} !important; }
${recolor ? `body, body *:not(svg):not(svg *) { color: ${c.ink} !important; background-color: transparent !important; border-color: ${c.dim} !important; }
a, a * { color: ${c.link} !important; }` : ''}
${font ? `body, body *:not(pre):not(code):not(kbd):not(samp):not(svg):not(svg *) { font-family: ${font} !important; }` : ''}
::selection { background: ${c.sel}; }
img, svg, video { max-width: 100% !important; max-height: 96vh !important; object-fit: contain; }
body { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; overflow-wrap: break-word; -webkit-hyphens: auto; hyphens: auto; }
`;
}

/** The sentence around a selection, taken from its enclosing block. */
function sentenceOf(range: Range, text: string) {
  let el: Node | null = range.commonAncestorContainer; while (el && el.nodeType !== 1) el = el.parentNode;
  const block = ((el as Element | null)?.closest?.('p,li,blockquote,div,h1,h2,h3,h4,td') ?? el) as Element | null;
  const full = (block?.textContent ?? text).replace(/\s+/g, ' ').trim(); const q = text.replace(/\s+/g, ' ').trim();
  const i = full.indexOf(q); if (i < 0) return q;
  const a = Math.max(full.lastIndexOf('. ', i), full.lastIndexOf('! ', i), full.lastIndexOf('? ', i)) + 1;
  const m = /[.!?]["”’)]*(\s|$)/g; m.lastIndex = i + q.length; const e = m.exec(full);
  return full.slice(a, e ? e.index + e[0].trimEnd().length : full.length).trim() || q;
}

export function EpubReader(props: Props) {
  const { bookId, total } = props;
  const wrap = useRef<HTMLDivElement>(null); const host = useRef<HTMLDivElement>(null);
  const P = useRef(props); P.current = props;
  const prefs = useEpubPrefs((s) => s.p); const prefsR = useRef(prefs); prefsR.current = prefs;
  const [err, setErr] = useState<string | null>(null); const [ready, setReady] = useState(false);
  const [w, setW] = useState(0);
  const R = useRef<{ bk: any; rend: any; locs: boolean; last: number; busy: boolean; busyAt: number; sel: string | null; applied: Map<string, string> }>({ bk: null, rend: null, locs: false, last: -1, busy: false, busyAt: 0, sel: null, applied: new Map() });

  useEffect(() => { const el = wrap.current; if (!el) return; const ro = new ResizeObserver(() => setW(el.clientWidth)); ro.observe(el); setW(el.clientWidth); return () => ro.disconnect(); }, []);
  // Apple Books lays a landscape iPad out as two pages of about 520 px; a narrow window gets one comfortable column
  const spreadOn = prefs.flow === 'paged' && prefs.twoPage && w >= 880;
  const hostW = prefs.flow === 'scroll' ? Math.min(w, 760) : spreadOn ? Math.min(w, 1120) : Math.min(w, 660);

  // current look, shared by every section as it is rendered
  const skinRef = useRef(''); const fontStack = prefs.font === 'original' ? null : FAMILIES[prefs.font].stack;
  skinRef.current = skinCss(props.theme, fontStack);

  const pageOf = (pct: number) => Math.min(P.current.total, Math.max(1, Math.round(pct * (P.current.total - 1)) + 1));
  const pctOf = (page: number) => (page - 1) / Math.max(1, P.current.total - 1);

  async function showPct(pct: number) {
    const { bk, rend } = R.current; if (!bk || !rend) return;
    try {
      if (R.current.locs) { const cfi = bk.locations.cfiFromPercentage(Math.min(0.9999, Math.max(0, pct))); if (cfi) return void (await rend.display(cfi)); }
      const n = bk.spine.length; const it = bk.spine.get(Math.min(n - 1, Math.floor(pct * n))); if (it) await rend.display(it.href);
    } catch { /* a bad target leaves the reader where it is */ }
  }

  // ── open the book ──
  useEffect(() => {
    let dead = false; setErr(null); setReady(false);
    const ckey = 'folio.epubcfi.' + bookId, lkey = 'folio.epubloc.' + bookId;
    (async () => {
      try {
        const [mod, res] = await Promise.all([import('epubjs'), fetch(`/api/books/${bookId}/file`)]);
        if (!res.ok) throw new Error('The book file could not be loaded.');
        const buf = await res.arrayBuffer(); if (dead || !host.current) return;
        const ePub: any = (mod as any).default ?? mod;
        const bk = ePub(buf, { replacements: 'blobUrl' });
        const rend = bk.renderTo(host.current, { width: '100%', height: '100%', flow: prefsR.current.flow === 'scroll' ? 'scrolled-doc' : 'paginated', spread: prefsR.current.twoPage ? 'auto' : 'none', minSpreadWidth: 880, allowScriptedContent: false });
        R.current.bk = bk; R.current.rend = rend; R.current.locs = false; R.current.last = -1;

        const setSkin = (c: any) => { const d = c.document; let s = d.getElementById('folio-skin'); if (!s) { s = d.createElement('style'); s.id = 'folio-skin'; d.head.appendChild(s); } s.textContent = skinRef.current; };
        rend.hooks.content.register((contents: any) => {
          setSkin(contents); const doc: Document = contents.document; const frame = () => doc.defaultView?.frameElement as HTMLElement | null;
          doc.addEventListener('keydown', (e) => { // the iframe swallows keys, so hand them to the reader's shortcuts
            if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', ' ', 'Home', 'End'].includes(e.key)) e.preventDefault();
            window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true }));
          });
          doc.addEventListener('mousedown', () => P.current.onSelect(null));
          doc.addEventListener('click', (e) => {
            const a = (e.target as Element).closest?.('a[href]');
            if (a) { const h = a.getAttribute('href') ?? ''; if (/^(https?:|mailto:)/i.test(h)) { e.preventDefault(); window.open(h, '_blank', 'noopener'); } return; }
            const s = doc.getSelection(); if (s && !s.isCollapsed) return;
            if (prefsR.current.flow !== 'paged') return;
            const f = frame(), hr = host.current?.getBoundingClientRect(); if (!f || !hr) return;
            const rel = (f.getBoundingClientRect().left + e.clientX - hr.left) / Math.max(1, hr.width); // tap an outer edge to turn, like the iPad
            if (rel < 0.2) turn(-1); else if (rel > 0.8) turn(1);
          });
          let sx = 0, sy = 0;
          doc.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
          doc.addEventListener('touchend', (e) => {
            if (prefsR.current.flow !== 'paged') return; const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.6 && doc.getSelection()?.isCollapsed !== false) turn(dx < 0 ? 1 : -1);
          }, { passive: true });
          let acc = 0, lock = 0; // wheel / trackpad swipe turns the page
          doc.addEventListener('wheel', (e) => {
            if (prefsR.current.flow !== 'paged') return; e.preventDefault(); if (Date.now() < lock) return;
            acc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            if (Math.abs(acc) > 50) { const d = acc > 0 ? 1 : -1; acc = 0; lock = Date.now() + 450; turn(d); }
          }, { passive: false });
        });

        rend.on('relocated', (loc: any) => {
          const cfi: string | undefined = loc?.start?.cfi; if (!cfi) return;
          try { localStorage.setItem(ckey, cfi); } catch { /* */ }
          let pct: number | null = null;
          if (R.current.locs) { try { pct = bk.locations.percentageFromCfi(cfi); } catch { /* */ } }
          if (pct == null || Number.isNaN(pct)) { const d = loc.start.displayed ?? { page: 1, total: 1 }; pct = (loc.start.index + (d.page - 1) / Math.max(1, d.total)) / Math.max(1, bk.spine.length); }
          const n = pageOf(pct); R.current.last = n; P.current.onPage(n); P.current.onSection(loc.start.index);
        });
        rend.on('selected', (cfiRange: string, contents: any) => {
          const range: Range | null = rend.getRange(cfiRange); const text = range?.toString().replace(/\s+/g, ' ').trim(); if (!range || !text) return;
          R.current.sel = cfiRange;
          const fr = (contents.document.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect(); const rr = range.getBoundingClientRect(); if (!fr) return;
          const pt = P.current.pageText; const at = pt.replace(/\s+/g, ' ').indexOf(text); const start = at >= 0 ? at : 0;
          P.current.onSelect({ text, start, end: start + text.length, sentence: sentenceOf(range, text), rect: new DOMRect(fr.left + rr.left, fr.top + rr.top, rr.width, rr.height) });
        });

        api(bk, rend);
        bk.loaded.navigation.then((nav: any) => {
          const out: TocItem[] = []; const walk = (items: any[], depth: number) => items?.forEach((it) => { const sec = bk.spine.get(String(it.href).split('#')[0]); out.push({ label: String(it.label).replace(/\s+/g, ' ').trim(), href: it.href, depth, index: sec?.index ?? 0 }); if (it.subitems?.length) walk(it.subitems, depth + 1); });
          walk(nav.toc, 0); if (!dead) P.current.onToc(out);
        }).catch(() => {});

        // where to open: a jump from a note, else the exact place you left, else the page the library remembers
        const saved = (() => { try { return localStorage.getItem(ckey); } catch { return null; } })();
        const cached = (() => { try { return localStorage.getItem(lkey); } catch { return null; } })();
        await bk.ready; if (dead) return;
        if (cached) { try { bk.locations.load(cached); R.current.locs = true; } catch { /* regenerate below */ } }
        const j = P.current.jump;
        if (j?.text) { const hit = await findText(j.text); if (hit) await rend.display(hit); else await showAfterLocs(); }
        else if (saved) await rend.display(saved).catch(() => rend.display());
        else await showAfterLocs();
        if (dead) return; setReady(true);
        if (!R.current.locs) {
          await bk.locations.generate(1500); if (dead) return; R.current.locs = true;
          try { localStorage.setItem(lkey, bk.locations.save()); } catch { /* too large to cache: regenerated next time */ }
          const cur = rend.currentLocation?.(); const cfi = cur?.start?.cfi; if (cfi) { const n = pageOf(bk.locations.percentageFromCfi(cfi)); R.current.last = n; P.current.onPage(n); }
        }
      } catch (e: any) { if (!dead) setErr(e?.message ?? 'This book could not be opened.'); }
    })();
    async function showAfterLocs() {
      const pg = P.current.page;
      if (pg > 1 && !R.current.locs) { await R.current.bk.locations.generate(1500); R.current.locs = true; try { localStorage.setItem(lkey, R.current.bk.locations.save()); } catch { /* */ } }
      if (pg > 1) await showPct(pctOf(pg)); else await R.current.rend.display();
    }
    return () => { dead = true; try { R.current.rend?.destroy(); R.current.bk?.destroy(); } catch { /* */ } R.current.rend = null; R.current.bk = null; R.current.applied.clear(); };
  }, [bookId]); // eslint-disable-line react-hooks/exhaustive-deps

  // text search through the whole book, as exact locations
  async function findText(q: string): Promise<string | null> { const r = await search(q, 1); return r[0]?.cfi ?? null; }
  async function search(q: string, max = 120) {
    const { bk } = R.current; const out: { cfi: string; excerpt: string }[] = []; if (!bk || q.trim().length < 2) return out;
    for (const s of (bk.spine as any).spineItems as any[]) {
      try { await s.load(bk.load.bind(bk)); const hits = s.find(q.trim()) as { cfi: string; excerpt: string }[]; for (const h of hits) out.push({ cfi: h.cfi, excerpt: h.excerpt.replace(/\s+/g, ' ').trim() }); s.unload(); } catch { /* unreadable section: skip */ }
      if (out.length >= max) break;
    }
    return out;
  }

  // page turns: the new page slides and fades in, like the iPad's. No timers are involved, so a turn can never get stuck.
  async function turn(dir: 1 | -1) {
    const r = R.current; if (!r.rend) return; const now = Date.now(); if (r.busy && now - r.busyAt < 1500) return; r.busy = true; r.busyAt = now;
    const el = host.current; const anim = !!el && prefsR.current.flow === 'paged' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (anim) { el!.style.transition = 'none'; el!.style.opacity = '0'; el!.style.transform = `translateX(${dir > 0 ? 18 : -18}px)`; }
    try { await (dir > 0 ? r.rend.next() : r.rend.prev()); } catch { /* end of the book */ }
    r.busy = false;
    if (el) { void el.offsetWidth; el.style.transition = anim ? 'opacity 180ms ease, transform 220ms cubic-bezier(.2,.7,.2,1)' : 'none'; el.style.opacity = '1'; el.style.transform = 'none'; }
  }
  function api(_bk: any, rend: any) {
    P.current.apiRef.current = {
      next: () => void turn(1), prev: () => void turn(-1),
      goHref: (h) => void rend.display(h).catch(() => {}), goCfi: (c) => void rend.display(c).catch(() => {}),
      search: (q) => search(q),
      selectionCfi: () => R.current.sel,
      clearSelection: () => { R.current.sel = null; for (const c of rend.getContents?.() ?? []) c.window?.getSelection()?.removeAllRanges(); },
    };
  }
  useEffect(() => () => { props.apiRef.current = null; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the app moved to another page (contents, slider, bookmark, search): follow it
  useEffect(() => {
    if (!ready || props.page === R.current.last) return; R.current.last = props.page; void showPct(pctOf(props.page));
  }, [props.page, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // look: theme, font, text size
  useEffect(() => {
    const { rend } = R.current; if (!rend || !ready) return;
    const cfi = rend.currentLocation?.()?.start?.cfi;
    for (const c of rend.getContents?.() ?? []) { const d = c.document; const s = d.getElementById('folio-skin'); if (s) s.textContent = skinRef.current; }
    rend.themes.fontSize(`${Math.round((props.size / 19) * 100)}%`);
    if (cfi) setTimeout(() => R.current.rend?.display(cfi).catch(() => {}), 60);
  }, [props.theme, prefs.font, props.size, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // paged or scrolling, one page or two
    const { rend } = R.current; if (!rend || !ready) return; const cfi = rend.currentLocation?.()?.start?.cfi;
    try { rend.flow(prefs.flow === 'scroll' ? 'scrolled-doc' : 'paginated'); rend.spread(prefs.twoPage ? 'auto' : 'none', 880); } catch { /* */ }
    if (cfi) setTimeout(() => R.current.rend?.display(cfi).catch(() => {}), 80);
  }, [prefs.flow, prefs.twoPage, ready]);
  useEffect(() => { const { rend } = R.current; if (rend && ready && hostW) { try { rend.resize('100%', '100%'); } catch { /* */ } } }, [hostW, ready]);

  // saved highlights drawn on the page itself
  useEffect(() => {
    const { rend, applied } = R.current; if (!rend || !ready) return; const want = new Map(props.highlights.map((h) => [h.id, h]));
    for (const [id, cfi] of [...applied]) if (!want.has(id)) { try { rend.annotations.remove(cfi, 'highlight'); } catch { /* */ } applied.delete(id); }
    for (const h of want.values()) {
      if (applied.get(h.id) === h.cfi) continue;
      const dark = props.theme === 'dark';
      try {
        rend.annotations.highlight(h.cfi, { id: h.id }, (e: MouseEvent) => {
          const t = e.target as Element; const fr = (t.ownerDocument.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect(); const r = t.getBoundingClientRect();
          P.current.onHighlightClick(h.id, new DOMRect((fr?.left ?? 0) + r.left, (fr?.top ?? 0) + r.top, r.width, r.height));
        }, 'folio-hl', { fill: HL[h.color] ?? HL.yellow, 'fill-opacity': dark ? '.38' : '.42', 'mix-blend-mode': dark ? 'normal' : 'multiply' });
        applied.set(h.id, h.cfi);
      } catch { /* the passage is not in a loaded section yet; it is drawn when the section renders */ }
    }
  }, [props.highlights, props.theme, ready]);

  const c = PAPER[props.theme];
  return (
    <div ref={wrap} className="absolute inset-0 flex justify-center" style={{ background: c.bg }}>
      <div style={{ width: hostW || '100%', height: '100%', padding: prefs.flow === 'scroll' ? 0 : '28px 0 8px', boxSizing: 'border-box' }}>
        <div ref={host} className="w-full h-full" aria-label="Book" />
      </div>
      {!ready && !err && <div className="absolute inset-0 grid place-items-center" style={{ background: c.bg }}><Spinner label="Opening the book…" /></div>}
      {err && <div className="absolute inset-0 grid place-items-center p-8" style={{ background: c.bg }}><ErrorNote error={err} /></div>}
    </div>
  );
}
