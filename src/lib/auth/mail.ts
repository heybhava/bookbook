// Outgoing mail. Production: SMTP via SMTP_URL (any provider, including a free/self-hosted one). Development/test: written to an outbox folder, readable via /api/dev/outbox.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../tenant';
import { cfg } from './config';

export interface Mail { to: string; subject: string; text: string }
const outboxDir = () => { const d = path.join(DATA_DIR, 'system', 'outbox'); fs.mkdirSync(d, { recursive: true }); return d; };
export const mailConfigured = () => !!cfg.smtpUrl || cfg.env !== 'production';

export async function sendMail(m: Mail): Promise<void> {
  if (cfg.smtpUrl) {
    const nodemailer = (await import('nodemailer')).default;
    await nodemailer.createTransport(cfg.smtpUrl).sendMail({ from: cfg.mailFrom, to: m.to, subject: m.subject, text: m.text });
    return;
  }
  if (cfg.env === 'production') throw new Error('SMTP_URL is not configured');
  fs.writeFileSync(path.join(outboxDir(), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`), JSON.stringify({ ...m, at: new Date().toISOString() }, null, 1)); // dev/test only
}
export function readOutbox(to?: string): (Mail & { at: string })[] {
  if (cfg.env === 'production') return [];
  const d = outboxDir();
  return fs.readdirSync(d).sort().map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))).filter((x) => !to || x.to.toLowerCase() === to.toLowerCase());
}
export const linkBase = (req: { headers: Headers }) => cfg.publicUrl || `${req.headers.get('x-forwarded-proto') && cfg.trustProxy ? req.headers.get('x-forwarded-proto') : 'http'}://${req.headers.get('host')}`;
