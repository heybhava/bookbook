'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, post, patch, del, put, ndjson } from '@/lib/api';
import { useStore, type View } from '@/lib/store';
import { Icon, Md, Spinner, Empty, ErrorNote, useFetch, fmtDur } from './ui';
import { L, LangSelect } from './Lang';

const H = ({ children, sub }: { children: React.ReactNode; sub?: string }) => (
  <header className="mb-6"><h1 className="font-serif text-3xl tracking-tight">{children}</h1>{sub && <p className="text-sm text-[var(--ink2)] mt-1">{sub}</p>}</header>
);
const TYPE_LABEL: Record<string, string> = { selection: 'Passage', note: 'Note', ai: 'AI note', quote: 'Quote', question: 'Question', objective: 'Objective', action: 'Action', concept: 'Concept', lesson: 'Lesson', framework: 'Framework', formula: 'Formula', insight: 'Insight', highlight: 'Highlight', vocab: 'Vocabulary', principle: 'Principle', application: 'Application', example: 'Example' };

// ───────────────── Knowledge Inbox ─────────────────
interface Item {
  key: string; src: 'note' | 'highlight' | 'vocab' | 'concept'; id: string; type: string; title: string | null; body: string; tags: string[];
  book_id: string | null; book_title: string | null; author: string | null; page: number | null; chapter: string | null; section: string | null;
  context: string | null; start: number | null; end: number | null; created_at: number; collection: string | null; extra?: any;
}

export function InboxView() {
  const { openAt, say } = useStore();
  const [type, setType] = useState('all'); const [q, setQ] = useState(''); const [tag, setTag] = useState(''); const [coll, setColl] = useState(''); const [sort, setSort] = useState('new');
  const qs = `/inbox?type=${type}&q=${encodeURIComponent(q)}&tag=${encodeURIComponent(tag)}&collection=${encodeURIComponent(coll)}&sort=${sort}`;
  const { data, reload, loading } = useFetch<{ items: Item[]; total: number; counts: Record<string, number>; tags: string[]; collections: string[] }>(qs);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [quick, setQuick] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const toggle = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const chosen = (data?.items ?? []).filter((i) => sel.has(i.key));

  async function bulk(action: 'delete' | 'tag' | 'flashcard') {
    if (!chosen.length) return;
    if (action === 'delete') { if (!confirm(`Delete ${chosen.length} items?`)) return; for (const i of chosen) await del(`/inbox/${i.src}/${i.id}`); }
    if (action === 'tag') { const t = prompt('Tag to add to the selected notes'); if (!t) return; for (const i of chosen.filter((x) => x.src === 'note')) await patch(`/notes/${i.id}`, { tags: [...i.tags, t.trim()].join(',') }); }
    if (action === 'flashcard') { let n = 0; for (const i of chosen) { await post('/inbox/convert', { key: i.key, to: 'flashcard' }); n++; } say(`${n} flashcards created`); }
    setSel(new Set()); reload();
  }
  async function doImport(f: File) {
    const text = await f.text();
    try {
      const r = f.name.endsWith('.json') ? await post('/import', { format: 'json', data: JSON.parse(text) }) : await post('/import', { format: 'markdown', title: f.name.replace(/\.\w+$/, ''), text });
      say(`Imported ${r.notes} notes, ${r.vocab} words, ${r.cards} cards`); reload();
    } catch (e: any) { say(`Import failed: ${e.message}`); }
  }

  return (
    <div>
      <H sub="Everything you capture while reading, in one searchable place — each item keeps its source.">Knowledge Inbox</H>
      <form className="flex gap-2 mb-4 max-w-2xl" onSubmit={async (e) => { e.preventDefault(); if (!quick.trim()) return; await post('/notes', { body: quick, kind: 'note' }); setQuick(''); reload(); }}>
        <input className="input" placeholder="Quick capture — a thought, question or idea…" value={quick} onChange={(e) => setQuick(e.target.value)} aria-label="Quick capture" />
        <button className="btn btn-primary" disabled={!quick.trim()}>Capture</button>
      </form>
      <div className="flex flex-wrap gap-1.5 mb-3">
        <button className={`chip ${type === 'all' ? '!bg-[var(--accent)] !text-[var(--accent-ink)]' : ''}`} onClick={() => setType('all')}>All {data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : ''}</button>
        {Object.entries(data?.counts ?? {}).sort((a, b) => b[1] - a[1]).map(([t, n]) => <button key={t} className={`chip ${type === t ? '!bg-[var(--accent)] !text-[var(--accent-ink)]' : ''}`} onClick={() => setType(t)}>{TYPE_LABEL[t] ?? t} {n}</button>)}
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        <input className="input max-w-xs" placeholder="Search inbox" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search inbox" />
        <select className="input !w-auto" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag"><option value="">All tags</option>{data?.tags.map((t) => <option key={t}>{t}</option>)}</select>
        <select className="input !w-auto" value={coll} onChange={(e) => setColl(e.target.value)} aria-label="Collection"><option value="">All collections</option>{data?.collections.map((t) => <option key={t}>{t}</option>)}</select>
        <select className="input !w-auto" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort"><option value="new">Newest</option><option value="old">Oldest</option><option value="book">By book & page</option></select>
        <details className="relative"><summary className="btn cursor-pointer list-none"><Icon n="download" /> Export / import</summary>
          <div className="absolute z-20 mt-1 card p-3 shadow-xl w-64 space-y-2 text-sm">
            <div className="label">Export</div>
            <div className="flex flex-wrap gap-1">{['md', 'json', 'csv', 'html'].map((f) => <a key={f} className="btn" href={`/api/export/data?format=${f}&what=${f === 'csv' ? 'notes' : 'all'}`} download>{f.toUpperCase()}</a>)}</div>
            <div className="text-[11px] text-[var(--ink3)]">CSV exports notes; use JSON for everything. For PDF, open the HTML export and print.</div>
            <div className="label pt-1">Import</div>
            <button className="btn w-full justify-center" onClick={() => importRef.current?.click()}>Folio JSON or Markdown file…</button>
            <input ref={importRef} type="file" accept=".json,.md,.markdown,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ''; }} />
          </div></details>
      </div>
      {chosen.length > 0 && (
        <div className="card p-2 mb-3 flex items-center gap-2 text-sm"><b>{chosen.length} selected</b>
          <button className="btn" onClick={() => bulk('tag')}>Add tag</button><button className="btn" onClick={() => bulk('flashcard')}>→ Flashcards</button>
          <button className="btn" style={{ color: 'var(--danger)' }} onClick={() => bulk('delete')}>Delete</button><button className="btn btn-ghost ml-auto" onClick={() => setSel(new Set())}>Clear</button></div>
      )}
      {loading && !data ? <Spinner /> : !data?.items.length ? <Empty title="Nothing here yet">Select a sentence or passage while reading and it lands here automatically, with its book, chapter and page.</Empty> : (
        <div className="space-y-2.5">{data.items.map((i) => <InboxCard key={i.key} i={i} checked={sel.has(i.key)} toggle={() => toggle(i.key)} reload={reload} openAt={openAt} />)}</div>
      )}
    </div>
  );
}

function InboxCard({ i, checked, toggle, reload, openAt }: { i: Item; checked: boolean; toggle: () => void; reload: () => void; openAt: ReturnType<typeof useStore.getState>['openAt'] }) {
  const { say, ask, go } = useStore();
  const [tr, setTr] = useState<{ lang: string; text: string } | null>(null); const [trBusy, setTrBusy] = useState(false); const [trLang, setTrLang] = useState(useStore.getState().langPrefs.reading ?? 'te');
  const [edit, setEdit] = useState(false); const [body, setBody] = useState(i.body); const [tags, setTags] = useState(i.tags.join(', ')); const [showCtx, setShowCtx] = useState(false);
  const meta = [i.book_title, i.author, i.chapter, i.section && i.section !== i.chapter ? i.section : null, i.page ? `p. ${i.page}` : null].filter(Boolean).join(' · ');
  return (
    <article className="card p-3.5 flex gap-3">
      <input type="checkbox" className="mt-1.5" checked={checked} onChange={toggle} aria-label="Select item" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1"><span className="chip">{TYPE_LABEL[i.type] ?? i.type}</span>{i.title && i.src !== 'note' && <b className="text-sm">{i.title}</b>}{i.collection && <span className="chip">{i.collection}</span>}{i.tags.map((t) => <span key={t} className="chip">#{t}</span>)}<span className="ml-auto text-[11px] text-[var(--ink3)]">{new Date(i.created_at).toLocaleDateString()}</span></div>
        {edit && i.src === 'note' ? (
          <div className="space-y-2"><textarea className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Edit text" /><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, comma separated" aria-label="Tags" />
            <div className="flex gap-2"><button className="btn btn-primary" onClick={async () => { await patch(`/notes/${i.id}`, { body, tags }); setEdit(false); reload(); }}>Save</button><button className="btn" onClick={() => setEdit(false)}>Cancel</button></div></div>
        ) : <p className={`text-[0.95rem] leading-relaxed whitespace-pre-wrap ${['selection', 'highlight', 'quote'].includes(i.type) ? 'font-serif border-l-2 border-[var(--accent)] pl-3' : ''}`}>{i.body || i.title}</p>}
        {tr && <div className="mt-2 p-2 rounded bg-[var(--panel2)]"><div className="text-[10px] text-[var(--ink3)] mb-0.5">{tr.lang}</div><L code={tr.lang} block className="text-sm">{tr.text}</L></div>}
        {i.src === 'vocab' && i.context && <p className="text-xs italic text-[var(--ink2)] mt-1">“{i.context}”</p>}
        {showCtx && i.context && i.src === 'note' && <p className="text-xs text-[var(--ink2)] mt-2 p-2 rounded bg-[var(--panel2)] whitespace-pre-wrap">{i.context}</p>}
        {meta && <div className="text-[11px] text-[var(--ink3)] mt-2">{meta}</div>}
        <div className="flex flex-wrap gap-1 mt-2 text-xs">
          {i.book_id && i.page && <button className="btn !py-1" onClick={() => openAt(i.book_id!, i.page!, i.start, i.end, i.body)}><Icon n="book" size={13} /> Open in book</button>}
          {i.src === 'note' && <button className="btn !py-1" onClick={() => setEdit(!edit)}><Icon n="edit" size={13} /> Edit</button>}
          {i.src === 'note' && <span className="inline-flex gap-1"><LangSelect className="!w-40 !py-1 !text-xs" value={trLang} onChange={setTrLang} label="Translate note to" /><button className="btn !py-1" disabled={trBusy} onClick={async () => { setTrBusy(true); try { const r = await post(`/notes/${i.id}/translate`, { tgt: trLang }); setTr({ lang: trLang, text: r.text }); } catch (e: any) { say(e.message); } setTrBusy(false); }}>{trBusy ? '…' : 'Translate'}</button></span>}
          {i.context && i.src === 'note' && <button className="btn !py-1" onClick={() => setShowCtx(!showCtx)}>{showCtx ? 'Hide' : 'Show'} context</button>}
          {i.book_id && i.page && <button className="btn !py-1" onClick={() => { openAt(i.book_id!, i.page!, i.start, i.end, i.body); setTimeout(() => ask(`Explain this passage: "${i.body.slice(0, 400)}"`), 600); }}>Ask AI</button>}
          <select className="input !w-auto !py-1 !text-xs" value="" onChange={async (e) => {
            const to = e.target.value; if (!to) return;
            try { const r = await post('/inbox/convert', { key: i.key, to }); say(to === 'flashcard' ? `Flashcard created${r.how === 'cloze' ? ' (fill-in-the-blank; no AI model was needed)' : ''}` : `Converted to ${to}`); reload(); } catch (err: any) { say(err.message); }
          }} aria-label="Convert to"><option value="">Convert to…</option>{['note', 'flashcard', 'concept', 'question', 'objective', 'action'].map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <button className="btn btn-ghost !py-1 ml-auto" style={{ color: 'var(--danger)' }} onClick={async () => { await del(`/inbox/${i.src}/${i.id}`); reload(); }} aria-label="Delete"><Icon n="trash" size={13} /></button>
          {i.src === 'vocab' && <button className="btn !py-1" onClick={() => go('vocab')}>Vocabulary</button>}
        </div>
      </div>
    </article>
  );
}

// ───────────────── Ask your library ─────────────────
interface Src { n: number; own: boolean; book_id: string | null; book_title: string; author: string | null; chapter: string | null; page_start: number; page_end: number; quote: string; via: string[] }
const MODE_OPTS: [string, string, string][] = [['answer', 'Answer', 'Answer from everything I have read'], ['learned', 'What I learned', 'Summarise what I have learned, using my notes'], ['compare', 'Compare authors', 'Compare how my books treat this'], ['contradictions', 'Find contradictions', 'Where do my sources disagree or agree?'], ['teach', 'Teach me', 'Teach me this topic from my library']];
const STARTERS = ['What have I learned about cash flow?', 'What are the most important ideas across my books?', 'Compare how the authors explain strategy', 'Find contradictions between my sources'];

export function AskLibraryView() {
  const { openAt } = useStore();
  const { data: books } = useFetch<any[]>('/books');
  const [q, setQ] = useState(''); const [mode, setMode] = useState('answer'); const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [text, setText] = useState(''); const [meta, setMeta] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState<{ cited: number[]; invalid: number[] } | null>(null);
  const [hl, setHl] = useState<number | null>(null);
  const ready = (books ?? []).filter((b) => b.status === 'ready' || b.status === 'readable');

  async function run(question = q, m = mode) {
    if (!question.trim() || busy) return;
    setQ(question); setBusy(true); setText(''); setMeta(null); setErr(null); setDone(null);
    try {
      await ndjson('/ai/library-ask', { question, mode: m, bookIds: ids }, (e) => {
        if (e.type === 'meta') setMeta(e); else if (e.type === 'delta') setText((t) => t + e.text); else if (e.type === 'done') setDone(e); else if (e.type === 'error') setErr(e.error);
      });
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }
  const srcs: Src[] = meta?.sources ?? [];
  return (
    <div className="max-w-5xl">
      <H sub="Ask across every book and note. Answers cite real passages; the evidence is kept separate from the AI's interpretation.">Ask your library</H>
      <form onSubmit={(e) => { e.preventDefault(); void run(); }} className="space-y-3 mb-6">
        <textarea className="input" rows={2} placeholder="What have I learned about…? Compare how my authors explain…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void run(); } }} aria-label="Question" />
        <div className="flex flex-wrap gap-2 items-center">
          <select className="input !w-auto" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Mode">{MODE_OPTS.map(([k, l]) => <option key={k} value={k} title={l}>{l}</option>)}</select>
          <details className="relative"><summary className="btn cursor-pointer list-none">{ids.length ? `${ids.length} books` : 'All books'}</summary>
            <div className="absolute z-20 mt-1 card p-2 shadow-xl w-72 max-h-64 overflow-auto text-sm">{ready.map((b) => <label key={b.id} className="flex gap-2 p-1.5 hover:bg-[var(--panel2)] rounded"><input type="checkbox" checked={ids.includes(b.id)} onChange={(e) => setIds(e.target.checked ? [...ids, b.id] : ids.filter((x) => x !== b.id))} /><span className="truncate">{b.title}</span></label>)}{!ready.length && <div className="p-2 text-[var(--ink3)]">No books yet.</div>}{ids.length > 0 && <button type="button" className="btn w-full justify-center mt-1" onClick={() => setIds([])}>Search all books</button>}</div></details>
          <button className="btn btn-primary" disabled={busy || !q.trim()}><Icon n="sparkle" /> Ask</button>
        </div>
        {!text && !busy && <div className="flex flex-wrap gap-1.5">{STARTERS.map((s) => <button key={s} type="button" className="chip hover:!bg-[var(--panel2)]" onClick={() => void run(s, s.startsWith('Compare') ? 'compare' : s.startsWith('Find contr') ? 'contradictions' : 'answer')}>{s}</button>)}</div>}
      </form>
      {busy && !text && <Spinner label="Searching your library…" />}
      {err && <div className="space-y-2 mb-4"><ErrorNote error={err} /></div>}
      {meta && (
        <div className="grid lg:grid-cols-5 gap-6">
          <div className="lg:col-span-3 min-w-0">
            {text ? <Md text={text} cites={new Set(srcs.map((s) => s.n))} onCite={(n) => { setHl(n); document.getElementById(`src-${n}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }} /> : null}
            {done?.invalid?.length ? <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>The model cited source(s) {done.invalid.join(', ')} that were not provided — ignore those.</p> : null}
            <div className="mt-4 p-3 rounded-lg bg-[var(--panel2)] text-xs space-y-1"><div><b>Evidence confidence:</b> {meta.confidence}</div>{meta.limitations.map((l: string, k: number) => <div key={k} className="text-[var(--ink2)]">{l}</div>)}<div className="text-[var(--ink3)]">Model: {meta.model}</div></div>
            {meta.vocab?.length > 0 && <div className="mt-3 text-xs"><span className="label">Related vocabulary</span> {meta.vocab.map((v: any) => <span key={v.word} className="chip mr-1" title={v.definition}>{v.word}</span>)}</div>}
          </div>
          <aside className="lg:col-span-2 space-y-2" aria-label="Sources">
            <div className="label">Sources ({srcs.length})</div>
            {srcs.map((s) => (
              <div key={s.n} id={`src-${s.n}`} className={`card p-3 text-xs ${hl === s.n ? 'ring-2 ring-[var(--accent)]' : ''}`}>
                <div className="flex justify-between gap-2"><b>[S{s.n}] {s.own ? 'Your note' : s.book_title}</b><span className="text-[var(--ink3)] shrink-0">{s.via.join(' + ')}</span></div>
                {!s.own && <div className="text-[var(--ink3)]">{[s.author, s.chapter, `p. ${s.page_start}${s.page_end !== s.page_start ? `–${s.page_end}` : ''}`].filter(Boolean).join(' · ')}</div>}
                <p className="mt-1.5 text-[var(--ink2)] line-clamp-5 whitespace-pre-wrap">{s.quote}</p>
                {s.book_id && s.page_start > 0 && <button className="underline mt-1.5" onClick={() => openAt(s.book_id!, s.page_start)}>Open in book</button>}
              </div>
            ))}
          </aside>
        </div>
      )}
    </div>
  );
}

// ───────────────── Writing & thinking workspace ─────────────────
export function WriteView() {
  const { say } = useStore();
  const { data: drafts, reload } = useFetch<any[]>('/drafts');
  const [id, setId] = useState<string | null>(null); const [title, setTitle] = useState(''); const [text, setText] = useState('');
  const [saved, setSaved] = useState(true); const ta = useRef<HTMLTextAreaElement>(null);
  const [panel, setPanel] = useState<'' | 'source' | 'ai'>('');
  const [sq, setSq] = useState(''); const [res, setRes] = useState<any>(null);
  const [instr, setInstr] = useState(''); const [aiBusy, setAiBusy] = useState(false); const [aiOut, setAiOut] = useState<any>(null); const [aiErr, setAiErr] = useState<string | null>(null);

  async function open(d: string) { const x = await api<any>(`/drafts/${d}`); setId(x.id); setTitle(x.title); setText(x.body); setSaved(true); }
  useEffect(() => { if (id) return; if (drafts?.[0]) void open(drafts[0].id); }, [drafts, id]);
  useEffect(() => {
    if (!id || saved) return;
    const t = setTimeout(async () => { await patch(`/drafts/${id}`, { title, body: text }); setSaved(true); reload(); }, 900);
    return () => clearTimeout(t);
  }, [id, title, text, saved, reload]);
  useEffect(() => { if (sq.trim().length < 2) return setRes(null); const t = setTimeout(() => api(`/search?q=${encodeURIComponent(sq)}`).then(setRes).catch(() => {}), 250); return () => clearTimeout(t); }, [sq]);

  const insert = (s: string) => { const el = ta.current; const pos = el?.selectionStart ?? text.length; setText(text.slice(0, pos) + s + text.slice(pos)); setSaved(false); };
  async function create() { const r = await post('/drafts', { title: 'Untitled', body: '' }); reload(); await open(r.id); }

  return (
    <div className="grid md:grid-cols-[14rem_1fr] gap-6">
      <aside><H>Write</H><button className="btn btn-primary w-full justify-center mb-3" onClick={create}><Icon n="plus" /> New draft</button>
        <div className="space-y-1">{drafts?.map((d) => <button key={d.id} onClick={() => open(d.id)} className={`w-full text-left px-2.5 py-2 rounded-lg text-sm ${d.id === id ? 'bg-[var(--panel2)] font-medium' : 'hover:bg-[var(--panel2)]'}`}><div className="truncate">{d.title}</div><div className="text-[11px] text-[var(--ink3)] truncate">{d.preview || 'Empty'}</div></button>)}</div></aside>
      <section className="min-w-0">
        {!id ? <Empty title="Start a draft">Write notes, outlines, essays or research summaries. Insert real passages from your books as cited quotes, and ask the AI to help using your library.</Empty> : (
          <div>
            <div className="flex gap-2 mb-3"><input className="input font-serif text-xl" value={title} onChange={(e) => { setTitle(e.target.value); setSaved(false); }} aria-label="Title" />
              <button className="btn" onClick={() => setPanel(panel === 'source' ? '' : 'source')}>Insert source</button><button className="btn" onClick={() => setPanel(panel === 'ai' ? '' : 'ai')}><Icon n="sparkle" /> Assist</button>
              <button className="btn" onClick={() => { const b = new Blob([`# ${title}\n\n${text}`], { type: 'text/markdown' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${title || 'draft'}.md`; a.click(); }}><Icon n="download" /></button>
              <button className="btn" style={{ color: 'var(--danger)' }} onClick={async () => { if (confirm('Delete this draft?')) { await del(`/drafts/${id}`); setId(null); reload(); } }} aria-label="Delete draft"><Icon n="trash" /></button></div>
            <div className="grid lg:grid-cols-[1fr_20rem] gap-4">
              <div><textarea ref={ta} className="input font-serif leading-relaxed" style={{ minHeight: '60vh', fontSize: '1.05rem' }} value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} placeholder="Write here. Markdown is fine." aria-label="Draft" />
                <div className="text-[11px] text-[var(--ink3)] mt-1">{saved ? 'Saved' : 'Saving…'} · {text.trim() ? text.trim().split(/\s+/).length : 0} words</div></div>
              {panel === 'source' && (
                <div className="space-y-2"><input className="input" placeholder="Search notes, highlights, books…" value={sq} onChange={(e) => setSq(e.target.value)} autoFocus aria-label="Search sources" />
                  {res?.passages?.map((p: any, k: number) => <button key={'p' + k} className="card p-2 text-xs text-left w-full hover:bg-[var(--panel2)]" onClick={() => insert(`\n> ${p.snippet.replace(/[\[\]]/g, '').replace(/\n/g, ' ')}\n> — ${p.book_title}, p. ${p.page}\n`)}><b>{p.book_title}</b> p. {p.page}<div className="text-[var(--ink2)] mt-1">{p.snippet.replace(/[\[\]]/g, '')}</div></button>)}
                  {res?.notes?.map((n: any) => <button key={n.id} className="card p-2 text-xs text-left w-full hover:bg-[var(--panel2)]" onClick={() => insert(`\n> ${n.body.replace(/\n/g, ' ')}${n.book_title ? `\n> — ${n.book_title}${n.page ? `, p. ${n.page}` : ''}` : ''}\n`)}><span className="chip">{n.kind}</span><div className="mt-1 line-clamp-3">{n.body}</div></button>)}
                  <p className="text-[11px] text-[var(--ink3)]">Inserted quotes carry the real book and page.</p></div>
              )}
              {panel === 'ai' && (
                <div className="space-y-2"><textarea className="input" rows={3} placeholder="e.g. Outline an essay on cash flow using my books" value={instr} onChange={(e) => setInstr(e.target.value)} aria-label="Instruction" />
                  <button className="btn btn-primary w-full justify-center" disabled={aiBusy || !instr.trim()} onClick={async () => { setAiBusy(true); setAiErr(null); setAiOut(null); try { setAiOut(await post('/ai/draft-assist', { instruction: instr, draft: text })); } catch (e: any) { setAiErr(e.message); } setAiBusy(false); }}>Generate from my library</button>
                  {aiBusy && <Spinner label="Reading your sources…" />}{aiErr && <ErrorNote error={aiErr} />}
                  {aiOut && <div className="card p-3 text-sm space-y-2"><Md text={aiOut.text} /><div className="text-[11px] text-[var(--ink3)] space-y-0.5">{aiOut.refs.map((r: string) => <div key={r}>{r}</div>)}</div>
                    <button className="btn w-full justify-center" onClick={() => { insert(`\n${aiOut.text}\n${aiOut.refs.length ? `\n**References**\n${aiOut.refs.map((r: string) => `- ${r}`).join('\n')}\n` : ''}`); say('Inserted'); }}>Insert into draft</button></div>}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ───────────────── Concept mastery, quiz and Teach it back (Review tab) ─────────────────
export function ConceptsReview() {
  const { data, reload, loading } = useFetch<any[]>('/mastery');
  const [quiz, setQuiz] = useState<any>(null); const [qBusy, setQBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [tb, setTb] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="space-y-5">
      <p className="text-sm text-[var(--ink2)]">Mastery moves only when you are tested — quiz answers and Teach it back — never from reading time.</p>
      <div className="flex gap-2"><button className="btn btn-primary" disabled={qBusy || !data?.length} onClick={async () => { setQBusy(true); setErr(null); try { setQuiz(await post('/ai/concept-quiz', {})); } catch (e: any) { setErr(e.message); } setQBusy(false); }}>Quiz me on my weakest concepts</button></div>
      {qBusy && <Spinner label="Writing questions from your saved concepts…" />}{err && <ErrorNote error={err} />}
      {quiz && <ConceptQuiz quiz={quiz} done={() => { setQuiz(null); reload(); }} />}
      {loading && !data ? <Spinner /> : !data?.length ? <Empty title="No concepts yet">Extract concepts with Goal Lens while reading, or convert Inbox items to concepts.</Empty> : (
        <div className="grid md:grid-cols-2 gap-2.5">{data.map((c) => (
          <div key={c.id} className="card p-3"><div className="flex justify-between gap-2"><b className="text-sm">{c.name}</b><span className="text-xs text-[var(--ink3)]">{c.attempts ? `${Math.round(c.score)}%` : 'untested'}</span></div>
            <div className="h-1.5 rounded bg-[var(--panel2)] mt-2"><div className="h-1.5 rounded bg-[var(--accent)]" style={{ width: `${c.score}%` }} /></div>
            {c.summary && <p className="text-xs text-[var(--ink2)] mt-2 line-clamp-2">{c.summary}</p>}
            <div className="flex justify-between items-center mt-2 text-[11px] text-[var(--ink3)]"><span>{[c.book_title, c.page ? `p. ${c.page}` : '', c.goals].filter(Boolean).join(' · ')}</span><button className="btn !py-1" onClick={() => setTb({ id: c.id, name: c.name })}>Teach it back</button></div></div>
        ))}</div>
      )}
      {tb && <TeachBack concept={tb} onClose={() => { setTb(null); reload(); }} />}
    </div>
  );
}

function ConceptQuiz({ quiz, done }: { quiz: any; done: () => void }) {
  const [ans, setAns] = useState<Record<number, string>>({}); const [checked, setChecked] = useState(false);
  const ok = (q: any, a?: string) => q.type !== 'short' && (a ?? '').trim().toLowerCase() === String(q.answer).trim().toLowerCase();
  return (
    <div className="card p-4 space-y-3">
      {quiz.questions.map((q: any, i: number) => (
        <div key={i} className="text-sm"><div className="text-[11px] text-[var(--ink3)]">{q.conceptName}</div><div className="font-medium">{i + 1}. {q.q}</div>
          {q.type === 'mcq' && q.options?.map((o: string) => <label key={o} className="flex gap-2 mt-1"><input type="radio" name={`cq${i}`} disabled={checked} checked={ans[i] === o} onChange={() => setAns({ ...ans, [i]: o })} />{o}</label>)}
          {q.type === 'tf' && <div className="flex gap-4 mt-1">{['true', 'false'].map((o) => <label key={o} className="flex gap-1"><input type="radio" name={`cq${i}`} disabled={checked} checked={ans[i] === o} onChange={() => setAns({ ...ans, [i]: o })} />{o}</label>)}</div>}
          {q.type === 'short' && <textarea className="input mt-1" rows={2} disabled={checked} value={ans[i] ?? ''} onChange={(e) => setAns({ ...ans, [i]: e.target.value })} />}
          {checked && <div className="text-xs mt-1">{q.type === 'short' ? <>Model answer: {q.answer} <button className="underline ml-2" onClick={() => setAns({ ...ans, [i]: '__right' })}>I got it</button></> : ok(q, ans[i]) ? <span className="text-green-600">Correct</span> : <span style={{ color: 'var(--danger)' }}>Answer: {q.answer}</span>}<div className="text-[var(--ink3)]">{q.explanation}</div></div>}
        </div>
      ))}
      <div className="flex gap-2">{!checked ? <button className="btn btn-primary" onClick={() => setChecked(true)}>Check answers</button> : <button className="btn btn-primary" onClick={async () => {
        await post('/mastery/record', { results: quiz.questions.map((q: any, i: number) => ({ conceptId: q.conceptId, correct: q.type === 'short' ? ans[i] === '__right' : ok(q, ans[i]) })) });
        await post(`/quizzes/${quiz.id}/attempt`, { score: quiz.questions.filter((q: any, i: number) => (q.type === 'short' ? ans[i] === '__right' : ok(q, ans[i]))).length, total: quiz.questions.length, answers: ans });
        done();
      }}>Record results</button>}<button className="btn" onClick={done}>Close</button></div>
    </div>
  );
}

function TeachBack({ concept, onClose }: { concept: { id: string; name: string }; onClose: () => void }) {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [r, setR] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 grid place-items-center p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card w-full max-w-2xl max-h-[88vh] overflow-auto p-5 space-y-3" role="dialog" aria-label="Teach it back">
        <div className="flex justify-between"><h2 className="font-semibold">Teach it back: {concept.name}</h2><button className="btn btn-ghost" onClick={onClose} aria-label="Close"><Icon n="x" /></button></div>
        <p className="text-sm text-[var(--ink2)]">Explain this concept in your own words, as if to someone new. It is checked against your saved source passage.</p>
        <textarea className="input" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Explain it here…" aria-label="Your explanation" />
        <button className="btn btn-primary" disabled={busy || text.trim().split(/\s+/).length < 8} onClick={async () => { setBusy(true); setErr(null); try { setR(await post('/ai/teach-back', { conceptId: concept.id, explanation: text })); } catch (e: any) { setErr(e.message); } setBusy(false); }}>Evaluate my explanation</button>
        {busy && <Spinner label="Comparing with the source…" />}{err && <ErrorNote error={err} />}
        {r && (
          <div className="space-y-2 text-sm fade-in">
            <div className="grid grid-cols-3 gap-2 text-center">{[['Accuracy', r.accuracy], ['Depth', r.depth], ['Application', r.application]].map(([k, v]) => <div key={k as string} className="card p-2"><div className="label">{k}</div><div className="text-xl font-serif">{v}</div></div>)}</div>
            <p>{r.feedback}</p>
            {r.missing?.length > 0 && <div><b>Missing:</b><ul className="list-disc ml-5">{r.missing.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul></div>}
            {r.misunderstandings?.length > 0 && <div><b>Misunderstandings:</b><ul className="list-disc ml-5">{r.misunderstandings.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul></div>}
            {r.followUps?.length > 0 && <div><b>Think about:</b><ul className="list-disc ml-5">{r.followUps.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul></div>}
            <p className="text-[11px] text-[var(--ink3)]">Judged by {r.model} against {r.evaluatedAgainst?.join(', ') || 'your saved summary'} · new mastery {Math.round(r.mastery)}%. Local models can misjudge — treat as feedback, not a grade.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────────── Learning report ─────────────────
export function ReportView() {
  const [period, setPeriod] = useState<'week' | 'month'>('week');
  const { data: r } = useFetch<any>(`/report?period=${period}`, [period]);
  const { data: vi } = useFetch<any>('/vocab/insights');
  if (!r) return <Spinner />;
  const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  return (
    <div className="space-y-4">
      <div className="flex gap-2"><button className={`btn ${period === 'week' ? 'btn-primary' : ''}`} onClick={() => setPeriod('week')}>Last 7 days</button><button className={`btn ${period === 'month' ? 'btn-primary' : ''}`} onClick={() => setPeriod('month')}>Last 30 days</button></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{[
        ['Reading time', fmtDur(r.reading.seconds)], ['Pages turned', r.reading.pages], ['Speed', r.reading.pagesPerHour ? `${r.reading.pagesPerHour} pages/h` : '—'], ['Passages captured', r.captured.passages],
        ['Notes written', r.captured.notes], ['Words saved', r.vocabulary.saved], ['Word recall', pct(r.vocabulary.recall)], ['Card retention', pct(r.cards.retention)],
        ['Concepts found', r.concepts.discovered], ['Concepts tested', r.concepts.tested], ['Teach-backs', r.concepts.teachbacks], ['Quizzes taken', r.quizzes.attempts]].map(([k, v]) => <div key={k as string} className="card p-3"><div className="label">{k}</div><div className="text-xl font-serif mt-1">{v}</div></div>)}</div>
      <div className="grid md:grid-cols-3 gap-3 text-sm">
        <div className="card p-3"><div className="label mb-1">Strongest concepts</div>{r.concepts.strongest.length ? r.concepts.strongest.map((c: any) => <div key={c.name} className="flex justify-between"><span className="truncate">{c.name}</span><span>{Math.round(c.score)}%</span></div>) : <span className="text-[var(--ink3)]">Nothing tested in this period.</span>}</div>
        <div className="card p-3"><div className="label mb-1">Needs work</div>{r.concepts.weakest.length ? r.concepts.weakest.map((c: any) => <div key={c.name} className="flex justify-between"><span className="truncate">{c.name}</span><span>{Math.round(c.score)}%</span></div>) : <span className="text-[var(--ink3)]">—</span>}</div>
        <div className="card p-3"><div className="label mb-1">Goals advanced</div>{r.goals.length ? r.goals.map((g: any) => <div key={g.title} className="flex justify-between"><span className="truncate">{g.title}</span><span>+{g.items}</span></div>) : <span className="text-[var(--ink3)]">No new knowledge saved.</span>}</div>
      </div>
      {vi?.forgotten?.length > 0 && <div className="text-sm"><span className="label">Words you forget most</span> {vi.forgotten.map((w: any) => <span key={w.word} className="chip mr-1">{w.word} ×{w.lapses}</span>)}</div>}
      {vi?.byBook?.length > 0 && <div className="text-sm"><span className="label">Vocabulary by source</span> {vi.byBook.map((b: any) => <span key={b.title} className="chip mr-1">{b.title.slice(0, 30)} · {b.n}</span>)}</div>}
      <p className="text-xs text-[var(--ink3)]">This report counts things you did (captured, tested, recalled), not pages opened. Reading speed needs a few minutes of reading to be meaningful.</p>
    </div>
  );
}

// ───────────────── Goal gap analysis ─────────────────
export function GapAnalysis({ goal }: { goal: any }) {
  const { openAt } = useStore();
  const { data, setData } = useFetch<any>(`/goals/${goal.id}/gaps`);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const color: Record<string, string> = { covered: 'var(--accent)', partial: '#d97706', gap: 'var(--danger)' };
  return (
    <div className="mt-3 pt-3 border-t border-[var(--line)] space-y-3">
      <button className="btn" disabled={busy} onClick={async () => { setBusy(true); setErr(null); try { setData(await post(`/goals/${goal.id}/gaps`)); } catch (e: any) { setErr(e.message); } setBusy(false); }}>{data ? 'Re-analyse knowledge gaps' : 'Analyse knowledge gaps & learning path'}</button>
      {busy && <Spinner label="Comparing your saved knowledge with the goal…" />}{err && <ErrorNote error={err} />}
      {data && (
        <div className="space-y-3 text-sm fade-in">
          <p className="text-[11px] text-[var(--ink3)]">{data.note} Based on {data.savedConcepts} saved concepts · {new Date(data.generated_at).toLocaleDateString()}.</p>
          <div className="flex flex-wrap gap-1.5">{data.topics.map((t: any, i: number) => <span key={i} className="chip" title={t.why} style={{ borderColor: color[t.status], color: color[t.status] }}>{t.status === 'covered' ? '✔' : t.status === 'partial' ? '◐' : '○'} {t.name}</span>)}</div>
          {data.path?.length > 0 && <div><div className="label mb-1">Learning path</div><ol className="list-decimal ml-5 space-y-0.5">{data.path.map((s: any, i: number) => <li key={i}><b>{s.topic}</b> — {s.action}</li>)}</ol></div>}
          {data.nextReads?.length > 0 && <div><div className="label mb-1">Read next (from your library)</div>{data.nextReads.map((b: any) => <div key={b.book_id} className="flex justify-between gap-2 py-0.5"><span><b>{b.title}</b> <span className="text-[var(--ink3)]">covers {b.topics.join(', ')}</span></span><button className="underline shrink-0" onClick={() => openAt(b.book_id, b.pages[0])}>p. {b.pages[0]}</button></div>)}</div>}
          {data.nextReads?.length === 0 && <p className="text-xs text-[var(--ink3)]">None of your current books address the gaps. Add a book on: {data.topics.filter((t: any) => t.status === 'gap').slice(0, 3).map((t: any) => t.name).join(', ')}.</p>}
          {data.exercises?.length > 0 && <div><div className="label mb-1">Practice</div><ul className="list-disc ml-5">{data.exercises.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>}
          {data.actions?.length > 0 && <div><div className="label mb-1">Apply</div><ul className="list-disc ml-5">{data.actions.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>}
        </div>
      )}
    </div>
  );
}

// ───────────────── Settings additions ─────────────────
export function CaptureSettings() {
  const { captureMode, setCaptureMode, vocabHints, setVocabHints } = useStore();
  const { data: st, reload } = useFetch<any>('/status');
  const [instr, setInstr] = useState<string | null>(null);
  const prefs = st?.prefs ?? {};
  return (
    <section className="mb-8 space-y-4">
      <h2 className="label">Reading capture</h2>
      <div className="card p-4 space-y-3 text-sm">
        <div><div className="font-medium mb-1">When I select text</div>
          {([['sentences', 'Save sentences and passages to Notes automatically (words open vocabulary instead)'], ['all', 'Save every selection, including single words'], ['highlight', 'Save only when I highlight']] as const).map(([k, l]) => <label key={k} className="flex gap-2 py-0.5"><input type="radio" name="cap" checked={captureMode === k} onChange={() => setCaptureMode(k)} />{l}</label>)}</div>
        <label className="flex gap-2"><input type="checkbox" checked={vocabHints} onChange={(e) => setVocabHints(e.target.checked)} />Suggest vocabulary: subtly underline words that may be worth learning</label>
      </div>
      <h2 className="label">AI behaviour</h2>
      <div className="card p-4 space-y-3 text-sm">
        <label className="flex items-center gap-3">Answer length<select className="input !w-auto" value={prefs['ai.length'] ?? 'normal'} onChange={async (e) => { await put('/prefs', { key: 'ai.length', value: e.target.value }); reload(); }}><option value="short">Short</option><option value="normal">Normal</option><option value="long">Detailed</option></select></label>
        <label className="block">Custom instructions for the companion<textarea className="input mt-1" rows={3} placeholder="e.g. Use Australian spelling. Relate ideas to software engineering." value={instr ?? prefs['ai.instructions'] ?? ''} onChange={(e) => setInstr(e.target.value)} onBlur={async () => { if (instr !== null) { await put('/prefs', { key: 'ai.instructions', value: instr }); reload(); } }} /></label>
      </div>
    </section>
  );
}

// ───────────────── Command palette (Ctrl/Cmd+K) ─────────────────
export function CommandPalette() {
  const { palette, setPalette, go, openAt, say } = useStore();
  const [q, setQ] = useState(''); const [res, setRes] = useState<any>(null); const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(!useStore.getState().palette); } else if (e.key === 'Escape') setPalette(false); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [setPalette]);
  useEffect(() => { if (palette) { setQ(''); setRes(null); setIdx(0); setTimeout(() => input.current?.focus(), 30); } }, [palette]);
  useEffect(() => { if (q.trim().length < 2) return setRes(null); const t = setTimeout(() => api(`/search?q=${encodeURIComponent(q)}`).then(setRes).catch(() => {}), 200); return () => clearTimeout(t); }, [q]);
  const cmds = useMemo(() => {
    const nav: [string, View][] = [['Library', 'home'], ['Knowledge Inbox', 'inbox'], ['Ask your library', 'ask'], ['Write', 'write'], ['Review & learning report', 'review'], ['Vocabulary', 'vocab'], ['Notes & highlights', 'notes'], ['Goals', 'goals'], ['Knowledge graph', 'knowledge'], ['Settings & models', 'settings']];
    const items: { label: string; hint: string; run: () => void }[] = nav.map(([l, v]) => ({ label: l, hint: 'Go to', run: () => go(v) }));
    for (const b of res?.books ?? []) items.push({ label: b.title, hint: 'Open book', run: () => go('reader', b.id) });
    for (const n of res?.notes ?? []) items.push({ label: n.body.slice(0, 90), hint: `${n.kind}${n.book_title ? ` · ${n.book_title}` : ''}`, run: () => (n.book_id && n.page ? openAt(n.book_id, n.page, null, null, n.body) : go('inbox')) });
    for (const v of res?.vocab ?? []) items.push({ label: v.word, hint: v.definition?.slice(0, 60) ?? 'Vocabulary', run: () => go('vocab') });
    for (const p of res?.passages ?? []) items.push({ label: p.snippet.replace(/[\[\]]/g, '').slice(0, 100), hint: `${p.book_title} · p. ${p.page}`, run: () => openAt(p.book_id, p.page, null, null) });
    items.push({ label: 'Ask library: ' + q, hint: 'Question', run: () => { go('ask'); say('Type your question and press Enter'); } });
    const needle = q.toLowerCase();
    return items.filter((i, k) => !q || k >= nav.length + 0 || i.label.toLowerCase().includes(needle) || i.hint.toLowerCase().includes(needle)).filter((i) => !i.label.startsWith('Ask library: ') || q.trim().length > 1);
  }, [res, q, go, openAt, say]);
  if (!palette) return null;
  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-start justify-center pt-[12vh] p-4" onMouseDown={(e) => e.target === e.currentTarget && setPalette(false)}>
      <div className="card w-full max-w-xl shadow-2xl overflow-hidden fade-in" role="dialog" aria-label="Command palette">
        <input ref={input} className="w-full px-4 py-3 bg-transparent outline-none border-b border-[var(--line)] text-base" placeholder="Search books, notes, vocabulary, passages — or jump anywhere" value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(cmds.length - 1, i + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); } else if (e.key === 'Enter') { cmds[idx]?.run(); setPalette(false); } }} aria-label="Command palette search" />
        <div className="max-h-[50vh] overflow-auto py-1">{cmds.map((c, i) => <button key={i} className={`w-full text-left px-4 py-2 text-sm flex justify-between gap-3 ${i === idx ? 'bg-[var(--panel2)]' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => { c.run(); setPalette(false); }}><span className="truncate">{c.label}</span><span className="text-xs text-[var(--ink3)] shrink-0 truncate max-w-[40%]">{c.hint}</span></button>)}</div>
      </div>
    </div>
  );
}
