// Shared types for the Outreach platform (mirrors migrations/outreach/*.sql, including 009–016)

export type Role = 'owner' | 'manager' | 'member' | 'client_viewer';
export type Provider = 'LINKEDIN' | 'GMAIL' | 'OUTLOOK' | 'IMAP';
export type AuthMethod = 'credentials' | 'cookie' | 'oauth';
export type SenderStatus = 'connecting' | 'ok' | 'credentials' | 'error' | 'paused' | 'disabled';
export type Relation = 'none' | 'pending_out' | 'pending_in' | 'first' | 'blocked' | 'invalid';
export type ActionType =
  | 'profile_view' | 'invite' | 'withdraw' | 'message' | 'inmail' | 'like' | 'comment'
  | 'endorse' | 'search_page' | 'email' | 'reply' | 'relations_poll' | 'call_api'
  | 'post_fetch' | 'follow' | 'find_email';
export type ActionStatus = 'queued' | 'reserved' | 'sent' | 'skipped' | 'failed' | 'cancelled';
export type EnrollmentStatus =
  | 'active' | 'waiting_connection' | 'waiting_delay' | 'waiting_task' | 'paused' | 'completed'
  | 'exited_replied' | 'exited_manual' | 'exited_suppressed' | 'exited_sender_disabled' | 'failed' | 'cancelled';
export type SequenceStatus = 'draft' | 'active' | 'paused' | 'archived';
export type Direction = 'in' | 'out';
export type Intent = 'interested' | 'question' | 'not_now' | 'not_interested' | 'ooo' | 'wrong_person' | 'unclear' | 'unclassified';
export type ImportKind =
  | 'search_url' | 'csv' | 'relations'
  | 'post_engagement' | 'conversations' | 'sn_saved_search' | 'sn_lead_list' | 'company_people';
export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export type TaskKind = 'manual_node' | 'follow_up' | 'review_ai_draft' | 'reconnect' | 'reply_hold' | 'call';
export type EnrichStatus = 'none' | 'waiting' | 'done' | 'failed';
export type EmailStatus = 'verified' | 'unverified' | 'invalid';
export type ReplyChannel = 'linkedin' | 'email';
/** Why an enrollment sits in `waiting_task` without a task (set at enrol time or by the AI routing step). */
export type WaitReason = 'enrichment' | 'ai_review' | 'ai_route';
export type CallOutcome = 'connected' | 'voicemail' | 'no_answer' | 'wrong_number';
export const CALL_OUTCOMES: CallOutcome[] = ['connected', 'voicemail', 'no_answer', 'wrong_number'];

export const LIVE_ENROLLMENT_STATUSES: EnrollmentStatus[] = ['active', 'waiting_connection', 'waiting_delay', 'waiting_task', 'paused'];

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: Role;
  client_ids: string[];
  can_reply: boolean;
  settings: Record<string, unknown>;
  trial_ends_at: string | null;
  stripe_status: string | null;
  past_due_since: string | null;
}

export interface Client {
  id: string;
  workspace_id: string;
  name: string;
  slug: string | null;
  timezone: string | null;
  settings: Record<string, unknown>;
  created_at: string;
}

export interface Member {
  user_id: string;
  role: Role;
  client_ids: string[];
  can_reply: boolean;
  email: string | null;
  display_name: string | null;
  created_at: string;
}

export interface Invitation {
  id: string;
  workspace_id: string;
  email: string;
  role: Role;
  client_ids: string[];
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

export type ScheduleWindow = [string, string];
export type Schedule = Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', ScheduleWindow[]>;

export interface Sender {
  id: string;
  workspace_id: string;
  client_id: string | null;
  owner_user_id: string | null;
  owner_email: string | null;
  provider: Provider;
  unipile_account_id: string | null;
  auth_method: AuthMethod;
  display_name: string | null;
  public_identifier: string | null;
  provider_user_id: string | null;
  picture_url: string | null;
  is_premium: boolean;
  has_sales_nav: boolean;
  has_recruiter: boolean;
  connections_count: number | null;
  status: SenderStatus;
  status_reason: string | null;
  proxy_country: string | null;
  user_agent: string | null;
  timezone: string;
  schedule: Schedule;
  warmup_level: number;
  warmup_locked_until: string | null;
  health_score: number;
  health_breakdown: Record<string, number>;
  manual_caps: Partial<Record<ActionType, number>>;
  rejects_1h: number;
  paused_until: string | null;
  invite_blocked_until: string | null;
  reconnect_attempts: number;
  connected_at: string | null;
  last_ok_at: string | null;
  last_disconnect_at: string | null;
  last_synced_at: string | null;
  extension_token_issued_at: string | null;
  // 010_schema_v2
  running_dry_at: string | null;
  alert_emails: string[];
  booking_link: string | null;
  /** HTML signature, used as {{sender.signature}}. */
  signature: string | null;
  bcc_address: string | null;
  /** Set on a mailbox that belongs to a person (a LinkedIn sender): "the sender's own mailboxes". */
  parent_sender_id: string | null;
  monthly_cost: number | null;
  /** null = follow the workspace default. */
  track_replies: boolean | null;
  enrich_empty_streak: number;
  enrich_backoff_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface SenderBudget {
  sender_id: string;
  day: string;
  action_type: ActionType;
  cap: number;
  used: number;
  reserved: number;
}

export interface SenderEvent {
  id: number;
  sender_id: string;
  kind: string;
  data: Record<string, unknown>;
  at: string;
}

export interface Lead {
  id: string;
  workspace_id: string;
  client_id: string | null;
  public_identifier: string | null;
  provider_id: string | null;
  profile_url: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  headline: string | null;
  company: string | null;
  company_id: string | null;
  title: string | null;
  location: string | null;
  picture_url: string | null;
  email_work: string | null;
  email_personal: string | null;
  is_open_profile: boolean | null;
  custom: Record<string, unknown>;
  list_id: string | null;
  stage_id: string | null;
  do_not_contact: boolean;
  unsubscribed: boolean;
  source: string | null;
  import_job_id: string | null;
  last_profile_fetch_at: string | null;
  // 010_schema_v2
  /** Last reply to any sender on any channel (the enrol guard looks back 90 days). */
  last_replied_at: string | null;
  last_replied_channel: ReplyChannel | null;
  phone: string | null;
  enrich_status: EnrichStatus;
  enriched_at: string | null;
  email_status: EmailStatus | null;
  created_at: string;
  updated_at: string;
}

export interface LeadSenderState {
  lead_id: string;
  sender_id: string;
  relation: Relation;
  invitation_id: string | null;
  invite_sent_at: string | null;
  invite_accepted_at: string | null;
  invite_detected_at: string | null;
  invite_withdrawn_at: string | null;
  invite_had_note: boolean | null;
  unipile_chat_id: string | null;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  replied: boolean;
  email_bounced: boolean;
  updated_at: string;
}

export interface List { id: string; workspace_id: string; client_id: string | null; name: string }
export type StageKind = 'new' | 'contacted' | 'connected' | 'replied' | 'interested' | 'meeting' | 'won' | 'lost';
export interface Stage { id: string; workspace_id: string; name: string; position: number; color: string | null; kind: StageKind | null; deal_value: number | null }
export interface Tag { id: string; workspace_id: string; name: string; color: string | null }
export type SuppressionKind = 'domain' | 'public_identifier' | 'email' | 'company';
/** Scope: both ids null = the whole workspace; `client_id` = one client; `sequence_id` = one sequence (never both). */
export interface Suppression {
  id: string;
  workspace_id: string;
  client_id: string | null;
  sequence_id: string | null;
  kind: SuppressionKind;
  value: string;
  reason: string | null;
  /** manual | csv | crm | unsubscribe */
  source: string;
  created_at: string;
}

export interface ImportJob {
  id: string;
  workspace_id: string;
  client_id: string | null;
  sender_id: string | null;
  kind: ImportKind;
  params: Record<string, unknown>;
  status: JobStatus;
  total_expected: number | null;
  fetched: number;
  created_leads: number;
  updated_leads: number;
  next_offset: number;
  next_run_at: string | null;
  capped: boolean;
  error: string | null;
  list_id: string | null;
  tag_ids: string[];
  mode: 'upsert' | 'update_only';
  update_fields: string[];
  enrich: boolean;
  schedule_id: string | null;
  created_at: string;
  finished_at: string | null;
}

export type SequenceAssignment = 'round_robin' | 'least_loaded' | 'fixed' | 'fresh_sender' | 'same_sender';
export const SEQUENCE_ASSIGNMENTS: Array<{ value: SequenceAssignment; label: string; description: string }> = [
  { value: 'round_robin', label: 'Round robin', description: 'Leads are dealt to the pool in turn.' },
  { value: 'least_loaded', label: 'Least loaded', description: 'Each lead goes to the sender with the fewest live leads.' },
  { value: 'fixed', label: 'Fixed', description: 'You choose the sender when you enrol.' },
  { value: 'fresh_sender', label: 'Fresh sender', description: 'Only a sender that never invited or messaged the lead. Leads with no fresh sender left are skipped.' },
  { value: 'same_sender', label: 'Same sender as before', description: 'Whoever last spoke to the lead, so the conversation stays in one place.' },
];

/** Keys the engine reads (docs/outreach/PLAN-BUILD-CONTRACT.md, item 1). Unknown keys are kept as they are. */
export interface SequenceSettings {
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

export interface Sequence {
  id: string;
  workspace_id: string;
  client_id: string | null;
  name: string;
  status: SequenceStatus;
  head_version: number;
  graph: Graph;
  sender_pool: string[];
  assignment: SequenceAssignment;
  use_sender_schedule: boolean;
  settings: SequenceSettings;
  throttled_reason: string | null;
  brief: string | null;
  // draft / publish (item 5)
  draft_graph: Graph | null;
  draft_updated_at: string | null;
  draft_updated_by: string | null;
  draft_base_version: number | null;
  // stall state (item 3)
  stalled_at: string | null;
  stalled_reason: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SequenceVersion { sequence_id: string; version: number; graph: Graph; created_by: string | null; created_at: string; note: string | null; publish_mode: 'all' | 'new_only' | null }

export interface Enrollment {
  id: string;
  workspace_id: string;
  sequence_id: string;
  sequence_version: number;
  lead_id: string;
  sender_id: string;
  status: EnrollmentStatus;
  current_node_id: string | null;
  node_entered_at: string;
  wait_until: string | null;
  exit_reason: string | null;
  restart_count: number;
  rotation_count: number;
  priority: number;
  /** Set when a publish pinned this lead to an older version (item 6). null = follows the live graph. */
  pinned_version: number | null;
  /** Held for review after a reply (status `paused`). */
  held_at: string | null;
  hold_reason: string | null;
  wait_reason: WaitReason | null;
  /** The auto-enrol rule that created this enrollment, if any. */
  rule_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Action {
  id: string;
  workspace_id: string;
  enrollment_id: string | null;
  import_job_id: string | null;
  sender_id: string;
  lead_id: string | null;
  node_id: string | null;
  /** A/B message variant the lead was given at this step (null = the step has no variants). */
  variant_id: string | null;
  action_type: ActionType;
  scheduled_for: string;
  status: ActionStatus;
  attempt: number;
  payload: Record<string, unknown>;
  response: Record<string, unknown> | null;
  error_code: string | null;
  decision: string | null;
  reserved_at: string | null;
  executed_at: string | null;
  created_at: string;
}

/** One row per (sequence, node, variant). `variant_id` is '' when the step has no variants: sum the rows per node (sumNodeStats in graph.ts). */
export interface NodeStats { sequence_id: string; node_id: string; variant_id: string; queued: number; sent: number; failed: number; skipped: number; accepted: number; replied: number; interested: number }

export interface Chat {
  id: string;
  workspace_id: string;
  client_id: string | null;
  sender_id: string;
  lead_id: string | null;
  unipile_chat_id: string;
  provider: Provider;
  attendee_provider_id: string | null;
  attendee_public_identifier: string | null;
  attendee_name: string | null;
  attendee_picture_url: string | null;
  subject: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_direction: Direction | null;
  unread: boolean;
  unread_count: number;
  assigned_to: string | null;
  intent: Intent;
  archived: boolean;
  created_at: string;
}

export interface Message {
  id: string;
  workspace_id: string;
  chat_id: string;
  unipile_message_id: string | null;
  direction: Direction;
  text: string | null;
  html: string | null;
  attachments: Array<{ id: string; name?: string; type?: string; size?: number; unipile_message_id?: string }>;
  sent_at: string;
  is_invite_note: boolean;
  intent: Intent | null;
  intent_confidence: number | null;
  summary: string | null;
  classified_at: string | null;
  opens: number;
  clicks: number;
  edited_at: string | null;
  deleted_at: string | null;
  action_id: string | null;
  /** Inbound: the automated action this message answers (attribution, item 4). */
  replied_to_action_id: string | null;
  is_first_reply: boolean;
  /** Manual replies: the teammate who sent it. */
  sent_by: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  workspace_id: string;
  client_id: string | null;
  kind: TaskKind;
  lead_id: string | null;
  sender_id: string | null;
  enrollment_id: string | null;
  node_id: string | null;
  chat_id: string | null;
  title: string;
  body: string | null;
  ai_draft: string | null;
  draft_kind: string | null;
  due_at: string | null;
  assigned_to: string | null;
  completed_at: string | null;
  completed_by: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
}

export interface OutboundWebhook { id: string; workspace_id: string; url: string; secret: string; events: string[]; active: boolean; failures: number; created_at: string }
export interface AuditRow { id: number; workspace_id: string; actor: string | null; actor_type: string; action: string; entity: string | null; entity_id: string | null; diff: unknown; at: string }
export interface PlatformCeiling { action_type: ActionType; per_day: number; per_week: number | null }
export interface WarmupCap { level: number; action_type: ActionType; per_day: number }

// ---------------------------------------------------------------------------
// Sequence graph
// ---------------------------------------------------------------------------
export type NodeType =
  | 'start' | 'end' | 'visit_profile' | 'like_latest_post' | 'comment_latest_post' | 'endorse_skills' | 'send_invite'
  | 'wait_connection' | 'withdraw_invite' | 'send_message' | 'send_inmail' | 'send_email' | 'delay' | 'condition'
  | 'rotate_sender' | 'change_sender' | 'add_tag' | 'remove_tag' | 'change_list' | 'change_stage' | 'call_webhook'
  | 'call_api' | 'send_to_sequence' | 'manual_task' | 'ai_draft_approval'
  | 'refresh_profile' | 'follow_profile' | 'send_voice_note' | 'find_email' | 'call_task' | 'ab_split' | 'ai_route';

export interface NodeDelay { amount: number; unit: 'minutes' | 'hours' | 'days'; jitter_pct?: number }

export interface GraphNode {
  id: string;
  type: NodeType;
  label?: string;
  config?: Record<string, any>;
  delay?: NodeDelay;
  mode?: 'auto' | 'manual';
  next?: string | null;
  branches?: Record<string, string | null>;
  position: { x: number; y: number };
}

export interface Graph {
  version: 1;
  start: string;
  nodes: Record<string, GraphNode>;
}

export type ConditionOp = 'eq' | 'neq' | 'contains' | 'not_contains' | 'exists' | 'not_exists' | 'gt' | 'lt' | 'gte' | 'lte';
export interface ConditionRule { field: string; op: ConditionOp; value?: string }

// --- A/B testing (item 11) ---------------------------------------------------
/** One copy of a step's text. The text key depends on the step: invite → note, message / InMail → text, email → html (+ subject). */
export interface MessageVariant { id: string; label: string; text?: string; note?: string; html?: string; subject?: string; weight: number; promoted_at?: string }
export const MAX_VARIANTS = 5;
/** `ab_split` step: config.branches. Each id is also a key of node.branches. */
export interface AbBranch { id: string; label: string; weight: number }
/** `ai_route` step: config.routes. Each id is a key of node.branches, next to the fixed `else`. */
export interface AiRouteOption { id: string; label: string; description: string }
export const AI_ROUTE_ELSE = 'else';

export interface AbVariantResult {
  variant_id: string;
  label: string;
  weight?: number | null;
  /** ab_split only: the branch cohort. */
  leads?: number;
  sent: number;
  accepted: number;
  replies: number;
  interested: number;
  meetings?: number;
  acceptance_rate: number | null;
  reply_rate: number | null;
  interested_rate: number | null;
  is_leading: boolean;
  confidence_vs_leader: number | null;
  verdict_vs_leader: string | null;
}
/** Return shape of the RPC ab_results. */
export interface AbResults {
  sequence_id: string;
  node_id: string;
  node_type: NodeType;
  judged_on: 'accepted' | 'interested';
  period: { from: string; to: string };
  enough_data: boolean;
  min_sends_per_variant: number;
  variants: AbVariantResult[];
  leader: string | null;
  can_promote: boolean;
}

// --- Enrichment + AI variables (items 13, 14) ---------------------------------
export interface LeadProfileRole { company?: string; company_id?: string; title?: string; start?: string; end?: string; current?: boolean; location?: string; description?: string }
export interface LeadProfileSchool { school?: string; degree?: string; field?: string; start?: string; end?: string }
export interface LeadProfilePost { id: string; text?: string; date?: string; reactions?: number; comments?: number; url?: string }
export interface LeadProfile {
  lead_id: string;
  workspace_id: string;
  about: string | null;
  current_title: string | null;
  current_company: string | null;
  current_started_on: string | null;
  experience: LeadProfileRole[] | null;
  education: LeadProfileSchool[] | null;
  skills: string[] | null;
  languages: string[] | null;
  profile_language: string | null;
  follower_count: number | null;
  connections_count: number | null;
  posts: LeadProfilePost[] | null;
  posts_fetched_at: string | null;
  last_posted_at: string | null;
  enriched_at: string | null;
  enriched_by_sender: string | null;
  source: string | null;
  /** Sections that came back empty last time: unknown, not "this person has none". */
  empty_sections: string[];
  updated_at: string;
}

/** A saved prompt + fallback, used in templates as {{ai.<key>|fallback}}. Only approved values are ever rendered. */
export interface AiVariable {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  prompt: string;
  fallback: string;
  needs_posts: boolean;
  max_chars: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
export type AiValueStatus = 'pending' | 'generated' | 'approved' | 'skipped' | 'blank' | 'failed';
export interface AiValue {
  id: string;
  workspace_id: string;
  lead_id: string;
  variable_id: string;
  batch_id: string | null;
  text: string | null;
  /** The profile facts the line relied on (shown in the review table). */
  facts: unknown[];
  status: AiValueStatus;
  edited: boolean;
  model: string | null;
  error: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}
/** Return shape of the RPC ai_generate_request. */
export interface AiGenerateResult { batch_id: string; to_generate: number; kept_existing: number; note?: string }

export interface VoiceClip {
  sequence_id: string;
  node_id: string;
  sender_id: string;
  workspace_id: string;
  /** Path inside the `outreach-attachments` bucket: <ws>/voice/<sequence>/<node>/<sender>.<ext> */
  path: string;
  mime: string;
  duration_s: number | null;
  size_bytes: number | null;
  created_by: string | null;
  created_at: string;
}

/** JSON returned by the RPC render_context; pass it to buildContext() from lib/outreach/render.ts. */
export interface RenderContextJson {
  lead: Record<string, unknown>;
  sender: Record<string, unknown>;
  enrich: Record<string, unknown>;
  ai: Record<string, string>;
  seed: string;
}

// --- Enrol guard (items 1, 17, 19) --------------------------------------------
/** Return shape of the RPC enroll_preview. */
export interface EnrollPreview {
  sequence_id: string;
  sequence_status: SequenceStatus;
  include_replied: boolean;
  requested: number;
  eligible: number;
  eligible_ids: string[];
  /** Keyed by reason: not_in_workspace, suppressed:<why>, replied_recently, already_enrolled, no_fresh_sender. */
  excluded: Record<string, { count: number; sample_ids: string[] }>;
  /** At most 50 rows. */
  replied_recently: Array<{ id: string; name: string | null; company: string | null; last_replied_at: string; channel: ReplyChannel | null }>;
  assignment: Array<{ sender_id: string; name: string | null; status: SenderStatus; leads: number }>;
  assignment_rule: SequenceAssignment;
  /** Keyed by note: moved_to_fresh_sender, kept_with_previous_sender, contacted_before_by_this_sender. */
  rule_effects: Record<string, number>;
  projection?: { estimated_days: number; bottleneck: string | null };
  warnings: string[];
}
/** The one row returned by the RPC enroll_leads. */
export interface EnrollResult { enrolled: number; skipped_active: number; skipped_suppressed: number; skipped_other: number; skipped_replied: number; waiting: number }

export interface DashboardData {
  senders: Array<{ id: string; display_name: string | null; provider: Provider; status: SenderStatus; status_reason: string | null; health_score: number; warmup_level: number; client_id: string | null; paused_until: string | null; today: Record<string, { used: number; reserved: number; cap: number }> }>;
  attention: Array<{ kind: string; id: string; label: string; reason: string }>;
  replies_awaiting: number;
  unread: number;
  tasks_open: number;
  drafts_awaiting: number;
  enrollments_live: number;
  sent_today: number;
  queued_today: number;
  leads_total: number;
  stats_7d: { invites: number; messages: number; accepted: number; replies: number };
  /** Totals objects with the same keys as the reports (outreach__totals_from in 013). */
  today?: Record<string, unknown>;
  last_7_days?: Record<string, unknown>;
  ai_lines_awaiting?: number;
}

export const EVENT_NAMES = [
  'sender.connected', 'sender.disconnected', 'sender.reconnected', 'sender.paused', 'sender.level_changed',
  'lead.created', 'lead.updated', 'invite.sent', 'invite.accepted', 'invite.withdrawn',
  'message.sent', 'message.received', 'message.classified', 'email.sent', 'email.opened', 'email.clicked', 'email.bounced',
  'enrollment.started', 'enrollment.exited', 'enrollment.completed', 'task.created', 'task.completed',
  'sequence.activated', 'sequence.paused', 'sequence.throttled', 'sequence.webhook',
  // product plan (009–016)
  'sequence.published', 'sequence.stalled', 'sequence.recovered', 'sender.running_dry',
  'enrollment.held', 'enrollment.resumed', 'enrollment.recovered', 'lead.unsubscribed', 'meeting.booked',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];
