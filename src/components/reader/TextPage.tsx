'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import { splitSentences } from '@/lib/tts';

export interface Hl { id: string; start_offset: number | null; end_offset: number | null; color: string; text: string; note?: string | null }

interface Mark { s: number; e: number; cls: string; hid?: string; hint?: string }
export interface Hint { start: number; end: number; word: string }
export interface JumpT { start?: number | null; end?: number | null; text?: string; nonce: number }

export function sentenceAt(text: string, a: number, b: number): string {
  const ss = splitSentences(text);
  const m = ss.find((s) => s.end > a && s.start <= Math.max(a, b - 1));
  return (m?.text ?? text.slice(Math.max(0, a - 120), b + 120)).slice(0, 600);
}

export function TextPage({ page, text, highlights, onSelect, onHighlightClick, searchTerm, hints, jump, onHintClick }: {
  page: number; text: string; highlights: Hl[]; searchTerm?: string; hints?: Hint[]; jump?: JumpT | null;
  onHintClick?: (word: string, sentence: string, rect: DOMRect) => void;
  onSelect: (sel: { text: string; start: number; end: number; sentence: string; rect: DOMRect } | null) => void;
  onHighlightClick: (id: string, rect: DOMRect) => void;
}) {
  const audio = useStore((s) => s.audio);
  const root = useRef<HTMLDivElement>(null);
  const speaking = audio.page === page && audio.playing;
  const [flash, setFlash] = useState(false);
  useEffect(() => { if (!jump) return; setFlash(true); const t = setTimeout(() => setFlash(false), 3500); return () => clearTimeout(t); }, [jump?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const marks = useMemo(() => {
    const m: Mark[] = [];
    for (const h of highlights) {
      let s = h.start_offset, e = h.end_offset;
      if (s == null || e == null || text.slice(s, e) !== h.text) { const i = text.indexOf(h.text); if (i < 0) continue; s = i; e = i + h.text.length; }
      m.push({ s, e, cls: `hl hl-${h.color}`, hid: h.id });
    }
    if (searchTerm && searchTerm.length > 1) {
      const lt = text.toLowerCase(), q = searchTerm.toLowerCase(); let i = -1;
      while ((i = lt.indexOf(q, i + 1)) >= 0) m.push({ s: i, e: i + q.length, cls: 'search-hit' });
    }
    for (const h of hints ?? []) if (h.end <= text.length && text.slice(h.start, h.end).toLowerCase() === h.word.toLowerCase()) m.push({ s: h.start, e: h.end, cls: 'vhint', hint: h.word });
    if (flash && jump) {
      let s = jump.start ?? -1, e = jump.end ?? -1;
      if ((s < 0 || e <= s || (jump.text && text.slice(s, e).replace(/\s+/g, ' ').trim() !== jump.text.replace(/\s+/g, ' ').trim())) && jump.text) { const i = text.indexOf(jump.text); if (i >= 0) { s = i; e = i + jump.text.length; } }
      if (s >= 0 && e > s) m.push({ s, e, cls: 'jump-flash' });
    }
    if (audio.page === page && audio.sentence) m.push({ s: audio.sentence[0], e: audio.sentence[1], cls: 'speak-sentence' });
    if (audio.page === page && audio.word) m.push({ s: audio.word[0], e: audio.word[1], cls: 'speak-word' });
    return m;
  }, [highlights, text, audio.page, audio.sentence, audio.word, page, searchTerm, hints, flash, jump]);

  const paras = useMemo(() => {
    const out: { start: number; end: number; segs: { s: number; e: number; cls: string; hid?: string; hint?: string }[] }[] = [];
    let pos = 0;
    for (const line of text.split('\n')) {
      const start = pos, end = pos + line.length; pos = end + 1;
      if (!line.trim()) continue;
      const pts = new Set([start, end]);
      for (const m of marks) { if (m.e > start && m.s < end) { pts.add(Math.max(start, m.s)); pts.add(Math.min(end, m.e)); } }
      const sorted = [...pts].sort((a, b) => a - b);
      const segs: { s: number; e: number; cls: string; hid?: string; hint?: string }[] = [];
      for (let i = 0; i < sorted.length - 1; i++) {
        const [s, e] = [sorted[i], sorted[i + 1]];
        const cover = marks.filter((m) => m.s <= s && m.e >= e);
        const hid = cover.find((m) => m.hid)?.hid;
        const hint = cover.find((m) => m.hint)?.hint;
        segs.push({ s, e, cls: cover.map((c) => c.cls).join(' '), hid, hint });
      }
      out.push({ start, end, segs });
    }
    return out;
  }, [text, marks]);

  useEffect(() => { if (flash) root.current?.querySelector('.jump-flash')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [flash]);

  // keep spoken sentence in view
  useEffect(() => {
    if (!speaking) return;
    root.current?.querySelector('.speak-word, .speak-sentence')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [speaking, audio.sentence]);

  function handleUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !root.current || !root.current.contains(sel.anchorNode)) return onSelect(null);
    const str = sel.toString().replace(/\s+/g, ' ').trim();
    if (!str) return onSelect(null);
    const r = sel.getRangeAt(0);
    const off = (n: Node, o: number) => {
      const el = (n.nodeType === 3 ? n.parentElement : (n as Element))?.closest('[data-s]') as HTMLElement | null;
      return el && n.nodeType === 3 ? Number(el.dataset.s) + o : null;
    };
    let a = off(r.startContainer, r.startOffset), b = off(r.endContainer, r.endOffset);
    if (a == null || b == null || b <= a) { const i = text.indexOf(str); if (i < 0) { a = 0; b = 0; } else { a = i; b = i + str.length; } }
    onSelect({ text: text.slice(a, b).replace(/\s+/g, ' ').trim() || str, start: a, end: b, sentence: sentenceAt(text, a, b), rect: r.getBoundingClientRect() });
  }

  return (
    <div ref={root} onMouseUp={handleUp} onKeyUp={(e) => e.shiftKey && handleUp()} className="prose-book" data-page={page}>
      {paras.map((p) => (
        <p key={p.start}>
          {p.segs.map((sg) => (
            <span key={sg.s} data-s={sg.s} className={sg.cls || undefined} onClick={sg.hid ? (e) => onHighlightClick(sg.hid!, (e.target as HTMLElement).getBoundingClientRect()) : sg.hint && onHintClick ? (e) => { if (!window.getSelection()?.toString()) onHintClick(sg.hint!, sentenceAt(text, sg.s, sg.e), (e.target as HTMLElement).getBoundingClientRect()); } : undefined} style={sg.cls.includes('search-hit') ? { outline: '2px solid var(--accent)', borderRadius: 2 } : undefined}>{text.slice(sg.s, sg.e)}</span>
          ))}
        </p>
      ))}
    </div>
  );
}
