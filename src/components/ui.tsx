'use client';
import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { api } from '@/lib/api';

const ICONS: Record<string, string> = {
  book: 'M4 5a2 2 0 012-2h12v16H6a2 2 0 00-2 2V5zm2 14h12',
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM16.5 5l3.5 1-4 14-3.5-1z',
  vocab: 'M4 6h16M4 12h10M4 18h7M18 14l3 3-3 3',
  note: 'M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6',
  goal: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 5a4 4 0 100 8 4 4 0 000-8zm0 3a1 1 0 100 2 1 1 0 000-2z',
  graph: 'M6 7a2 2 0 100-4 2 2 0 000 4zm12 0a2 2 0 100-4 2 2 0 000 4zM12 21a2 2 0 100-4 2 2 0 000 4zM7.5 6l3.5 11M16.5 6L13 17M8 5h8',
  cards: 'M3 8l9-4 9 4-9 4zM3 12l9 4 9-4M3 16l9 4 9-4',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  play: 'M7 4l13 8-13 8z', pause: 'M7 4h4v16H7zM13 4h4v16h-4z', stop: 'M6 6h12v12H6z',
  left: 'M15 5l-7 7 7 7', right: 'M9 5l7 7-7 7', x: 'M6 6l12 12M18 6L6 18', plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5', bookmark: 'M6 3h12v18l-6-4-6 4z',
  sound: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11', sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  menu: 'M4 6h16M4 12h16M4 18h16', type: 'M5 7V5h14v2M12 5v14M9 19h6', trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13', up: 'M6 15l6-6 6 6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4', down: 'M6 9l6 6 6-6', grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  download: 'M12 4v12m-5-5l5 5 5-5M5 20h14', upload: 'M12 16V4m-5 5l5-5 5 5M5 20h14', check: 'M5 13l4 4L19 7', clock: 'M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  highlight: 'M9 11l-5 9h5l1-2 8-8-4-4zM14 6l4 4', full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
};
export function Icon({ n, size = 16, className = '' }: { n: keyof typeof ICONS | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={ICONS[n] ?? ''} />
    </svg>
  );
}

export function useFetch<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try { setData(await api<T>(path)); setError(null); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [path]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, [reload, ...deps]);
  return { data, error, loading, reload, setData };
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Tiny safe Markdown renderer (escape first, then a handful of constructs). */
export function renderMd(src: string, cites?: Set<number>): string {
  const lines = escHtml(src.replace(/<\/?book_excerpt>/g, '')).split('\n'); // models sometimes echo the prompt's data fences
  let out = ''; let list: 'ul' | 'ol' | null = null;
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  const inline = (s: string) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(?<![*\w])\*(?!\s)(.+?)\*(?!\w)/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[S(\d+)\]/g, (_, n) => (!cites || cites.has(Number(n)) ? `<sup><a data-cite="${n}" class="cursor-pointer text-[var(--accent)] font-semibold no-underline">[${n}]</a></sup>` : '<sup title="invalid citation">[?]</sup>'));
  for (const l of lines) {
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^#{1,4}\s+(.*)/))) { close(); out += `<h3>${inline(m[1])}</h3>`; }
    else if (!l.trim()) close();
    else { close(); out += `<p>${inline(l)}</p>`; }
  }
  close();
  return out;
}
export function Md({ text, cites, onCite }: { text: string; cites?: Set<number>; onCite?: (n: number) => void }) {
  return (
    <div className="md text-[0.875rem] leading-relaxed" onClick={(e) => { const n = (e.target as HTMLElement).dataset?.cite; if (n && onCite) onCite(Number(n)); }} dangerouslySetInnerHTML={{ __html: renderMd(text, cites) }} />
  );
}

export function Spinner({ label }: { label?: string }) {
  return <div className="flex items-center gap-2 text-[var(--ink3)] text-sm"><span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-[var(--line)] border-t-[var(--accent)] animate-spin" />{label}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="text-center py-14 px-6 text-[var(--ink2)]"><div className="text-base font-medium text-[var(--ink)] mb-1">{title}</div><div className="text-sm max-w-md mx-auto">{children}</div></div>;
}

export function ErrorNote({ error }: { error: string }) {
  return <div className="rounded-lg border border-[var(--line)] bg-[var(--panel2)] p-3 text-sm text-[var(--danger)]">{error}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); ref.current?.focus(); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal aria-label={title} className={`card fade-in w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[88vh] overflow-auto p-5 shadow-2xl`}>
        <div className="flex items-center justify-between mb-3"><h2 className="font-semibold">{title}</h2><button className="btn btn-ghost" onClick={onClose} aria-label="Close"><Icon n="x" /></button></div>
        {children}
      </div>
    </div>
  );
}

export const fmtDur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`);
