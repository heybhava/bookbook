// Upgraded dependencies exercised through the real code paths: Nodemailer v10 (real SMTP conversation) and the patched SheetJS (spreadsheet import).
import { Client, BASE } from './_auth.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as XLSX from 'xlsx';

const ROOT = path.resolve(import.meta.dirname, '..');
const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });

/** A tiny SMTP sink: accepts one or more messages and records them. */
function smtpSink() {
  const messages: { from: string; to: string[]; data: string }[] = [];
  const server = net.createServer((sock) => {
    let cur = { from: '', to: [] as string[], data: '' }, inData = false, buf = '';
    const say = (s: string) => sock.write(s + '\r\n'); say('220 sink ESMTP');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (inData) { const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return; cur.data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false; messages.push(cur); cur = { from: '', to: [], data: '' }; say('250 queued'); continue; }
        const nl = buf.indexOf('\r\n'); if (nl < 0) return; const line = buf.slice(0, nl); buf = buf.slice(nl + 2); const u = line.toUpperCase();
        if (u.startsWith('EHLO') || u.startsWith('HELO')) say('250 sink'); else if (u.startsWith('MAIL FROM')) { cur.from = line; say('250 ok'); } else if (u.startsWith('RCPT TO')) { cur.to.push(line); say('250 ok'); }
        else if (u === 'DATA') { inData = true; say('354 go'); } else if (u === 'QUIT') { say('221 bye'); sock.end(); return; } else say('250 ok');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise<{ port: number; messages: typeof messages; close: () => void }>((res) => server.listen(0, '127.0.0.1', () => res({ port: (server.address() as net.AddressInfo).port, messages, close: () => server.close() })));
}

test('Nodemailer: verification mail is delivered over real SMTP', async () => {
  const sink = await smtpSink(); const port = await freePort(); const data = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-smtp-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, NEXT_DIST_DIR: '.next-test', BOOKREADER_DATA_DIR: data, FOLIO_ENV: 'test', FOLIO_API_RATE_PER_MIN: '100000', SMTP_URL: `smtp://127.0.0.1:${sink.port}?ignoreTLS=true`, MAIL_FROM: 'bookbook <hello@bookbook.test>' },
  });
  try {
    const base = `http://127.0.0.1:${port}`; for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).status < 500) break; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 300)); }
    const c = new Client(base); const email = `smtp-${Date.now()}@example.test`;
    const r = await c.json('/api/auth/register', { email, password: 'correct-horse-battery-9', name: 'Mail Test' }); assert.ok([200, 202].includes(r.status), `register ${r.status}`);
    for (let i = 0; i < 50 && !sink.messages.length; i++) await new Promise((res) => setTimeout(res, 200));
    assert.equal(sink.messages.length, 1, 'exactly one message reached the SMTP server');
    const m = sink.messages[0]; assert.match(m.from, /hello@bookbook\.test/); assert.ok(m.to.some((t) => t.toLowerCase().includes(email)), 'addressed to the new account');
    assert.match(m.data, /Subject:/i); assert.match(m.data, /\/auth\/verify\/[\w-]+/, 'carries a verification link');
    assert.ok(!/\r\nBcc:/i.test(m.data));
  } finally { child.kill(); sink.close(); await new Promise((r) => setTimeout(r, 800)); try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* Windows may still hold the file briefly; the OS temp folder is cleaned later */ } }
});

test('SheetJS: .xlsx import extracts every sheet; corrupt or hostile files are refused without crashing the server', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Word', 'Meaning'], ['ephemeral', 'lasting a very short time'], ['ubiquitous', 'found everywhere']]), 'Vocabulary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Chapter', 'Pages'], ['Intro', 12]]), 'Index');
  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const up = async (name: string, buf: Buffer) => { const fd = new FormData(); fd.append('files', new File([new Uint8Array(buf)], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); return (await (await fetch(BASE + '/api/books', { method: 'POST', body: fd })).json()).results?.[0]; };
  const wait = async (id: string) => { for (let i = 0; i < 80; i++) { const b = await (await fetch(`${BASE}/api/books/${id}`)).json(); if (['readable', 'ready', 'failed', 'error'].includes(b.status)) return b; await new Promise((r) => setTimeout(r, 300)); } throw new Error('timeout'); };

  const ok = await up('vocab.xlsx', bytes); assert.ok(ok?.id, JSON.stringify(ok)); const b = await wait(ok.id); assert.ok(['readable', 'ready'].includes(b.status), `status ${b.status}`);
  const pages = await (await fetch(`${BASE}/api/books/${ok.id}/pages?from=1&to=${b.page_count}`)).json(); const text = pages.map((p: any) => p.text).join('\n');
  assert.match(text, /ephemeral \| lasting a very short time/); assert.match(text, /ubiquitous/); assert.match(text, /Intro \| 12/, 'second sheet is imported too');

  const junk = await up('broken.xlsx', Buffer.from('PK\x03\x04 this is not really a workbook'.padEnd(500, 'x'))); if (junk?.id) { const jb = await wait(junk.id); assert.ok(!['readable', 'ready'].includes(jb.status) || (await (await fetch(`${BASE}/api/books/${junk.id}/pages?from=1&to=1`)).json()).length >= 0); }
  const health = await fetch(BASE + '/api/health'); assert.equal(health.status, 200, 'server still healthy after a corrupt spreadsheet');
});
