'use client';
import { useEffect, useMemo, useState } from 'react';
import { post, api } from '@/lib/api';
import { useStore, type DiscWord } from '@/lib/store';
import { Icon, Md, Spinner, ErrorNote, useFetch } from '../ui';
import { speakWord } from '@/lib/tts';

const LEVEL_LABEL: Record<string, string> = { advanced: 'advanced', term: 'technical term', intermediate: 'intermediate', familiar: 'familiar', common: 'common', unknown: '' };

interface BookLite { id: string; page_count: number }

function WordRow({ w, checked, onCheck, onSave, onIgnore, onOpen }: { w: DiscWord; checked?: boolean; onCheck?: () => void; onSave: () => void; onIgnore?: () => void; onOpen?: () => void }) {
  return (
    <div className="py-2 border-b border-[var(--line)] last:border-0">
      <div className="flex items-center gap-2">
        {onCheck && <input type="checkbox" checked={!!checked} onChange={onCheck} aria-label={`Select ${w.word}`} />}
        <button className="font-serif text-base hover:underline" onClick={onOpen}>{w.word}</button>
        {w.ipa && <span className="text-xs text-[var(--ink3)]">{w.ipa}</span>}
        {LEVEL_LABEL[w.level] && <span className="chip">{LEVEL_LABEL[w.level]}</span>}
        <span className="ml-auto flex gap-0.5">
          <button className="btn btn-ghost !p-1" onClick={() => speakWord(w.word)} aria-label={`Pronounce ${w.word}`}><Icon n="sound" size={14} /></button>
          <button className="btn btn-ghost !px-1.5 !py-1 text-xs" onClick={onSave}>Save</button>
          {onIgnore && <button className="btn btn-ghost !p-1" onClick={onIgnore} aria-label={`I know ${w.word}`} title="I know this word"><Icon n="check" size={14} /></button>}
        </span>
      </div>
      {w.definition && <div className="text-xs text-[var(--ink2)] mt-0.5 ml-0.5">{w.pos ? <i>{w.pos}. </i> : null}{w.definition}</div>}
    </div>
  );
}

/** Words on the current page worth learning. Shown in the Word tab when nothing is selected. */
export function DiscoveryPanel({ book, page }: { book: BookLite; page: number }) {
  const { disc, setDisc, say, vocabHints, setVocabHints, go } = useStore();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [cards, setCards] = useState(false);
  const [ph, setPh] = useState<{ items: any[]; model: string } | null>(null); const [phBusy, setPhBusy] = useState(false); const [phErr, setPhErr] = useState<string | null>(null);
  useEffect(() => { setSel(new Set()); setPh(null); setPhErr(null); }, [page]);

  const save = async (words: DiscWord[]) => {
    if (!words.length) return;
    const r = await post('/vocab/bulk', { flashcards: cards, words: words.map((w) => ({ word: w.word, sentence: w.sentence, book_id: book.id, page })) });
    setDisc(disc.filter((d) => !words.some((w) => w.word === d.word)));
    setSel(new Set());
    say(`Saved ${r.saved} word${r.saved === 1 ? '' : 's'}${r.cards ? ` and ${r.cards} flashcards` : ''}`);
  };
  const open = (w: DiscWord) => useStore.getState().setSelection({ text: w.word, page, sentence: w.sentence });
  const ignore = async (w: DiscWord) => { await post('/vocab/ignore', { word: w.word }); setDisc(disc.filter((d) => d.word !== w.word)); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><div className="label">On this page</div><label className="text-[11px] text-[var(--ink3)] flex items-center gap-1.5"><input type="checkbox" checked={vocabHints} onChange={(e) => setVocabHints(e.target.checked)} />underline in text</label></div>
      {disc.length === 0 ? <p className="text-sm text-[var(--ink2)]">No unfamiliar vocabulary found on this page. Select any word or sentence for help.</p> : (
        <>
          <div>{disc.map((w) => <WordRow key={w.word} w={w} checked={sel.has(w.word)} onCheck={() => setSel((s) => { const n = new Set(s); n.has(w.word) ? n.delete(w.word) : n.add(w.word); return n; })} onSave={() => save([w])} onIgnore={() => ignore(w)} onOpen={() => open(w)} />)}</div>
          <div className="flex flex-wrap gap-1.5 items-center">
            <button className="btn btn-primary" onClick={() => save(disc.filter((d) => sel.has(d.word)))} disabled={!sel.size}>Save selected ({sel.size})</button>
            <button className="btn" onClick={() => save(disc)}>Save all {disc.length}</button>
            <label className="text-xs text-[var(--ink2)] flex items-center gap-1"><input type="checkbox" checked={cards} onChange={(e) => setCards(e.target.checked)} />+ flashcards</label>
          </div>
          <p className="text-[10px] text-[var(--ink3)]">Chosen by word rarity (WordNet frequency data), offline. Tick ✓ for words you already know — they won’t be suggested again.</p>
        </>
      )}
      <div className="border-t border-[var(--line)] pt-3">
        {!ph && !phBusy && <button className="btn" onClick={async () => { setPhBusy(true); setPhErr(null); try { setPh(await post('/ai/phrases', { bookId: book.id, page })); } catch (e: any) { setPhErr(e.message); } setPhBusy(false); }}>Find idioms & key terms (AI)</button>}
        {phBusy && <Spinner label="Reading the page…" />}{phErr && <ErrorNote error={phErr} />}
        {ph && (ph.items.length ? <div className="space-y-2">{ph.items.map((i, k) => <div key={k} className="text-sm"><b>{i.phrase}</b> <span className="chip">{i.kind}</span><div className="text-xs text-[var(--ink2)]">{i.meaning}</div></div>)}<div className="text-[10px] text-[var(--ink3)]">Phrases verified against the page text; meanings by {ph.model}.</div></div> : <p className="text-sm text-[var(--ink2)]">No idioms or special terms detected.</p>)}
      </div>
      <button className="underline text-xs text-[var(--ink2)]" onClick={() => go('review')}>Review words I’ve learned →</button>
    </div>
  );
}

/** Difficult words inside a selected sentence/passage. */
export function SelectionWords({ text, book, page }: { text: string; book: BookLite; page: number }) {
  const [words, setWords] = useState<DiscWord[] | null>(null); const say = useStore((s) => s.say);
  useEffect(() => { let live = true; setWords(null); post('/vocab/analyze', { text }).then((r) => live && setWords(r)).catch(() => live && setWords([])); return () => { live = false; }; }, [text]);
  if (!words) return <Spinner label="Checking vocabulary…" />;
  if (!words.length) return <p className="text-xs text-[var(--ink3)]">No difficult vocabulary in this selection.</p>;
  return (
    <div><div className="label mb-1">Difficult words here</div>
      {words.map((w) => <WordRow key={w.word} w={w} onSave={async () => { await post('/vocab/bulk', { words: [{ word: w.word, sentence: w.sentence, book_id: book.id, page }] }); say(`Saved “${w.word}” to Vocabulary`); }} onOpen={() => useStore.getState().setSelection({ text: w.word, page, sentence: w.sentence })} />)}
    </div>
  );
}

/** Contextual, not constant: a few relevant actions derived from the page and state. */
export function Suggestions({ text, page }: { text: string; page: number }) {
  const { selection, ask } = useStore();
  const items = useMemo(() => {
    const out: { label: string; prompt: string }[] = [];
    const sel = selection?.text;
    if (sel && sel.split(/\s+/).length > 2) {
      out.push({ label: 'What does this mean?', prompt: `What does this mean? "${sel.slice(0, 500)}"` });
      out.push({ label: 'Explain the difficult part', prompt: `Explain the difficult part of this passage in simpler terms: "${sel.slice(0, 500)}"` });
      out.push({ label: 'Why is this important?', prompt: `Why is this important? "${sel.slice(0, 500)}"` });
    }
    if (/\b(is defined as|refers to|is called|we define|is known as|means that)\b/i.test(text)) out.push({ label: 'What should I remember?', prompt: `What are the most important things to remember from page ${page}?` });
    if (/[=±×÷]|\b\d+(\.\d+)?\s?%|\bformula|equation|\bratio\b/i.test(text)) out.push({ label: 'Walk me through the numbers', prompt: `Walk me through the formulas or numbers on this page step by step.` });
    if (/\b(however|although|critics|argue[sd]?|claims?|assum(e|ption)|should|must)\b/i.test(text)) out.push({ label: 'What should I question?', prompt: `What assumptions or weak points should I question on this page?` });
    if (!/\b(for example|for instance|such as|consider)\b/i.test(text)) out.push({ label: 'Give me an example', prompt: `Give me a concrete example of the main idea on this page.` });
    out.push({ label: 'Connect this to another concept', prompt: `Connect the main idea of this page to another concept from earlier in the book.` });
    out.push({ label: 'Test my understanding', prompt: `Test my understanding of page ${page}. Ask me ONE question at a time, wait for my answer, then tell me whether I am right using the book text, and ask the next question.` });
    return [...new Map(out.map((o) => [o.label, o])).values()].slice(0, 4);
  }, [text, selection, page]);
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Suggestions">
      {items.map((s) => <button key={s.label} className="chip hover:!bg-[var(--panel2)] !text-[var(--ink)] text-left" onClick={() => ask(s.prompt)}>{s.label}</button>)}
    </div>
  );
}

const MODE_NAMES: Record<string, string> = { learning: 'Learning', deep: 'Deep understanding', critical: 'Critical thinking', exam: 'Exam', research: 'Research', language: 'Language learning' };

export function ModeAnalysis({ bookId, page }: { bookId: string; page: number }) {
  const mode = useStore((s) => s.readingMode);
  const [out, setOut] = useState<{ text: string; model: string } | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setOut(null); setErr(null); }, [page, mode]);
  if (mode === 'normal' || !MODE_NAMES[mode]) return null;
  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2"><div className="text-sm font-medium">{MODE_NAMES[mode]} mode</div>
        <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); setErr(null); try { setOut(await post('/ai/mode-analysis', { bookId, page, mode })); } catch (e: any) { setErr(e.message); } setBusy(false); }}>Analyse page {page}</button></div>
      {busy && <Spinner label="Analysing…" />}{err && <ErrorNote error={err} />}
      {out && <div><Md text={out.text} /><div className="text-[10px] text-[var(--ink3)] mt-2">{out.model} · based only on this page’s text</div></div>}
      {!out && !busy && !err && <p className="text-xs text-[var(--ink3)]">The document itself is unchanged; this only changes what the companion looks for. Switch back with the mode menu in the header.</p>}
    </div>
  );
}

export const _unused = api;
