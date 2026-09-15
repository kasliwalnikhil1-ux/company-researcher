// Node catalogue for the sequence builder: metadata, defaults, exits, limits.
import type { ActionType, NodeType, GraphNode } from './types';

export type NodeGroup = 'Outreach' | 'Social' | 'Logic' | 'CRM' | 'Integrations' | 'AI' | 'Flow';

export interface NodeMeta {
  type: NodeType;
  label: string;
  group: NodeGroup;
  description: string;
  exits: string[];            // [] = terminal, ['next'] = single exit, else branch names
  actionType: ActionType | null;
  defaultConfig: Record<string, any>;
  color: string;              // tailwind bg class
}

export const NODE_CATALOG: Record<NodeType, NodeMeta> = {
  start: { type: 'start', label: 'Start', group: 'Flow', description: 'Entry point', exits: ['next'], actionType: null, defaultConfig: {}, color: 'bg-gray-800' },
  end: { type: 'end', label: 'End', group: 'Flow', description: 'Completes the enrollment', exits: [], actionType: null, defaultConfig: { reason: '' }, color: 'bg-gray-500' },
  visit_profile: { type: 'visit_profile', label: 'Visit profile', group: 'Outreach', description: 'View the lead profile (optionally notify)', exits: ['next'], actionType: 'profile_view', defaultConfig: { notify: true }, color: 'bg-sky-600' },
  like_latest_post: { type: 'like_latest_post', label: 'Like latest post', group: 'Social', description: 'React to the most recent post', exits: ['next'], actionType: 'like', defaultConfig: { max_age_days: 90, reaction: 'like' }, color: 'bg-pink-600' },
  comment_latest_post: { type: 'comment_latest_post', label: 'Comment on post', group: 'Social', description: 'Comment on the most recent post', exits: ['next'], actionType: 'comment', defaultConfig: { text: '', max_age_days: 90 }, color: 'bg-pink-600' },
  endorse_skills: { type: 'endorse_skills', label: 'Endorse skills', group: 'Social', description: 'Endorse 1–5 skills', exits: ['next'], actionType: 'endorse', defaultConfig: { count: 1 }, color: 'bg-pink-600' },
  send_invite: { type: 'send_invite', label: 'Send invitation', group: 'Outreach', description: 'Connection request with optional note', exits: ['next'], actionType: 'invite', defaultConfig: { note: '', require_note_for_free: false }, color: 'bg-indigo-600' },
  wait_connection: { type: 'wait_connection', label: 'Wait for connection', group: 'Outreach', description: 'Wait until the invite is accepted', exits: ['connected', 'no_connect'], actionType: null, defaultConfig: { window_days: 14, subtasks: [] }, color: 'bg-indigo-500' },
  withdraw_invite: { type: 'withdraw_invite', label: 'Withdraw invitation', group: 'Outreach', description: 'Cancel a pending invitation', exits: ['next'], actionType: 'withdraw', defaultConfig: {}, color: 'bg-indigo-400' },
  send_message: { type: 'send_message', label: 'Send message', group: 'Outreach', description: 'LinkedIn message (1st-degree only)', exits: ['next'], actionType: 'message', defaultConfig: { text: '', send_always: false }, color: 'bg-blue-600' },
  send_inmail: { type: 'send_inmail', label: 'Send InMail', group: 'Outreach', description: 'InMail via Classic / Sales Navigator / Recruiter', exits: ['next', 'no_credit'], actionType: 'inmail', defaultConfig: { subject: '', text: '', api: 'classic', open_profile_only: false }, color: 'bg-blue-700' },
  send_email: { type: 'send_email', label: 'Send email', group: 'Outreach', description: 'Email from a connected mailbox', exits: ['next', 'bounced', 'no_email'], actionType: 'email', defaultConfig: { subject: '', html: '', to: 'any', thread: 'continue', mailbox_sender_id: null, track: true }, color: 'bg-emerald-600' },
  delay: { type: 'delay', label: 'Delay', group: 'Logic', description: 'Wait for a period with jitter', exits: ['next'], actionType: null, defaultConfig: { amount: 1, unit: 'days', jitter_pct: 20 }, color: 'bg-amber-500' },
  condition: { type: 'condition', label: 'Condition', group: 'Logic', description: 'Branch on lead or relation attributes', exits: ['true', 'false'], actionType: null, defaultConfig: { rules: [], match: 'all' }, color: 'bg-amber-600' },
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
  ai_draft_approval: { type: 'ai_draft_approval', label: 'AI draft + approval', group: 'AI', description: 'Draft with AI, send after human approval', exits: ['next'], actionType: null, defaultConfig: { kind: 'message', brief: '' }, color: 'bg-fuchsia-600' },
};

export const NODE_GROUPS: NodeGroup[] = ['Outreach', 'Social', 'Logic', 'CRM', 'Integrations', 'AI', 'Flow'];

export const EXECUTABLE_TYPES: NodeType[] = ['visit_profile', 'like_latest_post', 'comment_latest_post', 'endorse_skills', 'send_invite', 'withdraw_invite', 'send_message', 'send_inmail', 'send_email', 'call_api'];

export const TEXT_LIMITS = {
  invite_note: 300,
  invite_note_free: 200,
  message: 8000,
  comment: 1250,
  inmail_subject: 200,
  inmail_body: 1900,
} as const;

export const CONDITION_FIELDS: Array<{ value: string; label: string; boolean?: boolean }> = [
  { value: 'replied', label: 'Replied', boolean: true },
  { value: 'accepted', label: 'Accepted invitation', boolean: true },
  { value: 'relation', label: 'Relation (none/pending_out/first…)' },
  { value: 'email_bounced', label: 'Email bounced', boolean: true },
  { value: 'has_email_work', label: 'Has work email', boolean: true },
  { value: 'has_email_personal', label: 'Has personal email', boolean: true },
  { value: 'is_open_profile', label: 'Is open profile', boolean: true },
  { value: 'has_tag', label: 'Has tag (tag id)' },
  { value: 'stage_is', label: 'Stage is (stage id)' },
  { value: 'sender_is_premium', label: 'Sender is premium', boolean: true },
  { value: 'company', label: 'Company' },
  { value: 'title', label: 'Title' },
  { value: 'headline', label: 'Headline' },
  { value: 'location', label: 'Location' },
  { value: 'custom.', label: 'Custom field (custom.key)' },
];

export const CONDITION_OPS = ['eq', 'neq', 'contains', 'not_contains', 'exists', 'not_exists', 'gt', 'lt'] as const;

export function newNode(type: NodeType, position: { x: number; y: number }): GraphNode {
  const meta = NODE_CATALOG[type];
  const id = `${type}_${Math.random().toString(36).slice(2, 8)}`;
  const node: GraphNode = { id, type, label: meta.label, config: { ...meta.defaultConfig }, position };
  if (meta.exits.length === 1) node.next = null;
  else if (meta.exits.length > 1) node.branches = Object.fromEntries(meta.exits.map((e) => [e, null]));
  return node;
}

export const TEMPLATE_VARIABLES = [
  'first_name', 'last_name', 'full_name', 'company', 'title', 'headline', 'location',
  'sender.first_name', 'sender.last_name', 'sender.full_name', 'custom.<key>',
];
