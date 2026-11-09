'use client';
// Tracks active reading (not just time with the book open): time only counts while the window is visible and you have interacted in the last 90 s.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post } from './api';
import { computeStreak, tzOffset, type DayRow } from './readStats';

export function useReadSession({ bookId, mode, restDays, say }: { bookId: string | null; mode: string; restDays: number[]; say: (m: string) => void }) {
  const allSecs = useRef(0); const secs = useRef(0), words = useRef(0), pages = useRef(0), lastAct = useRef(Date.now()), totalWords = useRef(0), totalSecs = useRef(0);
  const base = useRef({ secs: 0, pages: 0 }); const [days, setDays] = useState<DayRow[]>([]); const [todayDay, setTodayDay] = useState(0);
  const [today, setToday] = useState({ secs: 0, pages: 0 }); const modeR = useRef(mode); modeR.current = mode; const bookR = useRef(bookId); bookR.current = bookId;

  const load = useCallback(() => {
    api<{ days: DayRow[]; todayDay: number; today: { seconds: number; pages: number } }>(`/reading/stats?tz=${tzOffset()}`).then((s) => { setDays(s.days); setTodayDay(s.todayDay); base.current = { secs: s.today.seconds, pages: s.today.pages }; setToday({ secs: s.today.seconds + secs.current, pages: s.today.pages + pages.current }); }).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const flush = useCallback((final = false) => {
    const id = bookR.current; const s = secs.current, w = words.current, pg = pages.current; if (!id || s < 5) { if (final) { secs.current = 0; words.current = 0; pages.current = 0; } return; }
    secs.current = 0; words.current = 0; pages.current = 0; base.current = { secs: base.current.secs + s, pages: base.current.pages + pg };
    totalWords.current += w; totalSecs.current += s;
    void post('/sessions', { bookId: id, seconds: s, pages: pg, words: w, wpm: s >= 120 && w >= 100 ? (w / s) * 60 : undefined, mode: modeR.current }).catch(() => {});
  }, []);

  useEffect(() => {
    const act = () => { lastAct.current = Date.now(); };
    for (const e of ['mousemove', 'keydown', 'pointerdown', 'wheel', 'touchstart', 'scroll']) window.addEventListener(e, act, { passive: true, capture: true });
    let n = 0;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible' || Date.now() - lastAct.current > 90000) return;
      secs.current++; allSecs.current++; n++;
      if (n % 10 === 0) {
        const t = { secs: base.current.secs + secs.current, pages: base.current.pages + pages.current }; setToday(t);
      }
      if (n % 300 === 0) flush();
    }, 1000);
    const vis = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', vis); window.addEventListener('beforeunload', () => flush(true));
    return () => { clearInterval(id); for (const e of ['mousemove', 'keydown', 'pointerdown', 'wheel', 'touchstart', 'scroll']) window.removeEventListener(e, act, { capture: true } as EventListenerOptions); document.removeEventListener('visibilitychange', vis); flush(true); };
  }, [flush, say]);
  useEffect(() => { flush(true); load(); }, [bookId]); // eslint-disable-line react-hooks/exhaustive-deps

  const addWords = useCallback((n: number) => { if (n > 0) words.current += n; }, []);
  const addPages = useCallback((n: number) => { if (n > 0) pages.current += n; }, []);
  const getWords = useCallback(() => totalWords.current + words.current, []);
  const getActive = useCallback(() => allSecs.current, []);
  const withToday = days.some((d) => d.day === todayDay) ? days.map((d) => (d.day === todayDay ? { ...d, seconds: today.secs } : d)) : todayDay ? [...days, { day: todayDay, seconds: today.secs, words: 0, pages: today.pages, sessions: 0 }] : days;
  const { streak, best } = computeStreak(withToday, restDays, todayDay);
  return { today, streak, best, addWords, addPages, getWords, getActive, flush, reload: load };
}
