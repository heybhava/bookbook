// Fully offline dictionary: Princeton WordNet 3.1 (definitions, synonyms, antonyms, examples, related)
// + CMU Pronouncing Dictionary (American IPA). No network, no API.
import fs from 'node:fs';
import path from 'node:path';

const POS_FILES = { n: 'noun', v: 'verb', a: 'adj', r: 'adv' } as const;
type Pos = keyof typeof POS_FILES;
const POS_NAME: Record<string, string> = { n: 'noun', v: 'verb', a: 'adjective', s: 'adjective', r: 'adverb' };

interface Store { index: Map<string, { pos: Pos; offsets: string[] }[]>; data: Record<Pos, Map<string, string>>; cmu: Record<string, string> | null }
const g = globalThis as unknown as { __wn?: Promise<Store> };

function dictDir() {
  // wordnet-db is externalised; resolve its dict dir from node_modules
  for (const base of ['node_modules', '_nm']) { const p = path.join(process.cwd(), base, 'wordnet-db', 'dict'); if (fs.existsSync(p)) return p; } // packaged desktop app ships modules as _nm
  return path.join(process.cwd(), 'node_modules', 'wordnet-db', 'dict');
}

async function load(): Promise<Store> {
  const dir = dictDir();
  const index: Store['index'] = new Map();
  const data = {} as Store['data'];
  for (const p of Object.keys(POS_FILES) as Pos[]) {
    const f = POS_FILES[p];
    for (const line of fs.readFileSync(path.join(dir, `index.${f}`), 'utf8').split('\n')) {
      if (!line || line.startsWith(' ')) continue;
      const t = line.split(' ');
      const ptrCnt = Number(t[3]);
      const offsets = t.slice(6 + ptrCnt).filter((x) => /^\d{8}$/.test(x));
      const arr = index.get(t[0]) ?? [];
      arr.push({ pos: p, offsets });
      index.set(t[0], arr);
    }
    const m = new Map<string, string>();
    for (const line of fs.readFileSync(path.join(dir, `data.${f}`), 'utf8').split('\n')) {
      if (!line || line.startsWith(' ')) continue;
      m.set(line.slice(0, 8), line);
    }
    data[p] = m;
  }
  let cmu: Store['cmu'] = null;
  try { cmu = (await import('cmu-pronouncing-dictionary')).dictionary; } catch { /* pronunciation optional */ }
  return { index, data, cmu };
}
const store = () => (g.__wn ??= load());

function parseSynset(line: string) {
  const [head, gloss = ''] = line.split(' | ');
  const t = head.split(' ');
  const wcnt = parseInt(t[3], 16);
  const words: string[] = [];
  for (let i = 0; i < wcnt; i++) words.push(t[4 + i * 2].replace(/\(.*\)$/, '').replace(/_/g, ' '));
  let k = 4 + wcnt * 2;
  const pcnt = Number(t[k++]);
  const ptrs: { sym: string; off: string; pos: string; src: number; tgt: number }[] = [];
  for (let i = 0; i < pcnt; i++, k += 4) {
    const st = t[k + 3];
    ptrs.push({ sym: t[k], off: t[k + 1], pos: t[k + 2], src: parseInt(st.slice(0, 2), 16), tgt: parseInt(st.slice(2), 16) });
  }
  const examples = [...gloss.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const definition = gloss.split(';').filter((s) => !s.trim().startsWith('"'))[0]?.trim() ?? gloss;
  return { words, ptrs, examples, definition };
}

const ARPA: Record<string, string> = {
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ', B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', EH: 'ɛ', ER: 'ɝ', EY: 'eɪ', F: 'f', G: 'ɡ', HH: 'h',
  IH: 'ɪ', IY: 'i', JH: 'dʒ', K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ', OW: 'oʊ', OY: 'ɔɪ', P: 'p', R: 'ɹ', S: 's', SH: 'ʃ', T: 't', TH: 'θ',
  UH: 'ʊ', UW: 'u', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};
export function arpaToIpa(arpa: string): string {
  const toks: { s: string; vowel: boolean; stress?: string }[] = [];
  for (const p of arpa.split(' ')) {
    const m = p.match(/^([A-Z]+)([012])?$/); if (!m) continue;
    let s = ARPA[m[1]] ?? '';
    if (m[1] === 'AH' && m[2] === '0') s = 'ə';
    if (m[1] === 'ER' && m[2] === '0') s = 'ɚ';
    toks.push({ s, vowel: m[2] !== undefined, stress: m[2] === '1' ? 'ˈ' : m[2] === '2' ? 'ˌ' : undefined });
  }
  // put the stress mark at the start of the syllable (before its onset consonants), not before the vowel
  const ins = new Map<number, string>();
  toks.forEach((t, i) => { if (!t.stress) return; let j = i; while (j > 0 && !toks[j - 1].vowel) j--; ins.set(j, t.stress); });
  return toks.map((t, i) => (ins.get(i) ?? '') + t.s).join('');
}

function candidates(w: string): string[] {
  const c = [w];
  const rules: [RegExp, string][] = [[/ies$/, 'y'], [/ied$/, 'y'], [/ves$/, 'f'], [/(s|x|z|ch|sh)es$/, '$1'], [/s$/, ''], [/ed$/, ''], [/ed$/, 'e'], [/ing$/, ''], [/ing$/, 'e'], [/([^aeiou])\1ing$/, '$1'], [/([^aeiou])\1ed$/, '$1'], [/er$/, ''], [/est$/, ''], [/ly$/, ''], [/ier$/, 'y'], [/iest$/, 'y']];
  for (const [re, rep] of rules) if (re.test(w)) c.push(w.replace(re, rep));
  return [...new Set(c)];
}

export interface DictResult {
  word: string; lemma: string | null; found: boolean; ipa?: string; arpabet?: string;
  senses: { pos: string; definition: string; examples: string[]; synonyms: string[]; antonyms: string[]; related: string[] }[];
  family: string[]; level: Level; freq: number;
  source: string; pronunciationNote: string;
}

export async function lookup(raw: string): Promise<DictResult> {
  const { index, data, cmu } = await store();
  const word = raw.trim().toLowerCase().replace(/[“”"’‘]/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
  const res: DictResult = { word, lemma: null, found: false, senses: [], family: [], level: 'unknown', freq: 0, source: 'WordNet 3.1 + CMU Pronouncing Dictionary (offline)', pronunciationNote: 'IPA is General American (CMU dictionary). Use the voice selector for British/Australian audio — IPA for those accents is not generated.' };
  if (cmu) {
    const a = cmu[word] ?? cmu[candidates(word).find((c) => cmu[c]) ?? ''];
    if (a) { res.arpabet = a; res.ipa = `/${arpaToIpa(a)}/`; }
  }
  const key = candidates(word.replace(/ /g, '_')).find((c) => index.has(c));
  if (!key) return res;
  res.found = true; res.lemma = key;
  { const f = await frequencies(); res.freq = f.get(key) ?? 0; res.level = levelOf(true, res.freq, key); }
  for (const e of index.get(key)!) {
    for (const off of e.offsets.slice(0, 4)) {
      const line = data[e.pos].get(off); if (!line) continue;
      const ss = parseSynset(line);
      const synonyms = ss.words.filter((w) => w.toLowerCase() !== key.replace(/_/g, ' '));
      const antonyms: string[] = []; const related: string[] = [];
      for (const p of ss.ptrs) {
        const tpos = (p.pos === 's' ? 'a' : p.pos) as Pos;
        const tl = data[tpos]?.get(p.off); if (!tl) continue;
        const t = parseSynset(tl);
        if (p.sym === '!') antonyms.push(...(p.tgt ? [t.words[p.tgt - 1]] : t.words.slice(0, 2)).filter(Boolean));
        else if (p.sym === '+') res.family.push(...(p.tgt ? [t.words[p.tgt - 1]] : t.words.slice(0, 2)).filter(Boolean));
        else if (['@', '~', '#m', '#p', '%m', '%p', '&', '^'].includes(p.sym)) related.push(...t.words.slice(0, 2));
      }
      res.senses.push({ pos: POS_NAME[ss.ptrs.length ? e.pos : e.pos] ?? e.pos, definition: ss.definition, examples: ss.examples, synonyms: synonyms.slice(0, 8), antonyms: [...new Set(antonyms)].slice(0, 6), related: [...new Set(related)].filter((r) => r.toLowerCase() !== key).slice(0, 8) });
      if (res.senses.length >= 6) { res.family = [...new Set(res.family)].filter((w) => w.toLowerCase() !== key).slice(0, 10); return res; }
    }
  }
  res.family = [...new Set(res.family)].filter((w) => w.toLowerCase() !== key).slice(0, 10);
  return res;
}

export type Level = 'common' | 'familiar' | 'intermediate' | 'advanced' | 'term' | 'unknown';

/** Summed WordNet/SemCor sense-tag counts per lemma: a free proxy for how common a word is. */
const gf = globalThis as unknown as { __wnfreq?: Promise<Map<string, number>> };
export function frequencies(): Promise<Map<string, number>> {
  return (gf.__wnfreq ??= (async () => {
    const m = new Map<string, number>();
    for (const line of fs.readFileSync(path.join(dictDir(), 'index.sense'), 'utf8').split('\n')) {
      const sp = line.split(' '); if (sp.length < 4) continue;
      const lemma = sp[0].split('%')[0];
      m.set(lemma, (m.get(lemma) ?? 0) + (Number(sp[3]) || 0));
    }
    return m;
  })());
}
/** Rank (1 = most common) in a 10,000-word English frequency list (public/dict/en-top10k.txt). */
const gr = globalThis as unknown as { __ranks?: Map<string, number> };
export function ranks(): Map<string, number> {
  if (!gr.__ranks) {
    const m = new Map<string, number>();
    try { fs.readFileSync(path.join(process.cwd(), 'public', 'dict', 'en-top10k.txt'), 'utf8').split('\n').forEach((w, i) => { const t = w.trim().toLowerCase(); if (t && !m.has(t)) m.set(t, i + 1); }); } catch { /* falls back to WordNet counts */ }
    gr.__ranks = m;
  }
  return gr.__ranks;
}
export function rankOf(word: string): number | undefined {
  const r = ranks();
  for (const c of candidates(word)) { const v = r.get(c); if (v) return v; }
  return undefined;
}
export function levelOf(inDict: boolean, freq: number, word: string): Level {
  const rank = rankOf(word);
  if (ranks().size) {
    if (rank !== undefined) return rank <= 3500 ? 'common' : rank <= 7000 ? 'familiar' : 'intermediate';
    return inDict ? 'advanced' : word.length >= 7 ? 'term' : 'unknown';
  }
  if (!inDict) return word.length >= 7 ? 'term' : 'unknown';
  if (freq >= 40) return 'common';
  if (freq >= 8) return 'familiar';
  if (freq >= 2) return 'intermediate';
  return 'advanced';
}
export async function hasWord(w: string) { return (await store()).index.has(w); }
export { candidates as wordCandidates };
