// Exact text ranges inside a pdf.js text layer, so highlights/speech/jump cover precisely the saved words even when
// they begin or end in the middle of a text-layer fragment (PDF text is split into many small <span>s).

const QUOTES: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '‐': '-', '‑': '-', ' ': ' ' };
const norm = (ch: string) => QUOTES[ch] ?? ch;

export interface TextIndex { flat: string; map: { node: Text; off: number }[] }

/** Every non-whitespace character of the layer, in reading order, with its text node + offset. */
export function buildIndex(root: HTMLElement): TextIndex {
  let flat = '';
  const map: TextIndex['map'] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    for (let i = 0; i < t.data.length; i++) {
      const ch = norm(t.data[i]);
      if (/\s/.test(ch)) continue;
      flat += ch.toLowerCase();
      map.push({ node: t, off: i });
    }
  }
  return { flat, map };
}

export const needleOf = (text: string) => [...text].map(norm).filter((c) => !/\s/.test(c)).join('').toLowerCase();

export function findRange(idx: TextIndex, text: string): Range | null {
  const needle = needleOf(text);
  if (needle.length < 3) return null;
  const i = idx.flat.indexOf(needle);
  if (i < 0) return null;
  const a = idx.map[i], b = idx.map[i + needle.length - 1];
  const r = document.createRange();
  r.setStart(a.node, a.off);
  r.setEnd(b.node, b.off + 1);
  return r;
}

export const supportsHighlights = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof (globalThis as any).Highlight !== 'undefined';
export const NAMES = ['hl-yellow', 'hl-green', 'hl-blue', 'hl-pink', 'hl-orange', 'pdf-speak', 'pdf-jump'] as const;

export function applyHighlights(groups: Record<string, Range[]>) {
  const reg = (CSS as any).highlights as Map<string, unknown>;
  for (const n of NAMES) {
    const rs = groups[n];
    if (rs?.length) reg.set(n, new (globalThis as any).Highlight(...rs)); else reg.delete(n);
  }
}
export function clearHighlights() {
  const reg = (CSS as any).highlights as Map<string, unknown> | undefined;
  for (const n of NAMES) reg?.delete(n);
}
