// Small helpers shared by the reader footer and the reading dashboard. Everything is derived from the user's own recorded sessions.
export interface DayRow { day: number; seconds: number; words: number; pages: number; sessions: number }
export const MIN_STREAK_SECONDS = 60;

/** Consecutive days with some reading. Rest days never break the streak; today never breaks it until the day is over. */
export function computeStreak(days: DayRow[], restDays: number[], todayDay: number): { streak: number; best: number } {
  const by = new Map(days.map((d) => [d.day, d.seconds]));
  const wd = (d: number) => (((d + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  let streak = 0;
  for (let d = todayDay; d > todayDay - 400; d--) {
    const s = by.get(d) ?? 0;
    if (s >= MIN_STREAK_SECONDS) streak++;
    else if (d === todayDay) continue; // today may still be read
    else if (restDays.includes(wd(d))) continue;
    else break;
  }
  let best = 0, run = 0; const first = days.length ? Math.min(...days.map((d) => d.day)) : todayDay;
  for (let d = first; d <= todayDay; d++) { const s = by.get(d) ?? 0; if (s >= MIN_STREAK_SECONDS) { run++; best = Math.max(best, run); } else if (!restDays.includes(wd(d))) run = 0; }
  return { streak, best: Math.max(best, streak) };
}
export const fmtDuration = (secs: number) => { const m = Math.round(secs / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
export const tzOffset = () => -new Date().getTimezoneOffset(); // minutes east of UTC
