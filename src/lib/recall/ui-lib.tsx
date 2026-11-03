// OpenUI component library for recall feedback and study plans (https://github.com/thesysdev/openui, MIT).
// The local model writes OpenUI Lang using ONLY these components; the Renderer streams it into live UI.
// Every use is wrapped with a native fallback: the structured evaluation is the source of truth, OpenUI is the presentation layer.
import { defineComponent, createLibrary } from '@openuidev/react-lang';
import { z } from 'zod/v4';

const toneCls: Record<string, string> = { good: 'border-l-4 border-green-500', warn: 'border-l-4 border-amber-500', bad: 'border-l-4 border-red-500', info: 'border-l-4 border-[var(--accent)]' };

export const Callout = defineComponent({
  name: 'Callout', description: 'A highlighted note with a short title. tone: good = what was right, warn = what was missed, bad = what was wrong, info = general.',
  props: z.object({ tone: z.enum(['good', 'warn', 'bad', 'info']), title: z.string(), text: z.string() }),
  component: ({ props }) => <div className={`card p-3 ${toneCls[props.tone]}`}><div className="text-sm font-semibold">{props.title}</div><div className="text-sm text-[var(--ink2)] mt-0.5">{props.text}</div></div>,
});
export const KeyPoints = defineComponent({
  name: 'KeyPoints', description: 'A titled bulleted list of key ideas to remember (max 6 items).',
  props: z.object({ title: z.string(), items: z.array(z.string()) }),
  component: ({ props }) => <div><div className="label mb-1">{props.title}</div><ul className="list-disc ml-5 text-sm space-y-0.5">{props.items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>,
});
export const Steps = defineComponent({
  name: 'Steps', description: 'A titled numbered sequence of steps (a process, a derivation, or a study plan).',
  props: z.object({ title: z.string(), items: z.array(z.string()) }),
  component: ({ props }) => <div><div className="label mb-1">{props.title}</div><ol className="list-decimal ml-5 text-sm space-y-0.5">{props.items.map((x, i) => <li key={i}>{x}</li>)}</ol></div>,
});
export const Formula = defineComponent({
  name: 'Formula', description: 'A formula or equation shown in monospace, exactly as written in the source. Never alter formulas.',
  props: z.object({ text: z.string() }),
  component: ({ props }) => <pre className="card p-2 text-sm font-mono overflow-auto">{props.text}</pre>,
});
export const Quote = defineComponent({
  name: 'Quote', description: 'A short verbatim quotation from the book with its page reference, e.g. source "p. 12".',
  props: z.object({ text: z.string(), source: z.string() }),
  component: ({ props }) => <blockquote className="font-serif border-l-2 border-[var(--accent)] pl-3 text-sm"><div>“{props.text}”</div><div className="text-[11px] text-[var(--ink3)] mt-0.5">{props.source}</div></blockquote>,
});
export const Mnemonic = defineComponent({
  name: 'Mnemonic', description: 'One memorable sentence or cue that helps remember the idea.',
  props: z.object({ text: z.string() }),
  component: ({ props }) => <div className="rounded-lg bg-[var(--panel2)] p-2.5 text-sm">💡 {props.text}</div>,
});
export const Pair = defineComponent({ name: 'Pair', description: 'One row of a comparison: left text and right text.', props: z.object({ left: z.string(), right: z.string() }), component: ({ props }) => <tr className="border-t border-[var(--line)]"><td className="p-1.5 align-top">{props.left}</td><td className="p-1.5 align-top">{props.right}</td></tr> });
export const Compare = defineComponent({
  name: 'Compare', description: 'A two-column comparison table, e.g. what you wrote vs what the book says.',
  props: z.object({ title: z.string(), leftTitle: z.string(), rightTitle: z.string(), rows: z.array(Pair.ref) }),
  component: ({ props, renderNode }) => <div><div className="label mb-1">{props.title}</div><table className="w-full text-sm text-left"><thead><tr className="text-[var(--ink3)] text-xs"><th className="p-1.5">{props.leftTitle}</th><th className="p-1.5">{props.rightTitle}</th></tr></thead><tbody>{props.rows.map((r: unknown, i: number) => <span key={i} style={{ display: 'contents' }}>{renderNode(r)}</span>)}</tbody></table></div>,
});
export const Panel = defineComponent({
  name: 'Panel', description: 'The root container: a vertical stack of blocks.',
  props: z.object({ children: z.array(z.union([Callout.ref, KeyPoints.ref, Steps.ref, Formula.ref, Quote.ref, Mnemonic.ref, Compare.ref])) }),
  component: ({ props, renderNode }) => <div className="space-y-3">{props.children.map((c: unknown, i: number) => <div key={i}>{renderNode(c)}</div>)}</div>,
});

export const recallLibrary = createLibrary({ components: [Panel, Callout, KeyPoints, Steps, Formula, Quote, Mnemonic, Compare, Pair], root: 'Panel' });
export { FEEDBACK_RULES, PLAN_RULES, FEEDBACK_EXAMPLE, PLAN_EXAMPLE, FORMAT_RULE } from './ui-rules';
