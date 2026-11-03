// A tiny, safe math expression language for generated models. No eval, no property access, no calls except an allow-list.
// Grammar: + - * / % ^ (right assoc), unary -, parentheses, numbers, identifiers, f(a,b,...), comparison/ternary via if(c,a,b).

export type Env = Record<string, number>;
type Node = { t: 'n'; v: number } | { t: 'v'; name: string } | { t: 'u'; a: Node } | { t: 'b'; op: string; a: Node; b: Node } | { t: 'f'; name: string; args: Node[] };

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  exp: Math.exp, ln: Math.log, log: Math.log10, sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max, pow: Math.pow, sign: Math.sign, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  if: (c, a, b) => (c ? a : b), gt: (a, b) => (a > b ? 1 : 0), lt: (a, b) => (a < b ? 1 : 0), clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  // financial helpers: pmt(rate, n, pv), fv(rate, n, pmt), npv(rate, c0, c1, ...), pv_annuity(rate, n, pmt)
  pmt: (r, n, pv) => (r === 0 ? pv / n : (pv * r) / (1 - Math.pow(1 + r, -n))),
  fv: (r, n, p) => (r === 0 ? p * n : (p * (Math.pow(1 + r, n) - 1)) / r),
  pv_annuity: (r, n, p) => (r === 0 ? p * n : (p * (1 - Math.pow(1 + r, -n))) / r),
  npv: (r, ...cf) => cf.reduce((s, c, i) => s + c / Math.pow(1 + r, i), 0),
};
const CONST: Env = { pi: Math.PI, e: Math.E };
const MAX_LEN = 400;

function tokenize(src: string) {
  const toks: { k: 'num' | 'id' | 'op'; v: string }[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/.exec(src.slice(i));
    if (m) { toks.push({ k: 'num', v: m[1] }); i += m[1].length; continue; }
    const id = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i));
    if (id) { toks.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    if ('+-*/%^(),'.includes(c)) { toks.push({ k: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected character "${c}" in expression`);
  }
  return toks;
}

export function parse(src: string): Node {
  if (typeof src !== 'string' || !src.trim() || src.length > MAX_LEN) throw new Error('Expression is empty or too long');
  const t = tokenize(src); let p = 0;
  const peek = () => t[p]; const eat = (v?: string) => { const x = t[p]; if (!x || (v && x.v !== v)) throw new Error(`Expected ${v ?? 'token'} in expression`); p++; return x; };
  const prim = (): Node => {
    const x = peek(); if (!x) throw new Error('Unexpected end of expression');
    if (x.k === 'num') { p++; return { t: 'n', v: Number(x.v) }; }
    if (x.k === 'id') {
      p++;
      if (peek()?.v === '(') {
        eat('('); const args: Node[] = [];
        if (peek()?.v !== ')') { args.push(add()); while (peek()?.v === ',') { eat(','); args.push(add()); } }
        eat(')');
        if (!FUNCS[x.v]) throw new Error(`Unknown function "${x.v}"`);
        return { t: 'f', name: x.v, args };
      }
      return { t: 'v', name: x.v };
    }
    if (x.v === '(') { eat('('); const n = add(); eat(')'); return n; }
    throw new Error(`Unexpected "${x.v}"`);
  };
  const unary = (): Node => { if (peek()?.v === '-') { eat('-'); return { t: 'u', a: unary() }; } if (peek()?.v === '+') { eat('+'); return unary(); } return pow(); };
  const pow = (): Node => { const b = prim(); if (peek()?.v === '^') { eat('^'); return { t: 'b', op: '^', a: b, b: unary() }; } return b; };
  const mul = (): Node => { let l = unary(); while (['*', '/', '%'].includes(peek()?.v ?? '')) { const op = eat().v; l = { t: 'b', op, a: l, b: unary() }; } return l; };
  const add = (): Node => { let l = mul(); while (['+', '-'].includes(peek()?.v ?? '')) { const op = eat().v; l = { t: 'b', op, a: l, b: mul() }; } return l; };
  const n = add();
  if (p < t.length) throw new Error(`Unexpected "${t[p].v}"`);
  return n;
}

export function evalNode(n: Node, env: Env): number {
  switch (n.t) {
    case 'n': return n.v;
    case 'v': { const v = env[n.name] ?? CONST[n.name]; if (v === undefined) throw new Error(`Unknown variable "${n.name}"`); return v; }
    case 'u': return -evalNode(n.a, env);
    case 'b': { const a = evalNode(n.a, env), b = evalNode(n.b, env); switch (n.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b; default: return Math.pow(a, b); } }
    case 'f': return FUNCS[n.name](...n.args.map((x) => evalNode(x, env)));
  }
}

export const evaluate = (src: string, env: Env) => evalNode(parse(src), env);
export const compile = (src: string) => { const n = parse(src); return (env: Env) => evalNode(n, env); };

export function variablesOf(src: string): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => { if (n.t === 'v') out.add(n.name); else if (n.t === 'u') walk(n.a); else if (n.t === 'b') { walk(n.a); walk(n.b); } else if (n.t === 'f') n.args.forEach(walk); };
  walk(parse(src)); return [...out].filter((v) => !(v in CONST));
}
