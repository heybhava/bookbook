// Vault API: files on disk are the source of truth; everything else is an index over them.
import fs from 'node:fs';
import path from 'node:path';
import type { Kit } from './routes2';
import * as V from './vault/store';
import { renderMarkdown } from './vault/render';
import { parseNote } from './vault/parse';
import * as B from './vault/bases';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', pdf: 'application/pdf', md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', json: 'application/json', canvas: 'application/json', base: 'text/plain; charset=utf-8' };

export function registerVault({ on, J, bad, body }: Kit) {
  /** Wrap a handler: resolve the vault, scan for external changes, turn VaultError into a JSON error. */
  const vault = (h: (c: { v: V.Vault; req: any; p: Record<string, string>; q: URLSearchParams; b?: any }) => unknown, o: { method?: 'body' | 'none'; scan?: boolean } = {}) => async (c: any) => {
    try {
      const b = o.method === 'body' ? await body(c.req) : undefined;
      const v = V.getVault(c.q.get('vault') ?? b?.vault);
      if (o.scan !== false) V.scan(v);
      return await h({ ...c, v, b });
    } catch (e: any) {
      if (e instanceof V.VaultError) return J({ error: e.message, ...(e.extra as object ?? {}) }, e.status);
      throw e;
    }
  };
  const need = (s: string | null | undefined, what = 'path') => { if (!s) throw new V.VaultError(`${what} required`); return s; };

  // ── registry ──
  on('GET', '/vaults', () => V.listVaults().map((v) => ({ ...v, exists: fs.existsSync(v.root) })));
  on('POST', '/vaults', async ({ req }) => { try { const b = await body(req); const v = V.createVault(String(b.name ?? ''), b.path ? String(b.path) : undefined, !!b.existing); return { ...v, stats: V.stats(v) }; } catch (e: any) { if (e instanceof V.VaultError) return bad(e.message, e.status); throw e; } });
  on('POST', '/vaults/import', async ({ req }) => { try { const fd = await req.formData(); const f = fd.get('file'); if (!(f instanceof File)) return bad('A .zip file is required.'); if (f.size > 500 * 1048576) return bad('Archive is larger than 500 MB.', 413); const r = await V.importZip(String(fd.get('name') ?? f.name.replace(/\.zip$/i, '') ?? 'Imported'), Buffer.from(await f.arrayBuffer())); return { ...r.vault, files: r.files, skipped: r.skipped, stats: r.stats }; } catch (e: any) { if (e?.status) return bad(e.message, e.status); throw e; } });
  on('PATCH', '/vaults/:id', async ({ req, p }) => { try { const b = await body(req); V.renameVault(p.id, String(b.name ?? '')); return { ok: true }; } catch (e: any) { if (e instanceof V.VaultError) return bad(e.message, e.status); throw e; } });
  on('DELETE', '/vaults/:id', ({ p }) => { V.forgetVault(p.id); return { ok: true, note: 'The folder and its files were left untouched.' }; });

  // ── tree / scan ──
  on('GET', '/vault/tree', vault(({ v }) => { V.touchVault(v.id); return { vault: v, files: V.listFiles(v), folders: V.listFolders(v), stats: V.stats(v) }; }));
  on('POST', '/vault/scan', vault(({ v }) => ({ ...V.scan(v, { full: true }), stats: V.stats(v) }), { scan: false }));

  // ── files ──
  on('GET', '/vault/file', vault(({ v, q }) => V.readFile(v, need(q.get('path')))));
  on('PUT', '/vault/file', vault(({ v, b }) => V.writeFile(v, need(b.path), String(b.text ?? ''), { baseHash: b.baseHash ?? null, create: !!b.create }), { method: 'body', scan: false }));
  on('POST', '/vault/folder', vault(({ v, b }) => { V.makeFolder(v, need(b.path)); return { ok: true }; }, { method: 'body', scan: false }));
  on('POST', '/vault/move', vault(({ v, b }) => V.movePath(v, need(b.from, 'from'), need(b.to, 'to')), { method: 'body' }));
  on('DELETE', '/vault/file', vault(({ v, q }) => V.deletePath(v, need(q.get('path'))), { scan: false }));
  on('POST', '/vault/create-note', vault(({ v, b }) => {
    const name = String(b.name ?? 'Untitled').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\.md$/i, '').trim() || 'Untitled'; const folder = String(b.folder ?? '').replace(/^\/+|\/+$/g, '');
    let rel = (folder ? folder + '/' : '') + name + '.md'; for (let i = 2; fs.existsSync(V.safePath(v, rel)); i++) rel = `${folder ? folder + '/' : ''}${name} ${i}.md`;
    return V.writeFile(v, rel, typeof b.content === 'string' ? b.content : '', { create: true });
  }, { method: 'body', scan: false }));
  on('POST', '/vault/upload', async ({ req, q }) => {
    try { const v = V.getVault(q.get('vault')); const rel = need(q.get('path')); return V.writeBinary(v, rel, Buffer.from(await req.arrayBuffer())); } catch (e: any) { if (e instanceof V.VaultError) return J({ error: e.message }, e.status); throw e; }
  });
  on('GET', '/vault/raw', vault(({ v, q }) => {
    const rel = need(q.get('path')); const full = V.safePath(v, rel); if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new V.VaultError('Not found', 404);
    const ext = path.extname(rel).slice(1).toLowerCase(); const buf = fs.readFileSync(full);
    // user files are untrusted: never let an SVG/HTML attachment run script in the app's origin
    return new Response(new Uint8Array(buf), { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream', 'content-length': String(buf.length), 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" } });
  }, { scan: false }));

  // ── rendering ──
  on('POST', '/vault/render', vault(({ v, b }) => {
    const rel = need(b.path); const text = typeof b.text === 'string' ? b.text : V.readFile(v, rel).text;
    return { html: renderMarkdown(text, rel, { vault: v, depth: 0, seen: new Set([rel]) }) };
  }, { method: 'body', scan: false }));
  on('GET', '/vault/headings', vault(({ v, q }) => { const f = V.readFile(v, need(q.get('path'))); return parseNote(f.text).headings; }, { scan: false }));

  // ── relationships ──
  on('GET', '/vault/backlinks', vault(({ v, q }) => V.backlinks(v, need(q.get('path')))));
  on('GET', '/vault/outgoing', vault(({ v, q }) => V.outgoing(v, need(q.get('path')))));
  on('GET', '/vault/unresolved', vault(({ v }) => V.unresolvedLinks(v)));
  on('POST', '/vault/link-mention', vault(({ v, b }) => V.linkUnmentioned(v, need(b.src, 'src'), need(b.target, 'target'), Number(b.line), String(b.term ?? '')), { method: 'body' }));
  on('GET', '/vault/graph', vault(({ v, q }) => V.graph(v, { center: q.get('center') ?? undefined, depth: Number(q.get('depth')) || 1, tag: q.get('tag') ?? undefined, folder: q.get('folder') ?? undefined, orphans: q.get('orphans') !== '0', attachments: q.get('attachments') === '1', unresolved: q.get('unresolved') !== '0' })));

  // ── tags & properties ──
  on('GET', '/vault/tags', vault(({ v }) => V.tagTree(v)));
  on('GET', '/vault/tag-files', vault(({ v, q }) => V.filesWithTag(v, need(q.get('tag'), 'tag').replace(/^#/, ''))));
  on('GET', '/vault/props', vault(({ v }) => V.propSummary(v)));
  on('GET', '/vault/props/file', vault(({ v, q }) => V.fileProps(v, need(q.get('path')))));
  on('PUT', '/vault/props/file', vault(({ v, b }) => V.setProps(v, need(b.path), { set: b.set, remove: b.remove, rename: b.rename, raw: b.raw, baseHash: b.baseHash }), { method: 'body', scan: false }));

  // ── search ──
  on('GET', '/vault/search', vault(({ v, q }) => V.search(v, q.get('q') ?? '', { limit: Number(q.get('limit')) || 100, folder: q.get('folder') ?? undefined, sort: (q.get('sort') as any) ?? 'relevance' })));
  on('GET', '/vault/switch', vault(({ v, q }) => V.quickSwitch(v, q.get('q') ?? '')));

  // ── bases ──
  const loadCfg = (v: V.Vault, b: any): { cfg: B.BaseCfg; hash?: string } => {
    if (b.config) return { cfg: b.config as B.BaseCfg, hash: undefined };
    const l = B.loadBase(v, need(b.path)); if (l.error) throw new V.VaultError(`The .base file has invalid YAML: ${l.error}`); return { cfg: l.config, hash: l.hash };
  };
  on('GET', '/vault/base', vault(({ v, q }) => { const l = B.loadBase(v, need(q.get('path'))); return { config: l.config, error: l.error, raw: l.raw, hash: l.hash }; }, { scan: false }));
  on('PUT', '/vault/base', vault(({ v, b }) => B.saveBase(v, need(b.path), b.config, b.baseHash), { method: 'body', scan: false }));
  on('POST', '/vault/base/new', vault(({ v, b }) => {
    const name = String(b.name ?? 'Untitled').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\.base$/i, '').trim() || 'Untitled'; const folder = String(b.folder ?? '').replace(/^\/+|\/+$/g, '');
    let rel = (folder ? folder + '/' : '') + name + '.base'; for (let i = 2; fs.existsSync(V.safePath(v, rel)); i++) rel = `${folder ? folder + '/' : ''}${name} ${i}.base`;
    return V.writeFile(v, rel, B.defaultBase(['books', 'highlights'].includes(b.source) ? b.source : 'notes'), { create: true });
  }, { method: 'body', scan: false }));
  on('POST', '/vault/base/query', vault(({ v, b }) => { try { return B.runBase(v, loadCfg(v, b).cfg, Number(b.view) || 0); } catch (e: any) { if (e instanceof V.VaultError) throw e; throw new V.VaultError(e.message); } }, { method: 'body' }));
  on('GET', '/vault/base/csv', vault(({ v, q }) => {
    const r = B.runBase(v, B.loadBase(v, need(q.get('path'))).config, Number(q.get('view')) || 0);
    return new Response(B.toCsv(r), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${(q.get('path') ?? 'base').split('/').pop()!.replace(/\.base$/, '').replace(/[^\w .-]/g, '_')}.csv"`, 'x-content-type-options': 'nosniff' } });
  }));
  // edit a record's property in its own note (the note stays the single source of truth)
  on('POST', '/vault/base/set', vault(({ v, b }) => {
    const p = need(b.path, 'record'); if (!/\.md$/i.test(p)) throw new V.VaultError('Only notes can be edited from a base.');
    const key = String(b.key ?? '').replace(/^note\./, ''); if (!key || /^(file|formula)\./.test(String(b.key))) throw new V.VaultError('Only note properties can be edited; file fields and formulas are computed.');
    return b.value === null || b.value === '' ? V.setProps(v, p, { remove: [key] }) : V.setProps(v, p, { set: { [key]: b.value } });
  }, { method: 'body', scan: false }));
  on('POST', '/vault/base/create', vault(({ v, b }) => {
    const { cfg } = loadCfg(v, b); if ((cfg.source ?? 'notes') !== 'notes') throw new V.VaultError('Records can only be created in note-based bases.');
    const view = cfg.views[Number(b.view) || 0] ?? cfg.views[0]; const pre = B.prefillFor(cfg, view);
    const folder = String(b.folder ?? pre.folder ?? '').replace(/^\/+|\/+$/g, ''); const name = String(b.name ?? 'Untitled').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim() || 'Untitled';
    const props: Record<string, unknown> = { ...pre.props, ...(b.props ?? {}) }; if (view.groupBy?.property && b.group !== undefined && b.group !== null) props[view.groupBy.property.replace(/^note\./, '')] = b.group;
    let rel = (folder ? folder + '/' : '') + name + '.md'; for (let i = 2; fs.existsSync(V.safePath(v, rel)); i++) rel = `${folder ? folder + '/' : ''}${name} ${i}.md`;
    const r = V.writeFile(v, rel, '', { create: true });
    const set = { ...props, ...(pre.tags.length ? { tags: pre.tags } : {}) }; if (Object.keys(set).length) V.setProps(v, rel, { set });
    return { ...r, path: rel };
  }, { method: 'body' }));

  // ── history ──
  on('GET', '/vault/history', vault(({ v, q }) => V.history(v, need(q.get('path'))), { scan: false }));
  on('GET', '/vault/history/:id', vault(({ v, p }) => V.historyText(v, p.id), { scan: false }));
  on('POST', '/vault/history/:id/restore', vault(({ v, p }) => V.restore(v, p.id), { scan: false }));
}
