// Security configuration, all from environment variables with safe defaults.
import { FOLIO_ENV } from '../tenant';

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const bool = (v: string | undefined, d: boolean) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const cfg = {
  env: FOLIO_ENV,
  publicUrl: process.env.FOLIO_PUBLIC_URL?.replace(/\/$/, '') || '',
  get secureCookies() { return bool(process.env.FOLIO_SECURE_COOKIES, FOLIO_ENV === 'production' || this.publicUrl.startsWith('https://')); },
  sessionIdleSec: num(process.env.FOLIO_SESSION_IDLE_SECONDS, 14 * 86400),
  sessionAbsSec: num(process.env.FOLIO_SESSION_ABSOLUTE_SECONDS, 30 * 86400),
  requireVerification: bool(process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION, true),
  allowRegistration: bool(process.env.FOLIO_ALLOW_REGISTRATION, true),
  trustProxy: bool(process.env.FOLIO_TRUST_PROXY, false),
  smtpUrl: process.env.SMTP_URL || '',
  mailFrom: process.env.MAIL_FROM || 'bookbook <no-reply@localhost>',
  adminEmails: (process.env.FOLIO_ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  allowLocalVaultPaths: bool(process.env.FOLIO_ALLOW_LOCAL_VAULT_PATHS, false), // admin-only even when on
  quotaBytes: num(process.env.FOLIO_USER_QUOTA_MB, 5000) * 1048576,
  apiPerMinute: num(process.env.FOLIO_API_RATE_PER_MIN, 1500),
  aiConcurrencyPerUser: num(process.env.FOLIO_AI_PER_USER, 1),
  aiConcurrencyGlobal: num(process.env.FOLIO_AI_GLOBAL, 2),
  jobConcurrency: num(process.env.FOLIO_JOB_CONCURRENCY, 2),
  maxZipEntries: num(process.env.FOLIO_ZIP_MAX_ENTRIES, 20000),
  maxZipBytes: num(process.env.FOLIO_ZIP_MAX_UNCOMPRESSED_MB, 2000) * 1048576,
  maxZipRatio: num(process.env.FOLIO_ZIP_MAX_RATIO, 200),
  devEndpoints: FOLIO_ENV !== 'production', // /api/dev/* (mail outbox) exist only outside production
};

const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'];
const hostOnly = (h: string) => { const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(h.trim().toLowerCase()); return m ? m[1] : h.trim().toLowerCase(); };
export function allowedHosts(): Set<string> {
  const s = new Set<string>(loopback);
  for (const h of (process.env.FOLIO_ALLOWED_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean)) s.add(hostOnly(h));
  if (cfg.publicUrl) { try { s.add(new URL(cfg.publicUrl).hostname.toLowerCase()); } catch { /* ignore */ } }
  return s;
}
/** Is the Host header one this deployment answers to? Blocks DNS-rebinding and host-header poisoning. */
export const hostAllowed = (hostHeader: string | null | undefined): boolean => !!hostHeader && allowedHosts().has(hostOnly(hostHeader));
