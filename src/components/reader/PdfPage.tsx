'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import type { Hl } from './TextPage';
import { buildIndex, findRange, supportsHighlights, applyHighlights, clearHighlights } from './pdfRanges';

let pdfjsP: Promise<any> | null = null;
function loadPdfjs() {
  if (!pdfjsP) {
    // Served from /public (copied from pdfjs-dist) so the bundler never touches it. A native import: `new Function` would need 'unsafe-eval' in the CSP.
    pdfjsP = import(/* webpackIgnore: true */ new URL('/pdfjs/pdf.min.mjs', location.origin).href).then((m: any) => { m.GlobalWorkerOptions.workerSrc = new URL('/pdfjs/pdf.worker.min.mjs', location.origin).href; return m; }, (e: unknown) => { pdfjsP = null; throw e; });
  }
  return pdfjsP;
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

const docs = new Map<string, Promise<any>>();
function getDoc(bookId: string) {
  if (!docs.has(bookId)) docs.set(bookId, loadPdfjs().then((p) => p.getDocument({ url: `/api/books/${bookId}/file`, isEvalSupported: false }).promise).catch((e) => { docs.delete(bookId); throw e; }));
  return docs.get(bookId)!;
}

/** Render a page to an offscreen canvas (used for OCR of scanned pages). */
export async function renderPageCanvas(bookId: string, page: number, scale = 2): Promise<HTMLCanvasElement> {
  const pg = await (await getDoc(bookId)).getPage(page);
  const vp = pg.getViewport({ scale });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  await pg.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
  return c;
}

export function PdfPage({ bookId, page, zoom, pageText, highlights, onSelect, onHighlightClick, jump }: {
  bookId: string; page: number; zoom: number; pageText: string; highlights: Hl[]; jump?: { text?: string; nonce: number } | null;
  onSelect: (sel: { text: string; start: number; end: number; sentence: string; rect: DOMRect } | null) => void;
  onHighlightClick: (id: string, rect: DOMRect) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rendered, setRendered] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const audio = useStore((s) => s.audio);
  const hlRanges = useRef<{ id: string; range: Range }[]>([]);
  const [flash, setFlash] = useState(false);
  useEffect(() => { if (!jump) return; setFlash(true); const t = setTimeout(() => setFlash(false), 3500); return () => clearTimeout(t); }, [jump?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false; let task: any; let tl: any;
    (async () => {
      try {
        const [pdfjs, doc] = [await loadPdfjs(), await getDoc(bookId)];
        const pg = await doc.getPage(page);
        const avail = Math.min((wrap.current?.parentElement?.clientWidth ?? 800) - 8, 1100);
        const base = pg.getViewport({ scale: 1 });
        const scale = (avail / base.width) * zoom;
        const vp = pg.getViewport({ scale });
        // Supersample 2x: scanned bitmap pages look blotchy (random bold/thin strokes) when pdf.js downsamples them to the screen size.
        const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1) * 2, Math.max(1, 4096 / vp.width));
        // fresh canvas per render: pdf.js refuses concurrent render() calls on one canvas (React strict-mode double mount)
        const c = document.createElement('canvas'); c.style.display = 'block'; c.width = vp.width * dpr; c.height = vp.height * dpr; c.style.width = `${vp.width}px`; c.style.height = `${vp.height}px`;
        setSize({ w: vp.width, h: vp.height });
        if (cancelled) return;
        task = pg.render({ canvasContext: c.getContext('2d')!, viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0] });
        await task.promise;
        if (cancelled) return;
        host.current?.replaceChildren(c);
        const L = layer.current!; L.replaceChildren(); L.style.setProperty('--scale-factor', String(vp.scale)); L.style.width = `${vp.width}px`; L.style.height = `${vp.height}px`;
        tl = new pdfjs.TextLayer({ textContentSource: pg.streamTextContent(), container: L, viewport: vp });
        await tl.render();
        if (!cancelled) { setErr(null); setRendered((r) => r + 1); }
      } catch (e: any) { if (!cancelled && e?.name !== 'RenderingCancelledException') setErr(e?.message ?? 'Failed to render page'); }
    })();
    return () => { cancelled = true; try { task?.cancel(); tl?.cancel(); } catch { /* */ } };
  }, [bookId, page, zoom]);

  // Approximate highlight/speech overlay: mark text-layer spans contained in the target text.
  useEffect(() => {
    const L = layer.current; if (!L || !rendered) return;
    if (supportsHighlights()) {
      // exact ranges (a highlight may start/end mid-fragment or span several fragments)
      const idx = buildIndex(L);
      const groups: Record<string, Range[]> = {};
      const found: { id: string; range: Range }[] = [];
      for (const h of highlights) { const r = findRange(idx, h.text); if (r) { (groups[`hl-${h.color}`] ??= []).push(r); found.push({ id: h.id, range: r }); } }
      hlRanges.current = found;
      if (audio.page === page && audio.sentence) { const r = findRange(idx, pageText.slice(audio.sentence[0], audio.sentence[1])); if (r) groups['pdf-speak'] = [r]; }
      let jr: Range | null = null;
      if (flash && jump?.text) { jr = findRange(idx, jump.text); if (jr) groups['pdf-jump'] = [jr]; }
      applyHighlights(groups);
      if (jr) jr.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return () => { clearHighlights(); hlRanges.current = []; };
    }
    const spans = [...L.querySelectorAll<HTMLSpanElement>('span')];
    const hlTexts = highlights.map((h) => ({ id: h.id, t: norm(h.text), color: h.color }));
    const jt = flash && jump?.text ? norm(jump.text) : '';
    const sent = audio.page === page && audio.sentence ? norm(pageText.slice(audio.sentence[0], audio.sentence[1])) : '';
    for (const sp of spans) {
      const t = norm(sp.textContent ?? '');
      sp.classList.remove('pdf-hl', 'pdf-speak', 'pdf-jump', 'pdf-hl-yellow', 'pdf-hl-green', 'pdf-hl-blue', 'pdf-hl-pink', 'pdf-hl-orange'); delete sp.dataset.hid;
      if (t.length < 2) continue;
      const h = hlTexts.find((x) => x.t.includes(t));
      if (h) { sp.classList.add('pdf-hl', `pdf-hl-${h.color}`); sp.dataset.hid = h.id; }
      if (sent && sent.includes(t)) sp.classList.add('pdf-speak');
      if (jt && jt.includes(t)) sp.classList.add('pdf-jump');
    }
    if (jt) L.querySelector('.pdf-jump')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [rendered, highlights, audio.sentence, audio.page, page, pageText, flash, jump]);

  function handleUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !layer.current?.contains(sel.anchorNode)) return onSelect(null);
    const str = sel.toString().replace(/\s+/g, ' ').trim(); if (!str) return onSelect(null);
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const flat = pageText.replace(/\s+/g, ' ');
    const i = flat.toLowerCase().indexOf(str.toLowerCase());
    const sentence = i >= 0 ? (flat.slice(0, i).split(/(?<=[.!?])\s+/).pop() ?? '') + flat.slice(i).split(/(?<=[.!?])\s+/)[0] : str;
    onSelect({ text: str, start: i, end: i >= 0 ? i + str.length : -1, sentence: sentence.slice(0, 600), rect });
  }

  return (
    <div ref={wrap} className="pdf-wrap" style={{ width: size.w || undefined, height: size.h || 400 }} onMouseUp={handleUp}
      onClick={(e) => {
        const hid = (e.target as HTMLElement).dataset?.hid;
        if (hid) return onHighlightClick(hid, (e.target as HTMLElement).getBoundingClientRect());
        if (!hlRanges.current.length || window.getSelection()?.toString()) return;
        const d = document as any;
        const pos = d.caretPositionFromPoint?.(e.clientX, e.clientY);
        const cr = !pos ? d.caretRangeFromPoint?.(e.clientX, e.clientY) : null;
        const node: Node | null = pos?.offsetNode ?? cr?.startContainer ?? null; const off: number = pos?.offset ?? cr?.startOffset ?? 0;
        if (!node) return;
        const hit = hlRanges.current.find((h) => { try { return h.range.isPointInRange(node, off); } catch { return false; } });
        if (hit) onHighlightClick(hit.id, hit.range.getBoundingClientRect());
      }}>
      <div ref={host} />
      <div ref={layer} className="textLayer" />
      {err && <div className="absolute inset-0 grid place-items-center p-6 text-sm text-center bg-white text-red-700">{err}</div>}
    </div>
  );
}
