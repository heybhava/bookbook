'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, post, patch, del } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Icon, Empty, Spinner, useFetch, Md, ErrorNote, fmtDur } from './ui';
import { AccountSettings } from './Auth';
import { MemorySettings } from './Memory';
import { speakWord } from '@/lib/tts';
import { ConceptsReview, ReportView, CaptureSettings } from './Intel';
import { LanguageSettings } from './Lang';

const H = ({ children, sub }: { children: React.ReactNode; sub?: string }) => (
  <header className="mb-6"><h1 className="font-serif text-3xl tracking-tight">{children}</h1>{sub && <p className="text-sm text-[var(--ink2)] mt-1">{sub}</p>}</header>
);

// ───────── Vocabulary ─────────
export function VocabView() {
  const { data, reload } = useFetch<any[]>('/vocab');
  const go = useStore((s) => s.go);
  return (
    <div>
      <H sub="Every word you save, with its sentence and source. Review them in the Review tab.">Vocabulary</H>
      {!data ? <Spinner /> : data.length === 0 ? <Empty title="No saved words yet">Select a word while reading, then choose “Save word”.</Empty> : (
        <div className="card divide-y divide-[var(--line)]">
          {data.map((v) => (
            <div key={v.id} className="p-3 flex gap-3 items-start">
              <button className="btn btn-ghost !p-1.5" onClick={() => speakWord(v.word)} aria-label={`Pronounce ${v.word}`}><Icon n="sound" /></button>
              <div className="flex-1 min-w-0">
                <div className="flex gap-2 items-baseline flex-wrap"><span className="font-serif text-lg">{v.word}</span>{v.ipa && <span className="text-xs text-[var(--ink3)]">{v.ipa}</span>}{v.pos && <span className="chip">{v.pos}</span>}<span className="chip">{v.status}</span></div>
                <div className="text-sm">{v.definition}</div>
                {v.sentence && <div className="text-xs italic text-[var(--ink2)] mt-0.5">“{v.sentence}”</div>}
                <div className="text-[11px] text-[var(--ink3)] mt-0.5">{v.book_title ? <button className="underline" onClick={() => v.book_id && go('reader', v.book_id)}>{v.book_title}</button> : null}{v.page ? ` · p. ${v.page}` : ''} · {new Date(v.created_at).toLocaleDateString()}</div>
              </div>
              <button className="btn btn-ghost" onClick={async () => { await del(`/vocab/${v.id}`); reload(); }} aria-label="Delete"><Icon n="trash" size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────── Notes & highlights ─────────
export function NotesView() {
  const [q, setQ] = useState('');
  const { data: notes, reload } = useFetch<any[]>(`/notes?q=${encodeURIComponent(q)}`);
  const { data: hl } = useFetch<any[]>('/highlights');
  const go = useStore((s) => s.go);
  const shown = (hl ?? []).filter((h) => !q || h.text.toLowerCase().includes(q.toLowerCase()) || (h.note ?? '').toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <H sub="Everything you've highlighted or written, searchable across all books.">Notes & highlights</H>
      <div className="flex gap-2 mb-5"><input className="input max-w-sm" placeholder="Search notes and highlights" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /><a className="btn" href="/api/export/data?format=json&what=all" download><Icon n="download" /> All data (JSON)</a><a className="btn" href="/api/export" download>Export Markdown</a></div>
      <div className="grid md:grid-cols-2 gap-6">
        <section><h2 className="label mb-2">Notes ({notes?.length ?? 0})</h2>
          {!notes ? <Spinner /> : notes.length === 0 ? <p className="text-sm text-[var(--ink3)]">No notes.</p> : <div className="space-y-2">{notes.map((n) => (
            <div key={n.id} className="card p-3"><Md text={n.body} /><div className="flex justify-between text-[11px] text-[var(--ink3)] mt-2"><button className="underline" onClick={() => n.book_id && useStore.getState().openAt(n.book_id, n.page ?? 1, n.start_offset, n.end_offset, n.body)}>{n.book_title ?? 'General'}{n.page ? ` · p. ${n.page}` : ''}</button><button onClick={async () => { await del(`/notes/${n.id}`); reload(); }} aria-label="Delete note"><Icon n="trash" size={13} /></button></div></div>
          ))}</div>}</section>
        <section><h2 className="label mb-2">Highlights ({shown.length})</h2>
          {shown.length === 0 ? <p className="text-sm text-[var(--ink3)]">No highlights.</p> : <div className="space-y-2">{shown.map((h) => (
            <button key={h.id} onClick={() => useStore.getState().openAt(h.book_id, h.page, h.start_offset, h.end_offset, h.text)} className="card p-3 w-full text-left block"><mark className={`hl hl-${h.color} text-sm`}>{h.text}</mark>{h.note && <div className="text-xs mt-1">{h.note}</div>}<div className="text-[11px] text-[var(--ink3)] mt-1">{h.book_title} · p. {h.page}</div></button>
          ))}</div>}</section>
      </div>
    </div>
  );
}

// ───────── Knowledge library + graph ─────────
export function KnowledgeView() {
  const [q, setQ] = useState('');
  const { data, reload } = useFetch<any[]>(`/knowledge?q=${encodeURIComponent(q)}`);
  const { data: graph } = useFetch<{ nodes: any[]; edges: any[] }>('/graph');
  const go = useStore((s) => s.go);
  const [tab, setTab] = useState<'library' | 'graph'>('library');
  const grouped = useMemo(() => { const m = new Map<string, any[]>(); (data ?? []).forEach((r) => { const k = r.book_title || 'Other'; m.set(k, [...(m.get(k) ?? []), r]); }); return [...m]; }, [data]);
  return (
    <div>
      <H sub="Concepts and lessons accumulated across pages and books.">Knowledge</H>
      <div className="flex flex-wrap gap-2 mb-5">
        <div className="flex"><button className={`btn ${tab === 'library' ? 'bg-[var(--panel2)]' : ''}`} onClick={() => setTab('library')}>Library</button><button className={`btn ${tab === 'graph' ? 'bg-[var(--panel2)]' : ''}`} onClick={() => setTab('graph')}>Graph</button></div>
        {tab === 'library' && <><input className="input max-w-xs" placeholder="Search knowledge" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></>}
      </div>
      {tab === 'library' ? (
        !data ? <Spinner /> : data.length === 0 ? <Empty title="Nothing saved yet">Concepts you save while reading will collect here.</Empty> : (
          <div className="space-y-8">{grouped.map(([title, rows]) => (
            <section key={title}><h2 className="font-serif text-xl mb-2">{title}</h2>
              <div className="grid md:grid-cols-2 gap-2">{rows.map((r) => (
                <div key={r.id} className="card p-3"><div className="flex justify-between gap-2"><span className="font-medium text-sm">{r.name}</span><span className="chip">{r.category}</span></div>
                  {r.summary && <p className="text-sm text-[var(--ink2)] mt-1">{r.summary}</p>}{r.why && <p className="text-xs mt-1"><b>Why:</b> {r.why}</p>}
                  <div className="flex justify-between text-[11px] text-[var(--ink3)] mt-2"><button className="underline" onClick={() => r.book_id && go('reader', r.book_id)}>{r.book_title} · p. {r.page}</button><button onClick={async () => { await del(`/knowledge/${r.id}`); reload(); }} aria-label="Remove"><Icon n="trash" size={12} /></button></div></div>
              ))}</div></section>
          ))}</div>
        )
      ) : graph ? <Graph nodes={graph.nodes} edges={graph.edges} /> : <Spinner />}
    </div>
  );
}

const NODE_COLOR: Record<string, string> = { goal: '#e11d48', concept: '#3b5bdb', book: '#0f766e', bridge: '#d97706', vocab: '#7c3aed' };
function Graph({ nodes, edges }: { nodes: { id: string; label: string; type: string }[]; edges: { a: string; b: string }[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const sim = useRef<{ x: number; y: number; vx: number; vy: number; n: (typeof nodes)[0] }[]>([]);
  const drag = useRef<number | null>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const W = c.clientWidth, Hh = 560; const dpr = devicePixelRatio || 1; c.width = W * dpr; c.height = Hh * dpr;
    const ctx = c.getContext('2d')!; ctx.scale(dpr, dpr);
    sim.current = nodes.map((n, i) => ({ n, x: W / 2 + Math.cos(i) * 150 * Math.random(), y: Hh / 2 + Math.sin(i) * 150 * Math.random(), vx: 0, vy: 0 }));
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    let raf = 0, tick = 0;
    const style = getComputedStyle(document.documentElement);
    const step = () => {
      const S = sim.current;
      for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
        let dx = S[i].x - S[j].x, dy = S[i].y - S[j].y; const d2 = dx * dx + dy * dy + 0.01, f = 2200 / d2, d = Math.sqrt(d2);
        dx /= d; dy /= d; S[i].vx += dx * f; S[i].vy += dy * f; S[j].vx -= dx * f; S[j].vy -= dy * f;
      }
      for (const e of edges) { const a = S[idx.get(e.a)!], b = S[idx.get(e.b)!]; if (!a || !b) continue; const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - 90) * 0.012; a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f; }
      S.forEach((s, i) => { s.vx += (W / 2 - s.x) * 0.003; s.vy += (Hh / 2 - s.y) * 0.003; if (drag.current !== i) { s.x += s.vx * 0.5; s.y += s.vy * 0.5; } s.vx *= 0.8; s.vy *= 0.8; s.x = Math.max(20, Math.min(W - 20, s.x)); s.y = Math.max(20, Math.min(Hh - 20, s.y)); });
      ctx.clearRect(0, 0, W, Hh); ctx.lineWidth = 1; ctx.strokeStyle = style.getPropertyValue('--line') || '#ccc';
      for (const e of edges) { const a = S[idx.get(e.a)!], b = S[idx.get(e.b)!]; if (!a || !b) continue; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      ctx.font = '11px ui-sans-serif, system-ui'; ctx.textAlign = 'center';
      S.forEach((s) => { ctx.fillStyle = NODE_COLOR[s.n.type] ?? '#888'; ctx.beginPath(); ctx.arc(s.x, s.y, s.n.type === 'goal' ? 9 : s.n.type === 'book' ? 8 : 5.5, 0, 7); ctx.fill(); ctx.fillStyle = style.getPropertyValue('--ink') || '#000'; ctx.fillText(s.n.label.slice(0, 26), s.x, s.y - 11); });
      if (++tick < 400 || drag.current !== null) raf = requestAnimationFrame(step);
    };
    step();
    const pick = (e: MouseEvent) => { const r = c.getBoundingClientRect(); return sim.current.findIndex((s) => Math.hypot(s.x - (e.clientX - r.left), s.y - (e.clientY - r.top)) < 12); };
    const down = (e: MouseEvent) => { const i = pick(e); if (i >= 0) { drag.current = i; tick = 0; raf = requestAnimationFrame(step); } };
    const move = (e: MouseEvent) => { const r = c.getBoundingClientRect(); if (drag.current !== null) { sim.current[drag.current].x = e.clientX - r.left; sim.current[drag.current].y = e.clientY - r.top; } setHover(sim.current[pick(e)]?.n.label ?? null); };
    const up = () => { drag.current = null; };
    c.addEventListener('mousedown', down); window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    return () => { cancelAnimationFrame(raf); c.removeEventListener('mousedown', down); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [nodes, edges]);
  if (!nodes.length) return <Empty title="The graph is empty">It fills as you save concepts. Concepts that appear in more than one book are highlighted as bridges.</Empty>;
  return (
    <div className="card p-2"><canvas ref={ref} style={{ width: '100%', height: 560 }} aria-label="Knowledge graph" role="img" />
      <div className="flex gap-3 flex-wrap text-xs p-2 text-[var(--ink2)]">{Object.entries(NODE_COLOR).map(([k, c]) => <span key={k} className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: c }} />{k === 'bridge' ? 'cross-book concept' : k}</span>)}<span className="ml-auto">{hover}</span></div></div>
  );
}

// ───────── Review (flashcards + vocab SRS) + analytics ─────────
export function ReviewView() {
  const { data: stats, reload: rs } = useFetch<any>('/stats');
  const { data: cards, reload: rc } = useFetch<any[]>('/cards?due=1');
  const { data: vocab, reload: rv } = useFetch<any[]>('/vocab?due=1');
  const [mode, setMode] = useState<'cards' | 'vocab' | 'concepts'>('cards');
  const [flip, setFlip] = useState(false);
  const list = (mode === 'cards' ? cards : vocab) ?? [];
  const cur = list[0];
  async function grade(g: number) {
    if (!cur || mode === 'concepts') return;
    await post(mode === 'cards' ? `/cards/${cur.id}/review` : `/vocab/${cur.id}/review`, { grade: g });
    setFlip(false); await (mode === 'cards' ? rc() : rv()); rs();
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (/INPUT|TEXTAREA/.test((e.target as HTMLElement).tagName)) return; if (e.key === ' ') { e.preventDefault(); setFlip(true); } if (flip && '1234'.includes(e.key)) void grade(Number(e.key) - 1); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });
  return (
    <div>
      <H sub="Spaced repetition: cards come back just before you'd forget them.">Review</H>
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          {[['Reading time', fmtDur(stats.readingSeconds)], ['Books finished', `${stats.completed} / ${stats.books}`], ['Cards due', `${stats.cardsDue} of ${stats.cards}`], ['Retention', stats.retention == null ? '—' : `${Math.round(stats.retention * 100)}%`], ['Words saved', `${stats.vocab} (${stats.vocabMastered} mastered)`], ['Concepts', String(stats.concepts)], ['Quiz average', stats.quizAvg == null ? '—' : `${Math.round(stats.quizAvg * 100)}%`]].map(([k, v]) => <div key={k} className="card p-3"><div className="label">{k}</div><div className="text-xl font-serif mt-1">{v}</div></div>)}
        </div>
      )}
      <details className="mb-8"><summary className="label cursor-pointer">Learning report — what you actually did</summary><div className="mt-3"><ReportView /></div></details>
      <div className="flex gap-2 mb-4"><button className={`btn ${mode === 'cards' ? 'btn-primary' : ''}`} onClick={() => { setMode('cards'); setFlip(false); }}>Flashcards ({cards?.length ?? 0})</button><button className={`btn ${mode === 'vocab' ? 'btn-primary' : ''}`} onClick={() => { setMode('vocab'); setFlip(false); }}>Vocabulary ({vocab?.length ?? 0})</button><button className={`btn ${mode === 'concepts' ? 'btn-primary' : ''}`} onClick={() => setMode('concepts')}>Concepts & teach-back</button></div>
      {mode === 'concepts' ? <ConceptsReview /> : !cur ? <Empty title="Nothing due">{mode === 'cards' ? 'Generate flashcards from a page in the reader (Understand → Study materials).' : 'Save words while reading to practise them here.'}</Empty> : (
        <div className="max-w-xl mx-auto">
          <div className="card p-8 min-h-[16rem] flex flex-col justify-center text-center fade-in" key={cur.id + flip}>
            <div className="label mb-3">{mode === 'cards' ? cur.book_title ?? 'Card' : 'Word'}{cur.page ? ` · p. ${cur.page}` : ''}</div>
            {mode === 'cards' ? (<><div className="font-serif text-2xl whitespace-pre-line">{cur.front}</div>{flip && <div className="mt-5 pt-5 border-t border-[var(--line)] text-[var(--ink2)] whitespace-pre-line">{cur.back}{cur.source_text && <div className="text-xs italic mt-3 text-[var(--ink3)]">Source: “{cur.source_text}”</div>}</div>}</>)
              : (<><div className="font-serif text-3xl">{cur.word}</div>{cur.sentence && <div className="text-sm italic text-[var(--ink2)] mt-3">“{cur.sentence.replace(new RegExp(cur.word, 'i'), '_____')}”</div>}{flip && <div className="mt-5 pt-5 border-t border-[var(--line)] text-[var(--ink2)]">{cur.ipa && <div className="mb-1">{cur.ipa}</div>}{cur.definition}</div>}</>)}
          </div>
          <div className="flex justify-center gap-2 mt-4">
            {!flip ? <button className="btn btn-primary" onClick={() => setFlip(true)}>Show answer (Space)</button> :
              [['Again', 0], ['Hard', 1], ['Good', 2], ['Easy', 3]].map(([l, g], i) => <button key={l} className="btn" onClick={() => grade(g as number)}>{l} <span className="text-[var(--ink3)] text-xs">{i + 1}</span></button>)}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────── Settings & model setup ─────────
const TASK_LABELS: Record<string, string> = { assistant: 'General AI assistant', comprehension: 'Book comprehension (Ask)', summary: 'Summarisation', vocabulary: 'Vocabulary & translation', knowledge: 'Knowledge extraction, flashcards & quizzes', embedding: 'Embeddings (semantic search)' };

export function SettingsView() {
  const { data: st, reload } = useFetch<any>('/status');
  const [pull, setPull] = useState<{ model: string; status: string; pct: number } | null>(null);
  const [custom, setCustom] = useState('');
  const { prefs, setPrefs } = useStore();
  const installed = new Set<string>(st?.ollama?.models?.map((m: any) => m.name));

  async function download(model: string) {
    setPull({ model, status: 'starting', pct: 0 });
    try {
      const r = await fetch('/api/ollama/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
      if (!r.ok || !r.body) throw new Error((await r.json()).error);
      const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const j = JSON.parse(l); setPull({ model, status: j.error ?? j.status, pct: j.total ? (j.completed / j.total) * 100 : 0 }); } catch { /* */ } } }
    } catch (e: any) { setPull({ model, status: `Failed: ${e.message}`, pct: 0 }); return; }
    setPull(null); reload();
  }

  return (
    <div className="max-w-3xl">
      <H sub="All AI runs locally through Ollama. Nothing is sent to any cloud service.">Settings & models</H>
      <div className="mb-8"><AccountSettings /></div>
      <div className="mb-8"><MemorySettings /></div>
      <section className="mb-8">
        <h2 className="label mb-2">Appearance</h2>
        <div className="flex gap-2">{(['light', 'sepia', 'dark'] as const).map((t) => <button key={t} className={`btn ${prefs.theme === t ? 'btn-primary' : ''}`} onClick={() => setPrefs({ theme: t })}>{t}</button>)}</div>
      </section>

      <section className="mb-8">
        <h2 className="label mb-2">Local AI (Ollama)</h2>
        {!st ? <Spinner /> : !st.ollama.online ? (
          <div className="card p-4 space-y-2 text-sm"><div className="font-medium" style={{ color: 'var(--danger)' }}>Ollama is not running.</div>
            <p>Reading, dictionary lookup, search, highlights and browser audio work without it. Summaries, Ask and study materials need a local model.</p>
            <ol className="list-decimal ml-5 space-y-1"><li>Install Ollama (free): <code>https://ollama.com/download</code></li><li>Start it (it runs in the background after install, or run <code>ollama serve</code>).</li><li>Come back and press Refresh — then download a model below.</li></ol>
            <button className="btn" onClick={reload}>Refresh</button></div>
        ) : (
          <div className="space-y-4">
            <div className="text-sm text-[var(--ink2)]">Connected to {st.ollama.url} · {st.ollama.models.length} model{st.ollama.models.length === 1 ? '' : 's'} installed.</div>
            {st.ollama.models.filter((m: any) => !m.embedding).length === 0 && <ErrorNote error="No chat model installed yet. Download one below — nothing will answer until you do." />}
            <div className="card divide-y divide-[var(--line)]">
              {Object.entries(TASK_LABELS).map(([task, label]) => {
                const pool = st.ollama.models.filter((m: any) => (task === 'embedding' ? m.embedding : !m.embedding));
                return (
                  <div key={task} className="p-3 flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-[12rem] text-sm">{label}{!st.resolved[task] && <span className="text-xs ml-2" style={{ color: 'var(--danger)' }}>not available</span>}</div>
                    <select className="input !w-56" value={st.prefs[`model.${task}`] ?? ''} onChange={async (e) => { await api('/prefs', { method: 'PUT', json: { key: `model.${task}`, value: e.target.value } }); reload(); }} aria-label={label}>
                      <option value="">Auto ({st.resolved[task] ?? 'none'})</option>{pool.map((m: any) => <option key={m.name} value={m.name}>{m.name} · {m.params ?? ''}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
            <div>
              <h3 className="text-sm font-medium mb-2">Download a model</h3>
              <div className="card divide-y divide-[var(--line)]">
                {st.recommended.map((m: any) => (
                  <div key={m.name} className="p-3 flex items-center gap-3"><div className="flex-1"><div className="text-sm font-medium">{m.name}</div><div className="text-xs text-[var(--ink3)]">{m.note}</div></div>
                    {installed.has(m.name) || installed.has(m.name + ':latest') ? <span className="chip">installed</span> : <button className="btn" disabled={!!pull} onClick={() => download(m.name)}><Icon n="download" /> Download</button>}</div>
                ))}
                <form className="p-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) void download(custom.trim()); }}><input className="input" placeholder="Any Ollama model, e.g. qwen3:14b" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Model name" /><button className="btn" disabled={!!pull}>Download</button></form>
              </div>
              {pull && <div className="mt-3 card p-3 text-sm"><div className="flex justify-between"><span>{pull.model}: {pull.status}</span><span>{pull.pct ? `${pull.pct.toFixed(0)}%` : ''}</span></div><div className="h-1.5 bg-[var(--panel2)] rounded mt-2"><div className="h-1.5 rounded bg-[var(--accent)]" style={{ width: `${pull.pct}%` }} /></div></div>}
              <p className="text-xs text-[var(--ink3)] mt-2">Hardware: 8B-class models want ≈8 GB of free RAM/VRAM; 4B ≈5 GB; 1.7B ≈3 GB. Smaller models are faster but make more mistakes — answers are always grounded in retrieved book text and cited, but check important facts.</p>
              {!st.resolved.embedding && <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>No embedding model: search falls back to keyword-only. Download <code>nomic-embed-text</code>, then re-open a book's “Re-process” to build vectors.</p>}
            </div>
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="label mb-2">Capabilities on this machine</h2>
        {st && (
          <ul className="card p-4 text-sm space-y-1.5">
            <li>✔ Native: PDF, EPUB, DOCX, TXT, Markdown, HTML, FB2, CSV, XLSX, images and scanned PDFs (Tesseract OCR, run from the reader)</li>
            <li>{st.caps.calibre ? '✔' : '✖'} MOBI / AZW / AZW3 via Calibre {st.caps.calibre ? '' : <span className="text-[var(--ink3)]">— install Calibre to enable (DRM-protected files are not supported)</span>}</li>
            <li>{st.caps.libreoffice ? '✔' : '✖'} DOC / PPT / PPTX / ODT / RTF via LibreOffice {st.caps.libreoffice ? '' : <span className="text-[var(--ink3)]">— install LibreOffice to enable</span>}</li>
            <li>{st.piper ? '✔' : '✖'} Piper neural TTS {st.piper ? '' : <span className="text-[var(--ink3)]">— optional; browser speech works without it</span>}</li>
            <li>✖ CBZ/CBR comics are not implemented yet</li>
          </ul>
        )}
      </section>

      <CaptureSettings />
      <LanguageSettings />

      <section>
        <h2 className="label mb-2">Your data</h2>
        <div className="flex gap-2 flex-wrap"><a className="btn" href="/api/backup" download><Icon n="download" /> Full backup (.zip)</a><a className="btn" href="/api/export" download><Icon n="download" /> Export notes (Markdown)</a></div>
        <p className="text-xs text-[var(--ink3)] mt-2">The backup contains the database plus original files. To restore: stop the app, unzip into the <code>data/</code> folder (files → data/files, covers → data/covers, bookreader.db), start again.</p>
      </section>
    </div>
  );
}
