// Splits a block of text into pages that exactly fit a page box at the reader's own font size, by measuring real layout.
// (The library stores long "sections"; a printed page holds only part of one, so each section is cut into as many pages as it needs.)
export interface Span { s: number; e: number }
export interface Box { w: number; h: number; vars: Record<string, string> }

let host: HTMLDivElement | null = null;
function measurer(b: Box) {
  if (!host) {
    host = document.createElement('div'); host.className = 'bk-measure'; host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;overflow:visible;height:auto;pointer-events:none';
    const inner = document.createElement('div'); inner.className = 'prose-book'; host.appendChild(inner); document.body.appendChild(host);
  }
  host.style.width = `${b.w}px`;
  for (const [k, v] of Object.entries(b.vars)) host.style.setProperty(k, v);
  return host.firstChild as HTMLDivElement;
}

export function paginate(text: string, b: Box): Span[] {
  const el = measurer(b);
  const fits = (s: number, e: number) => {
    el.textContent = '';
    for (const line of text.slice(s, e).split('\n')) { if (!line.trim()) continue; const p = document.createElement('p'); p.textContent = line; el.appendChild(p); }
    return el.offsetHeight <= b.h;
  };
  const out: Span[] = []; const n = text.length; let pos = 0;
  while (pos < n && /\s/.test(text[pos])) pos++;
  while (pos < n) {
    if (fits(pos, n)) { out.push({ s: pos, e: n }); break; }
    let lo = pos + 1, hi = n; // largest end that still fits
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(pos, mid)) lo = mid; else hi = mid - 1; }
    let cut = lo;
    const sp = Math.max(text.lastIndexOf(' ', cut - 1), text.lastIndexOf('\n', cut - 1));
    if (sp > pos + 20 && cut < n) cut = sp; // break between words, not inside one
    out.push({ s: pos, e: cut });
    pos = cut; while (pos < n && /\s/.test(text[pos])) pos++;
  }
  return out.length ? out : [{ s: 0, e: n }];
}
