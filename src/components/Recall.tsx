'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Renderer } from '@openuidev/react-lang';
import { api, post, put } from '@/lib/api';
import { useStore, type RecallRun } from '@/lib/store';
import { recallLibrary, FEEDBACK_RULES, PLAN_RULES, FEEDBACK_EXAMPLE, PLAN_EXAMPLE, FORMAT_RULE } from '@/lib/recall/ui-lib';
import { fontFor, isRtl, detectLanguage, getLang, langName } from '@/lib/lang/registry';
import { Icon, Md, Spinner, ErrorNote, Empty, useFetch } from './ui';
import { L, LangSelect } from './Lang';
import { Socratic, MindMap, ExamPlanner } from './RecallModes';

const RATINGS: [number, string, string][] = [[1, 'Again', 'I forgot it'], [2, 'Hard', 'with effort'], [3, 'Good', 'I recalled it'], [4, 'Easy', 'instantly']];
const pctTxt = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const bandOf = (s: number) => (s >= 0.8 ? ['Strong recall', 'var(--accent)'] : s >= 0.55 ? ['Partly there', '#d97706'] : ['Needs work', 'var(--danger)']);
const STATUS_ICON: Record<string, string> = { covered: '✔', partial: '◐', missing: '○', contradicted: '✖' };
const nextText = (d: number) => (d < 0.02 ? 'in a few minutes' : d < 1 ? 'later today' : d < 2 ? 'tomorrow' : `in ${Math.round(d)} days`);

// ───────────── OpenUI: model-composed visual panel (with native fallback) ─────────────
export function OpenUIPanel({ kind, attemptId, bookId, fallback, lang }: { kind: 'feedback' | 'plan'; attemptId?: string; bookId?: string | null; fallback: React.ReactNode; lang?: string }) {
  const [src, setSrc] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [bad, setBad] = useState(false); const [model, setModel] = useState('');
  const system = useMemo(() => recallLibrary.prompt({ preamble: kind === 'plan' ? "You turn a learner's memory report into a short, motivating study briefing panel." : 'You turn a learner feedback report into a clear, compact visual panel.', additionalRules: [FORMAT_RULE, ...(kind === 'plan' ? PLAN_RULES : FEEDBACK_RULES)], examples: [kind === 'plan' ? PLAN_EXAMPLE : FEEDBACK_EXAMPLE] }), [kind]);
  const schema = useMemo(() => recallLibrary.toJSONSchema(), []);
  async function go() {
    setBusy(true); setErr(null); setBad(false); setSrc(null);
    try { const r = await post('/recall/compose', { kind, attemptId, bookId, lang, system, schema }); setSrc(r.openui); setModel(`${r.model}${r.attempts > 1 ? `, ${r.attempts} attempts` : ''}`); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }
  return (
    <div className="space-y-2">
      {!src && !busy && <button className="btn" onClick={go}><Icon n="sparkle" size={14} /> {kind === 'plan' ? 'Compose my study briefing' : 'Explain visually'}</button>}
      {busy && <Spinner label="Composing a panel with OpenUI…" />}
      {err && <div className="space-y-2"><ErrorNote error={err} />{fallback}</div>}
      {src && (bad ? <div className="space-y-2"><p className="text-xs text-[var(--ink3)]">The composed panel had errors, showing the standard view.</p>{fallback}</div> : (
        <div className="fade-in">
          <Renderer response={src} library={recallLibrary} isStreaming={false} onError={(errs: unknown) => { if (Array.isArray(errs) && errs.length) setBad(true); }} />
          <p className="text-[10px] text-[var(--ink3)] mt-2">Composed by {model} with OpenUI from your evaluation and the book passage. <button className="underline" onClick={go}>Regenerate</button></p>
        </div>))}
    </div>
  );
}

// ───────────── the close-book recall session ─────────────
interface Fb { attemptId: string; evaluation: any; key: any; question: any }

export function RecallSession({ run, onClose }: { run: RecallRun; onClose: (completed: boolean) => void }) {
  const { say, openAt } = useStore();
  const qs = run.questions; const [i, setI] = useState(0); const [answer, setAnswer] = useState(''); const [choice, setChoice] = useState<number | null>(null);
  const [conf, setConf] = useState(3); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [fb, setFb] = useState<Fb | null>(null);
  const [rated, setRated] = useState<{ rating: number; next: number } | null>(null); const [results, setResults] = useState<{ q: any; score: number; rating: number }[]>([]);
  const [done, setDone] = useState(false); const t0 = useRef(Date.now()); const [mic, setMic] = useState(false); const [modality, setModality] = useState<'text' | 'voice'>('text');
  const { data: settings } = useFetch<any>('/recall/settings'); const recRef = useRef<any>(null);
  const q = qs[i]; const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : null;
  useEffect(() => { t0.current = Date.now(); setAnswer(''); setChoice(null); setFb(null); setRated(null); setErr(null); setConf(3); setModality('text'); }, [i]);

  async function submit(text?: string) {
    const a = text ?? (q.type === 'mcq' ? String(choice ?? '') : answer); if (!a.trim()) return;
    setBusy(true); setErr(null);
    try { const r = await post(`/recall/sessions/${run.sessionId}/answer`, { questionId: q.id, answer: a, confidence: conf, modality, timeMs: Date.now() - t0.current }); setFb(r); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }
  async function rate(r: number) { if (!fb) return; try { const x = await post(`/recall/attempts/${fb.attemptId}/rate`, { rating: r }); setRated({ rating: r, next: x.state.dueInDays }); setResults((l) => [...l, { q, score: fb.evaluation.score, rating: r }]); } catch (e: any) { setErr(e.message); } }
  async function finish(status: 'completed' | 'skipped') { await post(`/recall/sessions/${run.sessionId}/end`, { status }).catch(() => {}); onClose(status === 'completed'); }
  function startMic() {
    if (!SR) return say('This browser has no speech recognition — type your answer.');
    const r = new SR(); r.lang = getLang(settings?.feedbackLang || undefined)?.speech ?? navigator.language; r.interimResults = true; recRef.current = r;
    r.onresult = (e: any) => { setAnswer(Array.from(e.results).map((x: any) => x[0].transcript).join(' ')); setModality('voice'); }; r.onend = () => setMic(false); r.onerror = () => setMic(false);
    setMic(true); r.start();
  }
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) void finish(results.length ? 'completed' : 'skipped'); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }); // eslint-disable-line react-hooks/exhaustive-deps

  if (done || !q) {
    const avg = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
    const weak = results.filter((r) => r.score < 0.55).map((r) => r.q.concept);
    return (
      <div className="fixed inset-0 z-50 bg-[var(--bg)] overflow-auto"><div className="max-w-xl mx-auto p-8 space-y-5 fade-in">
        <h1 className="font-serif text-3xl">Session complete</h1>
        <div className="grid grid-cols-3 gap-3 text-center">{[['Answered', results.length], ['Evidence of recall', pctTxt(avg)], ['To revisit', new Set(weak).size]].map(([k, v]) => <div key={k as string} className="card p-3"><div className="label">{k}</div><div className="text-2xl font-serif">{v}</div></div>)}</div>
        {weak.length > 0 && <div className="card p-3 text-sm"><div className="label mb-1">Scheduled to come back sooner</div>{[...new Set(weak)].map((w) => <span key={w} className="chip mr-1">{w}</span>)}</div>}
        <p className="text-xs text-[var(--ink3)]">Each question is rescheduled by your own result using FSRS, so forgotten ideas return soon and remembered ones are spaced further out.</p>
        <button className="btn btn-primary" onClick={() => finish('completed')}>Back to reading</button>
      </div></div>
    );
  }
  const lang = q.lang ?? 'en'; const ev = fb?.evaluation; const [bandText, bandColor] = ev ? bandOf(ev.score) : ['', ''];
  const fallbackView = fb && (
    <div className="space-y-3 text-sm">
      {ev.got_right.length > 0 && <div><div className="label mb-1" style={{ color: 'var(--accent)' }}>What you got right</div><ul className="list-disc ml-5">{ev.got_right.map((x: string, k: number) => <li key={k}>{x}</li>)}</ul></div>}
      {(ev.missed.length > 0 || ev.points.some((p: any) => p.status !== 'covered')) && <div><div className="label mb-1" style={{ color: '#d97706' }}>What you missed</div><ul className="list-disc ml-5">{ev.missed.map((x: string, k: number) => <li key={k}>{x}</li>)}</ul></div>}
      {ev.wrong.length > 0 && <div><div className="label mb-1" style={{ color: 'var(--danger)' }}>What you got wrong</div><ul className="list-disc ml-5">{ev.wrong.map((x: string, k: number) => <li key={k}>{x}</li>)}</ul></div>}
      {ev.improve && <div><div className="label mb-1">How to improve your answer</div><p>{ev.improve}</p></div>}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg)] overflow-auto" role="dialog" aria-label="Recall session">
      <div className="max-w-2xl mx-auto p-5 md:p-8 space-y-5">
        <div className="flex items-center gap-3 text-sm"><span className="font-medium truncate">{run.title}</span><span className="chip">{i + 1} / {qs.length}</span><span className="chip">{q.levelName}</span><span className="chip">{q.concept}</span>
          <div className="ml-auto flex gap-2"><span className="text-[11px] text-[var(--ink3)] hidden sm:inline">The book is closed — answer from memory</span><button className="btn" onClick={() => finish(results.length ? 'completed' : 'skipped')}>{results.length ? 'End' : 'Skip'}</button></div></div>
        <div className="h-1 rounded bg-[var(--panel2)]"><div className="h-1 rounded bg-[var(--accent)] transition-all" style={{ width: `${((i + (fb ? 1 : 0)) / qs.length) * 100}%` }} /></div>

        <L code={lang} block className="font-serif text-2xl leading-snug">{q.question}</L>

        {!fb && (<>
          {q.type === 'mcq' ? <div className="space-y-2">{q.options.map((o: string, k: number) => <label key={k} className={`card p-3 flex gap-3 cursor-pointer ${choice === k ? 'ring-2 ring-[var(--accent)]' : ''}`}><input type="radio" name="opt" checked={choice === k} onChange={() => setChoice(k)} /><span>{o}</span></label>)}</div>
            : <div className="space-y-2"><textarea className="input text-base" rows={q.type === 'numeric' ? 2 : 7} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={q.type === 'numeric' ? `Your numeric answer${q.unit ? ` (${q.unit})` : ''}` : 'Write what you remember and how you would apply it — in any language…'} autoFocus lang={detectLanguage(answer).code} dir={isRtl(detectLanguage(answer).code) ? 'rtl' : undefined} style={{ fontFamily: fontFor(detectLanguage(answer).code) }} aria-label="Your answer" />
              {settings?.allowVoice && <button className="btn" onMouseDown={startMic} onMouseUp={() => recRef.current?.stop()}><Icon n={mic ? 'stop' : 'sound'} size={14} /> {mic ? 'Listening…' : 'Hold to speak'}</button>}</div>}
          <div className="flex flex-wrap items-center gap-3 text-sm"><label className="flex items-center gap-2">How sure are you? <input type="range" min={1} max={5} value={conf} onChange={(e) => setConf(Number(e.target.value))} className="accent-[var(--accent)]" aria-label="Confidence" /><span className="chip">{['guessing', 'unsure', 'maybe', 'fairly sure', 'certain'][conf - 1]}</span></label></div>
          {err && <ErrorNote error={err} />}
          <div className="flex gap-2"><button className="btn btn-primary" disabled={busy || (q.type === 'mcq' ? choice == null : !answer.trim())} onClick={() => submit()}>{busy ? 'Evaluating…' : 'Submit answer'}</button><button className="btn" disabled={busy} onClick={() => submit("I don't know")}>I don't know</button></div>
          {busy && <Spinner label="Checking your answer against the book…" />}
        </>)}

        {fb && ev && (
          <div className="space-y-4 fade-in">
            <div className="card p-4 flex items-center gap-4"><div className="text-3xl font-serif" style={{ color: bandColor }}>{Math.round(ev.score * 100)}%</div><div className="flex-1"><div className="font-medium" style={{ color: bandColor }}>{bandText}</div>
              <div className="text-[11px] text-[var(--ink3)]">{ev.method === 'deterministic' ? 'Checked by calculation' : `Judged by ${ev.model} against the book's key points`} · accuracy {pctTxt(ev.scores.accuracy)} · completeness {pctTxt(ev.scores.completeness)}{ev.scores.understanding != null ? ` · understanding ${pctTxt(ev.scores.understanding)}` : ''}{ev.scores.application != null ? ` · application ${pctTxt(ev.scores.application)}` : ''}</div></div></div>
            {ev.points.length > 0 && <div className="card p-3 text-sm"><div className="label mb-1">Key ideas</div>{ev.points.map((p: any, k: number) => <div key={k} className="flex gap-2 py-0.5"><span style={{ color: p.status === 'covered' ? 'var(--accent)' : p.status === 'contradicted' ? 'var(--danger)' : p.status === 'partial' ? '#d97706' : 'var(--ink3)' }}>{STATUS_ICON[p.status]}</span><L code={lang}>{p.point}</L></div>)}</div>}
            <div className="card p-3 text-sm space-y-2"><div className="label">Model answer</div><L code={lang} block>{fb.key.expected}</L>
              {fb.key.source_quote && <blockquote className="font-serif border-l-2 border-[var(--accent)] pl-3 text-[var(--ink2)]">“{fb.key.source_quote}”</blockquote>}
              <div className="flex flex-wrap gap-2 text-xs text-[var(--ink3)]">{fb.key.sources.map((s: any, k: number) => <button key={k} className="underline" onClick={() => { void finish('completed'); setTimeout(() => openAt(s.book_id, s.page, null, null, s.quote), 100); }}>{s.book_title ? `${s.book_title}, ` : ''}p. {s.page}</button>)}</div></div>
            <OpenUIPanel kind="feedback" attemptId={fb.attemptId} lang={ev.feedbackLang} fallback={fallbackView} />
            {ev.remember && <div className="rounded-lg bg-[var(--panel2)] p-3 text-sm">💡 <b>Remember:</b> <L code={ev.feedbackLang}>{ev.remember}</L></div>}
            {ev.follow_up && <p className="text-sm text-[var(--ink2)]">Think about: <L code={ev.feedbackLang}>{ev.follow_up}</L></p>}
            {!rated ? (<div><div className="label mb-2">How well did you recall it? (suggested: {RATINGS.find((r) => r[0] === ev.autoRating)?.[1]})</div>
              <div className="grid grid-cols-4 gap-2">{RATINGS.map(([n, name, hint]) => <button key={n} onClick={() => rate(n)} className={`btn flex-col !py-2 justify-center ${n === ev.autoRating ? 'btn-primary' : ''}`}><b>{name}</b><span className="text-[10px] opacity-70">{hint}</span></button>)}</div></div>
            ) : (<div className="flex items-center gap-3"><span className="text-sm text-[var(--ink2)]">Next review {nextText(rated.next)}.</span><button className="btn btn-primary" onClick={() => (i + 1 >= qs.length ? setDone(true) : setI(i + 1))}>{i + 1 >= qs.length ? 'Finish' : 'Next question'}</button></div>)}
            {err && <ErrorNote error={err} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ───────────── reading trigger banner ─────────────
export function RecallBanner({ label, busy, onStart, onLater, onSkip }: { label: string; busy: boolean; onStart: () => void; onLater: () => void; onSkip: () => void }) {
  return (
    <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-40 card px-4 py-2.5 shadow-xl flex items-center gap-3 fade-in text-sm" role="status">
      <Icon n="sparkle" size={16} /><span>{busy ? 'Preparing questions…' : label}</span>
      <button className="btn btn-primary !py-1" disabled={busy} onClick={onStart}>Close book & recall</button>
      <button className="btn btn-ghost !py-1" onClick={onLater}>Later</button><button className="btn btn-ghost !py-1 text-[var(--ink3)]" onClick={onSkip} title="Counts as a skipped review">Skip</button>
    </div>
  );
}

// ───────────── Daily Recall hub ─────────────
export function RecallView() {
  const { say, setRecall, go } = useStore();
  const [tab, setTab] = useState<'today' | 'mastery' | 'practice' | 'analytics' | 'settings'>('today');
  const { data: sum, reload: reloadSum } = useFetch<any>('/recall/summary');
  const [minutes, setMinutes] = useState<number | null>(null); const [busy, setBusy] = useState(false);
  const mins = minutes ?? sum?.settings?.dailyMinutes ?? 10;
  const { data: daily, reload: reloadDaily } = useFetch<any>(`/recall/daily?minutes=${mins}`, [mins, sum?.due]);
  const { data: gaps } = useFetch<any>('/recall/gaps'); const { data: mastery } = useFetch<any[]>('/recall/mastery'); const { data: an } = useFetch<any>('/recall/analytics');

  async function startDaily() {
    setBusy(true);
    try { const r = await post('/recall/sessions', { kind: 'daily', minutes: mins }); if (!r.questions.length) { say('Nothing is due right now. Read more pages or generate questions in Practice.'); } else setRecall({ title: `Daily recall · ${mins} min`, sessionId: r.sessionId, bookId: null, questions: r.questions }); } catch (e: any) { say(e.message); }
    setBusy(false);
  }
  async function startConcepts(concepts: string[], title: string) { try { const r = await post('/recall/sessions', { kind: 'concepts', concepts }); setRecall({ title, sessionId: r.sessionId, bookId: null, questions: r.questions }); } catch (e: any) { say(e.message); } }
  const TABS: [typeof tab, string][] = [['today', 'Today'], ['mastery', 'Mastery'], ['practice', 'Practice'], ['analytics', 'Analytics'], ['settings', 'Settings']];

  return (
    <div>
      <header className="mb-5"><h1 className="font-serif text-3xl tracking-tight">Daily recall</h1><p className="text-sm text-[var(--ink2)] mt-1">Reading introduces knowledge. Retrieval makes it last. Everything here is built from your own answers.</p></header>
      <div className="flex gap-1 mb-6 flex-wrap">{TABS.map(([k, l]) => <button key={k} className={`btn ${tab === k ? 'btn-primary' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>

      {tab === 'today' && (
        <div className="space-y-6 max-w-3xl">
          <div className="card p-5 space-y-3">
            <div className="flex flex-wrap gap-6 items-end">
              {[['Due for review', sum?.due ?? '—'], ['New from pages you read', sum?.fresh ?? '—'], ['Question bank', sum?.total ?? '—'], ['Sessions skipped', sum?.skipped ?? '—'], ['Completed', sum?.completed ?? '—']].map(([k, v]) => <div key={k as string}><div className="label">{k}</div><div className="text-2xl font-serif">{v}</div></div>)}
            </div>
            <div className="flex flex-wrap items-center gap-2"><span className="text-sm text-[var(--ink2)]">Session length</span>{[5, 10, 20, 30].map((m) => <button key={m} className={`btn ${mins === m ? 'btn-primary' : ''}`} onClick={() => setMinutes(m)}>{m} min</button>)}
              <input type="number" min={3} max={120} className="input !w-20" value={mins} onChange={(e) => setMinutes(Number(e.target.value) || 10)} aria-label="Custom minutes" /></div>
            {daily && <p className="text-sm text-[var(--ink2)]">{daily.questions.length ? `A ${mins}-minute session: ${daily.questions.length} questions (${daily.plan.due} reviews + ${daily.plan.new} new), mixed across ${daily.plan.books} book${daily.plan.books === 1 ? '' : 's'}, about ${daily.plan.estimated} min. ${daily.plan.overdueTotal > daily.plan.due ? `${daily.plan.overdueTotal - daily.plan.due} more are due — they are not lost, just postponed to keep the workload manageable.` : ''}` : 'Nothing is due, and you have no unseen questions from pages you have read. Read a few pages, or build questions in Practice.'}</p>}
            <button className="btn btn-primary" disabled={busy || !daily?.questions.length} onClick={startDaily}>{busy ? 'Starting…' : 'Start daily recall'}</button>
          </div>

          {gaps && gaps.sessions.length > 0 && (
            <div className="space-y-2"><h2 className="label">Targeted sessions from your knowledge gaps</h2>
              {gaps.sessions.map((s: any) => <div key={s.kind} className="card p-3 flex items-center gap-3"><div className="flex-1"><div className="font-medium text-sm">{s.label}</div><div className="text-xs text-[var(--ink3)]">{s.concepts.join(' · ')}</div></div><button className="btn" onClick={() => startConcepts(s.concepts, s.label)}>~{s.minutes} min</button></div>)}
              <OpenUIPanel kind="plan" lang={sum?.settings?.feedbackLang || 'en'} fallback={<p className="text-sm text-[var(--ink2)]">Start with the weakest concepts above, then the fading ones.</p>} />
            </div>
          )}
          {gaps && !gaps.sessions.length && <Empty title="No gaps detected yet">Gaps appear after you have answered questions: weak concepts, forgotten ideas, and pages you read but never tested.</Empty>}
        </div>
      )}

      {tab === 'mastery' && <MasteryTab mastery={mastery} gaps={gaps} onPractice={(c) => startConcepts([c], `Practice: ${c}`)} />}
      {tab === 'practice' && <PracticeTab onStart={(r) => setRecall(r)} reload={() => { reloadSum(); reloadDaily(); }} />}
      {tab === 'analytics' && <AnalyticsTab an={an} />}
      {tab === 'settings' && <RecallSettings onSaved={reloadSum} />}
      <button className="hidden" onClick={() => go('home')} aria-hidden />
    </div>
  );
}

function Bar({ v, label }: { v: number | null; label: string }) {
  return <div className="text-[10px] text-[var(--ink3)]" title={`${label}: ${pctTxt(v)}`}><div className="h-1.5 rounded bg-[var(--panel2)]"><div className="h-1.5 rounded" style={{ width: `${(v ?? 0) * 100}%`, background: v == null ? 'transparent' : v >= 0.7 ? 'var(--accent)' : v >= 0.5 ? '#d97706' : 'var(--danger)' }} /></div>{label}</div>;
}

function MasteryTab({ mastery, gaps, onPractice }: { mastery: any[] | null; gaps: any; onPractice: (c: string) => void }) {
  if (!mastery) return <Spinner />;
  if (!mastery.length) return <Empty title="No concepts yet">Generate questions from a page (Practice tab, or the Recall button in the reader). Mastery only reflects questions you have actually answered.</Empty>;
  const byBook = new Map<string, any[]>(); for (const m of mastery) byBook.set(m.book_title, [...(byBook.get(m.book_title) ?? []), m]);
  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--ink3)] max-w-2xl">Four separate dimensions per concept, from your own answers: <b>recognition</b> (choosing), <b>recall</b> (retrieving), <b>understanding</b> (explaining) and <b>application</b> (using). Recognising a concept never counts as mastering it.</p>
      {gaps?.prerequisites?.length > 0 && <div className="card p-3 text-sm"><div className="label mb-1">Possible missing prerequisites</div>{gaps.prerequisites.map((p: any, i: number) => <div key={i}><b>{p.concept}</b> <span className="text-[var(--ink3)]">(p. {p.page}) may be holding back “{p.forWeak}” — {p.why}</span></div>)}</div>}
      {[...byBook.entries()].map(([title, ms]) => (
        <section key={title}><h2 className="font-serif text-xl mb-2">{title}</h2>
          <div className="grid md:grid-cols-2 gap-2.5">{ms.map((m) => (
            <div key={m.concept} className="card p-3 space-y-2"><div className="flex justify-between gap-2"><b className="text-sm">{m.concept}</b><span className="chip" style={m.status === 'mastered' ? { color: 'var(--accent)' } : m.status === 'untested' ? { color: 'var(--ink3)' } : undefined}>{m.status}</span></div>
              <div className="grid grid-cols-4 gap-2"><Bar v={m.dims.recognition} label="recognise" /><Bar v={m.dims.recall} label="recall" /><Bar v={m.dims.understanding} label="understand" /><Bar v={m.dims.application} label="apply" /></div>
              <div className="flex items-center justify-between text-[11px] text-[var(--ink3)]"><span>{m.attempts} attempts · p. {m.page}{m.retention != null ? ` · est. retention ${pctTxt(m.retention)}` : ''}{m.confidenceGap != null && Math.abs(m.confidenceGap) > 0.25 ? (m.confidenceGap > 0 ? ' · overconfident' : ' · underconfident') : ''}</span><button className="btn !py-1" onClick={() => onPractice(m.concept)}>Practise</button></div></div>))}</div></section>
      ))}
    </div>
  );
}

function PracticeTab({ onStart, reload }: { onStart: (r: RecallRun) => void; reload: () => void }) {
  const { data: books } = useFetch<any[]>('/books'); const { say, setRecall } = useStore();
  const ready = (books ?? []).filter((b) => ['readable', 'ready'].includes(b.status));
  const [bookId, setBookId] = useState(''); const bid = bookId || ready[0]?.id || ''; const bk = ready.find((b) => b.id === bid);
  const { data: detail } = useFetch<any>(bid ? `/books/${bid}` : null, [bid]);
  const [from, setFrom] = useState(1); const [to, setTo] = useState(1); const [busy, setBusy] = useState(''); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (detail) { const p = detail.progress?.page ?? 1; setFrom(p); setTo(p); } }, [detail?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [blurtTxt, setBlurtTxt] = useState(''); const [bl, setBl] = useState<any>(null); const [topic, setTopic] = useState('');
  const [exam, setExam] = useState<any>(null); const [chapter, setChapter] = useState(''); const [cnt, setCnt] = useState(8); const [limit, setLimit] = useState(0); const [fmt, setFmt] = useState('mixed');

  const wrap = async (k: string, fn: () => Promise<void>) => { setBusy(k); setErr(null); setMsg(null); try { await fn(); } catch (e: any) { setErr(e.message); } setBusy(''); };
  return (
    <div className="space-y-8 max-w-3xl">
      <div className="card p-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-center"><select className="input !w-72" value={bid} onChange={(e) => setBookId(e.target.value)} aria-label="Book">{ready.map((b) => <option key={b.id} value={b.id}>{b.title.slice(0, 60)}</option>)}</select>
          <label className="text-sm flex items-center gap-1">pages <input type="number" min={1} max={bk?.page_count ?? 1} className="input !w-20" value={from} onChange={(e) => { setFrom(Number(e.target.value)); if (Number(e.target.value) > to) setTo(Number(e.target.value)); }} /> to <input type="number" min={from} max={bk?.page_count ?? 1} className="input !w-20" value={to} onChange={(e) => setTo(Number(e.target.value))} /></label></div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={!bid || !!busy} onClick={() => wrap('gen', async () => { const r = await post('/recall/generate', { bookId: bid, from, to, force: false }); setMsg(r.cached ? 'Questions for these pages already exist.' : `Created ${r.created} questions${r.rejected.length ? `; ${r.rejected.length} rejected by the quality check (${[...new Set(r.rejected.flatMap((x: any) => x.issues))].slice(0, 2).join('; ')})` : ''}.`); reload(); })}>{busy === 'gen' ? 'Generating…' : 'Generate questions'}</button>
          <button className="btn" disabled={!bid || !!busy} onClick={() => wrap('rec', async () => { const r = await post('/recall/sessions', { kind: to > from ? 'section' : 'page', bookId: bid, from, to, count: 5 }); setRecall({ title: `Recall · pp. ${from}–${to}`, sessionId: r.sessionId, bookId: bid, questions: r.questions, range: [from, to] }); })}>Recall these pages now</button>
        </div>
        {busy === 'gen' && <Spinner label="Writing and quality-checking questions from the text (about 20 s per page)…" />}{msg && <p className="text-sm text-[var(--ink2)]">{msg}</p>}{err && <ErrorNote error={err} />}
      </div>

      <section className="space-y-2"><h2 className="label">Blurt: write everything you remember</h2>
        <p className="text-xs text-[var(--ink3)]">The pages are hidden. Write all you remember about pages {from}–{to}; it is compared with the book by meaning. More words earn nothing; wrong statements cost points.</p>
        <textarea className="input" rows={6} value={blurtTxt} onChange={(e) => setBlurtTxt(e.target.value)} placeholder="Everything you remember, in any language…" aria-label="Blurt" />
        <button className="btn" disabled={blurtTxt.trim().length < 20 || !!busy} onClick={() => wrap('blurt', async () => setBl(await post('/recall/blurt', { bookId: bid, from, to, answer: blurtTxt, feedbackLang: undefined })))}>{busy === 'blurt' ? 'Comparing…' : 'Compare with the book'}</button>
        {bl && <div className="card p-3 space-y-2 fade-in"><div className="flex items-center gap-3"><span className="text-2xl font-serif">{Math.round(bl.coverage * 100)}%</span><span className="text-sm text-[var(--ink2)]">of the key ideas recalled · {bl.words} words written</span></div><p className="text-sm">{bl.summary}</p>
          <div className="label">Coverage map</div><div className="grid sm:grid-cols-2 gap-1.5">{bl.ideas.map((x: any, k: number) => <div key={k} className="rounded-md px-2 py-1.5 text-xs border" style={{ borderColor: x.status === 'remembered' ? 'var(--accent)' : x.status === 'partial' ? '#d97706' : 'var(--line)', opacity: x.status === 'missing' ? 0.65 : 1 }}>{x.status === 'remembered' ? '✔' : x.status === 'partial' ? '◐' : '○'} {x.idea}</div>)}</div>
          {bl.wrong.length > 0 && <div><div className="label" style={{ color: 'var(--danger)' }}>Incorrect statements</div><ul className="list-disc ml-5 text-sm">{bl.wrong.map((w: string, k: number) => <li key={k}>{w}</li>)}</ul></div>}
          {bl.extra.length > 0 && <div><div className="label">Extra connections</div><ul className="list-disc ml-5 text-sm">{bl.extra.map((w: string, k: number) => <li key={k}>{w}</li>)}</ul></div>}</div>}
      </section>

      <section className="space-y-2"><h2 className="label">Exam</h2>
        <div className="flex flex-wrap gap-2 items-center"><select className="input !w-64" value={chapter} onChange={(e) => setChapter(e.target.value)} aria-label="Scope"><option value="">Whole book</option>{detail?.chapters?.map((c: any) => <option key={c.idx} value={c.idx}>{c.title.slice(0, 40)}</option>)}</select>
          <label className="text-sm">Questions <input type="number" min={3} max={20} className="input !w-16" value={cnt} onChange={(e) => setCnt(Number(e.target.value))} /></label>
          <label className="text-sm">Minutes <input type="number" min={0} max={180} className="input !w-16" value={limit} onChange={(e) => setLimit(Number(e.target.value))} title="0 = untimed" /></label>
          <select className="input !w-36" value={fmt} onChange={(e) => setFmt(e.target.value)} aria-label="Format"><option value="mixed">Mixed</option><option value="mcq">Multiple choice</option><option value="short">Short answer</option><option value="long">Long / applied</option></select>
          <button className="btn btn-primary" disabled={!bid || !!busy} onClick={() => wrap('exam', async () => { const r = await post('/recall/exams', { bookId: bid, chapterIdx: chapter === '' ? undefined : Number(chapter), count: cnt, timeLimitMin: limit || undefined, format: fmt }); setExam(r); })}>{busy === 'exam' ? 'Building…' : 'Start exam'}</button></div>
        {busy === 'exam' && <Spinner label="Selecting questions across the range (generating any that are missing)…" />}
      </section>

      <Socratic bid={bid} from={from} to={to} />
      <MindMap key={bid} bid={bid} from={from} to={to} topicDefault={detail?.chapters?.find((c: any) => c.start_page <= from && (c.start_page + 1 > from || true))?.title ?? bk?.title ?? 'Topic'} />
      <ExamPlanner key={'p' + bid} bid={bid} detail={detail} />

      <section className="space-y-2"><h2 className="label">Across your books</h2>
        <p className="text-xs text-[var(--ink3)]">Questions that need ideas from two or more books, with citations to both.</p>
        <div className="flex gap-2"><input className="input" placeholder="Topic, e.g. competitive advantage" value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Topic" /><button className="btn" disabled={!topic.trim() || !!busy} onClick={() => wrap('cross', async () => { const r = await post('/recall/cross', { topic }); setMsg(`Created ${r.created} cross-book question${r.created === 1 ? '' : 's'}${r.rejected.length ? `; ${r.rejected.length} rejected` : ''}. They appear in your daily sessions.`); reload(); })}>Generate</button></div>
      </section>
      {exam && <ExamRunner exam={exam} onClose={() => setExam(null)} />}
    </div>
  );
}

function ExamRunner({ exam, onClose }: { exam: any; onClose: () => void }) {
  const [ans, setAns] = useState<Record<string, string>>({}); const [left, setLeft] = useState<number | null>(exam.timeLimitSec); const [submitting, setSubmitting] = useState(false);
  const [prog, setProg] = useState(0); const [items, setItems] = useState<any[]>([]); const [res, setRes] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const t0 = useRef(Date.now()); const sent = useRef(false);
  async function submit() {
    if (sent.current) return; sent.current = true; setSubmitting(true);
    try {
      const r = await fetch(`/api/recall/exams/${exam.examId}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers: ans, seconds: Math.round((Date.now() - t0.current) / 1000) }) });
      if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error ?? 'Submit failed');
      const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; const got: any[] = [];
      for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let nl: number; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; const e = JSON.parse(l); if (e.type === 'progress') setProg(e.i + 1); else if (e.type === 'item') { got.push(e); setItems([...got]); } else if (e.type === 'done') setRes(e); else if (e.type === 'error') setErr(e.error); } }
    } catch (e: any) { setErr(e.message); }
    setSubmitting(false);
  }
  useEffect(() => { if (left == null || res || submitting) return; if (left <= 0) { void submit(); return; } const t = setTimeout(() => setLeft(left - 1), 1000); return () => clearTimeout(t); }); // eslint-disable-line react-hooks/exhaustive-deps
  const mm = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg)] overflow-auto"><div className="max-w-2xl mx-auto p-6 space-y-5">
      <div className="flex items-center gap-3"><h1 className="font-serif text-2xl flex-1">{exam.title}</h1>{left != null && !res && <span className={`chip ${left < 60 ? '!text-[var(--danger)]' : ''}`}>⏱ {mm(left)}</span>}<button className="btn" onClick={onClose}>{res ? 'Close' : 'Abandon'}</button></div>
      {!res && !submitting && <>
        <p className="text-xs text-[var(--ink3)]">Closed-book. Covers pages {exam.pages[0]}–{exam.pages[1]} ({exam.coveragePages.length} distinct pages sampled). Answers are checked after you submit.</p>
        {exam.questions.map((q: any, i: number) => (<div key={q.id} className="card p-4 space-y-2"><div className="flex gap-2 text-xs"><span className="chip">Q{i + 1}</span><span className="chip">{q.levelName}</span></div><L code={q.lang} block className="font-serif text-lg">{q.question}</L>
          {q.type === 'mcq' ? q.options.map((o: string, k: number) => <label key={k} className="flex gap-2 text-sm"><input type="radio" name={q.id} checked={ans[q.id] === String(k)} onChange={() => setAns({ ...ans, [q.id]: String(k) })} />{o}</label>) : <textarea className="input" rows={q.level >= 4 ? 6 : 3} value={ans[q.id] ?? ''} onChange={(e) => setAns({ ...ans, [q.id]: e.target.value })} aria-label={`Answer ${i + 1}`} />}</div>))}
        <button className="btn btn-primary" onClick={submit}>Submit exam</button></>}
      {submitting && !res && <div className="space-y-2"><Spinner label={`Marking question ${prog} of ${exam.questions.length}…`} />{items.length > 0 && <p className="text-xs text-[var(--ink3)]">{items.length} marked so far</p>}</div>}
      {err && <ErrorNote error={err} />}
      {res && <div className="space-y-4 fade-in"><div className="card p-4 flex gap-6 items-center"><div className="text-4xl font-serif" style={{ color: bandOf(res.score)[1] }}>{Math.round(res.score * 100)}%</div><div className="text-sm text-[var(--ink2)]">{res.correct} of {res.total} answers showed solid recall · pages {res.pages.join(', ')}{res.seconds ? ` · ${mm(res.seconds)}` : ''}</div></div>
        <div className="card p-3 text-sm"><div className="label mb-1">By concept (weakest first)</div>{res.concepts.map((c: any) => <div key={c.concept} className="flex justify-between py-0.5"><span>{c.concept}</span><span style={{ color: bandOf(c.score)[1] }}>{Math.round(c.score * 100)}%</span></div>)}</div>
        {items.map((it, i) => <div key={i} className="card p-3 text-sm space-y-1"><div className="flex justify-between"><b>Q{i + 1}. {it.question.concept}</b><span style={{ color: bandOf(it.evaluation.score)[1] }}>{Math.round(it.evaluation.score * 100)}%</span></div><L code={it.question.lang} block className="text-[var(--ink2)]">{it.question.question}</L><div><span className="label">Model answer </span><L code={it.question.lang}>{it.key.expected}</L></div>{it.evaluation.missed.length > 0 && <div className="text-xs">Missed: {it.evaluation.missed.join('; ')}</div>}<div className="text-[11px] text-[var(--ink3)]">p. {it.question.page}</div></div>)}
        <p className="text-xs text-[var(--ink3)]">Every answer was also scheduled for spaced review by its result.</p></div>}
    </div></div>
  );
}

function AnalyticsTab({ an }: { an: any }) {
  if (!an) return <Spinner />;
  if (!an.attempts) return <Empty title="No recall data yet">Analytics are computed only from questions you answer. Nothing is estimated or made up.</Empty>;
  const dims = Object.entries(an.dimensions) as [string, any][];
  return (
    <div className="space-y-6 max-w-3xl">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{[['Questions answered', an.attempts], ['Solid answers', `${an.correct} (${pctTxt(an.accuracy)})`], ['Average score', pctTxt(an.avgScore)], ['Sessions done / skipped', `${an.sessions.completed ?? 0} / ${an.sessions.skipped ?? 0}`]].map(([k, v]) => <div key={k as string} className="card p-3"><div className="label">{k}</div><div className="text-xl font-serif mt-1">{v}</div></div>)}</div>
      <section><h2 className="label mb-2">By skill — kept separate</h2><div className="grid grid-cols-2 md:grid-cols-4 gap-3">{dims.map(([k, d]) => <div key={k} className="card p-3"><div className="label">{k}</div><div className="text-lg font-serif">{pctTxt(d.accuracy)}</div><div className="text-[11px] text-[var(--ink3)]">{d.attempts} answers</div></div>)}</div></section>
      {an.daily.length > 0 && <section><h2 className="label mb-2">Last days</h2><div className="flex items-end gap-1 h-24">{an.daily.map((d: any) => <div key={d.date} className="flex-1 flex flex-col justify-end" title={`${d.date}: ${d.attempts} answers, ${pctTxt(d.accuracy)} solid`}><div className="rounded-t" style={{ height: `${Math.max(6, (d.accuracy ?? 0) * 100)}%`, background: 'var(--accent)', opacity: 0.35 + Math.min(0.65, d.attempts / 12) }} /></div>)}</div><p className="text-[10px] text-[var(--ink3)]">Bar height = share of solid answers; opacity = how many questions you answered.</p></section>}
      {an.retentionTrend.length > 0 && <section><h2 className="label mb-2">Retention on repeat reviews (weekly)</h2>{an.retentionTrend.map((w: any) => <div key={w.week} className="flex gap-3 text-sm py-0.5"><span className="w-24 text-[var(--ink3)]">{w.week}</span><div className="flex-1 h-2 self-center rounded bg-[var(--panel2)]"><div className="h-2 rounded bg-[var(--accent)]" style={{ width: `${(w.retained ?? 0) * 100}%` }} /></div><span className="w-24 text-right">{pctTxt(w.retained)} of {w.reviews}</span></div>)}</section>}
      {an.chapters.length > 0 && <section><h2 className="label mb-2">Weakest chapters</h2>{an.chapters.slice(0, 6).map((c: any, i: number) => <div key={i} className="flex justify-between text-sm py-0.5"><span className="truncate">{c.chapter} <span className="text-[var(--ink3)]">· {String(c.book).slice(0, 30)}</span></span><span>{pctTxt(c.avg)} ({c.attempts})</span></div>)}</section>}
      <p className="text-xs text-[var(--ink3)]">{an.note}</p>
    </div>
  );
}

function RecallSettings({ onSaved }: { onSaved: () => void }) {
  const { data, reload } = useFetch<any>('/recall/settings'); const save = async (p: any) => { await put('/recall/settings', p); reload(); onSaved(); };
  if (!data) return <Spinner />;
  return (
    <div className="card p-4 space-y-4 max-w-xl text-sm">
      <label className="block">When should recall start while you read?
        <select className="input mt-1" value={data.trigger} onChange={(e) => save({ trigger: e.target.value })}>
          <option value="off">Never interrupt me (use Daily recall)</option><option value="page">After every page</option><option value="pages2">After every 2 pages</option><option value="pages3">After every 3 pages</option><option value="pages5">After every 5 pages</option><option value="chapter">At the end of a chapter</option><option value="difficult">Only after difficult pages (formulas, hard vocabulary)</option><option value="session">When I leave the book (end of session)</option><option value="manual">Only when I press Recall</option></select></label>
      <label className="block">Questions per recall <input type="number" min={1} max={10} className="input !w-20 ml-2" value={data.perSession} onChange={(e) => save({ perSession: Number(e.target.value) })} /></label>
      <label className="block">Daily session length (minutes) <input type="number" min={3} max={120} className="input !w-20 ml-2" value={data.dailyMinutes} onChange={(e) => save({ dailyMinutes: Number(e.target.value) })} /></label>
      <label className="block">Target retention <select className="input !w-28 ml-2" value={data.retention} onChange={(e) => save({ retention: Number(e.target.value) })}>{[0.8, 0.85, 0.9, 0.95].map((r) => <option key={r} value={r}>{Math.round(r * 100)}%</option>)}</select><span className="block text-xs text-[var(--ink3)] mt-1">Higher = more frequent reviews. FSRS spaces each question so you should still recall it with this probability.</span></label>
      <div><div className="mb-1">Feedback language</div><LangSelect value={data.feedbackLang || 'en'} onChange={(c) => save({ feedbackLang: c })} /><button className="underline text-xs mt-1" onClick={() => save({ feedbackLang: '' })}>Match the language I answer in</button><p className="text-xs text-[var(--ink3)] mt-1">Answer in any language: meaning is judged, not wording. {data.feedbackLang ? `Feedback in ${langName(data.feedbackLang)}.` : 'Feedback follows your answer language.'}</p></div>
      <label className="flex gap-2 items-start"><input type="checkbox" checked={data.allowVoice} onChange={(e) => save({ allowVoice: e.target.checked })} className="mt-1" /><span>Allow spoken answers (push-to-talk). <span className="text-xs text-[var(--ink3)]">No local speech recogniser is installed; Chrome/Edge send audio to their servers.</span></span></label>
    </div>
  );
}
