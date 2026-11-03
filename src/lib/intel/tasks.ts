// Background task runner: persistent task rows, single-lane in-process queue, cancel + resume.
import { all, get, run, uid } from '../db';

export type TaskStatus = 'queued' | 'analysing' | 'generating' | 'rendering' | 'completed' | 'failed' | 'cancelled';
export interface Ctx { task: any; payload: any; update: (progress: number, detail?: string, status?: TaskStatus) => void; cancelled: () => boolean }
type Handler = (c: Ctx) => Promise<void>;

const g = globalThis as unknown as { __tasks?: { handlers: Map<string, Handler>; chain: Promise<void>; queued: Set<string>; cancel: Set<string> } };
const S = (g.__tasks ??= { handlers: new Map(), chain: Promise.resolve(), queued: new Set(), cancel: new Set() });

export const registerTask = (kind: string, h: Handler) => { S.handlers.set(kind, h); };

export function createTask(kind: string, bookId: string | null, payload: Record<string, unknown> = {}, assetId: string | null = null) {
  const id = uid();
  run('INSERT INTO tasks (id, book_id, asset_id, kind, status, payload, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, bookId, assetId, kind, 'queued', JSON.stringify(payload), Date.now(), Date.now());
  enqueueTask(id);
  return id;
}

export function enqueueTask(id: string) {
  if (S.queued.has(id)) return;
  S.queued.add(id); S.cancel.delete(id);
  S.chain = S.chain.then(() => execute(id)).catch(() => {}).finally(() => S.queued.delete(id));
}

async function execute(id: string) {
  const t = get<any>('SELECT * FROM tasks WHERE id = ?', id);
  if (!t || t.status === 'cancelled' || t.status === 'completed') return;
  const h = S.handlers.get(t.kind);
  const set = (status: TaskStatus, progress?: number, detail?: string | null, error?: string | null): void => {
    run('UPDATE tasks SET status = ?, progress = COALESCE(?, progress), detail = COALESCE(?, detail), error = ?, updated_at = ? WHERE id = ?', status, progress ?? null, detail ?? null, error ?? null, Date.now(), id);
  };
  if (!h) return set('failed', 0, null, `No handler for task kind "${t.kind}"`);
  set('analysing', 0, 'Starting…');
  try {
    await h({
      task: t, payload: JSON.parse(t.payload || '{}'),
      update: (p: number, d?: string, st?: TaskStatus) => set(st ?? 'generating', p, d ?? null),
      cancelled: () => S.cancel.has(id),
    });
    if (S.cancel.has(id)) set('cancelled', undefined, 'Cancelled — completed work was kept');
    else set('completed', 1, 'Done');
  } catch (e: any) {
    if (S.cancel.has(id)) set('cancelled', undefined, 'Cancelled');
    else set('failed', undefined, null, e?.message ?? String(e));
  }
}

export function cancelTask(id: string) {
  S.cancel.add(id);
  const t = get<any>('SELECT status FROM tasks WHERE id = ?', id);
  if (t && t.status === 'queued') run("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?", Date.now(), id);
}

/** Re-run a failed/cancelled task. Handlers are written to skip work that is already saved, so this resumes. */
export function resumeTask(id: string) {
  run("UPDATE tasks SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?", Date.now(), id);
  enqueueTask(id);
}

/** After a restart, anything that was mid-flight is marked failed (resumable) rather than silently lost. */
export function recoverTasks() {
  run("UPDATE tasks SET status = 'failed', error = 'Interrupted by a restart — press Resume', updated_at = ? WHERE status IN ('analysing','generating','rendering')", Date.now());
  for (const t of all<{ id: string }>("SELECT id FROM tasks WHERE status = 'queued'")) enqueueTask(t.id);
}

export const listTasks = (bookId?: string | null) =>
  all<any>(`SELECT * FROM tasks ${bookId ? 'WHERE book_id = ?' : ''} ORDER BY created_at DESC LIMIT 60`, ...(bookId ? [bookId] : []));
