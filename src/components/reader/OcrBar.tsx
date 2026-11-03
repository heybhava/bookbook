'use client';
import { useEffect, useState } from 'react';
import { api, post, put } from '@/lib/api';
import { renderPageCanvas } from './PdfPage';

/** Browser-side OCR (tesseract.js) for scanned PDF pages. Text is stored server-side so search, AI and audio work. */
export function OcrBar({ bookId, page, pageHasText, onDone }: { bookId: string; page: number; pageHasText: boolean; onDone: () => void }) {
  const [scanned, setScanned] = useState<number[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [remote, setRemote] = useState(false);
  useEffect(() => { api<any>('/status').then((s) => setRemote(!!s.ocrRemote)).catch(() => {}); }, []);
  useEffect(() => { api<number[]>(`/books/${bookId}/scanned`).then(setScanned).catch(() => {}); }, [bookId, page, busy]);

  async function run(pages: number[]) {
    setErr(null);
    let worker: any;
    try {
      setBusy('Loading OCR engine…');
      if (!remote) {
      const { createWorker } = await import('tesseract.js');
      worker = await createWorker('eng', 1, { workerPath: '/tesseract/worker.min.js', corePath: '/tesseract/core', langPath: '/tesseract/lang', gzip: true, workerBlobURL: false });
      }
      let i = 0;
      for (const p of pages) {
        setBusy(`Recognising page ${p} (${++i}/${pages.length})…`);
        const canvas = await renderPageCanvas(bookId, p, remote ? 2.5 : 2);
        const text = remote
          ? (await post('/ocr/remote', { image: canvas.toDataURL('image/png') })).text
          : (await worker.recognize(canvas)).data.text;
        await put(`/books/${bookId}/pages/${p}/ocr`, { text });
        if (p === page) onDone();
      }
      await post(`/books/${bookId}/reindex`);
    } catch (e: any) { setErr(e.message ?? String(e)); }
    try { await worker?.terminate(); } catch { /* */ }
    setBusy(null); onDone();
  }

  if (!scanned.length && !busy && !err) return null;
  return (
    <div className="card p-3 mt-4 text-sm text-center space-y-2">
      {!pageHasText && scanned.includes(page) && <p className="text-[var(--ink2)]">This page is an image with no text layer, so search, AI and audio can't see it yet.</p>}
      {busy ? <p>{busy}</p> : (
        <div className="flex gap-2 justify-center flex-wrap">
          {scanned.includes(page) && <button className="btn btn-primary" onClick={() => run([page])}>OCR this page</button>}
          <button className="btn" onClick={() => run(scanned)}>OCR all {scanned.length} scanned page{scanned.length > 1 ? 's' : ''}</button>
        </div>
      )}
      {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}
      <p className="text-[11px] text-[var(--ink3)]">{remote ? 'Using your local Unlimited-OCR server.' : 'Runs locally in your browser with Tesseract (English, offline).'} The scan stays as an image; recognised text is used for search, AI and audio.</p>
    </div>
  );
}
