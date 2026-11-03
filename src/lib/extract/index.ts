// Common document abstraction: every format is reduced to { meta, chapters, pages }.
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { guardZip } from '../zipguard';
import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml } from 'node-html-parser';

export interface ExtractedPage { text: string; html?: string; chapterIdx: number; ocr?: boolean }
export interface ExtractedChapter { title: string; startPage: number }
export interface Extracted {
  title?: string; author?: string; language?: string;
  chapters: ExtractedChapter[]; pages: ExtractedPage[];
  cover?: { data: Buffer; ext: string };
  notes: string[]; // honest caveats shown in the UI
}

export const SUPPORTED: Record<string, string> = {
  pdf: 'PDF', epub: 'EPUB', txt: 'Text', md: 'Markdown', markdown: 'Markdown', html: 'HTML', htm: 'HTML',
  docx: 'DOCX', csv: 'CSV', xlsx: 'XLSX', fb2: 'FB2', cbz: 'Comic (images only, needs OCR)',
};
/** Formats that need Calibre / LibreOffice; accepted only if those CLIs are installed. */
export const NEEDS_CONVERTER: Record<string, 'calibre' | 'libreoffice'> = {
  mobi: 'calibre', azw: 'calibre', azw3: 'calibre', rtf: 'libreoffice', doc: 'libreoffice',
  ppt: 'libreoffice', pptx: 'libreoffice', odt: 'libreoffice',
};

const PAGE_TARGET = 1800; // chars per virtual page for reflowable formats

export function paginate(paragraphs: string[], chapterIdx: number): ExtractedPage[] {
  const pages: ExtractedPage[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    if (!buf.length) return;
    pages.push({ text: buf.join('\n\n'), html: buf.map((p) => `<p>${esc(p)}</p>`).join(''), chapterIdx });
    buf = []; len = 0;
  };
  for (const p of paragraphs) {
    if (len > 0 && len + p.length > PAGE_TARGET) flush();
    if (p.length > PAGE_TARGET * 1.6) {
      // very long paragraph: split on sentence boundaries
      for (const s of p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [p]) {
        if (len > 0 && len + s.length > PAGE_TARGET) flush();
        buf.push(s.trim()); len += s.length;
      }
      continue;
    }
    buf.push(p); len += p.length;
  }
  flush();
  return pages;
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function htmlToParagraphs(html: string): { title?: string; paras: string[] } {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false, noscript: false } });
  root.querySelectorAll('script,style,noscript,svg').forEach((n) => n.remove());
  const title = root.querySelector('h1,h2,h3')?.text.trim();
  const paras: string[] = [];
  const blocks = root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,tr,div');
  const seen = new Set<unknown>();
  for (const b of blocks) {
    // only leaf-ish blocks, so nested divs don't duplicate text
    if (b.tagName === 'DIV' && b.querySelector('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,tr,div')) continue;
    if (['P', 'LI', 'BLOCKQUOTE'].includes(b.tagName) && b.querySelector('p,li,blockquote')) continue;
    if (seen.has(b)) continue;
    seen.add(b);
    const t = b.text.replace(/\s+/g, ' ').trim();
    if (t) paras.push(t);
  }
  if (!paras.length) {
    const t = root.text.replace(/\s+/g, ' ').trim();
    if (t) paras.push(t);
  }
  return { title, paras };
}

async function extractText(buf: Buffer, md: boolean): Promise<Extracted> {
  const s = buf.toString('utf8').replace(/\r\n?/g, '\n');
  const chapters: ExtractedChapter[] = [];
  const pages: ExtractedPage[] = [];
  // Split by markdown headings if any, else a single chapter.
  const sections: { title: string; body: string }[] = [];
  if (md || /^#{1,3} /m.test(s)) {
    let cur = { title: 'Start', body: '' };
    for (const line of s.split('\n')) {
      const m = line.match(/^#{1,3}\s+(.*)/);
      if (m) { if (cur.body.trim()) sections.push(cur); cur = { title: m[1].trim(), body: '' }; }
      else cur.body += line + '\n';
    }
    if (cur.body.trim()) sections.push(cur);
  }
  if (!sections.length) sections.push({ title: 'Text', body: s });
  sections.forEach((sec, i) => {
    const paras = sec.body.split(/\n{2,}/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    chapters.push({ title: sec.title, startPage: pages.length + 1 });
    pages.push(...paginate(paras, i));
  });
  return { chapters, pages, notes: [] };
}

async function extractHtmlFile(buf: Buffer): Promise<Extracted> {
  const { title, paras } = htmlToParagraphs(buf.toString('utf8'));
  return { title, chapters: [{ title: title || 'Document', startPage: 1 }], pages: paginate(paras, 0), notes: [] };
}

async function extractDocx(buf: Buffer): Promise<Extracted> {
  const mammoth = await import('mammoth');
  const { value: html } = await mammoth.convertToHtml({ buffer: buf });
  const root = parseHtml(html);
  const chapters: ExtractedChapter[] = [];
  const pages: ExtractedPage[] = [];
  let paras: string[] = [];
  let ci = -1;
  const flush = () => { if (paras.length && ci >= 0) pages.push(...paginate(paras, ci)); paras = []; };
  for (const n of root.childNodes) {
    const el = n as any;
    const t = (el.text ?? '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (/^H[1-2]$/.test(el.tagName ?? '')) {
      flush(); ci++; chapters.push({ title: t, startPage: pages.length + 1 });
    } else {
      if (ci < 0) { ci = 0; chapters.push({ title: 'Document', startPage: 1 }); }
      paras.push(t);
    }
  }
  flush();
  return { chapters, pages, notes: ['DOCX is converted to reflowable text; original page layout is not preserved.'] };
}

async function extractEpub(buf: Buffer): Promise<Extracted> {
  const zip = await JSZip.loadAsync(buf);
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
  const read = async (p: string) => (await zip.file(p)?.async('string')) ?? '';
  if (await zip.file('META-INF/encryption.xml')?.async('string')) {
    const enc = await read('META-INF/encryption.xml');
    if (/EncryptedData/.test(enc) && !/obfuscation/i.test(enc)) throw new Error('This EPUB is DRM-protected. DRM is not bypassed.');
  }
  const container = xml.parse(await read('META-INF/container.xml'));
  const opfPath: string = container.container.rootfiles.rootfile['@_full-path'] ?? container.container.rootfiles.rootfile[0]['@_full-path'];
  const opfDir = path.posix.dirname(opfPath);
  const opf = xml.parse(await read(opfPath)).package;
  const arr = <T,>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
  const manifest = new Map<string, any>();
  for (const it of arr<any>(opf.manifest.item)) manifest.set(it['@_id'], it);
  const meta = opf.metadata ?? {};
  const txt = (v: any) => (typeof v === 'object' && v ? v['#text'] ?? '' : v ?? '');
  const title = String(txt(arr<any>(meta.title)[0]) || '').trim() || undefined;
  const author = String(txt(arr<any>(meta.creator)[0]) || '').trim() || undefined;
  const language = String(txt(arr<any>(meta.language)[0]) || '').trim() || undefined;

  // Table of contents (nav.xhtml or toc.ncx) -> map href -> label
  const tocLabels = new Map<string, string>();
  const navItem = [...manifest.values()].find((m) => (m['@_properties'] ?? '').includes('nav'));
  const ncxItem = [...manifest.values()].find((m) => m['@_media-type'] === 'application/x-dtbncx+xml');
  const norm = (href: string) => decodeURIComponent(href.split('#')[0]);
  try {
    if (navItem) {
      const navHtml = await read(path.posix.join(opfDir, navItem['@_href']));
      const navDir = path.posix.dirname(path.posix.join(opfDir, navItem['@_href']));
      parseHtml(navHtml).querySelectorAll('nav a, a').forEach((a) => {
        const href = a.getAttribute('href'); if (!href) return;
        const key = path.posix.normalize(path.posix.join(navDir, norm(href)));
        if (!tocLabels.has(key)) tocLabels.set(key, a.text.replace(/\s+/g, ' ').trim());
      });
    } else if (ncxItem) {
      const ncxPath = path.posix.join(opfDir, ncxItem['@_href']);
      const ncx = xml.parse(await read(ncxPath));
      const walk = (pts: any) => arr<any>(pts).forEach((p) => {
        const src = p.content?.['@_src']; const label = txt(p.navLabel?.text);
        if (src) tocLabels.set(path.posix.normalize(path.posix.join(path.posix.dirname(ncxPath), norm(src))), String(label).trim());
        if (p.navPoint) walk(p.navPoint);
      });
      walk(ncx.ncx.navMap.navPoint);
    }
  } catch { /* TOC is best-effort */ }

  const chapters: ExtractedChapter[] = [];
  const pages: ExtractedPage[] = [];
  let ci = -1;
  for (const ref of arr<any>(opf.spine.itemref)) {
    const item = manifest.get(ref['@_idref']);
    if (!item || !/x?html/.test(item['@_media-type'] ?? '')) continue;
    const full = path.posix.normalize(path.posix.join(opfDir, decodeURIComponent(item['@_href'])));
    const html = await read(full);
    const { title: h, paras } = htmlToParagraphs(html);
    if (!paras.length) continue;
    const label = tocLabels.get(full) ?? h ?? `Section ${ci + 2}`;
    // Merge tiny untitled spine items into the previous chapter
    if (ci >= 0 && !tocLabels.has(full) && paras.join(' ').length < 400) { pages.push(...paginate(paras, ci)); continue; }
    ci++;
    chapters.push({ title: label.slice(0, 160), startPage: pages.length + 1 });
    pages.push(...paginate(paras, ci));
  }
  if (!pages.length) throw new Error('No readable text found in EPUB.');

  let cover: Extracted['cover'];
  try {
    const coverId = arr<any>(meta.meta).find((m) => m['@_name'] === 'cover')?.['@_content'];
    const ci2 = (coverId && manifest.get(coverId)) || [...manifest.values()].find((m) => (m['@_properties'] ?? '').includes('cover-image'));
    if (ci2) {
      const f = zip.file(path.posix.join(opfDir, decodeURIComponent(ci2['@_href'])));
      if (f) cover = { data: Buffer.from(await f.async('uint8array')), ext: path.extname(ci2['@_href']) || '.jpg' };
    }
  } catch { /* optional */ }
  return { title, author, language, chapters, pages, cover, notes: ['EPUB is rendered from extracted text (headings/paragraphs). Inline images and exact CSS layout are not reproduced.'] };
}

async function extractFb2(buf: Buffer): Promise<Extracted> {
  const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, preserveOrder: false });
  const doc = xml.parse(buf.toString('utf8')).FictionBook;
  const arr = <T,>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
  const flat = (n: any): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(flat).join(' ') : n && typeof n === 'object' ? Object.entries(n).filter(([k]) => !k.startsWith('@_')).map(([, v]) => flat(v)).join(' ') : '');
  const ti = doc.description?.['title-info'];
  const chapters: ExtractedChapter[] = []; const pages: ExtractedPage[] = [];
  for (const body of arr<any>(doc.body)) for (const sec of arr<any>(body.section)) {
    const paras = arr<any>(sec.p).map((p) => flat(p).replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!paras.length) continue;
    chapters.push({ title: flat(sec.title).replace(/\s+/g, ' ').trim() || `Section ${chapters.length + 1}`, startPage: pages.length + 1 });
    pages.push(...paginate(paras, chapters.length - 1));
  }
  if (!pages.length) throw new Error('No readable text found in FB2.');
  return { title: flat(ti?.['book-title']).trim() || undefined, author: [flat(ti?.author?.['first-name']), flat(ti?.author?.['last-name'])].join(' ').trim() || undefined, chapters, pages, notes: [] };
}

async function extractCsv(buf: Buffer): Promise<Extracted> {
  const Papa = (await import('papaparse')).default;
  const rows = Papa.parse<string[]>(buf.toString('utf8'), { skipEmptyLines: true }).data;
  const header = rows[0] ?? [];
  const paras = rows.slice(1).map((r) => r.map((c, i) => `${header[i] ?? i}: ${c}`).join('; '));
  return { chapters: [{ title: 'Table', startPage: 1 }], pages: paginate(paras.length ? paras : rows.map((r) => r.join(', ')), 0), notes: ['Rows converted to "column: value" text.'] };
}

async function extractXlsx(buf: Buffer): Promise<Extracted> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const chapters: ExtractedChapter[] = []; const pages: ExtractedPage[] = [];
  wb.SheetNames.forEach((name, i) => {
    const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[name], { header: 1, blankrows: false }) as any[][];
    const paras = rows.map((r) => r.join(' | ')).filter(Boolean);
    if (!paras.length) return;
    chapters.push({ title: name, startPage: pages.length + 1 });
    pages.push(...paginate(paras, i));
  });
  return { chapters, pages, notes: ['Sheets converted to pipe-separated text.'] };
}

async function extractPdf(buf: Buffer): Promise<Extracted> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages: ExtractedPage[] = [];
  let scanned = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // Rebuild words/lines/paragraphs from glyph positions: spaces only where there is a real gap,
    // new paragraph on a large vertical gap, soft line breaks joined, end-of-line hyphens removed.
    let out = ''; let lastY = 0; let lastEnd = 0; let lastH = 10; let first = true;
    for (const it of tc.items as any[]) {
      if (!('str' in it) || !it.str) continue;
      const x = it.transform[4], y = it.transform[5];
      const h = Math.abs(it.height || it.transform[3]) || lastH;
      if (!first) {
        if (Math.abs(y - lastY) > h * 0.5) {
          if (Math.abs(lastY - y) > lastH * 1.7) out += '\n';
          else if (/[A-Za-z]-$/.test(out)) out = out.slice(0, -1);
          else out += ' ';
        } else if (x - lastEnd > lastH * 0.18 && !out.endsWith(' ')) out += ' ';
      }
      out += it.str; lastY = y; lastEnd = x + (it.width || 0); lastH = h; first = false;
    }
    const text = out.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
    if (text.length < 20) scanned++;
    pages.push({ text, chapterIdx: 0 });
    page.cleanup();
  }
  const chapters: ExtractedChapter[] = [];
  try {
    const outline = await doc.getOutline();
    const walk = async (items: any[], depth: number) => {
      for (const o of items ?? []) {
        let pg: number | null = null;
        try {
          const dest = typeof o.dest === 'string' ? await doc.getDestination(o.dest) : o.dest;
          if (dest) pg = (await doc.getPageIndex(dest[0])) + 1;
        } catch { /* skip */ }
        if (pg && depth === 0) chapters.push({ title: String(o.title).trim().slice(0, 160), startPage: pg });
        if (o.items?.length && depth < 0) await walk(o.items, depth + 1);
      }
    };
    await walk(outline ?? [], 0);
  } catch { /* outline optional */ }
  if (!chapters.length) chapters.push({ title: 'Document', startPage: 1 });
  chapters.sort((a, b) => a.startPage - b.startPage);
  pages.forEach((p, i) => { let ci = 0; chapters.forEach((c, k) => { if (c.startPage <= i + 1) ci = k; }); p.chapterIdx = ci; });
  let info: any = {};
  try { info = (await doc.getMetadata()).info ?? {}; } catch { /* optional */ }
  const notes: string[] = [];
  if (scanned > 0) notes.push(`${scanned} of ${doc.numPages} pages have no text layer (scanned). Open the book and use the OCR button to make them searchable.`);
  return { title: info.Title?.trim() || undefined, author: info.Author?.trim() || undefined, chapters, pages, notes };
}

let pdfjsP: Promise<any> | null = null;
export function loadPdfjs() {
  if (!pdfjsP) {
    const imp = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
    pdfjsP = imp('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsP;
}

export async function extractFile(filePath: string, ext: string): Promise<Extracted> {
  const buf = await fs.readFile(filePath);
  switch (ext) {
    case 'pdf': return extractPdf(buf);
    case 'epub': guardZip(buf, 'EPUB'); return extractEpub(buf);
    case 'txt': return extractText(buf, false);
    case 'md': case 'markdown': return extractText(buf, true);
    case 'html': case 'htm': return extractHtmlFile(buf);
    case 'docx': guardZip(buf, 'DOCX'); return extractDocx(buf);
    case 'fb2': return extractFb2(buf);
    case 'csv': return extractCsv(buf);
    case 'xlsx': guardZip(buf, 'XLSX'); return extractXlsx(buf);
    default: throw new Error(`Unsupported format: .${ext}`);
  }
}
