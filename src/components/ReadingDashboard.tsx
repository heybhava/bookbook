'use client';
// Reading dashboard: everything shown here comes from your own recorded reading sessions. Estimates are labelled as estimates.
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { useRead } from '@/lib/readPrefs';
import { computeStreak, fmtDuration, tzOffset, type DayRow } from '@/lib/readStats';
import { Spinner, ErrorNote } from './ui';

interface Totals { seconds: number; words: number; pages: number; sessions: number }
interface Stats {
  today: Totals; week: Totals; month: Totals; total: { s: number; w: number; n: number };
  avgWpm: number | null; wpmSamples: { t: number; wpm: number }[]; days: DayRow[]; todayDay: number; completed: number;
  current: { id: string; title: string; author: string | null; percent: number | null; page: number | null; page_count: number }[]; perBook: { book_id: string; seconds: number }[];
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="card p-4"><div className="label">{label}</div><div className="text-2xl font-serif mt-1 tabular-nums">{value}</div>{sub && <div className="text-[11px] text-[var(--ink3)] mt-0.5">{sub}</div>}</div>;
}

export function ReadingDashboard() {
  const go = useStore((s) => s.go); const p = useRead((s) => s.p); const load = useRead((s) => s.load); const setP = useRead((s) => s.set);
  const [s, setS] = useState<Stats | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { load(); api<Stats>(`/reading/stats?tz=${tzOffset()}`).then(setS).catch((e) => setErr(e.message)); }, [load]);
  const { streak, best } = useMemo(() => (s ? computeStreak(s.days, p.restDays, s.todayDay) : { streak: 0, best: 0 }), [s, p.restDays]);
  if (err) return <ErrorNote error={err} />; if (!s) return <Spinner label="Loading your reading history…" />;
  const by = new Map(s.days.map((d) => [d.day, d])); const weeks = 14; const end = s.todayDay; const wd = (d: number) => (((d + 4) % 7) + 7) % 7;
  const first = end - (weeks * 7 - 1) - wd(end - (weeks * 7 - 1)); // start the grid on a Sunday
  const cells: { day: number; secs: number }[] = []; for (let d = first; d <= end; d++) cells.push({ day: d, secs: by.get(d)?.seconds ?? 0 });
  const shade = (m: number) => (m <= 0 ? 'var(--panel2)' : `color-mix(in srgb, var(--accent) ${Math.min(90, 22 + m * 1.6)}%, var(--panel2))`);
  const last = s.current[0]; const active = new Set(s.days.filter((d) => d.seconds >= 60).map((d) => d.day));
  const wpm = s.wpmSamples; const wmax = Math.max(1, ...wpm.map((x) => x.wpm)), wmin = Math.min(...wpm.map((x) => x.wpm), wmax);
  const consistency = (() => { let n = 0, read = 0; for (let d = end - 29; d <= end; d++) { if (p.restDays.includes(wd(d))) continue; n++; if (active.has(d)) read++; } return n ? Math.round((read / n) * 100) : 0; })();
  const secsByBook = new Map(s.perBook.map((b) => [b.book_id, b.seconds]));

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div><h1 className="text-2xl font-serif">Reading</h1><p className="text-sm text-[var(--ink2)]">Your own reading time, measured while you actually read.</p></div>
        {last && <button className="btn btn-primary" onClick={() => go('reader', last.id)}>Continue “{last.title.slice(0, 40)}{last.title.length > 40 ? '…' : ''}”{last.page ? ` · page ${last.page}` : ''}</button>}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Today" value={fmtDuration(s.today.seconds)} sub={`${s.today.sessions} session${s.today.sessions === 1 ? '' : 's'}`} />
        <Stat label="This week" value={fmtDuration(s.week.seconds)} sub={`${s.week.pages} pages · ≈${s.week.words.toLocaleString()} words`} />
        <Stat label="This month" value={fmtDuration(s.month.seconds)} sub={`${s.month.sessions} sessions`} />
        <Stat label="All time" value={fmtDuration(s.total.s)} sub={`${s.total.n} sessions · ≈${s.total.w.toLocaleString()} words`} />
        <Stat label="Current streak" value={`${streak} day${streak === 1 ? '' : 's'}`} sub={`best ${best} · rest days never break it`} />
        <Stat label="Consistency" value={`${consistency}%`} sub="of the last 30 non-rest days with reading" />
        <Stat label="Books completed" value={String(s.completed)} sub={`${s.current.length} in progress`} />
        <Stat label="Average speed" value={s.avgWpm ? `${s.avgWpm} wpm` : '—'} sub={s.avgWpm ? 'measured over sessions of 2+ min; words are estimated' : 'appears after a few longer sessions'} />
      </div>

      <div className="card p-4">
        <div className="label mb-2">Reading activity · last {weeks} weeks</div>
        <div className="overflow-x-auto"><div className="inline-grid grid-flow-col gap-[3px]" style={{ gridTemplateRows: 'repeat(7, 14px)' }}>
          {cells.map((c) => <div key={c.day} title={`${new Date(c.day * 86400000).toUTCString().slice(0, 16)} · ${Math.round(c.secs / 60)} min`} className="w-3.5 h-3.5 rounded-[3px]" style={{ background: c.day > end ? 'transparent' : shade(c.secs / 60) }} />)}
        </div></div>
        <div className="text-[11px] text-[var(--ink3)] mt-2">Darker = more minutes. Hover a square for the day.</div>
      </div>

      {wpm.length > 1 && <div className="card p-4">
        <div className="label mb-2">Measured reading speed (words per minute)</div>
        <svg viewBox="0 0 600 90" className="w-full h-24" role="img" aria-label="Reading speed history"><polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={wpm.map((x, i) => `${(i / Math.max(1, wpm.length - 1)) * 590 + 5},${85 - ((x.wpm - wmin) / Math.max(1, wmax - wmin)) * 75}`).join(' ')} /></svg>
        <div className="text-[11px] text-[var(--ink3)]">Range {Math.round(wmin)}–{Math.round(wmax)} wpm. Speed is not comprehension: a faster number only means you moved through the text faster.</div>
      </div>}

      <div className="card p-4">
        <div className="label mb-2">Books in progress</div>
        {s.current.length === 0 && <p className="text-sm text-[var(--ink3)]">Nothing in progress yet.</p>}
        <div className="space-y-3">{s.current.map((b) => (
          <button key={b.id} onClick={() => go('reader', b.id)} className="block w-full text-left">
            <div className="flex justify-between text-sm gap-3"><span className="truncate">{b.title}</span><span className="text-[var(--ink2)] tabular-nums whitespace-nowrap">{Math.round((b.percent ?? 0) * 100)}% · {fmtDuration(secsByBook.get(b.id) ?? 0)} read</span></div>
            <div className="h-1.5 rounded-full bg-[var(--panel2)] mt-1 overflow-hidden"><div className="h-full bg-[var(--accent)]" style={{ width: `${(b.percent ?? 0) * 100}%` }} /></div>
          </button>))}</div>
      </div>
      <p className="text-[11px] text-[var(--ink3)]">Time counts only while the window is visible and you have used the keyboard, mouse or touch within the last 90 seconds. Word and page counts are estimates from section sizes.</p>
    </div>
  );
}
