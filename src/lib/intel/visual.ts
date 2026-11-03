// Book page(s) -> a validated, interactive scene. The model picks the visualisation and fills in DATA; the maths is built in.
import { all, get } from '../db';
import { chat, parseJson, NoModelError } from '../ollama';
import { SAFETY, pageText } from '../rag';
import { validateScene, BUILTIN_INPUTS, SCENE_KINDS, simulate, type Scene, type SceneKind } from '../scene/schema';
import { createAsset, getAsset, updateAsset, type Source } from './assets';
import { ensureBasic, pageIntel } from './pageintel';
import { registerTask, type Ctx } from './tasks';

/** Hand-written, checked teaching sequences for the exact models (PREDICT → EXPLORE → TEST → EXPLAIN → APPLY). */
export const TEMPLATES: Record<string, Pick<Scene, 'predict' | 'explain' | 'apply' | 'questions'> & { objective: string }> = {
  projectile: {
    objective: 'See how launch speed, angle and height determine where and when a projectile lands.',
    predict: { question: 'The same ball is launched with the same speed once at 30° and once at 45° from the ground. Which goes farther (no air resistance)?', options: ['30°', '45°', 'Both land at the same place'], correct: 1, explanation: 'Range is v²·sin(2θ)/g, which is largest when 2θ = 90°, i.e. θ = 45°. (30° and 60° land at the same place, but 45° beats both.)' },
    explain: 'Horizontal and vertical motion are independent. Horizontally the speed stays constant: x = v₀cosθ·t. Vertically gravity pulls it down: y = h₀ + v₀sinθ·t − ½gt². Eliminating t gives the parabola you see.',
    apply: { problem: 'A football is kicked from the ground at 20 m/s at 40°. How far does it travel? (g = 9.81 m/s²)', hint: 'R = v₀² sin(2θ) / g', answer: 'R = 400·sin80° / 9.81 ≈ 40.2 m' },
    questions: [{ q: 'What angle gives maximum range from level ground?', a: '45° (in a vacuum).' }, { q: 'What does launching from a higher point do to the flight time?', a: 'It increases it, because the projectile has farther to fall.' }],
  },
  spring: {
    objective: 'Relate mass, spring stiffness and amplitude to the period and energy of oscillation.',
    predict: { question: 'You quadruple the mass on a spring. What happens to the oscillation period?', options: ['It doubles', 'It quadruples', 'It stays the same', 'It halves'], correct: 0, explanation: 'T = 2π√(m/k), so T ∝ √m: four times the mass gives twice the period.' },
    explain: 'Hooke\'s law F = −kx gives simple harmonic motion with ω = √(k/m). The period does not depend on the amplitude. Energy swaps between spring (½kx²) and kinetic (½mv²); the total ½kA² stays constant unless there is damping.',
    apply: { problem: 'A 0.5 kg mass hangs on a 50 N/m spring. What is the period?', hint: 'T = 2π√(m/k)', answer: 'T = 2π√(0.5/50) = 2π·0.1 ≈ 0.63 s' },
    questions: [{ q: 'Does a larger amplitude change the period?', a: 'No — for an ideal spring the period is independent of amplitude.' }],
  },
  pendulum: {
    objective: 'Discover what the period of a pendulum depends on — and what it does not.',
    predict: { question: 'Does a heavier bob make a pendulum swing faster?', options: ['Yes, faster', 'No, mass does not affect the period', 'Only at large angles'], correct: 1, explanation: 'For a simple pendulum T ≈ 2π√(L/g): mass cancels out. Only length and gravity matter (and amplitude slightly, at large angles).' },
    explain: 'The restoring torque is proportional to sinθ. For small angles sinθ ≈ θ, giving T = 2π√(L/g). This lab integrates the full equation, so you can see the small-angle formula drift at large release angles.',
    apply: { problem: 'A 2.0 m pendulum swings through small angles on Earth. What is its period?', hint: 'T = 2π√(L/g)', answer: 'T = 2π√(2.0/9.81) ≈ 2.84 s' },
    questions: [{ q: 'Why is the small-angle formula inaccurate at 150°?', a: 'Because sinθ is no longer ≈ θ, so the real period is longer than 2π√(L/g).' }],
  },
  energy: {
    objective: 'Watch potential energy turn into kinetic energy while the total stays constant.',
    predict: { question: 'You drop an object from twice the height. How does its impact speed change?', options: ['It doubles', 'It increases by √2', 'It quadruples'], correct: 1, explanation: 'mgh = ½mv² gives v = √(2gh), so doubling h multiplies v by √2.' },
    explain: 'With no friction, mgh at the top converts completely to ½mv² at the bottom. The two curves always sum to the same total, which is conservation of mechanical energy. Mass cancels from the speed.',
    apply: { problem: 'A 2 kg object is dropped from 10 m. How fast is it moving just before impact?', hint: 'v = √(2gh)', answer: 'v = √(2·9.81·10) ≈ 14.0 m/s' },
    questions: [{ q: 'Does mass affect the impact speed in free fall?', a: 'No — it cancels in mgh = ½mv².' }],
  },
  rc: {
    objective: 'Understand how resistance and capacitance set how quickly a capacitor charges.',
    predict: { question: 'You double the resistance in an RC charging circuit. What happens to the charging time?', options: ['It halves', 'It doubles', 'It is unchanged'], correct: 1, explanation: 'The time constant is τ = RC, so doubling R doubles τ and the capacitor charges more slowly.' },
    explain: 'The capacitor voltage follows V(1 − e^(−t/RC)). After one time constant τ = RC it has reached about 63 % of the supply; after about 5τ it is effectively full.',
    apply: { problem: 'R = 10 kΩ and C = 47 µF. What is the time constant?', hint: 'τ = R·C', answer: 'τ = 10 000 Ω × 47×10⁻⁶ F = 0.47 s' },
    questions: [{ q: 'How long to reach about 99 % of the supply voltage?', a: 'About 4.6 time constants.' }],
  },
  supply_demand: {
    objective: 'See how a market settles at equilibrium and how a tax shifts it.',
    predict: { question: 'A per-unit tax is placed on suppliers. What happens to the equilibrium quantity?', options: ['It rises', 'It falls', 'It is unchanged'], correct: 1, explanation: 'The tax raises suppliers\' costs, shifting the supply curve up; the new equilibrium has a higher price and a lower quantity.' },
    explain: 'Equilibrium is where quantity demanded equals quantity supplied. A tax drives a wedge between what buyers pay and what sellers keep; how it is shared depends on the relative slopes of the curves.',
    apply: { problem: 'With a=100, b=2, c=10, d=3 and no tax, what are the equilibrium price and quantity?', hint: 'Set a − bP = c + dP', answer: 'P = (100 − 10)/(2 + 3) = 18; Q = 100 − 2·18 = 64' },
    questions: [{ q: 'Who bears more of a tax: the side with the steeper or flatter curve?', a: 'The side with the less responsive (steeper) curve bears more of it.' }],
  },
};

const KIND_HELP = `kinds and what "data" must contain:
- projectile | spring | pendulum | energy | rc | supply_demand: exact built-in physics/economics models. "data" = {} ; optionally "inputs":[{"id":"v0","value":30}] to set DEFAULT slider values suggested by the text. Choose these ONLY when the page is about that phenomenon.
- model: a business/finance/engineering calculator. "inputs":[{"id","label","min","max","step","value","unit"}] (max 6) and data={"formulas":[{"id","label","expr","unit"}],"chart":{"x":"t","from":0,"to":24,"step":1,"xLabel":"Month","yLabel":"$","y":[{"label","expr"}]}}. Formula "expr" uses + - * / ^ ( ), numbers, input ids, earlier formula ids, and functions sin cos tan exp ln log sqrt abs min max pow pmt fv npv if. Use ONLY quantities and relationships stated or clearly implied by the page.
- function: data={"expr":"a*sin(b*x)","range":[-6.3,6.3],"ylabel":"y"} with inputs for parameters a,b,… (variable is x).
- surface: data={"expr":"sin(x)*cos(y)","range":[-3,3],"range2":[-3,3]} (variables x and y).
- timeline: data={"events":[{"year":1914,"label":"short","desc":"one sentence from the page","page":N}]} using ONLY events stated in the text.
- map: data={"mapKind":"concept|argument|causal","nodes":[{"id":"a","label":"…","detail":"…","page":N}],"edges":[{"from":"a","to":"b","label":"supports|causes|contradicts|…"}]} (max 14 nodes).
- algorithm: data={"algo":"bubble|insertion|selection|binary_search","array":[5,2,9,1]}.
- diagram3d: a schematic of a mechanism/structure/molecule/system from primitives. "objects":[{"id","shape":"box|sphere|cylinder|cone|torus|plane|line","position":[x,y,z],"scale":[x,y,z],"color":"#RRGGBB","label","explain","animate":{"type":"rotate|oscillate|orbit|pulse","axis":"y","speed":1,"amplitude":1}}] (max 25, positions within ±6).`;

function pick(bookId: string, pages: number[]) {
  const hints = pages.flatMap((p) => pageIntel(bookId, p)?.data?.basic?.methodHints ?? []);
  const subj = new Map<string, number>(); for (const p of pages) for (const s of pageIntel(bookId, p)?.data?.basic?.subjects ?? []) subj.set(s.id, (subj.get(s.id) ?? 0) + s.score);
  return { hints, subjects: [...subj.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id) };
}

/** Deterministic, source-grounded fallbacks when the model is unavailable or returns something invalid. */
function fallbackScene(bookId: string, pages: number[], kind: SceneKind | undefined, why: string): Scene {
  const first = pages[0];
  const years = pages.flatMap((p) => (pageIntel(bookId, p)?.data?.basic?.years ?? []).map((y: any) => ({ ...y, page: p })));
  const ai = pages.map((p) => pageIntel(bookId, p)?.data?.ai).filter(Boolean);
  const src = [{ page: first }];
  if ((kind === 'timeline' || !kind) && years.length >= 3) return validateScene({ kind: 'timeline', title: 'Timeline from the text', objective: 'Place the dated events in order.', sources: src, explain: 'Events are the years mentioned in the selected pages, with the sentence each appears in.', data: { events: years.slice(0, 20).map((y: any) => ({ year: y.year, label: y.sentence.slice(0, 70), desc: y.sentence, page: y.page })) } });
  const concepts = [...new Set(ai.flatMap((a: any) => [a.main_concept, ...(a.supporting_concepts ?? [])]).filter(Boolean))].slice(0, 10) as string[];
  if (concepts.length >= 2) return validateScene({ kind: 'map', title: 'Concept map', objective: 'See how the page\'s ideas fit together.', sources: src, explain: `Concepts found on the selected pages. Links are shown as co-occurrence (${why}).`, data: { mapKind: 'concept', nodes: concepts.map((c, i) => ({ id: `n${i}`, label: c, page: first })), edges: concepts.slice(1).map((_, i) => ({ from: 'n0', to: `n${i + 1}`, label: 'relates to' })) } });
  throw new Error(`Could not build a visual from these pages (${why}). Run the AI page analysis first, or choose a visualisation type.`);
}

export async function generateScene(bookId: string, pages: number[], want?: string): Promise<{ scene: Scene; model: string | null; how: 'ai' | 'template' }> {
  await ensureBasic(bookId);
  const text = pages.map((p) => `[Page ${p}]\n${(get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', bookId, p)?.text ?? '').slice(0, 3200)}`).join('\n\n').slice(0, 8000);
  const { hints, subjects } = pick(bookId, pages);
  const wanted = SCENE_KINDS.includes(want as SceneKind) ? (want as SceneKind) : undefined;
  const sys = `${SAFETY}
You design ONE interactive learning visualisation for the book pages provided, choosing the visualisation type that actually fits the content (do not default to a generic diagram). ${wanted ? `The reader asked for kind "${wanted}".` : ''}
Page analysis hints — subjects: ${subjects.join(', ') || 'unknown'}; suggested methods: ${hints.map((h) => h.method).join(', ') || 'none'}.
${KIND_HELP}
Return ONLY JSON: {"kind":"…","title":"…","objective":"what the learner will understand","subject":"…","why":"why this visualisation suits these pages","inputs":[…],"data":{…},"objects":[…],"explain":"2-4 sentences explaining the idea using the text","predict":{"question","options":["…","…"],"correct":0,"explanation"},"apply":{"problem","hint","answer"},"questions":[{"q","a"}],"sources":[{"page":N,"quote":"short VERBATIM quote from the page"}]}
Rules: use only facts and numbers from the text; never invent quotations or page numbers (pages must be among ${pages.join(', ')}); keep it small and correct.`;
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await chat('knowledge', [{ role: 'system', content: sys }, { role: 'user', content: `${lastErr ? `Your previous answer was rejected: ${lastErr}. Fix it.\n\n` : ''}<book_excerpt>\n${text}\n</book_excerpt>` }], { json: true, temperature: 0.3 });
      const j = parseJson<any>(r.text); if (!j) throw new Error('not valid JSON');
      const kind: SceneKind = SCENE_KINDS.includes(j.kind) ? j.kind : wanted ?? 'map';
      // grounding: keep only citations whose page is in range and whose quote really appears on that page
      const fullText = (p: number) => get<{ text: string }>('SELECT text FROM pages WHERE book_id = ? AND page = ?', bookId, p)?.text ?? '';
      const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
      const sources = (Array.isArray(j.sources) ? j.sources : []).filter((s: any) => pages.includes(Number(s?.page))).map((s: any) => ({ page: Number(s.page), quote: s.quote && norm(fullText(Number(s.page))).includes(norm(String(s.quote)).trim()) ? String(s.quote) : undefined }));
      if (!sources.length) sources.push({ page: pages[0], quote: undefined });
      const tpl = TEMPLATES[kind];
      const merged = { ...j, kind, sources,
        objective: j.objective || tpl?.objective, predict: tpl?.predict ?? j.predict, apply: tpl?.apply ?? j.apply, questions: [...(tpl?.questions ?? []), ...(Array.isArray(j.questions) ? j.questions : [])].slice(0, 4),
        explain: [tpl?.explain, j.explain].filter(Boolean).join('\n\n') };
      const scene = validateScene(merged);
      return { scene, model: r.model, how: 'ai' };
    } catch (e: any) { if (e instanceof NoModelError) break; lastErr = String(e?.message ?? e).slice(0, 200); }
  }
  // model unavailable or unusable: a built-in model if the reader asked for one, else a deterministic grounded fallback
  if (wanted && BUILTIN_INPUTS[wanted]) return { scene: validateScene({ kind: wanted, title: `${wanted.replace('_', ' ')} (built-in model)`, ...TEMPLATES[wanted], sources: [{ page: pages[0] }], subject: subjects[0] ?? '' }), model: null, how: 'template' };
  return { scene: fallbackScene(bookId, pages, wanted, lastErr || 'no model'), model: null, how: 'template' };
}

registerTask('visual', async ({ task, payload, update }: Ctx) => {
  const assetId = task.asset_id as string; const bookId = task.book_id as string;
  update(0.1, 'Reading the pages…', 'analysing');
  update(0.3, 'Designing the visualisation…', 'generating');
  try {
    const { scene, model, how } = await generateScene(bookId, payload.pages as number[], payload.kind);
    const sources: Source[] = scene.sources.map((s) => ({ page: s.page, quote: s.quote }));
    updateAsset(assetId, { title: scene.title, status: 'completed', progress: 1, detail: how === 'ai' ? `Designed by ${model}` : 'Built from a template (no AI model used)', spec: scene, meta: { pages: payload.pages, sources, model, how, hasPractice: !!scene.apply, kind: scene.kind } });
  } catch (e: any) { updateAsset(assetId, { status: 'failed', error: e?.message ?? String(e) }); throw e; }
});

export function createVisualAsset(bookId: string, pages: number[], kind?: string) {
  return createAsset({ bookId, kind: 'visual', title: 'Generating visualisation…', status: 'generating', meta: { pages }, spec: {} });
}

void all; void pageText; void simulate; void getAsset;
