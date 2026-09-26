// Node catalogue for the sequence builder: metadata, defaults, exits, limits.
// Mirrors outreach_node_types / outreach_node_action_type / outreach_is_executable_node in migrations/outreach/011_engine_v2.sql.
import type { AbBranch, ActionType, AiRouteOption, ConditionOp, ConsentBasis, GraphNode, NodeType, Provider } from './types';
import { AI_ROUTE_ELSE, CALL_OUTCOMES, CHANNEL_PROVIDERS } from './types';

export type NodeGroup = 'Outreach' | 'Social' | 'Instagram' | 'WhatsApp' | 'Logic' | 'CRM' | 'Integrations' | 'AI' | 'Flow';

export interface NodeMeta {
  type: NodeType;
  label: string;
  group: NodeGroup;
  description: string;
  /**
   * The channels the step can run on. undefined = any channel (logic, CRM, integrations…). A step with channels needs
   * an account of one of them in the sender pool; a message picks its channel from `config.channel` or the pool.
   */
  channels?: Provider[];
  /**
   * Exits of a freshly added step: [] = terminal, ['next'] = single exit (stored in node.next), else branch names
   * (stored in node.branches). Steps whose exits depend on their config (`ab_split`, `ai_route`) also set
   * `dynamicExits`; always read exits of an existing node with nodeExits(node).
   */
  exits: string[];
  dynamicExits?: (node: GraphNode) => string[];
  actionType: ActionType | null;
  defaultConfig: Record<string, any>;
  color: string;              // tailwind bg class
}

function abBranchIds(node: GraphNode): string[] {
  const list: AbBranch[] = Array.isArray(node.config?.branches) ? node.config!.branches : [];
  return list.map((b) => b?.id).filter((id): id is string => typeof id === 'string' && id !== '');
}

function aiRouteIds(node: GraphNode): string[] {
  const list: AiRouteOption[] = Array.isArray(node.config?.routes) ? node.config!.routes : [];
  const ids = list.map((r) => r?.id).filter((id): id is string => typeof id === 'string' && id !== '' && id !== AI_ROUTE_ELSE);
  return [...ids, AI_ROUTE_ELSE];
}

export const NODE_CATALOG: Record<NodeType, NodeMeta> = {
  start: { type: 'start', label: 'Start', group: 'Flow', description: 'Entry point', exits: ['next'], actionType: null, defaultConfig: {}, color: 'bg-gray-800' },
  end: { type: 'end', label: 'End', group: 'Flow', description: 'Completes the enrollment', exits: [], actionType: null, defaultConfig: { reason: '' }, color: 'bg-gray-500' },
  visit_profile: { type: 'visit_profile', label: 'Visit profile', group: 'Outreach', channels: ['LINKEDIN'], description: 'View the lead profile (optionally notify)', exits: ['next'], actionType: 'profile_view', defaultConfig: { notify: true }, color: 'bg-sky-600' },
  refresh_profile: { type: 'refresh_profile', label: 'Refresh profile', group: 'Outreach', channels: ['LINKEDIN'], description: 'Re-read the full profile when the stored data is old', exits: ['next'], actionType: 'profile_view', defaultConfig: { only_if_stale_days: 90 }, color: 'bg-sky-500' },
  like_latest_post: { type: 'like_latest_post', label: 'Like latest post', group: 'Social', channels: ['LINKEDIN'], description: 'React to the most recent post', exits: ['next'], actionType: 'like', defaultConfig: { max_age_days: 90, reaction: 'like' }, color: 'bg-pink-600' },
  comment_latest_post: { type: 'comment_latest_post', label: 'Comment on post', group: 'Social', channels: ['LINKEDIN'], description: 'Comment on the most recent post', exits: ['next'], actionType: 'comment', defaultConfig: { text: '', max_age_days: 90 }, color: 'bg-pink-600' },
  endorse_skills: { type: 'endorse_skills', label: 'Endorse skills', group: 'Social', channels: ['LINKEDIN'], description: 'Endorse 1–5 skills', exits: ['next'], actionType: 'endorse', defaultConfig: { count: 1 }, color: 'bg-pink-600' },
  follow_profile: { type: 'follow_profile', label: 'Follow profile', group: 'Social', channels: ['LINKEDIN'], description: 'Follow the lead on LinkedIn', exits: ['next'], actionType: 'follow', defaultConfig: {}, color: 'bg-pink-500' },
  send_invite: { type: 'send_invite', label: 'Send invitation', group: 'Outreach', channels: ['LINKEDIN'], description: 'Connection request with optional note', exits: ['next'], actionType: 'invite', defaultConfig: { note: '', require_note_for_free: false }, color: 'bg-indigo-600' },
  wait_connection: { type: 'wait_connection', label: 'Wait for connection', group: 'Outreach', channels: ['LINKEDIN'], description: 'Wait until the invite is accepted', exits: ['connected', 'no_connect'], actionType: null, defaultConfig: { window_days: 14, subtasks: [] }, color: 'bg-indigo-500' },
  withdraw_invite: { type: 'withdraw_invite', label: 'Withdraw invitation', group: 'Outreach', channels: ['LINKEDIN'], description: 'Cancel a pending invitation', exits: ['next'], actionType: 'withdraw', defaultConfig: {}, color: 'bg-indigo-400' },
  // `no_chat` is an optional second exit that appears when `new_chat_allowed` is off (see nodeExits): the builder keeps
  // the onward step in `next` (mirrored into branches.next while the second exit exists) so the engine reads both.
  send_message: { type: 'send_message', label: 'Send message', group: 'Outreach', channels: ['LINKEDIN', 'INSTAGRAM', 'WHATSAPP'], description: 'A direct message on LinkedIn, Instagram or WhatsApp', exits: ['next'], actionType: 'message', defaultConfig: { text: '', send_always: false, new_chat_allowed: true }, color: 'bg-blue-600' },
  send_voice_note: { type: 'send_voice_note', label: 'Send voice note', group: 'Outreach', channels: ['LINKEDIN', 'WHATSAPP'], description: 'A recorded voice message, one clip per sender', exits: ['next'], actionType: 'message', defaultConfig: { send_always: false, new_chat_allowed: true }, color: 'bg-blue-500' },
  send_inmail: { type: 'send_inmail', label: 'Send InMail', group: 'Outreach', channels: ['LINKEDIN'], description: 'InMail via Classic / Sales Navigator / Recruiter', exits: ['next', 'no_credit'], actionType: 'inmail', defaultConfig: { subject: '', text: '', api: 'classic', open_profile_only: false }, color: 'bg-blue-700' },
  send_email: { type: 'send_email', label: 'Send email', group: 'Outreach', channels: ['GMAIL', 'OUTLOOK', 'IMAP'], description: 'Email from a connected mailbox', exits: ['next', 'bounced', 'no_email'], actionType: 'email', defaultConfig: { subject: '', html: '', to: 'any', thread: 'continue', mailbox_sender_id: null, track: true }, color: 'bg-emerald-600' },
  find_email: { type: 'find_email', label: 'Find email', group: 'Outreach', description: 'Look up a work email with your own provider keys', exits: ['found', 'not_found'], actionType: 'find_email', defaultConfig: {}, color: 'bg-emerald-500' },
  // Instagram (docs/outreach/CHANNELS-BUILD-CONTRACT.md §3): every action is metered, 10 per hour per account
  follow: { type: 'follow', label: 'Follow', group: 'Instagram', channels: ['INSTAGRAM'], description: 'Follow the lead on Instagram', exits: ['next'], actionType: 'follow', defaultConfig: {}, color: 'bg-rose-600' },
  unfollow: { type: 'unfollow', label: 'Unfollow', group: 'Instagram', channels: ['INSTAGRAM'], description: 'Stop following the lead on Instagram', exits: ['next'], actionType: 'unfollow', defaultConfig: {}, color: 'bg-rose-500' },
  like_recent_posts: { type: 'like_recent_posts', label: 'Like recent posts', group: 'Instagram', channels: ['INSTAGRAM'], description: 'Like one to three of the lead’s recent posts', exits: ['next'], actionType: 'like', defaultConfig: { count: 2, max_age_days: 60 }, color: 'bg-rose-600' },
  comment_post: { type: 'comment_post', label: 'Comment on a post', group: 'Instagram', channels: ['INSTAGRAM'], description: 'Comment on the lead’s most recent post', exits: ['next'], actionType: 'comment', defaultConfig: { text: '', max_age_days: 60 }, color: 'bg-rose-600' },
  wait_follow_back: { type: 'wait_follow_back', label: 'Wait for follow-back', group: 'Instagram', channels: ['INSTAGRAM'], description: 'Wait to see whether the lead follows back', exits: ['followed_back', 'no_follow_back'], actionType: null, defaultConfig: { window_days: 5, poll_budget: 2 }, color: 'bg-rose-700' },
  // WhatsApp: messages only go to people who agreed to hear from you
  check_identifier: { type: 'check_identifier', label: 'Check the number', group: 'WhatsApp', channels: ['WHATSAPP'], description: 'Is the lead’s number on WhatsApp? Branches on the answer', exits: ['valid', 'invalid'], actionType: 'identifier_check', defaultConfig: {}, color: 'bg-green-600' },
  require_consent: { type: 'require_consent', label: 'Check consent', group: 'WhatsApp', channels: ['WHATSAPP'], description: 'Only continue with leads who agreed to hear from you on WhatsApp', exits: ['has_consent', 'no_consent'], actionType: null, defaultConfig: { bases: [] }, color: 'bg-green-700' },
  delay: { type: 'delay', label: 'Delay', group: 'Logic', description: 'Wait for a period with jitter', exits: ['next'], actionType: null, defaultConfig: { amount: 1, unit: 'days', jitter_pct: 20 }, color: 'bg-amber-500' },
  wait_for_reply: { type: 'wait_for_reply', label: 'Wait for a reply', group: 'Logic', description: 'Wait for the lead to answer. Branches on whether they did', exits: ['replied', 'no_reply'], actionType: null, defaultConfig: { window_hours: 96 }, color: 'bg-amber-500' },
  channel_switch: { type: 'channel_switch', label: 'Switch channel', group: 'Logic', description: 'Carry on with the lead on another channel', exits: ['next', 'unavailable'], actionType: null, defaultConfig: { to_channel: 'WHATSAPP', require_identity: true }, color: 'bg-amber-700' },
  condition: { type: 'condition', label: 'Condition', group: 'Logic', description: 'Branch on lead or relation attributes', exits: ['true', 'false'], actionType: null, defaultConfig: { rules: [], match: 'all' }, color: 'bg-amber-600' },
  ab_split: {
    type: 'ab_split', label: 'A/B split', group: 'Logic', description: 'Send leads down weighted paths to test whole flows', exits: ['a', 'b'], dynamicExits: abBranchIds, actionType: null,
    defaultConfig: { branches: [{ id: 'a', label: 'A', weight: 50 }, { id: 'b', label: 'B', weight: 50 }] }, color: 'bg-amber-600',
  },
  rotate_sender: { type: 'rotate_sender', label: 'Rotate sender', group: 'Logic', description: 'Restart from a node with the next sender in the pool', exits: ['next'], actionType: null, defaultConfig: { restart_from: '', max_rotations: 2 }, color: 'bg-amber-700' },
  change_sender: { type: 'change_sender', label: 'Change sender', group: 'Logic', description: 'Continue with another sender', exits: ['next'], actionType: null, defaultConfig: { sender_id: 'next_in_pool' }, color: 'bg-amber-700' },
  add_tag: { type: 'add_tag', label: 'Add tag', group: 'CRM', description: 'Tag the lead', exits: ['next'], actionType: null, defaultConfig: { tag_id: '' }, color: 'bg-teal-600' },
  remove_tag: { type: 'remove_tag', label: 'Remove tag', group: 'CRM', description: 'Untag the lead', exits: ['next'], actionType: null, defaultConfig: { tag_id: '' }, color: 'bg-teal-600' },
  change_list: { type: 'change_list', label: 'Change list', group: 'CRM', description: 'Move the lead to a list', exits: ['next'], actionType: null, defaultConfig: { list_id: '' }, color: 'bg-teal-600' },
  change_stage: { type: 'change_stage', label: 'Change stage', group: 'CRM', description: 'Set the pipeline stage', exits: ['next'], actionType: null, defaultConfig: { stage_id: '' }, color: 'bg-teal-600' },
  call_webhook: { type: 'call_webhook', label: 'Call webhook', group: 'Integrations', description: 'POST the lead to an outbound webhook', exits: ['next'], actionType: null, defaultConfig: { webhook_id: '' }, color: 'bg-purple-600' },
  call_api: { type: 'call_api', label: 'Call API', group: 'Integrations', description: 'HTTP request with lead variables', exits: ['next', 'error'], actionType: 'call_api', defaultConfig: { method: 'POST', url: '', headers: {}, query: {}, body: '', remove_empty: true }, color: 'bg-purple-600' },
  send_to_sequence: { type: 'send_to_sequence', label: 'Send to sequence', group: 'Integrations', description: 'Enrol into another sequence and finish', exits: [], actionType: null, defaultConfig: { sequence_id: '' }, color: 'bg-purple-700' },
  manual_task: { type: 'manual_task', label: 'Manual task', group: 'Flow', description: 'Create a task; continue when done', exits: ['next'], actionType: null, defaultConfig: { title: '', body: '' }, color: 'bg-slate-600' },
  call_task: {
    type: 'call_task', label: 'Call task', group: 'Flow', description: 'A phone call with a script; branch on the outcome',
    // the four outcomes are branches; `next` is the fallback for an outcome with no step connected
    exits: [...CALL_OUTCOMES, 'next'], actionType: null, defaultConfig: { title: '', script: '' }, color: 'bg-slate-700',
  },
  ai_draft_approval: { type: 'ai_draft_approval', label: 'AI draft + approval', group: 'AI', description: 'Draft with AI, send after human approval', exits: ['next'], actionType: null, defaultConfig: { kind: 'message', brief: '' }, color: 'bg-fuchsia-600' },
  ai_route: {
    type: 'ai_route', label: 'AI routing', group: 'AI', description: 'Describe each path in plain words; AI picks one per lead', exits: ['route_1', AI_ROUTE_ELSE], dynamicExits: aiRouteIds, actionType: null,
    defaultConfig: { routes: [{ id: 'route_1', label: 'Route 1', description: '' }] }, color: 'bg-fuchsia-700',
  },
};

export const NODE_GROUPS: NodeGroup[] = ['Outreach', 'Social', 'Instagram', 'WhatsApp', 'Logic', 'CRM', 'Integrations', 'AI', 'Flow'];

/** Steps that become a budgeted / queued action (outreach_is_executable_node). */
export const EXECUTABLE_TYPES: NodeType[] = [
  'visit_profile', 'refresh_profile', 'like_latest_post', 'comment_latest_post', 'endorse_skills', 'follow_profile', 'send_invite',
  'withdraw_invite', 'send_message', 'send_voice_note', 'send_inmail', 'send_email', 'call_api', 'find_email',
  'follow', 'unfollow', 'like_recent_posts', 'comment_post', 'check_identifier',
];

/** Steps that send into a conversation (and may open a new one: `new_chat_allowed`, optional `no_chat` exit). */
export const MESSAGE_TYPES: NodeType[] = ['send_message', 'send_voice_note'];

/** Steps that pause the lead for a while: they break a run of Instagram actions for the hourly limit. */
export const WAIT_TYPES: NodeType[] = ['delay', 'wait_connection', 'wait_follow_back', 'wait_for_reply', 'manual_task', 'call_task', 'ai_draft_approval'];

/** Plain names of the ways a lead can have agreed to hear from you on WhatsApp (outreach_consent_basis_t). */
export const CONSENT_BASIS_LABELS: Record<ConsentBasis, string> = {
  inbound: 'They messaged us first',
  form_optin: 'Opted in on a form',
  existing_customer: 'Existing customer',
  linkedin_reply: 'Replied on LinkedIn and shared contact',
  explicit_share: 'Shared their number in a conversation',
  imported_attested: 'Attested at import (weakest)',
};

/**
 * The channels a step applies to.
 *  - a channel step (follow, send_invite…) → its channels, narrowed to the ones in the pool when they overlap;
 *  - a message → `config.channel` when set, else the pool channels it supports;
 *  - a channel-agnostic step (delay, tag…) → the pool's channels.
 * Without a pool, or with a pool that has no channel account yet (mailboxes only), LinkedIn is assumed as before.
 */
export function nodeChannels(node: GraphNode, poolProviders?: Provider[] | null): Provider[] {
  const meta = NODE_CATALOG[node.type];
  const supported = meta?.channels ?? CHANNEL_PROVIDERS;
  const cfg = node.config?.channel;
  if (typeof cfg === 'string' && (supported as string[]).includes(cfg)) return [cfg as Provider];
  const pool = CHANNEL_PROVIDERS.filter((p) => poolProviders?.includes(p));
  const hit = supported.filter((c) => pool.includes(c));
  if (hit.length) return hit;
  if (!poolProviders?.length || !pool.length) return supported.includes('LINKEDIN') ? ['LINKEDIN'] : supported;
  return supported;
}

/** The longest text a direct message may carry on the given channels (the strictest one counts). */
export function messageTextLimit(channels: Provider[]): number {
  let lim: number = TEXT_LIMITS.message;
  if (channels.includes('WHATSAPP')) lim = Math.min(lim, TEXT_LIMITS.wa_message);
  if (channels.includes('INSTAGRAM')) lim = Math.min(lim, TEXT_LIMITS.ig_message);
  return lim;
}

/** Steps that can carry A/B message variants, with the config key that holds their text. */
export const VARIANT_TEXT_KEY: Partial<Record<NodeType, 'note' | 'text' | 'html'>> = {
  send_invite: 'note', send_message: 'text', send_inmail: 'text', send_email: 'html',
};

export const TEXT_LIMITS = {
  invite_note: 300,
  invite_note_free: 200,
  message: 8000,
  comment: 1250,
  inmail_subject: 200,
  inmail_body: 1900,
  voice_note_seconds: 60,
  ig_message: 1000,
  wa_message: 4096,
  ig_comment: 2200,
} as const;

// ---------------------------------------------------------------------------
// Exits
// ---------------------------------------------------------------------------
/** The exits of an existing node. Use this (not NODE_CATALOG[type].exits) wherever a node is at hand: A/B split and AI routing derive their exits from config. */
export function nodeExits(node: GraphNode): string[] {
  const meta = NODE_CATALOG[node.type];
  if (!meta) return [];
  if (meta.dynamicExits) return meta.dynamicExits(node);
  // A message that may not open a new conversation exposes where leads with no conversation go. This is kept out of
  // `dynamicExits` on purpose: steps with `dynamicExits` always wire through `branches`, while a plain message keeps
  // its onward step in `next` like before (the engine reads `next` when a message completes).
  if (MESSAGE_TYPES.includes(node.type) && node.config?.new_chat_allowed === false) return ['next', 'no_chat'];
  return meta.exits;
}

const EXIT_LABELS: Record<string, string> = {
  next: 'next', true: 'true', false: 'false', connected: 'connected', no_connect: 'no connect', no_credit: 'no credit', bounced: 'bounced', no_email: 'no email',
  error: 'error', found: 'found', not_found: 'not found', voicemail: 'voicemail', no_answer: 'no answer', wrong_number: 'wrong number', else: 'everything else',
  followed_back: 'followed back', no_follow_back: 'no follow back', has_consent: 'has consent', no_consent: 'no consent', valid: 'valid', invalid: 'invalid',
  replied: 'replied', no_reply: 'no reply', no_chat: 'no chat', unavailable: 'unavailable',
};

/** Plain-language name of an exit (the A/B branch or AI route label when there is one). */
export function exitLabel(node: GraphNode, exit: string): string {
  if (node.type === 'ab_split') {
    const list: AbBranch[] = Array.isArray(node.config?.branches) ? node.config!.branches : [];
    const total = list.reduce((s, b) => s + Math.max(0, Number(b.weight) || 0), 0);
    const b = list.find((x) => x.id === exit);
    if (b) return `${b.label || b.id}${total > 0 ? ` · ${Math.round((Math.max(0, Number(b.weight) || 0) / total) * 100)}%` : ''}`;
  }
  if (node.type === 'ai_route' && exit !== AI_ROUTE_ELSE) {
    const list: AiRouteOption[] = Array.isArray(node.config?.routes) ? node.config!.routes : [];
    const r = list.find((x) => x.id === exit);
    if (r) return r.label || r.id;
  }
  if (node.type === 'call_task' && exit === 'next') return 'any other outcome';
  return EXIT_LABELS[exit] ?? exit.replace(/_/g, ' ');
}

/**
 * Keep node.branches in step with the exits the config defines: new exits get a null target, removed exits are dropped.
 * Forms for `ab_split` and `ai_route` call this after every change to their branch list.
 */
export function syncNodeBranches(node: GraphNode): GraphNode {
  const meta = NODE_CATALOG[node.type];
  if (MESSAGE_TYPES.includes(node.type)) {
    // one exit: the onward step lives in `next`; two exits (`no_chat` shown): `next` is mirrored into branches.next so the
    // canvas (which wires multi-exit steps through branches) and the engine (which reads `next`) agree
    const onward = node.next ?? node.branches?.next ?? null;
    if (nodeExits(node).length === 1) { const { branches: _b, ...rest } = node; return { ...rest, next: onward }; }
    return { ...node, next: onward, branches: { next: onward, no_chat: node.branches?.no_chat ?? null } };
  }
  if (!meta?.dynamicExits) return node;
  const exits = meta.dynamicExits(node);
  const branches: Record<string, string | null> = {};
  for (const e of exits) branches[e] = node.branches?.[e] ?? null;
  return { ...node, branches };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------
export type ConditionValueKind = 'boolean' | 'number' | 'text' | 'select' | 'tag' | 'stage';
export interface ConditionFieldMeta {
  value: string;
  label: string;
  group: 'Conversation' | 'Lead' | 'Profile data' | 'Sender';
  /** Kept for older callers: true when kind === 'boolean'. */
  boolean?: boolean;
  kind: ConditionValueKind;
  options?: Array<{ value: string; label: string }>;
  /** Shown next to a number input. */
  unit?: string;
  /** Operator picked when the field is chosen. */
  defaultOp?: ConditionOp;
  /** Operators that make sense for this field (default: by kind). */
  ops?: ConditionOp[];
  hint?: string;
}

const BOOL = { kind: 'boolean' as const, boolean: true, defaultOp: 'eq' as const, ops: ['eq'] as ConditionOp[] };
const TEXT_OPS: ConditionOp[] = ['contains', 'not_contains', 'eq', 'neq', 'exists', 'not_exists'];
const NUMBER_OPS: ConditionOp[] = ['gte', 'lte', 'gt', 'lt', 'eq', 'neq', 'exists', 'not_exists'];

export const CONDITION_FIELDS: ConditionFieldMeta[] = [
  { value: 'replied', label: 'Replied', group: 'Conversation', ...BOOL },
  { value: 'accepted', label: 'Accepted invitation', group: 'Conversation', ...BOOL },
  {
    value: 'relation', label: 'Connection status', group: 'Conversation', kind: 'select', defaultOp: 'eq', ops: ['eq', 'neq'],
    options: [{ value: 'none', label: 'Not connected' }, { value: 'pending_out', label: 'Invitation sent' }, { value: 'pending_in', label: 'They invited us' }, { value: 'first', label: 'Connected' }, { value: 'blocked', label: 'Blocked' }, { value: 'invalid', label: 'Profile not found' }],
  },
  { value: 'email_bounced', label: 'Email bounced', group: 'Conversation', ...BOOL },
  {
    value: 'call_outcome', label: 'Last call outcome', group: 'Conversation', kind: 'select', defaultOp: 'eq', ops: ['eq', 'neq', 'exists', 'not_exists'],
    options: [{ value: 'connected', label: 'Connected' }, { value: 'voicemail', label: 'Voicemail' }, { value: 'no_answer', label: 'No answer' }, { value: 'wrong_number', label: 'Wrong number' }],
    hint: 'The outcome of the most recent completed call task for this lead.',
  },
  { value: 'has_email_work', label: 'Has work email', group: 'Lead', ...BOOL },
  { value: 'has_email_personal', label: 'Has personal email', group: 'Lead', ...BOOL },
  { value: 'has_phone', label: 'Has phone number', group: 'Lead', ...BOOL },
  { value: 'is_open_profile', label: 'Is open profile', group: 'Lead', ...BOOL },
  { value: 'has_tag', label: 'Has tag', group: 'Lead', kind: 'tag', defaultOp: 'eq', ops: ['eq', 'neq'] },
  { value: 'stage_is', label: 'Stage is', group: 'Lead', kind: 'stage', defaultOp: 'eq', ops: ['eq', 'neq'] },
  { value: 'company', label: 'Company', group: 'Lead', kind: 'text', defaultOp: 'contains' },
  { value: 'title', label: 'Title', group: 'Lead', kind: 'text', defaultOp: 'contains' },
  { value: 'headline', label: 'Headline', group: 'Lead', kind: 'text', defaultOp: 'contains' },
  { value: 'location', label: 'Location', group: 'Lead', kind: 'text', defaultOp: 'contains' },
  { value: 'custom.', label: 'Custom field', group: 'Lead', kind: 'text', defaultOp: 'eq', ops: [...TEXT_OPS, 'gt', 'lt', 'gte', 'lte'] },
  { value: 'enrich.is_enriched', label: 'Profile data is stored', group: 'Profile data', ...BOOL },
  { value: 'enrich.months_in_role', label: 'Months in current role', group: 'Profile data', kind: 'number', unit: 'months', defaultOp: 'gte' },
  { value: 'enrich.posted_within_days', label: 'Posted in the last', group: 'Profile data', kind: 'number', unit: 'days', defaultOp: 'lte', ops: ['lte', 'gt', 'exists', 'not_exists'], hint: 'True when the most recent post is at most this many days old.' },
  { value: 'enrich.follower_count', label: 'Followers', group: 'Profile data', kind: 'number', defaultOp: 'gte' },
  { value: 'enrich.connections_count', label: 'Connections', group: 'Profile data', kind: 'number', defaultOp: 'gte' },
  { value: 'enrich.past_company', label: 'Past company', group: 'Profile data', kind: 'text', defaultOp: 'contains' },
  { value: 'enrich.skill', label: 'Skill', group: 'Profile data', kind: 'text', defaultOp: 'contains' },
  { value: 'enrich.language', label: 'Profile language', group: 'Profile data', kind: 'text', defaultOp: 'contains' },
  { value: 'enrich.about', label: 'About section', group: 'Profile data', kind: 'text', defaultOp: 'contains' },
  { value: 'enrich.education', label: 'School', group: 'Profile data', kind: 'text', defaultOp: 'contains' },
  { value: 'sender_is_premium', label: 'Sender is premium', group: 'Sender', ...BOOL },
];

export const CONDITION_FIELD_GROUPS: ConditionFieldMeta['group'][] = ['Conversation', 'Lead', 'Profile data', 'Sender'];

export const CONDITION_OPS = ['eq', 'neq', 'contains', 'not_contains', 'exists', 'not_exists', 'gt', 'lt', 'gte', 'lte'] as const;

export function conditionFieldMeta(field: string): ConditionFieldMeta | undefined {
  if (field.startsWith('custom.')) return CONDITION_FIELDS.find((f) => f.value === 'custom.');
  return CONDITION_FIELDS.find((f) => f.value === field);
}

/** Operators offered for a field, most useful first. */
export function conditionOpsFor(field: string): ConditionOp[] {
  const meta = conditionFieldMeta(field);
  if (meta?.ops) return meta.ops;
  if (meta?.kind === 'number') return NUMBER_OPS;
  return TEXT_OPS;
}

export function newNode(type: NodeType, position: { x: number; y: number }): GraphNode {
  const meta = NODE_CATALOG[type];
  const id = `${type}_${Math.random().toString(36).slice(2, 8)}`;
  const node: GraphNode = { id, type, label: meta.label, config: JSON.parse(JSON.stringify(meta.defaultConfig)), position };
  if (type === 'call_task') {
    // An outcome key that exists with no target ends the sequence for that lead, so outcomes start absent and fall back to `next`.
    node.next = null;
    node.branches = {};
  } else if (meta.exits.length === 1) node.next = null;
  else if (meta.exits.length > 1) node.branches = Object.fromEntries(meta.exits.map((e) => [e, null]));
  return node;
}

// ---------------------------------------------------------------------------
// Template variables (docs/outreach/PLAN-BUILD-CONTRACT.md, items 14–16)
// ---------------------------------------------------------------------------
export interface TemplateVariableMeta { name: string; label: string; fallback?: string; emailOnly?: boolean }
export interface TemplateVariableGroup { id: 'lead' | 'custom' | 'sender' | 'enrich' | 'ai' | 'links'; label: string; note?: string; variables: TemplateVariableMeta[] }

export const TEMPLATE_VARIABLE_GROUPS: TemplateVariableGroup[] = [
  {
    id: 'lead', label: 'Lead',
    variables: [
      { name: 'first_name', label: 'First name', fallback: 'there' },
      { name: 'last_name', label: 'Last name' },
      { name: 'full_name', label: 'Full name', fallback: 'there' },
      { name: 'company', label: 'Company', fallback: 'your company' },
      { name: 'title', label: 'Title', fallback: 'your role' },
      { name: 'headline', label: 'Headline' },
      { name: 'location', label: 'Location' },
    ],
  },
  { id: 'custom', label: 'Custom fields', variables: [] },   // filled from the workspace's custom keys
  {
    id: 'sender', label: 'Sender',
    variables: [
      { name: 'sender.first_name', label: 'Sender first name' },
      { name: 'sender.last_name', label: 'Sender last name' },
      { name: 'sender.full_name', label: 'Sender full name' },
      { name: 'sender.signature', label: 'Email signature', emailOnly: true },
      { name: 'sender.booking_link', label: 'Booking link' },
    ],
  },
  {
    id: 'enrich', label: 'Profile data', note: 'Filled from the stored LinkedIn profile. Add a fallback: not every profile has every field.',
    variables: [
      { name: 'enrich.about', label: 'About (first 600 characters)' },
      { name: 'enrich.current_title', label: 'Current title' },
      { name: 'enrich.current_company', label: 'Current company' },
      { name: 'enrich.years_in_role', label: 'Years in role' },
      { name: 'enrich.months_in_role', label: 'Months in role' },
      { name: 'enrich.previous_company', label: 'Previous company' },
      { name: 'enrich.previous_title', label: 'Previous title' },
      { name: 'enrich.school', label: 'School' },
      { name: 'enrich.degree', label: 'Degree' },
      { name: 'enrich.top_skill', label: 'Top skill' },
      { name: 'enrich.skills', label: 'Top three skills' },
      { name: 'enrich.language', label: 'Profile language' },
      { name: 'enrich.follower_count', label: 'Followers' },
      { name: 'enrich.connections_count', label: 'Connections' },
      { name: 'enrich.recent_post', label: 'Recent post (last 60 days)' },
      { name: 'enrich.recent_post_date', label: 'Recent post date' },
    ],
  },
  { id: 'ai', label: 'AI variables', note: 'Only approved lines are used. Anything not approved falls back.', variables: [] },   // filled from outreach_ai_variables
  {
    id: 'links', label: 'Links',
    variables: [
      { name: 'unsubscribe_link', label: 'Unsubscribe link', emailOnly: true },
      { name: 'booking_link', label: 'Booking link (the sender\'s, with lead tracking)' },
    ],
  },
];

/** Flat list of the built-in variable names (custom.<key> and ai.<key> are per workspace). */
export const TEMPLATE_VARIABLES: string[] = [
  ...TEMPLATE_VARIABLE_GROUPS.flatMap((g) => g.variables.map((v) => v.name)),
  'custom.<key>', 'ai.<key>',
];
