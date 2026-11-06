// Memory: things the user wants the AI assistant to remember about them across every conversation. Stored in the user's own database; editable and deletable.
import type { Kit } from './routes2';
import { all, get, run, uid, me } from './db';

const now = () => Date.now();
const MAX_FACTS = 200;
export const memoryFacts = (limit = 60): string[] => all<{ text: string }>('SELECT text FROM memories WHERE user_id = ? AND enabled = 1 ORDER BY pinned DESC, updated_at DESC LIMIT ?', me(), limit).map((r) => r.text);
export const memoryEnabled = () => (get<{ value: string }>("SELECT value FROM preferences WHERE user_id = ? AND key = 'memory.enabled'", me())?.value ?? '1') !== '0';

export function registerMemory({ on, bad, body }: Kit) {
  on('GET', '/memories', () => ({ enabled: memoryEnabled(), items: all('SELECT id, text, enabled, pinned, source, created_at, updated_at FROM memories WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC', me()) }));
  on('POST', '/memories', async ({ req }) => {
    const b = await body(req); const text = String(b.text ?? '').trim().slice(0, 500); if (text.length < 3) return bad('Write a short sentence to remember.');
    if ((get<{ n: number }>('SELECT COUNT(*) n FROM memories WHERE user_id = ?', me())?.n ?? 0) >= MAX_FACTS) return bad(`You can keep up to ${MAX_FACTS} memories; delete some first.`, 409);
    if (get('SELECT 1 FROM memories WHERE user_id = ? AND lower(text) = lower(?)', me(), text)) return bad('That is already remembered.', 409);
    const id = uid(); run('INSERT INTO memories (id, user_id, text, source, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, me(), text, b.source === 'chat' ? 'chat' : 'manual', now(), now()); return { id };
  });
  on('PATCH', '/memories/:id', async ({ req, p }) => {
    const b = await body(req); const row = get('SELECT id FROM memories WHERE id = ? AND user_id = ?', p.id, me()); if (!row) return bad('Not found', 404);
    if (typeof b.text === 'string') { const t = b.text.trim().slice(0, 500); if (t.length < 3) return bad('Too short.'); run('UPDATE memories SET text = ?, updated_at = ? WHERE id = ?', t, now(), p.id); }
    if (typeof b.enabled === 'boolean') run('UPDATE memories SET enabled = ?, updated_at = ? WHERE id = ?', b.enabled ? 1 : 0, now(), p.id);
    if (typeof b.pinned === 'boolean') run('UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?', b.pinned ? 1 : 0, now(), p.id);
    return { ok: true };
  });
  on('DELETE', '/memories/:id', ({ p }) => { run('DELETE FROM memories WHERE id = ? AND user_id = ?', p.id, me()); return { ok: true }; });
  on('PUT', '/memories-enabled', async ({ req }) => { const b = await body(req); run("INSERT INTO preferences (user_id, key, value) VALUES (?, 'memory.enabled', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value", me(), b.enabled === false ? '0' : '1'); return { enabled: b.enabled !== false }; });
}
