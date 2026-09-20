// Types for the builder's draft / publish / recovery RPCs (migrations/outreach/012 + 013).
// Kept here because lib/outreach/types.ts belongs to another workstream.
import type { Graph, GraphNode, Sequence } from '@/lib/outreach/types';

/** Columns added to outreach_sequences by 010 (drafts, stall flags). All optional: older cached rows lack them. */
export type SequenceExt = Sequence & {
  draft_graph?: Graph | null;
  draft_updated_at?: string | null;
  draft_updated_by?: string | null;
  draft_base_version?: number | null;
  stalled_at?: string | null;
  stalled_reason?: string | null;
};

/** Sequence.settings keys from the contract (item 1, 13, 14). */
export interface SequenceSettingsExt {
  stop_on_reply?: boolean;
  stop_on_reply_scope?: 'lead' | 'sender';
  on_reply?: 'exit' | 'hold';
  resume_after_ooo?: boolean;
  ooo_resume_days?: number;
  hold_max_days?: number;
  wait_for_enrichment?: boolean;
  hold_for_ai_review?: boolean;
  withdraw_after_days?: number;
  [k: string]: unknown;
}

export type AssignmentRule = 'round_robin' | 'least_loaded' | 'fixed' | 'fresh_sender' | 'same_sender';

export const ASSIGNMENT_OPTIONS: Array<{ value: AssignmentRule; label: string; help: string }> = [
  { value: 'round_robin', label: 'Round robin', help: 'Leads are dealt to the pool senders in turn.' },
  { value: 'least_loaded', label: 'Least loaded', help: 'Each lead goes to the sender with the fewest live leads.' },
  { value: 'fixed', label: 'Fixed sender', help: 'You pick the sender when you enrol.' },
  { value: 'fresh_sender', label: 'Fresh sender (never contacted this lead)', help: 'Picks a sender that has never invited or messaged the lead. If none is left, the lead is skipped and the preview says why.' },
  { value: 'same_sender', label: 'Same sender as before', help: 'Picks whoever last spoke to the lead, so the conversation stays in one place.' },
];

export interface SaveDraftResult { saved_at: string; base_version: number | null; head_version: number; stale: boolean; unpublished_changes: number }

export interface ImpactIssue { code?: string; message?: string; node_id?: string | null; [k: string]: unknown }

export interface PublishImpactNode { node_id: string; change: 'added' | 'removed' | 'changed'; type: string; text_changed: boolean; delay_changed: boolean; leads_here: number; queued: number }

export interface PublishImpact {
  head_version: number;
  draft_base_version: number | null;
  stale: boolean;
  changes: number;
  in_flight: number;
  already_pinned: number;
  on_changed_step: number;
  past_changed_step: number;
  on_or_after_changed: number;
  before_changed_step: number;
  queued_with_old_text: number;
  waiting_on_changed_delay: number;
  removed_nodes: string[];
  nodes: PublishImpactNode[];
  validation: { errors?: ImpactIssue[]; warnings?: ImpactIssue[] } | null;
}

export type PublishMode = 'all' | 'new_only';
export type RemovedMode = 'skip' | 'exit';

export interface PublishResult { version: number; mode: PublishMode; pinned: number; queued_updated: number; rescheduled: number; removed_step_leads: number }

export interface VersionUsageRow { version: number; created_at: string; note: string | null; publish_mode: PublishMode | null; is_head: boolean; live_leads: number }
export interface MoveToLatestResult { moved: number; kept_on_old_version: number }

export interface QueuedActionRow { action_id: string; lead_id: string | null; lead_name: string | null; sender_id: string; payload: Record<string, any> | null; scheduled_for: string; variant_id: string | null }

export type FailedKind = 'failed' | 'skipped';
export interface FailedLeadRow {
  enrollment_id: string; lead_id: string; lead_name: string | null; company: string | null; sender_id: string; sender_name: string | null;
  node_id: string | null; error_code: string | null; reason: string; at: string | null; recoverable: boolean;
}
export type RecoverAction = 'retry' | 'skip' | 'exit';
export interface RecoverResult { done: number; action?: RecoverAction; refused: Array<{ id: string; reason: string }> }

export const REFUSED_REASON: Record<string, string> = {
  not_found: 'the enrolment no longer exists',
  not_failed: 'the lead is no longer in a failed state',
  lead_suppressed: 'the lead is on a do-not-contact list',
  profile_invalid: 'LinkedIn says the profile cannot be contacted',
  already_enrolled_again: 'the lead is already running again with this sender',
  sender_gone: 'the sender was removed or disabled',
};

export interface RebalanceSenderRow { sender_id: string; name: string | null; status: string; in_pool: boolean; untouched: number; contacted: number; after: number }
export interface RebalancePreview {
  pool_size: number; added: string[]; removed: string[]; untouched_total: number; would_move: number; target_per_sender: number;
  senders: RebalanceSenderRow[]; contacted_on_removed: number; note: string;
}
export interface SetPoolResult { pool: string[]; moved: number; exited: number }

export interface WhyCause {
  code: string; blocking: boolean; detail: string; remedy?: string | null; sender?: string | null; sender_id?: string | null;
  next_capacity?: string | null; partial?: boolean; task_id?: string | null;
}
export interface WhyNotSendingResult { target: string | null; blocked: boolean; reason: string; causes: WhyCause[]; notes: string[]; rule?: string }

export interface AutoEnrolFilter {
  tag_ids?: string[]; stage_id?: string; client_id?: string; title_contains?: string; company_contains?: string; location_contains?: string;
  source?: string; min_followers?: number; posted_within_days?: number;
}
export interface AutoEnrolRule {
  id: string; workspace_id: string; sequence_id: string; name: string; list_id: string | null; filter: AutoEnrolFilter | null;
  daily_cap: number; active: boolean; last_run_at: string | null; created_at: string;
}
export interface AutoEnrolLogRow { id: number; rule_id: string; day: string; matched: number; enrolled: number; skipped: Record<string, number> | null; at: string }

/** Steps whose queued actions carry text a person may want to read or edit before it goes out. */
const TEXT_NODE_TYPES = new Set<string>(['send_message', 'send_invite', 'send_inmail', 'send_email', 'comment_latest_post', 'send_voice_note']);
export function isTextStep(node: GraphNode | null | undefined): boolean { return !!node && TEXT_NODE_TYPES.has(node.type as string); }
export function isDelayStep(node: GraphNode | null | undefined): boolean { return !!node && ((node.type as string) === 'delay' || (!!node.delay && node.delay.amount > 0)); }

export function isLiveStatus(status: Sequence['status']): boolean { return status === 'active' || status === 'paused'; }

export const fmtInt = (n: number | null | undefined): string => Number(n ?? 0).toLocaleString();
export const plural = (n: number, one: string, many = `${one}s`): string => (Number(n) === 1 ? one : many);

export function fmtClock(v: string | number | null | undefined): string {
  if (v == null) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
