'use client';
// Instant meaning for a clicked/selected word: a small card under the word, filled from the offline dictionary (cached, pre-fetched on selection).
import { useEffect, useState } from 'react';
import { api, post } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Icon } from '../ui';

const cache = new Map<string, Promise<any>>();
export const defineWord = (w: string) => {
  const k = w.toLowerCase(); let p = cache.get(k);
  if (!p) { p = api<any>(`/define?word=${encodeURIComponent(k)}`).catch((e) => { cache.delete(k); throw e; }); cache.set(k, p); if (cache.size > 400) cache.delete(cache.keys().next().value as string); }
  return p;
};

export function cleanWord(raw: string) { return raw.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, ''); }

export function WordPop({ word, rect, bookId, page, sentence, onMore, onClose }: { word: string; rect: { x: number; y: number; w: number; h: number }; bookId: string; page: number; sentence?: string; onMore: () => void; onClose: () => void }) {
  const [d, setD] = useState<any>(null); const [err, setErr] = useState(false); const say = useStore((s) => s.say);
  useEffect(() => { let live = true; setD(null); setErr(false); defineWord(word).then((x) => live && setD(x)).catch(() => live && setErr(true)); return () => { live = false; }; }, [word]);
  const s0 = d?.senses?.[0], s1 = d?.senses?.[1];
  const left = Math.max(8, Math.min(rect.x - 170, window.innerWidth - 348));
  const below = rect.y + rect.h + 10, top = below + 190 > window.innerHeight ? Math.max(8, rect.y - 200) : below;
  const listen = () => { try { const u = new SpeechSynthesisUtterance(word); u.lang = 'en-US'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch { /* */ } };
  return (
    <div className="fixed z-40 card p-3 w-[340px] shadow-xl fade-in text-sm" style={{ left, top }} onMouseDown={(e) => e.preventDefault()} role="dialog" aria-label={`Meaning of ${word}`}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-serif text-xl">{word}</span>
        {d?.ipa && <span className="text-[var(--ink2)] text-xs">{d.ipa}</span>}
        {s0 && <span className="chip">{s0.pos}</span>}
        <span className="flex-1" />
        <button className="btn btn-ghost !px-1.5 !py-0.5" onClick={listen} aria-label="Listen"><Icon n="sound" size={14} /></button>
        <button className="btn btn-ghost !px-1.5 !py-0.5" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {!d && !err && <div className="mt-2 space-y-1.5 animate-pulse"><div className="h-3 rounded bg-[var(--panel2)] w-11/12" /><div className="h-3 rounded bg-[var(--panel2)] w-8/12" /></div>}
      {err && <p className="mt-2 text-xs text-[var(--ink2)]">Couldn’t look that up.</p>}
      {d && !d.found && <p className="mt-2 text-xs text-[var(--ink2)]">Not in the offline dictionary (names, rare or inflected forms may be missing).</p>}
      {s0 && <p className="mt-1.5 leading-snug">{s0.definition}{s0.examples?.[0] && <span className="block text-xs italic text-[var(--ink2)] mt-1">“{s0.examples[0]}”</span>}</p>}
      {s1 && <p className="mt-1.5 text-xs text-[var(--ink2)] leading-snug"><span className="chip mr-1">{s1.pos}</span>{s1.definition}</p>}
      <div className="flex gap-1.5 mt-2.5">
        <button className="btn !py-1 text-xs" onClick={async () => { await post('/vocab', { word: word.toLowerCase(), definition: s0?.definition ?? '', ipa: d?.ipa, pos: s0?.pos, sentence, book_id: bookId, page }); say(`Saved “${word}” to vocabulary`); }}>Save word</button>
        <button className="btn btn-ghost !py-1 text-xs" onClick={onMore}>More ▸</button>
      </div>
    </div>
  );
}
