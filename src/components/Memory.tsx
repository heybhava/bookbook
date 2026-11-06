'use client';
// Settings → Memory: facts the AI assistant remembers about you. Stored only in your own account; nothing leaves this computer.
import { useCallback, useEffect, useState } from 'react';
import { api, post } from '@/lib/api';

export function MemorySettings() {
  const [d, setD] = useState<{ enabled: boolean; items: any[] } | null>(null); const [text, setText] = useState(''); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { api<any>('/memories').then(setD).catch((e) => setErr(e.message)); }, []); useEffect(load, [load]);
  const add = async () => { setErr(null); try { await post('/memories', { text }); setText(''); load(); } catch (e: any) { setErr(e.message); } };
  const patch = async (id: string, body: unknown) => { await api(`/memories/${id}`, { method: 'PATCH', json: body }); load(); };
  if (!d) return null;
  return (
    <section className="card p-4 space-y-3" aria-label="Memory"><h2 className="font-semibold">Memory</h2>
      <p className="text-sm text-[var(--ink2)]">Things you want your reading assistant to remember — your goals, background, how you like explanations. They are added quietly to its context in every conversation. Stored only in your account on this computer.</p>
      <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={d.enabled} onChange={async (e) => { await api('/memories-enabled', { method: 'PUT', json: { enabled: e.target.checked } }); load(); }} /> The assistant uses my memory</label>
      <div className="flex gap-2"><input className="input flex-1" placeholder="e.g. I’m learning Telugu and prefer short, concrete explanations" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim().length > 2 && add()} aria-label="New memory" /><button className="btn" disabled={text.trim().length < 3} onClick={add}>Remember</button></div>
      {err && <p className="text-sm text-[var(--danger)]" role="alert">{err}</p>}
      <ul className="space-y-1.5">{d.items.length === 0 && <li className="text-sm text-[var(--ink3)]">Nothing remembered yet.</li>}{d.items.map((m) => <li key={m.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={!!m.enabled} onChange={(e) => patch(m.id, { enabled: e.target.checked })} aria-label="Use this memory" className="mt-1" /><span className={`flex-1 ${m.enabled ? '' : 'opacity-50 line-through'}`}>{m.pinned ? '📌 ' : ''}{m.text}</span><button className="text-[var(--ink3)]" onClick={() => patch(m.id, { pinned: !m.pinned })} title="Pin to the top">pin</button><button className="text-[var(--danger)]" onClick={async () => { await api(`/memories/${m.id}`, { method: 'DELETE' }); load(); }} aria-label="Forget this">✕</button></li>)}</ul>
    </section>
  );
}
