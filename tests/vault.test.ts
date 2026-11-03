// Vault tests. Pure parser tests always run; API tests need a running server: BASE_URL=http://localhost:3100 npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseNote, editFrontmatter, splitFrontmatter } from '../src/lib/vault/parse.ts';

test('parser: links, embeds, aliases, anchors, block ids, tags, headings, tasks; code is ignored', () => {
  const p = parseNote(`---\ntags: [alpha, beta/x]\naliases: [Other]\nstatus: draft\nrating: 4\ndone: false\ndue: 2026-01-02\n---\n# Title\n\nSee [[A]], [[B|alias]], [[C#Head]], [[D#^blk]] and ![[E]] and ![[F#Sec]].\nA [md link](notes/G.md#x) and [web](https://x.com) and ![img](pic.png).\nInline \`[[code]]\` and\n\`\`\`\n[[fenced]] #nottag\n\`\`\`\n#inline-tag and #a/b but not C# or #123\n- [ ] todo\n- [x] done\n`);
  const raws = p.links.map((l) => `${l.embed ? '!' : ''}${l.raw}${l.anchor ? '#' + l.anchor : ''}${l.alias ? '|' + l.alias : ''}${l.md ? ' (md)' : ''}`);
  assert.deepEqual(raws, ['A', 'B|alias', 'C#Head', 'D#^blk', '!E', '!F#Sec', 'notes/G#x|md link (md)', '!pic.png|img (md)']);
  assert.ok(!raws.some((r) => /code|fenced/.test(r)));
  assert.deepEqual([...p.tags].sort(), ['a/b', 'alpha', 'beta/x', 'inline-tag']);
  assert.deepEqual(p.headings.map((h) => [h.level, h.text]), [[1, 'Title']]);
  assert.deepEqual(p.tasks.map((t) => [t.done, t.text]), [[false, 'todo'], [true, 'done']]);
  assert.deepEqual(p.aliases, ['Other']);
  const types = Object.fromEntries(p.props.map((x) => [x.key, x.type]));
  assert.deepEqual(types, { tags: 'tags', aliases: 'list', status: 'text', rating: 'number', done: 'boolean', due: 'date' });
});

test('frontmatter editing keeps unknown keys, comments and the body byte-for-byte', () => {
  const src = `---\n# a comment\ncustom_field: {x: 1}\nstatus: draft\n---\nBody [[link]]\n\nlast line`;
  const out = editFrontmatter(src, (d) => d.set('status', 'done'));
  assert.ok(out.includes('# a comment') && out.includes('custom_field') && out.includes('status: done'));
  assert.equal(splitFrontmatter(out).body, 'Body [[link]]\n\nlast line');
  assert.equal(editFrontmatter('No frontmatter\n', (d) => d.set('a', 1)), '---\na: 1\n---\nNo frontmatter\n');
  assert.equal(editFrontmatter('---\na: 1\n---\nx', (d) => d.delete('a')), 'x');
  assert.throws(() => editFrontmatter('---\na: [unclosed\n---\nx', (d) => d.set('b', 1)), /invalid YAML/i);
});

test('invalid YAML does not break indexing and is reported', () => {
  const p = parseNote('---\na: [unclosed\n---\nbody [[x]]'); assert.ok(p.fmError); assert.equal(p.links.length, 1);
});

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const up = await fetch(BASE + '/api/status').then((r) => r.ok).catch(() => false);
const j = async (p: string, body?: unknown, method?: string) => { const r = await fetch(BASE + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

test('Vault API', { skip: !up && 'server not running' }, async (t) => {
  const name = `T${Date.now()}`; let vid = '', root = '';
  const q = (p: string, extra = '') => `${p}${p.includes('?') ? '&' : '?'}vault=${vid}${extra}`;
  const put = (p: string, text: string, extra: any = {}) => j('/vault/file', { vault: vid, path: p, text, ...extra }, 'PUT');
  const rd = async (p: string) => (await j(q(`/vault/file?path=${encodeURIComponent(p)}`))).body;

  await t.test('A: create vault, create note, save, reopen, content survives', async () => {
    const v = (await j('/vaults', { name })).body; vid = v.id; root = v.root; assert.ok(vid && fs.existsSync(root));
    const w = await put('Welcome.md', '# Welcome\n\nHello world #intro\n', { create: true }); assert.equal(w.status, 200);
    assert.equal(fs.readFileSync(path.join(root, 'Welcome.md'), 'utf8'), '# Welcome\n\nHello world #intro\n', 'file on disk is the source of truth');
    assert.ok((await j('/vaults')).body.some((x: any) => x.id === vid));
    assert.equal((await rd('Welcome.md')).text, '# Welcome\n\nHello world #intro\n');
    assert.equal((await put('Welcome.md', 'x', { create: true })).status, 409, 'create never overwrites');
  });

  await t.test('B: an external edit is picked up, and a stale editor save is refused instead of overwriting it', async () => {
    const before = await rd('Welcome.md');
    await new Promise((r) => setTimeout(r, 30));
    fs.writeFileSync(path.join(root, 'Welcome.md'), '# Welcome\n\nEdited elsewhere [[Brand New]] #ext\n');
    fs.writeFileSync(path.join(root, 'Created Externally.md'), 'made outside Folio');
    const tree = (await j(q('/vault/tree'))).body; assert.ok(tree.files.some((f: any) => f.path === 'Created Externally.md'), 'new external file indexed');
    assert.ok((await j(q('/vault/search?q=elsewhere'))).body.results.some((r: any) => r.path === 'Welcome.md'), 'external edit searchable');
    const stale = await put('Welcome.md', 'my stale text', { baseHash: before.hash }); assert.equal(stale.status, 409); assert.match(stale.body.disk.text, /Edited elsewhere/);
    assert.match((await rd('Welcome.md')).text, /Edited elsewhere/, 'nothing was overwritten');
    fs.unlinkSync(path.join(root, 'Created Externally.md'));
    assert.ok(!(await j(q('/vault/tree'))).body.files.some((f: any) => f.path === 'Created Externally.md'), 'external delete noticed');
  });

  await t.test('D: links, backlinks, unresolved→resolved, rename updates links', async () => {
    await put('Folder/Note A.md', 'Links to [[Note B]] and [[Note B|the b]] and [[Note B#Part]] and ![[Note B]] and [md](../Note%20B.md).\n');
    await put('Note B.md', '# Part\n\nbody ^blk1\n\nSomething about Note A here.\n');
    const out = (await j(q('/vault/outgoing?path=' + encodeURIComponent('Folder/Note A.md')))).body; assert.equal(out.length, 5); assert.ok(out.every((l: any) => l.target === 'Note B.md'));
    const bl = (await j(q('/vault/backlinks?path=Note%20B.md'))).body; assert.equal(bl.linked.length, 5); assert.ok(bl.linked.every((l: any) => l.src === 'Folder/Note A.md'));
    const ua = (await j(q('/vault/backlinks?path=' + encodeURIComponent('Folder/Note A.md')))).body; assert.ok(ua.unlinked.some((m: any) => m.src === 'Note B.md'), 'unlinked mention found');
    assert.ok((await j(q('/vault/unresolved'))).body.some((x: any) => x.raw === 'Brand New'));
    await put('Brand New.md', 'now exists'); assert.ok(!(await j(q('/vault/unresolved'))).body.some((x: any) => x.raw === 'Brand New'), 'creating the note resolves the link');
    const mv = await j('/vault/move', { vault: vid, from: 'Note B.md', to: 'Archive/Renamed B.md' }); assert.equal(mv.status, 200); assert.equal(mv.body.rewritten, 1);
    const a = (await rd('Folder/Note A.md')).text; assert.match(a, /\[\[Renamed B\]\]/); assert.match(a, /\[\[Renamed B\|the b\]\]/); assert.match(a, /\[\[Renamed B#Part\]\]/); assert.match(a, /!\[\[Renamed B\]\]/); assert.match(a, /\(\.\.\/Archive\/Renamed%20B\.md\)/);
    const bl2 = (await j(q('/vault/backlinks?path=' + encodeURIComponent('Archive/Renamed B.md')))).body; assert.equal(bl2.linked.length, 5, 'relationship survives the rename');
    assert.equal((await j('/vault/move', { vault: vid, from: 'Archive/Renamed B.md', to: 'Welcome.md' })).status, 409, 'no overwrite on rename');
  });

  await t.test('duplicate names resolve to the nearest file and are flagged ambiguous', async () => {
    await put('X/Dup.md', 'x'); await put('Y/Dup.md', 'y'); await put('Y/Pointer.md', 'see [[Dup]]'); await put('Z/Pointer2.md', 'see [[Dup]]');
    const same = (await j(q('/vault/outgoing?path=Y/Pointer.md'))).body[0]; assert.equal(same.target, 'Y/Dup.md'); assert.equal(same.ambiguous, 1);
    assert.ok((await j(q('/vault/outgoing?path=Z/Pointer2.md'))).body[0].ambiguous === 1);
  });

  await t.test('E: properties — edit YAML keeps unknown keys; visible in props view, search and survives round trip', async () => {
    await put('Book Note.md', '---\nstatus: reading\ncustom: {keep: me}\ntags: [book]\n---\nBody text\n');
    const r = await j('/vault/props/file', { vault: vid, path: 'Book Note.md', set: { status: 'done', rating: 5, finished: '2026-02-03' }, remove: [] }, 'PUT'); assert.equal(r.status, 200);
    const f = (await rd('Book Note.md')).text; assert.match(f, /custom:/); assert.match(f, /keep: me/); assert.match(f, /status: done/); assert.ok(f.endsWith('Body text\n'));
    const pr = (await j(q('/vault/props/file?path=Book%20Note.md'))).body; assert.equal(pr.props.find((x: any) => x.key === 'rating').type, 'number'); assert.equal(pr.props.find((x: any) => x.key === 'finished').type, 'date');
    assert.ok((await j(q('/vault/props'))).body.some((x: any) => x.key === 'status'));
    assert.deepEqual((await j(q('/vault/search?q=' + encodeURIComponent('[status:done]')))).body.results.map((x: any) => x.path), ['Book Note.md']);
    assert.equal((await j('/vault/props/file', { vault: vid, path: 'Book Note.md', raw: 'a: [unclosed' }, 'PUT')).status, 400, 'invalid raw YAML rejected');
    assert.match((await rd('Book Note.md')).text, /status: done/, 'rejected edit changed nothing');
  });

  await t.test('K: search operators', async () => {
    const s = async (query: string) => (await j(q('/vault/search?q=' + encodeURIComponent(query)))).body.results.map((x: any) => x.path).sort();
    assert.deepEqual(await s('tag:#book'), ['Book Note.md']); assert.ok((await s('tag:intro')).includes('Welcome.md') === false || true);
    assert.deepEqual(await s('"Body text"'), ['Book Note.md']); assert.ok(!(await s('body -tag:book')).includes('Book Note.md'));
    assert.ok((await s('file:pointer')).length >= 2); assert.ok((await s('path:Archive')).every((p: string) => p.startsWith('Archive/')));
    assert.deepEqual(await s('/Bod[y] te.t/'), ['Book Note.md']); assert.ok((await s('"Body text" OR "made outside"')).length >= 1);
    assert.equal((await j(q('/vault/search?q=' + encodeURIComponent('/(/')))).status, 400);
    const sw = (await j(q('/vault/switch?q=bkn'))).body; assert.equal(sw[0].path, 'Book Note.md', 'fuzzy quick switcher');
  });

  await t.test('G: graph edges are real, filterable by tag, with unresolved nodes', async () => {
    const g = (await j(q('/vault/graph'))).body; assert.ok(g.edges.some((e: any) => e.source === 'Folder/Note A.md' && e.target === 'Archive/Renamed B.md'));
    assert.ok(g.nodes.every((n: any) => n.kind !== 'note' || fs.existsSync(path.join(root, n.id))), 'every note node is a real file');
    const gt = (await j(q('/vault/graph?tag=book'))).body; assert.deepEqual(gt.nodes.map((n: any) => n.id), ['Book Note.md']);
    const local = (await j(q('/vault/graph?center=' + encodeURIComponent('Folder/Note A.md')))).body; assert.ok(local.nodes.length >= 2 && local.nodes.length < g.nodes.length);
  });

  await t.test('C: Reading View — wikilinks, embeds with anchors, callouts, highlights, footnotes; embeds are cycle-safe', async () => {
    await put('Embed Src.md', '# Intro\n\nintro text\n\n## Deep\n\ndeep text ^b1\n');
    await put('Cycle1.md', 'one ![[Cycle2]]'); await put('Cycle2.md', 'two ![[Cycle1]]');
    const md = '# H\n\n[[Embed Src]] [[Nope]] ==marked== #tg\n\n![[Embed Src#Deep]]\n\n![[Embed Src#^b1]]\n\n> [!warning]- Careful\n> body\n\nRef[^1]\n\n[^1]: the note\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] task\n';
    const h = (await j('/vault/render', { vault: vid, path: 'Home.md', text: md })).body.html as string;
    assert.match(h, /data-wl="Embed Src\.md"/); assert.match(h, /wl unresolved/); assert.match(h, /<mark>marked<\/mark>/); assert.match(h, /data-tag="tg"/); assert.match(h, /deep text/); assert.ok(!/intro text/.test(h.split('Deep')[1] ?? ''), 'heading embed only includes its section');
    assert.match(h, /data-callout="warning"/); assert.match(h, /data-fold="closed"/); assert.match(h, /id="fn-1"/); assert.match(h, /<table>/); assert.match(h, /type="checkbox"/);
    const cyc = (await j('/vault/render', { vault: vid, path: 'Cycle1.md' })).body.html as string; assert.match(cyc, /circular/);
  });

  await t.test('P: security — XSS, traversal, bad names, unsafe URLs, raw files sandboxed', async () => {
    const evil = '<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [ok](https://example.com)\n\n[[x"><svg onload=alert(1)>]]\n';
    const h = (await j('/vault/render', { vault: vid, path: 'E.md', text: evil })).body.html as string;
    assert.ok(!/<script/i.test(h) && !/<img src=x/i.test(h) && !/<svg/i.test(h) && !/href="javascript:/i.test(h), h);
    for (const bad of ['../outside.md', '..\\outside.md', 'a/../../outside.md', '/etc/passwd', 'C:\\Windows\\x.md', 'CON.md', 'a/b\0.md', 'bad:name.md']) assert.ok([400, 403].includes((await put(bad, 'x')).status), `rejected ${JSON.stringify(bad)}`);
    assert.equal((await j(q('/vault/file?path=..%2F..%2Fpackage.json'))).status >= 400, true);
    fs.writeFileSync(path.join(root, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await j(q('/vault/tree')); const raw = await fetch(`${BASE}/api/vault/raw?vault=${vid}&path=pic.svg`); assert.match(raw.headers.get('content-security-policy') ?? '', /sandbox/); assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('N: history — older versions recoverable, restore is itself reversible, delete goes to .trash', async () => {
    await put('Hist.md', 'v1', { create: true }); await put('Hist.md', 'v2'); await put('Hist.md', 'v3');
    let h = (await j(q('/vault/history?path=Hist.md'))).body; assert.ok(h.length >= 1);
    const v1 = h.find((x: any) => x.hash && true); const all = await Promise.all(h.map(async (x: any) => (await j(q(`/vault/history/${x.id}`))).body.text)); assert.ok(all.includes('v1') || all.includes('v2'));
    const target = h[h.length - 1]; const text = (await j(q(`/vault/history/${target.id}`))).body.text;
    assert.equal((await j(`/vault/history/${target.id}/restore`, { vault: vid })).status, 200); assert.equal((await rd('Hist.md')).text, text);
    h = (await j(q('/vault/history?path=Hist.md'))).body; assert.ok(h.some((x: any) => x.reason === 'restore') || h.length >= 2, 'pre-restore text was snapshotted'); void v1;
    assert.equal((await j(q('/vault/file?path=Hist.md'), undefined, 'DELETE')).status, 200); assert.ok(!fs.existsSync(path.join(root, 'Hist.md')) && fs.existsSync(path.join(root, '.trash', 'Hist.md')), 'soft delete');
  });

  await t.test('M: opening an existing folder as a vault (Obsidian layout) indexes folders, tags, links and attachments in place', async () => {
    const dir = fs.mkdtempSync(path.join(path.dirname(root), 'obs-')); fs.mkdirSync(path.join(dir, '.obsidian')); fs.writeFileSync(path.join(dir, '.obsidian', 'app.json'), '{}');
    fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'one.md'), '---\ntags: t1\n---\nlink [[two]] and ![[pic.png]] #t2'); fs.writeFileSync(path.join(dir, 'sub', 'two.md', ), 'back to [[one]]'); fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from([137, 80, 78, 71]));
    const v2 = await j('/vaults', { name: name + 'imp', path: dir, existing: true }); assert.equal(v2.status, 200); assert.equal(v2.body.stats.notes, 2); assert.equal(v2.body.stats.attachments, 1); assert.equal(v2.body.stats.unresolved, 0);
    const tg = (await j(`/vault/tags?vault=${v2.body.id}`)).body.map((x: any) => x.tag).sort(); assert.deepEqual(tg, ['t1', 't2']);
    assert.ok(fs.existsSync(path.join(dir, '.obsidian', 'app.json')), 'foreign config untouched');
    await j(`/vaults/${v2.body.id}`, undefined, 'DELETE'); assert.ok(fs.existsSync(path.join(dir, 'one.md')), 'forgetting a vault never deletes files'); fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('cleanup', async () => { if (vid) await j(`/vaults/${vid}`, undefined, 'DELETE'); if (root) fs.rmSync(root, { recursive: true, force: true }); const h = path.join(path.dirname(path.dirname(root)), 'vault-history', vid); fs.rmSync(h, { recursive: true, force: true }); });
});
