// Pure data (safe to import on server and client): rules given to the model together with the OpenUI component prompt.
export const FEEDBACK_RULES = [
  'Use ONLY facts given in the provided evaluation and source passage; never add new facts, quotes or page numbers.',
  'Order: Callout(good) for what the learner got right, Callout(warn) for what was missed, Callout(bad) only if something was wrong, then Compare / KeyPoints / Formula / Quote / Mnemonic to teach the correct explanation, ending with one Steps block "How to improve your answer".',
  'Keep every string short. Write all text in the requested language but keep formulas and technical terms exactly as in the source.',
  'Do not include the learner\'s score. Do not use components that are not listed.',
];
export const PLAN_RULES = [
  'Use ONLY the concepts, numbers and reasons given. Do not invent concepts or statistics.',
  'Use Callout(warn) for the top weakness, KeyPoints for concepts to revise, Steps for a short ordered study plan with durations, and Mnemonic for one motivating cue. Keep it brief.',
];

/** Worked examples shown to the model. Small local models follow these far more reliably than prose rules. */
export const FEEDBACK_EXAMPLE = `root = Panel([good, warn, point, tip, plan])
good = Callout("good", "What you got right", "You explained that growth ties up cash in receivables.")
warn = Callout("warn", "What you missed", "You did not name the cash conversion cycle.")
point = KeyPoints("Key ideas to remember", ["Customers pay after suppliers are paid", "Growth increases cash tied up"])
tip = Mnemonic("Profit is an opinion; cash is a fact.")
plan = Steps("How to improve your answer", ["Name the cash conversion cycle", "Add a numeric example"])`;
export const PLAN_EXAMPLE = `root = Panel([top, revise, steps, cue])
top = Callout("warn", "Biggest gap", "Working capital: forgotten twice this week.")
revise = KeyPoints("Revise these concepts", ["Working capital", "Cash conversion cycle"])
steps = Steps("Today's plan", ["5 min: working capital questions", "5 min: new questions from pages you read"])
cue = Mnemonic("Little and often beats long and rare.")`;
export const FORMAT_RULE = 'Output ONLY OpenUI Lang: one statement per line in the form `name = Component("positional", "arguments")`. NEVER use named arguments (name=value), NEVER write `name.children = ...`, and give Panel an array of references: `root = Panel([a, b, c])`. Every defined name must appear in root.';
