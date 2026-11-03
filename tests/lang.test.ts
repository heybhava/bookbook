// Language-intelligence tests. API part needs a running server: BASE_URL=http://localhost:3100 npm test
import './_auth.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, getLang, detectLanguage, isRtl, fontFor, bundledFont } from '../src/lib/lang/registry.ts';

test('registry: required languages, native names and BCP-47 codes', () => {
  for (const code of ['te', 'ta', 'hi', 'kn', 'ml', 'bn', 'mr', 'gu', 'pa', 'or', 'as', 'ur', 'sa', 'kok', 'ks', 'ne', 'sd', 'doi', 'mai', 'sat', 'mni', 'brx', 'en', 'es', 'ar', 'he', 'fa', 'ja', 'ko', 'th', 'zh-Hans', 'zh-Hant', 'la', 'eo', 'sw', 'af']) assert.ok(getLang(code), `missing ${code}`);
  assert.equal(getLang('te')!.native, 'తెలుగు'); assert.equal(getLang('ta')!.native, 'தமிழ்'); assert.equal(getLang('hi')!.native, 'हिन्दी');
  assert.equal(new Set(LANGUAGES.map((l) => l.code)).size, LANGUAGES.length, 'duplicate codes');
  assert.ok(LANGUAGES.length >= 100, `only ${LANGUAGES.length}`);
});
test('registry: RTL and fonts', () => {
  for (const c of ['ar', 'he', 'fa', 'ur', 'ps']) assert.equal(isRtl(c), true, c);
  assert.equal(isRtl('te'), false);
  assert.match(fontFor('te')!, /Noto Sans Telugu/); assert.match(fontFor('ta')!, /Noto Sans Tamil/);
  assert.ok(bundledFont('te') && bundledFont('ta') && bundledFont('ar') && !bundledFont('ja'));
  assert.equal(getLang('zh-TW')!.code, 'zh-Hant'); assert.equal(getLang('te-IN')!.code, 'te');
});
test('language detection by script and stop-words', () => {
  assert.equal(detectLanguage('ఈ పేజీని నాకు సులభంగా వివరించండి').code, 'te');
  assert.equal(detectLanguage('இந்த கருத்தை எனக்கு விளக்குங்கள்').code, 'ta');
  assert.equal(detectLanguage('यह पृष्ठ मुझे आसान भाषा में समझाइए').code, 'hi');
  assert.equal(detectLanguage('اشرح لي هذه الفكرة بالتفصيل').code, 'ar');
  assert.equal(detectLanguage('这个概念是什么意思').code, 'zh-Hans');
  assert.equal(detectLanguage('Explain this concept to me in simple terms and give an example').code, 'en');
  assert.equal(detectLanguage('Explícame este concepto de la economía y por qué es importante para los mercados').code, 'es');
  assert.equal(detectLanguage('Telugu కోడ్-స్విచింగ్ with English engineering terms like voltage మరియు current').code, 'te');
});

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const up = await fetch(BASE + '/api/status').then((r) => r.ok).catch(() => false);
const j = async (p: string, init?: RequestInit) => { const r = await fetch(BASE + '/api' + p, init); return { status: r.status, body: await r.json().catch(() => null) as any }; };
const send = (p: string, body: unknown, method = 'POST') => j(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const hasScript = (t: string, re: RegExp) => (t.match(re) ?? []).length / Math.max(1, (t.match(/\p{L}/gu) ?? []).length);
const TELUGU = /[ఀ-౿]/g, TAMIL = /[஀-௿]/g;

test('Language API', { skip: !up && 'server not running' }, async (t) => {
  const st = (await j('/status')).body; const modelOk = !!st.resolved.assistant;
  const TEXT = 'Ohm\'s law states that the current through a resistor is proportional to the voltage across it, V = I * R, where R is the resistance.';
  let id = '';

  await t.test('model routing is honest about quality and unsupported pairs', async () => {
    const hi = (await j('/lang/route?src=en&tgt=hi')).body; assert.ok(['official', 'broad', 'dedicated', 'none'].includes(hi.quality));
    const sat = (await j('/lang/route?src=en&tgt=sat')).body; assert.equal(sat.quality, 'none'); assert.ok(sat.reason.length > 10); assert.ok(sat.alternatives.length >= 1);
    const te = (await j('/lang/route?src=en&tgt=te')).body; if (te.provider === 'ollama') assert.notEqual(te.quality, 'official', 'Telugu must never be claimed as official on a general model');
  });
  await t.test('support matrix covers every language with real probes', async () => {
    const m = (await j('/lang/matrix')).body; assert.ok(m.rows.length >= 100);
    const te = m.rows.find((r: any) => r.code === 'te'); assert.ok(te.toLang && te.font && te.search && te.stt);
    assert.equal(m.rows.find((r: any) => r.code === 'ja').search.startsWith('exact substring only'), true);
  });
  await t.test('Telugu and Tamil: native script, formula preserved, cached on repeat', { skip: !modelOk && 'no model' }, async () => {
    for (const [tgt, re] of [['te', TELUGU], ['ta', TAMIL]] as const) {
      const r = (await send('/translate', { texts: [TEXT], src: 'en', tgt })).body;
      if (r.error) { assert.ok(r.route, 'unsupported must explain'); continue; }
      const out = r.items[0].translation; assert.ok(hasScript(out, re) > 0.5, `${tgt} output not in native script: ${out}`);
      assert.ok(out.includes('V = I * R'), `${tgt}: formula changed: ${out}`);
      const again = (await send('/translate', { texts: [TEXT], src: 'en', tgt })).body; assert.equal(again.items[0].cached, true); assert.equal(again.items[0].translation, out);
    }
  });
  await t.test('unsupported pair fails loudly with options, never silently', async () => {
    const r = await send('/translate', { texts: ['hello world'], src: 'en', tgt: 'sat' }); assert.equal(r.status, 503); assert.ok(r.body.error && r.body.route);
  });
  await t.test('glossary: "keep" preserves an English term; correction becomes the new version', { skip: !modelOk && 'no model' }, async () => {
    const sentence = 'The resistor limits the current in the circuit.';
    await send('/glossary', { term: 'resistor', lang: 'hi', mode: 'keep' });
    const r = (await send('/translate', { texts: [sentence], src: 'en', tgt: 'hi' })).body; if (r.error) return;
    assert.match(r.items[0].translation, /resistor/i, 'kept term missing');
    const g = (await j('/glossary?lang=hi')).body.find((x: any) => x.term === 'resistor'); await j('/glossary/' + g.id, { method: 'DELETE' });
    await send('/translations/correct', { source: 'My unique sentence 12345.', translation: 'मेरा अद्वितीय वाक्य', src: 'en', tgt: 'hi' });
    const again = (await send('/translate', { texts: ['My unique sentence 12345.'], src: 'en', tgt: 'hi' })).body; assert.equal(again.items[0].translation, 'मेरा अद्वितीय वाक्य'); assert.equal(again.items[0].corrected, true);
    assert.ok((await send('/translations/history', { source: 'My unique sentence 12345.', src: 'en', tgt: 'hi' })).body.length >= 1);
  });
  await t.test('page translation streams aligned paragraphs and leaves the original untouched', { skip: !modelOk && 'no model' }, async () => {
    const fd = new FormData(); fd.append('files', new File([`# Circuits\n\nVoltage drives current through a conductor (run ${Date.now()}).\n\nPower is P = V * I.`], 'ltest.md', { type: 'text/markdown' }));
    id = (await j('/books', { method: 'POST', body: fd })).body.results[0].id;
    for (let i = 0; i < 60; i++) { const b = (await j('/books/' + id)).body; if (['readable', 'ready'].includes(b.status)) break; await new Promise((r) => setTimeout(r, 400)); }
    const before = (await j(`/books/${id}/pages?from=1&to=1`)).body[0].text;
    const r = await fetch(`${BASE}/api/books/${id}/pages/1/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tgt: 'ta' }) });
    const ev = (await r.text()).trim().split('\n').map((l) => JSON.parse(l)); const meta = ev[0]; const items = ev.filter((e) => e.type === 'item');
    if (ev.some((e) => e.type === 'error')) return;
    assert.equal(items.length, meta.count); items.forEach((it, i) => { assert.equal(it.i, i); assert.ok(hasScript(it.translation, TAMIL) > 0.5); });
    assert.equal((await j(`/books/${id}/pages?from=1&to=1`)).body[0].text, before, 'original page text must not change');
    assert.ok((await j(`/books/${id}/translation-coverage?tgt=ta`)).body.pages >= 1);
  });
  await t.test('cross-language search: a Telugu query finds an English note', { skip: !modelOk && 'no model' }, async () => {
    const n = (await send('/notes', { body: 'Capacitor charging time depends on the resistance and capacitance of the circuit.', kind: 'note' })).body.id;
    const q = (await send('/translate', { texts: ['capacitor charging time'], src: 'en', tgt: 'te' })).body; if (q.error) return;
    const res = (await j(`/search?q=${encodeURIComponent(q.items[0].translation)}`)).body;
    assert.ok(res.notes.some((x: any) => x.id === n), 'English note not found from Telugu query');
    await j('/notes/' + n, { method: 'DELETE' });
  });
  await t.test('vocabulary keeps old data and gains translations', async () => {
    await send('/vocab', { word: 'ltestword', definition: 'original definition', sentence: 'a sentence' });
    await send('/vocab/translations', { word: 'ltestword', translations: { te: { word: 'పరీక్ష', transliteration: 'parīkṣa' } }, notes: 'my note', lang: 'en' });
    const v = (await j('/vocab')).body.find((x: any) => x.word === 'ltestword');
    assert.equal(v.definition, 'original definition'); assert.equal(JSON.parse(v.translations).te.word, 'పరీక్ష'); assert.equal(v.user_notes, 'my note');
    await j('/vocab/' + v.id, { method: 'DELETE' });
  });
  await t.test('prefs: global and per-book, invalid language codes dropped', async () => {
    await send('/lang/prefs', { prefs: { reading: 'te', explain: 'ta', bogus: 'x', secondary: 'xx-nope' } }, 'PUT');
    const g = (await j('/lang/prefs')).body.global; assert.equal(g.reading, 'te'); assert.equal(g.secondary, undefined);
    await send('/lang/prefs', { prefs: { reading: '', explain: '' } }, 'PUT');
  });
  await t.test('Telugu question gets a Telugu answer from the book (tutor + retrieval)', { skip: !modelOk && 'no model' }, async () => {
    if (!id) return;
    const r = await fetch(`${BASE}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bookId: id, message: 'ఈ పేజీని నాకు సులభంగా వివరించండి.', page: 1, persona: 'beginner' }) });
    const ev = (await r.text()).trim().split('\n').map((l) => JSON.parse(l)); const ans = ev.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    assert.ok(hasScript(ans, TELUGU) > 0.3, `answer not Telugu: ${ans.slice(0, 120)}`);
    assert.ok(ev[0].citations.length >= 1, 'citations missing');
  });
  await t.test('cleanup', async () => { if (id) await j('/books/' + id, { method: 'DELETE' }); });
});
