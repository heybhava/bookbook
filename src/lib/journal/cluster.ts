// Pure helpers for grouping similar statements across entries (no I/O; unit-tested).
export const STOP = new Set('that this with from have which their they there been when will would could about into than then also such these those because between while where what does should just like very really being were your you are was and the for not but out had has its our his her she him them who how why can did get got going thing things said say think thought know want need much some more most many lot lots time today yesterday tomorrow'.split(' '));
export const stems = (s: string): Set<string> => new Set(s.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length > 3 && !STOP.has(w)).map((w) => w.slice(0, 5)));
export const jacc = (a: Set<string>, b: Set<string>) => { let k = 0; for (const x of a) if (b.has(x)) k++; return k / (a.size + b.size - k || 1); };
export const shared = (a: Set<string>, b: Set<string>) => { let k = 0; for (const x of a) if (b.has(x)) k++; return k; };

export interface Item { entryId: string; day: string; recordingId: string | null; kind: string; text: string; atMs: number | null; quote: string | null }
export interface Theme { label: string; kind: string; entries: number; mentions: number; first: string; last: string; basis: 'single entry' | 'two entries' | 'recurring'; evidence: Item[] }
export const basisOf = (n: number): Theme['basis'] => (n >= 3 ? 'recurring' : n === 2 ? 'two entries' : 'single entry');

/** Group similar items (same kind) from different entries. Pure function: unit-tested without a database. */
export function clusterThemes(items: Item[], opts: { minSim?: number } = {}): Theme[] {
  const minSim = opts.minSim ?? 0.3; const out: Theme[] = []; const kinds = [...new Set(items.map((i) => i.kind))];
  for (const kind of kinds) {
    const its = items.filter((i) => i.kind === kind); const sig = its.map((i) => stems(i.text)); const parent = its.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (let i = 0; i < its.length; i++) for (let j = i + 1; j < its.length; j++) { if (its[i].entryId === its[j].entryId) continue; if (jacc(sig[i], sig[j]) >= minSim || (shared(sig[i], sig[j]) >= 2 && jacc(sig[i], sig[j]) >= 0.2)) parent[find(i)] = find(j); }
    const groups = new Map<number, number[]>(); its.forEach((_, i) => { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)!).push(i); });
    for (const idxs of groups.values()) {
      const ents = new Set(idxs.map((i) => its[i].entryId)); const days = idxs.map((i) => its[i].day).sort();
      const centre = idxs.reduce((best, i) => { const sc = idxs.reduce((s, j) => s + (i === j ? 0 : jacc(sig[i], sig[j])), 0); return sc > best.sc ? { i, sc } : best; }, { i: idxs[0], sc: -1 }).i;
      out.push({ label: its[centre].text, kind, entries: ents.size, mentions: idxs.length, first: days[0], last: days.at(-1)!, basis: basisOf(ents.size), evidence: idxs.sort((a, b) => its[a].day.localeCompare(its[b].day)).slice(0, 8).map((i) => its[i]) });
    }
  }
  return out.sort((a, b) => b.entries - a.entries || b.mentions - a.mentions || b.last.localeCompare(a.last));
}

