// Edge middleware: Host allow-list (DNS-rebinding / host-header poisoning) and security headers for every response.
import { NextResponse, type NextRequest } from 'next/server';

const prod = process.env.FOLIO_ENV === 'production' || (!process.env.FOLIO_ENV && process.env.NODE_ENV === 'production');
const hostOnly = (h: string) => { const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(h.trim().toLowerCase()); return m ? m[1] : h.trim().toLowerCase(); };
function allowed(): Set<string> {
  const s = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  for (const h of (process.env.FOLIO_ALLOWED_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean)) s.add(hostOnly(h));
  try { if (process.env.FOLIO_PUBLIC_URL) s.add(new URL(process.env.FOLIO_PUBLIC_URL).hostname.toLowerCase()); } catch { /* ignore */ }
  return s;
}
const https = (process.env.FOLIO_PUBLIC_URL || '').startsWith('https://');

export function middleware(req: NextRequest) {
  const host = req.headers.get('host');
  if (!host || !allowed().has(hostOnly(host))) return new NextResponse('Unknown host', { status: 421 });
  const res = NextResponse.next();
  const isApi = req.nextUrl.pathname.startsWith('/api/');
  const csp = [
    "default-src 'self'", `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${prod ? '' : " 'unsafe-eval'"}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "media-src 'self' blob:",
    "font-src 'self' data:", "connect-src 'self'", "worker-src 'self' blob:", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join('; ');
  if (!isApi) res.headers.set('Content-Security-Policy', csp); // API routes set their own (e.g. user attachments are served with `sandbox`); the page policy must not overwrite it
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'same-origin');
  res.headers.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
  res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (https || prod) res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.nextUrl.pathname.startsWith('/api/')) res.headers.set('Cache-Control', 'no-store');
  return res;
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
