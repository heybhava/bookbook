// Resource management for many users on one machine: API rate limit per user, fair background-job scheduling, bounded concurrent AI calls, storage quota.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './auth/config';
import { me, tryMe, runAs, userDir } from './tenant';

// ── per-user API rate limit (in-memory token bucket; one process) ──
const g = globalThis as unknown as { __rl?: Map<string, { t: number; n: number }>; __jobs?: Lane; __ai?: AiState };
const buckets = (g.__rl ??= new Map());
export function apiBucket(userId: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now(); const b = buckets.get(userId);
  if (!b || now - b.t >= 60_000) { buckets.set(userId, { t: now, n: 1 }); if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.t > 120_000) buckets.delete(k); return { ok: true, retryAfterSec: 0 }; }
  if (++b.n > cfg.apiPerMinute) return { ok: false, retryAfterSec: Math.ceil((60_000 - (now - b.t)) / 1000) };
  return { ok: true, retryAfterSec: 0 };
}

// ── fair background jobs: at most `jobConcurrency` run at once overall and ONE per user per lane; users are served round-robin ──
interface Job { userId: string; admin: boolean; key: string; fn: () => Promise<unknown> }
class Lane {
  private queues = new Map<string, Job[]>(); private order: string[] = []; private running = new Set<string>(); private active = 0; private keys = new Set<string>();
  constructor(private max: number, private perUser = 1) {}
  has(userId: string, key: string) { return this.keys.has(userId + '\0' + key); }
  push(job: Job) {
    const id = job.userId + '\0' + job.key; if (this.keys.has(id)) return; this.keys.add(id);
    (this.queues.get(job.userId) ?? this.queues.set(job.userId, []).get(job.userId)!).push(job); if (!this.order.includes(job.userId)) this.order.push(job.userId); this.pump();
  }
  private pump() {
    while (this.active < this.max) {
      const u = this.order.find((x) => !this.running.has(x) && (this.queues.get(x)?.length ?? 0) > 0); if (!u) return;
      this.order.splice(this.order.indexOf(u), 1); this.order.push(u); // round-robin
      const job = this.queues.get(u)!.shift()!; this.running.add(u); this.active++;
      runAs(job.userId, () => job.fn(), job.admin).catch((e: unknown) => console.error('job failed', job.key, (e as Error)?.message)).finally(() => { this.running.delete(u); this.active--; this.keys.delete(u + '\0' + job.key); if (!(this.queues.get(u)?.length)) { this.queues.delete(u); this.order = this.order.filter((x) => x !== u); } this.pump(); });
    }
  }
}
const lanes = (): Map<string, Lane> => ((g as any).__lanes ??= new Map<string, Lane>());
/** Queue `fn` to run as the CURRENT user (captured now). Same (user,key) pair is never queued twice. `lane` names the resource pool. */
export function enqueueJob(lane: 'ingest' | 'task' | 'journal', key: string, fn: () => Promise<unknown>, max = lane === 'journal' ? 1 : cfg.jobConcurrency) {
  const l = lanes(); let L = l.get(lane); if (!L) l.set(lane, (L = new Lane(max)));
  const uid = me(); L.push({ userId: uid, admin: false, key, fn });
}

// ── bounded AI calls (shared GPU/CPU): per-user and global limits ──
interface AiState { global: number; perUser: Map<string, number>; waiters: (() => void)[] }
const ai: AiState = (g.__ai ??= { global: 0, perUser: new Map<string, number>(), waiters: [] as (() => void)[] });
export async function acquireAi(): Promise<() => void> {
  const u = tryMe() ?? '_system';
  for (;;) { if (ai.global < cfg.aiConcurrencyGlobal && (ai.perUser.get(u) ?? 0) < cfg.aiConcurrencyPerUser) break; await new Promise<void>((r) => ai.waiters.push(r)); }
  ai.global++; ai.perUser.set(u, (ai.perUser.get(u) ?? 0) + 1); let done = false;
  return () => { if (done) return; done = true; ai.global--; const n = (ai.perUser.get(u) ?? 1) - 1; if (n <= 0) ai.perUser.delete(u); else ai.perUser.set(u, n); const w = ai.waiters.splice(0); w.forEach((r) => r()); };
}
export async function withAiSlot<T>(fn: () => Promise<T>): Promise<T> { const release = await acquireAi(); try { return await fn(); } finally { release(); } }

// ── storage quota (bytes under the user's directory; cached for 60 s) ──
const usage = new Map<string, { bytes: number; at: number }>();
function dirBytes(d: string): number { let n = 0; let ents: fs.Dirent[]; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return 0; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) n += dirBytes(p); else if (e.isFile()) { try { n += fs.statSync(p).size; } catch { /* vanished */ } } } return n; }
export function usedBytes(force = false): number { const uid = me(); const c = usage.get(uid); if (!force && c && Date.now() - c.at < 60_000) return c.bytes; const bytes = dirBytes(userDir(uid)); usage.set(uid, { bytes, at: Date.now() }); return bytes; }
export class QuotaError extends Error { status = 413; }
export function checkQuota(extraBytes: number) { const used = usedBytes(); if (used + extraBytes > cfg.quotaBytes) { usage.delete(me()); throw new QuotaError(`Storage quota exceeded (${(used / 1048576).toFixed(0)} MB used of ${(cfg.quotaBytes / 1048576).toFixed(0)} MB). Delete something or ask the administrator for more space.`); } const c = usage.get(me()); if (c) c.bytes += extraBytes; }
