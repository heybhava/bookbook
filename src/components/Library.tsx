'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, patch, del, post } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Icon, Empty, Modal, useFetch, Spinner } from './ui';
import { renderPageCanvas } from './reader/PdfPage';

interface BookRow {
  id: string; title: string; author: string | null; format: string; tags: string; page_count: number; status: string; status_detail: string | null;
  created_at: number; last_opened_at: number | null; has_cover: number; page: number; percent: number; collections: string[];
}
const ACCEPT = '.pdf,.epub,.txt,.md,.markdown,.html,.htm,.docx,.csv,.xlsx,.fb2,.mobi,.azw,.azw3,.rtf,.doc,.ppt,.pptx,.odt,.jpg,.jpeg,.png,.webp';

function Cover({ b, className = '' }: { b: BookRow; className?: string }) {
  const hue = [...b.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return b.has_cover ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/books/${b.id}/cover`} alt="" className={`object-cover ${className}`} />
  ) : (
    <div className={`flex flex-col justify-between p-3 ${className}`} style={{ background: `linear-gradient(145deg, hsl(${hue} 28% 34%), hsl(${(hue + 30) % 360} 30% 22%))`, color: '#fff' }}>
      <div className="font-serif text-[13px] leading-tight font-semibold line-clamp-4">{b.title}</div>
      <div className="text-[10px] opacity-70 uppercase tracking-wide">{b.format}</div>
    </div>
  );
}

export function Library() {
  const go = useStore((s) => s.go);
  const [q, setQ] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState<'recent' | 'title' | 'added' | 'progress'>('recent');
  const [filter, setFilter] = useState<string>('all');
  const [coll, setColl] = useState<string>('');
  const { data: books, reload, loading } = useFetch<BookRow[]>(`/books?q=${encodeURIComponent(q)}`);
  const { data: collections, reload: reloadColl } = useFetch<{ id: string; name: string }[]>('/collections');
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [results, setResults] = useState<{ name: string; error?: string }[]>([]);
  const [edit, setEdit] = useState<BookRow | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // poll while anything is still processing
  const busy = books?.some((b) => ['queued', 'processing', 'readable'].includes(b.status));
  useEffect(() => { if (!busy) return; const t = setInterval(reload, 1800); return () => clearInterval(t); }, [busy, reload]);

  // PDFs have no embedded cover: render page 1 once, store it server-side as the cover.
  const coverTried = useRef(new Set<string>());
  useEffect(() => {
    const next = books?.find((b) => b.format === 'pdf' && !b.has_cover && (b.status === 'readable' || b.status === 'ready') && !coverTried.current.has(b.id));
    if (!next) return;
    coverTried.current.add(next.id);
    (async () => {
      try {
        const c = await renderPageCanvas(next.id, 1, 0.9);
        const blob: Blob | null = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
        if (blob) { await fetch(`/api/books/${next.id}/cover`, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: blob }); reload(); }
      } catch { /* keep the generated cover */ }
    })();
  }, [books, reload]);

  async function upload(files: FileList | File[]) {
    const list = [...files]; if (!list.length) return;
    setUploading(`Uploading ${list.length} file${list.length > 1 ? 's' : ''}…`);
    const fd = new FormData(); list.forEach((f) => fd.append('files', f));
    try {
      const r = await fetch('/api/books', { method: 'POST', body: fd });
      const j = await r.json(); setResults(j.results ?? [{ name: '', error: j.error }]);
    } catch (e: any) { setResults([{ name: '', error: e.message }]); }
    setUploading(null); reload();
  }

  const shown = useMemo(() => {
    let r = [...(books ?? [])];
    if (filter !== 'all') r = r.filter((b) => (filter === 'reading' ? b.percent > 0 && b.percent < 0.98 : filter === 'finished' ? b.percent >= 0.98 : filter === 'unread' ? b.percent === 0 : b.format === filter));
    if (coll) r = r.filter((b) => b.collections.includes(coll));
    r.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'added' ? b.created_at - a.created_at : sort === 'progress' ? b.percent - a.percent : (b.last_opened_at ?? b.created_at) - (a.last_opened_at ?? a.created_at));
    return r;
  }, [books, filter, coll, sort]);
  const reading = (books ?? []).filter((b) => b.last_opened_at && b.percent > 0 && b.percent < 0.98 && b.status !== 'error').sort((a, b) => b.last_opened_at! - a.last_opened_at!).slice(0, 4);
  const formats = [...new Set((books ?? []).map((b) => b.format))];

  return (
    <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }} onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); }} className="relative min-h-[70vh]">
      {drag && <div className="absolute inset-0 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-[var(--accent)] bg-[var(--bg)]/90 text-lg font-medium">Drop to add to your library</div>}

      <header className="flex flex-wrap items-end justify-between gap-3 mb-8">
        <div>
          <h1 className="font-serif text-3xl tracking-tight">Read anything. Understand everything.</h1>
          <p className="text-[var(--ink2)] text-sm mt-1">Drag books here — PDF, EPUB, DOCX, TXT, Markdown, HTML, FB2, CSV, XLSX, images (OCR). Everything stays on this computer.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={() => input.current?.click()}><Icon n="upload" /> Add books</button>
          <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ''; }} />
        </div>
      </header>

      {uploading && <div className="mb-4"><Spinner label={uploading} /></div>}
      {results.some((r) => r.error) && (
        <div className="mb-4 card p-3 text-sm text-[var(--danger)]" role="alert">
          {results.filter((r) => r.error).map((r, i) => <div key={i}>{r.name}: {r.error}</div>)}
          <button className="btn btn-ghost mt-1" onClick={() => setResults([])}>Dismiss</button>
        </div>
      )}

      {reading.length > 0 && !q && (
        <section className="mb-10" aria-label="Continue reading">
          <h2 className="label mb-3">Continue reading</h2>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            {reading.map((b) => (
              <button key={b.id} onClick={() => go('reader', b.id)} className="card p-3 flex gap-3 text-left hover:shadow-md transition-shadow">
                <Cover b={b} className="w-16 h-24 rounded-md shrink-0 overflow-hidden" />
                <div className="min-w-0 flex-1 flex flex-col justify-between">
                  <div><div className="font-medium text-sm line-clamp-2">{b.title}</div><div className="text-xs text-[var(--ink3)] truncate">{b.author}</div></div>
                  <div><div className="h-1 bg-[var(--panel2)] rounded"><div className="h-1 rounded bg-[var(--accent)]" style={{ width: `${b.percent * 100}%` }} /></div><div className="text-[11px] text-[var(--ink3)] mt-1">Page {b.page} of {b.page_count}</div></div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section aria-label="All books">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-[200px] max-w-sm"><Icon n="search" className="absolute left-2.5 top-2.5 text-[var(--ink3)]" /><input className="input pl-8" placeholder="Search title, author, tag" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search library" /></div>
          <select className="input !w-auto" value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort"><option value="recent">Recently opened</option><option value="added">Recently added</option><option value="title">Title</option><option value="progress">Progress</option></select>
          <select className="input !w-auto" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter"><option value="all">All</option><option value="reading">Reading</option><option value="unread">Unread</option><option value="finished">Finished</option>{formats.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}</select>
          <select className="input !w-auto" value={coll} onChange={(e) => setColl(e.target.value)} aria-label="Collection"><option value="">All collections</option>{collections?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button className="btn" onClick={async () => { const name = prompt('New collection name'); if (name) { await post('/collections', { name }); reloadColl(); } }}>+ Collection</button>
          <div className="ml-auto flex">
            <button className={`btn ${view === 'grid' ? 'bg-[var(--panel2)]' : ''}`} onClick={() => setView('grid')} aria-label="Grid view"><Icon n="grid" /></button>
            <button className={`btn ${view === 'list' ? 'bg-[var(--panel2)]' : ''}`} onClick={() => setView('list')} aria-label="List view"><Icon n="list" /></button>
          </div>
        </div>

        {loading && !books ? <Spinner /> : shown.length === 0 ? (
          <Empty title={q || filter !== 'all' ? 'No books match' : 'Your library is empty'}>
            {q || filter !== 'all' ? 'Try clearing the search or filters.' : 'Drag a PDF or EPUB anywhere on this page to start reading. Nothing is uploaded to the internet.'}
          </Empty>
        ) : view === 'grid' ? (
          <div className="grid gap-5 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {shown.map((b) => <BookCard key={b.id} b={b} onEdit={() => setEdit(b)} />)}
          </div>
        ) : (
          <div className="card divide-y divide-[var(--line)]">
            {shown.map((b) => (
              <div key={b.id} className="flex items-center gap-3 p-3">
                <button disabled={b.status === 'error' || b.status === 'queued'} onClick={() => go('reader', b.id)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                  <Cover b={b} className="w-8 h-11 rounded shrink-0 overflow-hidden" />
                  <div className="min-w-0"><div className="text-sm font-medium truncate">{b.title}</div><div className="text-xs text-[var(--ink3)] truncate">{b.author || '—'} · {b.format.toUpperCase()} · {b.page_count} pages</div></div>
                </button>
                <StatusChip b={b} /><div className="w-24 hidden sm:block h-1 bg-[var(--panel2)] rounded"><div className="h-1 rounded bg-[var(--accent)]" style={{ width: `${b.percent * 100}%` }} /></div>
                <button className="btn btn-ghost" onClick={() => setEdit(b)} aria-label="Edit"><Icon n="edit" /></button>
              </div>
            ))}
          </div>
        )}
      </section>

      {edit && <EditModal b={edit} collections={collections ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function StatusChip({ b }: { b: BookRow }) {
  if (b.status === 'ready') return null;
  const label = b.status === 'error' ? 'Failed' : b.status === 'readable' ? 'Indexing…' : 'Processing…';
  return <span className="chip" title={b.status_detail ?? ''} style={b.status === 'error' ? { color: 'var(--danger)' } : undefined}>{label}</span>;
}

function BookCard({ b, onEdit }: { b: BookRow; onEdit: () => void }) {
  const go = useStore((s) => s.go);
  const openable = b.status === 'readable' || b.status === 'ready';
  return (
    <div className="group">
      <button disabled={!openable} onClick={() => go('reader', b.id)} className="block w-full text-left relative" aria-label={`Open ${b.title}`}>
        <Cover b={b} className="w-full aspect-[2/3] rounded-lg overflow-hidden shadow-md group-hover:shadow-xl group-hover:-translate-y-0.5 transition-all" />
        {b.percent > 0 && <div className="absolute left-2 right-2 bottom-2 h-1 rounded bg-black/30"><div className="h-1 rounded bg-white" style={{ width: `${b.percent * 100}%` }} /></div>}
        {!openable && <div className="absolute inset-0 rounded-lg bg-black/55 grid place-items-center text-white text-xs p-2 text-center">{b.status === 'error' ? <span title={b.status_detail ?? ''}>⚠ {b.status_detail?.slice(0, 90)}</span> : <Spinner label="Processing…" />}</div>}
      </button>
      <div className="mt-2 flex items-start gap-1">
        <div className="min-w-0 flex-1"><div className="text-sm font-medium line-clamp-2 leading-snug">{b.title}</div><div className="text-xs text-[var(--ink3)] truncate">{b.author || b.format.toUpperCase()}</div>{b.status === 'readable' && <span className="chip mt-1" title={b.status_detail ?? ''}>Indexing…</span>}</div>
        <button className="btn btn-ghost !p-1 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={onEdit} aria-label={`Edit ${b.title}`}><Icon n="edit" size={14} /></button>
      </div>
    </div>
  );
}

function EditModal({ b, collections, onClose, onSaved }: { b: BookRow; collections: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(b.title); const [author, setAuthor] = useState(b.author ?? ''); const [tags, setTags] = useState(b.tags ?? '');
  const [cols, setCols] = useState<string[]>(b.collections);
  return (
    <Modal title="Book details" onClose={onClose}>
      <div className="space-y-3">
        <label className="block"><span className="label">Title</span><input className="input mt-1" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="block"><span className="label">Author</span><input className="input mt-1" value={author} onChange={(e) => setAuthor(e.target.value)} /></label>
        <label className="block"><span className="label">Tags (comma separated)</span><input className="input mt-1" value={tags} onChange={(e) => setTags(e.target.value)} /></label>
        {collections.length > 0 && <div><span className="label">Collections</span><div className="flex flex-wrap gap-2 mt-1">{collections.map((c) => <label key={c.id} className="chip cursor-pointer flex items-center gap-1"><input type="checkbox" checked={cols.includes(c.id)} onChange={(e) => setCols(e.target.checked ? [...cols, c.id] : cols.filter((x) => x !== c.id))} />{c.name}</label>)}</div></div>}
        {b.status_detail && <p className="text-xs text-[var(--ink3)]">{b.status_detail}</p>}
        <div className="flex justify-between pt-2">
          <button className="btn" style={{ color: 'var(--danger)' }} onClick={async () => { if (confirm(`Delete "${b.title}" and its highlights, notes and index? This cannot be undone.`)) { await del(`/books/${b.id}`); onSaved(); } }}><Icon n="trash" /> Delete</button>
          <div className="flex gap-2">
            <button className="btn" onClick={async () => { await post(`/books/${b.id}/reprocess`); onSaved(); }}>Re-process</button>
            <button className="btn btn-primary" onClick={async () => { await patch(`/books/${b.id}`, { title, author, tags, collections: cols }); onSaved(); }}>Save</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export { api };
