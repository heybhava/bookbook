'use client';
// Vault: notes as plain Markdown files with explorer, source editor, reading view, backlinks, properties, outline, history, graph and quick switcher.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, post } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Icon, Spinner, ErrorNote, Empty } from './ui';
import { BasesPane } from './Bases';

type FileEnt = { path: string; name: string; ext: string; size: number; mtime: number };
type Tab = 'backlinks' | 'outgoing' | 'props' | 'outline' | 'history';
const vq = (vid: string, p: string) => `${p}${p.includes('?') ? '&' : '?'}vault=${vid}`;
const enc = encodeURIComponent;
const stem = (p: string) => p.split('/').pop()!.replace(/\.md$/i, '');
const jf = async (vid: string, p: string, method: string, json?: unknown) => api(vq(vid, p), { method, json });

export function VaultView() {
  const { say } = useStore();
  const [vaults, setVaults] = useState<any[] | null>(null); const [vid, setVid] = useState<string>(''); const [tree, setTree] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); const [text, setText] = useState(''); const [hash, setHash] = useState(''); const [dirty, setDirty] = useState(false); const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ text: string; hash: string } | null>(null);
  const [mode, setMode] = useState<'source' | 'reading' | 'graph'>('source'); const [tab, setTab] = useState<Tab>('backlinks'); const [switcher, setSwitcher] = useState(false);
  const [adding, setAdding] = useState(false); const [query, setQuery] = useState(''); const [results, setResults] = useState<any | null>(null); const [tags, setTags] = useState<any[]>([]); const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const textRef = useRef(text); textRef.current = text; const hashRef = useRef(hash); hashRef.current = hash; const openRef = useRef(open); openRef.current = open;

  const loadVaults = useCallback(async () => { const v = await api<any[]>('/vaults'); setVaults(v); setVid((cur) => cur && v.some((x) => x.id === cur) ? cur : (() => { try { const s = localStorage.getItem('folio.vault'); if (s && v.some((x) => x.id === s)) return s; } catch { /* */ } return v[0]?.id ?? ''; })()); }, []);
  useEffect(() => { loadVaults().catch((e) => setErr(e.message)); }, [loadVaults]);
  useEffect(() => { try { if (vid) localStorage.setItem('folio.vault', vid); } catch { /* */ } }, [vid]);
  const refresh = useCallback(async () => { if (!vid) return; try { setTree(await api(vq(vid, '/vault/tree'))); setTags(await api(vq(vid, '/vault/tags'))); setErr(null); } catch (e: any) { setErr(e.message); } }, [vid]);
  useEffect(() => { setOpen(null); setTree(null); setResults(null); if (vid) { refresh(); try { const last = localStorage.getItem(`folio.vault.${vid}.open`); if (last) openFile(last, true); } catch { /* */ } } }, [vid]); // eslint-disable-line react-hooks/exhaustive-deps
  // pick up edits made outside bookbook when the window regains focus
  useEffect(() => { const f = () => { refresh(); const p = openRef.current; if (p && !dirtyRef.current) api<any>(vq(vid, `/vault/file?path=${enc(p)}`)).then((r) => { if (r.hash !== hashRef.current) { setText(r.text); setHash(r.hash); say('Reloaded — the file changed on disk'); } }).catch(() => {}); }; window.addEventListener('focus', f); return () => window.removeEventListener('focus', f); }, [vid, refresh, say]);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;

  async function openFile(p: string, quiet = false) {
    if (dirtyRef.current && openRef.current) await save();
    try { const r = await api<any>(vq(vid, `/vault/file?path=${enc(p)}`)); setOpen(p); setText(r.text); setHash(r.hash); setDirty(false); setConflict(null); if (!/\.md$/i.test(p)) setMode('reading'); try { localStorage.setItem(`folio.vault.${vid}.open`, p); } catch { /* */ } }
    catch (e: any) { if (!quiet) say(e.message); }
  }
  async function save(force = false) {
    const p = openRef.current; if (!p || (!dirtyRef.current && !force)) return; setSaving(true);
    try { const r = await api<any>('/vault/file', { method: 'PUT', json: { vault: vid, path: p, text: textRef.current, baseHash: force ? undefined : hashRef.current } }); setHash(r.hash); setDirty(false); setConflict(null); }
    catch (e: any) { if (e.status === 409 && e.body?.disk) setConflict(e.body.disk); else say(e.message); }
    setSaving(false);
  }
  useEffect(() => { if (!dirty) return; const t = setTimeout(() => { void save(); }, 900); return () => clearTimeout(t); }, [text, dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); setSwitcher(true); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); setMode((m) => (m === 'source' ? 'reading' : 'source')); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!query.trim() || !vid) { setResults(null); return; } const t = setTimeout(() => { api(vq(vid, `/vault/search?q=${enc(query)}`)).then(setResults).catch((e) => setErr(e.message)); }, 250); return () => clearTimeout(t); }, [query, vid]);

  async function newNote(folder = '', name?: string, content = '') {
    const n = name ?? window.prompt('Note name', 'Untitled'); if (!n) return;
    try { const r = await api<any>('/vault/create-note', { method: 'POST', json: { vault: vid, name: n, folder, content } }); await refresh(); await openFile(r.path); setMode('source'); } catch (e: any) { say(e.message); }
  }
  async function newBase() {
    const src = (window.prompt("Base of: notes, books or highlights", "notes") ?? "").trim().toLowerCase(); if (!src) return; const nm = window.prompt("Base name", "Untitled"); if (!nm) return;
    try { const r = await post("/vault/base/new", { vault: vid, name: nm, source: src }); await refresh(); await openFile(r.path); } catch (e: any) { say(e.message); }
  }
  async function newFolder(parent = '') { const n = window.prompt('Folder name'); if (!n) return; try { await post('/vault/folder', { vault: vid, path: (parent ? parent + '/' : '') + n }); await refresh(); } catch (e: any) { say(e.message); } }
  async function rename(p: string) {
    const isFile = tree.files.some((f: FileEnt) => f.path === p); const cur = isFile ? p.split('/').pop()! : p.split('/').pop()!; const nn = window.prompt('New name (links to it are updated)', cur); if (!nn || nn === cur) return;
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : ''; const to = dir + (isFile && !/\.[a-z0-9]+$/i.test(nn) ? nn + '.md' : nn);
    try { if (dirtyRef.current) await save(); const r = await post('/vault/move', { vault: vid, from: p, to }); await refresh(); if (open === p) await openFile(to); else if (open) await openFile(open); say(`Renamed${r.rewritten ? ` · updated links in ${r.rewritten} note${r.rewritten > 1 ? 's' : ''}` : ''}`); } catch (e: any) { say(e.message); }
  }
  async function remove(p: string) { if (!window.confirm(`Move "${p}" to the vault's .trash folder?`)) return; try { await api(vq(vid, `/vault/file?path=${enc(p)}`), { method: 'DELETE' }); if (open === p) { setOpen(null); setText(''); } await refresh(); } catch (e: any) { say(e.message); } }
  async function followLink(target: string | null, create?: string, anchor?: string) {
    if (create) { await newNote('', create, `# ${create}\n\n`); return; }
    if (target) { await openFile(target); setMode('reading'); if (anchor) setTimeout(() => document.getElementById('vault-reading')?.querySelector(`[id="${CSS.escape(anchor)}"]`)?.scrollIntoView(), 100); }
  }

  if (err && !vaults) return <ErrorNote error={err} />;
  if (!vaults) return <Spinner label="Loading vaults…" />;
  if (!vaults.length || adding) return <CreateVault onDone={async (id) => { await loadVaults(); setVid(id); setAdding(false); }} onCancel={vaults.length ? () => setAdding(false) : undefined} />;

  return (
    <div className="flex h-[calc(100vh-0px)] min-h-0 text-sm" onClick={() => undefined}>
      <aside className="w-64 shrink-0 border-r border-[var(--line)] bg-[var(--panel)] flex flex-col min-h-0">
        <div className="p-2 border-b border-[var(--line)] space-y-2">
          <div className="flex gap-1">
            <select className="input !py-1 flex-1" value={vid} onChange={(e) => setVid(e.target.value)} aria-label="Vault">{vaults.map((v) => <option key={v.id} value={v.id}>{v.name}{v.exists ? '' : ' (missing)'}</option>)}</select>
            <button className="btn !px-2" title="Add or open another vault" onClick={() => setAdding(true)} aria-label="Add vault">+</button>
          </div>
          <div className="flex gap-1"><button className="btn flex-1 justify-center" onClick={() => newNote()} title="New note">New note</button><button className="btn" onClick={newBase} title="New base (database view)" aria-label="New base">Base</button><button className="btn" onClick={() => newFolder()} title="New folder" aria-label="New folder"><Icon n="library" size={14} /></button><button className="btn" onClick={() => setSwitcher(true)} title="Quick switcher (Ctrl+O)" aria-label="Quick switcher"><Icon n="search" size={14} /></button></div>
          <input className="input !py-1" placeholder="Search vault… (tag:#x  [prop:value]  file:  path:  -exclude)" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search vault" />
        </div>
        <div className="flex-1 overflow-auto p-1.5">
          {!tree ? <Spinner /> : results ? <SearchResults r={results} onOpen={(p) => { setQuery(''); openFile(p); }} /> : <Explorer tree={tree} open={open} collapsed={collapsed} setCollapsed={setCollapsed} onOpen={openFile} onNew={newNote} onNewFolder={newFolder} onRename={rename} onDelete={remove} />}
        </div>
        {tags.length > 0 && !results && <details className="border-t border-[var(--line)] p-2 max-h-40 overflow-auto"><summary className="label cursor-pointer">Tags ({tags.length})</summary><div className="flex flex-wrap gap-1 mt-1">{tags.map((t) => <button key={t.tag} className="rounded-full border border-[var(--line)] px-2 py-0.5 text-xs hover:bg-[var(--panel2)]" onClick={() => setQuery(`tag:#${t.tag}`)}>#{t.tag} <span className="text-[var(--ink3)]">{t.n}</span></button>)}</div></details>}
        {tree && <div className="border-t border-[var(--line)] px-2 py-1.5 text-[11px] text-[var(--ink3)] flex justify-between"><span>{tree.stats.notes} notes · {tree.stats.links} links</span><button onClick={async () => { const r = await post('/vault/scan', { vault: vid }); say(`Re-indexed ${r.files} files`); refresh(); }} title="Rebuild the index from the files on disk">Re-index</button></div>}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--line)]">
          <div className="min-w-0 flex-1 truncate text-[var(--ink2)]">{open ? <span title={open}>{open.split('/').map((s, i, a) => <span key={i}>{i > 0 && ' / '}{i === a.length - 1 ? <b className="text-[var(--ink)]">{s}</b> : s}</span>)}</span> : mode === 'graph' ? 'Graph' : 'No note open'}</div>
          <span className="text-xs text-[var(--ink3)]" aria-live="polite">{saving ? 'Saving…' : dirty ? 'Unsaved' : open ? 'Saved' : ''}</span>
          <div className="flex rounded-lg border border-[var(--line)] overflow-hidden" role="tablist" aria-label="View mode">{(['source', 'reading', 'graph'] as const).map((m) => <button key={m} role="tab" aria-selected={mode === m} className={`px-3 py-1 text-xs ${mode === m ? 'bg-[var(--ink)] text-[var(--bg)]' : 'hover:bg-[var(--panel2)]'}`} onClick={() => setMode(m)} title={m === 'reading' ? 'Reading view (Ctrl+E)' : m === 'source' ? 'Source mode (Ctrl+E)' : 'Graph'}>{m === 'source' ? 'Source' : m === 'reading' ? 'Reading' : 'Graph'}</button>)}</div>
        </div>
        {conflict && <div className="bg-[#fef3c7] dark:bg-[#3b2f10] text-[var(--ink)] px-3 py-2 text-sm flex flex-wrap items-center gap-2" role="alert">This file was changed outside bookbook. Your unsaved edits have not been written.
          <button className="btn" onClick={() => { setText(conflict.text); setHash(conflict.hash); setDirty(false); setConflict(null); }}>Load the disk version</button>
          <button className="btn" onClick={() => { setHash(conflict.hash); setConflict(null); void save(true); }}>Overwrite with mine</button></div>}
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 overflow-auto">
            {mode === 'graph' ? <GraphPane vid={vid} center={open} onOpen={(p) => { openFile(p); setMode('reading'); }} />
              : !open ? <div className="p-10"><Empty title="Open or create a note">Pick a note in the explorer, press Ctrl+O to jump to one, or create a new note. Everything is saved as a plain .md file in your vault folder.</Empty></div>
              : mode === 'source' ? <Editor vid={vid} text={text} onChange={(t) => { setText(t); setDirty(true); }} />
              : /\.md$/i.test(open) ? <Reading vid={vid} path={open} text={text} onLink={followLink} onTag={(t) => setQuery(`tag:#${t}`)} onToggleTask={(i) => setText((cur) => { const lines = cur.split('\n'); let n = -1; const out = lines.map((l) => { if (/^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]/.test(l)) { n++; if (n === i) return l.replace(/\[( |x|X)\]/, (_m, c) => (c === ' ' ? '[x]' : '[ ]')); } return l; }); setDirty(true); return out.join('\n'); })} />
              : /.base$/i.test(open) ? <BasesPane key={open} vid={vid} path={open} onOpenNote={(p) => { void openFile(p); setMode("reading"); }} /> : <Attachment vid={vid} path={open} />}
          </div>
          {open && mode !== 'graph' && <RightPanel vid={vid} path={open} tab={tab} setTab={setTab} text={text} hash={hash} onOpen={(p) => { openFile(p); }} onChanged={async () => { await openFile(open, true); refresh(); }} />}
        </div>
        {open && <div className="h-6 shrink-0 border-t border-[var(--line)] px-3 flex items-center gap-4 text-[11px] text-[var(--ink3)]"><span>{(text.match(/\S+/g) ?? []).length} words</span><span>{text.length} characters</span><span className="ml-auto">Ctrl+O switch · Ctrl+E toggle view · Ctrl+S save</span></div>}
      </section>
      {switcher && <Switcher vid={vid} onClose={() => setSwitcher(false)} onPick={(p, create) => { setSwitcher(false); if (create) newNote('', create); else openFile(p!); }} />}
    </div>
  );
}

function CreateVault({ onDone, onCancel }: { onDone: (id: string) => void; onCancel?: () => void }) {
  const [name, setName] = useState('My Vault'); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [file, setFile] = useState<File | null>(null);
  const create = async () => { setBusy(true); setErr(null); try { const v = await post('/vaults', { name }); onDone(v.id); } catch (e: any) { setErr(e.message); } setBusy(false); };
  const importZip = async () => { if (!file) return; setBusy(true); setErr(null); try { const fd = new FormData(); fd.append('file', file); fd.append('name', name); const r = await fetch('/api/vaults/import', { method: 'POST', body: fd }); const j = await r.json(); if (!r.ok) throw new Error(j.error ?? 'Import failed'); onDone(j.id); } catch (e: any) { setErr(e.message); } setBusy(false); };
  return (
    <div className="max-w-xl mx-auto p-8 space-y-4">
      <h1 className="font-serif text-2xl">Vault</h1>
      <p className="text-[var(--ink2)]">A vault is a folder of plain Markdown files stored in your private account space. bookbook indexes links, tags and properties so you can search, follow backlinks and see a graph — and the files can be exported and used in any other editor, including Obsidian.</p>
      <label className="block"><span className="label">Name</span><input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2 items-center"><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={create}>Create new vault</button>{onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}</div>
      <div className="border-t border-[var(--line)] pt-4 space-y-2"><span className="label">Or import notes you already have</span><p className="text-xs text-[var(--ink3)]">Zip an Obsidian vault or any folder of Markdown files and choose the .zip here. Hidden folders such as .obsidian are skipped; nothing outside your vault is touched.</p>
        <input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Zip file to import" /><button className="btn" disabled={busy || !file || !name.trim()} onClick={importZip}>Import .zip as a vault</button></div>
      {err && <ErrorNote error={err} />}
    </div>
  );
}

function Explorer({ tree, open, collapsed, setCollapsed, onOpen, onNew, onNewFolder, onRename, onDelete }: any) {
  const files: FileEnt[] = tree.files; const folders: string[] = tree.folders;
  const [menu, setMenu] = useState<string | null>(null);
  const children = (dir: string) => ({
    dirs: folders.filter((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '') === dir),
    files: files.filter((f) => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '') === dir),
  });
  const row = (key: string, label: React.ReactNode, depth: number, onClick: () => void, active: boolean, path: string, isDir: boolean) => (
    <div key={key} className={`group flex items-center gap-1 rounded-md pr-1 ${active ? 'bg-[var(--panel2)] font-medium' : 'hover:bg-[var(--panel2)]'}`} style={{ paddingLeft: 6 + depth * 12 }}>
      <button className="flex-1 min-w-0 text-left truncate py-1" onClick={onClick}>{label}</button>
      <button className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-[var(--ink3)] px-1" aria-label={`Actions for ${path}`} onClick={() => setMenu(menu === path ? null : path)}>⋯</button>
      {menu === path && <div className="absolute z-20 mt-24 card shadow-lg p-1 flex flex-col text-xs" onMouseLeave={() => setMenu(null)}>
        {isDir && <button className="px-2 py-1 text-left hover:bg-[var(--panel2)] rounded" onClick={() => { setMenu(null); onNew(path); }}>New note here</button>}
        {isDir && <button className="px-2 py-1 text-left hover:bg-[var(--panel2)] rounded" onClick={() => { setMenu(null); onNewFolder(path); }}>New folder here</button>}
        <button className="px-2 py-1 text-left hover:bg-[var(--panel2)] rounded" onClick={() => { setMenu(null); onRename(path); }}>Rename / move…</button>
        <button className="px-2 py-1 text-left hover:bg-[var(--panel2)] rounded text-[var(--danger)]" onClick={() => { setMenu(null); onDelete(path); }}>Delete</button></div>}
    </div>
  );
  const render = (dir: string, depth: number): React.ReactNode => { const c = children(dir); return <>
    {c.dirs.map((d) => <div key={d}>{row(d, <><span className="text-[var(--ink3)] mr-1">{collapsed.has(d) ? '▸' : '▾'}</span>{d.split('/').pop()}</>, depth, () => setCollapsed((s: Set<string>) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; }), false, d, true)}{!collapsed.has(d) && render(d, depth + 1)}</div>)}
    {c.files.map((f) => row(f.path, <span className={f.ext === 'md' ? '' : 'text-[var(--ink3)]'}>{f.ext === 'md' ? f.name : f.name + '.' + f.ext}</span>, depth, () => onOpen(f.path), open === f.path, f.path, false))}
  </>; };
  return <div className="relative">{files.length === 0 && folders.length === 0 ? <p className="p-3 text-xs text-[var(--ink3)]">This vault is empty. Create your first note.</p> : render('', 0)}</div>;
}

function SearchResults({ r, onOpen }: { r: any; onOpen: (p: string) => void }) {
  if (!r.results.length) return <p className="p-3 text-xs text-[var(--ink3)]">No matches.</p>;
  return <div className="space-y-1">{r.total > r.results.length && <p className="px-2 text-[11px] text-[var(--ink3)]">Showing {r.results.length} of {r.total}</p>}{r.results.map((x: any) => <button key={x.path} onClick={() => onOpen(x.path)} className="block w-full text-left rounded-md px-2 py-1.5 hover:bg-[var(--panel2)]"><div className="font-medium truncate">{x.name}</div><div className="text-[11px] text-[var(--ink3)] truncate">{x.path}</div>{x.matches.slice(0, 2).map((m: any, i: number) => <div key={i} className="text-xs text-[var(--ink2)] truncate">{highlightTerms(m.text, r.terms)}</div>)}</button>)}</div>;
}
function highlightTerms(text: string, terms: string[] = []) {
  const t = terms.filter(Boolean).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); if (!t.length) return text;
  return text.split(new RegExp(`(${t.join('|')})`, 'ig')).map((p, i) => (i % 2 ? <mark key={i} className="bg-[var(--hl-y)] text-inherit rounded px-0.5">{p}</mark> : p));
}

function Editor({ vid, text, onChange }: { vid: string; text: string; onChange: (t: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null); const [sug, setSug] = useState<{ items: any[]; from: number } | null>(null);
  const check = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart; const before = el.value.slice(0, pos); const m = /\[\[([^\]\n|#]*)$/.exec(before);
    if (!m) { setSug(null); return; }
    api<any[]>(vq(vid, `/vault/switch?q=${enc(m[1])}`)).then((items) => setSug({ items: items.filter((i) => i.ext === 'md').slice(0, 8), from: pos - m[1].length })).catch(() => setSug(null));
  };
  const insert = (name: string) => { const el = ref.current!; const pos = el.selectionStart; const next = text.slice(0, sug!.from) + name + ']]' + text.slice(pos).replace(/^\]\]/, ''); onChange(next); setSug(null); requestAnimationFrame(() => { el.focus(); const c = sug!.from + name.length + 2; el.setSelectionRange(c, c); }); };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget; const s = el.selectionStart, en = el.selectionEnd;
    if (sug && sug.items.length && (e.key === 'Tab' || e.key === 'Enter')) { e.preventDefault(); insert(sug.items[0].name); return; }
    if (e.key === 'Escape') setSug(null);
    const wrap = (l: string, r: string) => { e.preventDefault(); onChange(text.slice(0, s) + l + text.slice(s, en) + r + text.slice(en)); requestAnimationFrame(() => el.setSelectionRange(s + l.length, en + l.length)); };
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') return wrap('**', '**'); if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') return wrap('*', '*');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return wrap('[', '](url)');
    if (['(', '[', '{', '"', '`'].includes(e.key) && s !== en) return wrap(e.key, ({ '(': ')', '[': ']', '{': '}', '"': '"', '`': '`' } as any)[e.key]);
    if (e.key === '[' && s === en) { e.preventDefault(); onChange(text.slice(0, s) + '[]' + text.slice(en)); requestAnimationFrame(() => el.setSelectionRange(s + 1, s + 1)); return; }
    if (e.key === 'Enter' && !e.shiftKey) { // list / quote continuation
      const ls = text.lastIndexOf('\n', s - 1) + 1; const line = text.slice(ls, s); const m = /^(\s*)((?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?|>)\s+(.*)$/.exec(line);
      if (m) { e.preventDefault(); if (!m[3].trim()) { onChange(text.slice(0, ls) + text.slice(en)); requestAnimationFrame(() => el.setSelectionRange(ls, ls)); return; } let mark = m[2].replace(/\[[xX]\]/, '[ ]'); const num = /^(\d+)([.)])/.exec(mark); if (num) mark = `${Number(num[1]) + 1}${num[2]}`; const ins = `\n${m[1]}${mark} `; onChange(text.slice(0, s) + ins + text.slice(en)); requestAnimationFrame(() => el.setSelectionRange(s + ins.length, s + ins.length)); }
    }
    if (e.key === 'Tab' && !sug) { e.preventDefault(); onChange(text.slice(0, s) + '  ' + text.slice(en)); requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2)); }
  };
  return (
    <div className="relative h-full">
      <textarea ref={ref} className="w-full h-full resize-none bg-transparent p-6 md:px-12 font-mono text-[13.5px] leading-7 outline-none max-w-3xl mx-auto block" spellCheck value={text} onChange={(e) => { onChange(e.target.value); check(e.target); }} onKeyDown={onKey} onClick={(e) => check(e.currentTarget)} aria-label="Note source" placeholder="Start writing… use [[ to link notes, #tags, and a --- properties block at the top." />
      {sug && sug.items.length > 0 && <div className="absolute left-1/2 -translate-x-1/2 top-16 card shadow-lg p-1 z-10 w-72" role="listbox">{sug.items.map((i, k) => <button key={i.path} role="option" aria-selected={k === 0} className={`block w-full text-left px-2 py-1 rounded text-sm ${k === 0 ? 'bg-[var(--panel2)]' : ''}`} onMouseDown={(e) => { e.preventDefault(); insert(i.name); }}>{i.name}<span className="text-[11px] text-[var(--ink3)] ml-2">{i.path.includes('/') ? i.path.slice(0, i.path.lastIndexOf('/')) : ''}</span></button>)}<div className="px-2 py-0.5 text-[10px] text-[var(--ink3)]">Tab or Enter to insert</div></div>}
    </div>
  );
}

function Reading({ vid, path, text, onLink, onTag, onToggleTask }: { vid: string; path: string; text: string; onLink: (t: string | null, c?: string, a?: string) => void; onTag: (t: string) => void; onToggleTask: (i: number) => void }) {
  const [html, setHtml] = useState(''); const [zoom, setZoom] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => { post('/vault/render', { vault: vid, path, text }).then((r) => setHtml(r.html)).catch(() => setHtml('<p>Could not render this note.</p>')); }, 120); return () => clearTimeout(t); }, [vid, path, text]);
  const click = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement; const a = el.closest('a') as HTMLElement | null;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') { e.preventDefault(); const all = [...(e.currentTarget as HTMLElement).querySelectorAll('input[type=checkbox]')]; onToggleTask(all.indexOf(el)); return; }
    if (el instanceof HTMLImageElement && el.classList.contains('zoomable')) { setZoom(el.src); return; }
    if (el.closest('.callout-title')) { const c = el.closest('.callout') as HTMLElement; if (c?.dataset.fold) c.dataset.fold = c.dataset.fold === 'closed' ? 'open' : 'closed'; }
    if (!a) return;
    if (a.dataset.wl) { e.preventDefault(); onLink(a.dataset.wl, undefined, a.dataset.anchor); }
    else if (a.dataset.wlCreate) { e.preventDefault(); onLink(null, a.dataset.wlCreate); }
    else if (a.dataset.tag) { e.preventDefault(); onTag(a.dataset.tag); }
    else if (a.dataset.mdLink) { e.preventDefault(); const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''; const rel = decodeURIComponent(a.dataset.mdLink.split('#')[0]); const parts = (dir + rel).split('/'); const out: string[] = []; for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); } onLink(out.join('/')); }
  };
  return <><article id="vault-reading" className="vault-md max-w-3xl mx-auto px-6 md:px-12 py-8" onClick={click} dangerouslySetInnerHTML={{ __html: html }} />{zoom && <div className="fixed inset-0 z-[70] bg-black/80 grid place-items-center cursor-zoom-out" onClick={() => setZoom(null)} role="dialog" aria-label="Image"><img src={zoom} alt="" className="max-w-[92vw] max-h-[92vh]" /></div>}</>;
}
function Attachment({ vid, path }: { vid: string; path: string }) {
  const src = `/api/vault/raw?vault=${vid}&path=${enc(path)}`; const ext = path.split('.').pop()!.toLowerCase();
  return <div className="p-8 flex flex-col items-center gap-3">{/^(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(ext) ? <img src={src} alt={path} className="max-w-full max-h-[75vh]" /> : /^(mp3|wav|ogg|m4a|flac)$/.test(ext) ? <audio controls src={src} /> : /^(mp4|webm|mov)$/.test(ext) ? <video controls src={src} className="max-w-full max-h-[75vh]" /> : ext === 'pdf' ? <a className="btn" href={src} target="_blank" rel="noreferrer">Open PDF in a new tab</a> : <p className="text-[var(--ink3)]">No preview for .{ext} files.</p>}</div>;
}

function RightPanel({ vid, path, tab, setTab, text, hash, onOpen, onChanged }: { vid: string; path: string; tab: Tab; setTab: (t: Tab) => void; text: string; hash: string; onOpen: (p: string) => void; onChanged: () => void }) {
  const isMd = /\.md$/i.test(path); const tabs: [Tab, string][] = [['backlinks', 'Links'], ['props', 'Properties'], ['outline', 'Outline'], ['history', 'History']];
  return (
    <aside className="w-72 shrink-0 border-l border-[var(--line)] bg-[var(--panel)] overflow-auto hidden lg:block">
      <div className="flex border-b border-[var(--line)] sticky top-0 bg-[var(--panel)] z-10" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k || (tab === 'outgoing' && k === 'backlinks')} className={`flex-1 py-2 text-xs ${tab === k || (tab === 'outgoing' && k === 'backlinks') ? 'border-b-2 border-[var(--accent)] font-medium' : 'text-[var(--ink3)]'}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="p-3">{!isMd ? <p className="text-xs text-[var(--ink3)]">Attachments have no note metadata.</p> : tab === 'backlinks' || tab === 'outgoing' ? <Links vid={vid} path={path} text={text} onOpen={onOpen} onChanged={onChanged} /> : tab === 'props' ? <Props key={path + hash} vid={vid} path={path} hash={hash} onChanged={onChanged} /> : tab === 'outline' ? <Outline vid={vid} path={path} text={text} /> : <History vid={vid} path={path} onChanged={onChanged} />}</div>
    </aside>
  );
}
function useLive<T>(vid: string, url: string, dep: unknown): { data: T | null; err: string | null } {
  const [d, setD] = useState<T | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let on = true; const t = setTimeout(() => { api<T>(vq(vid, url)).then((r) => { if (on) { setD(r); setErr(null); } }).catch((e) => on && setErr(e.message)); }, 300); return () => { on = false; clearTimeout(t); }; }, [vid, url, dep]);
  return { data: d, err };
}
function Links({ vid, path, text, onOpen, onChanged }: { vid: string; path: string; text: string; onOpen: (p: string) => void; onChanged: () => void }) {
  const [show, setShow] = useState<'in' | 'out'>('in'); const bl = useLive<any>(vid, `/vault/backlinks?path=${enc(path)}`, text.length); const out = useLive<any[]>(vid, `/vault/outgoing?path=${enc(path)}`, text);
  return <div className="space-y-3">
    <div className="flex gap-1 text-xs"><button className={`btn !py-0.5 ${show === 'in' ? 'btn-primary' : ''}`} onClick={() => setShow('in')}>Backlinks</button><button className={`btn !py-0.5 ${show === 'out' ? 'btn-primary' : ''}`} onClick={() => setShow('out')}>Outgoing</button></div>
    {show === 'in' ? (bl.data ? <>
      <div className="label">Linked mentions ({bl.data.linked.length})</div>
      {bl.data.linked.length === 0 && <p className="text-xs text-[var(--ink3)]">No notes link here yet.</p>}
      {bl.data.linked.map((l: any, i: number) => <button key={i} onClick={() => onOpen(l.src)} className="block w-full text-left rounded-md p-2 hover:bg-[var(--panel2)] border border-[var(--line)]"><div className="font-medium text-xs">{stem(l.src)}{l.embed ? ' · embed' : ''}</div><div className="text-xs text-[var(--ink2)] line-clamp-2">{l.context}</div></button>)}
      <div className="label pt-2">Unlinked mentions ({bl.data.unlinked.length})</div>
      {bl.data.unlinked.map((l: any, i: number) => <div key={i} className="rounded-md p-2 border border-dashed border-[var(--line)]"><button className="block text-left w-full" onClick={() => onOpen(l.src)}><div className="font-medium text-xs">{stem(l.src)}</div><div className="text-xs text-[var(--ink2)] line-clamp-2">{l.context}</div></button><button className="text-xs text-[var(--accent)] mt-1" onClick={async () => { try { await post('/vault/link-mention', { vault: vid, src: l.src, target: path, line: l.line, term: l.term }); onChanged(); } catch (e: any) { alert(e.message); } }}>Link it</button></div>)}
    </> : <Spinner />) : (out.data ? (out.data.length === 0 ? <p className="text-xs text-[var(--ink3)]">This note has no links.</p> : out.data.map((l: any, i: number) => <button key={i} disabled={!l.target} onClick={() => l.target && onOpen(l.target)} className="block w-full text-left rounded-md p-2 hover:bg-[var(--panel2)] border border-[var(--line)]"><div className="text-xs font-medium">{l.embed ? '⧉ ' : ''}{l.raw || '(this note)'}{l.anchor ? ' › ' + l.anchor : ''}</div><div className={`text-[11px] ${l.target ? 'text-[var(--ink3)]' : 'text-[var(--danger)]'}`}>{l.target ? l.target + (l.ambiguous ? ' · ambiguous name' : '') : 'unresolved — no such note'}</div></button>)) : <Spinner />)}
  </div>;
}
function Props({ vid, path, hash, onChanged }: { vid: string; path: string; hash: string; onChanged: () => void }) {
  const [d, setD] = useState<any>(null); const [raw, setRaw] = useState(false); const [rawText, setRawText] = useState(''); const [err, setErr] = useState<string | null>(null); const [nk, setNk] = useState(''); const [nv, setNv] = useState('');
  const { data: sum } = useLive<any[]>(vid, '/vault/props', 0);
  useEffect(() => { api<any>(vq(vid, `/vault/props/file?path=${enc(path)}`)).then((r) => { setD(r); setRawText(r.raw ?? ''); }).catch((e) => setErr(e.message)); }, [vid, path, hash]);
  const apply = async (body: any) => { setErr(null); try { await api('/vault/props/file', { method: 'PUT', json: { vault: vid, path, baseHash: d?.hash, ...body } }); onChanged(); } catch (e: any) { setErr(e.message); } };
  if (!d) return err ? <ErrorNote error={err} /> : <Spinner />;
  const coerce = (type: string, s: string): unknown => type === 'number' ? Number(s) : type === 'boolean' ? s === 'true' : type === 'list' || type === 'tags' ? s.split(',').map((x) => x.trim()).filter(Boolean) : s;
  return <div className="space-y-2">
    <div className="flex justify-between items-center"><span className="label">Properties</span><button className="text-xs text-[var(--accent)]" onClick={() => setRaw(!raw)}>{raw ? 'Fields' : 'Raw YAML'}</button></div>
    {d.error && <p className="text-xs text-[var(--danger)]">YAML error: {d.error}. Fix it in raw mode.</p>}
    {raw ? <><textarea className="input font-mono text-xs" rows={10} value={rawText} onChange={(e) => setRawText(e.target.value)} aria-label="Raw frontmatter" /><button className="btn btn-primary" onClick={() => apply({ raw: rawText })}>Save YAML</button></>
      : <>{d.props.length === 0 && <p className="text-xs text-[var(--ink3)]">No properties yet.</p>}
        {d.props.map((p: any) => <div key={p.key} className="space-y-0.5"><div className="flex items-center justify-between"><span className="text-xs font-medium">{p.key} <span className="text-[10px] text-[var(--ink3)]">{p.type}</span></span><button className="text-[11px] text-[var(--ink3)]" aria-label={`Remove ${p.key}`} onClick={() => apply({ remove: [p.key] })}>✕</button></div>
          {p.type === 'boolean' ? <input type="checkbox" checked={!!p.value} onChange={(e) => apply({ set: { [p.key]: e.target.checked } })} aria-label={p.key} />
            : <input className="input !py-1 text-xs" type={p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : 'text'} defaultValue={Array.isArray(p.value) ? p.value.join(', ') : typeof p.value === 'object' && p.value ? JSON.stringify(p.value) : String(p.value ?? '')} disabled={typeof p.value === 'object' && p.value != null && !Array.isArray(p.value)} title={typeof p.value === 'object' && !Array.isArray(p.value) ? 'Nested values: edit in raw YAML' : ''} onBlur={(e) => { const cur = Array.isArray(p.value) ? p.value.join(', ') : String(p.value ?? ''); if (e.target.value !== cur) apply({ set: { [p.key]: coerce(p.type, e.target.value) } }); }} aria-label={p.key} />}</div>)}
        <div className="pt-2 border-t border-[var(--line)] space-y-1"><input className="input !py-1 text-xs" list="prop-keys" placeholder="New property name" value={nk} onChange={(e) => setNk(e.target.value)} aria-label="New property name" /><datalist id="prop-keys">{(sum ?? []).map((s) => <option key={s.key} value={s.key} />)}</datalist>
          <input className="input !py-1 text-xs" placeholder="Value (comma-separate for a list)" value={nv} onChange={(e) => setNv(e.target.value)} aria-label="New property value" list="prop-vals" /><datalist id="prop-vals">{(sum?.find((s) => s.key === nk)?.values ?? []).filter((x: unknown) => typeof x !== 'object').map((x: any) => <option key={String(x)} value={String(x)} />)}</datalist>
          <button className="btn w-full justify-center" disabled={!nk.trim()} onClick={() => { const t = sum?.find((s) => s.key === nk)?.type ?? (nv.includes(',') ? 'list' : /^-?\d+(\.\d+)?$/.test(nv) ? 'number' : /^(true|false)$/.test(nv) ? 'boolean' : 'text'); apply({ set: { [nk.trim()]: coerce(t, nv) } }); setNk(''); setNv(''); }}>Add property</button></div></>}
    {err && <ErrorNote error={err} />}
  </div>;
}
function Outline({ vid, path, text }: { vid: string; path: string; text: string }) {
  const { data } = useLive<any[]>(vid, `/vault/headings?path=${enc(path)}`, text.length);
  if (!data) return <Spinner />; if (!data.length) return <p className="text-xs text-[var(--ink3)]">No headings.</p>;
  return <ul className="text-sm space-y-0.5">{data.map((h, i) => <li key={i} style={{ paddingLeft: (h.level - 1) * 10 }} className="truncate text-[var(--ink2)]" title={`line ${h.line + 1}`}>{h.text}</li>)}</ul>;
}
function History({ vid, path, onChanged }: { vid: string; path: string; onChanged: () => void }) {
  const [n, setN] = useState(0); const { data } = useLive<any[]>(vid, `/vault/history?path=${enc(path)}`, n + path); const [view, setView] = useState<{ id: string; text: string } | null>(null);
  if (!data) return <Spinner />;
  return <div className="space-y-2"><p className="text-[11px] text-[var(--ink3)]">Earlier versions are saved automatically (at most one per 45 s while typing). Restoring keeps the current text as a version too.</p>
    {data.length === 0 && <p className="text-xs text-[var(--ink3)]">No earlier versions yet.</p>}
    {data.map((h) => <div key={h.id} className="rounded-md border border-[var(--line)] p-2 text-xs"><div className="flex justify-between"><span>{new Date(h.created_at).toLocaleString()}</span><span className="text-[var(--ink3)]">{h.reason}</span></div><div className="flex gap-2 mt-1"><button className="text-[var(--accent)]" onClick={async () => setView({ id: h.id, text: (await api<any>(vq(vid, `/vault/history/${h.id}`))).text })}>Preview</button><button className="text-[var(--accent)]" onClick={async () => { if (!window.confirm('Restore this version?')) return; await post(`/vault/history/${h.id}/restore`, { vault: vid }); setN(n + 1); onChanged(); }}>Restore</button></div></div>)}
    {view && <div className="fixed inset-0 z-[70] bg-black/50 grid place-items-center p-6" onClick={() => setView(null)}><pre className="card p-4 max-w-2xl max-h-[80vh] overflow-auto whitespace-pre-wrap text-xs" onClick={(e) => e.stopPropagation()}>{view.text}</pre></div>}
  </div>;
}

function Switcher({ vid, onClose, onPick }: { vid: string; onClose: () => void; onPick: (p: string | null, create?: string) => void }) {
  const [q, setQ] = useState(''); const [items, setItems] = useState<any[]>([]); const [i, setI] = useState(0);
  useEffect(() => { let on = true; api<any[]>(vq(vid, `/vault/switch?q=${enc(q)}`)).then((r) => { if (on) { setItems(r); setI(0); } }).catch(() => {}); return () => { on = false; }; }, [q, vid]);
  const exact = items.some((x) => x.name.toLowerCase() === q.trim().toLowerCase());
  const rows = [...items.map((x) => ({ p: x.path as string | null, label: x.name + (x.ext !== 'md' ? '.' + x.ext : ''), sub: x.alias ? `alias: ${x.alias}` : x.path, create: undefined as string | undefined })), ...(q.trim() && !exact ? [{ p: null, label: `Create "${q.trim()}"`, sub: 'new note', create: q.trim() }] : [])];
  return <div className="fixed inset-0 z-[70] bg-black/40 flex justify-center pt-24" onClick={onClose} role="dialog" aria-label="Quick switcher"><div className="card w-[34rem] max-w-[92vw] h-fit max-h-[70vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
    <input autoFocus className="input !rounded-none !border-0 border-b" placeholder="Find or create a note…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(rows.length - 1, x + 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); } if (e.key === 'Enter' && rows[i]) onPick(rows[i].p, rows[i].create); }} aria-label="Search notes" />
    <div className="overflow-auto" role="listbox">{rows.map((r, k) => <button key={k} role="option" aria-selected={k === i} className={`block w-full text-left px-3 py-2 ${k === i ? 'bg-[var(--panel2)]' : ''}`} onMouseEnter={() => setI(k)} onClick={() => onPick(r.p, r.create)}><div>{r.label}</div><div className="text-[11px] text-[var(--ink3)]">{r.sub}</div></button>)}{!rows.length && <p className="p-3 text-[var(--ink3)]">Nothing found.</p>}</div></div></div>;
}

// ───────────── graph ─────────────
function GraphPane({ vid, center, onOpen }: { vid: string; center: string | null; onOpen: (p: string) => void }) {
  const [scope, setScope] = useState<'global' | 'local'>(center ? 'local' : 'global'); const [depth, setDepth] = useState(1); const [tag, setTag] = useState(''); const [orphans, setOrphans] = useState(true); const [unres, setUnres] = useState(true); const [att, setAtt] = useState(false); const [labels, setLabels] = useState(true);
  const [repel, setRepel] = useState(60); const [linkLen, setLinkLen] = useState(60);
  const [g, setG] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const p = new URLSearchParams(); if (scope === 'local' && center) { p.set('center', center); p.set('depth', String(depth)); } if (tag) p.set('tag', tag.replace(/^#/, '')); if (!orphans) p.set('orphans', '0'); if (!unres) p.set('unresolved', '0'); if (att) p.set('attachments', '1'); api(vq(vid, `/vault/graph?${p}`)).then(setG).catch((e) => setErr(e.message)); }, [vid, scope, center, depth, tag, orphans, unres, att]);
  return <div className="h-full flex flex-col"><div className="flex flex-wrap items-center gap-3 p-2 border-b border-[var(--line)] text-xs">
    <select className="input !w-auto !py-0.5" value={scope} onChange={(e) => setScope(e.target.value as any)} aria-label="Graph scope"><option value="global">Global graph</option><option value="local" disabled={!center}>Local graph</option></select>
    {scope === 'local' && <label>depth <input type="number" min={1} max={4} className="input !w-14 !py-0.5" value={depth} onChange={(e) => setDepth(Number(e.target.value))} /></label>}
    <input className="input !w-32 !py-0.5" placeholder="tag filter" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag filter" />
    <label><input type="checkbox" checked={orphans} onChange={(e) => setOrphans(e.target.checked)} /> orphans</label><label><input type="checkbox" checked={unres} onChange={(e) => setUnres(e.target.checked)} /> unresolved</label><label><input type="checkbox" checked={att} onChange={(e) => setAtt(e.target.checked)} /> attachments</label><label><input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> labels</label>
    <label>repel <input type="range" min={10} max={200} value={repel} onChange={(e) => setRepel(Number(e.target.value))} /></label><label>link length <input type="range" min={20} max={200} value={linkLen} onChange={(e) => setLinkLen(Number(e.target.value))} /></label>
    {g && <span className="text-[var(--ink3)] ml-auto">{g.nodes.length} nodes · {g.edges.length} edges</span>}</div>
    {err ? <ErrorNote error={err} /> : !g ? <Spinner /> : g.nodes.length === 0 ? <div className="p-8"><Empty title="Nothing to graph">Link notes with [[wikilinks]] and they appear here.</Empty></div> : <ForceGraph g={g} center={center} labels={labels} repel={repel} linkLen={linkLen} onOpen={onOpen} />}</div>;
}
function ForceGraph({ g, center, labels, repel, linkLen, onOpen }: { g: any; center: string | null; labels: boolean; repel: number; linkLen: number; onOpen: (p: string) => void }) {
  const W = 900, H = 600; const svg = useRef<SVGSVGElement>(null); const [, tick] = useState(0);
  const sim = useRef<{ n: any[]; idx: Map<string, number>; alpha: number }>({ n: [], idx: new Map(), alpha: 1 });
  const view = useRef({ x: 0, y: 0, k: 1 }); const drag = useRef<{ i: number | null; pan: boolean; sx: number; sy: number; moved: boolean }>({ i: null, pan: false, sx: 0, sy: 0, moved: false });
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { const old = new Map(sim.current.n.map((n) => [n.id, n])); const n = g.nodes.map((d: any, i: number) => { const o = old.get(d.id); return { ...d, x: o?.x ?? W / 2 + Math.cos(i) * 150 * Math.random(), y: o?.y ?? H / 2 + Math.sin(i) * 150 * Math.random(), vx: 0, vy: 0, fixed: false }; }); sim.current = { n, idx: new Map(n.map((d: any, i: number) => [d.id, i])), alpha: 1 }; }, [g]);
  useEffect(() => { sim.current.alpha = 1; }, [repel, linkLen]);
  useEffect(() => {
    let raf = 0; let stop = false;
    const step = () => { if (stop) return; const s = sim.current; const n = s.n; if (s.alpha > 0.01 && n.length) {
      const R = repel * 40; const cell = new Map<string, number[]>(); const cs = 120; // grid for approximate repulsion on big graphs
      n.forEach((d, i) => { const k = `${Math.floor(d.x / cs)},${Math.floor(d.y / cs)}`; (cell.get(k) ?? cell.set(k, []).get(k)!).push(i); });
      n.forEach((a, i) => { const cx = Math.floor(a.x / cs), cy = Math.floor(a.y / cs); for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (const j of cell.get(`${cx + dx},${cy + dy}`) ?? []) { if (j <= i) continue; const b = n[j]; let x = a.x - b.x, y = a.y - b.y; let d2 = x * x + y * y + 0.01; if (d2 > 90000) continue; const f = R / d2; const d = Math.sqrt(d2); x /= d; y /= d; a.vx += x * f * s.alpha; a.vy += y * f * s.alpha; b.vx -= x * f * s.alpha; b.vy -= y * f * s.alpha; } });
      for (const e of g.edges) { const a = n[s.idx.get(e.source)!], b = n[s.idx.get(e.target)!]; if (!a || !b) continue; const x = b.x - a.x, y = b.y - a.y; const d = Math.sqrt(x * x + y * y) || 1; const f = (d - linkLen) * 0.04 * s.alpha; a.vx += (x / d) * f; a.vy += (y / d) * f; b.vx -= (x / d) * f; b.vy -= (y / d) * f; }
      n.forEach((d) => { d.vx += (W / 2 - d.x) * 0.004 * s.alpha; d.vy += (H / 2 - d.y) * 0.004 * s.alpha; if (!d.fixed) { d.x += d.vx; d.y += d.vy; } d.vx *= 0.6; d.vy *= 0.6; });
      s.alpha *= 0.985; tick((t) => t + 1); }
      raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step); return () => { stop = true; cancelAnimationFrame(raf); };
  }, [g, repel, linkLen]);
  const pt = (e: React.PointerEvent | React.WheelEvent) => { const r = svg.current!.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
  const world = (p: { x: number; y: number }) => ({ x: (p.x - view.current.x) / view.current.k, y: (p.y - view.current.y) / view.current.k });
  const nodes = sim.current.n; const hn = hover != null ? nodes[hover] : null;
  const nb = useMemo(() => { const s = new Set<string>(); if (hn) { s.add(hn.id); for (const e of g.edges) { if (e.source === hn.id) s.add(e.target); if (e.target === hn.id) s.add(e.source); } } return s; }, [hn?.id, g]); // eslint-disable-line react-hooks/exhaustive-deps
  const tagColors = useMemo(() => { const m = new Map<string, number>(); for (const n of g.nodes) for (const t of n.tags.slice(0, 1)) if (!m.has(t.split('/')[0])) m.set(t.split('/')[0], m.size); return m; }, [g]);
  const colour = (n: any) => n.kind === 'unresolved' ? 'var(--ink3)' : n.kind === 'attachment' ? '#b45309' : n.tags[0] ? `hsl(${(tagColors.get(n.tags[0].split('/')[0]) ?? 0) * 67 + 200} 55% 55%)` : 'var(--accent)';
  return <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="w-full flex-1 touch-none select-none" style={{ minHeight: 400 }} role="img" aria-label="Link graph"
    onWheel={(e) => { const p = pt(e); const k = Math.max(0.2, Math.min(5, view.current.k * (e.deltaY < 0 ? 1.1 : 0.9))); view.current = { x: p.x - ((p.x - view.current.x) / view.current.k) * k, y: p.y - ((p.y - view.current.y) / view.current.k) * k, k }; tick((t) => t + 1); }}
    onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); const p = pt(e); drag.current = { i: null, pan: true, sx: p.x, sy: p.y, moved: false }; }}
    onPointerMove={(e) => { const d = drag.current; const p = pt(e); if (d.i != null) { const w = world(p); const n = nodes[d.i]; n.x = w.x; n.y = w.y; n.fixed = true; sim.current.alpha = Math.max(sim.current.alpha, 0.3); d.moved = true; tick((t) => t + 1); } else if (d.pan) { if (Math.abs(p.x - d.sx) + Math.abs(p.y - d.sy) > 2) d.moved = true; view.current = { ...view.current, x: view.current.x + p.x - d.sx, y: view.current.y + p.y - d.sy }; d.sx = p.x; d.sy = p.y; tick((t) => t + 1); } }}
    onPointerUp={() => { const d = drag.current; if (d.i != null) { nodes[d.i].fixed = false; if (!d.moved && nodes[d.i].kind !== 'unresolved') onOpen(nodes[d.i].id); } drag.current = { i: null, pan: false, sx: 0, sy: 0, moved: false }; }}>
    <g transform={`translate(${view.current.x} ${view.current.y}) scale(${view.current.k})`}>
      {g.edges.map((e: any, i: number) => { const a = nodes[sim.current.idx.get(e.source)!], b = nodes[sim.current.idx.get(e.target)!]; if (!a || !b) return null; const on = hn && (e.source === hn.id || e.target === hn.id); return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--ink3)" strokeOpacity={hn ? (on ? 0.9 : 0.1) : 0.4} strokeWidth={on ? 1.6 : 1} strokeDasharray={e.embed ? '3 2' : undefined} />; })}
      {nodes.map((n, i) => { const r = 4 + Math.min(10, Math.sqrt(n.degree) * 2.2); const dim = hn && !nb.has(n.id); return <g key={n.id} transform={`translate(${n.x} ${n.y})`} opacity={dim ? 0.2 : 1} style={{ cursor: n.kind === 'unresolved' ? 'default' : 'pointer' }} onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture?.(e.pointerId); drag.current = { i, pan: false, sx: 0, sy: 0, moved: false }; }} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
        <circle r={r} fill={colour(n)} stroke={n.id === center ? 'var(--ink)' : 'none'} strokeWidth={2} strokeDasharray={n.kind === 'unresolved' ? '2 2' : undefined} fillOpacity={n.kind === 'unresolved' ? 0.4 : 1} />
        {(labels || hover === i) && <text y={r + 10} textAnchor="middle" fontSize={10 / Math.sqrt(view.current.k)} fill="var(--ink2)" style={{ pointerEvents: 'none' }}>{n.label.slice(0, 28)}</text>}<title>{n.kind === 'unresolved' ? `${n.label} (unresolved)` : n.id}</title></g>; })}
    </g></svg>;
}
