import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { all, get, run, tx, uid, db, filesDir, coversDir, me } from './db';
import { enqueueJob, checkQuota } from './limits';
import { extractFile, SUPPORTED, NEEDS_CONVERTER, paginate, type Extracted } from './extract';
import { embed } from './ollama';

const exec = promisify(execFile);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
export const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 500) * 1024 * 1024;

const has = async (cmd: string) => { try { await exec(process.platform === 'win32' ? 'where' : 'which', [cmd]); return true; } catch { return false; } };

export async function capabilities() {
  return {
    calibre: await has('ebook-convert'), libreoffice: (await has('soffice')) || (await has('libreoffice')),
    native: Object.keys(SUPPORTED), images: [...IMAGE_EXT],
  };
}

export function checkUpload(name: string, size: number): string | null {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (size > MAX_UPLOAD) return `File exceeds the ${MAX_UPLOAD / 1048576} MB limit.`;
  if (size === 0) return 'File is empty.';
  if (ext === 'cbr' || ext === 'cbz') return 'Comic archives contain only images and need OCR; not supported yet.';
  if (!(ext in SUPPORTED) && !(ext in NEEDS_CONVERTER) && !IMAGE_EXT.has(ext)) return `Unsupported file type .${ext}`;
  return null;
}

export async function saveUpload(name: string, data: Buffer): Promise<string> {
  const ext = path.extname(name).slice(1).toLowerCase();
  const bookId = uid();
  const docId = uid();
  const safe = `${docId}.${ext.replace(/[^a-z0-9]/g, '')}`; // never trust the client file name for paths
  await fs.writeFile(path.join(filesDir(), safe), data);
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  tx(() => {
    run('INSERT INTO books (id, user_id, title, format, status, created_at) VALUES (?,?,?,?,?,?)', bookId, me(), path.basename(name, path.extname(name)).slice(0, 200), ext, 'queued', Date.now());
    run('INSERT INTO documents (id, book_id, file_path, original_name, size, sha256) VALUES (?,?,?,?,?,?)', docId, bookId, safe, path.basename(name), data.length, sha);
  });
  enqueue(bookId);
  return bookId;
}

// ---- per-tenant background queue ----
/** Queue processing for the CURRENT user's book. Jobs run inside that user's context; users are served fairly (see limits.ts). */
export function enqueue(bookId: string) { enqueueJob('ingest', bookId, () => processBook(bookId)); }

/** Re-queue anything left half-done by a restart. */
export function resumeQueue() {
  for (const b of all<{ id: string }>("SELECT id FROM books WHERE status IN ('queued','processing')")) enqueue(b.id);
}

const setStatus = (id: string, status: string, detail: string | null = null) =>
  run('UPDATE books SET status = ?, status_detail = ? WHERE id = ?', status, detail, id);

async function convert(file: string, ext: string, kind: 'calibre' | 'libreoffice'): Promise<{ file: string; ext: string }> {
  const dir = await fs.mkdtemp(path.join(filesDir(), 'conv-'));
  if (kind === 'calibre') {
    if (!(await has('ebook-convert'))) throw new Error(`.${ext} needs Calibre (ebook-convert) installed. Install https://calibre-ebook.com and re-upload. DRM-protected files are not supported.`);
    const out = path.join(dir, 'out.epub');
    await exec('ebook-convert', [file, out], { timeout: 10 * 60_000 });
    return { file: out, ext: 'epub' };
  }
  const bin = (await has('soffice')) ? 'soffice' : (await has('libreoffice')) ? 'libreoffice' : null;
  if (!bin) throw new Error(`.${ext} needs LibreOffice (soffice) installed. Install https://libreoffice.org and re-upload.`);
  await exec(bin, ['--headless', '--convert-to', 'docx', '--outdir', dir, file], { timeout: 10 * 60_000 });
  const f = (await fs.readdir(dir)).find((x) => x.endsWith('.docx'));
  if (!f) throw new Error('LibreOffice conversion produced no output.');
  return { file: path.join(dir, f), ext: 'docx' };
}

async function ocrImage(file: string): Promise<Extracted> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, { cachePath: path.join(filesDir(), '..', 'tessdata') });
  try {
    const { data } = await worker.recognize(file);
    const paras = data.text.split(/\n{2,}/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    if (!paras.length) throw new Error('OCR found no text in this image.');
    return { chapters: [{ title: 'Image text (OCR)', startPage: 1 }], pages: paginate(paras, 0).map((p) => ({ ...p, ocr: true })), notes: ['Text recognised with Tesseract OCR; accuracy depends on image quality. English only.'] };
  } finally { await worker.terminate(); }
}

export async function processBook(bookId: string) {
  const book = get<any>('SELECT * FROM books WHERE id = ?', bookId);
  const doc = get<any>('SELECT * FROM documents WHERE book_id = ?', bookId);
  if (!book || !doc) return;
  try {
    setStatus(bookId, 'processing', 'Extracting text…');
    let file = path.join(filesDir(), doc.file_path);
    let ext = book.format as string;
    let ex: Extracted;
    if (IMAGE_EXT.has(ext)) ex = await ocrImage(file);
    else {
      if (ext in NEEDS_CONVERTER) ({ file, ext } = await convert(file, ext, NEEDS_CONVERTER[ext]));
      ex = await extractFile(file, ext);
    }
    if (!ex.pages.length || (ext !== 'pdf' && ex.pages.every((p) => !p.text.trim()))) {
      throw new Error('No extractable text. ');
    }
    tx(() => {
      run('DELETE FROM pages WHERE book_id = ?', bookId);
      run('DELETE FROM chapters WHERE book_id = ?', bookId);
      ex.chapters.forEach((c, i) => run('INSERT INTO chapters (id, book_id, idx, title, start_page) VALUES (?,?,?,?,?)', uid(), bookId, i, c.title, c.startPage));
      ex.pages.forEach((p, i) => run('INSERT INTO pages (book_id, page, chapter_idx, text, html, ocr) VALUES (?,?,?,?,?,?)', bookId, i + 1, p.chapterIdx, p.text, p.html ?? null, p.ocr ? 1 : 0));
      const title = book.title === path.basename(doc.original_name, path.extname(doc.original_name)) ? ex.title || book.title : book.title;
      run('UPDATE books SET title = ?, author = COALESCE(author, ?), language = ?, page_count = ?, status_detail = ? WHERE id = ?', title, ex.author ?? null, ex.language ?? null, ex.pages.length, ex.notes.join(' ') || null, bookId);
    });
    if (ex.cover) {
      const cp = `${bookId}${ex.cover.ext}`;
      await fs.writeFile(path.join(coversDir(), cp), ex.cover.data);
      run('UPDATE books SET cover_path = ? WHERE id = ?', cp, bookId);
    }
    // Readable now; indexing continues in the background.
    setStatus(bookId, 'readable', ex.notes.join(' ') || null);
    await indexBook(bookId);
    const embedded = get<{ n: number }>('SELECT COUNT(*) n FROM chunks WHERE book_id = ? AND embedding IS NULL', bookId)?.n === 0;
    setStatus(bookId, 'ready', [ex.notes.join(' '), embedded ? '' : 'Semantic search unavailable (no embedding model) — keyword search only.'].filter(Boolean).join(' ') || null);
  } catch (e: any) {
    setStatus(bookId, 'error', e?.message ?? String(e));
  }
}

/** Chunk text (~900 chars, paragraph aware, with page ranges) and store FTS + embeddings. */
export async function indexBook(bookId: string) {
  const pages = all<{ page: number; chapter_idx: number; text: string }>('SELECT page, chapter_idx, text FROM pages WHERE book_id = ? ORDER BY page', bookId);
  const chunks: { ps: number; pe: number; ch: number; text: string }[] = [];
  let cur: { ps: number; pe: number; ch: number; text: string } | null = null;
  for (const p of pages) {
    for (const para of p.text.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
      if (cur && cur.text.length + para.length > 900) {
        chunks.push(cur);
        const tail: string = cur.text.slice(-150);
        cur = { ps: p.page, pe: p.page, ch: p.chapter_idx, text: tail };
      }
      if (!cur) cur = { ps: p.page, pe: p.page, ch: p.chapter_idx, text: '' };
      cur.text += (cur.text ? '\n' : '') + para; cur.pe = p.page;
    }
  }
  if (cur?.text.trim()) chunks.push(cur);
  tx(() => {
    run('DELETE FROM chunks WHERE book_id = ?', bookId);
    for (const c of chunks) run('INSERT INTO chunks (book_id, page_start, page_end, chapter_idx, text) VALUES (?,?,?,?,?)', bookId, c.ps, c.pe, c.ch, c.text);
  });
  await embedBook(bookId);
}

/** Embed any chunks missing vectors. Returns false if no embedding model is available. */
export async function embedBook(bookId: string): Promise<boolean> {
  const rows = all<{ id: number; text: string }>('SELECT id, text FROM chunks WHERE book_id = ? AND embedding IS NULL', bookId);
  if (!rows.length) return true;
  for (let i = 0; i < rows.length; i += 64) {
    const batch = rows.slice(i, i + 64);
    setStatus(bookId, 'readable', `Indexing for semantic search ${Math.min(i + 64, rows.length)}/${rows.length}…`);
    const res = await embed(batch.map((b) => b.text));
    if (!res) return false;
    tx(() => batch.forEach((b, k) => {
      const buf = Buffer.from(new Float32Array(res.vectors[k]).buffer);
      run('UPDATE chunks SET embedding = ?, embed_model = ? WHERE id = ?', buf, res.model, b.id);
    }));
  }
  return true;
}

export async function deleteBook(bookId: string) {
  const doc = get<any>('SELECT file_path FROM documents WHERE book_id = ?', bookId);
  const b = get<any>('SELECT cover_path FROM books WHERE id = ?', bookId);
  run('DELETE FROM books WHERE id = ? AND user_id = ?', bookId, me());
  if (doc) await fs.rm(path.join(filesDir(), doc.file_path), { force: true });
  if (b?.cover_path) await fs.rm(path.join(coversDir(), b.cover_path), { force: true });
  db();
}
