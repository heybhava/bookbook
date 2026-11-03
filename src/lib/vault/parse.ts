// Markdown note parsing for the vault index: frontmatter, links, embeds, tags, headings, tasks.
// Pure functions (no I/O) so they can be unit-tested and reused by the renderer.
import YAML from 'yaml';

export interface ParsedLink { raw: string; embed: boolean; anchor: string | null; alias: string | null; md: boolean; line: number; start: number; end: number; text: string }
export interface Parsed {
  frontmatter: Record<string, unknown>; fmRaw: string | null; body: string; bodyOffset: number;
  links: ParsedLink[]; tags: string[]; headings: { level: number; text: string; line: number }[]; tasks: { line: number; done: boolean; text: string }[];
  props: { key: string; value: unknown; type: PropType }[]; aliases: string[]; fmError: string | null;
}
export type PropType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'list' | 'tags';

/** Split `---\nyaml\n---\n` off the front. Returns the raw yaml text and where the body starts. */
export function splitFrontmatter(src: string): { fmRaw: string | null; body: string; bodyOffset: number } {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { fmRaw: null, body: src, bodyOffset: 0 };
  return { fmRaw: m[1], body: src.slice(m[0].length), bodyOffset: m[0].length };
}

export function propType(key: string, v: unknown): PropType {
  if (key === 'tags' || key === 'tag') return 'tags';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (v instanceof Date) return 'datetime';
  if (typeof v === 'string') { if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date'; if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return 'datetime'; }
  return 'text';
}

/** Blank out code (fenced + inline) with spaces of equal length so offsets/lines are preserved but nothing inside is parsed. */
export function maskCode(s: string): string {
  const blank = (x: string) => x.replace(/[^\n]/g, ' ');
  return s.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?=\n|$)|$(?![\s\S]))/gm, blank).replace(/`[^`\n]+`/g, blank);
}

const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;
const WIKI_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MDLINK_RE = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

export function parseNote(src: string): Parsed {
  const { fmRaw, body, bodyOffset } = splitFrontmatter(src);
  let frontmatter: Record<string, unknown> = {}; let fmError: string | null = null;
  if (fmRaw != null) {
    try { const d = YAML.parseDocument(fmRaw, { prettyErrors: false }); if (d.errors.length) fmError = d.errors[0].message; else { const j = d.toJS({ maxAliasCount: 50 }); if (j && typeof j === 'object' && !Array.isArray(j)) frontmatter = j as any; } } catch (e: any) { fmError = String(e?.message ?? e); }
  }
  const masked = maskCode(body);
  const lineAt = (idx: number) => { let n = 0; for (let i = 0; i < idx; i++) if (masked.charCodeAt(i) === 10) n++; return n; };
  const links: ParsedLink[] = [];
  for (const m of masked.matchAll(WIKI_RE)) {
    const inner = m[2]; const pipe = inner.indexOf('|'); const target = pipe < 0 ? inner : inner.slice(0, pipe); const alias = pipe < 0 ? null : inner.slice(pipe + 1).trim() || null;
    const h = target.indexOf('#'); const name = (h < 0 ? target : target.slice(0, h)).trim(); const anchor = h < 0 ? null : target.slice(h + 1).trim() || null;
    if (!name && !anchor) continue;
    links.push({ raw: name, embed: m[1] === '!', anchor, alias, md: false, line: lineAt(m.index!), start: m.index!, end: m.index! + m[0].length, text: m[0] });
  }
  for (const m of masked.matchAll(MDLINK_RE)) {
    let href = m[3].replace(/^<|>$/g, ''); if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) continue; // external or same-note anchor
    const h = href.indexOf('#'); const anchor = h < 0 ? null : decodeURIComponent(href.slice(h + 1)); if (h >= 0) href = href.slice(0, h);
    try { href = decodeURIComponent(href); } catch { /* keep as written */ }
    if (!href) continue;
    links.push({ raw: href.replace(/\.md$/i, ''), embed: m[1] === '!', anchor, alias: m[2] || null, md: true, line: lineAt(m.index!), start: m.index!, end: m.index! + m[0].length, text: m[0] });
  }
  const tags = new Set<string>();
  for (const m of masked.replace(WIKI_RE, (x) => ' '.repeat(x.length)).matchAll(TAG_RE)) tags.add(m[2].replace(/\/+$/, ''));
  const fmTags = frontmatter.tags ?? frontmatter.tag;
  for (const t of Array.isArray(fmTags) ? fmTags : typeof fmTags === 'string' ? fmTags.split(/[,\s]+/) : []) { const s = String(t).replace(/^#/, '').trim(); if (s) tags.add(s); }
  const headings: Parsed['headings'] = []; const tasks: Parsed['tasks'] = [];
  masked.split('\n').forEach((ln, i) => {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(ln); if (h) headings.push({ level: h[1].length, text: h[2].trim(), line: i });
    const t = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.*)$/.exec(ln); if (t) tasks.push({ line: i, done: t[1] !== ' ', text: t[2].trim() });
  });
  const props = Object.entries(frontmatter).map(([key, value]) => ({ key, value, type: propType(key, value) }));
  const al = frontmatter.aliases ?? frontmatter.alias;
  const aliases = (Array.isArray(al) ? al : typeof al === 'string' ? [al] : []).map((x) => String(x)).filter(Boolean);
  return { frontmatter, fmRaw, body, bodyOffset, links, tags: [...tags], headings, tasks, props, aliases, fmError };
}

/** Edit frontmatter without disturbing unknown keys, comments, or the body. */
export function editFrontmatter(src: string, edit: (doc: YAML.Document) => void): string {
  const { fmRaw, body } = splitFrontmatter(src);
  const doc = fmRaw != null ? YAML.parseDocument(fmRaw) : new YAML.Document({});
  if (doc.errors.length) throw new Error('The note has invalid YAML frontmatter; fix it in the raw editor first.');
  if (!doc.contents || !YAML.isMap(doc.contents)) doc.contents = doc.createNode({}) as any;
  edit(doc);
  const out = String(doc).trimEnd();
  if (!out || out === '{}') return body;
  return `---\n${out}\n---\n${body}`;
}

/** Heading slug used for [[Note#Heading]] matching (case/punctuation-insensitive). */
export const headingKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
