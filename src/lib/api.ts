export class ApiError extends Error { constructor(msg: string, public status: number, public code?: string, public body?: any) { super(msg); } }

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const headers: Record<string, string> = {};
  let body = init?.body;
  if (init?.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
  const r = await fetch('/api' + path, { ...init, headers: { ...headers, ...(init?.headers as any) }, body });
  if (!r.ok) {
    let msg = r.statusText, code: string | undefined, jb: any;
    try { const j = await r.json(); msg = j.error ?? msg; code = j.code; jb = j; } catch { /* non-json */ }
    throw new ApiError(msg, r.status, code, jb);
  }
  const ct = r.headers.get('content-type') ?? '';
  return (ct.includes('json') ? r.json() : r.text()) as Promise<T>;
}
export const post = <T = any>(p: string, json?: unknown) => api<T>(p, { method: 'POST', json: json ?? {} });
export const put = <T = any>(p: string, json?: unknown) => api<T>(p, { method: 'PUT', json });
export const patch = <T = any>(p: string, json?: unknown) => api<T>(p, { method: 'PATCH', json });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

/** Read an NDJSON stream, calling onEvent for each line. */
export async function ndjson(path: string, json: unknown, onEvent: (e: any) => void, signal?: AbortSignal) {
  const r = await fetch('/api' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json), signal });
  if (!r.ok || !r.body) {
    let msg = r.statusText, code: string | undefined;
    try { const j = await r.json(); msg = j.error ?? msg; code = j.code; } catch { /* */ }
    throw new ApiError(msg, r.status, code);
  }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { onEvent(JSON.parse(l)); } catch { /* partial */ } } }
  }
}
