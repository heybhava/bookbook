// Reading View renderer: Markdown + Obsidian syntax (wikilinks, embeds, callouts, highlights, tags, footnotes) -> sanitised HTML.
// Safe by construction: raw HTML in notes is escaped, URLs are allow-listed, nothing from a note is ever executed.
import { Marked } from 'marked';
import { parseNote } from './parse';
import { runBase, loadBase } from './bases';
import { resolveIn, readFile, sectionOf, blockOf, getFileSet, type Vault } from './store';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAFE_URL = /^(https?:|mailto:|folio:|\/api\/vault\/raw\?|#)/i;
const IMG = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i, AUD = /\.(mp3|wav|ogg|m4a|flac)$/i, VID = /\.(mp4|webm|mov|ogv)$/i;

const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    html({ text }) { return esc(text); }, // never pass raw HTML through
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens); if (!SAFE_URL.test(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) return inner; // javascript:, data:, vbscript: ... become plain text
      const external = /^https?:/i.test(href);
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${external ? ' target="_blank" rel="noopener noreferrer nofollow"' : ''}${!external && !href.startsWith('#') ? ` data-md-link="${esc(href)}"` : ''}>${inner}</a>`;
    },
    image({ href, title, text }) { return /^https?:/i.test(href) ? `<img src="${esc(href)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''} loading="lazy" referrerpolicy="no-referrer">` : `<span class="wl-embed-missing">${esc(text || href)}</span>`; },
  },
});

function mapText(html: string, fn: (t: string) => string): string {
  return html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|<[^>]+>)/g).map((seg, i) => (i % 2 === 1 ? seg : fn(seg))).join('');
}

export interface RenderCtx { vault: Vault; depth: number; seen: Set<string> }
const raw = (v: Vault, p: string) => `/api/vault/raw?vault=${encodeURIComponent(v.id)}&path=${encodeURIComponent(p)}`;

export function renderMarkdown(text: string, srcPath: string, ctx: RenderCtx): string {
  const p = parseNote(text); const fsx = getFileSet(ctx.vault); const stash: string[] = [];
  const hold = (html: string) => { stash.push(html); return `\u0001${stash.length - 1}\u0001`; };
  // 1. splice wikilinks/embeds out of the body (positions come from the code-masked parse, so code blocks are untouched)
  let body = p.body; const links = [...p.links].filter((l) => !l.md).sort((a, b) => b.start - a.start);
  for (const l of links) {
    const r = resolveIn(fsx, srcPath, l.raw, false); const label = l.alias ?? (l.raw ? l.raw + (l.anchor ? ' > ' + l.anchor : '') : l.anchor ?? '');
    let html: string;
    if (!l.embed) html = r.target ? `<a class="wl" href="#" data-wl="${esc(r.target)}"${l.anchor ? ` data-anchor="${esc(l.anchor)}"` : ''}>${esc(label)}</a>` : `<a class="wl unresolved" href="#" data-wl-create="${esc(l.raw)}" title="Note does not exist yet — click to create">${esc(label)}</a>`;
    else if (!r.target) html = `<span class="wl-embed-missing">${esc(l.raw)} (not found)</span>`;
    else if (IMG.test(r.target)) { const w = l.alias && /^\d+(x\d+)?$/.test(l.alias) ? l.alias.split('x')[0] : null; html = `<img src="${raw(ctx.vault, r.target)}" alt="${esc(r.target)}" loading="lazy"${w ? ` width="${w}"` : ''} class="zoomable">`; }
    else if (AUD.test(r.target)) html = `<audio controls preload="none" src="${raw(ctx.vault, r.target)}"></audio>`;
    else if (VID.test(r.target)) html = `<video controls preload="none" src="${raw(ctx.vault, r.target)}"></video>`;
    else if (/\.base$/i.test(r.target)) {
      try {
        const res = runBase(ctx.vault, loadBase(ctx.vault, r.target).config, 0); const rows = res.rows.slice(0, 50);
        html = `<div class="embed base-embed" data-wl="${esc(r.target)}"><div class="embed-title">${esc(r.target.replace(/\.base$/i, ''))} · ${res.total} record${res.total === 1 ? '' : 's'}</div><table><thead><tr>${res.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((x) => `<tr>${res.columns.map((c) => `<td>${esc(String(Array.isArray(x.cells[c.id]) ? (x.cells[c.id] as unknown[]).join(', ') : x.cells[c.id] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      } catch (e: any) { html = `<span class="wl-embed-missing">${esc(r.target)}: ${esc(e.message)}</span>`; }
    }
    else if (/\.md$/i.test(r.target)) {
      if (ctx.depth >= 3 || ctx.seen.has(r.target)) html = `<div class="embed-cycle">↻ ${esc(r.target)} (embed omitted: ${ctx.seen.has(r.target) ? 'circular' : 'too deep'})</div>`;
      else {
        try {
          const f = readFile(ctx.vault, r.target); let part = parseNote(f.text).body;
          if (l.anchor?.startsWith('^')) part = blockOf(f.text, l.anchor.slice(1)) ?? `*Block ${l.anchor} not found.*`; else if (l.anchor) part = sectionOf(f.text, l.anchor) ?? `*Heading "${l.anchor}" not found.*`;
          html = `<div class="embed" data-wl="${esc(r.target)}"><div class="embed-title">${esc(r.target.replace(/\.md$/i, ''))}${l.anchor ? ' › ' + esc(l.anchor) : ''}</div>${renderMarkdown(part, r.target, { ...ctx, depth: ctx.depth + 1, seen: new Set([...ctx.seen, r.target]) })}</div>`;
        } catch { html = `<span class="wl-embed-missing">${esc(l.raw)} (unreadable)</span>`; }
      }
    } else html = `<a class="wl" href="${raw(ctx.vault, r.target)}" target="_blank" rel="noopener">${esc(r.target)}</a>`;
    body = body.slice(0, l.start) + hold(html) + body.slice(l.end);
  }
  // footnotes: [^id]: text  ->  collected list
  const notes: { id: string; text: string }[] = [];
  body = body.replace(/^\[\^([^\]\s]+)\]:\s*(.*)$/gm, (_, id, t) => { notes.push({ id, text: t }); return ''; });
  let html = md.parse(body, { async: false }) as string;
  html = mapText(html, (t) => t
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
    .replace(/(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu, (_m, a, tag) => `${a}<a href="#" class="tag" data-tag="${esc(tag)}">#${tag}</a>`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, x) => `<div class="math-block" title="LaTeX source (not typeset)">${x}</div>`)
    .replace(/(^|[^\w$])\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$(?![\w$])/g, '$1<span class="math" title="LaTeX source (not typeset)">$2</span>')
    .replace(/\[\^([^\]\s]+)\]/g, (m, id) => (notes.some((n) => n.id === id) ? `<sup class="fnref"><a href="#fn-${esc(id)}">${esc(id)}</a></sup>` : m))
    .replace(/\s\^([\w-]+)$/gm, ''));
  html = html.replace(/<blockquote>\s*<p>\[!([\w-]+)\]([+-]?)[ \t]*([^\n<]*)/g, (_m, type, fold, title) => `<blockquote class="callout" data-callout="${esc(type.toLowerCase())}"${fold ? ` data-fold="${fold === '-' ? 'closed' : 'open'}"` : ''}><p class="callout-title">${title.trim() ? title.trim() : esc(type[0].toUpperCase() + type.slice(1))}</p><p>`);
  html = html.replace(/\u0001(\d+)\u0001/g, (_m, i) => stash[Number(i)] ?? '');
  if (notes.length) html += `<hr><ol class="footnotes">${notes.map((n) => `<li id="fn-${esc(n.id)}">${md.parseInline(n.text, { async: false })}</li>`).join('')}</ol>`;
  return html;
}
