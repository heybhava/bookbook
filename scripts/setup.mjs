// npm run setup — checks prerequisites and (optionally) pulls the recommended free models.
import { execFileSync } from 'node:child_process';

const ok = (m) => console.log(`  ✔ ${m}`);
const no = (m) => console.log(`  ✖ ${m}`);
const OLLAMA = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const [major, minor] = process.versions.node.split('.').map(Number);

console.log('\nFolio setup check\n');
if (major > 22 || (major === 22 && minor >= 5)) ok(`Node ${process.versions.node} (needs ≥ 22.5 for built-in SQLite)`);
else { no(`Node ${process.versions.node} is too old — install Node 22.5+ (24 recommended)`); process.exit(1); }

const has = (cmd, args = ['--version']) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };
has('ebook-convert') ? ok('Calibre found — MOBI/AZW/AZW3 enabled') : console.log('  · Calibre not found (optional) — MOBI/AZW need it: https://calibre-ebook.com');
has('soffice') || has('libreoffice') ? ok('LibreOffice found — DOC/PPT/PPTX/ODT/RTF enabled') : console.log('  · LibreOffice not found (optional) — DOC/PPT/ODT/RTF need it: https://libreoffice.org');

try {
  const j = await (await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) })).json();
  const names = j.models.map((m) => m.name);
  ok(`Ollama running (${names.length} models: ${names.join(', ') || 'none'})`);
  const chat = names.some((n) => !/embed/.test(n));
  const emb = names.some((n) => /embed/.test(n));
  if (!chat) no('No chat model. Run:  ollama pull qwen3:8b   (or gemma3:4b for lighter machines)');
  if (!emb) no('No embedding model (semantic search). Run:  ollama pull nomic-embed-text');
  if (chat && emb) ok('Models ready');
} catch {
  no('Ollama not reachable. Install from https://ollama.com and start it. Reading, dictionary, search, highlights and browser audio still work without it.');
}
console.log('\nNext:  npm install   →   npm run dev   →   open http://localhost:3100\n');
