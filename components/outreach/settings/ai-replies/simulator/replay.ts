// "Why did it say that?": turn a real run into a simulator starting point (thread, state, prompt version, lead).
import type { PromptListRow, RunDetail, SimState } from '@/lib/outreach/aiReplies';
import type { PromptScopeRef } from '../prompt/draftContext';
import { EMPTY_LEAD, turnId } from './simModel';
import type { SimLead, SimTurn } from './simModel';

export interface Replay {
  runId: string;
  turns: SimTurn[];
  state: SimState | null;
  version: number | null;
  scope: PromptScopeRef | null;
  lead: SimLead;
  senderId: string;
  leadName: string | null;
  original: { decision: RunDetail['decision']; text: string | null; stageAfter: string | null; rule: string | null };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function buildReplay(run: RunDetail, rows: PromptListRow[] | undefined): Replay {
  const ctx = run.context ?? null;
  const turns: SimTurn[] = (ctx?.thread ?? []).filter((m) => m.text?.trim()).map((m) =>
    m.from === 'prospect' ? { id: turnId(), from: 'prospect', text: m.text } : { id: turnId(), from: 'us', text: m.text, origin: m.from === 'us' ? 'us' : m.from });
  const s = ctx?.state;
  const mpId = run.master_prompt?.id ?? run.master_prompt_id;
  const row = mpId ? rows?.find((r) => r.id === mpId) : undefined;
  const l = (ctx?.lead ?? {}) as Record<string, unknown>;
  return {
    runId: run.id,
    turns,
    state: s ? { stage: s.stage ?? null, exchanges: s.exchanges ?? 0, last_move: s.last_move ?? null, ai_replies_count: s.ai_replies_count ?? 0 } : null,
    version: run.master_prompt?.version ?? run.master_prompt_version ?? null,
    scope: row ? { scope: row.scope, scopeId: row.scope_id } : null,
    lead: {
      ...EMPTY_LEAD,
      full_name: str(l.full_name) || str(l.name) || run.lead_name || '',
      title: str(l.title) || str(l.headline),
      company: str(l.company) || str(l.company_name),
      location: str(l.location),
    },
    senderId: run.sender_id ?? '',
    leadName: run.lead_name,
    original: { decision: run.decision, text: run.final_text ?? run.draft_text, stageAfter: run.stage_after, rule: run.rule_applied },
  };
}
