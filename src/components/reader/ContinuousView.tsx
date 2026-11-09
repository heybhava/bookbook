'use client';
// Continuous-scroll reading: sections flow one after another with no page breaks. Chapters get a heading; scrolling keeps the current page up to date.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Spinner } from '../ui';

export function ContinuousView({ total, page, chapterAt, hasText, renderSection, onVisible, hostRef, maxWidth, overlay }: {
  total: number; page: number; chapterAt: (n: number) => string | null; hasText: (n: number) => boolean;
  renderSection: (n: number) => ReactNode; onVisible: (n: number) => void; hostRef: (el: HTMLDivElement | null) => void; maxWidth: number; overlay?: ReactNode;
}) {
  const [range, setRange] = useState({ from: Math.max(1, page - 1), to: Math.min(total, page + 3) });
  const wrap = useRef<HTMLDivElement>(null); const lastVis = useRef(page); const top = useRef<HTMLDivElement>(null); const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { hostRef(wrap.current); return () => hostRef(null); }, [hostRef]);

  // jumping somewhere (contents, search, bookmarks): show that section and scroll to it
  useEffect(() => {
    if (lastVis.current === page) return;
    lastVis.current = page;
    if (page < range.from || page > range.to) { setRange({ from: Math.max(1, page - 1), to: Math.min(total, page + 3) }); return; }
    wrap.current?.querySelector(`[data-sec="${page}"]`)?.scrollIntoView({ block: 'start' });
  }, [page, range.from, range.to, total]);
  useEffect(() => { if (lastVis.current === page) wrap.current?.querySelector(`[data-sec="${page}"]`)?.scrollIntoView({ block: 'start' }); }, [range.from]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => wrap.current?.querySelector(`[data-sec="${page}"]`)?.scrollIntoView({ block: 'start' }), 60); return () => clearTimeout(t); }, [range.from, range.to === total]); // eslint-disable-line react-hooks/exhaustive-deps

  // load more as the edges come into view
  useEffect(() => {
    const els = [top.current, bottom.current].filter(Boolean) as Element[]; if (!els.length) return;
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { if (e.target === bottom.current) setRange((r) => (r.to < total ? { ...r, to: Math.min(total, r.to + 3) } : r)); else setRange((r) => (r.from > 1 ? { ...r, from: Math.max(1, r.from - 2) } : r)); } }, { rootMargin: '600px 0px' });
    els.forEach((e) => io.observe(e)); return () => io.disconnect();
  }, [total, range.from, range.to]);
  // which section is being read
  useEffect(() => {
    const secs = wrap.current?.querySelectorAll('[data-sec]'); if (!secs?.length) return;
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { const n = Number((e.target as HTMLElement).dataset.sec); if (n !== lastVis.current) { lastVis.current = n; onVisible(n); } } }, { rootMargin: '-35% 0px -60% 0px' });
    secs.forEach((s) => io.observe(s)); return () => io.disconnect();
  }, [range.from, range.to, onVisible]);

  const nums: number[] = []; for (let n = range.from; n <= range.to; n++) nums.push(n);
  return (
    <div ref={wrap} className="relative mx-auto px-5 py-10" style={{ maxWidth: maxWidth + 40 }}>
      <div ref={top} aria-hidden style={{ height: 1 }} />
      {nums.map((n) => (
        <section key={n} data-sec={n} aria-label={`Page ${n}`}>
          {chapterAt(n) && <h2 className="font-serif text-2xl mt-14 mb-6 text-[var(--ink)]">{chapterAt(n)}</h2>}
          {hasText(n) ? renderSection(n) : <Spinner />}
        </section>
      ))}
      <div ref={bottom} aria-hidden style={{ height: 1 }} />
      {overlay}
      {range.to >= total && <p className="text-center text-sm text-[var(--ink3)] py-16">— End —</p>}
    </div>
  );
}
