import test from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../src/lib/srs.ts';
import { arpaToIpa, lookup } from '../src/lib/dictionary.ts';
import { paginate } from '../src/lib/extract/index.ts';

test('SRS: failing resets interval and lowers ease', () => {
  const r = schedule({ ease: 2.5, interval_days: 10, reps: 5 }, 0, 0);
  assert.equal(r.reps, 0);
  assert.equal(r.interval_days, 0);
  assert.ok(r.ease < 2.5);
  assert.equal(r.due_at, 10 * 60_000);
});

test('SRS: intervals grow with successful reviews', () => {
  let s = { ease: 2.5, interval_days: 0, reps: 0, lapses: 0 };
  const days: number[] = [];
  for (let i = 0; i < 4; i++) { const n = schedule(s, 2, 0); days.push(n.interval_days); s = { ...n }; }
  assert.deepEqual(days.slice(0, 2), [1, 6]);
  assert.ok(days[3] > days[2] && days[2] > days[1]);
});

test('SRS: ease never drops below 1.3', () => {
  let s = { ease: 1.35, interval_days: 3, reps: 3, lapses: 0 };
  for (let i = 0; i < 5; i++) s = { ...schedule(s, 0, 0) };
  assert.ok(s.ease >= 1.3);
});

test('ARPAbet to IPA puts stress at syllable start', () => {
  assert.equal(arpaToIpa('R AH1 N IH0 NG'), 'ˈɹʌnɪŋ');
  assert.equal(arpaToIpa('HH AH0 L OW1'), 'həˈloʊ');
});

test('offline dictionary: definitions, synonyms, IPA, inflection', async () => {
  const d = await lookup('ephemeral');
  assert.ok(d.found);
  assert.ok(d.ipa?.startsWith('/'));
  assert.ok(d.senses.some((s) => s.pos === 'adjective' && /short/.test(s.definition)));
  assert.ok(d.senses.flatMap((s) => s.synonyms).includes('transient'));
  assert.equal((await lookup('Walked,')).lemma, 'walk');
  assert.equal((await lookup('zzqxqz')).found, false);
});

test('antonyms are returned for adjectives', async () => {
  const d = await lookup('happy');
  assert.ok(d.senses.flatMap((s) => s.antonyms).length > 0);
});

test('paginate keeps content intact and splits huge paragraphs', () => {
  const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ` + 'word '.repeat(80));
  const pages = paginate(paras, 0);
  assert.ok(pages.length > 1);
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(pages.map((p) => p.text).join(' ')), norm(paras.join(' ')));
  assert.ok(paginate(['Sentence one is here. '.repeat(400)], 0).length > 1);
});
