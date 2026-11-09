'use client';
// The "aA" sheet from Apple Books: text size, theme, font, and how pages are laid out.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import { useEpubPrefs, type EpubFont } from '@/lib/epubPrefs';
import { FAMILIES } from '@/lib/readPrefs';
import { PAPER, type PaperTheme } from './EpubReader';

const FONTS: [EpubFont, string, string][] = [
  ['original', 'Original', 'inherit'], ['georgia', 'Georgia', FAMILIES.georgia.stack], ['palatino', 'Palatino', FAMILIES.palatino.stack],
  ['charter', 'Charter', FAMILIES.charter.stack], ['sans', 'System', FAMILIES.sans.stack], ['accessible', 'Verdana', FAMILIES.accessible.stack],
];
const THEMES: [PaperTheme, string][] = [['light', 'Original'], ['sepia', 'Paper'], ['dark', 'Quiet']];

export function EpubAppearance({ onOpen }: { onOpen?: (open: boolean) => void }) {
  const { prefs, setPrefs } = useStore(); const { p, set } = useEpubPrefs();
  const [open, setOpen] = useState(false); const box = useRef<HTMLDivElement>(null);
  useEffect(() => { onOpen?.(open); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', away); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key); };
  }, [open]);
  const pct = Math.round((prefs.size / 19) * 100);
  return (
    <div className="relative" ref={box}>
      <button className="btn btn-ghost" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" aria-label="Themes & settings" title="Themes & settings"><span className="font-serif leading-none"><span className="text-[11px]">A</span><span className="text-[17px]">A</span></span></button>
      {open && (
        <div role="dialog" aria-label="Themes & settings" className="absolute right-0 top-11 z-50 w-72 rounded-2xl border border-[var(--line)] bg-[var(--panel)] shadow-2xl p-3 space-y-3 fade-in">
          <div className="flex rounded-xl overflow-hidden border border-[var(--line)] divide-x divide-[var(--line)]">
            <button className="flex-1 py-2 text-[13px] hover:bg-[var(--panel2)] disabled:opacity-40" disabled={prefs.size <= 14} onClick={() => setPrefs({ size: Math.max(14, prefs.size - 1) })} aria-label="Smaller text">A</button>
            <div className="px-3 py-2 text-xs tabular-nums text-[var(--ink2)] grid place-items-center min-w-[3.5rem]">{pct}%</div>
            <button className="flex-1 py-2 text-[21px] leading-none hover:bg-[var(--panel2)] disabled:opacity-40" disabled={prefs.size >= 32} onClick={() => setPrefs({ size: Math.min(32, prefs.size + 1) })} aria-label="Larger text">A</button>
          </div>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
            {THEMES.map(([t, label]) => (
              <button key={t} role="radio" aria-checked={prefs.theme === t} onClick={() => setPrefs({ theme: t })} className="rounded-xl py-2.5 border-2 text-[12px] font-medium" style={{ background: PAPER[t].bg, color: PAPER[t].ink, borderColor: prefs.theme === t ? 'var(--accent)' : 'var(--line)' }}>
                <div className="font-serif text-lg leading-none mb-1">Aa</div>{label}
              </button>
            ))}
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-[var(--ink3)] mb-1 px-1">Font</div>
            <div className="rounded-xl border border-[var(--line)] overflow-hidden">
              {FONTS.map(([k, label, stack]) => (
                <button key={k} onClick={() => set({ font: k })} className="w-full flex items-center justify-between px-3 py-1.5 text-[15px] hover:bg-[var(--panel2)] border-b last:border-b-0 border-[var(--line)]" style={{ fontFamily: stack }}>
                  <span>{label}</span>{p.font === k && <span className="text-[var(--accent)] text-sm" aria-label="Selected">✓</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <button className={`rounded-xl border py-2 ${p.flow === 'paged' ? 'border-[var(--accent)] bg-[var(--panel2)]' : 'border-[var(--line)]'}`} onClick={() => set({ flow: 'paged' })}>Paged</button>
            <button className={`rounded-xl border py-2 ${p.flow === 'scroll' ? 'border-[var(--accent)] bg-[var(--panel2)]' : 'border-[var(--line)]'}`} onClick={() => set({ flow: 'scroll' })}>Scrolling</button>
          </div>
          {p.flow === 'paged' && <label className="flex items-center justify-between text-[13px] px-1">Two pages on wide windows<input type="checkbox" checked={p.twoPage} onChange={(e) => set({ twoPage: e.target.checked })} className="accent-[var(--accent)]" /></label>}
        </div>
      )}
    </div>
  );
}
