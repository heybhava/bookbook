// Browser side of authentication: every same-origin /api write carries the session's CSRF token, and a 401 tells the app to show the sign-in screen.
'use client';
const w = typeof window !== 'undefined' ? (window as any) : null;
export const csrfToken = (): string => { if (typeof document === 'undefined') return ''; const m = /(?:^|;\s*)(?:__Host-)?folio_csrf=([^;]+)/.exec(document.cookie); return m ? decodeURIComponent(m[1]) : (w?.__folioCsrf ?? ''); };
export const setCsrf = (t: string) => { if (w) w.__folioCsrf = t; };

if (w && !w.__folioFetchPatched) {
  w.__folioFetchPatched = true;
  const orig = w.fetch.bind(w);
  w.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const local = url.startsWith('/api/') || url.startsWith(location.origin + '/api/');
    if (local) {
      const method = (init.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')).toUpperCase();
      const headers = new Headers(init.headers ?? (typeof input === 'object' && 'headers' in input ? (input as Request).headers : undefined));
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers.has('x-csrf-token')) { const t = csrfToken(); if (t) headers.set('x-csrf-token', t); }
      init = { ...init, headers, credentials: 'same-origin' };
    }
    const res: Response = await orig(input, init);
    if (local && res.status === 401 && !url.includes('/api/auth/')) w.dispatchEvent(new Event('folio:unauthorized'));
    return res;
  };
}
