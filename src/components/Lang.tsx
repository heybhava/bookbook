'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, post, put, del } from '@/lib/api';
import { useStore, type TransLayout, type TransMode } from '@/lib/store';
import { LANGUAGES, getLang, label, fontFor, isRtl, langName, detectLanguage } from '@/lib/lang/registry';
import { browserVoices, voiceFor, speakIn } from '@/lib/tts';
import { Icon, Spinner, ErrorNote, Md, useFetch, Empty } from './ui';

// ───────────── tiny i18n for the application shell (navigation); extensible by adding a catalog ─────────────
const CATALOG: Record<string, Record<string, string>> = {
  en: { journal: 'Life Journal', vault: 'Vault', library: 'Library', inbox: 'Knowledge Inbox', ask: 'Ask your library', review: 'Review', vocab: 'Vocabulary', write: 'Write', notes: 'Notes & highlights', goals: 'Goals', graph: 'Knowledge graph', settings: 'Settings & models', live: 'Live translate', recall: 'Daily recall', search: 'Search' },
  te: { library: 'గ్రంథాలయం', inbox: 'జ్ఞాన ఇన్‌బాక్స్', ask: 'మీ లైబ్రరీని అడగండి', review: 'పునఃసమీక్ష', vocab: 'పదజాలం', write: 'రాయండి', notes: 'గమనికలు & హైలైట్‌లు', goals: 'లక్ష్యాలు', graph: 'జ్ఞాన గ్రాఫ్', settings: 'సెట్టింగ్‌లు & మోడల్స్', live: 'లైవ్ అనువాదం', recall: 'రోజువారీ పునఃస్మరణ', search: 'శోధన' },
  ta: { library: 'நூலகம்', inbox: 'அறிவு இன்பாக்ஸ்', ask: 'உங்கள் நூலகத்தைக் கேளுங்கள்', review: 'மறுபார்வை', vocab: 'சொல்லகராதி', write: 'எழுதுங்கள்', notes: 'குறிப்புகள் & சிறப்பம்சங்கள்', goals: 'இலக்குகள்', graph: 'அறிவு வரைபடம்', settings: 'அமைப்புகள் & மாதிரிகள்', live: 'நேரடி மொழிபெயர்ப்பு', recall: 'தினசரி நினைவுகூரல்', search: 'தேடல்' },
  hi: { library: 'पुस्तकालय', inbox: 'ज्ञान इनबॉक्स', ask: 'अपनी लाइब्रेरी से पूछें', review: 'पुनरावलोकन', vocab: 'शब्दावली', write: 'लिखें', notes: 'नोट्स और हाइलाइट', goals: 'लक्ष्य', graph: 'ज्ञान ग्राफ़', settings: 'सेटिंग्स और मॉडल', live: 'लाइव अनुवाद', recall: 'दैनिक पुनः स्मरण', search: 'खोज' },
};
export const UI_LANGS = Object.keys(CATALOG);
export function useT() {
  const ui = useStore((s) => s.langPrefs.ui) ?? 'en';
  return useCallback((k: string) => CATALOG[ui]?.[k] ?? CATALOG.en[k] ?? k, [ui]);
}

/** Text in a given language: correct lang/dir attributes and script-appropriate font. */
export function L({ code, children, className = '', block }: { code?: string | null; children: ReactNode; className?: string; block?: boolean }) {
  const Tag = (block ? 'div' : 'span') as 'div';
  return <Tag lang={code ?? undefined} dir={isRtl(code) ? 'rtl' : undefined} className={className} style={{ fontFamily: fontFor(code) }}>{children}</Tag>;
}

export function LangSelect({ value, onChange, label: lb, include, className = '' }: { value: string; onChange: (c: string) => void; label?: string; include?: string[]; className?: string }) {
  const list = include ? LANGUAGES.filter((l) => include.includes(l.code)) : LANGUAGES;
  return (
    <select className={`input ${className}`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={lb ?? 'Language'}>
      {list.map((l) => <option key={l.code} value={l.code}>{label(l)}</option>)}
    </select>
  );
}

// ───────────── shared hooks ─────────────
export interface TrItem { i: number; text: string; translation: string; cached: boolean; warnings: string[]; corrected?: boolean }
interface TrState { items: TrItem[]; total: number; status: 'idle' | 'loading' | 'done' | 'error'; route: any; error?: string; src?: string }
const pageCache = new Map<string, TrState>();

export function useTranslatePage(bookId: string | null, page: number, tgt: string, enabled: boolean) {
  const key = `${bookId}:${page}:${tgt}`;
  const [st, setSt] = useState<TrState>({ items: [], total: 0, status: 'idle', route: null });
  const [nonce, setNonce] = useState(0);
  const force = useRef(false);
  useEffect(() => {
    if (!enabled || !bookId) return;
    const hit = !force.current && pageCache.get(key);
    if (hit && hit.status === 'done') { setSt(hit); return; }
    const ac = new AbortController(); setSt({ items: [], total: 0, status: 'loading', route: null });
    const items: TrItem[] = []; let route: any = null, total = 0, src: string | undefined;
    (async () => {
      try {
        const r = await fetch(`/api/books/${bookId}/pages/${page}/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tgt, force: force.current }), signal: ac.signal });
        force.current = false;
        if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
        const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; const e = JSON.parse(line);
            if (e.type === 'meta') { route = e.route; total = e.count; src = e.src; setSt({ items: [], total, status: 'loading', route, src }); }
            else if (e.type === 'item') { items.push(e); setSt({ items: [...items], total, status: 'loading', route, src }); }
            else if (e.type === 'error') { setSt({ items: [...items], total, status: 'error', route: e.route ?? route, error: e.error, src }); return; }
          }
        }
        const fin: TrState = { items, total, status: 'done', route, src }; pageCache.set(key, fin); setSt(fin);
      } catch (e: any) { if (e.name !== 'AbortError') setSt({ items, total, status: 'error', route, error: e.message, src }); }
    })();
    return () => ac.abort();
  }, [key, enabled, bookId, page, tgt, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = () => { pageCache.delete(key); force.current = true; setNonce((n) => n + 1); };
  const edit = (i: number, translation: string) => setSt((s) => { const items = s.items.map((x) => (x.i === i ? { ...x, translation, corrected: true } : x)); const n = { ...s, items }; pageCache.set(key, n); return n; });
  return { ...st, reload, edit };
}

// ───────────── speech availability ─────────────
export function useVoices() {
  const [n, setN] = useState(0);
  useEffect(() => { if (typeof speechSynthesis === 'undefined') return; const h = () => setN((x) => x + 1); speechSynthesis.addEventListener?.('voiceschanged', h); h(); return () => speechSynthesis.removeEventListener?.('voiceschanged', h); }, []);
  return n;
}
export function VoiceBadge({ code }: { code: string }) {
  useVoices();
  const v = voiceFor(getLang(code)?.speech ?? code);
  return v ? <span className="chip" title={`${v.name} (${v.lang})`}>🔊 voice available</span> : <span className="chip" style={{ color: 'var(--danger)' }} title="No installed text-to-speech voice for this language in this browser/OS. Windows: Settings → Time & language → Speech → add voices. Or configure Piper.">no voice installed</span>;
}

// ───────────── bilingual page (center column) ─────────────
export function BilingualPage({ bookId, page, text, tgt, mode, layout, srcLang, onSelect }: {
  bookId: string; page: number; text: string; tgt: string; mode: TransMode; layout: TransLayout; srcLang: string;
  onSelect: (s: { text: string; start: number; end: number; sentence: string; rect: DOMRect } | null) => void;
}) {
  const tr = useTranslatePage(bookId, page, tgt, true);
  const paras = useMemo(() => { const out: { start: number; text: string }[] = []; let pos = 0; for (const line of text.split('\n')) { if (line.trim()) out.push({ start: pos, text: line }); pos += line.length + 1; } return out; }, [text]);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [alt, setAlt] = useState(false); const altRef = useRef(false);
  const { say } = useStore();
  const rtl = isRtl(tgt);

  async function speak(txt: string, code: string, id: string) {
    setSpeaking(id); const ok = await speakIn(txt, getLang(code)?.speech ?? code); setSpeaking(null);
    if (!ok) say(`No ${getLang(code)?.en ?? code} voice is installed here — see Settings → Language support`);
    return ok;
  }
  async function playAlternating() {
    if (alt) { altRef.current = false; setAlt(false); speechSynthesis.cancel(); return; }
    altRef.current = true; setAlt(true);
    for (let i = 0; i < paras.length && altRef.current; i++) {
      const t = tr.items.find((x) => x.i === i); if (!t) continue;
      if (mode !== 'translated') if (!(await speak(paras[i].text, srcLang, `o${i}`))) break;
      if (!altRef.current) break;
      if (!(await speak(t.translation, tgt, `t${i}`))) break;
    }
    altRef.current = false; setAlt(false);
  }
  useEffect(() => () => { altRef.current = false; try { speechSynthesis.cancel(); } catch { /* */ } }, [page]);

  function up(e: React.MouseEvent, start: number, ptext: string) {
    const sel = window.getSelection(); if (!sel || sel.isCollapsed) return onSelect(null);
    const str = sel.toString().replace(/\s+/g, ' ').trim(); if (!str) return onSelect(null);
    const i = ptext.indexOf(str); const a = i >= 0 ? start + i : -1;
    onSelect({ text: str, start: a, end: a >= 0 ? a + str.length : -1, sentence: ptext.slice(0, 500), rect: sel.getRangeAt(0).getBoundingClientRect() });
    void e;
  }
  async function correct(item: TrItem) {
    const t = prompt('Correct this translation (saved and reused from now on):', item.translation); if (t == null || !t.trim()) return;
    await post('/translations/correct', { source: item.text, translation: t.trim(), src: srcLang, tgt, bookId, page }); tr.edit(item.i, t.trim()); say('Correction saved');
  }
  const side = layout === 'side' && mode === 'bilingual';
  const orig = (p: { start: number; text: string }, k: number) => <p key="o" lang={srcLang} dir={isRtl(srcLang) ? 'rtl' : undefined} style={{ fontFamily: fontFor(srcLang) }} className={speaking === `o${k}` ? 'speak-sentence' : ''} onMouseUp={(e) => up(e, p.start, p.text)}>{p.text}</p>;
  const trans = (k: number) => { const t = tr.items.find((x) => x.i === k); return t ? (
    <p key="t" lang={tgt} dir={rtl ? 'rtl' : undefined} style={{ fontFamily: fontFor(tgt) }} className={`${mode === 'bilingual' ? 'text-[var(--accent)]' : ''} ${speaking === `t${k}` ? 'speak-sentence' : ''}`}>
      {t.translation}{t.corrected && <span className="chip ml-1">edited</span>}
      <span className="inline-flex gap-0.5 align-middle ml-1 not-italic" style={{ fontFamily: 'ui-sans-serif, system-ui' }}>
        <button className="btn btn-ghost !p-0.5" onClick={() => speak(t.translation, tgt, `t${k}`)} aria-label="Listen to translation"><Icon n="sound" size={12} /></button>
        <button className="btn btn-ghost !p-0.5" onClick={() => correct(t)} aria-label="Correct translation"><Icon n="edit" size={12} /></button>
      </span></p>) : <p key="t" className="text-[var(--ink3)]">…</p>; };
  return (
    <div className="prose-book">
      <div className="flex flex-wrap items-center gap-2 mb-4 text-xs" style={{ fontFamily: 'ui-sans-serif, system-ui' }}>
        <span className="chip">{langName(srcLang)} → {langName(tgt)}</span>
        {tr.route?.model && <span className="chip" title={tr.route.reason}>{tr.route.model} · {tr.route.quality}</span>}
        <button className="btn !py-1" onClick={playAlternating}><Icon n={alt ? 'stop' : 'sound'} size={13} /> {alt ? 'Stop' : mode === 'translated' ? 'Listen' : 'Listen alternating'}</button>
        <button className="btn !py-1" onClick={tr.reload} disabled={tr.status === 'loading'}>Retranslate</button>
        {tr.status === 'loading' && <Spinner label={`${tr.items.length}/${tr.total}`} />}
      </div>
      {tr.status === 'error' && <div className="mb-4"><ErrorNote error={tr.error ?? 'Translation failed'} />{tr.route?.alternatives?.map((a: any) => <div key={a.model} className="text-xs mt-1 text-[var(--ink2)]">{a.how}</div>)}</div>}
      {tr.items.some((i) => i.warnings.length) && <p className="text-xs mb-3" style={{ color: 'var(--danger)', fontFamily: 'ui-sans-serif, system-ui' }}>{[...new Set(tr.items.flatMap((i) => i.warnings))].join(' · ')}</p>}
      {paras.map((p, k) => mode === 'translated' ? <div key={k}>{trans(k)}</div> : side
        ? <div key={k} className="grid md:grid-cols-2 gap-6">{orig(p, k)}<div>{trans(k)}</div></div>
        : <div key={k} className="mb-3">{layout === 'stack-rev' ? <>{trans(k)}{orig(p, k)}</> : <>{orig(p, k)}{trans(k)}</>}</div>)}
    </div>
  );
}

// ───────────── the Translate tab ─────────────
export function TranslatePanel({ book, page, text }: { book: { id: string; page_count: number; chapters: { idx: number; title: string; start_page: number }[]; language?: string | null }; page: number; text: string }) {
  const { transMode, transTgt, transLayout, setTrans, selection, say, langPrefs } = useStore();
  const src = useMemo(() => book.language && getLang(book.language) ? getLang(book.language)!.code : detectLanguage(text).code, [book.language, text]);
  const [route, setRoute] = useState<any>(null);
  useEffect(() => { api(`/lang/route?src=${src}&tgt=${transTgt}`).then(setRoute).catch(() => {}); }, [src, transTgt]);
  const [selTr, setSelTr] = useState<{ text: string; warnings: string[] } | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setSelTr(null); setErr(null); }, [selection?.text, transTgt]);
  const [task, setTask] = useState<any>(null);
  useEffect(() => { if (!task) return; const t = setInterval(async () => { const l = await api<any[]>(`/tasks?book=${book.id}`); const x = l.find((y) => y.id === task.id); if (x) { setTask(x); if (['completed', 'failed', 'cancelled'].includes(x.status)) clearInterval(t); } }, 1500); return () => clearInterval(t); }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: cov, reload: reloadCov } = useFetch<{ pages: number; total: number }>(`/books/${book.id}/translation-coverage?tgt=${transTgt}`, [task?.status]);
  const ch = [...book.chapters].reverse().find((c) => c.start_page <= page); const chNext = book.chapters.find((c) => c.start_page > page);
  const [study, setStudy] = useState<any>(null); const [stBusy, setStBusy] = useState(false);
  const tgtL = getLang(transTgt);

  async function translateSel() {
    if (!selection) return; setBusy(true); setErr(null);
    try { const r = await post('/translate', { texts: [selection.text], src, tgt: transTgt, bookId: book.id, page, context: selection.sentence }); setSelTr({ text: r.items[0].translation, warnings: r.items[0].warnings }); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }
  async function range(from: number, to: number) { try { const r = await post(`/books/${book.id}/translate-range`, { tgt: transTgt, from, to }); const l = await api<any[]>(`/tasks?book=${book.id}`); setTask(l.find((x) => x.id === r.taskId) ?? { id: r.taskId, status: 'queued', progress: 0 }); } catch (e: any) { say(e.message); } }

  return (
    <div className="space-y-4">
      <div><div className="label mb-1">Translate into</div><LangSelect value={transTgt} onChange={(c) => setTrans({ transTgt: c })} label="Target language" />
        {langPrefs.reading && langPrefs.reading !== transTgt && <button className="underline text-xs mt-1" onClick={() => setTrans({ transTgt: langPrefs.reading! })}>Use my reading language ({langName(langPrefs.reading)})</button>}</div>
      <div className="flex gap-1">{(['original', 'translated', 'bilingual'] as const).map((m) => <button key={m} className={`btn flex-1 justify-center ${transMode === m ? 'btn-primary' : ''}`} onClick={() => setTrans({ transMode: m })}>{m}</button>)}</div>
      {transMode === 'bilingual' && <div className="flex gap-1">{([['stack', 'Original above'], ['stack-rev', 'Translation above'], ['side', 'Side by side']] as const).map(([k, l]) => <button key={k} className={`btn flex-1 justify-center !text-[11px] ${transLayout === k ? 'btn-primary' : ''}`} onClick={() => setTrans({ transLayout: k })}>{l}</button>)}</div>}
      {transMode !== 'original' && <p className="text-[11px] text-[var(--ink3)]">Your original document is never changed. PDF page images are shown as-is; use <b>Text view</b> in the header for in-page translation of PDFs.</p>}

      {route && (
        <div className="card p-2.5 text-xs space-y-1">
          <div className="flex gap-1.5 flex-wrap items-center"><span className="chip">{langName(src)} → {tgtL?.en}</span><span className="chip" style={route.quality === 'none' ? { color: 'var(--danger)' } : undefined}>{route.quality}</span>{route.model && <span className="chip">{route.model}</span>}</div>
          <p className="text-[var(--ink2)]">{route.reason}</p>
          {route.alternatives?.map((a: any) => <p key={a.model} className="text-[var(--ink3)]">Better option: {a.how}</p>)}
          <div className="flex gap-3 items-center"><span>Voice ({tgtL?.en}):</span><VoiceBadge code={transTgt} /></div>
        </div>
      )}

      <div className="border-t border-[var(--line)] pt-3 space-y-2">
        <div className="label">Selection</div>
        {selection ? (<>
          <p className="text-xs italic text-[var(--ink2)] line-clamp-3">“{selection.text}”</p>
          <button className="btn btn-primary w-full justify-center" disabled={busy} onClick={translateSel}>Translate selection</button>
          {busy && <Spinner label="Translating in context…" />}{err && <ErrorNote error={err} />}
          {selTr && <div className="card p-2.5"><L code={transTgt} block className="text-base leading-relaxed">{selTr.text}</L>
            <div className="flex gap-1 mt-2"><button className="btn !py-1" onClick={async () => { if (!(await speakIn(selTr.text, tgtL?.speech ?? transTgt))) say(`No ${tgtL?.en} voice installed`); }}><Icon n="sound" size={13} /> Listen</button>
              <button className="btn !py-1" onClick={async () => { await post('/notes', { book_id: book.id, page, body: `${selection.text}\n\n— ${tgtL?.en}: ${selTr.text}`, kind: 'note' }); say('Saved to notes with translation'); }}>Save as note</button></div>
            {selTr.warnings.length > 0 && <p className="text-[11px] mt-1" style={{ color: 'var(--danger)' }}>{selTr.warnings[0]}</p>}</div>}
          {selection.text.split(/\s+/).length > 2 && <button className="btn w-full justify-center" disabled={stBusy} onClick={async () => { setStBusy(true); setStudy(null); try { setStudy(await post('/lang/study', { sentence: selection.text, from: src, to: transTgt })); } catch (e: any) { setErr(e.message); } setStBusy(false); }}>Study this sentence</button>}
          {stBusy && <Spinner label="Analysing grammar…" />}
          {study && <StudyCard s={study} />}
        </>) : <p className="text-xs text-[var(--ink3)]">Select a word or sentence in the book to translate it with its context.</p>}
      </div>

      <div className="border-t border-[var(--line)] pt-3 space-y-2">
        <div className="label">Translate more</div>
        <div className="grid grid-cols-2 gap-1.5">
          <button className="btn justify-center" onClick={() => range(page, page)}>This page</button>
          <button className="btn justify-center" onClick={() => range(page, Math.min(book.page_count, page + 9))}>Next 10 pages</button>
          <button className="btn justify-center" disabled={!ch} onClick={() => ch && range(ch.start_page, (chNext?.start_page ?? book.page_count + 1) - 1)}>This chapter</button>
          <button className="btn justify-center" onClick={() => confirm(`Translate all ${book.page_count} pages with a local model? This can take a long time.`) && range(1, book.page_count)}>Entire book</button>
        </div>
        {task && <div className="text-xs"><div>{task.detail ?? task.status}</div><div className="h-1.5 bg-[var(--panel2)] rounded mt-1"><div className="h-1.5 rounded bg-[var(--accent)]" style={{ width: `${(task.progress ?? 0) * 100}%` }} /></div>
          <div className="flex gap-2 mt-1">{['analysing', 'generating', 'queued'].includes(task.status) && <button className="underline" onClick={() => post(`/tasks/${task.id}/cancel`)}>Cancel</button>}{['failed', 'cancelled'].includes(task.status) && <button className="underline" onClick={() => post(`/tasks/${task.id}/resume`)}>Resume</button>}</div>{task.error && <ErrorNote error={task.error} />}</div>}
        {cov && <p className="text-[11px] text-[var(--ink3)]">{cov.pages} of {cov.total} pages translated into {tgtL?.en} (cached; nothing is retranslated unless you ask).</p>}
        <button className="underline text-xs" onClick={reloadCov}>Refresh</button>
      </div>
      <TermsQuick bookId={book.id} lang={transTgt} />
    </div>
  );
}

function StudyCard({ s }: { s: any }) {
  return (
    <div className="card p-2.5 text-sm space-y-2 fade-in">
      <div><div className="label">Literal</div><L code={s.to}>{s.literal}</L></div>
      <div><div className="label">Natural</div><L code={s.to}>{s.natural}</L></div>
      {s.words?.length > 0 && <div><div className="label">Word by word</div><div className="flex flex-wrap gap-1.5 mt-1">{s.words.map((w: any, i: number) => <span key={i} className="chip" title={w.note}>{w.src} → <L code={s.to}>{w.tr}</L></span>)}</div></div>}
      {s.structure && <div><div className="label">Structure</div><L code={s.to} className="text-xs">{s.structure}</L></div>}
      {s.grammar?.length > 0 && <div><div className="label">Grammar</div><ul className="list-disc ml-4 text-xs">{s.grammar.map((g: string, i: number) => <li key={i}><L code={s.to}>{g}</L></li>)}</ul></div>}
      {s.idioms?.length > 0 && <div><div className="label">Idioms</div><ul className="list-disc ml-4 text-xs">{s.idioms.map((g: string, i: number) => <li key={i}>{g}</li>)}</ul></div>}
      <p className="text-[10px] text-[var(--ink3)]">{s.model} ({s.quality}) — language-teaching output from a local model; verify with a teacher for exams.</p>
    </div>
  );
}

function TermsQuick({ bookId, lang }: { bookId: string; lang: string }) {
  const { data, reload } = useFetch<any[]>(`/glossary?book=${bookId}&lang=${lang}`, [lang]);
  const [term, setTerm] = useState(''); const [tr, setTr] = useState(''); const [mode, setMode] = useState<'keep' | 'translate' | 'both'>('keep');
  const [open, setOpen] = useState(false);
  return (
    <details className="border-t border-[var(--line)] pt-3" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="label cursor-pointer">Terminology for this book ({data?.length ?? 0})</summary>
      <div className="space-y-2 mt-2 text-xs">
        <p className="text-[var(--ink2)]">Keep technical terms in English, always translate them one way, or show both — applied consistently in every chapter.</p>
        <div className="flex gap-1"><input className="input !py-1" placeholder="English term" value={term} onChange={(e) => setTerm(e.target.value)} />{mode !== 'keep' && <input className="input !py-1" placeholder="Translation" value={tr} onChange={(e) => setTr(e.target.value)} style={{ fontFamily: fontFor(lang) }} />}</div>
        <div className="flex gap-1">{(['keep', 'translate', 'both'] as const).map((m) => <button key={m} className={`btn flex-1 justify-center !py-1 ${mode === m ? 'btn-primary' : ''}`} onClick={() => setMode(m)}>{m}</button>)}
          <button className="btn" disabled={!term.trim() || (mode !== 'keep' && !tr.trim())} onClick={async () => { await post('/glossary', { bookId, term, lang, translation: tr || null, mode }); setTerm(''); setTr(''); reload(); useStore.getState().say('Term saved — affects new translations'); }}>Add</button></div>
        {data?.map((g) => <div key={g.id} className="flex justify-between gap-2"><span><b>{g.term}</b> <span className="chip">{g.mode}</span> {g.translation && <L code={lang}>{g.translation}</L>}</span><button onClick={async () => { await del(`/glossary/${g.id}`); reload(); }} aria-label="Remove"><Icon n="trash" size={12} /></button></div>)}
        <button className="underline" onClick={async () => { const s = await post('/glossary/suggest', { bookId, lang }); useStore.getState().say(s.length ? `Suggested: ${s.slice(0, 8).map((x: any) => x.term).join(', ')}` : 'No further terms found'); }}>Suggest technical terms from this book</button>
      </div>
    </details>
  );
}

// ───────────── word translations (used inside the Word tab) ─────────────
export function WordTranslations({ word, sentence, bookId, page }: { word: string; sentence: string; bookId: string; page: number }) {
  const { langPrefs, say } = useStore();
  const targets = useMemo(() => [...new Set([langPrefs.vocab, langPrefs.secondary, langPrefs.reading, 'te', 'ta', 'hi'].filter(Boolean) as string[])].slice(0, 4), [langPrefs]);
  const [pick, setPick] = useState<string[]>(targets.slice(0, 3)); const [data, setData] = useState<Record<string, any> | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setData(null); setErr(null); }, [word]);
  async function run() { setBusy(true); setErr(null); try { setData((await post('/lang/word', { word, sentence, targets: pick, bookId })).translations); } catch (e: any) { setErr(e.message); } setBusy(false); }
  return (
    <div className="border-t border-[var(--line)] pt-3 space-y-2">
      <div className="label">Translations</div>
      <div className="flex flex-wrap gap-1">{[...new Set([...targets, ...pick])].map((c) => <button key={c} className={`chip ${pick.includes(c) ? '!bg-[var(--accent)] !text-[var(--accent-ink)]' : ''}`} onClick={() => setPick((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]))}>{getLang(c)?.native ?? c}</button>)}
        <select className="input !w-auto !py-0.5 !text-xs" value="" onChange={(e) => e.target.value && setPick((p) => [...new Set([...p, e.target.value])])} aria-label="Add language"><option value="">+ language</option>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{label(l)}</option>)}</select></div>
      {!data && <button className="btn" disabled={busy || !pick.length} onClick={run}>Translate “{word}” in context</button>}
      {busy && <Spinner label="Translating…" />}{err && <ErrorNote error={err} />}
      {data && (<div className="space-y-2">
        {pick.map((c) => { const v = data[c]; return v ? (
          <div key={c} className="card p-2 text-sm"><div className="flex items-baseline gap-2 flex-wrap"><span className="text-[10px] text-[var(--ink3)]">{getLang(c)?.en}</span><L code={c} className="text-lg">{v.word}</L>{v.transliteration && <span className="text-xs text-[var(--ink2)]">{v.transliteration}</span>}
            <button className="btn btn-ghost !p-0.5 ml-auto" onClick={async () => { if (!(await speakIn(v.word, getLang(c)?.speech ?? c))) say(`No ${getLang(c)?.en} voice installed`); }} aria-label="Listen"><Icon n="sound" size={13} /></button></div>
            {v.meaning && <L code={c} block className="text-xs text-[var(--ink2)]">{v.meaning}</L>}{v.contextual && <L code={c} block className="text-xs mt-0.5">↳ {v.contextual}</L>}</div>) : <div key={c} className="text-xs text-[var(--ink3)]">{getLang(c)?.en}: no translation returned</div>; })}
        <button className="btn btn-primary" onClick={async () => { await post('/vocab/translations', { word, sentence, book_id: bookId, page, translations: data }); say(`Saved “${word}” with ${Object.keys(data).length} translations`); }}>Save word with translations</button></div>)}
    </div>
  );
}

// ───────────── settings: preferences, support matrix ─────────────
export function LanguageSettings() {
  const { langPrefs, setLangPrefsLocal } = useStore();
  const { data: books } = useFetch<any[]>('/books'); const [bookId, setBookId] = useState('');
  const { data: bp, reload } = useFetch<{ global: any; book: any }>(`/lang/prefs${bookId ? `?book=${bookId}` : ''}`, [bookId]);
  const eff = { ...(bp?.global ?? {}), ...(bp?.book ?? {}) };
  useEffect(() => { if (bp && !bookId) setLangPrefsLocal(bp.global); }, [bp, bookId, setLangPrefsLocal]);
  const set = async (k: string, v: unknown) => { const r = await put('/lang/prefs', { bookId: bookId || undefined, prefs: { [k]: v } }); if (!bookId) setLangPrefsLocal(r); reload(); };
  const row = (k: string, lb: string, extra?: string[]) => (
    <label key={k} className="flex items-center gap-3 flex-wrap text-sm"><span className="w-56 shrink-0">{lb}</span>
      <LangSelect className="!w-72" value={(eff as any)[k] ?? ''} onChange={(c) => set(k, c)} include={extra} label={lb} />{(eff as any)[k] && <button className="underline text-xs" onClick={() => set(k, '')}>clear</button>}</label>);
  return (
    <section className="mb-8 space-y-3">
      <h2 className="label">Language</h2>
      <div className="card p-4 space-y-3">
        <label className="flex items-center gap-3 text-sm"><span className="w-56">Applies to</span><select className="input !w-72" value={bookId} onChange={(e) => setBookId(e.target.value)}><option value="">All books (global default)</option>{books?.map((b) => <option key={b.id} value={b.id}>{b.title.slice(0, 50)}</option>)}</select></label>
        <label className="flex items-center gap-3 text-sm"><span className="w-56">Interface language</span><select className="input !w-72" value={(eff as any).ui ?? 'en'} onChange={(e) => set('ui', e.target.value)}>{UI_LANGS.map((c) => <option key={c} value={c}>{label(getLang(c)!)}</option>)}</select></label>
        <p className="text-[11px] text-[var(--ink3)] -mt-2">The application shell (navigation) is translated for English, Telugu, Tamil and Hindi; book content, summaries, vocabulary and the tutor work in any language your models support.</p>
        {row('reading', 'Preferred reading language')}{row('explain', 'Explanations & AI tutor language')}{row('audio', 'Audio language')}{row('podcast', 'Podcast language')}{row('video', 'Video language')}{row('vocab', 'Vocabulary translation language')}{row('secondary', 'Secondary language')}
        <label className="flex items-center gap-3 text-sm"><span className="w-56">Technical terminology</span><select className="input !w-72" value={(eff as any).terms ?? 'both'} onChange={(e) => set('terms', e.target.value)}><option value="keep">Keep English terms</option><option value="translate">Translate terms</option><option value="both">Show both</option></select></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!(eff as any).bilingual} onChange={(e) => set('bilingual', e.target.checked)} />Prefer bilingual reading when translating</label>
        <p className="text-[11px] text-[var(--ink3)]">Podcast and video language settings are stored now; those generators are not finished yet, so they do not use them.</p>
      </div>
      <SupportMatrix />
    </section>
  );
}

export function SupportMatrix() {
  const { data } = useFetch<any>('/lang/matrix'); const { data: sp } = useFetch<any>('/lang/speech'); useVoices();
  const [q, setQ] = useState(''); const [open, setOpen] = useState(false);
  if (!data) return <Spinner label="Probing local language capabilities…" />;
  const rows = data.rows.filter((r: any) => !q || `${r.en} ${r.native} ${r.code}`.toLowerCase().includes(q.toLowerCase()));
  const col = (qu: string) => (qu === 'none' ? 'var(--danger)' : qu === 'broad' ? '#d97706' : 'var(--accent)');
  return (
    <details className="card p-4" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-sm font-medium">Language support matrix — what actually works on this computer</summary>
      <div className="mt-3 space-y-3 text-xs">
        <p className="text-[var(--ink2)]">Models installed: {data.models.join(', ') || 'none'}. Dedicated translation server (NLLB/IndicTrans2): {data.nllbServer ? 'configured' : 'not configured'}. Speech recognition: {sp?.stt?.local ? 'local' : 'no local engine installed'}. Speech voices on this PC (server): {sp?.voices?.map((v: any) => v.name).join(', ') || 'none'}.</p>
        <input className="input max-w-xs" placeholder="Filter languages" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter languages" />
        <div className="overflow-auto max-h-96"><table className="w-full text-left"><thead className="sticky top-0 bg-[var(--panel)]"><tr className="text-[var(--ink3)]"><th className="p-1">Language</th><th>EN → it</th><th>it → EN</th><th>Voice</th><th>Font</th><th>Search</th><th>RTL</th></tr></thead>
          <tbody>{rows.map((r: any) => { const v = voiceFor(getLang(r.code)?.speech ?? r.code); return (
            <tr key={r.code} className="border-t border-[var(--line)]"><td className="p-1"><L code={r.code}>{r.native}</L> <span className="text-[var(--ink3)]">{r.en} · {r.code}</span></td>
              <td title={r.toLang.note} style={{ color: col(r.toLang.quality) }}>{r.toLang.quality}</td><td title={r.fromLang.note} style={{ color: col(r.fromLang.quality) }}>{r.fromLang.quality}</td>
              <td>{v ? `browser: ${v.name}` : r.tts.server.length ? `server: ${r.tts.server[0]}` : '—'}</td><td>{r.font}</td><td>{r.search}</td><td>{r.rtl ? 'yes' : ''}</td></tr>); })}</tbody></table></div>
        <p className="text-[var(--ink3)]">“broad” = the model was trained on the language but quality is weaker (review output); “none” = not supported by any installed model; “dedicated” = NLLB/IndicTrans2. Voices appear only when the OS/browser has one installed. OCR of scanned pages covers English only.</p>
      </div>
    </details>
  );
}

// ───────────── live translation ─────────────
export function LiveTranslateView() {
  const { langPrefs, say } = useStore();
  const [a, setA] = useState(langPrefs.secondary ?? 'te'); const [b, setB] = useState('en'); const [turn, setTurn] = useState<'a' | 'b'>('a');
  const [text, setText] = useState(''); const [log, setLog] = useState<{ from: string; to: string; src: string; out: string; warn?: string }[]>([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [auto, setAuto] = useState(true); const [speak, setSpeak] = useState(true);
  const [mic, setMic] = useState(false); const [allowCloud, setAllowCloud] = useState(false);
  const recRef = useRef<any>(null);
  const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : null;
  const from = turn === 'a' ? a : b, to = turn === 'a' ? b : a;

  async function go(t = text) {
    if (!t.trim()) return; setBusy(true); setErr(null);
    try {
      const src = auto ? detectLanguage(t).code : from; const tgt = auto && src === b ? a : to;
      const r = await post('/translate', { texts: [t], src, tgt });
      const out = r.items[0].translation; setLog((l) => [{ from: src, to: tgt, src: t, out, warn: r.items[0].warnings[0] }, ...l]); setText('');
      if (speak && !(await speakIn(out, getLang(tgt)?.speech ?? tgt))) say(`No ${getLang(tgt)?.en} voice installed — showing text only`);
      setTurn((x) => (x === 'a' ? 'b' : 'a'));
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }
  function startMic() {
    if (!SR) return say('This browser has no speech recognition. Use the text box.');
    const r = new SR(); r.lang = getLang(from)?.speech ?? from; r.interimResults = true; r.continuous = false; recRef.current = r;
    r.onresult = (e: any) => setText(Array.from(e.results).map((x: any) => x[0].transcript).join(' '));
    r.onend = () => { setMic(false); }; r.onerror = (e: any) => { setMic(false); setErr(`Speech recognition: ${e.error}`); };
    setMic(true); r.start();
  }
  return (
    <div className="max-w-3xl">
      <header className="mb-6"><h1 className="font-serif text-3xl tracking-tight">Live translation</h1><p className="text-sm text-[var(--ink2)] mt-1">Two-way conversation translation, translated and spoken locally.</p></header>
      <div className="grid sm:grid-cols-2 gap-3 mb-4"><div><div className="label mb-1">Speaker A</div><LangSelect value={a} onChange={setA} label="Language A" /><VoiceBadge code={a} /></div><div><div className="label mb-1">Speaker B</div><LangSelect value={b} onChange={setB} label="Language B" /><VoiceBadge code={b} /></div></div>
      <div className="flex gap-4 text-sm mb-3 flex-wrap"><label className="flex gap-1.5"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Detect language automatically</label><label className="flex gap-1.5"><input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} />Speak translations</label></div>
      <div className="card p-3 space-y-2">
        <div className="text-xs text-[var(--ink2)]">Now speaking: <b>{turn === 'a' ? 'A' : 'B'}</b> — {langName(from)}</div>
        <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void go(); } }} placeholder="Type here, or hold the microphone…" style={{ fontFamily: fontFor(from) }} lang={from} dir={isRtl(from) ? 'rtl' : undefined} aria-label="Text to translate" />
        <div className="flex gap-2 items-center flex-wrap"><button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => go()}>Translate</button>
          <button className="btn" disabled={!SR || !allowCloud} onMouseDown={startMic} onMouseUp={() => recRef.current?.stop()} title="Push to talk"><Icon n={mic ? 'stop' : 'sound'} size={14} /> {mic ? 'Listening…' : 'Hold to talk'}</button>
          <label className="text-[11px] text-[var(--ink3)] flex gap-1.5 items-center"><input type="checkbox" checked={allowCloud} onChange={(e) => setAllowCloud(e.target.checked)} />Allow browser speech recognition (Chrome/Edge send audio to their servers; no local engine is installed)</label></div>
        {busy && <Spinner label="Translating…" />}{err && <ErrorNote error={err} />}
      </div>
      <div className="mt-4 space-y-2">{log.length === 0 ? <Empty title="No conversation yet">Type or speak in either language; the translation appears here and is spoken if a voice is installed.</Empty> : log.map((m, i) => (
        <div key={i} className="card p-3"><div className="text-[11px] text-[var(--ink3)]">{langName(m.from)} → {langName(m.to)}</div><L code={m.from} block className="text-sm text-[var(--ink2)]">{m.src}</L><L code={m.to} block className="text-lg mt-1">{m.out}</L>{m.warn && <p className="text-[11px] mt-1" style={{ color: 'var(--danger)' }}>{m.warn}</p>}</div>))}</div>
    </div>
  );
}

export { Md };
void browserVoices;
