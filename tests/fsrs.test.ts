import test from 'node:test';
import assert from 'node:assert/strict';
import { newCard, review, retrievability, intervalFor, initStability, initDifficulty, ratingFromScore, retrievabilityNow, W } from '../src/lib/recall/fsrs.ts';

const DAY = 86_400_000; const T0 = Date.UTC(2026, 0, 1);

test('FSRS: retrievability is 90% at t = stability and decays monotonically', () => {
  assert.ok(Math.abs(retrievability(10, 10) - 0.9) < 1e-9);
  assert.ok(retrievability(1, 10) > retrievability(5, 10) && retrievability(5, 10) > retrievability(30, 10));
  assert.equal(retrievability(0, 10), 1);
});
test('FSRS: interval for 90% retention equals stability (rounded)', () => {
  assert.equal(intervalFor(3.7145), 4); assert.equal(intervalFor(10), 10);
  assert.ok(intervalFor(10, 0.8) > intervalFor(10, 0.9));
});
test('FSRS: first review sets initial stability from the rating; Again goes to a short relearn step', () => {
  assert.equal(initStability(3), W[2]); assert.ok(initDifficulty(1) > initDifficulty(4));
  const good = review(newCard(T0), 3, T0); assert.equal(good.state, 'review'); assert.equal(Math.round((good.due - T0) / DAY), 4);
  const easy = review(newCard(T0), 4, T0); assert.ok(easy.due > good.due);
  const again = review(newCard(T0), 1, T0); assert.equal(again.state, 'learning'); assert.equal(again.due - T0, 10 * 60_000);
});
test('FSRS: successful reviews on time grow the interval; a lapse shrinks stability and schedules sooner', () => {
  let c = review(newCard(T0), 3, T0); let prev = c.stability; let t = c.due;
  for (let i = 0; i < 4; i++) { c = review(c, 3, t); assert.ok(c.stability > prev, `stability must grow (${prev} -> ${c.stability})`); prev = c.stability; t = c.due; }
  assert.ok(prev > 30, 'after 5 successful reviews the stability should be well over a month');
  const lapsed = review(c, 1, t); assert.ok(lapsed.stability < c.stability); assert.equal(lapsed.state, 'relearning'); assert.equal(lapsed.lapses, 1);
});
test('FSRS: Hard < Good < Easy for the next interval; reviewing late helps more than early', () => {
  const base = review(newCard(T0), 3, T0); const t = base.due;
  const [h, g, e] = [2, 3, 4].map((r) => review(base, r as 2 | 3 | 4, t));
  assert.ok(h.due <= g.due && g.due < e.due, 'Hard <= Good < Easy');
  const early = review(base, 3, T0 + DAY), late = review(base, 3, t + 10 * DAY);
  assert.ok(late.stability > early.stability, 'a successful recall after longer forgetting strengthens memory more');
});
test('FSRS: difficulty stays within 1..10 and rises after Again', () => {
  let c = review(newCard(T0), 3, T0); const d0 = c.difficulty;
  for (let i = 0; i < 30; i++) c = review(c, 1, c.due);
  assert.ok(c.difficulty >= d0 && c.difficulty <= 10);
  let e = review(newCard(T0), 4, T0); for (let i = 0; i < 30; i++) e = review(e, 4, e.due);
  assert.ok(e.difficulty >= 1);
});
test('rating mapping: wrong answers are never rescued by confidence; Easy needs high score and confidence', () => {
  assert.equal(ratingFromScore(0.2, 5), 1); assert.equal(ratingFromScore(0.5), 2); assert.equal(ratingFromScore(0.8, 5), 3); assert.equal(ratingFromScore(0.95, 5), 4); assert.equal(ratingFromScore(0.95, 2), 3);
});
test('retrievabilityNow is 0 for never-reviewed cards', () => { assert.equal(retrievabilityNow(newCard(T0), T0), 0); });
