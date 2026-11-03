// Safe, declarative scene schema ("folio.scene.v1") + deterministic simulations.
// AI produces DATA (validated here); it never produces code. All maths below is plain, testable TypeScript.
import { compile, parse, type Env } from './expr';

export const SCENE_KINDS = ['projectile', 'spring', 'pendulum', 'energy', 'rc', 'model', 'function', 'surface', 'supply_demand', 'timeline', 'map', 'algorithm', 'diagram3d'] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];

export interface Input { id: string; label: string; min: number; max: number; step: number; value: number; unit?: string }
export interface Obj3D {
  id: string; shape: 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane' | 'line'; position: [number, number, number]; scale: [number, number, number];
  color: string; label?: string; opacity?: number; points?: [number, number, number][];
  animate?: { type: 'rotate' | 'oscillate' | 'orbit' | 'pulse'; axis?: 'x' | 'y' | 'z'; speed: number; amplitude?: number };
  explain?: string;
}
export interface Scene {
  schema: 'folio.scene.v1'; kind: SceneKind; title: string; objective: string; subject: string;
  sources: { page: number; quote?: string }[];
  inputs: Input[];
  accuracy: 'exact' | 'educational-approximation'; accuracyNote: string;
  data: Record<string, any>;
  objects?: Obj3D[]; camera: { position: [number, number, number]; target: [number, number, number] }; lighting: { ambient: number; directional: number };
  predict?: { question: string; options: string[]; correct: number; explanation: string };
  explain: string; apply?: { problem: string; hint?: string; answer?: string }; questions: { q: string; a: string }[];
}

const num = (v: unknown, d: number, lo = -1e9, hi = 1e9) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v: unknown, n = 300) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, n);
const vec3 = (v: unknown, d: [number, number, number]): [number, number, number] => Array.isArray(v) && v.length === 3 ? [num(v[0], d[0], -200, 200), num(v[1], d[1], -200, 200), num(v[2], d[2], -200, 200)] : d;
const color = (v: unknown) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#4c6ef5');

/** Built-in, physically exact models and their slider definitions. */
export const BUILTIN_INPUTS: Partial<Record<SceneKind, Input[]>> = {
  projectile: [
    { id: 'v0', label: 'Launch speed', min: 1, max: 100, step: 1, value: 25, unit: 'm/s' }, { id: 'angle', label: 'Launch angle', min: 5, max: 85, step: 1, value: 45, unit: '°' },
    { id: 'h0', label: 'Launch height', min: 0, max: 50, step: 1, value: 0, unit: 'm' }, { id: 'g', label: 'Gravity', min: 1.6, max: 25, step: 0.1, value: 9.81, unit: 'm/s²' },
  ],
  spring: [
    { id: 'm', label: 'Mass', min: 0.1, max: 10, step: 0.1, value: 1, unit: 'kg' }, { id: 'k', label: 'Spring constant', min: 1, max: 200, step: 1, value: 40, unit: 'N/m' },
    { id: 'A', label: 'Amplitude', min: 0.05, max: 1, step: 0.05, value: 0.4, unit: 'm' }, { id: 'b', label: 'Damping', min: 0, max: 5, step: 0.05, value: 0, unit: 'kg/s' },
  ],
  pendulum: [
    { id: 'L', label: 'Length', min: 0.2, max: 5, step: 0.1, value: 1, unit: 'm' }, { id: 'theta0', label: 'Release angle', min: 5, max: 170, step: 1, value: 30, unit: '°' },
    { id: 'g', label: 'Gravity', min: 1.6, max: 25, step: 0.1, value: 9.81, unit: 'm/s²' },
  ],
  energy: [
    { id: 'm', label: 'Mass', min: 0.1, max: 20, step: 0.1, value: 2, unit: 'kg' }, { id: 'h', label: 'Drop height', min: 1, max: 100, step: 1, value: 20, unit: 'm' },
    { id: 'g', label: 'Gravity', min: 1.6, max: 25, step: 0.1, value: 9.81, unit: 'm/s²' },
  ],
  rc: [
    { id: 'R', label: 'Resistance', min: 10, max: 10000, step: 10, value: 1000, unit: 'Ω' }, { id: 'C', label: 'Capacitance', min: 1, max: 1000, step: 1, value: 100, unit: 'µF' },
    { id: 'V', label: 'Supply voltage', min: 1, max: 24, step: 1, value: 9, unit: 'V' },
  ],
  supply_demand: [
    { id: 'a', label: 'Demand intercept (a)', min: 20, max: 200, step: 1, value: 100, unit: 'units' }, { id: 'b', label: 'Demand slope (b)', min: 0.5, max: 10, step: 0.1, value: 2, unit: '' },
    { id: 'c', label: 'Supply intercept (c)', min: -40, max: 40, step: 1, value: 10, unit: 'units' }, { id: 'd', label: 'Supply slope (d)', min: 0.5, max: 10, step: 0.1, value: 3, unit: '' },
    { id: 'tax', label: 'Tax per unit', min: 0, max: 20, step: 0.5, value: 0, unit: '$' },
  ],
};

export interface Series { id: string; label: string; color: string; points: [number, number][]; dashed?: boolean }
export interface Sim { outputs: { label: string; value: number | string; unit?: string }[]; series: Series[]; xLabel: string; yLabel: string; steps?: AlgoStep[]; duration?: number }
export interface AlgoStep { array: number[]; highlight: number[]; note: string }

const rad = (d: number) => (d * Math.PI) / 180;
const fix = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export const projectileState = (v: Env, t: number) => { const th = rad(v.angle); return { x: v.v0 * Math.cos(th) * t, y: v.h0 + v.v0 * Math.sin(th) * t - 0.5 * v.g * t * t }; };

export function pendulumTrajectory(L: number, g: number, theta0: number, tEnd: number, dt = 0.002) {
  // RK4 on theta'' = -(g/L) sin(theta): exact for any amplitude (no small-angle approximation)
  let th = rad(theta0), w = 0; const out: [number, number][] = []; const f = (a: number) => -(g / L) * Math.sin(a);
  for (let t = 0, i = 0; t <= tEnd; t += dt, i++) {
    if (i % 10 === 0) out.push([fix(t, 4), th]);
    const k1t = w, k1w = f(th), k2t = w + 0.5 * dt * k1w, k2w = f(th + 0.5 * dt * k1t), k3t = w + 0.5 * dt * k2w, k3w = f(th + 0.5 * dt * k2t), k4t = w + dt * k3w, k4w = f(th + dt * k3t);
    th += (dt / 6) * (k1t + 2 * k2t + 2 * k3t + k4t); w += (dt / 6) * (k1w + 2 * k2w + 2 * k3w + k4w);
  }
  return out;
}
const measuredPeriod = (traj: [number, number][]) => { const crossings: number[] = []; for (let i = 1; i < traj.length; i++) if (traj[i - 1][1] > 0 && traj[i][1] <= 0) { const [t0, a0] = traj[i - 1], [t1, a1] = traj[i]; crossings.push(t0 + ((0 - a0) * (t1 - t0)) / (a1 - a0)); } return crossings.length >= 2 ? crossings[1] - crossings[0] : NaN; };

export function algoSteps(algo: string, arr: number[]): AlgoStep[] {
  const a = [...arr]; const s: AlgoStep[] = [{ array: [...a], highlight: [], note: 'Start' }];
  if (algo === 'bubble') { for (let i = 0; i < a.length; i++) for (let j = 0; j < a.length - i - 1; j++) { const sw = a[j] > a[j + 1]; if (sw) [a[j], a[j + 1]] = [a[j + 1], a[j]]; s.push({ array: [...a], highlight: [j, j + 1], note: sw ? `${a[j + 1]} > ${a[j]}, swap` : `${a[j]} ≤ ${a[j + 1]}, keep` }); } }
  else if (algo === 'insertion') { for (let i = 1; i < a.length; i++) { const key = a[i]; let j = i - 1; while (j >= 0 && a[j] > key) { a[j + 1] = a[j]; j--; s.push({ array: [...a], highlight: [j + 1, i], note: `shift ${a[j + 1]} right` }); } a[j + 1] = key; s.push({ array: [...a], highlight: [j + 1], note: `insert ${key}` }); } }
  else if (algo === 'selection') { for (let i = 0; i < a.length - 1; i++) { let m = i; for (let j = i + 1; j < a.length; j++) if (a[j] < a[m]) m = j; if (m !== i) [a[i], a[m]] = [a[m], a[i]]; s.push({ array: [...a], highlight: [i, m], note: `minimum of the rest is ${a[i]}` }); } }
  else if (algo === 'binary_search') {
    a.sort((x, y) => x - y); const target = a[Math.floor(a.length * 0.7)]; s.length = 0; s.push({ array: [...a], highlight: [], note: `Sorted array; searching for ${target}` });
    let lo = 0, hi = a.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; s.push({ array: [...a], highlight: [mid], note: `lo=${lo}, hi=${hi}, mid=${mid} → ${a[mid]} ${a[mid] === target ? '= target, found' : a[mid] < target ? '< target, go right' : '> target, go left'}` }); if (a[mid] === target) break; if (a[mid] < target) lo = mid + 1; else hi = mid - 1; }
  }
  return s;
}

export function simulate(scene: Scene, values: Record<string, number>): Sim {
  const v: Env = { ...Object.fromEntries(scene.inputs.map((i) => [i.id, i.value])), ...values };
  const d = scene.data;
  switch (scene.kind) {
    case 'projectile': {
      const s = Math.sin(rad(v.angle)), c = Math.cos(rad(v.angle)); const T = (v.v0 * s + Math.sqrt((v.v0 * s) ** 2 + 2 * v.g * v.h0)) / v.g;
      const pts: [number, number][] = []; for (let i = 0; i <= 60; i++) { const p = projectileState(v, (T * i) / 60); pts.push([fix(p.x), fix(Math.max(0, p.y))]); }
      const vy = v.v0 * s - v.g * T;
      return { xLabel: 'Distance (m)', yLabel: 'Height (m)', duration: T, series: [{ id: 'path', label: 'Trajectory', color: '#4c6ef5', points: pts }],
        outputs: [{ label: 'Range', value: fix(v.v0 * c * T, 2), unit: 'm' }, { label: 'Flight time', value: fix(T, 2), unit: 's' }, { label: 'Maximum height', value: fix(v.h0 + (v.v0 * s) ** 2 / (2 * v.g), 2), unit: 'm' }, { label: 'Impact speed', value: fix(Math.hypot(v.v0 * c, vy), 2), unit: 'm/s' }] };
    }
    case 'spring': {
      const w0 = Math.sqrt(v.k / v.m), gam = v.b / (2 * v.m), wd2 = w0 * w0 - gam * gam; const T = (2 * Math.PI) / w0; const tEnd = Math.max(3 * T, 1);
      const x = (t: number) => (wd2 > 0 ? v.A * Math.exp(-gam * t) * (Math.cos(Math.sqrt(wd2) * t) + (gam / Math.sqrt(wd2)) * Math.sin(Math.sqrt(wd2) * t)) : v.A * Math.exp(-gam * t) * (1 + gam * t));
      const pts: [number, number][] = []; for (let i = 0; i <= 200; i++) { const t = (tEnd * i) / 200; pts.push([fix(t, 3), fix(x(t), 4)]); }
      return { xLabel: 'Time (s)', yLabel: 'Displacement (m)', duration: tEnd, series: [{ id: 'x', label: 'x(t)', color: '#4c6ef5', points: pts }],
        outputs: [{ label: 'Natural period T = 2π√(m/k)', value: fix(T, 3), unit: 's' }, { label: 'Angular frequency ω = √(k/m)', value: fix(w0, 3), unit: 'rad/s' }, { label: 'Total energy ½kA²', value: fix(0.5 * v.k * v.A * v.A, 3), unit: 'J' }, { label: 'Max speed (undamped) Aω', value: fix(v.A * w0, 3), unit: 'm/s' }, { label: 'Damping', value: v.b === 0 ? 'none' : wd2 > 0 ? 'underdamped' : 'critically/over-damped' }] };
    }
    case 'pendulum': {
      const Tsmall = 2 * Math.PI * Math.sqrt(v.L / v.g); const traj = pendulumTrajectory(v.L, v.g, v.theta0, 3 * Tsmall * (1 + v.theta0 / 180));
      const Tm = measuredPeriod(traj);
      return { xLabel: 'Time (s)', yLabel: 'Angle (rad)', duration: traj.at(-1)?.[0] ?? 3, series: [{ id: 'th', label: 'θ(t) (exact numerical)', color: '#4c6ef5', points: traj }],
        outputs: [{ label: 'Small-angle period 2π√(L/g)', value: fix(Tsmall, 3), unit: 's' }, { label: 'Actual period (numerical)', value: Number.isFinite(Tm) ? fix(Tm, 3) : 'n/a', unit: 's' }, { label: 'Small-angle error', value: Number.isFinite(Tm) ? `${fix(((Tsmall - Tm) / Tm) * 100, 2)} %` : 'n/a' }] };
    }
    case 'energy': {
      const pe: [number, number][] = [], ke: [number, number][] = [], tot: [number, number][] = []; for (let i = 0; i <= 50; i++) { const y = (v.h * (50 - i)) / 50; const P = v.m * v.g * y; const K = v.m * v.g * (v.h - y); pe.push([fix(v.h - y, 2), fix(P, 2)]); ke.push([fix(v.h - y, 2), fix(K, 2)]); tot.push([fix(v.h - y, 2), fix(P + K, 2)]); }
      return { xLabel: 'Distance fallen (m)', yLabel: 'Energy (J)', duration: Math.sqrt((2 * v.h) / v.g), series: [{ id: 'pe', label: 'Potential', color: '#e8590c', points: pe }, { id: 'ke', label: 'Kinetic', color: '#2f9e44', points: ke }, { id: 'tot', label: 'Total (conserved)', color: '#868e96', points: tot, dashed: true }],
        outputs: [{ label: 'Initial potential energy mgh', value: fix(v.m * v.g * v.h, 2), unit: 'J' }, { label: 'Impact speed √(2gh)', value: fix(Math.sqrt(2 * v.g * v.h), 2), unit: 'm/s' }, { label: 'Fall time √(2h/g)', value: fix(Math.sqrt((2 * v.h) / v.g), 2), unit: 's' }] };
    }
    case 'rc': {
      const tau = v.R * v.C * 1e-6; const pts: [number, number][] = []; for (let i = 0; i <= 100; i++) { const t = (5 * tau * i) / 100; pts.push([fix(t, 5), fix(v.V * (1 - Math.exp(-t / tau)), 4)]); }
      return { xLabel: 'Time (s)', yLabel: 'Capacitor voltage (V)', duration: 5 * tau, series: [{ id: 'vc', label: 'V_C(t) = V(1 − e^(−t/RC))', color: '#4c6ef5', points: pts }, { id: 'sup', label: 'Supply', color: '#868e96', points: [[0, v.V], [fix(5 * tau, 5), v.V]], dashed: true }],
        outputs: [{ label: 'Time constant τ = RC', value: fix(tau * 1000, 3), unit: 'ms' }, { label: 'Voltage after 1τ (≈63.2 %)', value: fix(v.V * (1 - Math.exp(-1)), 3), unit: 'V' }, { label: 'Charge time to 99 % (≈4.6τ)', value: fix(4.605 * tau * 1000, 2), unit: 'ms' }] };
    }
    case 'supply_demand': {
      const P = (v.a - v.c + v.d * v.tax) / (v.b + v.d), Q = v.a - v.b * P; const pmax = v.a / v.b; const pmin = -v.c / v.d;
      const dem: [number, number][] = [], sup: [number, number][] = []; for (let q = 0; q <= Math.max(1, v.a); q += Math.max(1, v.a) / 40) { dem.push([fix(q, 2), fix((v.a - q) / v.b, 2)]); sup.push([fix(q, 2), fix((q - v.c) / v.d + v.tax, 2)]); }
      return { xLabel: 'Quantity', yLabel: 'Price', series: [{ id: 'd', label: 'Demand', color: '#4c6ef5', points: dem }, { id: 's', label: 'Supply', color: '#e8590c', points: sup }],
        outputs: [{ label: 'Equilibrium price', value: fix(P, 2), unit: '$' }, { label: 'Equilibrium quantity', value: fix(Q, 2) }, { label: 'Tax revenue', value: fix(v.tax * Math.max(Q, 0), 2), unit: '$' }, { label: 'Consumer surplus', value: fix(Math.max(0, ((pmax - P) * Q) / 2), 2) }, { label: 'Producer surplus', value: fix(Math.max(0, ((P - v.tax - Math.max(pmin, 0)) * Q) / 2), 2) }] };
    }
    case 'model': {
      const env: Env = { ...v }; const outs: Sim['outputs'] = [];
      for (const f of d.formulas ?? []) { const val = compile(f.expr)(env); env[f.id] = val; outs.push({ label: f.label, value: Number.isFinite(val) ? fix(val, 4) : 'n/a', unit: f.unit }); }
      const series: Series[] = []; const ch = d.chart; const pal = ['#4c6ef5', '#e8590c', '#2f9e44', '#ae3ec9'];
      if (ch) ch.y.forEach((y: any, k: number) => { const fn = compile(y.expr); const pts: [number, number][] = []; for (let t = ch.from; t <= ch.to + 1e-9; t += ch.step) { const val = fn({ ...env, [ch.x]: t }); pts.push([fix(t, 4), Number.isFinite(val) ? fix(val, 4) : 0]); } series.push({ id: y.id, label: y.label, color: pal[k % 4], points: pts }); });
      return { xLabel: ch?.xLabel ?? '', yLabel: ch?.yLabel ?? '', outputs: outs, series };
    }
    case 'function': {
      const fn = compile(d.expr); const pts: [number, number][] = []; const [lo, hi] = d.range; for (let i = 0; i <= 200; i++) { const x = lo + ((hi - lo) * i) / 200; const y = fn({ ...v, x }); if (Number.isFinite(y)) pts.push([fix(x, 4), fix(y, 4)]); }
      return { xLabel: 'x', yLabel: d.ylabel ?? 'y', outputs: [{ label: 'y(0)', value: fix(fn({ ...v, x: 0 }), 4) }], series: [{ id: 'f', label: d.expr, color: '#4c6ef5', points: pts }] };
    }
    case 'surface': return { xLabel: 'x', yLabel: 'z', outputs: [], series: [] };
    case 'algorithm': { const steps = algoSteps(d.algo, d.array); return { xLabel: '', yLabel: '', outputs: [{ label: 'Steps', value: steps.length - 1 }], series: [], steps }; }
    default: return { xLabel: '', yLabel: '', outputs: [], series: [] };
  }
}

/** z = f(x, y) sampled on a grid (for the 3D surface). */
export function surfaceGrid(scene: Scene, values: Record<string, number>, res = 40) {
  const fn = compile(scene.data.expr); const [xl, xh] = scene.data.range; const [yl, yh] = scene.data.range2 ?? scene.data.range;
  const v: Env = { ...Object.fromEntries(scene.inputs.map((i) => [i.id, i.value])), ...values };
  const z: number[][] = []; let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= res; i++) { const row: number[] = []; for (let j = 0; j <= res; j++) { const val = fn({ ...v, x: xl + ((xh - xl) * i) / res, y: yl + ((yh - yl) * j) / res }); const f = Number.isFinite(val) ? val : 0; row.push(f); lo = Math.min(lo, f); hi = Math.max(hi, f); } z.push(row); }
  return { z, lo, hi, res };
}

export function validateScene(raw: any): Scene {
  if (!raw || typeof raw !== 'object') throw new Error('scene must be an object');
  const kind = SCENE_KINDS.includes(raw.kind) ? (raw.kind as SceneKind) : (() => { throw new Error(`unknown scene kind "${raw.kind}"`); })();
  const builtin = BUILTIN_INPUTS[kind];
  const inputs: Input[] = (builtin ?? (Array.isArray(raw.inputs) ? raw.inputs : [])).slice(0, 8).map((i: any) => {
    const min = num(i.min, 0), max = Math.max(min + 1e-9, num(i.max, 100)); const base = builtin?.find((b) => b.id === i.id);
    const mine = Array.isArray(raw.inputs) ? raw.inputs.find((x: any) => x?.id === i.id) : null; // AI may only choose the default value of a built-in slider
    const value = num(mine?.value ?? mine?.default ?? i.value ?? i.default, base?.value ?? min, min, max);
    return { id: str(i.id, 24).replace(/[^A-Za-z0-9_]/g, '') || 'x', label: str(i.label, 60), min, max, step: num(i.step, (max - min) / 100, 1e-6), value, unit: i.unit ? str(i.unit, 12) : undefined };
  });
  const d = raw.data && typeof raw.data === 'object' ? raw.data : {};
  const data: Record<string, any> = {};
  const env: Env = Object.fromEntries(inputs.map((i) => [i.id, i.value]));
  if (kind === 'model') {
    const ids = new Set(inputs.map((i) => i.id)); const formulas: any[] = []; const dry: Env = { ...env, t: 1 };
    for (const f of (Array.isArray(d.formulas) ? d.formulas : []).slice(0, 14)) {
      const id = str(f.id, 24).replace(/[^A-Za-z0-9_]/g, ''); if (!id || ids.has(id)) continue; const val = compile(String(f.expr))(dry);
      if (!Number.isFinite(val)) throw new Error(`formula "${id}" is not finite for the default inputs`); dry[id] = val; ids.add(id); formulas.push({ id, label: str(f.label, 70), expr: str(f.expr, 300), unit: f.unit ? str(f.unit, 12) : undefined });
    }
    if (!formulas.length) throw new Error('model needs at least one formula');
    data.formulas = formulas;
    if (d.chart?.y?.length) { const xv = str(d.chart.x, 12).replace(/[^A-Za-z0-9_]/g, '') || 't'; const from = num(d.chart.from, 0), to = num(d.chart.to, 24, from + 1, from + 2000); const step = Math.max((to - from) / 400, num(d.chart.step, 1, 1e-6));
      const ys = d.chart.y.slice(0, 4).map((y: any, k: number) => { compile(String(y.expr))({ ...dry, [xv]: from }); return { id: `y${k}`, label: str(y.label, 60), expr: str(y.expr, 300) }; });
      data.chart = { x: xv, from, to, step, y: ys, xLabel: str(d.chart.xLabel, 40), yLabel: str(d.chart.yLabel, 40) }; }
  } else if (kind === 'function' || kind === 'surface') {
    const expr = str(d.expr, 300); const fn = compile(expr); const probe = { ...env, x: 0.5, y: 0.5 }; if (!Number.isFinite(fn(probe))) throw new Error('function is not finite at the test point');
    const r = (x: any): [number, number] => { const a = num(x?.[0], -5, -1e4, 1e4), b = num(x?.[1], 5, -1e4, 1e4); return a < b ? [a, b] : [-5, 5]; };
    data.expr = expr; data.range = r(d.range); data.range2 = r(d.range2 ?? d.range); data.ylabel = str(d.ylabel, 30);
  } else if (kind === 'timeline') {
    data.events = (Array.isArray(d.events) ? d.events : []).slice(0, 40).map((e: any) => ({ year: num(e.year, 0, -10000, 3000), label: str(e.label, 80), desc: str(e.desc, 300), page: e.page ? Math.floor(num(e.page, 1, 1, 100000)) : undefined })).sort((a: any, b: any) => a.year - b.year);
    if (!data.events.length) throw new Error('timeline needs events');
  } else if (kind === 'map') {
    const nodes = (Array.isArray(d.nodes) ? d.nodes : []).slice(0, 40).map((n: any, i: number) => ({ id: str(n.id ?? `n${i}`, 24), label: str(n.label, 60), group: str(n.group, 20), page: n.page ? Math.floor(num(n.page, 1, 1, 100000)) : undefined, detail: str(n.detail, 300) }));
    const ids = new Set(nodes.map((n: any) => n.id));
    data.nodes = nodes; data.edges = (Array.isArray(d.edges) ? d.edges : []).filter((e: any) => ids.has(e?.from) && ids.has(e?.to)).slice(0, 80).map((e: any) => ({ from: e.from, to: e.to, label: str(e.label, 40) }));
    data.mapKind = ['concept', 'argument', 'causal'].includes(d.mapKind) ? d.mapKind : 'concept';
    if (nodes.length < 2) throw new Error('map needs at least two nodes');
  } else if (kind === 'algorithm') {
    data.algo = ['bubble', 'insertion', 'selection', 'binary_search'].includes(d.algo) ? d.algo : 'bubble';
    data.array = (Array.isArray(d.array) ? d.array : [5, 2, 9, 1, 7, 3]).slice(0, 14).map((x: any) => Math.round(num(x, 0, -999, 999)));
    if (data.array.length < 3) data.array = [5, 2, 9, 1, 7, 3];
  }
  let objects: Obj3D[] | undefined;
  if (kind === 'diagram3d') {
    objects = (Array.isArray(raw.objects) ? raw.objects : []).slice(0, 60).filter((o: any) => ['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'line'].includes(o?.shape)).map((o: any, i: number): Obj3D => ({
      id: str(o.id ?? `o${i}`, 24), shape: o.shape, position: vec3(o.position, [0, 0, 0]), scale: vec3(o.scale, [1, 1, 1]), color: color(o.color), label: o.label ? str(o.label, 40) : undefined, opacity: num(o.opacity, 1, 0.1, 1), explain: o.explain ? str(o.explain, 300) : undefined,
      points: o.shape === 'line' && Array.isArray(o.points) ? o.points.slice(0, 40).map((p: any) => vec3(p, [0, 0, 0])) : undefined,
      animate: o.animate && ['rotate', 'oscillate', 'orbit', 'pulse'].includes(o.animate.type) ? { type: o.animate.type, axis: ['x', 'y', 'z'].includes(o.animate.axis) ? o.animate.axis : 'y', speed: num(o.animate.speed, 1, -10, 10), amplitude: num(o.animate.amplitude, 1, 0, 20) } : undefined,
    }));
    if (!objects?.length) throw new Error('diagram3d needs objects');
  }
  const p = raw.predict;
  const predict = p && Array.isArray(p.options) && p.options.length >= 2 && Number.isInteger(p.correct) && p.correct >= 0 && p.correct < p.options.length
    ? { question: str(p.question, 300), options: p.options.slice(0, 5).map((o: any) => str(o, 160)), correct: p.correct, explanation: str(p.explanation, 500) } : undefined;
  const scene: Scene = {
    schema: 'folio.scene.v1', kind, title: str(raw.title, 120) || 'Interactive lesson', objective: str(raw.objective, 300), subject: str(raw.subject, 30),
    sources: (Array.isArray(raw.sources) ? raw.sources : []).slice(0, 10).map((s: any) => ({ page: Math.floor(num(s.page, 0, 0, 100000)), quote: s.quote ? str(s.quote, 240) : undefined })).filter((s: any) => s.page > 0),
    inputs, accuracy: ['projectile', 'spring', 'pendulum', 'energy', 'rc', 'supply_demand'].includes(kind) ? 'exact' : 'educational-approximation',
    accuracyNote: kind === 'projectile' ? 'Exact for motion in a vacuum (no air resistance).' : kind === 'spring' ? 'Exact solution of the linear mass-spring(-damper) equation.' : kind === 'pendulum' ? 'Numerical (RK4) solution of the full nonlinear pendulum equation — no small-angle approximation.' : kind === 'energy' ? 'Exact for frictionless free fall (energy conserved).' : kind === 'rc' ? 'Exact first-order RC charging solution.' : kind === 'supply_demand' ? 'Textbook linear supply/demand with a per-unit tax on suppliers; surpluses are triangles of the linear curves.' : 'Educational illustration generated from the book\'s content; formulas are evaluated exactly as written but are only as accurate as the book\'s own model.',
    data, objects, camera: { position: vec3(raw.camera?.position, [6, 5, 8]), target: vec3(raw.camera?.target, [0, 1, 0]) }, lighting: { ambient: num(raw.lighting?.ambient, 0.6, 0, 3), directional: num(raw.lighting?.directional, 1, 0, 5) },
    predict, explain: str(raw.explain, 1500), apply: raw.apply?.problem ? { problem: str(raw.apply.problem, 500), hint: raw.apply.hint ? str(raw.apply.hint, 300) : undefined, answer: raw.apply.answer ? str(raw.apply.answer, 500) : undefined } : undefined,
    questions: (Array.isArray(raw.questions) ? raw.questions : []).slice(0, 5).filter((q: any) => q?.q).map((q: any) => ({ q: str(q.q, 300), a: str(q.a, 500) })),
  };
  if (kind !== 'timeline' && kind !== 'map' && kind !== 'diagram3d') simulate(scene, {}); // dry run must not throw
  void parse;
  return scene;
}
