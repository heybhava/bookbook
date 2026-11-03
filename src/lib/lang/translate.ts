// Translation engine: provider/model routing, cache + version history, glossary, formula masking, output validation.
// Providers: (1) optional NLLB-200 / IndicTrans2 HTTP server (NLLB_URL, see scripts/translate_server.py), (2) local Ollama models.
import crypto from 'node:crypto';
import { all, get, run, uid, LOCAL_USER } from '../db';
import * as ollama from '../ollama';
import { getLang, detectLanguage, langName } from './registry';

export type Quality = 'dedicated' | 'official' | 'broad' | 'none';
export interface Route { provider: 'nllb' | 'ollama' | 'none'; model: string | null; quality: Quality; reason: string; alternatives: { model: string; quality: Quality; how: string }[] }

// What each Ollama model family is documented to support. 'official' = listed by the model authors; 'broad' = trained on many languages
// but low-resource ones (Telugu, Tamil, …) are known to be weaker; 'none' = not supported.
const OFFICIAL: { re: RegExp; langs: string[] }[] = [
  { re: /^llama3\.[123]/, langs: ['en', 'de', 'fr', 'it', 'pt', 'hi', 'es', 'th'] },
  { re: /^aya/, langs: ['ar', 'zh-Hans', 'zh-Hant', 'cs', 'nl', 'en', 'fr', 'de', 'el', 'he', 'hi', 'id', 'it', 'ja', 'ko', 'fa', 'pl', 'pt', 'ro', 'ru', 'es', 'tr', 'uk', 'vi'] },
  { re: /^mistral/, langs: ['en', 'fr', 'de', 'es', 'it'] },
  { re: /^phi/, langs: ['en'] },
];
const BROAD = /^(gemma3|gemma2|qwen3|qwen2\.5|qwen2|command-r|glm)/; // gemma3: 140+ languages, qwen3: 119 languages (vendor claims)
const EXCLUDE_BROAD = new Set(['sat', 'mni', 'brx', 'doi', 'ks', 'kok', 'sd', 'mai', 'as', 'la', 'ig', 'st', 'xh', 'mg']); // too rarely covered to claim

const family = (name: string) => name.replace(/^.*\//, '').toLowerCase();
function modelQuality(model: string, code: string): Quality {
  const f = family(model);
  for (const o of OFFICIAL) if (o.re.test(f)) return o.langs.includes(code) || o.langs.includes(code.split('-')[0]) ? 'official' : 'none';
  if (BROAD.test(f)) return EXCLUDE_BROAD.has(code) ? 'none' : (['te', 'ta', 'kn', 'ml', 'bn', 'mr', 'gu', 'pa', 'or', 'ur', 'ne', 'si', 'my', 'km', 'lo', 'am', 'sw', 'so', 'ha', 'yo', 'zu', 'af', 'ps'].includes(code) ? 'broad' : 'official');
  return 'none';
}
const SIZE_RANK = (m: string) => { const x = /(\d+(?:\.\d+)?)b/.exec(m); return x ? Number(x[1]) : 4; };

const nllbOn = () => !!process.env.NLLB_URL;

export async function routeFor(src: string, tgt: string): Promise<Route> {
  const sl = getLang(src), tl = getLang(tgt);
  if (!tl) return { provider: 'none', model: null, quality: 'none', reason: `Unknown language "${tgt}".`, alternatives: [] };
  if (nllbOn() && tl.nllb && (!sl || sl.nllb)) return { provider: 'nllb', model: process.env.NLLB_MODEL || 'nllb-200', quality: 'dedicated', reason: 'Dedicated translation model (NLLB-200 / IndicTrans2 server).', alternatives: [] };
  const st = await ollama.status();
  if (!st.online) return { provider: 'none', model: null, quality: 'none', reason: 'Ollama is not running, and no dedicated translation server (NLLB_URL) is configured.', alternatives: [] };
  const chatModels = st.models.filter((m) => !m.embedding).map((m) => m.name);
  const pref = ollama.getPref('lang.model');
  const scored = chatModels.map((m) => ({ m, q: Math.min(rank(modelQuality(m, tl.code)), sl && sl.code !== 'en' ? rank(modelQuality(m, sl.code)) : 9) })).sort((a, b) => b.q - a.q || SIZE_RANK(b.m) - SIZE_RANK(a.m));
  const chosen = (pref && scored.find((s) => s.m === pref && s.q > 0)) || scored[0];
  const alts: Route['alternatives'] = [];
  if (!chosen || chosen.q <= 1) {
    for (const rec of ['gemma3:4b', 'qwen3:8b']) if (!chatModels.some((m) => family(m).startsWith(rec.split(':')[0]))) alts.push({ model: rec, quality: 'broad', how: `ollama pull ${rec}  (Settings → Download a model)` });
    alts.push({ model: 'NLLB-200 / IndicTrans2', quality: 'dedicated', how: 'Run scripts/translate_server.py and set NLLB_URL (needs Python, PyTorch and a one-time model download).' });
  }
  if (!chosen || chosen.q === 0) return { provider: 'none', model: null, quality: 'none', reason: `None of your installed models (${chatModels.join(', ') || 'none'}) supports ${tl.en}.`, alternatives: alts };
  const quality = unrank(chosen.q);
  const reason = quality === 'official' ? `${chosen.m} officially supports ${tl.en}.` : `${chosen.m} was trained on ${tl.en} but low-resource languages are weaker: review important translations.`;
  return { provider: 'ollama', model: chosen.m, quality, reason, alternatives: alts };
}
const rank = (q: Quality) => ({ dedicated: 3, official: 3, broad: 1, none: 0 }[q]);
const unrank = (n: number): Quality => (n >= 3 ? 'official' : n >= 1 ? 'broad' : 'none');

// ── protecting formulas, code, URLs ──
const PROTECT = [/`[^`]+`/g, /\$[^$\n]{1,200}\$/g, /\bhttps?:\/\/\S+/g, /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g,
  /(?:[A-Za-zΑ-Ωα-ω_][\w()\[\]^]*|\d[\d.,]*)(?:\s*[=+\-*/^<>≤≥≈×÷±]\s*(?:[A-Za-zΑ-Ωα-ω_][\w()\[\]^]*|\d[\d.,]*|\([^)]{1,30}\))){2,}/g, /[∑∫√∂Δπ][^\s,;]*/g];
export function mask(text: string, terms: Term[] = []) {
  const tokens: string[] = []; let out = text;
  // glossary terms are substituted deterministically (the model never gets to re-translate or transliterate them)
  for (const t of terms) {
    const esc = t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${esc}(?:s|es)?\\b`, 'gi'), (m) => { tokens.push(t.mode === 'keep' ? m : t.mode === 'both' ? `${t.translation} (${m})` : String(t.translation)); return `[[X${tokens.length - 1}]]`; });
  }
  for (const re of PROTECT) out = out.replace(re, (m) => { tokens.push(m); return `[[X${tokens.length - 1}]]`; });
  return { out, tokens };
}
export const unmask = (text: string, tokens: string[]) => text.replace(/\[\[\s*X\s*(\d+)\s*\]\]/g, (_, i) => tokens[Number(i)] ?? '');
const missingTokens = (text: string, n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => !new RegExp(`\\[\\[\\s*X\\s*${i}\\s*\\]\\]`).test(text));

// ── glossary ──
export interface Term { term: string; lang: string; translation: string | null; mode: 'keep' | 'translate' | 'both' }
export function glossaryFor(bookId: string | null, tgt: string): Term[] {
  return all<any>(`SELECT term, lang, translation, mode FROM glossary WHERE user_id = ? AND lang = ? AND (book_id IS NULL ${bookId ? 'OR book_id = ?' : ''}) ORDER BY length(term) DESC`, LOCAL_USER, tgt, ...(bookId ? [bookId] : []));
}
const termsIn = (g: Term[], text: string) => g.filter((t) => text.toLowerCase().includes(t.term.toLowerCase()));

const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
const ENGINE_V = 3; // bump when translation behaviour changes so stale cache entries are not reused
const keyOf = (text: string, src: string, tgt: string, g: Term[]) => sha(`v${ENGINE_V}|${src}|${tgt}|${text}|${g.map((t) => `${t.term}=${t.mode}:${t.translation ?? ''}`).sort().join(';')}`);

export function cached(key: string) {
  return get<any>('SELECT id, text, model, provider, version, corrected, warnings FROM translations WHERE key = ? ORDER BY version DESC LIMIT 1', key);
}
function store(key: string, src: string, tgt: string, source: string, text: string, model: string | null, provider: string, warnings: string[], ctx: { bookId?: string | null; page?: number | null }, corrected = 0) {
  const ver = (get<{ v: number }>('SELECT MAX(version) v FROM translations WHERE key = ?', key)?.v ?? 0) + 1;
  run('INSERT INTO translations (id, key, src_lang, tgt_lang, source, text, model, provider, version, corrected, warnings, book_id, page, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    uid(), key, src, tgt, source, text, model, provider, ver, corrected, warnings.length ? JSON.stringify(warnings) : null, ctx.bookId ?? null, ctx.page ?? null, Date.now());
}

const scriptRatio = (text: string, code: string) => {
  const l = getLang(code); if (!l || l.script === 'Latn') return 1;
  const d = detectLanguage(text); const letters = (text.match(/\p{L}/gu) ?? []).length || 1;
  const target = getLang(d.code)?.script === l.script ? 1 : 0;
  if (target) return 1;
  // fall back to counting characters of the script via detection on slices
  const first = text.match(/\p{L}+/gu) ?? []; const ok = first.filter((w) => getLang(detectLanguage(w).code)?.script === l.script).length;
  return ok / Math.max(1, first.length) * (letters > 0 ? 1 : 0);
};

async function llm(model: string, system: string, user: string): Promise<string> {
  const r = await fetch(`${ollama.OLLAMA_URL}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, think: false, format: 'json', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], options: { temperature: 0.1, num_ctx: 8192, num_predict: 3500, repeat_penalty: 1.05 } }) });
  if (!r.ok) throw new Error(`Ollama error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return String((await r.json()).message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
}

export interface TOpts { src?: string; tgt: string; bookId?: string | null; page?: number | null; context?: string; force?: boolean }
export interface TItem { text: string; translation: string; cached: boolean; warnings: string[]; version?: number; corrected?: boolean }

/** Translate many segments (paragraphs/sentences) at once, keeping them aligned 1:1. */
export async function translateBatch(texts: string[], o: TOpts): Promise<{ items: TItem[]; route: Route; src: string }> {
  const detected = o.src ?? detectLanguage(texts.join(' ')).code;
  const src = detected;
  if (src === o.tgt) return { items: texts.map((t) => ({ text: t, translation: t, cached: true, warnings: [] })), route: await routeFor(src, o.tgt), src };
  const route = await routeFor(src, o.tgt);
  const g = glossaryFor(o.bookId ?? null, o.tgt);
  const items: TItem[] = new Array(texts.length);
  const todo: { i: number; key: string; masked: string; tokens: string[]; terms: Term[] }[] = [];
  texts.forEach((t, i) => {
    if (!t.trim()) { items[i] = { text: t, translation: t, cached: true, warnings: [] }; return; }
    const terms = termsIn(g, t); const key = keyOf(t, src, o.tgt, terms);
    const c = o.force ? null : cached(key);
    if (c) { items[i] = { text: t, translation: c.text, cached: true, warnings: c.warnings ? JSON.parse(c.warnings) : [], version: c.version, corrected: !!c.corrected }; return; }
    const m = mask(t, terms); todo.push({ i, key, masked: m.out, tokens: m.tokens, terms });
  });
  if (!todo.length) return { items, route, src };
  if (route.provider === 'none') throw Object.assign(new Error(`${route.reason}${route.alternatives.length ? ' Options: ' + route.alternatives.map((a) => a.how).join(' · ') : ''}`), { route });

  const SL = langName(src), TL = langName(o.tgt);
  // batches of ~3500 chars keep alignment reliable for small local models
  const batches: typeof todo[] = []; let cur: typeof todo = []; let len = 0;
  for (const t of todo) { if (cur.length && (len + t.masked.length > 3500 || cur.length >= 12)) { batches.push(cur); cur = []; len = 0; } cur.push(t); len += t.masked.length; }
  if (cur.length) batches.push(cur);

  for (const b of batches) {
    const terms = [...new Map(b.flatMap((x) => x.terms).map((t) => [t.term.toLowerCase(), t])).values()];
    const rules = terms.length ? ['- [[Xn]] placeholders may stand for technical terms: leave them in the right place in the sentence.'] : [];
    const sys = `You are a professional translator from ${SL} into ${TL}. Translate each numbered segment faithfully and naturally into ${TL}, using the native script. Rules:
- Return ONLY JSON: {"t":["translation 1","translation 2",...]} with exactly ${b.length} strings, in order.
- Keep every [[Xn]] placeholder exactly as written (they stand for formulas, code, numbers or URLs).
- Do not add, omit or explain anything. Do not translate proper names of people; transliterate them if the script requires.
- Keep technical terminology consistent and accurate for the subject.${o.context ? `\nContext: ${o.context}` : ''}${rules.length ? `\nTerminology:\n${rules.join('\n')}` : ''}`;
    const user = b.map((x, k) => `${k + 1}. ${x.masked}`).join('\n');
    let outs: string[] | null = null; let model = route.model;
    for (let attempt = 0; attempt < 2 && !outs; attempt++) {
      try {
        let arr: unknown;
        if (route.provider === 'nllb') {
          const r = await fetch(process.env.NLLB_URL!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts: b.map((x) => x.masked), src: getLang(src)?.nllb, tgt: getLang(o.tgt)?.nllb, src_code: src, tgt_code: o.tgt }) });
          if (!r.ok) throw new Error(`Translation server error ${r.status}`); arr = (await r.json()).translations;
        } else arr = ollama.parseJson<{ t: unknown[] }>(await llm(route.model!, sys, user))?.t;
        if (Array.isArray(arr) && arr.length === b.length && arr.every((x) => typeof x === 'string')) outs = arr as string[];
      } catch (e: any) { if (attempt) throw e; }
    }
    if (!outs) { // alignment failed: translate one by one
      outs = [];
      for (const x of b) {
        const one = route.provider === 'ollama' ? ollama.parseJson<{ t: string[] }>(await llm(route.model!, sys.replace(`exactly ${b.length} strings`, 'exactly 1 string'), `1. ${x.masked}`))?.t?.[0] : null;
        outs.push(typeof one === 'string' ? one : '');
      }
    }
    b.forEach((x, k) => {
      const warnings: string[] = []; let t = String(outs![k] ?? '').trim();
      const miss = missingTokens(t, x.tokens.length);
      if (miss.length) { warnings.push('A formula/number token was lost in translation and has been appended; check this passage.'); t += ' ' + miss.map((i) => x.tokens[i]).join(' '); t = t.replace(/\[\[\s*X\s*\d+\s*\]\]/g, ''); }
      t = unmask(t, x.tokens);
      if (!t) warnings.push('The model returned nothing for this segment; original shown.');
      else if (getLang(o.tgt)?.script !== 'Latn' && x.masked.replace(/\[\[X\d+\]\]/g, '').length > 40 && scriptRatio(t, o.tgt) < 0.5) warnings.push(`Output does not look like ${getLang(o.tgt)?.en} script — the model may not support this language well.`);
      if (route.quality === 'broad') warnings.push('Low-resource language on a general model: review before relying on it.');
      const finalText = t || x.masked;
      if (t) store(x.key, src, o.tgt, texts[x.i], finalText, model, route.provider, warnings, o);
      items[x.i] = { text: texts[x.i], translation: finalText, cached: false, warnings };
    });
  }
  return { items, route, src };
}

/** User correction: stored as a new, higher version so history is kept and future requests use it. */
export function correctTranslation(source: string, translation: string, o: { src: string; tgt: string; bookId?: string | null; page?: number | null }) {
  const g = glossaryFor(o.bookId ?? null, o.tgt); const key = keyOf(source, o.src, o.tgt, termsIn(g, source));
  store(key, o.src, o.tgt, source, translation, 'user', 'user', [], o, 1);
}
export const history = (source: string, o: { src: string; tgt: string; bookId?: string | null }) => {
  const g = glossaryFor(o.bookId ?? null, o.tgt); const key = keyOf(source, o.src, o.tgt, termsIn(g, source));
  return all<any>('SELECT version, text, model, provider, corrected, created_at FROM translations WHERE key = ? ORDER BY version DESC', key);
};

export async function bookContext(bookId: string | null | undefined, page?: number | null) {
  if (!bookId) return '';
  const b = get<any>('SELECT title, author FROM books WHERE id = ?', bookId);
  const ch = page ? get<any>('SELECT title FROM chapters WHERE book_id = ? AND start_page <= ? ORDER BY start_page DESC LIMIT 1', bookId, page) : null;
  const pi = page ? get<any>('SELECT data FROM page_intel WHERE book_id = ? AND page = ?', bookId, page) : null;
  const subject = pi ? JSON.parse(pi.data)?.basic?.subjects?.[0]?.id : null;
  return [b && `Book "${b.title}"${b.author ? ` by ${b.author}` : ''}`, ch && `chapter "${ch.title}"`, subject && `subject: ${subject}`].filter(Boolean).join(', ');
}

/** Split a page into aligned paragraphs (the reader's own paragraph structure). */
export const paragraphs = (pageText: string) => pageText.split(/\n+/).map((s) => s.trim()).filter(Boolean);

/** For retrieval: a non-English question is also searched in English (via the local translator), so a Telugu/Tamil/Hindi query finds English passages. */
export async function queryVariants(q: string, bookLang = 'en'): Promise<{ lang: string; confidence: number; english: string | null; combined: string }> {
  const d = detectLanguage(q);
  if (d.code === bookLang || d.code === 'en' || d.confidence < 0.4) return { lang: d.code, confidence: d.confidence, english: null, combined: q };
  try {
    const r = await translateBatch([q], { src: d.code, tgt: bookLang });
    const en = r.items[0].translation;
    return { lang: d.code, confidence: d.confidence, english: en, combined: `${q} ${en}` };
  } catch { return { lang: d.code, confidence: d.confidence, english: null, combined: q }; }
}

/** System-prompt fragment so the tutor answers in the right language, understands code-switching and keeps citations intact. */
export function languageInstruction(answerLang: string, qLang: string, glossaryNote = ''): string {
  const L = getLang(answerLang);
  if (!L) return '';
  return `\nLANGUAGE: Reply in ${L.en} (${L.native}), using its native script.${answerLang !== 'en' ? ` The reader may mix ${L.en} with English technical terms (code-switching) — understand it naturally and keep established English technical terms as the reader uses them.` : ''} Keep source citations like [S1] exactly as written, do not translate quotations from the book without saying they are translated, and never change formulas or code.${glossaryNote}${qLang !== answerLang ? ` (The question was written in ${getLang(qLang)?.en ?? qLang}.)` : ''}`;
}
