// FSRS-4.5 (Free Spaced Repetition Scheduler), default parameters. Pure functions, no I/O.
// Memory model: each item has stability S (days for retrievability to fall to 90%) and difficulty D (1..10).
// Retrievability R(t) = (1 + FACTOR * t / S) ^ DECAY.  Ratings: 1 Again, 2 Hard, 3 Good, 4 Easy.
export type Rating = 1 | 2 | 3 | 4;
export type State = 'new' | 'learning' | 'review' | 'relearning';

export const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const DECAY = -0.5, FACTOR = 19 / 81;
const DAY = 86_400_000;

export interface Card { stability: number; difficulty: number; reps: number; lapses: number; state: State; lastReview: number | null; due: number }

export const newCard = (now = Date.now()): Card => ({ stability: 0, difficulty: 0, reps: 0, lapses: 0, state: 'new', lastReview: null, due: now });

const clampD = (d: number) => Math.min(10, Math.max(1, d));
export const initDifficulty = (g: Rating) => clampD(W[4] - (g - 3) * W[5]);
export const initStability = (g: Rating) => Math.max(0.1, W[g - 1]);

export const retrievability = (elapsedDays: number, stability: number) => (stability <= 0 ? 0 : Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY));
/** Days until retrievability decays to `r` (the desired retention). */
export const intervalFor = (stability: number, r = 0.9) => Math.max(1, Math.round((stability / FACTOR) * (Math.pow(r, 1 / DECAY) - 1)));

const nextDifficulty = (d: number, g: Rating) => clampD(W[7] * W[4] + (1 - W[7]) * (d - W[6] * (g - 3)));
const recallStability = (d: number, s: number, r: number, g: Rating) =>
  s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1));
const forgetStability = (d: number, s: number, r: number) => W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));

/** Apply one review. `retention` is the desired recall probability at the next review (default 90%). */
export function review(card: Card, g: Rating, now = Date.now(), retention = 0.9): Card {
  if (card.state === 'new' || !card.lastReview || card.stability <= 0) {
    const s = initStability(g), d = initDifficulty(g);
    if (g === 1) return { stability: s, difficulty: d, reps: 1, lapses: 1, state: 'learning', lastReview: now, due: now + 10 * 60_000 };
    return { stability: s, difficulty: d, reps: 1, lapses: 0, state: 'review', lastReview: now, due: now + intervalFor(s, retention) * DAY };
  }
  const elapsed = (now - card.lastReview) / DAY;
  const r = retrievability(elapsed, card.stability);
  const d = nextDifficulty(card.difficulty, g);
  if (g === 1) {
    const s = Math.min(forgetStability(card.difficulty, card.stability, r), card.stability);
    return { stability: Math.max(0.1, s), difficulty: d, reps: card.reps + 1, lapses: card.lapses + 1, state: 'relearning', lastReview: now, due: now + 10 * 60_000 };
  }
  const s = recallStability(card.difficulty, card.stability, r, g);
  let iv = intervalFor(s, retention);
  // Hard must not schedule further out than Good would, and Easy not sooner than Good
  if (g === 2) iv = Math.max(1, Math.min(iv, intervalFor(recallStability(card.difficulty, card.stability, r, 3), retention) - 1 || 1));
  return { stability: s, difficulty: d, reps: card.reps + 1, lapses: card.lapses, state: 'review', lastReview: now, due: now + iv * DAY };
}

/** Current recall probability for scheduling decisions and dashboards. */
export const retrievabilityNow = (c: Card, now = Date.now()) => (!c.lastReview || c.stability <= 0 ? 0 : retrievability((now - c.lastReview) / DAY, c.stability));

/** Map an evaluated composite score (0..1) + self-reported confidence (1..5) to an FSRS rating. Confidence only promotes to Easy; it never rescues a wrong answer. */
export function ratingFromScore(score: number, confidence?: number): Rating {
  if (score < 0.4) return 1;
  if (score < 0.65) return 2;
  if (score >= 0.92 && (confidence ?? 3) >= 4) return 4;
  return 3;
}
