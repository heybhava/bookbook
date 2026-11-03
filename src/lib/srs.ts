// SM-2 style spaced repetition. grade: 0 again, 1 hard, 2 good, 3 easy.
export interface SrsState { ease: number; interval_days: number; reps: number; lapses?: number }
const DAY = 86_400_000;

export function schedule(s: SrsState, grade: number, now = Date.now()) {
  let { ease, interval_days: iv, reps } = s;
  let lapses = s.lapses ?? 0;
  if (grade === 0) { reps = 0; iv = 0; lapses++; ease = Math.max(1.3, ease - 0.2); return { ease, interval_days: iv, reps, lapses, due_at: now + 10 * 60_000 }; }
  reps++;
  if (reps === 1) iv = grade === 3 ? 4 : 1;
  else if (reps === 2) iv = grade === 3 ? 8 : grade === 1 ? 3 : 6;
  else iv = Math.round(iv * ease * (grade === 1 ? 0.8 : grade === 3 ? 1.3 : 1));
  ease = Math.max(1.3, ease + (grade === 3 ? 0.15 : grade === 1 ? -0.15 : 0));
  return { ease, interval_days: iv, reps, lapses, due_at: now + iv * DAY };
}
