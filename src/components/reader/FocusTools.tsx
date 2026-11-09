'use client';
// Optional reading aids. None of them blocks rereading or backward navigation, and none of them claims to measure comprehension.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Icon } from '../ui';

interface Line { top: number; left: number; width: number; height: number; words: number; el: HTMLElement }

/** Lines of text currently on screen inside `host` (excluding the paper that is mid-turn), in reading order. */
function measureLines(host: HTMLElement): Line[] {
  const hr = host.getBoundingClientRect(); const out: Line[] = [];
  host.querySelectorAll<HTMLElement>('.prose-book').forEach((root) => {
    if (root.closest('.bk-leaf-face')) return;
    root.querySelectorAll<HTMLElement>('p').forEach((p) => {
      const range = document.createRange(); range.selectNodeContents(p);
      const groups = new Map<number, { l: number; r: number; t: number; b: number }>();
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 1 || r.height < 2) continue; const k = Math.round((r.top + r.height / 2) / 5);
        const g = groups.get(k); if (g) { g.l = Math.min(g.l, r.left); g.r = Math.max(g.r, r.right); g.t = Math.min(g.t, r.top); g.b = Math.max(g.b, r.bottom); } else groups.set(k, { l: r.left, r: r.right, t: r.top, b: r.bottom });
      }
      const ls = [...groups.values()].sort((a, b) => a.t - b.t); if (!ls.length) return;
      const words = (p.textContent ?? '').trim().split(/\s+/).filter(Boolean).length; const totalW = ls.reduce((s, g) => s + (g.r - g.l), 0) || 1;
      for (const g of ls) out.push({ top: g.t - hr.top + host.scrollTop, left: g.l - hr.left + host.scrollLeft, width: g.r - g.l, height: g.b - g.t, words: Math.max(1, (words * (g.r - g.l)) / totalW), el: p });
    });
  });
  return out;
}

export function Pacer({ host, scroller, active, wpm, guide, autoTurn, onEnd, resetKey }: { host: HTMLElement | null; scroller?: HTMLElement | null; active: boolean; wpm: number; guide: 'underline' | 'line' | 'band'; autoTurn: boolean; onEnd: () => void; resetKey: string }) {
  const lines = useRef<Line[]>([]); const idx = useRef(0); const acc = useRef(0); const [, force] = useState(0); const endedRef = useRef(false);
  const remeasure = useCallback(() => { if (!host) return; lines.current = measureLines(host); if (idx.current >= lines.current.length) idx.current = 0; force((n) => n + 1); }, [host]);
  useEffect(() => { idx.current = 0; acc.current = 0; endedRef.current = false; const t = setTimeout(remeasure, 160); return () => clearTimeout(t); }, [resetKey, remeasure, active]);
  useEffect(() => { // re-measure when the page size changes or new text arrives (debounced)
    if (!host) return; let t: ReturnType<typeof setTimeout>; const again = () => { clearTimeout(t); t = setTimeout(remeasure, 180); };
    const ro = new ResizeObserver(again); ro.observe(host); const mo = new MutationObserver(again); mo.observe(host, { childList: true, subtree: true, characterData: true });
    return () => { clearTimeout(t); ro.disconnect(); mo.disconnect(); };
  }, [host, remeasure]);
  useEffect(() => { // anywhere you click, the guide continues from there: rereading is never blocked
    if (!host || !active) return;
    const h = (e: MouseEvent) => { if (window.getSelection()?.toString()) return; const r = host.getBoundingClientRect(); const y = e.clientY - r.top + host.scrollTop; let best = -1, d = 1e9; lines.current.forEach((l, i) => { const dd = Math.abs(l.top + l.height / 2 - y); if (dd < d) { d = dd; best = i; } }); if (best >= 0 && d < 40) { idx.current = best; acc.current = 0; endedRef.current = false; force((n) => n + 1); } };
    host.addEventListener('click', h); return () => host.removeEventListener('click', h);
  }, [host, active]);
  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => {
      if (document.hidden || !lines.current.length || endedRef.current) return;
      const cur = lines.current[idx.current]; if (!cur) return; acc.current += 100;
      if (acc.current >= (cur.words * 60000) / Math.max(60, wpm)) {
        acc.current = 0;
        if (idx.current + 1 < lines.current.length) { idx.current++; const l = lines.current[idx.current]; if (scroller && l) { const view = scroller.clientHeight; if (l.top + l.height > scroller.scrollTop + view * 0.62 || l.top < scroller.scrollTop) scroller.scrollTo({ top: Math.max(0, l.top - view * 0.3), behavior: 'smooth' }); } force((n) => n + 1); }
        else { endedRef.current = true; if (autoTurn) onEnd(); }
      }
    }, 100);
    return () => clearInterval(tick);
  }, [active, wpm, autoTurn, onEnd, scroller]);
  if (!active || !host) return null; const l = lines.current[idx.current]; if (!l) return null; const nx = lines.current[idx.current + 1];
  const base: React.CSSProperties = { transition: 'top .12s linear, left .12s linear, width .12s linear' };
  return (<>
    {guide === 'underline' && <div className="pacer-bar" aria-hidden style={{ ...base, top: l.top + l.height - 1, left: l.left, width: l.width, height: 2, background: 'var(--accent)', borderRadius: 2, right: 'auto' }} />}
    {guide !== 'underline' && <div className="pacer-bar" aria-hidden style={{ ...base, top: l.top - 1, left: l.left - 4, width: l.width + 8, height: l.height + 2, right: 'auto', background: 'color-mix(in srgb, var(--accent) 16%, transparent)', borderRadius: 4 }} />}
    {guide === 'band' && nx && <div className="pacer-bar" aria-hidden style={{ ...base, top: nx.top - 1, left: nx.left - 4, width: nx.width + 8, height: nx.height + 2, right: 'auto', background: 'color-mix(in srgb, var(--accent) 7%, transparent)', borderRadius: 4 }} />}
  </>);
}

/** Dims everything except the line(s) under the pointer, or the hovered paragraph. Arrow Up/Down move it for keyboard use. */
export function Spotlight({ host, kind, size, dim, resetKey }: { host: HTMLElement | null; kind: 'line' | 'paragraph'; size: number; dim: number; resetKey: string }) {
  const [y, setY] = useState<number | null>(null); const lh = useRef(30); const top0 = useRef(0);
  useEffect(() => { if (host) { host.classList.add('spot-par'); host.style.setProperty('--spot-dim', String(dim)); } return () => { host?.classList.remove('spot-par'); host?.querySelectorAll('p.hot').forEach((p) => p.classList.remove('hot')); }; }, [host, dim]);
  useEffect(() => { setY(null); }, [resetKey, kind]);
  useEffect(() => {
    if (!host) return;
    const hr = () => host.getBoundingClientRect();
    const pr = host.querySelector('.prose-book'); if (pr) { const cs = getComputedStyle(pr); const l = parseFloat(cs.lineHeight); lh.current = Number.isFinite(l) ? l : parseFloat(cs.fontSize) * 1.5; }
    const first = host.querySelector('.prose-book'); top0.current = first ? first.getBoundingClientRect().top - hr().top : 0;
    const move = (e: PointerEvent) => { if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return; if (kind === 'line') setY(e.clientY - hr().top + host.scrollTop); else { const p = (e.target as HTMLElement).closest?.('.prose-book p') as HTMLElement | null; host.querySelectorAll('p.hot').forEach((x) => x !== p && x.classList.remove('hot')); p?.classList.add('hot'); } };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return; const t = e.target as HTMLElement; if (/INPUT|TEXTAREA|SELECT/.test(t.tagName)) return; e.preventDefault(); const dir = e.key === 'ArrowDown' ? 1 : -1;
      if (kind === 'line') setY((v) => (v == null ? top0.current + lh.current / 2 : v + dir * lh.current));
      else { const ps = [...host.querySelectorAll<HTMLElement>('.prose-book p')].filter((p) => !p.closest('.bk-leaf-face')); const i = ps.findIndex((p) => p.classList.contains('hot')); ps.forEach((p) => p.classList.remove('hot')); ps[Math.max(0, Math.min(ps.length - 1, (i < 0 ? -1 : i) + dir))]?.classList.add('hot'); }
    };
    host.addEventListener('pointermove', move); window.addEventListener('keydown', key);
    return () => { host.removeEventListener('pointermove', move); window.removeEventListener('keydown', key); };
  }, [host, kind, resetKey]);
  if (!host || kind !== 'line') return null;
  const h = lh.current * size; const t = (y ?? top0.current + lh.current / 2) - h / 2; const c = `color-mix(in srgb, var(--page) ${Math.round(dim * 100)}%, transparent)`;
  return <div className="spot-veil" aria-hidden style={{ background: `linear-gradient(to bottom, ${c} 0, ${c} ${Math.max(0, t)}px, transparent ${Math.max(0, t)}px, transparent ${t + h}px, ${c} ${t + h}px)` }} />;
}

/** Rapid serial visual presentation. Optional; faster presentation is not the same as understanding, and rewinding is always one key away. */
export function RSVP({ bookId, total, startPage, wpm, chunk, pausePunct, orp, onSet, onClose, onWords }: {
  bookId: string; total: number; startPage: number; wpm: number; chunk: number; pausePunct: boolean; orp: boolean;
  onSet: (p: { rsvpWpm?: number; rsvpChunk?: number }) => void; onClose: (page: number) => void; onWords: (words: number, seconds: number) => void;
}) {
  const words = useRef<string[]>([]); const pageAt = useRef<number[]>([]); // pageAt[i] = first word index of page startPage+i
  const [i, setI] = useState(0); const [playing, setPlaying] = useState(true); const [ready, setReady] = useState(false); const ir = useRef(0); ir.current = i;
  const t0 = useRef(Date.now()); const wordsShown = useRef(0);
  useEffect(() => {
    let live = true;
    (async () => {
      for (let from = startPage; from <= total && live && words.current.length < 60000; from += 25) {
        try { const rows = await api<{ page: number; text: string }[]>(`/books/${bookId}/pages?from=${from}&to=${Math.min(total, from + 24)}`); if (!live) return; for (const r of rows) { pageAt.current[r.page - startPage] = words.current.length; for (const w of r.text.split(/\s+/)) if (w) words.current.push(w); } if (from === startPage) setReady(true); } catch { return; }
      }
    })();
    return () => { live = false; };
  }, [bookId, total, startPage]);
  const pageOf = (idx: number) => { let p = 0; for (let k = 0; k < pageAt.current.length; k++) if (pageAt.current[k] != null && pageAt.current[k] <= idx) p = k; return startPage + p; };
  const close = useCallback(() => { onWords(wordsShown.current, Math.round((Date.now() - t0.current) / 1000)); onClose(pageOf(ir.current)); }, [onClose, onWords]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = (idx: number) => words.current.slice(idx, idx + chunk).join(' ');
  useEffect(() => {
    if (!playing || !ready) return;
    const w = cur(i); if (!w) { setPlaying(false); return; }
    let ms = (60000 / wpm) * Math.min(chunk, words.current.length - i);
    if (pausePunct) { const last = w.trim().slice(-1); if ('.!?'.includes(last)) ms *= 2; else if (',;:—'.includes(last)) ms *= 1.45; } if (w.length > 12) ms *= 1.25;
    const t = setTimeout(() => { wordsShown.current += chunk; setI((x) => Math.min(x + chunk, Math.max(0, words.current.length - 1))); }, ms);
    return () => clearTimeout(t);
  }, [i, playing, ready, wpm, chunk, pausePunct]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setI((x) => Math.max(0, x - 12)); } else if (e.key === 'ArrowRight') { e.preventDefault(); setI((x) => Math.min(words.current.length - 1, x + 12)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); onSet({ rsvpWpm: Math.min(1000, wpm + 25) }); } else if (e.key === 'ArrowDown') { e.preventDefault(); onSet({ rsvpWpm: Math.max(100, wpm - 25) }); }
    };
    window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true);
  }, [close, onSet, wpm]);
  const w = cur(i); const pivot = (s: string) => Math.max(0, Math.min(s.length - 1, Math.ceil(s.replace(/^[^\p{L}\p{N}]+/u, '').length * 0.35) - 1 + (s.length - s.replace(/^[^\p{L}\p{N}]+/u, '').length)));
  const pi = chunk === 1 && orp ? pivot(w) : -1; const pct = words.current.length ? Math.round((i / words.current.length) * 100) : 0;
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[var(--page)]" role="dialog" aria-label="RSVP reader">
      <div className="flex-1 grid place-items-center select-none px-6">
        {!ready ? <span className="text-[var(--ink3)]">Loading…</span> : (
          <div className="w-full max-w-3xl">
            <div className="h-px bg-[var(--line)] mb-6 relative"><span className="absolute left-1/2 -top-2 h-2 w-px bg-[var(--accent)]" /></div>
            {pi >= 0 ? (
              <div className="grid grid-cols-[1fr_auto_1fr] items-baseline font-serif" style={{ fontSize: 'clamp(2rem, 6vw, 4rem)' }} aria-live="off">
                <span className="text-right text-[var(--ink)] whitespace-pre">{w.slice(0, pi)}</span><span className="rsvp-orp font-semibold">{w[pi]}</span><span className="text-left text-[var(--ink)] whitespace-pre">{w.slice(pi + 1)}</span>
              </div>
            ) : <div className="text-center font-serif" style={{ fontSize: 'clamp(1.8rem, 5vw, 3.4rem)' }}>{w}</div>}
            <div className="h-px bg-[var(--line)] mt-6 relative"><span className="absolute left-1/2 -bottom-2 h-2 w-px bg-[var(--accent)]" /></div>
          </div>
        )}
      </div>
      <div className="border-t border-[var(--line)] bg-[var(--panel)] px-4 py-3 flex flex-wrap items-center gap-3 text-xs">
        <button className="btn" onClick={() => setI((x) => Math.max(0, x - 12))} aria-label="Back 12 words">⟲ 12</button>
        <button className="btn btn-primary w-20 justify-center" onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Resume'}</button>
        <button className="btn" onClick={() => setI((x) => Math.min(words.current.length - 1, x + 12))} aria-label="Forward 12 words">12 ⟳</button>
        <label className="flex items-center gap-2">Speed <input type="range" min={100} max={1000} step={25} value={wpm} onChange={(e) => onSet({ rsvpWpm: Number(e.target.value) })} className="accent-[var(--accent)]" aria-label="Words per minute" /> <b className="tabular-nums w-16">{wpm} wpm</b></label>
        <label className="flex items-center gap-1">Words <select className="input !py-1 !w-auto" value={chunk} onChange={(e) => onSet({ rsvpChunk: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select></label>
        <span className="text-[var(--ink3)] tabular-nums">page {pageOf(i)} · {pct}%</span>
        <span className="flex-1" />
        <button className="btn" onClick={close}>Back to the book (Esc)</button>
        <p className="basis-full text-[11px] text-[var(--ink3)]">RSVP shows words faster, not understanding. If a passage doesn’t land, rewind (←) or slow down (↓) — this is your own pace, and the book returns to the page you reached.</p>
      </div>
    </div>
  );
}

/** Self-timed reading-speed measurement on a passage from the current book. */
export function Calibrate({ text, onDone, onClose }: { text: string; onDone: (wpm: number) => void; onClose: () => void }) {
  const [start, setStart] = useState<number | null>(null); const [res, setRes] = useState<{ wpm: number; secs: number } | null>(null);
  const passage = text.split(/\s+/).filter(Boolean).slice(0, 220); const n = passage.length;
  const hist = (() => { try { return JSON.parse(localStorage.getItem('folio.calib') ?? '[]') as { wpm: number; at: number; ok: string }[]; } catch { return []; } })();
  const save = (ok: string) => { if (!res) return; try { localStorage.setItem('folio.calib', JSON.stringify([...hist, { wpm: res.wpm, at: Date.now(), ok }].slice(-20))); } catch { /* */ } if (ok !== 'no') onDone(res.wpm); onClose(); };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-label="Measure reading speed">
      <div className="card max-w-2xl w-full p-5 space-y-3 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between"><h3 className="font-semibold">Measure my reading speed</h3><button className="btn btn-ghost" onClick={onClose} aria-label="Close"><Icon n="x" /></button></div>
        {start == null && !res && <><p className="text-sm text-[var(--ink2)]">Read the next passage ({n} words) at the speed you normally read to understand it. Press Start, read, then press Done. Your speed counts only if you followed the passage.</p><button className="btn btn-primary" onClick={() => setStart(Date.now())} disabled={n < 40}>{n < 40 ? 'This page is too short — open a page with more text' : 'Start'}</button></>}
        {start != null && !res && <><p className="prose-book" style={{ fontSize: 18 }}>{passage.join(' ')}</p><button className="btn btn-primary" onClick={() => { const secs = (Date.now() - start) / 1000; setRes({ wpm: Math.round((n / secs) * 60), secs }); }}>Done</button></>}
        {res && <>
          <p className="text-2xl font-serif">{res.wpm} <span className="text-sm text-[var(--ink2)]">words per minute</span></p>
          <p className="text-sm text-[var(--ink2)]">Measured in {Math.round(res.secs)} s over {n} words. This is a rough, self-timed figure — not a comprehension score. Did you follow the passage?</p>
          <div className="flex gap-2"><button className="btn btn-primary" onClick={() => save('yes')}>Yes — use {res.wpm} wpm</button><button className="btn" onClick={() => save('partly')}>Partly</button><button className="btn" onClick={() => save('no')}>No — don’t use it</button></div>
        </>}
        {hist.length > 0 && <p className="text-[11px] text-[var(--ink3)]">Earlier measurements: {hist.slice(-5).map((h) => `${h.wpm}${h.ok === 'yes' ? '' : h.ok === 'no' ? '✗' : '~'}`).join(' · ')} wpm</p>}
      </div>
    </div>
  );
}

/** Timed reading session at a chosen pace. The pacer and auto-turn are driven by the parent while it runs. */
export function SprintBar({ minutes, wpm, onSet, getWords, onRunning }: { minutes: number; wpm: number; onSet: (p: { sprintMinutes?: number; sprintWpm?: number }) => void; getWords: () => number; onRunning: (r: boolean) => void }) {
  const [run, setRun] = useState(false); const [left, setLeft] = useState(minutes * 60); const [done, setDone] = useState<{ words: number; secs: number } | null>(null);
  const w0 = useRef(0); const started = useRef(0); const total = useRef(0);
  useEffect(() => { if (!run) setLeft(minutes * 60); }, [minutes, run]);
  useEffect(() => {
    if (!run) return; const id = setInterval(() => setLeft((l) => l - 1), 1000); return () => clearInterval(id);
  }, [run]);
  useEffect(() => { if (run && left <= 0) stop(true); }, [left, run]); // eslint-disable-line react-hooks/exhaustive-deps
  function stop(finished: boolean) { const secs = Math.round((Date.now() - started.current) / 1000); setRun(false); onRunning(false); setDone({ words: Math.max(0, getWords() - w0.current), secs: finished ? minutes * 60 : secs }); }
  function begin() { w0.current = getWords(); started.current = Date.now(); total.current = minutes * 60; setLeft(minutes * 60); setDone(null); setRun(true); onRunning(true); }
  const mm = Math.floor(Math.max(0, left) / 60), ss = Math.max(0, left) % 60;
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 card px-3 py-2 flex items-center gap-3 text-xs shadow-md" role="group" aria-label="Sprint session">
      {!run && <>
        <label className="flex items-center gap-1">Minutes <input type="number" min={1} max={120} value={minutes} onChange={(e) => onSet({ sprintMinutes: Math.max(1, Math.min(120, Number(e.target.value) || 10)) })} className="input !w-14 !py-0.5 text-center" /></label>
        <label className="flex items-center gap-1">Pace <input type="number" min={100} max={900} step={10} value={wpm} onChange={(e) => onSet({ sprintWpm: Math.max(100, Math.min(900, Number(e.target.value) || 300)) })} className="input !w-16 !py-0.5 text-center" /> wpm</label>
        <button className="btn btn-primary !py-1" onClick={begin}>{done ? 'Again' : 'Start'}</button>
        {done && <span className="text-[var(--ink2)]">{Math.floor(done.secs / 60)}:{String(done.secs % 60).padStart(2, '0')} · ≈{done.words.toLocaleString()} words{done.secs >= 60 ? ` · ≈${Math.round((done.words / done.secs) * 60)} wpm (estimate)` : ''}</span>}
      </>}
      {run && <>
        <b className="tabular-nums text-sm w-12">{mm}:{String(ss).padStart(2, '0')}</b>
        <div className="w-28 h-1.5 rounded-full bg-[var(--panel2)] overflow-hidden"><div className="h-full bg-[var(--accent)]" style={{ width: `${Math.max(0, Math.min(100, 100 - (left / Math.max(1, total.current)) * 100))}%` }} /></div>
        <button className="btn !py-1" onClick={() => { setRun(false); onRunning(false); }}>Pause</button><button className="btn !py-1" onClick={() => stop(false)}>End</button>
      </>}
      {!run && left < total.current && left > 0 && <button className="btn !py-1" onClick={() => { setRun(true); onRunning(true); }}>Resume</button>}
    </div>
  );
}
