// Pure helpers for the conversation simulator: turn model, built-in example prospects, thread / scenario conversion
// and error wording. No React here.
import { humanize, parseError } from '@/lib/outreach/api';
import type { Decision, Scenario, SimState, SimThreadMsg, SimulateResult, StageDef } from '@/lib/outreach/aiReplies';

export interface SimLead { full_name: string; title: string; company: string; location: string }
export const EMPTY_LEAD: SimLead = { full_name: '', title: '', company: '', location: '' };

/** One line in the simulated chat. `ai` turns carry the full pipeline result; fixed lines are typed or replayed. */
export type SimTurn =
  | { id: string; from: 'prospect'; text: string }
  | { id: string; from: 'us'; text: string; origin?: 'teammate' | 'ai' | 'us' }
  | { id: string; from: 'ai'; result: SimulateResult; stateBefore: SimState | null };

let seq = 0;
export const turnId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface ExampleProspect { key: string; title: string; lead: SimLead; script: string[] }

// PRD §8.3: five simulated prospects that show the stages in action before anyone edits the template.
export const EXAMPLES: ExampleProspect[] = [
  {
    key: 'price', title: 'Asks the price on turn 1',
    lead: { full_name: 'Priya Nair', title: 'Marketing Director', company: 'Brightline Foods', location: 'Mumbai, India' },
    script: ['Hi, thanks for reaching out. What do you charge for this?', 'Ok. And how long does it usually take?', 'Sounds good, can we do a quick call this week?'],
  },
  {
    key: 'short', title: 'One-word answers',
    lead: { full_name: 'Tom Becker', title: 'Head of Growth', company: 'Northwind Labs', location: 'Berlin, Germany' },
    script: ['Sure', 'Maybe', 'ok'],
  },
  {
    key: 'later', title: 'Not now, after Diwali',
    lead: { full_name: 'Rahul Mehta', title: 'Founder', company: 'Kestrel Home', location: 'Bengaluru, India' },
    script: ["Interesting, but we're swamped until the festive season. Can we talk after Diwali?"],
  },
  {
    key: 'referral', title: 'Wrong person, refers Karin',
    lead: { full_name: 'Jonas Lind', title: 'Sales Manager', company: 'Fjord Outdoor', location: 'Stockholm, Sweden' },
    script: ["I don't handle this. Please reach out to Karin Elwin, our Head of Marketing, at karin.elwin@fjord-outdoor.example."],
  },
  {
    key: 'bot', title: 'Are you a bot?',
    lead: { full_name: 'Emily Carter', title: 'Operations Lead', company: 'Harbor & Co', location: 'London, UK' },
    script: ['Is this an automated message? Are you a bot?'],
  },
];

/** Did this AI turn end up as a message in the chat? */
export const aiSent = (r: SimulateResult) => r.final_decision === 'send' && !!r.text?.trim();

/** The thread the engine sees: our typed lines as `us` (or their replayed origin), sent AI replies as `ai`. */
export function toThread(turns: SimTurn[]): SimThreadMsg[] {
  const out: SimThreadMsg[] = [];
  for (const t of turns) {
    if (t.from === 'prospect') out.push({ from: 'prospect', text: t.text });
    else if (t.from === 'us') out.push({ from: t.origin && t.origin !== 'us' ? t.origin : 'us', text: t.text });
    else if (aiSent(t.result)) out.push({ from: 'ai', text: t.result.text! });
  }
  return out;
}

/** State for the next AI turn: the last AI turn's `state_after`, else the starting state. */
export function currentState(turns: SimTurn[], start: SimState | null): SimState | null {
  for (let i = turns.length - 1; i >= 0; i--) { const t = turns[i]; if (t.from === 'ai') return t.result.state_after; }
  return start;
}

/**
 * Scenario form (contract §2): `turns` are prospect / us lines (sent AI replies become fixed `us` lines);
 * `expected[].after_turn` is the 0-based index in `turns` of the last line the AI had seen when it decided.
 */
export function toScenario(turns: SimTurn[]): { turns: Scenario['turns']; expected: Scenario['expected'] } {
  const out: Scenario['turns'] = [];
  const expected: Scenario['expected'] = [];
  for (const t of turns) {
    if (t.from === 'prospect') out.push({ from: 'prospect', text: t.text });
    else if (t.from === 'us') out.push({ from: 'us', text: t.text });
    else {
      if (out.length) {
        const e = { after_turn: out.length - 1, decision: t.result.final_decision, stage_after: t.result.stage_after ?? null };
        // asked twice at the same point: the later answer is the one that counts
        if (expected.length && expected[expected.length - 1].after_turn === e.after_turn) expected[expected.length - 1] = e;
        else expected.push(e);
      }
      if (aiSent(t.result)) out.push({ from: 'us', text: t.result.text! });
    }
  }
  return { turns: out, expected };
}

/** Load a saved scenario back into the chat as fixed lines. */
export const fromScenario = (s: Scenario): SimTurn[] =>
  s.turns.map((t) => (t.from === 'prospect' ? { id: turnId(), from: 'prospect' as const, text: t.text } : { id: turnId(), from: 'us' as const, text: t.text }));

export const DECISION_LABEL: Record<Decision, string> = { send: 'Reply', no_reply: 'No reply', escalate: 'Hand to a person' };

export function stageLabeler(stages: StageDef[] | undefined) {
  return (key: string | null | undefined) => {
    if (!key) return '—';
    if (key === 'closing') return 'Closing';
    const i = stages?.findIndex((s) => s.key === key) ?? -1;
    return i >= 0 ? `${i + 1} · ${stages![i].label}` : key;
  };
}

/** Classification entries → flat, de-duplicated flag list. */
export function flagsOf(classification: SimulateResult['classification'] | undefined): string[] {
  const out = new Set<string>();
  for (const c of classification ?? []) {
    const f = (c as { flags?: unknown }).flags;
    if (Array.isArray(f)) f.forEach((x) => typeof x === 'string' && out.add(x));
  }
  return [...out];
}

/** Human error text; AI setup problems point to AI → Setup → General. */
export function aiErrorText(e: unknown): { message: string; setup: boolean } {
  const err = parseError(e);
  if (err.code === 'E_AI_UNAVAILABLE') return { message: 'AI drafting is not set up for this workspace yet. Add an AI key in AI → Setup → General, or ask the platform team to switch it on.', setup: true };
  if (err.code === 'E_AI_KEY_INVALID') return { message: `The workspace's AI key was rejected. Check it in AI → Setup → General. ${err.message}`.trim(), setup: true };
  if (err.code === 'E_FORBIDDEN') return { message: 'Only owners and managers can do this.', setup: false };
  return { message: !err.message || err.message === err.code ? humanize(err.code) : err.message, setup: false };
}
