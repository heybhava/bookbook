'use client';
// A literal book: two facing pages inside a cover, with paper that behaves like paper.
//  · Text is re-paginated to fit the page at your own font size (a long section becomes several printed pages).
//  · The turning leaf is cut into strips that bend like real paper: the free edge trails behind, curls more than the hinge,
//    and flutters when the leaf stops. A damped spring moves the leaf, so it follows your hand, keeps the speed you let go with,
//    and settles with a small rebound. Shading follows the angle of every strip and the leaf casts a moving shadow.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react';
import { paginate, type Span } from './paginate';

export interface VP { db: number; sub: number }
export interface BookStats { printed: number; total: number; exact: boolean; at: (db: number) => number }
export interface BookApi { turn: (dir: 1 | -1) => void; busy: () => boolean; stats: () => BookStats }
const S = 16; // strips per leaf
const rad = (d: number) => (d * Math.PI) / 180;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const ASPECT = 0.7; // page width / height
const COVER = 6; // breathing room only: there is no frame around the pages
const PAD_T = 44, PAD_B = 42;

interface Sim { fast?: boolean; dir: 1 | -1; a: number; v: number; target: number; dragging: boolean; dragTarget: number; b: number; bv: number; grab: number; t: number; done?: boolean }

function Plain({ text }: { text: string }) {
  return <div className="prose-book">{text.split('\n').filter((l) => l.trim()).map((l, i) => <p key={i}>{l}</p>)}</div>;
}

function Face({ vp, num, side, title, head, children }: { vp: VP | null; num: number; side: 'L' | 'R'; title: string; head: string; children?: ReactNode }) {
  return (
    <div className="bk-face" data-turn="1">
      {vp && <>
        <div className="bk-head" data-turn="1"><span>{side === 'L' ? title : head}</span></div>
        <div className="bk-body">{children}</div>
        <div className="bk-num" data-turn="1">{num}</div>
      </>}
      <div className={`bk-gutter ${side}`} />
      <div className="bk-grain" />
    </div>
  );
}

export function BookSpread({ pos, total, texts, title, headOf, vars, padX, maxPageW, motion, edgeClicks, hostRef, overlay, renderLive, onCommit, apiRef }: {
  pos: VP; total: number; texts: Record<number, string | undefined>; title: string; headOf: (db: number) => string;
  vars: Record<string, string>; padX: number; maxPageW: number; motion: 'physics' | 'simple' | 'none'; edgeClicks: boolean; hostRef?: (el: HTMLElement | null) => void; overlay?: ReactNode;
  renderLive: (vp: VP, slice: string, base: number, full: string) => ReactNode; onCommit: (p: VP) => void;
  apiRef: MutableRefObject<BookApi | null>;
}) {
  const box = useRef<HTMLDivElement>(null); const pagesEl = useRef<HTMLDivElement | null>(null);
  const setPagesEl = useCallback((el: HTMLDivElement | null) => { pagesEl.current = el; hostRef?.(el); }, [hostRef]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const availW = Math.max(300, size.w - 2 * COVER - 56), availH = Math.max(260, size.h - 2 * COVER - 28);
  const W = Math.floor(Math.min(availW / 2, availH * ASPECT, maxPageW)), H = Math.floor(W / ASPECT);
  const PAD_X = clamp(padX, 18, Math.max(18, Math.floor(W / 4)));
  const sig = `${W}x${H}|${PAD_X}|${JSON.stringify(vars)}`;

  // ── pagination: section → printed pages that fit the page box ──
  const pages = useRef<{ sig: string; map: Map<number, Span[]>; src: Map<number, string> }>({ sig: '', map: new Map(), src: new Map() });
  const [, force] = useState(0); const redraw = () => force((n) => n + 1);
  useLayoutEffect(() => {
    if (W <= 0) return; const p = pages.current;
    if (p.sig !== sig) { p.sig = sig; p.map = new Map(); p.src = new Map(); }
    let changed = false;
    for (let db = Math.max(1, pos.db - 2); db <= Math.min(total, pos.db + 3); db++) {
      const t = texts[db]; if (t == null) continue;
      if (p.map.has(db) && p.src.get(db) === t) continue;
      p.map.set(db, paginate(t, { w: W - 2 * PAD_X, h: H - PAD_T - PAD_B, vars })); p.src.set(db, t); changed = true;
    }
    if (changed) redraw();
  }, [texts, sig, W, H, pos.db, total]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (W <= 0) return; let alive = true; let tm: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (!alive) return; const p = pages.current; let n = 0;
      for (const k of Object.keys(texts)) { const db = Number(k); const t = texts[db]; if (t == null || (p.map.has(db) && p.src.get(db) === t)) continue; p.map.set(db, paginate(t, { w: W - 2 * PAD_X, h: H - PAD_T - PAD_B, vars })); p.src.set(db, t); if (++n >= 3) break; }
      if (n > 0) { redraw(); tm = setTimeout(tick, 14); }
    };
    tm = setTimeout(tick, 60); return () => { alive = false; clearTimeout(tm); };
  }, [texts, sig, W, H]); // eslint-disable-line react-hooks/exhaustive-deps
  const lenOf = (db: number) => pages.current.map.get(db)?.length;
  // real page numbers: printed pages before this section (unknown sections are estimated until they have been counted)
  const avgLen = () => { const v = [...pages.current.map.values()]; return v.length ? v.reduce((s, a) => s + a.length, 0) / v.length : 1; };
  const printedAt = (db: number) => { const avg = avgLen(); let s = 0; for (let d = 1; d < db; d++) s += lenOf(d) ?? avg; return Math.round(s) + 1; };
  const exactBefore = (db: number) => { for (let d = 1; d < db; d++) if (lenOf(d) == null) return false; return true; };
  const totalPrinted = () => { const avg = avgLen(); let s = 0; for (let d = 1; d <= total; d++) s += lenOf(d) ?? avg; return Math.round(s); };
  const numOf = (v: VP | null) => (v ? printedAt(v.db) + v.sub : 0);
  const next = (v: VP | null): VP | null => { if (!v) return null; const n = lenOf(v.db); if (n == null) return null; if (v.sub + 1 < n) return { db: v.db, sub: v.sub + 1 }; return v.db < total ? { db: v.db + 1, sub: 0 } : null; };
  const prev = (v: VP | null): VP | null => { if (!v) return null; if (v.sub > 0) return { db: v.db, sub: v.sub - 1 }; if (v.db <= 1) return null; const n = lenOf(v.db - 1); return n == null ? null : { db: v.db - 1, sub: n - 1 }; };
  const spanOf = (v: VP | null) => (v ? pages.current.map.get(v.db)?.[v.sub] : undefined);
  const sliceOf = (v: VP | null) => { const sp = spanOf(v); return v && sp && texts[v.db] != null ? texts[v.db]!.slice(sp.s, sp.e) : ''; };

  const lastMoveR = useRef(0); const sim = useRef<Sim | null>(null); const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const posR = useRef(pos); posR.current = pos;
  const L0 = pos, R0 = next(L0);
  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  const dest = useRef<VP | null>(null);
  // turns asked for while a leaf is still in the air (held arrow key, quick drags) wait their turn, so pages can be flipped continuously
  const queue = useRef<(1 | -1)[]>([]); const turnRef = useRef<(d: 1 | -1) => void>(() => {});
  const flush = () => { const q = queue.current.shift(); if (q) setTimeout(() => turnRef.current(q), 0); };
  const clearDone = () => { if (sim.current?.done) { sim.current = null; redraw(); flush(); } };
  const finish = useCallback(() => {
    const s = sim.current; if (!s) return; stop();
    if (s.target === (s.dir > 0 ? 180 : 0) && dest.current) { s.done = true; s.a = s.target; s.v = 0; onCommit(dest.current); setTimeout(clearDone, 250); }
    else { sim.current = null; queue.current = []; }
    redraw();
  }, [onCommit]); // eslint-disable-line react-hooks/exhaustive-deps
  const posKey = `${pos.db}:${pos.sub}`;
  useEffect(() => { clearDone(); }, [posKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => stop, []);

  const step = useCallback(() => {
    const s = sim.current; if (!s || s.done) return;
    const now = performance.now(); const dt = Math.min(0.034, (now - s.t) / 1000); s.t = now;
    // the leaf: a damped spring toward your hand (while held) or toward the page it is falling onto
    if (s.dragging && now - (lastMoveR.current || now) > 2500) { s.dragging = false; s.target = s.a > 90 ? 180 : 0; } // nobody is holding it any more
    const tgt = s.dragging ? s.dragTarget : s.target;
    const K = s.dragging ? 520 : s.fast ? 150 : 64, C = s.dragging ? 44 : s.fast ? 18 : 12;
    s.v += (K * (tgt - s.a) - C * s.v) * dt; s.a += s.v * dt;
    if (s.a > 180) { s.a = 180; if (s.v > 0) s.v = -s.v * 0.16; }
    if (s.a < 0) { s.a = 0; if (s.v < 0) s.v = -s.v * 0.16; }
    // the paper: its free edge trails the motion (air drag) and springs back with a flutter
    const bt = clamp(s.v * 0.2, -70, 70) + (s.dir > 0 ? 1 : -1) * Math.sin(rad(s.a)) * 20;
    s.bv += (150 * (bt - s.b) - 7.5 * s.bv) * dt; s.b += s.bv * dt;
    if (mo.current === 'simple') { s.b = 0; s.bv = 0; } // quick plain turn: no curl or flutter
    if (!s.dragging && ((queue.current.length > 0 && Math.abs(tgt - s.a) < 3) || (Math.abs(tgt - s.a) < 0.5 && Math.abs(s.v) < 8 && Math.abs(s.bv) < 14 && Math.abs(s.b) < 2.5))) finish(); else redraw();
  }, [finish]);
  const begin = (dir: 1 | -1, dragging: boolean, v = 0, grab = 0.5) => {
    const L = posR.current; const R = next(L);
    dest.current = dir > 0 ? next(R) : prev(prev(L)); // the left page of the spread we are turning to
    sim.current = { fast: queue.current.length > 0, dir, a: dir > 0 ? 0 : 180, v, target: dir > 0 ? 180 : 0, dragging, dragTarget: dir > 0 ? 0 : 180, b: 0, bv: 0, grab, t: performance.now() };
    stop(); timer.current = setInterval(step, 16); redraw();
  };
  const canTurn = (dir: 1 | -1) => { if (sim.current) return false; const L = posR.current; if (dir > 0) return !!next(next(L)); return !!prev(L); };
  const hop = (dir: 1 | -1) => { const L = posR.current; if (dir < 0 && !prev(prev(L))) { const p = prev(L); if (p) onCommit(p); return true; } return false; }; // odd start: no room for a full turn
  const mo = useRef(motion); mo.current = motion;
  const turn = useCallback((dir: 1 | -1) => {
    let still = mo.current === 'none'; try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) still = true; } catch { /* */ }
    if (still && !sim.current) { if (!canTurn(dir)) return; const L = posR.current; const d = dir > 0 ? next(next(L)) : prev(prev(L)) ?? prev(L); if (d) onCommit(d); return; } // no animation: change page at once
    if (sim.current) { if (queue.current.length < 4) queue.current.push(dir); return; }
    if (!canTurn(dir)) { queue.current = []; return; } if (hop(dir)) return; begin(dir, false, dir * (queue.current.length ? 60 : 30));
  }, [total, step]); // eslint-disable-line react-hooks/exhaustive-deps
  turnRef.current = turn;
  const posRef2 = useRef(pos); posRef2.current = pos;
  useEffect(() => {
    apiRef.current = { turn, busy: () => !!sim.current, stats: () => { const p = posRef2.current; let all = true; for (let d = 1; d <= total; d++) if (lenOf(d) == null) { all = false; break; } return { printed: printedAt(p.db) + p.sub, total: totalPrinted(), exact: exactBefore(p.db) && all, at: printedAt }; } };
    return () => { apiRef.current = null; };
  }); // re-bind each render so the getter always sees fresh pagination

  // pointer: mouse drags from the page margin (text keeps normal selection), touch/pen anywhere; a click on the outer margin also turns
  const press = useRef<{ x: number; y: number; half: 1 | -1; turn: boolean; started: boolean } | null>(null);
  const spineX = () => { const r = pagesEl.current!.getBoundingClientRect(); return r.left + r.width / 2; };
  const grabOf = (y: number) => { const r = pagesEl.current!.getBoundingClientRect(); return clamp((y - r.top) / r.height, 0, 1); };
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || sim.current) return;
    const onMargin = !!(e.target as HTMLElement).closest('[data-turn]');
    if (e.pointerType === 'mouse' && !onMargin) return;
    press.current = { x: e.clientX, y: e.clientY, half: e.clientX >= spineX() ? 1 : -1, turn: onMargin, started: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const p = press.current; if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.started) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      const dir: 1 | -1 | 0 = p.half > 0 && dx < 0 ? 1 : p.half < 0 && dx > 0 ? -1 : 0;
      if (!dir || !canTurn(dir) || hop(dir)) { press.current = null; return; }
      begin(dir, true, 0, grabOf(p.y)); p.started = true; try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ } window.getSelection()?.removeAllRanges();
    }
    const s = sim.current; if (!s) return; lastMove.current = performance.now();
    s.dragTarget = (Math.acos(clamp((e.clientX - spineX()) / W, -1, 1)) * 180) / Math.PI; s.grab = grabOf(e.clientY);
  };
  const lastMove = lastMoveR;
  const release = useCallback(() => { press.current = null; const s = sim.current; if (s && s.dragging) { s.dragging = false; const proj = s.a + s.v * 0.13; s.target = proj > 90 ? 180 : 0; } }, []);
  useEffect(() => {
    const r = () => release(); const vis = () => { if (document.visibilityState === 'hidden') release(); };
    window.addEventListener('pointerup', r); window.addEventListener('pointercancel', r); window.addEventListener('blur', r); document.addEventListener('visibilitychange', vis);
    return () => { window.removeEventListener('pointerup', r); window.removeEventListener('pointercancel', r); window.removeEventListener('blur', r); document.removeEventListener('visibilitychange', vis); };
  }, [release]);
  const onUp = (e: React.PointerEvent) => {
    const p = press.current; press.current = null; if (!p) return;
    const s = sim.current;
    if (p.started && s) { release(); return; }
    if (edgeClicks && p.turn && Math.abs(e.clientX - p.x) < 5 && Math.abs(e.clientY - p.y) < 5) { const rel = (e.clientX - spineX()) / W; if (rel > 0.82) turn(1); else if (rel < -0.82) turn(-1); }
  };

  // ── what is on each side right now ──
  const s0 = sim.current; const dir = s0?.dir ?? 1;
  const flat = !!s0 && !s0.done && (dir > 0 ? s0.a < 0.7 : s0.a > 179.3);
  const s = flat ? null : s0;
  const R1 = R0, R2 = next(R1), R3 = next(R2), Lm1 = prev(L0), Lm2 = prev(Lm1);
  const baseL: VP | null = s ? (dir > 0 ? L0 : Lm2) : L0;
  const baseR: VP | null = s ? (dir > 0 ? R3 : R1) : R1;
  const frontV: VP | null = dir > 0 ? R1 : Lm1, backV: VP | null = dir > 0 ? R2 : L0;
  const a = s?.a ?? 0, bend = s?.b ?? 0;
  const live = !s;
  const faceFor = (v: VP | null, side: 'L' | 'R', isLive: boolean) => {
    const sp = spanOf(v);
    return <Face vp={v} num={numOf(v)} side={side} title={title} head={v ? headOf(v.db) : ''}>{v && sp ? (isLive ? renderLive(v, sliceOf(v), sp.s, texts[v.db]!) : <Plain text={sliceOf(v)} />) : null}</Face>;
  };

  // paper: strips curl more toward the free edge
  const sw = W / S; const wsum = (S * (S - 1)) / 2;
  const tilt = s ? (s.grab - 0.5) * 2 * Math.sin(rad(a)) * (s.dragging ? 11 : 4) : 0;
  const strip = (i: number, psi: number): ReactNode => {
    const want = i === 0 ? -a : (bend * i) / wsum;
    const nextPsi = i === 0 ? -a : clamp(psi + want, -179.5, -0.5); // paper never passes through the page beneath it
    const rel = i === 0 ? -a : nextPsi - psi;
    const edge = Math.min(1, Math.max(0, (Math.min(Math.abs(nextPsi), 180 - Math.abs(nextPsi)) - 1.5) / 10)); // no shading while the paper is (nearly) flat
    const shade = 0.5 * Math.pow(1 - Math.abs(Math.cos(rad(nextPsi))), 0.9) * edge;
    const sheen = Math.max(0, Math.sin(rad(nextPsi * 2 + 40))) * 0.1 * edge;
    return (
      <div key={i} style={{ position: 'absolute', left: i === 0 ? 0 : sw, top: 0, width: sw, height: H, transformStyle: 'preserve-3d', transformOrigin: 'left center', transform: `rotateY(${rel}deg)` }}>
        <div className="bk-leaf-face" style={{ width: sw + 0.8 }}><div style={{ width: W, height: H, transform: `translateX(${-i * sw}px)` }}>{faceFor(frontV, 'R', false)}</div><div className="bk-leaf-shade" style={{ opacity: shade }} /><div className="bk-leaf-sheen" style={{ opacity: sheen }} /></div>
        <div className="bk-leaf-face" style={{ width: sw + 0.8, transform: 'rotateY(180deg)' }}><div style={{ width: W, height: H, transform: `translateX(${-(W - (i + 1) * sw)}px)` }}>{faceFor(backV, 'L', false)}</div><div className="bk-leaf-shade" style={{ opacity: shade }} /><div className="bk-leaf-sheen" style={{ opacity: sheen }} /></div>
        {i < S - 1 && strip(i + 1, nextPsi)}
      </div>
    );
  };

  // shadow the leaf throws on the page beneath it (its edge travels with the leaf)
  const sa = Math.sin(rad(a)), ca = Math.cos(rad(a));
  const castR = a < 92 ? Math.min(0.6, 0.7 * sa + 0.05) : 0, castL = a > 88 ? Math.min(0.6, 0.7 * sa + 0.05) : 0;
  const tipR = Math.max(0, ca) * W, tipL = Math.max(0, -ca) * W;

  const stackK = (frac: number) => Math.max(1, Math.round(1 + 9 * clamp(frac, 0, 1)));
  const stack = (k: number, sign: 1 | -1) => Array.from({ length: k }, (_, j) => `${sign * (j + 1)}px ${Math.round((j + 1) * 0.4)}px 0 color-mix(in srgb, var(--page) ${j % 2 ? 90 : 78}%, #000)`).join(', ');
  const frac = total ? (L0.db - 1) / total : 0;

  return (
    <div ref={box} className="w-full h-full flex items-center justify-center" style={{ ...vars, ['--pad-x' as any]: `${PAD_X}px`, ['--pad-t' as any]: `${PAD_T}px`, ['--pad-b' as any]: `${PAD_B}px` }}>
      {W > 0 && (
        <div className="bk" style={{ width: 2 * W + 2 * COVER, height: H + 2 * COVER, padding: COVER }}>
          <div ref={setPagesEl} role="region" aria-label="Book pages" className="bk-pages" style={{ width: 2 * W, height: H, touchAction: 'none' }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            <div className="bk-page" style={{ left: 0, width: W, height: H, boxShadow: stack(stackK(frac), -1) }}>
              {faceFor(baseL, 'L', live)}
              {castL > 0 && <div className="bk-cast" style={{ opacity: castL, background: `linear-gradient(270deg, rgba(0,0,0,.85) 0, rgba(0,0,0,.45) ${tipL}px, transparent ${tipL + 70}px)` }} />}
            </div>
            <div className="bk-page" style={{ left: W, width: W, height: H, boxShadow: stack(stackK(1 - frac), 1) }}>
              {faceFor(baseR, 'R', live)}
              {castR > 0 && <div className="bk-cast" style={{ opacity: castR, background: `linear-gradient(90deg, rgba(0,0,0,.85) 0, rgba(0,0,0,.45) ${tipR}px, transparent ${tipR + 70}px)` }} />}
            </div>
            {s && <div style={{ position: 'absolute', left: W, top: 0, width: W, height: H, transformStyle: 'preserve-3d', transformOrigin: 'left center', transform: `translateZ(1px) rotateX(${tilt}deg)` }}>{strip(0, -a)}</div>}
            <div className="bk-spine" />
            {overlay}
          </div>
        </div>
      )}
    </div>
  );
}
