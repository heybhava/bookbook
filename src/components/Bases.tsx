'use client';
// Bases UI: Table, Cards, List and Kanban views over a .base definition. Edits write to the source notes' own properties.
import { useCallback, useEffect, useState } from 'react';
import { api, post } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Spinner, ErrorNote } from './ui';

const enc = encodeURIComponent;
const SUMS = ['count', 'filled', 'empty', 'unique', 'sum', 'average', 'min', 'max', 'median'];
type Cfg = { source?: string; filters?: any; formulas?: Record<string, string>; properties?: Record<string, { displayName?: string }>; views: any[]; [k: string]: any };
const show = (v: unknown): string => v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? '✓' : '✗') : String(v);
const filterLines = (f: any): string => !f ? '' : typeof f === 'string' ? f : Array.isArray(f.and) && f.and.every((x: any) => typeof x === 'string') ? f.and.join('\n') : JSON.stringify(f);
const parseFilterLines = (s: string, mode: 'and' | 'or'): any => { const t = s.trim(); if (!t) return undefined; if (t.startsWith('{')) { try { return JSON.parse(t); } catch { /* treat as expressions */ } } const ls = t.split('\n').map((x) => x.trim()).filter(Boolean); return ls.length === 1 && mode === 'and' ? ls[0] : { [mode]: ls }; };

export function BasesPane({ vid, path, onOpenNote }: { vid: string; path: string; onOpenNote: (p: string) => void }) {
  const { go, setPage, say } = useStore();
  const [file, setFile] = useState<{ config: Cfg; hash: string; error: string | null } | null>(null); const [cfg, setCfg] = useState<Cfg | null>(null); const [dirty, setDirty] = useState(false);
  const [vi, setVi] = useState(0); const [res, setRes] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [cfgOpen, setCfgOpen] = useState(false); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const f = await api<any>(`/vault/base?vault=${vid}&path=${enc(path)}`); setFile(f); setCfg(f.config); setDirty(false); setErr(f.error ? `The .base file has a YAML error: ${f.error}` : null); } catch (e: any) { setErr(e.message); } }, [vid, path]);
  useEffect(() => { setFile(null); setCfg(null); setRes(null); setVi(0); load(); }, [load]);
  const run = useCallback(async (c: Cfg, idx: number, saved: boolean) => { try { setRes(await post('/vault/base/query', saved ? { vault: vid, path, view: idx } : { vault: vid, config: c, view: idx })); setErr(null); } catch (e: any) { setErr(e.message); } }, [vid, path]);
  useEffect(() => { if (!cfg) return; const t = setTimeout(() => run(cfg, vi, !dirty), dirty ? 400 : 0); return () => clearTimeout(t); }, [cfg, vi, dirty, run]);
  const edit = (fn: (c: Cfg) => void) => { setCfg((cur) => { const n = structuredClone(cur!); fn(n); return n; }); setDirty(true); };
  const view = cfg?.views[Math.min(vi, (cfg?.views.length ?? 1) - 1)];
  const save = async () => { if (!cfg || !file) return; setBusy(true); try { await api('/vault/base', { method: 'PUT', json: { vault: vid, path, config: cfg, baseHash: file.hash } }); say('Base saved'); await load(); } catch (e: any) { setErr(e.message); } setBusy(false); };
  const refresh = () => cfg && run(cfg, vi, !dirty);
  const setCell = async (rowId: string, col: string, value: unknown) => { try { await post('/vault/base/set', { vault: vid, path: rowId, key: col, value }); await refresh(); } catch (e: any) { say(e.message); } };
  const openRow = (r: any) => { if (r.kind === 'note') onOpenNote(r.id); else if (r.ref?.bookId) { go('reader', r.ref.bookId); if (r.ref.page) setPage(r.ref.page); } };
  const newRecord = async (group?: string | null) => { const name = window.prompt('Name of the new note', 'Untitled'); if (!name) return; try { const r = await post('/vault/base/create', { vault: vid, path, config: cfg, view: vi, name, group }); await refresh(); say(`Created ${r.path}`); } catch (e: any) { say(e.message); } };
  if (!cfg) return err ? <div className="p-6"><ErrorNote error={err} /></div> : <Spinner />;
  const editableCol = (id: string) => !id.startsWith('file.') && !id.startsWith('formula.');
  const notes = (cfg.source ?? 'notes') === 'notes';

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--line)]">
        <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Base views">{cfg.views.map((v, i) => <button key={i} role="tab" aria-selected={i === vi} onClick={() => setVi(i)} className={`px-2.5 py-1 rounded-md text-xs ${i === vi ? 'bg-[var(--ink)] text-[var(--bg)]' : 'border border-[var(--line)] hover:bg-[var(--panel2)]'}`}>{v.name ?? `${v.type} ${i + 1}`} <span className="opacity-60">· {v.type}</span></button>)}
          <button className="px-2 py-1 rounded-md text-xs border border-dashed border-[var(--line)]" onClick={() => { edit((c) => c.views.push({ type: 'table', name: `View ${c.views.length + 1}`, order: view?.order })); setVi(cfg.views.length); setCfgOpen(true); }} aria-label="Add view">+ view</button></div>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {res && <span className="text-[var(--ink3)]">{res.shown}{res.total > res.shown ? ` of ${res.total}` : ''} record{res.total === 1 ? '' : 's'}</span>}
          {notes && <button className="btn !py-1" onClick={() => newRecord()}>New record</button>}
          <a className="btn !py-1" href={`/api/vault/base/csv?vault=${vid}&path=${enc(path)}&view=${vi}`} download title="Saved view as CSV">CSV</a>
          <button className={`btn !py-1 ${cfgOpen ? 'btn-primary' : ''}`} onClick={() => setCfgOpen(!cfgOpen)}>Configure</button>
          {dirty && <><button className="btn btn-primary !py-1" disabled={busy} onClick={save}>Save changes</button><button className="btn !py-1" onClick={load}>Discard</button></>}
        </div>
      </div>
      {err && <div className="px-3 pt-2"><ErrorNote error={err} /></div>}
      {res?.errors?.length > 0 && <div className="px-3 pt-2 text-xs text-[var(--danger)]" role="alert">{res.errors.slice(0, 3).map((e: any, i: number) => <div key={i}>{e.where}: {e.message}</div>)}</div>}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 overflow-auto p-3">
          {!res ? <Spinner /> : res.rows.length === 0 ? <p className="p-6 text-[var(--ink3)] text-sm">No records match this view’s filters.</p>
            : view.type === 'table' ? <TableView res={res} view={view} editableCol={editableCol} canEdit={notes} onCell={setCell} onOpen={openRow} onSort={(col: string) => edit((c) => { const v = c.views[vi]; const cur = v.sort?.[0]; v.sort = [{ property: col, direction: cur?.property === col && cur.direction !== 'DESC' ? 'DESC' : 'ASC' }, ...(v.sort ?? []).filter((s: any) => s.property !== col).slice(0, 2)]; })} onMove={(a: string, b: string) => edit((c) => { const v = c.views[vi]; const o = [...res.view.order]; const [m] = o.splice(o.indexOf(a), 1); o.splice(o.indexOf(b), 0, m); v.order = o; })} onResize={(col: string, w: number) => edit((c) => { const v = c.views[vi]; v.columnWidths = { ...(v.columnWidths ?? {}), [col]: w }; })} />
            : view.type === 'cards' ? <CardsView res={res} view={view} vid={vid} onOpen={openRow} />
            : view.type === 'list' ? <ListView res={res} onOpen={openRow} />
            : <KanbanView res={res} view={view} canEdit={notes} onOpen={openRow} onMove={(row: string, group: string | null) => setCell(row, view.groupBy.property, group)} onNew={newRecord} />}
        </div>
        {cfgOpen && <ConfigPanel cfg={cfg} vi={vi} res={res} edit={edit} onDeleteView={() => { edit((c) => { if (c.views.length > 1) c.views.splice(vi, 1); }); setVi(0); }} />}
      </div>
    </div>
  );
}

function Cell({ v }: { v: unknown }) { return Array.isArray(v) ? <span className="flex flex-wrap gap-1">{v.map((x, i) => <span key={i} className="rounded-full bg-[var(--panel2)] px-2 text-xs">{show(x)}</span>)}</span> : <>{show(v)}</>; }

function TableView({ res, view, editableCol, canEdit, onCell, onOpen, onSort, onMove, onResize }: any) {
  const [editing, setEditing] = useState<{ row: string; col: string } | null>(null); const [dragCol, setDragCol] = useState<string | null>(null); const widths = view.columnWidths ?? {};
  const sort0 = view.sort?.[0];
  const grid = (rows: number[]) => rows.map((i) => { const r = res.rows[i]; return <tr key={r.id + i} className="border-t border-[var(--line)] hover:bg-[var(--panel2)]">
    {res.columns.map((c: any, k: number) => { const isEd = editing?.row === r.id && editing!.col === c.id; const can = canEdit && r.editable && editableCol(c.id);
      return <td key={c.id} className="px-2 py-1.5 align-top" style={{ width: widths[c.id], maxWidth: widths[c.id] ?? 320 }} onDoubleClick={() => can && setEditing({ row: r.id, col: c.id })} title={can ? 'Double-click to edit' : undefined}>
        {isEd ? <input autoFocus className="input !py-0.5 w-full" defaultValue={Array.isArray(r.cells[c.id]) ? r.cells[c.id].join(', ') : show(r.cells[c.id])} aria-label={`Edit ${c.label}`} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); if (e.key === 'Enter') { const raw = (e.target as HTMLInputElement).value.trim(); const old = r.cells[c.id]; const val: unknown = raw === '' ? null : Array.isArray(old) ? raw.split(',').map((x) => x.trim()).filter(Boolean) : typeof old === 'number' || (old == null && /^-?\d+(\.\d+)?$/.test(raw)) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw; setEditing(null); onCell(r.id, c.id, val); } }} onBlur={() => setEditing(null)} />
          : k === 0 ? <button className="text-left text-[var(--accent)] hover:underline" onClick={() => onOpen(r)}><Cell v={r.cells[c.id]} /></button> : <Cell v={r.cells[c.id]} />}</td>; })}</tr>; });
  return <div className="overflow-auto"><table className="text-sm border-collapse min-w-full"><thead><tr>
    {res.columns.map((c: any) => <th key={c.id} draggable onDragStart={() => setDragCol(c.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => dragCol && dragCol !== c.id && onMove(dragCol, c.id)} style={{ width: widths[c.id] }} className="relative text-left px-2 py-1.5 bg-[var(--panel2)] font-medium whitespace-nowrap select-none">
      <button onClick={() => onSort(c.id)} title="Sort (click again to reverse). Drag to reorder.">{c.label}{sort0?.property === c.id ? (sort0.direction === 'DESC' ? ' ▼' : ' ▲') : ''}</button>
      <span className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(e) => { e.preventDefault(); const th = (e.currentTarget.parentElement as HTMLElement); const x0 = e.clientX, w0 = th.offsetWidth; const mv = (ev: MouseEvent) => { th.style.width = Math.max(60, w0 + ev.clientX - x0) + 'px'; }; const up = (ev: MouseEvent) => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); onResize(c.id, Math.max(60, w0 + ev.clientX - x0)); }; window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up); }} aria-hidden /></th>)}</tr></thead>
    <tbody>{res.groups ? res.groups.map((g: any) => <GroupRows key={String(g.key)} g={g} span={res.columns.length} render={grid} columns={res.columns} />) : grid(res.rows.map((_: any, i: number) => i))}</tbody>
    {Object.keys(res.summaries).length > 0 && <tfoot><tr className="border-t-2 border-[var(--line)] font-medium bg-[var(--panel2)]">{res.columns.map((c: any) => <td key={c.id} className="px-2 py-1.5">{c.id in res.summaries ? <span title={view.summaries[c.id]}>{show(res.summaries[c.id])} <span className="text-[10px] text-[var(--ink3)]">{view.summaries[c.id]}</span></span> : ''}</td>)}</tr></tfoot>}
  </table></div>;
}
function GroupRows({ g, span, render, columns }: any) {
  const [open, setOpen] = useState(true);
  return <><tr className="bg-[var(--panel2)]"><td colSpan={span} className="px-2 py-1 font-semibold"><button onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {g.label} <span className="text-[var(--ink3)] font-normal">({g.rows.length})</span></button>{g.summaries && Object.entries(g.summaries).map(([c, v]) => <span key={c} className="ml-4 text-xs text-[var(--ink3)]">{columns.find((x: any) => x.id === c)?.label}: {show(v)}</span>)}</td></tr>{open && render(g.rows)}</>;
}

function CardsView({ res, view, vid, onOpen }: any) {
  const w = view.cardWidth ?? 240; const img = view.image as string | undefined;
  const card = (i: number) => { const r = res.rows[i]; const src = img ? show(r.cells[img]) : ''; const url = !src ? '' : /^https?:/i.test(src) ? src : `/api/vault/raw?vault=${vid}&path=${enc(src.replace(/^!?\[\[|\]\]$/g, ''))}`;
    return <article key={r.id + i} className="card overflow-hidden flex flex-col"><button className="text-left" onClick={() => onOpen(r)} aria-label={`Open ${show(r.cells[res.columns[0].id])}`}>{url && <img src={url} alt="" loading="lazy" className="w-full h-32 object-cover bg-[var(--panel2)]" />}<div className="p-3 font-medium text-[var(--accent)]">{show(r.cells[res.columns[0].id]) || '(untitled)'}</div></button>
      <dl className="px-3 pb-3 text-xs space-y-0.5">{res.columns.slice(1).filter((c: any) => c.id !== img).map((c: any) => show(r.cells[c.id]) !== '' && <div key={c.id} className="flex gap-2"><dt className="text-[var(--ink3)] shrink-0">{c.label}</dt><dd className="min-w-0 break-words"><Cell v={r.cells[c.id]} /></dd></div>)}</dl></article>; };
  const grid = (idx: number[]) => <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${w}px, 1fr))` }}>{idx.map(card)}</div>;
  return res.groups ? <div className="space-y-5">{res.groups.map((g: any) => <section key={String(g.key)}><h3 className="font-semibold mb-2">{g.label} <span className="text-[var(--ink3)] font-normal text-sm">({g.rows.length})</span></h3>{grid(g.rows)}</section>)}</div> : grid(res.rows.map((_: any, i: number) => i));
}
function ListView({ res, onOpen }: any) {
  const item = (i: number) => { const r = res.rows[i]; return <li key={r.id + i} className="py-1"><button className="text-[var(--accent)] hover:underline" onClick={() => onOpen(r)}>{show(r.cells[res.columns[0].id]) || '(untitled)'}</button><span className="text-xs text-[var(--ink3)] ml-2">{res.columns.slice(1).map((c: any) => show(r.cells[c.id]) && `${c.label}: ${show(r.cells[c.id])}`).filter(Boolean).join(' · ')}</span></li>; };
  return res.groups ? <div className="space-y-3">{res.groups.map((g: any) => <section key={String(g.key)}><h3 className="font-semibold">{g.label} <span className="text-[var(--ink3)] font-normal text-sm">({g.rows.length})</span></h3><ul className="list-disc ml-5">{g.rows.map(item)}</ul></section>)}</div> : <ul className="list-disc ml-5">{res.rows.map((_: any, i: number) => item(i))}</ul>;
}

function KanbanView({ res, view, canEdit, onOpen, onMove, onNew }: any) {
  const [drag, setDrag] = useState<string | null>(null); const [over, setOver] = useState<string | null>(null); const [fold, setFold] = useState<Set<string>>(new Set());
  if (!view.groupBy?.property) return <p className="p-6 text-sm text-[var(--ink3)]">Choose a property to group by (Configure → Group by) to get columns.</p>;
  const groups: any[] = res.groups ?? [];
  return <div className="flex gap-3 items-start overflow-x-auto pb-3">{groups.map((g) => { const k = String(g.key); const closed = fold.has(k);
    return <section key={k} className={`shrink-0 rounded-lg bg-[var(--panel2)] p-2 ${over === k ? 'ring-2 ring-[var(--accent)]' : ''}`} style={{ width: closed ? 48 : 260 }} onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(k); } }} onDragLeave={() => setOver(null)} onDrop={() => { setOver(null); if (drag && canEdit) onMove(drag, g.key); setDrag(null); }} aria-label={`Column ${g.label}`}>
      <header className="flex items-center justify-between mb-2"><button className="font-semibold text-sm truncate" onClick={() => setFold((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; })} title={closed ? 'Expand' : 'Collapse'}>{closed ? '▸' : '▾'} {!closed && g.label}</button><span className="text-xs text-[var(--ink3)]">{g.rows.length}</span></header>
      {!closed && <div className="space-y-2">{g.rows.map((i: number) => { const r = res.rows[i]; return <article key={r.id + i} draggable={canEdit && r.editable} onDragStart={() => setDrag(r.id)} onDragEnd={() => { setDrag(null); setOver(null); }} className="card p-2 text-sm cursor-grab active:cursor-grabbing">
        <button className="text-left font-medium text-[var(--accent)]" onClick={() => onOpen(r)}>{show(r.cells[res.columns[0].id]) || '(untitled)'}</button>
        {res.columns.slice(1).map((c: any) => show(r.cells[c.id]) !== '' && c.id !== view.groupBy.property && <div key={c.id} className="text-xs text-[var(--ink2)]"><span className="text-[var(--ink3)]">{c.label}: </span><Cell v={r.cells[c.id]} /></div>)}</article>; })}
        {canEdit && <button className="w-full text-left text-xs text-[var(--ink3)] hover:text-[var(--ink)] py-1" onClick={() => onNew(g.key)}>+ New</button>}</div>}
    </section>; })}</div>;
}

function ConfigPanel({ cfg, vi, res, edit, onDeleteView }: { cfg: Cfg; vi: number; res: any; edit: (f: (c: Cfg) => void) => void; onDeleteView: () => void }) {
  const v = cfg.views[vi]; const cols: string[] = v.order ?? res?.view?.order ?? [];
  const [avail, setAvail] = useState<string[]>([]);
  useEffect(() => { // every property id the user could show: file fields, formulas, and keys seen in the results
    const base = (cfg.source ?? 'notes') === 'notes' ? ['file.name', 'file.path', 'file.folder', 'file.size', 'file.mtime', 'file.tags', 'file.links', 'file.backlinks'] : [];
    setAvail([...new Set([...base, ...Object.keys(cfg.formulas ?? {}).map((f) => `formula.${f}`), ...cols])]);
  }, [cfg.formulas, cfg.source]); // eslint-disable-line react-hooks/exhaustive-deps
  const [add, setAdd] = useState('');
  const setOrder = (o: string[]) => edit((c) => { c.views[vi].order = o; });
  const formulasText = Object.entries(cfg.formulas ?? {}).map(([k, e]) => `${k} = ${e}`).join('\n');
  return <aside className="w-80 shrink-0 border-l border-[var(--line)] bg-[var(--panel)] overflow-auto p-3 space-y-4 text-sm" aria-label="View settings">
    <label className="block"><span className="label">View name</span><input className="input mt-1" value={v.name ?? ''} onChange={(e) => edit((c) => { c.views[vi].name = e.target.value; })} /></label>
    <label className="block"><span className="label">Layout</span><select className="input mt-1" value={v.type} onChange={(e) => edit((c) => { c.views[vi].type = e.target.value; })}><option value="table">Table</option><option value="cards">Cards</option><option value="list">List</option><option value="kanban">Kanban</option></select></label>
    <div><span className="label">Properties shown (first is the title)</span>
      <ul className="mt-1 space-y-1">{cols.map((c, i) => <li key={c} className="flex items-center gap-1"><span className="flex-1 truncate">{cfg.properties?.[c]?.displayName ?? c}</span>
        <input className="input !py-0 !w-24 text-xs" placeholder="display name" defaultValue={cfg.properties?.[c]?.displayName ?? ''} onBlur={(e) => edit((x) => { x.properties = { ...(x.properties ?? {}) }; if (e.target.value.trim()) x.properties[c] = { displayName: e.target.value.trim() }; else delete x.properties[c]; })} aria-label={`Display name for ${c}`} />
        <button disabled={i === 0} onClick={() => { const o = [...cols]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; setOrder(o); }} aria-label="Move up">↑</button><button disabled={i === cols.length - 1} onClick={() => { const o = [...cols]; [o[i + 1], o[i]] = [o[i], o[i + 1]]; setOrder(o); }} aria-label="Move down">↓</button><button onClick={() => setOrder(cols.filter((x) => x !== c))} aria-label={`Hide ${c}`}>✕</button></li>)}</ul>
      <div className="flex gap-1 mt-1"><input className="input !py-1" list="base-props" placeholder="Add property, file.x or formula.x" value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Add property" /><datalist id="base-props">{avail.filter((a) => !cols.includes(a)).map((a) => <option key={a} value={a} />)}</datalist><button className="btn" disabled={!add.trim() || cols.includes(add.trim())} onClick={() => { setOrder([...cols, add.trim()]); setAdd(''); }}>Add</button></div></div>
    <div><span className="label">Sort</span>{(v.sort ?? []).map((s: any, i: number) => <div key={i} className="flex gap-1 mt-1"><select className="input !py-1 flex-1" value={s.property} onChange={(e) => edit((c) => { c.views[vi].sort[i].property = e.target.value; })}>{[...new Set([...cols, s.property])].map((c) => <option key={c}>{c}</option>)}</select><select className="input !py-1 !w-20" value={s.direction ?? 'ASC'} onChange={(e) => edit((c) => { c.views[vi].sort[i].direction = e.target.value; })}><option>ASC</option><option>DESC</option></select><button onClick={() => edit((c) => { c.views[vi].sort.splice(i, 1); })} aria-label="Remove sort">✕</button></div>)}
      <button className="text-xs text-[var(--accent)] mt-1" onClick={() => edit((c) => { c.views[vi].sort = [...(c.views[vi].sort ?? []), { property: cols[0] ?? 'file.name', direction: 'ASC' }]; })}>+ sort rule</button></div>
    <div><span className="label">Group by</span><div className="flex gap-1 mt-1"><input className="input !py-1 flex-1" list="base-props" value={v.groupBy?.property ?? ''} placeholder="(none) — e.g. status" onChange={(e) => edit((c) => { if (e.target.value) c.views[vi].groupBy = { property: e.target.value, direction: c.views[vi].groupBy?.direction ?? 'ASC' }; else delete c.views[vi].groupBy; })} aria-label="Group by" />{v.groupBy && <select className="input !py-1 !w-20" value={v.groupBy.direction ?? 'ASC'} onChange={(e) => edit((c) => { c.views[vi].groupBy.direction = e.target.value; })}><option>ASC</option><option>DESC</option></select>}</div></div>
    <label className="block"><span className="label">Result limit</span><input type="number" min={0} className="input mt-1" value={v.limit ?? ''} placeholder="no limit" onChange={(e) => edit((c) => { if (e.target.value) c.views[vi].limit = Number(e.target.value); else delete c.views[vi].limit; })} /></label>
    {v.type === 'cards' && <><label className="block"><span className="label">Cover image property</span><input className="input mt-1" value={v.image ?? ''} placeholder="e.g. cover" onChange={(e) => edit((c) => { if (e.target.value) c.views[vi].image = e.target.value; else delete c.views[vi].image; })} /></label><label className="block"><span className="label">Card width: {v.cardWidth ?? 240}px</span><input type="range" min={160} max={420} value={v.cardWidth ?? 240} onChange={(e) => edit((c) => { c.views[vi].cardWidth = Number(e.target.value); })} /></label></>}
    <div><span className="label">Summaries</span>{cols.slice(0, 12).map((c) => <div key={c} className="flex items-center gap-1 mt-1"><span className="flex-1 truncate text-xs">{c}</span><select className="input !py-0 !w-24 text-xs" value={v.summaries?.[c] ?? ''} onChange={(e) => edit((x) => { const s = { ...(x.views[vi].summaries ?? {}) }; if (e.target.value) s[c] = e.target.value; else delete s[c]; x.views[vi].summaries = s; })} aria-label={`Summary for ${c}`}><option value="">—</option>{SUMS.map((s) => <option key={s}>{s}</option>)}</select></div>)}</div>
    <label className="block"><span className="label">Filters for this view (one expression per line, all must match)</span><textarea className="input mt-1 font-mono text-xs" rows={3} defaultValue={filterLines(v.filters)} key={'vf' + vi} placeholder={'status == "todo"\nfile.hasTag("work")'} onBlur={(e) => edit((c) => { const f = parseFilterLines(e.target.value, 'and'); if (f) c.views[vi].filters = f; else delete c.views[vi].filters; })} /></label>
    <label className="block"><span className="label">Filters for the whole base</span><textarea className="input mt-1 font-mono text-xs" rows={3} defaultValue={filterLines(cfg.filters)} placeholder={'file.inFolder("Projects")'} onBlur={(e) => edit((c) => { const f = parseFilterLines(e.target.value, 'and'); if (f) c.filters = f; else delete c.filters; })} /></label>
    <details><summary className="text-xs text-[var(--ink3)] cursor-pointer">Filter syntax and functions</summary><p className="text-xs text-[var(--ink2)] mt-1">Use <code>and</code>/<code>or</code>/<code>not</code> in raw YAML for groups. Examples: <code>status != "done"</code>, <code>priority &gt; 2 &amp;&amp; due &lt; today()</code>, <code>file.hasTag("x")</code>, <code>file.inFolder("A")</code>, <code>tags.contains("x")</code>, <code>file.mtime &gt; now() - "7d"</code>. Functions: if, date, now, today, number, min, max, round, floor, ceil, abs, and string/list/date methods. No scripting is evaluated.</p></details>
    <label className="block"><span className="label">Formulas (name = expression)</span><textarea className="input mt-1 font-mono text-xs" rows={4} defaultValue={formulasText} placeholder={'score = priority * 10\nlate = if(due < today(), "late", "ok")'} onBlur={(e) => edit((c) => { const f: Record<string, string> = {}; for (const ln of e.target.value.split('\n')) { const m = /^\s*([^=]+?)\s*=\s*(.+)$/.exec(ln); if (m) f[m[1]] = m[2]; } if (Object.keys(f).length) c.formulas = f; else delete c.formulas; })} /><span className="text-[11px] text-[var(--ink3)]">Show a formula by adding <code>formula.name</code> as a property.</span></label>
    {cfg.views.length > 1 && <button className="btn w-full justify-center text-[var(--danger)]" onClick={onDeleteView}>Delete this view</button>}
  </aside>;
}
