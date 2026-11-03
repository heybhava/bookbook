import { all, get, run, LOCAL_USER } from './db';

export const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');

export type Task = 'assistant' | 'comprehension' | 'summary' | 'vocabulary' | 'knowledge' | 'embedding';
export const TASKS: Task[] = ['assistant', 'comprehension', 'summary', 'vocabulary', 'knowledge', 'embedding'];

export const RECOMMENDED = [
  { name: 'qwen3:8b', note: 'Best general reasoning. ~5 GB download, ~8 GB RAM/VRAM.' },
  { name: 'gemma3:4b', note: 'Lightweight and quick. ~3 GB download, ~5 GB RAM.' },
  { name: 'llama3.1:8b', note: 'Solid all-rounder. ~5 GB download, ~8 GB RAM/VRAM.' },
  { name: 'qwen3:1.7b', note: 'Tiny; for machines with 4 GB RAM. Lower quality.' },
  { name: 'nomic-embed-text', note: 'Embeddings for semantic search (required for hybrid retrieval). ~270 MB.' },
];

export interface OllamaStatus {
  online: boolean; url: string; models: { name: string; size: number; family?: string; params?: string; embedding: boolean }[]; error?: string;
}

export async function status(): Promise<OllamaStatus> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    return {
      online: true, url: OLLAMA_URL,
      models: (j.models ?? []).map((m: any) => ({
        name: m.name, size: m.size, family: m.details?.family, params: m.details?.parameter_size,
        embedding: /embed|bge|minilm|e5-|arctic-embed/i.test(m.name) || (m.details?.family ?? '').includes('bert'),
      })),
    };
  } catch (e: any) {
    return { online: false, url: OLLAMA_URL, models: [], error: e?.message ?? String(e) };
  }
}

export function getPref(key: string): string | undefined {
  return get<{ value: string }>('SELECT value FROM preferences WHERE user_id = ? AND key = ?', LOCAL_USER, key)?.value;
}
export function setPref(key: string, value: string) {
  run('INSERT INTO preferences (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value = excluded.value', LOCAL_USER, key, value);
}
export function allPrefs(): Record<string, string> {
  return Object.fromEntries(all<{ key: string; value: string }>('SELECT key, value FROM preferences WHERE user_id = ?', LOCAL_USER).map((r) => [r.key, r.value]));
}

/** Resolve the model for a task: explicit user choice (if still installed) > first installed chat model > null. */
export async function modelFor(task: Task): Promise<string | null> {
  const st = await status();
  if (!st.online) return null;
  const pick = getPref(`model.${task}`);
  const pool = st.models.filter((m) => (task === 'embedding' ? m.embedding : !m.embedding));
  if (pick && pool.some((m) => m.name === pick)) return pick;
  if (task === 'assistant' || task === 'embedding') return pool[0]?.name ?? null;
  const fallback = getPref('model.assistant');
  if (fallback && pool.some((m) => m.name === fallback)) return fallback;
  return pool[0]?.name ?? null;
}

export class NoModelError extends Error {
  constructor(public reason: 'offline' | 'no-model') {
    super(reason === 'offline' ? 'Ollama is not running. Start it (ollama serve) or install from https://ollama.com.' : 'No chat model installed. Run: ollama pull qwen3:8b');
  }
}

interface Msg { role: 'system' | 'user' | 'assistant'; content: string }

export async function chat(task: Task, messages: Msg[], opts: { json?: boolean; temperature?: number } = {}): Promise<{ text: string; model: string }> {
  const model = await modelFor(task);
  if (!model) throw new NoModelError((await status()).online ? 'no-model' : 'offline');
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, think: false, format: opts.json ? 'json' : undefined, options: { temperature: opts.temperature ?? 0.3, num_ctx: 8192, num_predict: 2048, repeat_penalty: 1.1 } }),
  });
  if (!r.ok) throw new Error(`Ollama error ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return { text: stripThink(j.message?.content ?? ''), model };
}

const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

/** Streaming chat -> async iterator of text deltas. */
export async function* chatStream(task: Task, messages: Msg[], temperature = 0.4): AsyncGenerator<{ delta?: string; model?: string }> {
  const model = await modelFor(task);
  if (!model) throw new NoModelError((await status()).online ? 'no-model' : 'offline');
  yield { model };
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, think: false, options: { temperature, num_ctx: 8192 } }),
  });
  if (!r.ok || !r.body) throw new Error(`Ollama error ${r.status}: ${await r.text()}`);
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; let inThink = false;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        let d: string = JSON.parse(line).message?.content ?? '';
        if (d.includes('<think>')) inThink = true;
        if (!inThink && d) yield { delta: d };
        if (d.includes('</think>')) inThink = false;
      } catch { /* partial line */ }
    }
  }
}

export async function embed(texts: string[]): Promise<{ vectors: number[][]; model: string } | null> {
  const model = await modelFor('embedding');
  if (!model) return null;
  try {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const r = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts.slice(i, i + 16) }),
      });
      if (!r.ok) return null;
      out.push(...(await r.json()).embeddings);
    }
    return { vectors: out, model };
  } catch { return null; }
}

/** Robustly parse JSON from a model reply (handles code fences / stray prose). */
export function parseJson<T = any>(s: string): T | null {
  const t = s.replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch { /* fallthrough */ }
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } }
  return null;
}
