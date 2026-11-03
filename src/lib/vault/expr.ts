// Restricted expression language for Bases filters and formulas. Parsed to an AST and interpreted — no eval, no Function, no host object access.
// Only the data and functions passed in through `Env` are reachable; evaluation is bounded by a step budget and recursion depth.
export class ExprError extends Error {}
type Tok = { t: 'num' | 'str' | 'id' | 'op' | 'eof'; v: string; pos: number };
export type Node =
  | { k: 'lit'; v: unknown } | { k: 'id'; name: string } | { k: 'list'; items: Node[] }
  | { k: 'un'; op: string; a: Node } | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'member'; obj: Node; name: string } | { k: 'index'; obj: Node; idx: Node } | { k: 'call'; fn: Node; args: Node[] };

function lex(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) { let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++; out.push({ t: 'num', v: src.slice(i, j), pos: i }); i = j; continue; }
    if (c === '"' || c === "'") { let j = i + 1, s = ''; while (j < src.length && src[j] !== c) { if (src[j] === '\\' && j + 1 < src.length) { j++; s += ({ n: '\n', t: '\t' } as any)[src[j]] ?? src[j]; } else s += src[j]; j++; } if (j >= src.length) throw new ExprError('Unterminated string'); out.push({ t: 'str', v: s, pos: i }); i = j + 1; continue; }
    if (/[\p{L}_]/u.test(c)) { let j = i; while (j < src.length && /[\p{L}\p{N}_-]/u.test(src[j]) && !(src[j] === '-' && !/[\p{L}\p{N}_]/u.test(src[j + 1] ?? ''))) j++; out.push({ t: 'id', v: src.slice(i, j), pos: i }); i = j; continue; }
    const two = src.slice(i, i + 2); if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two, pos: i }); i += 2; continue; }
    if ('+-*/%<>!(),.[]'.includes(c)) { out.push({ t: 'op', v: c, pos: i }); i++; continue; }
    throw new ExprError(`Unexpected character "${c}" at ${i}`);
  }
  out.push({ t: 'eof', v: '', pos: src.length }); return out;
}

export function parse(src: string): Node {
  if (src.length > 2000) throw new ExprError('Expression too long');
  const toks = lex(src); let p = 0; let depth = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const isOp = (v: string) => peek().t === 'op' && peek().v === v;
  const expect = (v: string) => { if (!isOp(v)) throw new ExprError(`Expected "${v}" at ${peek().pos}`); p++; };
  const bump = () => { if (++depth > 40) throw new ExprError('Expression too deeply nested'); };
  const bin = (sub: () => Node, ops: string[]): Node => { let a = sub(); while (peek().t === 'op' && ops.includes(peek().v)) { const op = next().v; a = { k: 'bin', op, a, b: sub() }; } return a; };
  const or = (): Node => bin(and, ['||']), and = (): Node => bin(eq, ['&&']), eq = (): Node => bin(cmp, ['==', '!=']), cmp = (): Node => bin(add, ['<', '>', '<=', '>=']), add = (): Node => bin(mul, ['+', '-']), mul = (): Node => bin(unary, ['*', '/', '%']);
  const unary = (): Node => { if (isOp('!') || isOp('-')) { bump(); const op = next().v; return { k: 'un', op, a: unary() }; } return postfix(); };
  const postfix = (): Node => {
    let n = primary();
    for (;;) {
      if (isOp('.')) { p++; const t = next(); if (t.t !== 'id') throw new ExprError(`Expected a name after "." at ${t.pos}`); n = { k: 'member', obj: n, name: t.v }; }
      else if (isOp('(')) { p++; const args: Node[] = []; if (!isOp(')')) { do { args.push(or()); } while (isOp(',') && (p++, true)); } expect(')'); n = { k: 'call', fn: n, args }; }
      else if (isOp('[')) { p++; const idx = or(); expect(']'); n = { k: 'index', obj: n, idx }; }
      else return n;
    }
  };
  const primary = (): Node => {
    const t = next(); bump();
    try {
      if (t.t === 'num') return { k: 'lit', v: Number(t.v) };
      if (t.t === 'str') return { k: 'lit', v: t.v };
      if (t.t === 'id') { if (t.v === 'true') return { k: 'lit', v: true }; if (t.v === 'false') return { k: 'lit', v: false }; if (t.v === 'null') return { k: 'lit', v: null }; return { k: 'id', name: t.v }; }
      if (t.t === 'op' && t.v === '(') { const e = or(); expect(')'); return e; }
      if (t.t === 'op' && t.v === '[') { const items: Node[] = []; if (!isOp(']')) { do { items.push(or()); } while (isOp(',') && (p++, true)); } expect(']'); return { k: 'list', items }; }
      throw new ExprError(t.t === 'eof' ? 'Unexpected end of expression' : `Unexpected "${t.v}" at ${t.pos}`);
    } finally { depth--; }
  };
  const n = or(); if (peek().t !== 'eof') throw new ExprError(`Unexpected "${peek().v}" at ${peek().pos}`); return n;
}

export interface Env { resolve: (name: string) => unknown; fileMethods?: Record<string, (...a: unknown[]) => unknown> }
export const isDate = (v: unknown): v is Date => v instanceof Date && !isNaN(v.getTime());
const DUR = /(\d+(?:\.\d+)?)\s*(years?|y|months?|M|weeks?|w|days?|d|hours?|h|minutes?|m|seconds?|s)\b/g;
const durMs = (s: string): number | null => { let t = 0, any = false; for (const m of s.matchAll(DUR)) { any = true; const n = Number(m[1]); const u = m[2]; t += n * (/^y/.test(u) ? 365 * 864e5 : u === 'M' || /^month/.test(u) ? 30 * 864e5 : /^w/.test(u) ? 7 * 864e5 : /^d/.test(u) ? 864e5 : /^h/.test(u) ? 36e5 : /^m/.test(u) ? 6e4 : 1e3); } return any && s.replace(DUR, '').trim() === '' ? t : null; };
export function toDate(v: unknown): Date | null { if (isDate(v)) return v; if (typeof v === 'number') return new Date(v); if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) { const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00' : v); return isNaN(d.getTime()) ? null : d; } return null; }
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export function fmtDate(d: Date, f = 'YYYY-MM-DD'): string { return f.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => ({ YYYY: pad(d.getFullYear(), 4), MM: pad(d.getMonth() + 1), DD: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) } as any)[t]); }
export const truthy = (v: unknown) => v != null && v !== false && v !== 0 && v !== '' && !(Array.isArray(v) && v.length === 0);
const str = (v: unknown): string => v == null ? '' : isDate(v) ? fmtDate(v, v.getHours() || v.getMinutes() ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD') : Array.isArray(v) ? v.map(str).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
export { str as toStr };
const cmpVals = (a: unknown, b: unknown): number => { const da = toDate(a), db = toDate(b); if (da && db && (isDate(a) || isDate(b) || (typeof a === 'string' && typeof b === 'string'))) return da.getTime() - db.getTime(); if (typeof a === 'number' && typeof b === 'number') return a - b; if (a == null) return b == null ? 0 : -1; if (b == null) return 1; return str(a).localeCompare(str(b), undefined, { numeric: true, sensitivity: 'base' }); };
export { cmpVals as compareValues };
const eqVals = (a: unknown, b: unknown): boolean => { if (a == null || b == null) return a == null && b == null; if (isDate(a) || isDate(b)) { const x = toDate(a), y = toDate(b); return !!x && !!y && x.getTime() === y.getTime(); } if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eqVals(x, b[i])); if (typeof a === 'string' && typeof b === 'string') return a === b; return a === b; };

const MAX_STEPS = 20000;
export function evaluate(node: Node, env: Env): unknown {
  let steps = 0;
  const ev = (n: Node, d = 0): unknown => {
    if (++steps > MAX_STEPS || d > 60) throw new ExprError('Expression is too expensive to evaluate');
    switch (n.k) {
      case 'lit': return n.v;
      case 'id': return env.resolve(n.name);
      case 'list': return n.items.map((i) => ev(i, d + 1));
      case 'un': { const a = ev(n.a, d + 1); return n.op === '!' ? !truthy(a) : typeof a === 'number' ? -a : null; }
      case 'bin': {
        if (n.op === '&&') { const a = ev(n.a, d + 1); return truthy(a) ? ev(n.b, d + 1) : a; }
        if (n.op === '||') { const a = ev(n.a, d + 1); return truthy(a) ? a : ev(n.b, d + 1); }
        const a = ev(n.a, d + 1), b = ev(n.b, d + 1);
        switch (n.op) {
          case '==': return eqVals(a, b); case '!=': return !eqVals(a, b);
          case '<': return cmpVals(a, b) < 0; case '>': return cmpVals(a, b) > 0; case '<=': return cmpVals(a, b) <= 0; case '>=': return cmpVals(a, b) >= 0;
          case '+': { if (isDate(a) && typeof b === 'string') { const m = durMs(b); return m == null ? null : new Date(a.getTime() + m); } if (typeof a === 'number' && typeof b === 'number') return a + b; if (a == null || b == null) return null; const s = str(a) + str(b); if (s.length > 100000) throw new ExprError('String too long'); return s; }
          case '-': { if (isDate(a) && isDate(b)) return a.getTime() - b.getTime(); if (isDate(a) && typeof b === 'string') { const m = durMs(b); return m == null ? null : new Date(a.getTime() - m); } return typeof a === 'number' && typeof b === 'number' ? a - b : null; }
          case '*': return typeof a === 'number' && typeof b === 'number' ? a * b : null; case '/': return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a / b : null; case '%': return typeof a === 'number' && typeof b === 'number' && b !== 0 ? a % b : null;
        }
        return null;
      }
      case 'index': { const o = ev(n.obj, d + 1), i = ev(n.idx, d + 1); if (Array.isArray(o) && typeof i === 'number') return o[i] ?? null; if (o && typeof o === 'object' && !isDate(o) && typeof i === 'string') return own(o, i); return null; }
      case 'member': { const o = ev(n.obj, d + 1); return member(o, n.name); }
      case 'call': {
        const args = n.args.map((a) => ev(a, d + 1));
        if (n.fn.k === 'id') return globalFn(n.fn.name, args, env);
        if (n.fn.k === 'member') { const o = ev(n.fn.obj, d + 1); return method(o, n.fn.name, args, env); }
        throw new ExprError('Not a function');
      }
    }
  };
  return ev(node);
}
const own = (o: any, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : (() => { const f = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase()); return f ? o[f] : null; })() ?? null);
function member(o: unknown, name: string): unknown {
  if (o == null) return null;
  if (typeof o === 'string') return name === 'length' ? o.length : null;
  if (Array.isArray(o)) return name === 'length' ? o.length : null;
  if (isDate(o)) return ({ year: o.getFullYear(), month: o.getMonth() + 1, day: o.getDate(), hour: o.getHours(), minute: o.getMinutes(), second: o.getSeconds() } as any)[name] ?? null;
  if (typeof o === 'object') return own(o, name);
  return null;
}
const need = (a: unknown[], n: number, name: string) => { if (a.length < n) throw new ExprError(`${name}() needs ${n} argument${n > 1 ? 's' : ''}`); };
function globalFn(name: string, a: unknown[], env: Env): unknown {
  switch (name) {
    case 'if': need(a, 2, 'if'); return truthy(a[0]) ? a[1] : (a[2] ?? null);
    case 'now': return new Date(); case 'today': { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
    case 'date': need(a, 1, 'date'); return toDate(a[0]); case 'number': { need(a, 1, 'number'); const n = typeof a[0] === 'number' ? a[0] : Number(String(a[0]).replace(/[, ]/g, '')); return isNaN(n) ? null : n; }
    case 'string': need(a, 1, 'string'); return str(a[0]); case 'list': return Array.isArray(a[0]) ? a[0] : a[0] == null ? [] : [a[0]];
    case 'min': case 'max': { const xs = (a.length === 1 && Array.isArray(a[0]) ? a[0] : a).filter((x): x is number => typeof x === 'number'); return xs.length ? Math[name](...xs) : null; }
    case 'abs': return typeof a[0] === 'number' ? Math.abs(a[0]) : null; case 'round': return typeof a[0] === 'number' ? (a[1] ? Number(a[0].toFixed(Math.min(10, Number(a[1])))) : Math.round(a[0])) : null;
    case 'floor': return typeof a[0] === 'number' ? Math.floor(a[0]) : null; case 'ceil': return typeof a[0] === 'number' ? Math.ceil(a[0]) : null;
    case 'concat': return a.map(str).join(''); case 'isEmpty': return !truthy(a[0]); case 'isNumber': return typeof a[0] === 'number'; case 'isString': return typeof a[0] === 'string';
    default: if (env.fileMethods?.[name]) return env.fileMethods[name](...a); throw new ExprError(`Unknown function "${name}"`);
  }
}
function method(o: unknown, name: string, a: unknown[], env: Env): unknown {
  if (o && typeof o === 'object' && !Array.isArray(o) && !isDate(o) && (o as any).__file) { const f = env.fileMethods?.[name]; if (f) return f(...a); throw new ExprError(`file.${name}() is not available`); }
  if (typeof o === 'string') switch (name) {
    case 'contains': return o.toLowerCase().includes(str(a[0]).toLowerCase()); case 'startsWith': return o.startsWith(str(a[0])); case 'endsWith': return o.endsWith(str(a[0]));
    case 'lower': return o.toLowerCase(); case 'upper': return o.toUpperCase(); case 'trim': return o.trim(); case 'isEmpty': return o.length === 0; case 'toString': return o;
    case 'replace': return o.split(str(a[0])).join(str(a[1])); case 'split': return o.split(str(a[0])); case 'slice': return o.slice(Number(a[0]) || 0, a[1] == null ? undefined : Number(a[1]));
    case 'title': return o.replace(/\b\p{L}/gu, (c) => c.toUpperCase()); case 'repeat': { const n = Math.min(100, Math.max(0, Number(a[0]) || 0)); if (o.length * n > 100000) throw new ExprError('String too long'); return o.repeat(n); }
  }
  if (typeof o === 'number') switch (name) { case 'round': return a[0] ? Number(o.toFixed(Math.min(10, Number(a[0])))) : Math.round(o); case 'floor': return Math.floor(o); case 'ceil': return Math.ceil(o); case 'abs': return Math.abs(o); case 'toFixed': return o.toFixed(Math.min(10, Number(a[0]) || 0)); case 'toString': return String(o); case 'isEmpty': return false; }
  if (Array.isArray(o)) switch (name) {
    case 'contains': return o.some((x) => eqVals(x, a[0]) || (typeof x === 'string' && typeof a[0] === 'string' && x.toLowerCase() === a[0].toLowerCase()));
    case 'containsAny': return a.flat().some((y) => o.some((x) => eqVals(x, y))); case 'containsAll': return a.flat().every((y) => o.some((x) => eqVals(x, y)));
    case 'join': return o.map(str).join(a[0] == null ? ', ' : str(a[0])); case 'isEmpty': return o.length === 0; case 'unique': return o.filter((x, i) => o.findIndex((y) => eqVals(x, y)) === i);
    case 'sort': return [...o].sort(cmpVals); case 'reverse': return [...o].reverse(); case 'flat': return o.flat(); case 'slice': return o.slice(Number(a[0]) || 0, a[1] == null ? undefined : Number(a[1]));
    case 'sum': return o.filter((x): x is number => typeof x === 'number').reduce((s, x) => s + x, 0); case 'toString': return str(o);
  }
  if (isDate(o)) switch (name) { case 'format': return fmtDate(o, a[0] == null ? undefined : str(a[0])); case 'date': { const d = new Date(o); d.setHours(0, 0, 0, 0); return d; } case 'time': return fmtDate(o, 'HH:mm:ss'); case 'toString': return str(o); case 'relative': { const s = Math.round((o.getTime() - Date.now()) / 1000); const u: [string, number][] = [['day', 86400], ['hour', 3600], ['minute', 60]]; for (const [n, v] of u) if (Math.abs(s) >= v) { const k = Math.round(s / v); return k > 0 ? `in ${k} ${n}${k > 1 ? 's' : ''}` : `${-k} ${n}${k < -1 ? 's' : ''} ago`; } return 'just now'; } }
  if (o == null) return null;
  if (name === 'isEmpty') return !truthy(o);
  throw new ExprError(`Unknown method ".${name}()"`);
}
export function compile(src: string): (env: Env) => unknown { const ast = parse(src); return (env) => evaluate(ast, env); }
