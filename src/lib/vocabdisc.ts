// Automatic vocabulary discovery: finds words on a page that are worth learning, using only local data
// (WordNet sense frequencies as a rarity proxy + CMU/WordNet lookups). No network, no model required.
import { all, LOCAL_USER } from './db';
import { lookup, frequencies, levelOf, wordCandidates, hasWord, type Level } from './dictionary';

const STOP = new Set(('about above after again against because before being below between both could during each from further have having herself himself into itself might more most myself once only other ought ourselves over same should some such than that their theirs them themselves then there these they this those through under until very were what when where which while whom with would your yours yourself yourselves also however therefore whether although within without among across around since upon toward towards often rather perhaps already always never every another several many much').split(' '));

export interface Candidate {
  word: string; lemma: string; level: Level; count: number; start: number; end: number; sentence: string;
  definition?: string; pos?: string; ipa?: string; known?: boolean;
}

const RANK: Record<Level, number> = { advanced: 0, term: 1, intermediate: 2, familiar: 3, common: 4, unknown: 5 };

export function knownWords(): Set<string> {
  const s = new Set<string>();
  for (const r of all<{ word: string }>('SELECT word FROM vocabulary WHERE user_id = ?', LOCAL_USER)) s.add(r.word.toLowerCase());
  for (const r of all<{ word: string }>('SELECT word FROM ignored_words WHERE user_id = ?', LOCAL_USER)) s.add(r.word.toLowerCase());
  return s;
}

function sentenceAround(text: string, a: number, b: number) {
  let s = a; while (s > 0 && !/[.!?\n]/.test(text[s - 1])) s--;
  let e = b; while (e < text.length && !/[.!?\n]/.test(text[e])) e++;
  return text.slice(s, Math.min(text.length, e + 1)).trim().slice(0, 500);
}

export async function discover(text: string, opts: { limit?: number; includeKnown?: boolean; withDefs?: boolean } = {}): Promise<Candidate[]> {
  const freq = await frequencies();
  const known = knownWords();
  const by = new Map<string, Candidate>();
  const re = /[A-Za-z][A-Za-z'’-]{4,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const surface = m[0].replace(/['’-]+$/, '');
    const low = surface.toLowerCase();
    if (STOP.has(low) || low.length < 5) continue;
    // proper nouns: capitalised mid-sentence
    if (/^[A-Z]/.test(surface) && m.index > 0 && !/[.!?"“\n]\s*$/.test(text.slice(Math.max(0, m.index - 3), m.index)) && !/^[A-Z]{2,}$/.test(surface)) continue;
    const lemma = wordCandidates(low).find((c) => freq.has(c)) ?? (await hasWord(low) ? low : null);
    const cached = by.get(lemma ?? low);
    if (cached) { cached.count++; continue; }
    const f = lemma ? freq.get(lemma) ?? 0 : 0;
    const level = levelOf(!!lemma, f, low);
    const interesting = level === 'advanced' || level === 'term' || (level === 'intermediate' && low.length >= 9);
    if (!interesting) continue;
    if (!opts.includeKnown && (known.has(low) || (lemma && known.has(lemma)))) continue;
    by.set(lemma ?? low, { word: low, lemma: lemma ?? low, level, count: 1, start: m.index, end: m.index + m[0].length, sentence: sentenceAround(text, m.index, m.index + m[0].length), known: known.has(low) });
  }
  // technical terms (not in WordNet) only if repeated, otherwise they are usually names or typos
  const out = [...by.values()].filter((c) => c.level !== 'term' || c.count >= 2)
    .sort((a, b) => RANK[a.level] - RANK[b.level] || b.count - a.count || b.word.length - a.word.length)
    .slice(0, opts.limit ?? 14);
  if (opts.withDefs !== false) {
    for (const c of out) {
      const d = await lookup(c.word);
      if (d.senses[0]) { c.definition = d.senses[0].definition; c.pos = d.senses[0].pos; }
      c.ipa = d.ipa;
    }
  }
  return out;
}
