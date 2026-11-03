'use client';
import { useEffect, useRef, useState } from 'react';
import { api, post, ndjson, ApiError } from '@/lib/api';
import { useStore, type RightTab } from '@/lib/store';
import { Icon, Md, Spinner, ErrorNote, useFetch } from '../ui';
import { speakWord, reader, ACCENTS, browserVoices, type Scope } from '@/lib/tts';
import { DiscoveryPanel, SelectionWords, Suggestions, ModeAnalysis } from './Companion';
import { TranslatePanel, WordTranslations, LangSelect } from '../Lang';
import { ListenCheck } from '../RecallModes';

interface P {
  book: { id: string; title: string; page_count: number; chapters: { idx: number; title: string; start_page: number }[] };
  page: number; text: string; goPage: (p: number) => void; chapterIdx: number; className?: string;
  annots: { bookmarks: any[]; highlights: any[]; notes: any[] };
}

const TABS: { id: RightTab; label: string; icon: string }[] = [
  { id: 'understand', label: 'Understand', icon: 'sparkle' }, { id: 'ask', label: 'Ask', icon: 'vocab' }, { id: 'word', label: 'Word', icon: 'book' },
  { id: 'goal', label: 'Goal Lens', icon: 'goal' }, { id: 'notes', label: 'Notes', icon: 'note' }, { id: 'audio', label: 'Audio', icon: 'sound' }, { id: 'translate', label: 'Translate', icon: 'type' },
];

export function RightPanel(p: P) {
  const { rightTab, setRightTab } = useStore();
  return (
    <aside className={`w-[22rem] max-w-full shrink-0 border-l border-[var(--line)] bg-[var(--panel)] flex flex-col ${p.className ?? ''}`} aria-label="Companion">
      <div role="tablist" className="flex border-b border-[var(--line)] overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={rightTab === t.id} onClick={() => setRightTab(t.id)} className={`flex-1 min-w-fit px-2.5 py-2.5 text-[11px] flex flex-col items-center gap-0.5 ${rightTab === t.id ? 'text-[var(--accent)] border-b-2 border-[var(--accent)] font-semibold' : 'text-[var(--ink2)]'}`}>
            <Icon n={t.icon} size={15} />{t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {rightTab === 'understand' && <Understand {...p} />}
        {rightTab === 'ask' && <Ask {...p} />}
        {rightTab === 'word' && <WordPanel {...p} />}
        {rightTab === 'goal' && <GoalLens {...p} />}
        {rightTab === 'notes' && <NotesPanel {...p} />}
        {rightTab === 'audio' && <AudioPanel {...p} />}
        {rightTab === 'translate' && <TranslatePanel book={p.book as any} page={p.page} text={p.text} />}
      </div>
    </aside>
  );
}

function AiError({ e }: { e: string }) {
  const go = useStore((s) => s.go);
  const setup = /ollama|model/i.test(e);
  return (
    <div className="space-y-2"><ErrorNote error={e} />
      {setup && <button className="btn" onClick={() => go('settings')}>Open model setup</button>}
    </div>
  );
}

// ───────────────── Understand: summaries + study materials ─────────────────
const KINDS = [['quick', 'Quick'], ['detailed', 'Detailed'], ['simple', 'Simple'], ['technical', 'Technical'], ['takeaways', 'Takeaways'], ['terms', 'Terms'], ['arguments', 'Arguments'], ['connections', 'Connections'], ['memory', 'Memory']] as const;

function Understand({ book, page, chapterIdx, text }: P) {
  const selection = useStore((s) => s.selection);
  const [kind, setKind] = useState<string>('quick');
  const [scope, setScope] = useState<'page' | 'selection' | 'pages' | 'chapter' | 'book'>('page');
  const [range, setRange] = useState(3);
  const [busy, setBusy] = useState(false); const [out, setOut] = useState<{ text: string; model: string; cached?: boolean; note?: string } | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setOut(null); setErr(null); }, [page, kind, scope]);
  const ch = book.chapters[chapterIdx]; const nextCh = book.chapters[chapterIdx + 1];

  async function run(force = false) {
    setBusy(true); setErr(null); setOut(null);
    let from = page, to = page, selText: string | undefined;
    if (scope === 'selection') selText = selection?.text;
    if (scope === 'pages') to = Math.min(book.page_count, page + range - 1);
    if (scope === 'chapter') { from = ch?.start_page ?? 1; to = (nextCh?.start_page ?? book.page_count + 1) - 1; }
    if (scope === 'book') { from = 1; to = book.page_count; }
    try { setOut(await post('/ai/summary', { bookId: book.id, kind, from, to, selection: selText, force })); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <Suggestions text={text} page={page} />
      <ModeAnalysis bookId={book.id} page={page} />
      <div className="flex flex-wrap gap-1">{KINDS.map(([k, l]) => <button key={k} onClick={() => setKind(k)} className={`chip ${kind === k ? '!bg-[var(--accent)] !text-[var(--accent-ink)]' : ''}`}>{l}</button>)}</div>
      <div className="flex gap-2 items-center">
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value as any)} aria-label="Scope">
          <option value="page">This page ({page})</option><option value="selection" disabled={!selection}>Selection</option><option value="pages">Next pages…</option><option value="chapter">Chapter: {ch?.title?.slice(0, 22)}</option><option value="book">Entire book</option>
        </select>
        {scope === 'pages' && <input type="number" min={2} max={20} className="input !w-16" value={range} onChange={(e) => setRange(Number(e.target.value))} aria-label="Number of pages" />}
      </div>
      <button className="btn btn-primary w-full justify-center" onClick={() => run(false)} disabled={busy || (scope === 'selection' && !selection)}><Icon n="sparkle" /> Summarise</button>
      {scope === 'book' && <p className="text-[11px] text-[var(--ink3)]">Whole-book summaries are built by summarising sections then combining them. With a local model this can take several minutes.</p>}
      {busy && <Spinner label="Reading the text with your local model…" />}
      {err && <AiError e={err} />}
      {out && (
        <div className="fade-in">
          <Md text={out.text} />
          <div className="mt-3 pt-3 border-t border-[var(--line)] text-[11px] text-[var(--ink3)] flex flex-wrap gap-x-3 gap-y-1 items-center">
            <span>Generated by {out.model}{out.cached ? ' · cached' : ''}</span>{out.note && <span>{out.note}</span>}
            {out.cached && <button className="underline" onClick={() => run(true)}>Regenerate</button>}
            <button className="underline" onClick={() => post('/notes', { book_id: book.id, page, title: `${kind} summary`, body: out.text, source: 'ai' }).then(() => useStore.getState().say('Saved to notes'))}>Save to notes</button>
          </div>
        </div>
      )}
      <Learn book={book} page={page} />
    </div>
  );
}

function Learn({ book, page }: { book: P['book']; page: number }) {
  const [n, setN] = useState(1);
  const [cards, setCards] = useState<any[] | null>(null); const [quiz, setQuiz] = useState<any | null>(null);
  const [busy, setBusy] = useState(''); const [err, setErr] = useState<string | null>(null);
  const to = Math.min(book.page_count, page + n - 1);
  return (
    <details className="border-t border-[var(--line)] pt-3" open>
      <summary className="label cursor-pointer">Study materials</summary>
      <div className="mt-3 space-y-3">
        <div className="flex items-center gap-2 text-xs text-[var(--ink2)]">From <b>{n > 1 ? `pp. ${page}–${to}` : `page ${page}`}</b>
          <select className="input !w-auto !py-1" value={n} onChange={(e) => setN(Number(e.target.value))} aria-label="Pages to cover">{[1, 2, 3, 5, 8].map((x) => <option key={x} value={x}>{x} page{x > 1 ? 's' : ''}</option>)}</select></div>
        <div className="flex gap-2">
          <button className="btn flex-1 justify-center" disabled={!!busy} onClick={async () => { setBusy('cards'); setErr(null); setQuiz(null); try { setCards((await post('/ai/cards', { bookId: book.id, from: page, to })).cards); } catch (e: any) { setErr(e.message); } setBusy(''); }}>Flashcards</button>
          <button className="btn flex-1 justify-center" disabled={!!busy} onClick={async () => { setBusy('quiz'); setErr(null); setCards(null); try { setQuiz(await post('/ai/quiz', { bookId: book.id, from: page, to })); } catch (e: any) { setErr(e.message); } setBusy(''); }}>Quiz</button>
        </div>
        {busy && <Spinner label="Generating from the text…" />}
        {err && <AiError e={err} />}
        {cards && (
          <div className="space-y-2">
            {cards.map((c, i) => <div key={i} className="card p-2.5 text-sm"><div className="font-medium">{c.front}</div><div className="text-[var(--ink2)] mt-1">{c.back}</div><div className="text-[10px] text-[var(--ink3)] mt-1">p. {c.page}{c.quote ? ` · “${String(c.quote).slice(0, 80)}”` : ''}</div></div>)}
            <button className="btn btn-primary w-full justify-center" onClick={async () => { const r = await post('/cards', { cards: cards.map((c) => ({ ...c, book_id: book.id })) }); useStore.getState().say(`${r.saved} flashcards saved — review them in Review`); setCards(null); }}>Save {cards.length} flashcards</button>
          </div>
        )}
        {quiz && <QuizRunner quiz={quiz} />}
      </div>
    </details>
  );
}

function QuizRunner({ quiz }: { quiz: { id: string; questions: any[] } }) {
  const [ans, setAns] = useState<Record<number, string>>({}); const [done, setDone] = useState(false);
  const correct = (q: any, a?: string) => (q.type === 'short' ? false : (a ?? '').trim().toLowerCase() === String(q.answer).trim().toLowerCase());
  const auto = quiz.questions.filter((q) => q.type !== 'short');
  const score = auto.filter((q) => correct(q, ans[quiz.questions.indexOf(q)])).length;
  return (
    <div className="space-y-3">
      {quiz.questions.map((q, i) => (
        <div key={i} className="card p-2.5 text-sm"><div className="font-medium">{i + 1}. {q.q}</div>
          {q.type === 'mcq' && <div className="mt-1.5 space-y-1">{q.options?.map((o: string) => <label key={o} className="flex gap-2 items-start"><input type="radio" name={`q${i}`} disabled={done} checked={ans[i] === o} onChange={() => setAns({ ...ans, [i]: o })} />{o}</label>)}</div>}
          {q.type === 'tf' && <div className="mt-1.5 flex gap-3">{['true', 'false'].map((o) => <label key={o} className="flex gap-1"><input type="radio" name={`q${i}`} disabled={done} checked={ans[i] === o} onChange={() => setAns({ ...ans, [i]: o })} />{o}</label>)}</div>}
          {q.type === 'short' && <textarea className="input mt-1.5" rows={2} disabled={done} value={ans[i] ?? ''} onChange={(e) => setAns({ ...ans, [i]: e.target.value })} />}
          {done && <div className="mt-2 text-xs">{q.type === 'short' ? <span>Model answer: {q.answer}</span> : correct(q, ans[i]) ? <span className="text-green-600">Correct</span> : <span style={{ color: 'var(--danger)' }}>Answer: {q.answer}</span>}<div className="text-[var(--ink3)]">{q.explanation} (p. {q.page})</div></div>}
        </div>
      ))}
      {!done ? <button className="btn btn-primary w-full justify-center" onClick={async () => { setDone(true); await post(`/quizzes/${quiz.id}/attempt`, { score, total: auto.length, answers: ans }); }}>Check answers</button>
        : <div className="text-sm font-medium">Score: {score} / {auto.length} auto-graded{quiz.questions.length > auto.length ? ' (short answers: self-assess)' : ''}</div>}
    </div>
  );
}

// ───────────────── Ask ─────────────────
interface Msg { role: 'user' | 'assistant'; content: string; citations?: Cit[]; model?: string; retrieval?: string; invalid?: number[] }
interface Cit { n: number; page_start: number; page_end: number; quote: string }
const PERSONAS = [['professor', 'Professor'], ['beginner', 'Beginner Teacher'], ['technical', 'Technical Expert'], ['socratic', 'Socratic Tutor'], ['critic', 'Critical Thinker'], ['business', 'Business Advisor'], ['exam', 'Exam Tutor']];
const QUICK = ['Explain this', 'Why is this important?', 'Give me an example', 'Challenge the author\'s argument', 'How does this connect to previous chapters?', 'Teach me this chapter', 'Give me practical applications', 'What am I misunderstanding?'];

function Ask({ book, page, goPage }: P) {
  const { selection } = useStore();
  const [persona, setPersona] = useState('professor');
  const [askLang, setAskLang] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]); const [input, setInput] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const conv = useRef<string | null>(null); const end = useRef<HTMLDivElement>(null); const abort = useRef<AbortController | null>(null);
  const [openCite, setOpenCite] = useState<Cit | null>(null);

  useEffect(() => {
    conv.current = null; setMsgs([]);
    api<any[]>(`/books/${book.id}/conversations`).then(async (l) => {
      if (!l[0]) return; conv.current = l[0].id; setPersona(l[0].persona ?? 'professor');
      const loaded = (await api<any[]>(`/conversations/${l[0].id}`)).map((m) => ({ role: m.role, content: m.content, citations: m.citations, model: m.model }));
      setMsgs((cur) => (cur.length ? cur : loaded)); // never clobber a question asked while history was loading
    }).catch(() => {});
  }, [book.id]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs]);
  // questions queued by the contextual suggestions / Inbox "Ask AI"
  const askQueue = useStore((s) => s.askQueue);
  useEffect(() => { if (askQueue && !busy) { const q = askQueue; useStore.getState().clearAsk(); setTimeout(() => void send(q), 250); } }, [askQueue]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setErr(null); setBusy(true); setInput('');
    setMsgs((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    const ac = new AbortController(); abort.current = ac;
    try {
      await ndjson('/ai/chat', { bookId: book.id, conversationId: conv.current, message: text, persona, page, selection: selection?.text, lang: askLang || undefined }, (e) => {
        if (e.type === 'meta') { conv.current = e.conversationId; setMsgs((m) => m.map((x, i) => i === m.length - 1 ? { ...x, citations: e.citations, model: e.model, retrieval: e.retrieval } : x)); }
        else if (e.type === 'delta') setMsgs((m) => m.map((x, i) => i === m.length - 1 ? { ...x, content: x.content + e.text } : x));
        else if (e.type === 'done') setMsgs((m) => m.map((x, i) => i === m.length - 1 ? { ...x, citations: x.citations?.filter((c) => e.cited.includes(c.n)), invalid: e.invalid } : x));
        else if (e.type === 'error') setErr(e.error);
      }, ac.signal);
    } catch (e: any) { if (e.name !== 'AbortError') { setErr(e.message); setMsgs((m) => m.slice(0, -1)); } }
    setBusy(false);
  }
  return (
    <div className="flex flex-col h-full -m-4">
      <div className="p-3 border-b border-[var(--line)] flex gap-2">
        <select className="input" value={persona} onChange={(e) => setPersona(e.target.value)} aria-label="Tutor personality">{PERSONAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select className="input !w-28" value={askLang} onChange={(e) => setAskLang(e.target.value)} aria-label="Answer language" title="Answer language (auto = the language you write in)"><option value="">Auto</option>{['en', 'te', 'ta', 'hi', 'kn', 'ml', 'bn', 'es', 'fr', 'de', 'ar', 'zh-Hans', 'ja'].map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <button className="btn" onClick={() => { conv.current = null; setMsgs([]); }}>New</button>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {msgs.length === 0 && (
          <div className="space-y-2"><p className="text-sm text-[var(--ink2)]">Ask anything about <b>{book.title}</b>. Answers are grounded in the book and cite pages; anything beyond the book is labelled.</p>
            <div className="flex flex-wrap gap-1.5">{QUICK.map((q) => <button key={q} className="chip hover:!bg-[var(--panel2)]" onClick={() => send(q)}>{q}</button>)}</div></div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-sm bg-[var(--panel2)] rounded-lg px-3 py-2 ml-6' : ''}>
            {m.role === 'user' ? m.content : (
              <div>
                {m.content ? <Md text={m.content} cites={new Set((m.citations ?? []).map((c) => c.n))} onCite={(n) => { const c = m.citations?.find((x) => x.n === n); if (c) setOpenCite(c); }} /> : <Spinner label="Thinking locally…" />}
                {m.citations && m.citations.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">{m.citations.map((c) => <button key={c.n} onClick={() => setOpenCite(c)} className="chip hover:!bg-[var(--panel2)]">[{c.n}] p. {c.page_start}{c.page_end !== c.page_start ? `–${c.page_end}` : ''}</button>)}</div>
                )}
                {m.invalid && m.invalid.length > 0 && <div className="text-[11px] mt-1" style={{ color: 'var(--danger)' }}>The model cited source(s) {m.invalid.join(', ')} that were not provided — ignore those.</div>}
                {m.model && m.content && <div className="text-[10px] text-[var(--ink3)] mt-1">{m.model}{m.retrieval ? ` · ${m.retrieval}` : ''}</div>}
              </div>
            )}
          </div>
        ))}
        {err && <AiError e={err} />}
        <div ref={end} />
      </div>
      {openCite && (
        <div className="mx-3 mb-2 card p-3 text-xs fade-in"><div className="flex justify-between mb-1"><b>Source [{openCite.n}] · p. {openCite.page_start}{openCite.page_end !== openCite.page_start ? `–${openCite.page_end}` : ''}</b><button onClick={() => setOpenCite(null)} aria-label="Close"><Icon n="x" size={12} /></button></div>
          <p className="text-[var(--ink2)] italic">“{openCite.quote}…”</p><button className="underline mt-1" onClick={() => goPage(openCite.page_start)}>Go to page</button></div>
      )}
      <div className="p-3 border-t border-[var(--line)]">
        {selection && <div className="text-[11px] text-[var(--ink3)] mb-1 truncate">Selected: “{selection.text}”</div>}
        <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="flex gap-2">
          <textarea className="input resize-none" rows={2} placeholder="Ask about this page, chapter or book…" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} aria-label="Question" />
          {busy ? <button type="button" className="btn" onClick={() => abort.current?.abort()}>Stop</button> : <button className="btn btn-primary" disabled={!input.trim()}>Send</button>}
        </form>
      </div>
    </div>
  );
}

// ───────────────── Word ─────────────────
function WordPanel({ book, page }: P) {
  const { selection, bump, say, setRightTab } = useStore();
  const raw = selection?.text ?? '';
  const isWord = raw.trim().split(/\s+/).length === 1;
  const [manual, setManual] = useState('');
  const word = (isWord ? raw : manual).replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '');
  const { data: dict, loading } = useFetch<any>(isWord && word ? `/define?word=${encodeURIComponent(word)}` : null, [word]);
  const [ai, setAi] = useState<any>(null); const [aiBusy, setAiBusy] = useState(false); const [aiErr, setAiErr] = useState<string | null>(null);
  const [tr, setTr] = useState<string | null>(null); const [lang, setLang] = useState('Spanish');
  const [pronNote, setPronNote] = useState('');
  useEffect(() => { setAi(null); setAiErr(null); setTr(null); setPronNote(''); }, [raw]);

  async function explain() {
    setAiBusy(true); setAiErr(null);
    try { setAi(await post('/ai/word', { word: isWord ? word : raw, sentence: selection?.sentence ?? '', mode: isWord ? 'word' : 'phrase' })); } catch (e: any) { setAiErr(e.message); } setAiBusy(false);
  }
  // auto-run contextual explanation if a model is available (silently ignore if not)
  useEffect(() => { if (selection && (isWord ? word : raw)) { setAi(null); void post('/ai/word', { word: isWord ? word : raw, sentence: selection.sentence, mode: isWord ? 'word' : 'phrase' }).then(setAi).catch(() => {}); } /* eslint-disable-next-line */ }, [raw]);

  const say1 = (accent: string) => { if (!speakWord(word, accent)) setPronNote(`No ${ACCENTS.find((a) => a.id === accent)?.label} voice is installed in this browser/OS.`); else setPronNote(''); };
  async function save() {
    const s = dict?.senses?.[0];
    await post('/vocab', { word, definition: s?.definition ?? ai?.contextual_meaning ?? '', ipa: dict?.ipa, pos: s?.pos, sentence: selection?.sentence, book_id: book.id, page });
    say(`Saved “${word}” to vocabulary`);
  }
  async function highlight() { if (!selection) return; await post(`/books/${book.id}/highlights`, { page: selection.page, text: selection.text, color: 'yellow', start: selection.start, end: selection.end }); bump(); say('Highlighted'); }
  async function flash() { await post('/cards', { cards: [{ front: `What does “${word}” mean?`, back: `${dict?.senses?.[0]?.definition ?? ai?.contextual_meaning ?? ''}${selection?.sentence ? `\n\n“${selection.sentence}”` : ''}`, book_id: book.id, page, kind: 'vocab', quote: selection?.sentence }] }); say('Flashcard created'); }

  if (!selection && !manual) return (
    <div className="space-y-4"><DiscoveryPanel book={book} page={page} /><p className="text-sm text-[var(--ink2)]">Or select a word or phrase in the book for its definition, IPA, pronunciation and meaning in context.</p>
      <form onSubmit={(e) => { e.preventDefault(); setManual((new FormData(e.currentTarget).get('w') as string).trim()); }} className="flex gap-2"><input name="w" className="input" placeholder="…or type a word" /><button className="btn">Look up</button></form></div>
  );

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline gap-2 flex-wrap"><h3 className="font-serif text-2xl">{isWord ? word : 'Phrase'}</h3>{dict?.ipa && <span className="text-[var(--ink2)]">{dict.ipa}</span>}{dict?.senses?.[0] && <span className="chip">{dict.senses[0].pos}</span>}</div>
        {!isWord && <p className="text-sm italic text-[var(--ink2)] mt-1 line-clamp-4">“{raw}”</p>}
        {!isWord && <p className="text-[11px] text-[var(--ink3)] mt-1">Saved to Notes automatically (see Settings → Reading capture).</p>}
      </div>
      {!isWord && <SelectionWords text={raw} book={book} page={page} />}
      {isWord && (
        <div>
          <div className="flex gap-1.5 flex-wrap items-center"><Icon n="sound" className="text-[var(--ink3)]" />
            {ACCENTS.map((a) => <button key={a.id} className="btn !py-1" onClick={() => say1(a.id)}>{a.label}</button>)}</div>
          {pronNote && <p className="text-[11px] mt-1" style={{ color: 'var(--danger)' }}>{pronNote}</p>}
          {dict?.ipa && <p className="text-[10px] text-[var(--ink3)] mt-1">{dict.pronunciationNote}</p>}
        </div>
      )}
      {isWord && (loading ? <Spinner label="Looking up offline dictionary…" /> : dict && !dict.found ? <p className="text-sm text-[var(--ink2)]">Not found in the offline dictionary (names, rare or inflected forms may be missing).</p> : dict?.senses?.length ? (
        <div className="space-y-3">
          {dict.senses.map((s: any, i: number) => (
            <div key={i} className="text-sm"><div><span className="text-[var(--ink3)] mr-1.5">{i + 1}. {s.pos}</span>{s.definition}</div>
              {s.examples[0] && <div className="text-[var(--ink2)] italic mt-0.5">“{s.examples[0]}”</div>}
              {s.synonyms.length > 0 && <div className="text-xs mt-0.5"><span className="label">Syn</span> {s.synonyms.join(', ')}</div>}
              {s.antonyms.length > 0 && <div className="text-xs"><span className="label">Ant</span> {s.antonyms.join(', ')}</div>}
              {s.related.length > 0 && i < 2 && <div className="text-xs text-[var(--ink3)]"><span className="label">Related</span> {s.related.join(', ')}</div>}
            </div>
          ))}
          {dict.family?.length > 0 && <div className="text-xs"><span className="label">Word family</span> {dict.family.map((f: string) => <button key={f} className="chip mr-1 hover:!bg-[var(--panel2)]" onClick={() => speakWord(f)} title="Listen">{f}</button>)}</div>}
          {dict.level && dict.level !== 'unknown' && <div className="text-xs"><span className="label">Difficulty</span> <span className="chip">{dict.level}</span></div>}
          <p className="text-[10px] text-[var(--ink3)]">{dict.source}</p>
        </div>
      ) : null)}

      <div className="border-t border-[var(--line)] pt-3">
        <div className="label mb-1">{isWord ? 'In this sentence (AI)' : 'Explained (AI)'}</div>
        {aiBusy && <Spinner />}
        {ai && !ai.error && (
          <div className="text-sm space-y-1.5">
            {ai.contextual_meaning && <p>{ai.contextual_meaning}</p>}
            {ai.simplified && <p><b>Simply:</b> {ai.simplified}</p>}
            {ai.idioms && <p><b>Idioms:</b> {ai.idioms}</p>}
            {ai.difficult_expressions && <p><b>Hard expressions:</b> {ai.difficult_expressions}</p>}
            {ai.grammar && <p><b>Grammar:</b> {ai.grammar}</p>}
            {ai.etymology && <p><b>Etymology (AI, unverified):</b> {ai.etymology}</p>}
            {Array.isArray(ai.examples) && ai.examples.length > 0 && <ul className="list-disc ml-4 text-[var(--ink2)]">{ai.examples.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>}
            {Array.isArray(ai.related) && ai.related.length > 0 && <p className="text-xs text-[var(--ink3)]">Related: {ai.related.join(', ')}</p>}
            <p className="text-[10px] text-[var(--ink3)]">{ai.model}</p>
          </div>
        )}
        {!ai && !aiBusy && <button className="btn" onClick={explain}>Explain with AI</button>}
        {aiErr && <AiError e={aiErr} />}
      </div>

      {isWord && selection && <WordTranslations word={word} sentence={selection.sentence ?? ''} bookId={book.id} page={page} />}
      <div className="flex flex-wrap gap-1.5 border-t border-[var(--line)] pt-3">
        {isWord && <button className="btn btn-primary" onClick={save}>Save word</button>}
        <button className="btn" onClick={highlight} disabled={!selection}>Highlight</button>
        <button className="btn" onClick={() => setRightTab('notes')}>Add note</button>
        {isWord && <button className="btn" onClick={flash}>Flashcard</button>}
        <button className="btn" onClick={() => { if (selection) void reader.play(book.id, selection.page, 'sentence', { engine: 'browser', startOffset: selection.start ?? 0 }); }}>Listen</button>
        <button className="btn" onClick={() => setRightTab('ask')}>Ask AI</button>
      </div>
      <div className="flex gap-2 items-center">
        <select className="input !w-auto" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Translate to">{['Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Chinese', 'Japanese', 'Hindi', 'Arabic', 'Russian'].map((l) => <option key={l}>{l}</option>)}</select>
        <button className="btn" onClick={async () => { setTr('…'); try { setTr((await post('/ai/translate', { text: raw || word, lang })).text); } catch (e: any) { setTr(null); setAiErr(e.message); } }}>Translate</button>
      </div>
      {tr && <p className="text-sm card p-2">{tr}</p>}
    </div>
  );
}

// ───────────────── Goal Lens ─────────────────
const SECTIONS: [string, string][] = [['concepts', 'Relevant concepts'], ['principles', 'Key principles'], ['applications', 'Practical applications'], ['frameworks', 'Frameworks'], ['terminology', 'Terminology'], ['examples', 'Examples'], ['lessons', 'Actionable lessons'], ['connections', 'Connections'], ['questions', 'Further questions'],
  ['definitions', 'Definitions'], ['formulas', 'Formulas & equations'], ['mentalModels', 'Mental models'], ['arguments', 'Arguments'], ['evidence', 'Evidence'], ['assumptions', 'Assumptions'], ['people', 'People'], ['processes', 'Processes & methods'], ['caseStudies', 'Case studies'], ['insights', 'Insights']];
const DEFAULT_TYPES = ['concepts', 'principles', 'applications', 'frameworks', 'terminology', 'examples', 'lessons', 'connections', 'questions'];

function GoalLens({ book, page }: P) {
  const { data: goals, reload } = useFetch<any[]>('/goals');
  const [form, setForm] = useState(false);
  const [results, setResults] = useState<Record<string, { extract?: any; model?: string; err?: string; busy?: boolean; saved?: number }>>({});
  const active = (goals ?? []).filter((g) => g.active);
  const [types, setTypes] = useState<string[]>(DEFAULT_TYPES);
  useEffect(() => { try { const t = JSON.parse(localStorage.getItem('folio.extractTypes') ?? 'null'); if (Array.isArray(t) && t.length) setTypes(t); } catch { /* */ } }, []);
  const toggleType = (k: string) => setTypes((t) => { const n = t.includes(k) ? t.filter((x) => x !== k) : [...t, k]; try { localStorage.setItem('folio.extractTypes', JSON.stringify(n)); } catch { /* */ } return n; });

  async function extract(g: any) {
    setResults((r) => ({ ...r, [g.id]: { busy: true } }));
    try { const x = await post('/ai/goal-extract', { bookId: book.id, goalId: g.id, page, types: types.length ? types : undefined }); setResults((r) => ({ ...r, [g.id]: { extract: x.extract, model: x.model } })); }
    catch (e: any) { setResults((r) => ({ ...r, [g.id]: { err: e.message } })); }
  }
  async function save(g: any) {
    const r = results[g.id]; if (!r?.extract) return;
    const x = await post(`/goals/${g.id}/save-extract`, { bookId: book.id, page, extract: r.extract });
    setResults((s) => ({ ...s, [g.id]: { ...r, saved: x.saved.length } })); reload(); useStore.getState().say(`${x.saved.length} items saved to your knowledge library`);
  }
  useEffect(() => { setResults({}); }, [page]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--ink2)]">Goal Lens reads this page <i>through</i> what you want to achieve. The same page gives different extracts for different goals.</p>
      <details className="text-xs"><summary className="cursor-pointer text-[var(--ink2)]">What to extract ({types.length})</summary>
        <div className="flex flex-wrap gap-1 mt-2">{SECTIONS.map(([k, l]) => <button key={k} onClick={() => toggleType(k)} className={`chip ${types.includes(k) ? '!bg-[var(--accent)] !text-[var(--accent-ink)]' : ''}`}>{l}</button>)}</div></details>
      {goals && active.length === 0 && !form && <div className="card p-4 text-sm text-center"><p className="mb-2">No active goals yet.</p><button className="btn btn-primary" onClick={() => setForm(true)}>Create your first goal</button></div>}
      {form && <GoalForm onDone={() => { setForm(false); reload(); }} />}
      {active.map((g) => {
        const r = results[g.id];
        return (
          <div key={g.id} className="card p-3 space-y-2">
            <div className="flex justify-between gap-2"><div><div className="font-medium text-sm">{g.title}</div><div className="text-[11px] text-[var(--ink3)]">{g.level}{g.deadline ? ` · by ${g.deadline}` : ''}</div></div>
              <button className="btn" disabled={r?.busy} onClick={() => extract(g)}>Extract p. {page}</button></div>
            {r?.busy && <Spinner label="Extracting for this goal…" />}
            {r?.err && <AiError e={r.err} />}
            {r?.extract && (
              <div className="space-y-2.5 text-sm fade-in">
                {SECTIONS.map(([k, label]) => { const items: any[] = r.extract[k] ?? []; if (!items.length) return null; return (
                  <div key={k}><div className="label mb-0.5">{label}</div>
                    <ul className="space-y-1">{items.map((it, i) => <li key={i} className="leading-snug">{typeof it === 'string' ? it : it.name ? <><b>{it.name}</b>{it.why ? ` — ${it.why}` : ''}{it.summary ? <span className="text-[var(--ink2)]"> {it.summary}</span> : null}</> : it.term ? <><b>{it.term}</b>: {it.meaning}</> : JSON.stringify(it)}</li>)}</ul></div>); })}
                <div className="flex gap-2 items-center"><button className="btn btn-primary" disabled={r.saved !== undefined} onClick={() => save(g)}>{r.saved !== undefined ? `Saved ${r.saved}` : 'Save to knowledge library'}</button><span className="text-[10px] text-[var(--ink3)]">{r.model} · from page {page}</span></div>
              </div>
            )}
          </div>
        );
      })}
      {active.length > 1 && <button className="btn w-full justify-center" onClick={async () => { for (const g of active) await extract(g); }}>Extract for all {active.length} active goals</button>}
      {!form && active.length > 0 && <button className="btn w-full justify-center" onClick={() => setForm(true)}><Icon n="plus" /> New goal</button>}
    </div>
  );
}

export function GoalForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ title: '', description: '', level: 'beginner', outcome: '', deadline: '' });
  return (
    <form className="card p-3 space-y-2" onSubmit={async (e) => { e.preventDefault(); if (!f.title.trim()) return; await post('/goals', f); onDone(); }}>
      <input className="input" placeholder="Goal (e.g. Build a successful startup)" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required aria-label="Goal title" />
      <textarea className="input" rows={2} placeholder="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} aria-label="Description" />
      <div className="flex gap-2"><select className="input" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} aria-label="Current level"><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option></select>
        <input type="date" className="input" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} aria-label="Deadline (optional)" /></div>
      <input className="input" placeholder="Desired outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} aria-label="Desired outcome" />
      <div className="flex gap-2 justify-end"><button type="button" className="btn" onClick={onDone}>Cancel</button><button className="btn btn-primary">Create goal</button></div>
    </form>
  );
}

// ───────────────── Notes ─────────────────
function NotesPanel({ book, page, annots, goPage }: P) {
  const { selection, bump } = useStore();
  const [body, setBody] = useState('');
  const quote = selection?.text;
  async function add() {
    if (!body.trim()) return;
    await post('/notes', { book_id: book.id, page, body: quote ? `> ${quote}\n\n${body}` : body, tags: '' });
    setBody(''); bump();
  }
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {quote && <div className="text-xs italic text-[var(--ink2)] border-l-2 border-[var(--accent)] pl-2 line-clamp-3">“{quote}”</div>}
        <textarea className="input" rows={3} placeholder={`Note on page ${page}…`} value={body} onChange={(e) => setBody(e.target.value)} aria-label="New note" />
        <button className="btn btn-primary" onClick={add} disabled={!body.trim()}>Add note</button>
      </div>
      <div className="space-y-2">
        {annots.notes.length === 0 && <p className="text-sm text-[var(--ink3)]">No notes in this book yet.</p>}
        {annots.notes.map((n: any) => (
          <div key={n.id} className={`card p-2.5 text-sm ${n.page === page ? 'ring-1 ring-[var(--accent)]' : ''}`}>
            <div className="flex items-center gap-1.5 mb-1"><span className="chip">{n.kind === 'selection' ? 'passage' : n.kind}</span>{n.source === 'ai' && <span className="chip">AI</span>}</div>
            {n.kind === 'selection' ? <p className="font-serif border-l-2 border-[var(--accent)] pl-2 whitespace-pre-wrap">{n.body}</p> : <Md text={n.body} />}
            <div className="flex justify-between gap-2 text-[10px] text-[var(--ink3)] mt-1.5">
              <button className="underline text-left" title="Return to this exact place in the book" onClick={() => n.page && useStore.getState().openAt(book.id, n.page, n.start_offset, n.end_offset, n.body)}>{[n.chapter_title, n.section && n.section !== n.chapter_title ? n.section : null, n.page ? `p. ${n.page}` : null].filter(Boolean).join(' · ') || '—'}</button>
              <button onClick={async () => { await api(`/notes/${n.id}`, { method: 'DELETE' }); bump(); }} aria-label="Delete note"><Icon n="trash" size={12} /></button></div></div>
        ))}
      </div>
    </div>
  );
}

// ───────────────── Audio ─────────────────
function AudioPanel({ book, page, text }: P) {
  const audio = useStore((s) => s.audio);
  const { data: status } = useFetch<any>('/status');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [scope, setScope] = useState<Scope>('book'); const [engine, setEngine] = useState<'browser' | 'piper'>('browser');
  const [accent, setAccent] = useState(''); const [voice, setVoice] = useState(''); const [rate, setRate] = useState(1); const [vol, setVol] = useState(1);
  const [sleep, setSleep] = useState(0); const [piperVoice, setPiperVoice] = useState('');
  const lastSaved = useRef(0);
  const [quiz, setQuiz] = useState(0); const [check, setCheck] = useState<{ page: number; offset: number; resolve: () => void } | null>(null);

  useEffect(() => {
    const load = () => setVoices(browserVoices().filter((v) => v.lang.toLowerCase().startsWith('en')));
    load(); speechSynthesis.addEventListener?.('voiceschanged', load); return () => speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, []);
  useEffect(() => { reader.accent = accent; reader.voice = voice; reader.rate = rate; reader.volume = vol; reader.piperVoice = piperVoice; }, [accent, voice, rate, vol, piperVoice]);
  useEffect(() => { try { const s = JSON.parse(localStorage.getItem('folio.audio') ?? '{}'); if (s.accent !== undefined) setAccent(s.accent); if (s.voice !== undefined) setVoice(s.voice); if (s.rate) setRate(s.rate); } catch { /* */ } }, []);
  useEffect(() => { try { localStorage.setItem('folio.audio', JSON.stringify({ accent, voice, rate })); } catch { /* */ } }, [accent, voice, rate]);

  function start(from?: number) {
    const sentence = from ?? 0;
    void reader.play(book.id, page, scope, {
      engine, startOffset: sentence,
      checkpoint: quiz > 0 ? { every: quiz, run: (pg, off) => new Promise<void>((resolve) => { setCheck({ page: pg, offset: off, resolve }); }) } : undefined,
      onPosition: (pg, off) => { if (Date.now() - lastSaved.current > 4000) { lastSaved.current = Date.now(); void api(`/books/${book.id}/progress`, { method: 'PUT', json: { page: pg, audio_page: pg, audio_sentence: off } }).catch(() => {}); } },
    });
  }
  const supported = typeof speechSynthesis !== 'undefined';
  const playing = audio.playing;

  return (
    <div className="space-y-4">
      <div className="card p-3 text-sm">
        <div className="flex items-center gap-2">
          <button className="btn btn-primary !rounded-full !w-10 !h-10 justify-center !p-0" onClick={() => (playing ? reader.pause() : audio.engine ? reader.resume() : start())} aria-label={playing ? 'Pause' : 'Play'} disabled={!supported && engine === 'browser'}><Icon n={playing ? 'pause' : 'play'} /></button>
          <button className="btn" onClick={() => { reader.stop(); start(); }}>From page start</button>
          <button className="btn" onClick={() => { reader.stop(); setCheck(null); }} aria-label="Stop"><Icon n="stop" size={14} /></button>
          <div className="ml-auto flex gap-1"><button className="btn" onClick={() => { reader.stop(); start(Math.max(0, (audio.sentence?.[1] ?? 0) + 1)); }} aria-label="Skip sentence">Skip ›</button></div>
        </div>
        <div className="text-[11px] text-[var(--ink3)] mt-2">{audio.engine ? `Playing with ${audio.engine === 'piper' ? 'Piper (local neural TTS)' : 'browser speech synthesis'}` : 'Idle'}{audio.page ? ` · page ${audio.page}` : ''}{audio.engine === 'browser' ? ' · word highlight active' : audio.engine === 'piper' ? ' · sentence highlight only' : ''}</div>
        {audio.sentence && audio.page === page && <p className="text-xs mt-2 text-[var(--ink2)] line-clamp-3">{text.slice(audio.sentence[0], audio.sentence[1])}</p>}
      </div>

      {check && <ListenCheck bookId={book.id} page={check.page} offset={check.offset} onDone={() => { check.resolve(); setCheck(null); }} />}
      <label className="block"><span className="label">Recall while listening</span>
        <select className="input mt-1" value={quiz} onChange={(e) => setQuiz(Number(e.target.value))}><option value={0}>Off</option><option value={6}>Pause every 6 sentences to test me</option><option value={12}>Pause every 12 sentences to test me</option><option value={25}>Pause every 25 sentences to test me</option></select>
        <span className="text-[11px] text-[var(--ink3)]">Applies the next time you press Play. Type your answer; playback resumes when you continue.</span></label>

      <label className="block"><span className="label">Read</span>
        <select className="input mt-1" value={scope} onChange={(e) => setScope(e.target.value as Scope)}><option value="sentence">One sentence</option><option value="paragraph">Paragraph</option><option value="page">Current page</option><option value="chapter">Current chapter</option><option value="book">Continue through the book</option></select></label>

      <div>
        <span className="label">Engine</span>
        <div className="flex gap-2 mt-1">
          <button className={`btn flex-1 justify-center ${engine === 'browser' ? 'btn-primary' : ''}`} onClick={() => setEngine('browser')}>Browser voice</button>
          <button className={`btn flex-1 justify-center ${engine === 'piper' ? 'btn-primary' : ''}`} disabled={!status?.piper} onClick={() => setEngine('piper')} title={status?.piper ? '' : 'Set PIPER_URL to enable'}>Piper</button>
        </div>
        <p className="text-[11px] text-[var(--ink3)] mt-1">{status?.piper ? 'Piper generates real audio locally and caches it on disk.' : 'Piper is not configured — see README to add higher-quality local voices. Browser speech is generated by your OS, not saved.'}</p>
      </div>
      {engine === 'browser' && (<>
        <label className="block"><span className="label">Accent</span><select className="input mt-1" value={accent} onChange={(e) => { setAccent(e.target.value); setVoice(''); }}>{ACCENTS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
        <label className="block"><span className="label">Voice ({voices.length} English available)</span><select className="input mt-1" value={voice} onChange={(e) => setVoice(e.target.value)}><option value="">Automatic</option>{voices.filter((v) => !accent || v.lang.replace('_', '-').toLowerCase() === accent.toLowerCase()).map((v) => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}</select></label>
      </>)}
      {engine === 'piper' && <label className="block"><span className="label">Piper voice id</span><input className="input mt-1" value={piperVoice} onChange={(e) => setPiperVoice(e.target.value)} placeholder="e.g. en_GB-alba-medium" /></label>}
      <label className="block"><span className="label">Speed {rate.toFixed(1)}×</span><input type="range" min={0.5} max={2.5} step={0.1} value={rate} onChange={(e) => setRate(Number(e.target.value))} className="w-full accent-[var(--accent)]" /></label>
      <label className="block"><span className="label">Volume</span><input type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => setVol(Number(e.target.value))} className="w-full accent-[var(--accent)]" /></label>
      <label className="block"><span className="label">Sleep timer</span>
        <select className="input mt-1" value={sleep} onChange={(e) => { const m = Number(e.target.value); setSleep(m); reader.setSleep(m, () => useStore.getState().say('Sleep timer: playback stopped')); }}><option value={0}>Off</option>{[5, 10, 15, 30, 45, 60].map((m) => <option key={m} value={m}>{m} min</option>)}</select></label>
      <div className="flex gap-2">
        <button className="btn" onClick={() => { const c = [...book.chapters].reverse().find((c) => c.start_page < page); if (c) { reader.stop(); useStore.getState().setPage(c.start_page); } }}>‹ Chapter</button>
        <button className="btn" onClick={() => { const c = book.chapters.find((c) => c.start_page > page); if (c) { reader.stop(); useStore.getState().setPage(c.start_page); } }}>Chapter ›</button>
      </div>
      {!supported && <ErrorNote error="This browser has no speech synthesis. Use Chrome, Edge or Safari, or configure Piper." />}
    </div>
  );
}

export { ApiError };
