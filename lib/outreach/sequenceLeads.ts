// Sequence lead filters, bulk unenroll & Analytics (PRD, 26 Oct 2026; migration 101).
// The filter vocabulary of the sequence Leads tab, the row shapes outreach_sequence_leads / _lead_counts /
// _analytics return, and the small presentational helpers. Nothing here computes a metric: counts come from the
// database (one definition, migration 101 §4), so the dropdown, the tabs, the banner and Analytics agree.
import type { EnrollmentStatus } from './types';

/** One option of the status filter. Stored statuses are unchanged; these are the names people see (PRD feature 1). */
export type LeadFilter =
  | 'live' | 'all'
  | 'active' | 'invite_sent' | 'waiting_task' | 'paused'
  | 'completed' | 'handoff' | 'stopped_by_teammate' | 'sender_disabled' | 'failed' | 'unenrolled';

export type LeadFilterGroup = 'top' | 'progress' | 'ended';

export interface LeadFilterOption {
  key: LeadFilter;
  label: string;
  group: LeadFilterGroup;
  /** What the option means, in words (the dropdown's title / the tab tooltip). */
  help: string;
  /** Shown as a tab above the table as well as in the dropdown. */
  tab?: boolean;
  statuses: EnrollmentStatus[] | null;
}

/**
 * The 12 options, in dropdown order. "Waiting to connect" merged into "Invite sent" (the engine sets waiting_connection
 * the moment the invitation goes out, so they were one state: open question 1), "Waiting" (the Delay-step wait) is
 * part of Active (open question 2), "Stopped: do not contact" is no longer an option but stays in All.
 */
export const LEAD_FILTERS: LeadFilterOption[] = [
  { key: 'live', label: 'Live', group: 'top', help: 'Everyone still in progress: active, invite sent, waiting on a task or paused.', tab: true, statuses: ['active', 'waiting_connection', 'waiting_delay', 'waiting_task', 'paused'] },
  { key: 'all', label: 'All', group: 'top', help: 'Everyone ever enrolled in this sequence.', statuses: null },
  { key: 'active', label: 'Active', group: 'progress', help: 'A step is running or scheduled (including leads waiting out a delay between steps).', statuses: ['active', 'waiting_delay'] },
  { key: 'invite_sent', label: 'Invite sent', group: 'progress', help: 'The connection invite went out and has not been accepted yet.', tab: true, statuses: ['waiting_connection'] },
  { key: 'waiting_task', label: 'Waiting on a task', group: 'progress', help: 'Paused on a manual task, an enrichment or an AI review.', statuses: ['waiting_task'] },
  { key: 'paused', label: 'Paused', group: 'progress', help: 'Paused by a teammate, or held after a reply.', statuses: ['paused'] },
  { key: 'completed', label: 'Finished', group: 'ended', help: 'Completed every step.', tab: true, statuses: ['completed'] },
  { key: 'handoff', label: 'Human handoff', group: 'ended', help: 'Replied, so the sequence stopped and a person takes over.', tab: true, statuses: ['exited_replied'] },
  { key: 'stopped_by_teammate', label: 'Stopped by teammate', group: 'ended', help: 'Stopped by hand (from the inbox, the lead page or a failed-lead action).', statuses: ['exited_manual'] },
  { key: 'sender_disabled', label: 'Sender disabled', group: 'ended', help: 'Stopped because the sender account was disabled.', statuses: ['exited_sender_disabled'] },
  { key: 'failed', label: 'Failed', group: 'ended', help: 'Stopped on an error. The Failed view shows why and offers retry, skip or exit.', statuses: ['failed'] },
  { key: 'unenrolled', label: 'Unenrolled', group: 'ended', help: 'Removed from the sequence with Unenroll. Can be enrolled again from the Leads page.', tab: true, statuses: ['cancelled'] },
];
export const LEAD_FILTER_BY_KEY: Record<LeadFilter, LeadFilterOption> = Object.fromEntries(LEAD_FILTERS.map((o) => [o.key, o])) as Record<LeadFilter, LeadFilterOption>;
export const LEAD_FILTER_GROUP_LABEL: Record<Exclude<LeadFilterGroup, 'top'>, string> = { progress: 'In progress', ended: 'Ended' };
export function isLeadFilter(v: unknown): v is LeadFilter { return typeof v === 'string' && v in LEAD_FILTER_BY_KEY; }

/** The Stopped by column shows for these filters (PRD feature 1). */
export const STOPPED_BY_FILTERS: LeadFilter[] = ['stopped_by_teammate', 'unenrolled', 'all'];

export const ENDED_STATUSES: EnrollmentStatus[] = ['completed', 'exited_replied', 'exited_manual', 'exited_suppressed', 'exited_sender_disabled', 'failed', 'cancelled'];
export function isEnded(status: EnrollmentStatus): boolean { return ENDED_STATUSES.includes(status); }

// ---------------------------------------------------------------------------
// Shapes (outreach_sequence_lead_counts / outreach_sequence_leads)
// ---------------------------------------------------------------------------
export interface LeadCounts {
  all: number; live: number; active: number; invite_sent: number; waiting_task: number; paused: number;
  completed: number; handoff: number; stopped_by_teammate: number; sender_disabled: number; failed: number; unenrolled: number;
  /** Not an option any more; still part of All. */
  do_not_contact: number;
  teammates: Array<{ user_id: string; name: string; count: number }>;
  /** exited_manual rows without a recorded teammate (older data, or stopped by the API / connector as a service). */
  stopped_by_system: number;
}
export const EMPTY_COUNTS: LeadCounts = { all: 0, live: 0, active: 0, invite_sent: 0, waiting_task: 0, paused: 0, completed: 0, handoff: 0, stopped_by_teammate: 0, sender_disabled: 0, failed: 0, unenrolled: 0, do_not_contact: 0, teammates: [], stopped_by_system: 0 };

export interface NextStep { kind: 'action' | 'wait' | 'task' | 'paused'; type?: string | null; node_id?: string | null; label: string; at: string | null; status?: string }
export interface Snippet { text: string | null; at: string; chat_id: string; intent?: string | null }

export interface SequenceLeadRow {
  id: string;
  lead_id: string;
  sender_id: string;
  status: EnrollmentStatus;
  exit_reason: string | null;
  current_node_id: string | null;
  node_entered_at: string;
  wait_until: string | null;
  created_at: string;
  completed_at: string | null;
  held_at: string | null;
  hold_reason: string | null;
  wait_reason: string | null;
  paused_from: EnrollmentStatus | null;
  lead: { id: string; full_name: string | null; company: string | null; headline: string | null; public_identifier: string | null; picture_url: string | null } | null;
  sender: { id: string | null; display_name: string | null; status: string | null } | null;
  /** 1-based number of the current step among the sequence's sending / task steps; null on a wait or delay. */
  step_index: number | null;
  step_total: number;
  step_label: string | null;
  step_type: string | null;
  next: NextStep | null;
  last_message: Snippet | null;
  last_reply: Snippet | null;
  changed_by: { id: string; name: string } | null;
  changed_at: string | null;
}
export interface SequenceLeadsPage { total: number; limit: number; offset: number; step_total: number; rows: SequenceLeadRow[] }

export interface LeadListQuery {
  filter: LeadFilter;
  teammate?: string | null;
  /** Enrolled in this window (workspace days): the link from Analytics. */
  from?: string | null;
  to?: string | null;
  search?: string | null;
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------
export type BulkAction = 'unenroll' | 'pause' | 'resume';
export const BULK_CHUNK = 500;
export const UNDO_SECONDS = 10;
export interface BulkResult { batch_id: string; action: BulkAction; done: number; skipped: number; remaining: number }
export interface BulkPreview { total: number; eligible: number; skipped: number; sequence_name: string }
export interface UndoResult { batch_id: string; restored: number; skipped: number }

export const BULK_ACTION_LABEL: Record<BulkAction, string> = { unenroll: 'Unenroll', pause: 'Pause', resume: 'Resume' };
/** Which statuses each action can touch (the action bar enables an action when at least one selected lead qualifies). */
export function bulkEligible(action: BulkAction, r: Pick<SequenceLeadRow, 'status' | 'held_at'>): boolean {
  if (action === 'unenroll') return !isEnded(r.status);
  if (action === 'pause') return ['active', 'waiting_connection', 'waiting_delay', 'waiting_task'].includes(r.status);
  return r.status === 'paused' && !r.held_at;
}

// ---------------------------------------------------------------------------
// Analytics (outreach_sequence_analytics)
// ---------------------------------------------------------------------------
export interface AnalyticsCards {
  enrolled: number; invites_sent: number; accepted: number; replied: number; interested: number; meetings: number; contacted: number;
  accepted_rate: number | null; replied_rate: number | null; replied_of_contacted_rate: number | null; interested_rate: number | null;
}
export interface AnalyticsProgress { live: number; completed: number; handoff: number; stopped: number; failed: number; unenrolled: number; total: number }
export interface AnalyticsStep {
  node_id: string; step_number: number | null; type: string; label: string; variant_id: string | null; has_variants: boolean;
  sent: number; accepted: number; read: number; replied: number; skipped: number; failed: number;
  accepted_rate: number | null; read_rate: number | null; replied_rate: number | null; skipped_rate: number | null; failed_rate: number | null;
  leads_here: number;
}
/** One workspace day of the Activity chart. The outcome counts arrived with migration 105 (absent = 0 on an older payload). */
export interface AnalyticsDay { day: string; planned: number; sent: number; snapshot: boolean; accepted?: number; replied?: number; interested?: number; meetings?: number }
export interface AnalyticsSender {
  id: string; name: string; provider: string; status: string; status_reason: string | null; in_pool: boolean;
  sent: number; invites: number; accepted: number; replied: number; failed: number; accepted_rate: number | null; replied_rate: number | null; limited: boolean; live: number;
}
export interface AnalyticsTeammate { user_id: string; name: string; handoffs_taken: number; stopped: number; unenrolled: number }
export interface SequenceAnalytics {
  sequence: { id: string; name: string; status: string; head_version: number };
  period: { from: string; to: string; timezone: string; default: boolean };
  first_run_at: string | null;
  empty: boolean;
  cards: AnalyticsCards;
  progress: AnalyticsProgress;
  steps: AnalyticsStep[];
  daily: { days: AnalyticsDay[]; today: string; today_planned: number; today_sent: number; gap_pct: number | null; gap_reason: string | null };
  senders: AnalyticsSender[];
  team: AnalyticsTeammate[];
  handoffs_untaken: number;
  definitions_version: number;
}
export interface AnalyticsLeadRow {
  id: string; lead_id: string; status: EnrollmentStatus; created_at: string; completed_at: string | null;
  lead: { id: string; full_name: string | null; company: string | null; public_identifier: string | null; picture_url: string | null } | null;
  sender: { id: string | null; display_name: string | null } | null;
  step_reached: number; step_total: number; step_label: string | null;
  invited_at: string | null; accepted_at: string | null; replied_at: string | null; positive_at: string | null; meeting_at: string | null;
}
export interface AnalyticsLeadsPage { total: number; limit: number; offset: number; step_total: number; rows: AnalyticsLeadRow[] }

/** The progress bar segments, in order, each with the Leads filter it opens (PRD feature 3 requirement 1). */
export const PROGRESS_SEGMENTS: Array<{ key: keyof Omit<AnalyticsProgress, 'total'>; label: string; filter: LeadFilter; color: string }> = [
  { key: 'live', label: 'Live', filter: 'live', color: '#2a78d6' },
  { key: 'completed', label: 'Finished', filter: 'completed', color: '#1baf7a' },
  { key: 'handoff', label: 'Human handoff', filter: 'handoff', color: '#4a3aa7' },
  { key: 'stopped', label: 'Stopped', filter: 'stopped_by_teammate', color: '#eda100' },
  { key: 'failed', label: 'Failed', filter: 'failed', color: '#e34948' },
  { key: 'unenrolled', label: 'Unenrolled', filter: 'unenrolled', color: '#9ca3af' },
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
/** "Step 3 of 5" / "Ended at step 3 of 5" / "Waiting" for a row of the table. */
export function stepText(r: Pick<SequenceLeadRow, 'step_index' | 'step_total' | 'status'>): string {
  if (!r.step_total) return 'No steps';
  if (r.step_index == null) return isEnded(r.status) ? `Ended · ${r.step_total} steps` : `Between steps · ${r.step_total} steps`;
  return `${isEnded(r.status) ? 'Ended at step' : 'Step'} ${r.step_index} of ${r.step_total}`;
}

/** The share of the progress bar one step represents (0–1). A lead between steps shows the step it just left. */
export function stepShare(index: number | null, total: number): number {
  if (!total) return 0;
  if (index == null) return 0;
  return Math.max(0, Math.min(1, index / total));
}

/** "12 selected · Select all 412 leads matching this filter" numbers (the banner). */
export function selectionText(selected: number, total: number, allMatching: boolean): string {
  const n = allMatching ? total : selected;
  return `${n.toLocaleString()} selected`;
}

/** The confirm sentence of an unenroll (PRD feature 2 step 4). */
export function unenrollConfirmText(n: number, sequenceName: string, skipped: number): { title: string; body: string } {
  const eligible = Math.max(0, n - skipped);
  const title = `Unenroll ${eligible.toLocaleString()} lead${eligible === 1 ? '' : 's'} from ${sequenceName}?`;
  const parts = ['Their scheduled steps are cancelled and they move to Unenrolled.'];
  if (skipped > 0) parts.push(`${skipped.toLocaleString()} lead${skipped === 1 ? ' that has' : 's that have'} already ended will be skipped.`);
  return { title, body: parts.join(' ') };
}
