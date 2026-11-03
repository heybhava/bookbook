// Universal Language Intelligence endpoints: translation, glossary, word translations, speech availability, support matrix, tasks.
import crypto from 'node:crypto';
import { all, get, run, uid, me } from './db';
import * as ollama from './ollama';
import { LANGUAGES, getLang, detectLanguage, langName, bundledFont } from './lang/registry';
import { translateBatch, routeFor, correctTranslation, history, bookContext, paragraphs, glossaryFor, cached } from './lang/translate';
import { listVoiceInfo, engine as ttsEngine } from './intel/tts';
import { registerTask, createTask, cancelTask, resumeTask, listTasks, type Ctx } from './intel/tasks';
import { ensureBasic, pageIntel } from './intel/pageintel';
import type { Kit } from './routes2';

const now = () => Date.now();
const errJson = (e: any, J: Kit['J']) => J({ error: e?.message ?? String(e), route: e?.route, code: e?.route ? 'no-translation-route' : undefined }, e?.route ? 503 : 500);

const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

/** Translate a range of pages in the background; cached paragraphs are skipped, so cancel + resume lose nothing. */
registerTask('translate-pages', async ({ task, payload, update, cancelled }: Ctx) => {
  const bookId = task.book_id as string; const { tgt, from, to } = payload as { tgt: string; from: number; to: number };
  const pages = all<{ page: number; text: string }>('SELECT page, text FROM pages WHERE book_id = ? AND page BETWEEN ? AND ? ORDER BY page', bookId, from, to);
  let i = 0;
  for (const p of pages) {
    if (cancelled()) return;
    update(i / pages.length, `Translating page ${p.page} (${i + 1}/${pages.length})…`, 'generating');
    const ps = paragraphs(p.text); if (ps.length) await translateBatch(ps, { tgt, bookId, page: p.page, context: await bookContext(bookId, p.page) });
    i++;
  }
});

export function registerLang({ on, J, bad, body, book }: Kit) {
  on('GET', '/lang/route', async ({ q }) => J(await routeFor(q.get('src') ?? 'en', q.get('tgt') ?? 'te')));
  on('POST', '/lang/detect', async ({ req }) => { const { text } = await body(req); return detectLanguage(String(text ?? '')); });

  on('POST', '/translate', async ({ req }) => {
    const b = await body(req);
    const texts: string[] = Array.isArray(b.texts) ? b.texts.map(String) : typeof b.text === 'string' ? [b.text] : [];
    if (!texts.length || !b.tgt || !getLang(b.tgt)) return bad('texts and a valid target language (tgt) are required');
    if (texts.join('').length > 60000) return bad('Too much text for one request; translate page by page.');
    try {
      const r = await translateBatch(texts, { src: b.src, tgt: b.tgt, bookId: b.bookId ?? null, page: b.page ?? null, context: b.context ?? (await bookContext(b.bookId, b.page)), force: !!b.force });
      return { ...r, items: r.items };
    } catch (e) { return errJson(e, J); }
  });

  // page translation, streamed paragraph-group by paragraph-group so the reader fills in progressively
  on('POST', '/books/:id/pages/:page/translate', async ({ req, p }) => {
    const bk = book(p.id); if (!bk) return bad('Not found', 404);
    const b = await body(req); const page = Number(p.page);
    const row = get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', p.id, page);
    if (!row || !getLang(b.tgt)) return bad('page or language not found', 404);
    const ps = paragraphs(row.text); const ctx = await bookContext(p.id, page);
    const src = b.src ?? bk.language ?? detectLanguage(row.text).code;
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctrl) {
        const send = (o: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n'));
        try {
          const route = await routeFor(src, b.tgt);
          send({ type: 'meta', src: getLang(src)?.code ?? src, tgt: b.tgt, count: ps.length, route, rtl: !!getLang(b.tgt)?.rtl });
          for (let i = 0; i < ps.length; i += 4) {
            const r = await translateBatch(ps.slice(i, i + 4), { src, tgt: b.tgt, bookId: p.id, page, context: ctx, force: !!b.force });
            r.items.forEach((it, k) => send({ type: 'item', i: i + k, text: it.text, translation: it.translation, cached: it.cached, warnings: it.warnings, corrected: it.corrected }));
          }
          send({ type: 'done' });
        } catch (e: any) { send({ type: 'error', error: e?.message ?? String(e), route: e?.route }); }
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
  });

  on('POST', '/books/:id/translate-range', async ({ req, p }) => {
    const bk = book(p.id); if (!bk) return bad('Not found', 404);
    const b = await body(req); if (!getLang(b.tgt)) return bad('valid target language required');
    const from = Math.max(1, Number(b.from) || 1), to = Math.min(bk.page_count, Number(b.to) || from);
    const route = await routeFor(bk.language ?? 'en', b.tgt); if (route.provider === 'none') return J({ error: route.reason, route }, 503);
    return { taskId: createTask('translate-pages', p.id, { tgt: b.tgt, from, to }), route };
  });
  on('GET', '/books/:id/translation-coverage', ({ p, q }) => {
    const tgt = q.get('tgt') ?? 'te';
    const done = all<{ page: number }>('SELECT DISTINCT page FROM translations WHERE book_id = ? AND tgt_lang = ? AND page IS NOT NULL', p.id, tgt).map((r) => r.page);
    return { tgt, pages: done.length, total: get<{ n: number }>('SELECT COUNT(*) n FROM pages WHERE book_id = ?', p.id)?.n ?? 0 };
  });
  on('POST', '/translations/correct', async ({ req }) => {
    const b = await body(req); if (!b.source || !b.translation || !getLang(b.tgt)) return bad('source, translation and tgt required');
    correctTranslation(String(b.source), String(b.translation), { src: b.src ?? detectLanguage(b.source).code, tgt: b.tgt, bookId: b.bookId ?? null, page: b.page ?? null });
    return { ok: true };
  });
  on('POST', '/translations/history', async ({ req }) => { const b = await body(req); return history(String(b.source), { src: b.src ?? detectLanguage(b.source).code, tgt: b.tgt, bookId: b.bookId ?? null }); });

  // ── tasks (also used by other background features) ──
  on('GET', '/tasks', ({ q }) => listTasks(q.get('book')));
  on('POST', '/tasks/:id/cancel', ({ p }) => { cancelTask(p.id); return { ok: true }; });
  on('POST', '/tasks/:id/resume', ({ p }) => { resumeTask(p.id); return { ok: true }; });

  // ── glossary ──
  on('GET', '/glossary', ({ q }) => all(`SELECT * FROM glossary WHERE user_id = ? ${q.get('book') ? 'AND (book_id = ? OR book_id IS NULL)' : ''} ${q.get('lang') ? 'AND lang = ?' : ''} ORDER BY term`, me(), ...(q.get('book') ? [q.get('book')] : []), ...(q.get('lang') ? [q.get('lang')] : [])));
  on('POST', '/glossary', async ({ req }) => {
    const b = await body(req); const term = String(b.term ?? '').trim().slice(0, 80); if (!term || !getLang(b.lang)) return bad('term and lang required');
    const mode = ['keep', 'translate', 'both'].includes(b.mode) ? b.mode : 'keep';
    if (mode !== 'keep' && !String(b.translation ?? '').trim()) return bad('A translation is required unless the term is kept in English.');
    run(`INSERT INTO glossary (id, user_id, book_id, term, lang, translation, mode, origin, created_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, COALESCE(book_id, ''), lower(term), lang) DO UPDATE SET translation = excluded.translation, mode = excluded.mode`,
      uid(), me(), b.bookId ?? null, term, b.lang, b.translation ? String(b.translation).slice(0, 120) : null, mode, 'user', now());
    return { ok: true };
  });
  on('DELETE', '/glossary/:id', ({ p }) => { run('DELETE FROM glossary WHERE id = ? AND user_id = ?', p.id, me()); return { ok: true }; });
  on('POST', '/glossary/suggest', async ({ req }) => {
    const b = await body(req); if (!book(b.bookId)) return bad('Not found', 404);
    await ensureBasic(b.bookId);
    const freq = new Map<string, { term: string; count: number; page: number }>();
    for (const r of all<any>('SELECT page, data FROM page_intel WHERE book_id = ?', b.bookId)) {
      const d = JSON.parse(r.data); for (const t of d.basic?.terms ?? []) { const e = freq.get(t.word) ?? { term: t.word, count: 0, page: r.page }; e.count++; freq.set(t.word, e); }
      for (const df of d.basic?.definitions ?? []) { const k = String(df.term).toLowerCase(); const e = freq.get(k) ?? { term: df.term, count: 0, page: r.page }; e.count += 2; freq.set(k, e); }
    }
    const have = new Set(glossaryFor(b.bookId, b.lang).map((t) => t.term.toLowerCase()));
    return [...freq.values()].filter((t) => !have.has(t.term.toLowerCase()) && t.term.length > 3).sort((a, b2) => b2.count - a.count).slice(0, 40);
  });

  // ── word-level, multi-language ──
  on('POST', '/lang/word', async ({ req }) => {
    const b = await body(req); const word = String(b.word ?? '').trim().slice(0, 80); const targets: string[] = (Array.isArray(b.targets) ? b.targets : []).filter((t: string) => getLang(t)).slice(0, 6);
    if (!word || !targets.length) return bad('word and targets required');
    const sentence = String(b.sentence ?? '').slice(0, 500);
    const srcL = b.src ?? detectLanguage(`${word} ${sentence}`).code;
    const out: Record<string, any> = {}; const need: string[] = [];
    for (const t of targets) { const k = sha(`word|${srcL}|${t}|${word.toLowerCase()}|${sentence}`); const c = cached(k); if (c) out[t] = JSON.parse(c.text); else need.push(t); }
    if (need.length) {
      const model = (await routeFor(srcL, need[0])).model; if (!model) return J({ error: (await routeFor(srcL, need[0])).reason }, 503);
      try {
        const r = await ollama.aiFetch(`${ollama.OLLAMA_URL}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, think: false, format: 'json', options: { temperature: 0.1, num_ctx: 4096 }, messages: [
          { role: 'system', content: `You translate single words/phrases with attention to the sentence they appear in. Return ONLY JSON: {"<code>":{"word":"translation in native script","transliteration":"Latin transliteration","meaning":"short meaning in that language","contextual":"how it is used in THIS sentence, in that language"}} for each language code requested. Use the native script of each language.` },
          { role: 'user', content: `Word: "${word}" (${langName(srcL)})\nSentence: "${sentence}"\nTarget languages: ${need.map((t) => `${t} = ${langName(t)}`).join('; ')}` }] }) });
        const j = ollama.parseJson<Record<string, any>>(String((await r.json()).message?.content ?? '')) ?? {};
        for (const t of need) { const v = j[t]; if (v && typeof v.word === 'string') { const clean = { word: String(v.word).slice(0, 80), transliteration: String(v.transliteration ?? '').slice(0, 80), meaning: String(v.meaning ?? '').slice(0, 200), contextual: String(v.contextual ?? '').slice(0, 300), model };
          out[t] = clean; run('INSERT INTO translations (id, key, src_lang, tgt_lang, source, text, model, provider, version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', uid(), sha(`word|${srcL}|${t}|${word.toLowerCase()}|${sentence}`), srcL, t, word, JSON.stringify(clean), model, 'ollama', 1, now()); } }
      } catch (e: any) { return J({ error: e.message }, 502); }
    }
    return { word, src: srcL, translations: out };
  });
  on('POST', '/vocab/translations', async ({ req }) => {
    const b = await body(req); const word = String(b.word ?? '').trim().toLowerCase(); if (!word) return bad('word required');
    const cur = get<any>('SELECT id, translations FROM vocabulary WHERE user_id = ? AND word = ?', me(), word);
    const merged = { ...(cur?.translations ? JSON.parse(cur.translations) : {}), ...(b.translations ?? {}) };
    if (cur) run('UPDATE vocabulary SET translations = ?, user_notes = COALESCE(?, user_notes), lang = COALESCE(?, lang) WHERE id = ?', JSON.stringify(merged), b.notes ?? null, b.lang ?? null, cur.id);
    else run(`INSERT INTO vocabulary (id, user_id, word, definition, ipa, pos, sentence, book_id, page, created_at, due_at, translations, user_notes, lang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid(), me(), word, b.definition ?? null, b.ipa ?? null, b.pos ?? null, b.sentence ?? null, b.book_id ?? null, b.page ?? null, now(), now(), JSON.stringify(merged), b.notes ?? null, b.lang ?? null);
    return { ok: true, translations: merged };
  });

  // ── notes ──
  on('POST', '/notes/:id/translate', async ({ req, p }) => {
    const n = get<any>('SELECT id, body, book_id FROM notes WHERE id = ? AND user_id = ?', p.id, me()); if (!n) return bad('Not found', 404);
    const b = await body(req); if (!getLang(b.tgt)) return bad('valid tgt required');
    try {
      const r = await translateBatch([n.body], { tgt: b.tgt, bookId: n.book_id });
      const prev = get<{ version: number }>('SELECT version FROM note_translations WHERE note_id = ? AND lang = ?', p.id, b.tgt);
      run('INSERT INTO note_translations (note_id, lang, text, model, version, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(note_id, lang) DO UPDATE SET text = excluded.text, model = excluded.model, version = version + 1, created_at = excluded.created_at',
        p.id, b.tgt, r.items[0].translation, r.route.model, (prev?.version ?? 0) + 1, now());
      return { text: r.items[0].translation, warnings: r.items[0].warnings, route: r.route };
    } catch (e) { return errJson(e, J); }
  });
  on('GET', '/notes/:id/translations', ({ p }) => all('SELECT lang, text, model, version, created_at FROM note_translations WHERE note_id = ?', p.id));

  // ── language-learning: compare a sentence in depth ──
  on('POST', '/lang/study', async ({ req }) => {
    const b = await body(req); const sentence = String(b.sentence ?? '').trim().slice(0, 600); if (!sentence || !getLang(b.to)) return bad('sentence and to required');
    const from = b.from ?? detectLanguage(sentence).code; const route = await routeFor(from, b.to); if (!route.model) return J({ error: route.reason, route }, 503);
    try {
      const r = await ollama.aiFetch(`${ollama.OLLAMA_URL}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: route.model, stream: false, think: false, format: 'json', options: { temperature: 0.1, num_ctx: 4096 }, messages: [
        { role: 'system', content: `You are a language teacher. Analyse one sentence for a learner. Return ONLY JSON: {"literal":"word-for-word translation in ${langName(b.to)}","natural":"natural idiomatic translation in ${langName(b.to)}","words":[{"src":"word","tr":"meaning/translation","note":"part of speech or nuance"}],"grammar":["short explanation of each notable construction, written in ${langName(b.to)}"],"idioms":["any idioms or fixed expressions and their meaning"],"structure":"how the sentence is built (subject, verb, object order etc.)"}. Be accurate; omit fields you are unsure of.` },
        { role: 'user', content: `${langName(from)} sentence: ${sentence}` }] }) });
      const j = ollama.parseJson<any>(String((await r.json()).message?.content ?? ''));
      if (!j?.natural) return J({ error: 'The model returned an unreadable analysis. Try again.' }, 502);
      return { ...j, from, to: b.to, model: route.model, quality: route.quality };
    } catch (e: any) { return J({ error: e.message }, 502); }
  });

  // ── prefs (global + per book) ──
  on('GET', '/lang/prefs', ({ q }) => {
    const g = get<{ value: string }>('SELECT value FROM preferences WHERE user_id = ? AND key = ?', me(), 'lang.global')?.value;
    const bk = q.get('book') ? get<{ value: string }>('SELECT value FROM preferences WHERE user_id = ? AND key = ?', me(), `lang.book.${q.get('book')}`)?.value : null;
    return { global: g ? JSON.parse(g) : {}, book: bk ? JSON.parse(bk) : null };
  });
  on('PUT', '/lang/prefs', async ({ req }) => {
    const b = await body(req); const key = b.bookId ? `lang.book.${b.bookId}` : 'lang.global';
    if (b.bookId && !book(b.bookId)) return bad('Not found', 404);
    const cur = JSON.parse(get<{ value: string }>('SELECT value FROM preferences WHERE user_id = ? AND key = ?', me(), key)?.value ?? '{}');
    const next = { ...cur, ...(b.prefs ?? {}) };
    for (const k of ['reading', 'explain', 'audio', 'podcast', 'video', 'vocab', 'secondary', 'ui']) if (next[k] && !getLang(next[k])) delete next[k];
    run('INSERT INTO preferences (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value = excluded.value', me(), key, JSON.stringify(next));
    return next;
  });

  // ── speech + support matrix ──
  on('GET', '/lang/speech', async () => ({ engine: ttsEngine(), voices: await listVoiceInfo(), piper: !!process.env.PIPER_URL, stt: { local: false, note: 'No local speech-recognition engine is installed (Whisper.cpp is not set up). The browser\'s SpeechRecognition may be used if you allow it — in Chrome/Edge it sends audio to the browser vendor\'s servers.' } }));
  on('GET', '/lang/matrix', async () => {
    const st = await ollama.status(); const voices = await listVoiceInfo();
    const rows = [];
    for (const l of LANGUAGES) {
      const toL = await routeFor('en', l.code), fromL = await routeFor(l.code, 'en');
      const sapi = voices.filter((v) => v.culture.toLowerCase().startsWith(l.code.split('-')[0].toLowerCase()) && (l.code.startsWith('zh') ? v.culture.toLowerCase().startsWith('zh') : true)).map((v) => v.name);
      const splitsWords = !['Thai', 'Khmr', 'Laoo', 'Mymr', 'Hans', 'Hant', 'Jpan'].includes(l.script);
      rows.push({ code: l.code, en: l.en, native: l.native, script: l.script, rtl: !!l.rtl,
        extraction: 'Unicode text is extracted as-is (text-based PDF/EPUB/DOCX/TXT). Scanned pages: OCR bundles English only.',
        toLang: { quality: toL.quality, model: toL.model, provider: toL.provider, note: toL.reason }, fromLang: { quality: fromL.quality, model: fromL.model, note: fromL.reason },
        tts: { server: sapi, piper: !!process.env.PIPER_URL ? 'configured (voice must exist for this language)' : null }, stt: 'none installed locally',
        font: bundledFont(l.code) || l.script === 'Latn' || l.script === 'Cyrl' || l.script === 'Grek' ? 'bundled/standard' : 'system CJK font', search: splitsWords ? 'exact substring + word search' : 'exact substring only (no word boundaries)', dedicatedModels: { nllb: !!l.nllb, indictrans2: !!l.it2 } });
    }
    return { models: st.models.filter((m) => !m.embedding).map((m) => m.name), ollama: st.online, nllbServer: !!process.env.NLLB_URL, gpu: process.env.GPU_NOTE ?? null, rows };
  });
  void pageIntel;
}
