// Shared types for the Outreach platform (mirrors migrations/outreach/*.sql)

export type Role = 'owner' | 'manager' | 'member' | 'client_viewer';
export type Provider = 'LINKEDIN' | 'GMAIL' | 'OUTLOOK' | 'IMAP';
export type AuthMethod = 'credentials' | 'cookie' | 'oauth';
export type SenderStatus = 'connecting' | 'ok' | 'credentials' | 'error' | 'paused' | 'disabled';
export type Relation = 'none' | 'pending_out' | 'pending_in' | 'first' | 'blocked' | 'invalid';
export type ActionType =
  | 'profile_view' | 'invite' | 'withdraw' | 'message' | 'inmail' | 'like' | 'comment'
  | 'endorse' | 'search_page' | 'email' | 'reply' | 'relations_poll' | 'call_api';
export type ActionStatus = 'queued' | 'reserved' | 'sent' | 'skipped' | 'failed' | 'cancelled';
export type EnrollmentStatus =
  | 'active' | 'waiting_connection' | 'waiting_delay' | 'waiting_task' | 'paused' | 'completed'
  | 'exited_replied' | 'exited_manual' | 'exited_suppressed' | 'exited_sender_disabled' | 'failed' | 'cancelled';
export type SequenceStatus = 'draft' | 'active' | 'paused' | 'archived';
export type Direction = 'in' | 'out';
export type Intent = 'interested' | 'question' | 'not_now' | 'not_interested' | 'ooo' | 'wrong_person' | 'unclear' | 'unclassified';
export type ImportKind = 'search_url' | 'csv' | 'relations';
export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export type TaskKind = 'manual_node' | 'follow_up' | 'review_ai_draft' | 'reconnect';

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
export interface Stage { id: string; workspace_id: string; name: string; position: number; color: string | null }
export interface Tag { id: string; workspace_id: string; name: string; color: string | null }
export interface Suppression { id: string; workspace_id: string; kind: 'domain' | 'public_identifier' | 'email'; value: string; reason: string | null; created_at: string }

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
  created_at: string;
  finished_at: string | null;
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
  assignment: 'round_robin' | 'least_loaded' | 'fixed';
  use_sender_schedule: boolean;
  settings: { stop_on_reply?: boolean; withdraw_after_days?: number; [k: string]: unknown };
  throttled_reason: string | null;
  brief: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SequenceVersion { sequence_id: string; version: number; graph: Graph; created_by: string | null; created_at: string }

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

export interface NodeStats { sequence_id: string; node_id: string; queued: number; sent: number; failed: number; skipped: number; accepted: number; replied: number }

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
  | 'call_api' | 'send_to_sequence' | 'manual_task' | 'ai_draft_approval';

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

export interface ConditionRule { field: string; op: 'eq' | 'neq' | 'contains' | 'not_contains' | 'exists' | 'not_exists' | 'gt' | 'lt'; value?: string }

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
}

export const EVENT_NAMES = [
  'sender.connected', 'sender.disconnected', 'sender.reconnected', 'sender.paused', 'sender.level_changed',
  'lead.created', 'lead.updated', 'invite.sent', 'invite.accepted', 'invite.withdrawn',
  'message.sent', 'message.received', 'message.classified', 'email.sent', 'email.opened', 'email.clicked', 'email.bounced',
  'enrollment.started', 'enrollment.exited', 'enrollment.completed', 'task.created', 'task.completed',
  'sequence.activated', 'sequence.paused', 'sequence.throttled', 'sequence.webhook',
] as const;
