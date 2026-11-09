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

export function TextPage({ page, text, highlights, onSelect, onHighlightClick, searchTerm, hints, jump, onHintClick, base = 0, fullText, skim }: {
  page: number; text: string; base?: number; fullText?: string; skim?: boolean; highlights: Hl[]; searchTerm?: string; hints?: Hint[]; jump?: JumpT | null;
  onHintClick?: (word: string, sentence: string, rect: DOMRect) => void;
  onSelect: (sel: { text: string; start: number; end: number; sentence: string; rect: DOMRect } | null) => void;
  onHighlightClick: (id: string, rect: DOMRect) => void;
}) {
  const audio = useStore((s) => s.audio);
  const root = useRef<HTMLDivElement>(null);
  const speaking = audio.page === page && audio.playing;
  const [flash, setFlash] = useState(false);
  useEffect(() => { if (!jump) return; setFlash(true); const t = setTimeout(() => setFlash(false), 3500); return () => clearTimeout(t); }, [jump?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const full = fullText ?? text;
  const marks = useMemo(() => {
    const m: Mark[] = [];
    for (const h of highlights) {
      let s = h.start_offset == null ? null : h.start_offset - base, e = h.end_offset == null ? null : h.end_offset - base;
      if (s == null || e == null || s < 0 || e > text.length || text.slice(s, e) !== h.text) { const i = text.indexOf(h.text); if (i < 0) continue; s = i; e = i + h.text.length; }
      m.push({ s, e, cls: `hl hl-${h.color}`, hid: h.id });
    }
    if (searchTerm && searchTerm.length > 1) {
      const lt = text.toLowerCase(), q = searchTerm.toLowerCase(); let i = -1;
      while ((i = lt.indexOf(q, i + 1)) >= 0) m.push({ s: i, e: i + q.length, cls: 'search-hit' });
    }
    for (const h of hints ?? []) { const hs = h.start - base, he = h.end - base; if (hs >= 0 && he <= text.length && text.slice(hs, he).toLowerCase() === h.word.toLowerCase()) m.push({ s: hs, e: he, cls: 'vhint', hint: h.word }); }
    if (flash && jump) {
      let s = jump.start == null ? -1 : jump.start - base, e = jump.end == null ? -1 : jump.end - base;
      if ((s < 0 || e <= s || (jump.text && text.slice(s, e).replace(/\s+/g, ' ').trim() !== jump.text.replace(/\s+/g, ' ').trim())) && jump.text) { const i = text.indexOf(jump.text); if (i >= 0) { s = i; e = i + jump.text.length; } }
      if (s >= 0 && e > s) m.push({ s, e, cls: 'jump-flash' });
    }
    if (skim) { // skim reading: the first sentence of every paragraph stays at full strength, the rest is softened (never hidden)
      let pos = 0;
      for (const line of text.split('\n')) {
        const st = pos, en = pos + line.length; pos = en + 1; if (line.trim().length < 90) continue;
        const mt = /[.!?]["'”’)\]]*\s+(?=\S)/.exec(line.slice(24)); if (!mt) continue; const rest = st + 24 + mt.index + mt[0].length; if (rest < en) m.push({ s: rest, e: en, cls: 'skim-rest' });
      }
    }
    const clip = (r: [number, number]) => ({ s: Math.max(0, r[0] - base), e: Math.min(text.length, r[1] - base) });
    if (audio.page === page && audio.sentence) { const r = clip(audio.sentence); if (r.e > r.s) m.push({ ...r, cls: 'speak-sentence' }); }
    if (audio.page === page && audio.word) { const r = clip(audio.word); if (r.e > r.s) m.push({ ...r, cls: 'speak-word' }); }
    return m;
  }, [highlights, text, base, skim, audio.page, audio.sentence, audio.word, page, searchTerm, hints, flash, jump]);

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

  // a plain click on a word picks it (no need to drag-select) so its meaning shows at once
  function pickWord(e: React.MouseEvent) {
    if (window.getSelection()?.toString() || (e.target as HTMLElement).closest('.hl, .vhint')) return;
    const d = document as any; let node: Node | null = null, off = 0;
    if (d.caretPositionFromPoint) { const p = d.caretPositionFromPoint(e.clientX, e.clientY); node = p?.offsetNode ?? null; off = p?.offset ?? 0; }
    else if (d.caretRangeFromPoint) { const r = d.caretRangeFromPoint(e.clientX, e.clientY); node = r?.startContainer ?? null; off = r?.startOffset ?? 0; }
    if (!node || node.nodeType !== 3 || !root.current?.contains(node)) return;
    const s = node.textContent ?? ''; let a = off, b = off; const isW = (ch: string) => /[\p{L}\p{N}'’-]/u.test(ch);
    while (a > 0 && isW(s[a - 1])) a--; while (b < s.length && isW(s[b])) b++;
    const el = (node.parentElement)?.closest('[data-s]') as HTMLElement | null; if (b <= a || !el) return;
    const st = Number(el.dataset.s) + a, en = Number(el.dataset.s) + b;
    const range = document.createRange(); range.setStart(node, a); range.setEnd(node, b);
    const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
    onSelect({ text: s.slice(a, b), start: st + base, end: en + base, sentence: sentenceAt(full, st + base, en + base), rect: range.getBoundingClientRect() });
  }

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
    onSelect({ text: text.slice(a, b).replace(/\s+/g, ' ').trim() || str, start: a + base, end: b + base, sentence: sentenceAt(full, a + base, b + base), rect: r.getBoundingClientRect() });
  }

  return (
    <div ref={root} onMouseUp={handleUp} onClick={pickWord} onKeyUp={(e) => e.shiftKey && handleUp()} className="prose-book" data-page={page}>
      {paras.map((p) => (
        <p key={p.start}>
          {p.segs.map((sg) => (
            <span key={sg.s} data-s={sg.s} className={sg.cls || undefined} onClick={sg.hid ? (e) => onHighlightClick(sg.hid!, (e.target as HTMLElement).getBoundingClientRect()) : sg.hint && onHintClick ? (e) => { if (!window.getSelection()?.toString()) onHintClick(sg.hint!, sentenceAt(full, sg.s + base, sg.e + base), (e.target as HTMLElement).getBoundingClientRect()); } : undefined} style={sg.cls.includes('search-hit') ? { outline: '2px solid var(--accent)', borderRadius: 2 } : undefined}>{text.slice(sg.s, sg.e)}</span>
          ))}
        </p>
      ))}
    </div>
  );
}
