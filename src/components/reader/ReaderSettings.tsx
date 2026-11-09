'use client';
// All reading settings in one place. Every control updates the page immediately and is saved; each section can be reset on its own.
import { useEffect, useState } from 'react';
import { useStore } from '@/lib/store';
import { useRead, FAMILIES, DEFAULTS, type ReadPrefs, type Family } from '@/lib/readPrefs';
import { Icon } from '../ui';

const TABS = [['text', 'Text'], ['layout', 'Page'], ['theme', 'Theme'], ['focus', 'Focus'], ['habit', 'Habit'], ['keys', 'Keys']] as const;
type Tab = (typeof TABS)[number][0];

function Row({ label, value, children, onReset }: { label: string; value?: string; children: React.ReactNode; onReset?: () => void }) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-xs text-[var(--ink2)]"><span>{label}{value ? <span className="text-[var(--ink3)]"> · {value}</span> : null}</span>{onReset && <button type="button" className="text-[10px] text-[var(--ink3)] hover:text-[var(--ink)] underline-offset-2 hover:underline" onClick={onReset}>reset</button>}</span>
      {children}
    </label>
  );
}
const Seg = <T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) => (
  <div className="flex gap-1" role="group" aria-label={label}>{options.map(([v, l]) => <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={`btn flex-1 justify-center !px-2 !py-1 text-xs ${value === v ? 'btn-primary' : ''}`}>{l}</button>)}</div>
);

export function ReaderSettings({ isPdf, zoom, setZoom, bookId, onCalibrate, onOpen }: { isPdf: boolean; zoom: number; setZoom: (z: number) => void; bookId: string; onCalibrate: () => void; onOpen?: (o: boolean) => void }) {
  const { prefs, setPrefs } = useStore(); const { p, set, reset, scope, setScope } = useRead();
  const [open, setOpen] = useState(false); const [tab, setTab] = useState<Tab>('text');
  useEffect(() => { onOpen?.(open); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = () => setOpen((o) => !o); window.addEventListener('folio:settings', t); return () => window.removeEventListener('folio:settings', t); }, []);
  const R = (k: keyof ReadPrefs) => () => reset([k]);
  const cpl = Math.round(Math.min(prefs.width, 2000) / (prefs.size * 0.5)); // rough characters per line in single-page layout

  return (
    <div className="relative">
      <button className="btn btn-ghost" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" aria-label="Reading settings (t)" title="Reading settings (t)"><Icon n="type" /></button>
      {open && (
        <div role="dialog" aria-label="Reading settings" className="absolute right-0 top-10 z-50 card w-[22rem] max-w-[92vw] shadow-xl fade-in text-sm flex flex-col max-h-[80vh]">
          <div className="flex border-b border-[var(--line)] text-xs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`flex-1 py-2.5 ${tab === k ? 'font-semibold border-b-2 border-[var(--accent)]' : 'text-[var(--ink2)]'}`}>{l}</button>)}</div>
          <div className="p-4 space-y-3 overflow-auto">
            {tab === 'text' && (isPdf ? (
              <Row label="Zoom" value={`${Math.round(zoom * 100)}%`}><input type="range" min={0.6} max={2} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-full accent-[var(--accent)]" /></Row>
            ) : (<>
              <Row label="Font" onReset={R('family')}><select className="input !py-1" value={p.family} onChange={(e) => set({ family: e.target.value as Family })}>{(Object.keys(FAMILIES) as Family[]).map((f) => <option key={f} value={f}>{FAMILIES[f].label}</option>)}</select></Row>
              <Row label="Size" value={`${prefs.size}px`}><input type="range" min={14} max={32} value={prefs.size} onChange={(e) => setPrefs({ size: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <Row label="Weight" value={String(p.weight)} onReset={R('weight')}><input type="range" min={300} max={700} step={100} value={p.weight} onChange={(e) => set({ weight: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <Row label="Line height" value={prefs.lineHeight.toFixed(2)}><input type="range" min={1.2} max={2.4} step={0.05} value={prefs.lineHeight} onChange={(e) => setPrefs({ lineHeight: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <Row label="Letter spacing" value={`${(p.letterSpacing / 100).toFixed(2)}em`} onReset={R('letterSpacing')}><input type="range" min={-3} max={12} step={1} value={p.letterSpacing} onChange={(e) => set({ letterSpacing: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <Row label="Word spacing" value={`${(p.wordSpacing / 100).toFixed(2)}em`} onReset={R('wordSpacing')}><input type="range" min={0} max={40} step={2} value={p.wordSpacing} onChange={(e) => set({ wordSpacing: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <Row label="Paragraph spacing" value={`${p.paraSpacing.toFixed(1)}em`} onReset={R('paraSpacing')}><input type="range" min={0} max={2} step={0.1} value={p.paraSpacing} onChange={(e) => set({ paraSpacing: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <Row label="Alignment"><Seg label="Alignment" value={p.align} options={[['left', 'Left'], ['justify', 'Justified']]} onChange={(v) => set({ align: v })} /></Row>
              <label className="flex items-center justify-between text-xs text-[var(--ink2)]"><span>Automatic hyphenation <span className="text-[var(--ink3)]">(needs hyphenation dictionaries on your system)</span></span><input type="checkbox" checked={p.hyphens} onChange={(e) => set({ hyphens: e.target.checked })} className="accent-[var(--accent)]" /></label>
            </>))}

            {tab === 'layout' && (<>
              <Row label="Layout"><Seg label="Layout" value={p.layout} options={[['book', 'Two pages'], ['page', 'One page'], ['scroll', 'Scroll']]} onChange={(v) => set({ layout: v })} /></Row>
              <Row label="Page margins" value={`${p.margin}px`} onReset={R('margin')}><input type="range" min={18} max={90} step={2} value={p.margin} onChange={(e) => set({ margin: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <Row label="Page width (two pages)" value={`${p.maxPageWidth}px`} onReset={R('maxPageWidth')}><input type="range" min={360} max={760} step={10} value={p.maxPageWidth} onChange={(e) => set({ maxPageWidth: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <Row label="Text column width (one page / scroll)" value={`${prefs.width}px · ≈${cpl} characters per line`}><input type="range" min={360} max={1000} step={20} value={prefs.width} onChange={(e) => setPrefs({ width: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <p className="text-[11px] text-[var(--ink3)]">Comfortable reading is usually 55–70 characters per line.</p>
              <Row label="Page turn" onReset={R('motion')}><Seg label="Page turn" value={p.motion} options={[['physics', 'Paper'], ['simple', 'Quick'], ['none', 'None']]} onChange={(v) => set({ motion: v })} /></Row>
              <label className="flex items-center justify-between text-xs text-[var(--ink2)]"><span>Click the page edge to turn <span className="text-[var(--ink3)]">(turn off to avoid accidental taps; arrows and swipes still work)</span></span><input type="checkbox" checked={p.tapZones} onChange={(e) => set({ tapZones: e.target.checked })} className="accent-[var(--accent)]" /></label>
              <label className="flex items-center justify-between text-xs text-[var(--ink2)]"><span>Hide controls while reading</span><input type="checkbox" checked={p.autoHide} onChange={(e) => set({ autoHide: e.target.checked })} className="accent-[var(--accent)]" /></label>
            </>)}

            {tab === 'theme' && (<>
              <div className="flex gap-1" role="group" aria-label="Theme">{(['light', 'sepia', 'dark'] as const).map((t) => <button key={t} onClick={() => setPrefs({ theme: t })} aria-pressed={prefs.theme === t} className={`btn flex-1 justify-center ${prefs.theme === t ? 'btn-primary' : ''}`}>{t === 'light' ? 'ivory' : t}</button>)}</div>
              <div className="grid grid-cols-2 gap-2">
                <Row label="Page colour"><input type="color" value={p.customBg || '#fbf7ee'} onChange={(e) => set({ customBg: e.target.value })} className="w-full h-8 rounded border border-[var(--line)] bg-transparent" aria-label="Page colour" /></Row>
                <Row label="Text colour"><input type="color" value={p.customInk || '#1d1c1a'} onChange={(e) => set({ customInk: e.target.value })} className="w-full h-8 rounded border border-[var(--line)] bg-transparent" aria-label="Text colour" /></Row>
              </div>
              <button className="btn text-xs" onClick={() => reset(['customBg', 'customInk'])}>Use theme colours</button>
              <Row label="Brightness" value={`${Math.round(p.brightness * 100)}%`} onReset={R('brightness')}><input type="range" min={0.35} max={1} step={0.01} value={p.brightness} onChange={(e) => set({ brightness: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <p className="text-[11px] text-[var(--ink3)]">Brightness dims the reader on screen; it does not change your device’s backlight.</p>
            </>)}

            {tab === 'focus' && (<>
              <Row label="Spotlight"><Seg label="Spotlight shape" value={p.spotKind} options={[['line', 'Lines'], ['paragraph', 'Paragraph']]} onChange={(v) => set({ spotKind: v })} /></Row>
              {p.spotKind === 'line' && <Row label="Spotlight height" value={`${p.spotSize} line${p.spotSize === 1 ? '' : 's'}`} onReset={R('spotSize')}><input type="range" min={1} max={6} value={p.spotSize} onChange={(e) => set({ spotSize: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>}
              <Row label="Dimming" value={`${Math.round(p.spotDim * 100)}%`} onReset={R('spotDim')}><input type="range" min={0.2} max={0.9} step={0.05} value={p.spotDim} onChange={(e) => set({ spotDim: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <hr className="border-[var(--line)]" />
              <label className="flex items-center justify-between text-xs"><span>Reading pacer <span className="text-[var(--ink3)]">(p)</span></span><input type="checkbox" checked={p.pacer} onChange={(e) => set({ pacer: e.target.checked })} className="accent-[var(--accent)]" /></label>
              <Row label="Pace" value={`${p.wpm} words/min`} onReset={R('wpm')}><input type="range" min={100} max={900} step={10} value={p.wpm} onChange={(e) => set({ wpm: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <div className="flex gap-1">{[['Relaxed', 180], ['Steady', 250], ['Brisk', 350], ['Fast', 500]].map(([l, v]) => <button key={l} className={`btn flex-1 justify-center !px-1 !py-1 text-[11px] ${p.wpm === v ? 'btn-primary' : ''}`} onClick={() => set({ wpm: v as number })}>{l}</button>)}</div>
              <Row label="Guide"><Seg label="Guide" value={p.guide} options={[['underline', 'Underline'], ['line', 'Line'], ['band', 'Band']]} onChange={(v) => set({ guide: v })} /></Row>
              <label className="flex items-center justify-between text-xs"><span>Turn the page automatically at the end</span><input type="checkbox" checked={p.autoTurn} onChange={(e) => set({ autoTurn: e.target.checked })} className="accent-[var(--accent)]" /></label>
              <button className="btn text-xs w-full justify-center" onClick={() => { setOpen(false); onCalibrate(); }}>Measure my reading speed…</button>
              <hr className="border-[var(--line)]" />
              <Row label="Session timer" value={p.sessionMinutes ? `${p.sessionMinutes} min` : 'off'} onReset={R('sessionMinutes')}><input type="range" min={0} max={120} step={5} value={p.sessionMinutes} onChange={(e) => set({ sessionMinutes: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
              <Row label="Break reminder every" value={p.breakEvery ? `${p.breakEvery} min` : 'off'} onReset={R('breakEvery')}><input type="range" min={0} max={90} step={5} value={p.breakEvery} onChange={(e) => set({ breakEvery: Number(e.target.value) })} className="w-full accent-[var(--accent)]" /></Row>
            </>)}

            {tab === 'habit' && (<>
              <div><div className="text-xs text-[var(--ink2)] mb-1">Rest days <span className="text-[var(--ink3)]">(they never break your streak)</span></div>
                <div className="flex gap-1" role="group" aria-label="Rest days">{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <button key={i} aria-pressed={p.restDays.includes(i)} onClick={() => set({ restDays: p.restDays.includes(i) ? p.restDays.filter((x) => x !== i) : [...p.restDays, i] })} className={`btn flex-1 justify-center !px-0 !py-1 text-xs ${p.restDays.includes(i) ? 'btn-primary' : ''}`}>{d}</button>)}</div></div>
              <label className="flex items-center justify-between text-xs"><span>Gentle reminder if I haven’t read today <span className="text-[var(--ink3)]">(shown when the app is open)</span></span><input type="checkbox" checked={p.remind} onChange={(e) => set({ remind: e.target.checked })} className="accent-[var(--accent)]" /></label>
            </>)}

            {tab === 'keys' && (
              <ul className="text-xs text-[var(--ink2)] space-y-1">
                {[['← →  /  Space  /  Shift+Space', 'Turn pages'], ['Home  /  End', 'First / last page'], ['Alt+← / Alt+→', 'Previous / next chapter'], ['Backspace', 'Back to where you were'], ['1 – 6', 'Reading mode'], ['p', 'Pacer on/off'], ['z', 'Zen mode'], ['f', 'Fullscreen'], ['b', 'Bookmark'], ['/', 'Search in book'], ['[  ]', 'Contents / companion'], ['+  −', 'Text size'], ['t', 'These settings'], ['Esc', 'Close / leave zen']].map(([k, d]) => <li key={k} className="flex justify-between gap-3"><kbd className="font-mono text-[11px] text-[var(--ink)]">{k}</kbd><span>{d}</span></li>)}
              </ul>
            )}
          </div>
          <div className="border-t border-[var(--line)] p-3 flex items-center gap-2 text-xs">
            <label className="flex items-center gap-2 text-[var(--ink2)] flex-1"><input type="checkbox" checked={scope === 'book'} onChange={(e) => setScope(e.target.checked ? 'book' : 'global')} className="accent-[var(--accent)]" /> This book only</label>
            <button className="btn !py-1 text-xs" onClick={() => { if (window.confirm('Reset all reading settings to their defaults?')) { reset(); setPrefs({ size: 19, lineHeight: 1.7, width: 680 }); } }}>Reset all</button>
          </div>
        </div>
      )}
    </div>
  );
}
export { DEFAULTS };
