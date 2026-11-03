'use client';
// Socratic dialogue, blind mind map, listening check and exam-date planner (all state lives on the server; nothing here is simulated).
import { useState } from 'react';
import { post, api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Spinner, ErrorNote } from './ui';

type Turn = { role: 'tutor' | 'learner'; content: string };

export function Socratic({ bid, from, to }: { bid: string; from: number; to: number }) {
  const [s, setS] = useState<any>(null); const [log, setLog] = useState<Turn[]>([]); const [ans, setAns] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [fin, setFin] = useState<any>(null); const [covered, setCovered] = useState(0);
  const start = async () => { setBusy(true); setErr(null); setFin(null); setCovered(0); try { const r = await post('/recall/socratic', { bookId: bid, from, to }); setS(r); setLog([{ role: 'tutor', content: r.question.question }]); } catch (e: any) { setErr(e.message); } setBusy(false); };
  const send = async () => {
    const a = ans.trim(); if (!a || busy) return; setBusy(true); setErr(null);
    try { const r = await post(`/recall/socratic/${s.sessionId}/turn`, { questionId: s.question.id, transcript: log, answer: a }); setLog([...log, { role: 'learner', content: a }, { role: 'tutor', content: r.reply }]); setAns(''); setCovered(r.covered.length); if (r.done) setFin(r); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <section className="space-y-2"><h2 className="label">Socratic recall</h2>
      <p className="text-xs text-[var(--ink3)]">A tutor asks one question at a time and never gives the answer: you work it out from memory. Ends after at most 6 replies; the result updates your mastery like any other attempt.</p>
      {!s && <button className="btn" disabled={!bid || busy} onClick={start}>{busy ? 'Preparing…' : 'Start a dialogue'}</button>}
      {s && <div className="card p-3 space-y-2 fade-in">
        <div className="text-xs text-[var(--ink3)]">{s.question.concept} · pp. {s.question.page}{s.question.page_end !== s.question.page ? `–${s.question.page_end}` : ''}</div>
        {log.map((t, i) => <div key={i} className={`text-sm rounded-md px-3 py-2 ${t.role === 'tutor' ? 'bg-[var(--surface2,rgba(127,127,127,.1))]' : 'ml-8 border border-[var(--line)]'}`}><span className="label mr-2">{t.role === 'tutor' ? 'Tutor' : 'You'}</span>{t.content}</div>)}
        {!fin && <><textarea className="input" rows={3} value={ans} onChange={(e) => setAns(e.target.value)} placeholder="Answer in your own words, in any language…" aria-label="Your answer" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }} />
          <div className="flex items-center gap-2"><button className="btn btn-primary" disabled={!ans.trim() || busy} onClick={send}>{busy ? 'Thinking…' : 'Reply'}</button><button className="btn" onClick={() => { setS(null); setLog([]); }}>Give up</button><span className="text-xs text-[var(--ink3)]">key ideas found: {covered}</span></div></>}
        {fin && <div className="space-y-2 border-t border-[var(--line)] pt-2">
          <div className="flex items-center gap-3"><span className="text-2xl font-serif">{Math.round(fin.score * 100)}%</span><span className="text-sm text-[var(--ink2)]">{fin.covered.length}/{fin.reveal.key_points.length} ideas reached by you · {fin.turns} repl{fin.turns === 1 ? 'y' : 'ies'}</span></div>
          <ul className="text-sm space-y-1">{fin.reveal.key_points.map((k: string, i: number) => <li key={i}>{fin.covered.includes(i + 1) ? '✔' : '○'} {k}</li>)}</ul>
          <p className="text-sm text-[var(--ink2)]">{fin.reveal.expected}</p>
          {fin.reveal.quote && <blockquote className="border-l-2 border-[var(--line)] pl-3 text-xs text-[var(--ink3)]">“{fin.reveal.quote}”</blockquote>}
          <button className="btn" onClick={() => { setS(null); setLog([]); setFin(null); }}>New dialogue</button></div>}
      </div>}
      {busy && !s && <Spinner label="Choosing a question…" />}{err && <ErrorNote error={err} />}
    </section>
  );
}

type N = { id: string; label: string; parent: string | null };
export function MindMap({ bid, from, to, topicDefault }: { bid: string; from: number; to: number; topicDefault: string }) {
  const [topic, setTopic] = useState(''); const [nodes, setNodes] = useState<N[]>([]); const [label, setLabel] = useState(''); const [parent, setParent] = useState('root'); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [res, setRes] = useState<any>(null); const [started, setStarted] = useState(false);
  const t = topic.trim() || topicDefault;
  const all = [{ id: 'root', label: t, parent: null as string | null }, ...nodes];
  const add = () => { const l = label.trim(); if (!l || nodes.length >= 30) return; setNodes([...nodes, { id: 'n' + (nodes.length + 1), label: l, parent }]); setLabel(''); };
  const depth = (id: string): number => { const n = all.find((x) => x.id === id); return n?.parent ? 1 + depth(n.parent) : 0; };
  const submit = async () => { setBusy(true); setErr(null); try { setRes(await post('/recall/mindmap', { bookId: bid, from, to: Math.min(to, from + 5), topic: t, nodes: all.map((n) => ({ id: n.id, label: n.label, parent: n.parent })) })); } catch (e: any) { setErr(e.message); } setBusy(false); };
  const verdict = (id: string) => res?.nodeVerdicts.find((v: any) => v.learner === id)?.verdict as string | undefined;
  return (
    <section className="space-y-2"><h2 className="label">Blind mind map</h2>
      <p className="text-xs text-[var(--ink3)]">Only the topic is shown. Build the map from memory — branches and sub-branches — then compare it with a map extracted from pages {from}–{Math.min(to, from + 5)}. Adding more branches does not raise the score; wrong ones lower it.</p>
      {!started ? <div className="flex gap-2"><input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={`Topic (default: ${topicDefault.slice(0, 40)})`} aria-label="Mind map topic" /><button className="btn" disabled={!bid} onClick={() => setStarted(true)}>Start</button></div>
        : <div className="card p-3 space-y-2 fade-in">
          <div className="font-serif text-lg">{t}</div>
          <ul className="text-sm space-y-1">{nodes.map((n) => { const v = verdict(n.id); return <li key={n.id} style={{ marginLeft: depth(n.id) * 18 }} className="flex items-center gap-2">└ <span>{n.label}</span>{v && <span className="text-xs" style={{ color: v === 'correct' ? 'var(--accent)' : v === 'partly' ? '#d97706' : v === 'unsupported' ? 'var(--ink3)' : 'var(--danger)' }}>{v}</span>}{!res && <button className="text-xs text-[var(--ink3)]" aria-label={`Remove ${n.label}`} onClick={() => setNodes(nodes.filter((x) => x.id !== n.id && x.parent !== n.id))}>✕</button>}</li>; })}</ul>
          {!res && <div className="flex flex-wrap gap-2"><select className="input !w-44" value={parent} onChange={(e) => setParent(e.target.value)} aria-label="Attach to">{all.map((n) => <option key={n.id} value={n.id}>under: {n.label.slice(0, 24)}</option>)}</select>
            <input className="input !w-64" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="A concept you remember…" aria-label="New branch" /><button className="btn" onClick={add} disabled={!label.trim()}>Add</button>
            <button className="btn btn-primary" disabled={nodes.length < 2 || busy} onClick={submit}>{busy ? 'Comparing…' : 'Compare with the book'}</button></div>}
          {busy && <Spinner label="Extracting a reference map and comparing by meaning…" />}
          {res && <div className="space-y-2 border-t border-[var(--line)] pt-2">
            <div className="flex items-center gap-4"><span className="text-2xl font-serif">{Math.round(res.score * 100)}%</span><span className="text-sm text-[var(--ink2)]">coverage {Math.round(res.coverage * 100)}% · accuracy {Math.round(res.accuracy * 100)}% · {res.correctEdges} correct link{res.correctEdges === 1 ? '' : 's'}</span></div>
            <p className="text-sm">{res.summary}</p>
            {res.missing.length > 0 && <div><div className="label">Missing from your map</div><div className="flex flex-wrap gap-1.5 mt-1">{res.missing.map((m: any) => <span key={m.id} className="rounded-md border border-[var(--line)] px-2 py-1 text-xs">{m.label}</span>)}</div></div>}
            {res.edgeVerdicts.filter((e: any) => e.verdict !== 'correct').length > 0 && <div><div className="label">Links to check</div><ul className="text-sm list-disc ml-5">{res.edgeVerdicts.filter((e: any) => e.verdict !== 'correct').map((e: any, i: number) => <li key={i}>{all.find((n) => n.id === e.from)?.label} → {all.find((n) => n.id === e.to)?.label}: {e.verdict}{e.note ? ` — ${e.note}` : ''}</li>)}</ul></div>}
            <button className="btn" onClick={() => { setRes(null); setNodes([]); setStarted(false); }}>New map</button></div>}
        </div>}
      {err && <ErrorNote error={err} />}
    </section>
  );
}

/** Pops up while audio is paused: the learner predicts what comes next or explains what they just heard. */
export function ListenCheck({ bookId, page, offset, onDone }: { bookId: string; page: number; offset: number; onDone: () => void }) {
  const [kind, setKind] = useState<'predict' | 'explain'>('explain'); const [ans, setAns] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [res, setRes] = useState<any>(null);
  const submit = async () => { setBusy(true); setErr(null); try { setRes(await post('/recall/listen', { bookId, page, offset, kind, answer: ans })); } catch (e: any) { setErr(e.message); } setBusy(false); };
  return (
    <div className="card p-3 space-y-2 fade-in" role="dialog" aria-label="Listening check">
      <div className="flex items-center gap-2"><span className="label">Listening check</span>
        {!res && <select className="input !w-auto !py-0.5 text-xs" value={kind} onChange={(e) => setKind(e.target.value as any)} aria-label="Check type"><option value="explain">Explain what you just heard</option><option value="predict">Predict what comes next</option></select>}</div>
      {!res ? <>
        <textarea className="input" rows={3} value={ans} onChange={(e) => setAns(e.target.value)} placeholder={kind === 'predict' ? 'What do you think comes next?' : 'In your own words, what did that passage say?'} aria-label="Your answer" autoFocus />
        <div className="flex gap-2"><button className="btn btn-primary" disabled={ans.trim().split(/\s+/).length < 3 || busy} onClick={submit}>{busy ? 'Checking…' : 'Check'}</button><button className="btn" onClick={onDone}>Skip & continue</button></div></>
        : <div className="space-y-1.5"><div className="flex items-center gap-3"><span className="text-xl font-serif">{Math.round(res.score * 100)}%</span><span className="text-sm text-[var(--ink2)]">{res.feedback}</span></div>
          {res.missed?.length > 0 && <div className="text-xs text-[var(--ink3)]">Missed: {res.missed.join('; ')}</div>}
          <details className="text-xs text-[var(--ink3)]"><summary className="cursor-pointer">Show the passage</summary><p className="mt-1">{res.reveal}</p></details>
          <button className="btn btn-primary" onClick={onDone}>Continue listening</button></div>}
      {err && <ErrorNote error={err} />}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { new: 'Learn', review: 'Review', weak: 'Weak spots', mock: 'Mock exam', light: 'Light day' };
export function ExamPlanner({ bid, detail }: { bid: string; detail: any }) {
  const { say } = useStore();
  const [date, setDate] = useState(''); const [mins, setMins] = useState(45); const [chs, setChs] = useState<number[]>([]); const [plan, setPlan] = useState<any>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [loaded, setLoaded] = useState('');
  if (bid && loaded !== bid) { setLoaded(bid); api(`/recall/plan?book=${bid}`).then((r: any) => { const p = r.plan; setPlan(p); if (p) { setDate(p.examDate); setMins(p.minutesPerDay); } }).catch(() => {}); }
  const make = async () => { setBusy(true); setErr(null); try { setPlan(await post('/recall/plan', { bookId: bid, examDate: date, minutesPerDay: mins, chapters: chs })); } catch (e: any) { setErr(e.message); } setBusy(false); };
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section className="space-y-2"><h2 className="label">Exam-date planner</h2>
      <p className="text-xs text-[var(--ink3)]">Allocates your daily minutes across chapters, spaced reviews, weak spots and a mock exam, working back from the exam date. Time per chapter is estimated from its question count; if the plan cannot fit, it says so.</p>
      <div className="flex flex-wrap gap-2 items-center"><label className="text-sm">Exam date <input type="date" min={today} className="input !w-40" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="text-sm">Minutes/day <input type="number" min={10} max={480} className="input !w-20" value={mins} onChange={(e) => setMins(Number(e.target.value))} /></label>
        <button className="btn btn-primary" disabled={!bid || !date || busy} onClick={make}>{busy ? 'Planning…' : plan ? 'Re-plan' : 'Make a plan'}</button>
        {plan && <button className="btn" onClick={async () => { await api(`/recall/plan?book=${bid}`, { method: 'DELETE' }); setPlan(null); say('Plan removed'); }}>Delete plan</button>}</div>
      {detail?.chapters?.length > 1 && <details className="text-sm"><summary className="cursor-pointer text-[var(--ink2)]">Chapters in the exam ({chs.length ? chs.length : 'all'})</summary><div className="grid sm:grid-cols-2 gap-1 mt-1">{detail.chapters.map((c: any) => <label key={c.idx} className="flex gap-2 items-center"><input type="checkbox" checked={chs.includes(c.idx)} onChange={(e) => setChs(e.target.checked ? [...chs, c.idx] : chs.filter((x) => x !== c.idx))} />{c.title.slice(0, 50)}</label>)}</div></details>}
      {err && <ErrorNote error={err} />}
      {plan && <div className="card p-3 space-y-2 fade-in">
        <div className="text-sm"><b>{plan.days}</b> days to go · first pass needs about <b>{plan.firstPassMinutes} min</b> in total ({plan.requiredPerDay} min/day over the learning days)</div>
        <p className="text-xs" style={{ color: plan.feasible ? 'var(--ink3)' : 'var(--danger)' }}>{plan.note}</p>
        {plan.chapters.some((c: any) => c.needsGeneration) && <p className="text-xs text-[var(--ink3)]">Chapters marked * have no questions yet; their time is an estimate until questions are generated.</p>}
        <div className="max-h-80 overflow-auto space-y-1.5">{plan.schedule.slice(0, 60).map((d: any) => <div key={d.date} className="text-sm border-t border-[var(--line)] pt-1.5"><div className="flex justify-between"><b>{d.date}{d.date === today ? ' · today' : ''}</b><span className="text-xs text-[var(--ink3)]">{d.daysLeft}d left · {d.minutes} min</span></div>
          <ul className="ml-4 list-disc text-[var(--ink2)]">{d.tasks.map((t: any, i: number) => <li key={i}><span className="text-xs label mr-1">{KIND_LABEL[t.kind]}</span>{t.label}{plan.chapters.find((c: any) => c.idx === t.chapterIdx)?.needsGeneration ? '*' : ''} · {t.minutes} min</li>)}</ul></div>)}</div>
      </div>}
    </section>
  );
}
