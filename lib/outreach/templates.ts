// Ready-made sequences offered on /outreach/sequences ("Start from a template").
// Each template builds a fresh graph with the same node shapes the builder produces (NODE_CATALOG defaults + overrides),
// so it can be saved through save_sequence as is. Positions are placeholders: run autoLayout() before showing or saving.
import type { Graph, GraphNode, NodeType } from './types';
import { NODE_CATALOG } from './nodes';

export interface SequenceTemplate {
  id: string;
  name: string;
  /** One line under the name in the picker. */
  tagline: string;
  /** What the flow does and who it is for, in plain words. */
  description: string;
  /** Plain-language outline shown next to the preview, top to bottom. */
  steps: string[];
  /** Things the workspace needs before this flow can go live (shown as a hint). */
  needs?: string;
  build: () => Graph;
}

type Spec = {
  id: string;
  type: NodeType;
  label: string;
  config?: Record<string, unknown>;
  mode?: 'manual';
  next?: string | null;
  branches?: Record<string, string | null>;
};

/** A node with the catalogue defaults merged under the overrides, positioned at the origin (autoLayout places it). */
function node(spec: Spec): GraphNode {
  const meta = NODE_CATALOG[spec.type];
  const n: GraphNode = {
    id: spec.id,
    type: spec.type,
    label: spec.label,
    config: { ...JSON.parse(JSON.stringify(meta.defaultConfig)), ...(spec.config ?? {}) },
    position: { x: 0, y: 0 },
  };
  if (spec.mode) n.mode = spec.mode;
  if (meta.exits.length === 1) n.next = spec.next ?? null;
  else if (meta.exits.length > 1) n.branches = Object.fromEntries(meta.exits.map((e) => [e, spec.branches?.[e] ?? null]));
  return n;
}

function graph(specs: Spec[]): Graph {
  return { version: 1, start: 'start', nodes: Object.fromEntries(specs.map((s) => [s.id, node(s)])) };
}

// --- shared pieces -----------------------------------------------------------

const INVITE_WINDOW_DAYS = 10;
/** Light touches spread across the wait window that nudge the lead to accept. */
const WAIT_SUBTASKS = [{ type: 'visit_profile' }, { type: 'like_latest_post' }];

const THANKS_MESSAGE = '{Hi|Hey} {{first_name|there}}, {thanks for connecting|pleasure connecting|great to connect}!';

const MANUAL_FOLLOW_UP_GUIDE =
  'Replace this text with your own note before you mark the task done.\n\n' +
  'Send a short compliment about something personal from their LinkedIn profile: a hobby, a sport, a recent post. ' +
  'It works even better when you tie it to yourself and add a casual question that is not about your offer.\n\n' +
  'Example: "Thanks for connecting! Looks like you\'re a dog person. I also have two pinschers, what\'s your breed?"';

const NURTURE_MESSAGE = "Hey {{first_name|there}}, long time no chat! How've you been?";

/** Start → are we already connected? → yes: end, no: invite → wait N days. Callers wire the two exits of the wait. */
function connectSpine(opts: { connected: string; noConnect: string }): Spec[] {
  return [
    { id: 'start', type: 'start', label: 'Start', next: 'already_connected' },
    { id: 'already_connected', type: 'condition', label: 'Already connected?', config: { rules: [{ field: 'relation', op: 'eq', value: 'first' }], match: 'all' }, branches: { true: 'end_already_connected', false: 'send_invite' } },
    { id: 'end_already_connected', type: 'end', label: 'Already connected' },
    { id: 'send_invite', type: 'send_invite', label: 'Send invitation', config: { note: '', require_note_for_free: false }, next: 'wait_connection' },
    { id: 'wait_connection', type: 'wait_connection', label: 'Wait for connection', config: { window_days: INVITE_WINDOW_DAYS, subtasks: WAIT_SUBTASKS }, branches: { connected: opts.connected, no_connect: opts.noConnect } },
  ];
}

/** no connect → withdraw the invitation → end. */
function withdrawAndEnd(): Spec[] {
  return [
    { id: 'withdraw_invite', type: 'withdraw_invite', label: 'Withdraw invitation', next: 'end_not_connected' },
    { id: 'end_not_connected', type: 'end', label: 'Not connected' },
  ];
}

/** no connect → withdraw → wait two weeks → let the next sender try from the top → end when nobody is left. */
function withdrawAndRotate(): Spec[] {
  return [
    { id: 'withdraw_invite', type: 'withdraw_invite', label: 'Withdraw invitation', next: 'delay_before_rotate' },
    { id: 'delay_before_rotate', type: 'delay', label: 'Wait 2 weeks', config: { amount: 14, unit: 'days', jitter_pct: 20 }, next: 'rotate_sender' },
    { id: 'rotate_sender', type: 'rotate_sender', label: 'Try the next sender', config: { restart_from: 'already_connected', max_rotations: 2 }, next: 'end_no_senders_left' },
    { id: 'end_no_senders_left', type: 'end', label: 'No sender left to try' },
  ];
}

/** connected → wait a day → thank-you message → end. */
function thankYouFollowUp(manual: boolean): Spec[] {
  return [
    { id: 'delay_after_connect', type: 'delay', label: 'Wait 1 day', config: { amount: 1, unit: 'days', jitter_pct: 20 }, next: 'follow_up' },
    manual
      ? { id: 'follow_up', type: 'send_message', label: 'Personal follow-up (written by you)', mode: 'manual', config: { text: MANUAL_FOLLOW_UP_GUIDE, send_always: false }, next: 'end_done' }
      : { id: 'follow_up', type: 'send_message', label: 'Thank-you message', config: { text: THANKS_MESSAGE, send_always: false }, next: 'end_done' },
    { id: 'end_done', type: 'end', label: 'Done' },
  ];
}

// --- the templates -----------------------------------------------------------

export const SEQUENCE_TEMPLATES: SequenceTemplate[] = [
  {
    id: 'connect',
    name: 'Connect',
    tagline: 'Send an invitation, wait 10 days, withdraw if ignored.',
    description: 'The simplest way to grow a network. Leads already connected to the sender are skipped. Everyone else gets an invitation without a note. Invitations still pending after 10 days are withdrawn so they do not pile up.',
    steps: [
      'Skip leads the sender is already connected to',
      'Send a connection request without a note',
      'Wait up to 10 days, visiting the profile and liking a post in the meantime',
      'Accepted: finish',
      'Not accepted: withdraw the invitation and finish',
    ],
    build: () => graph([
      ...connectSpine({ connected: 'end_connected', noConnect: 'withdraw_invite' }),
      { id: 'end_connected', type: 'end', label: 'Connected' },
      ...withdrawAndEnd(),
    ]),
  },
  {
    id: 'connect_follow_up',
    name: 'Connect and follow up',
    tagline: 'Invite, then thank new connections a day later.',
    description: 'Same as Connect, plus a short automatic thank-you message the day after the lead accepts. The wording is spun so every lead gets a slightly different line.',
    steps: [
      'Skip leads the sender is already connected to',
      'Send a connection request without a note',
      'Wait up to 10 days, visiting the profile and liking a post in the meantime',
      'Accepted: wait a day, send a thank-you message, finish',
      'Not accepted: withdraw the invitation and finish',
    ],
    build: () => graph([
      ...connectSpine({ connected: 'delay_after_connect', noConnect: 'withdraw_invite' }),
      ...thankYouFollowUp(false),
      ...withdrawAndEnd(),
    ]),
  },
  {
    id: 'connect_manual_follow_up',
    name: 'Connect and manual follow-up',
    tagline: 'Invite, then a teammate writes a personal first message.',
    description: 'Same as Connect, but the follow-up is a task for a teammate instead of an automatic message. The task carries tips for a personal compliment and a casual question. Best when the first message should not read like a template.',
    steps: [
      'Skip leads the sender is already connected to',
      'Send a connection request without a note',
      'Wait up to 10 days, visiting the profile and liking a post in the meantime',
      'Accepted: wait a day, then create a task to write and send a personal note',
      'Not accepted: withdraw the invitation and finish',
    ],
    build: () => graph([
      ...connectSpine({ connected: 'delay_after_connect', noConnect: 'withdraw_invite' }),
      ...thankYouFollowUp(true),
      ...withdrawAndEnd(),
    ]),
  },
  {
    id: 'rotate_until_connected',
    name: 'Rotate senders until connected',
    tagline: 'If one sender is ignored, the next one tries.',
    description: 'Connect and follow up, with a second chance. When an invitation is not accepted, it is withdrawn, the lead rests for two weeks, and the next sender in the pool starts from the top. Up to two extra senders try before the lead is given up.',
    needs: 'Two or more senders in the pool, otherwise there is nobody to rotate to.',
    steps: [
      'Skip leads the sender is already connected to',
      'Send a connection request without a note',
      'Wait up to 10 days, visiting the profile and liking a post in the meantime',
      'Accepted: wait a day, send a thank-you message, finish',
      'Not accepted: withdraw, wait 2 weeks, hand the lead to the next sender (up to 2 times)',
    ],
    build: () => graph([
      ...connectSpine({ connected: 'delay_after_connect', noConnect: 'withdraw_invite' }),
      ...thankYouFollowUp(false),
      ...withdrawAndRotate(),
    ]),
  },
  {
    id: 'connect_every_sender',
    name: 'Connect every sender to every lead',
    tagline: 'Each sender in the pool connects with each lead.',
    description: 'Builds the whole team\'s network at once. After one sender connects, the lead rests for five days and the next sender sends their own invitation. Ignored invitations are withdrawn and the next sender tries two weeks later. No messages are sent.',
    needs: 'Two or more senders in the pool.',
    steps: [
      'Skip leads the sender is already connected to',
      'Send a connection request without a note',
      'Wait up to 10 days, visiting the profile and liking a post in the meantime',
      'Accepted: wait 5 days, then the next sender starts from the top',
      'Not accepted: withdraw, wait 2 weeks, then the next sender starts from the top',
    ],
    build: () => graph([
      ...connectSpine({ connected: 'delay_after_connect', noConnect: 'withdraw_invite' }),
      { id: 'delay_after_connect', type: 'delay', label: 'Wait 5 days', config: { amount: 5, unit: 'days', jitter_pct: 20 }, next: 'rotate_after_connect' },
      { id: 'rotate_after_connect', type: 'rotate_sender', label: 'Next sender connects too', config: { restart_from: 'already_connected', max_rotations: 2 }, next: 'end_all_connected' },
      { id: 'end_all_connected', type: 'end', label: 'Every sender connected' },
      ...withdrawAndRotate(),
    ]),
  },
  {
    id: 'nurture_connected',
    name: 'Nurture and follow up connected leads',
    tagline: 'Six weeks of likes, then a casual check-in.',
    description: 'For leads who are already connected but went quiet. Three rounds of a two-week pause followed by a like on their latest post keep the sender visible, then a short "long time no chat" message reopens the conversation. Leads who are not connected to the sender leave the sequence after a day.',
    steps: [
      'Only continue with leads the sender is connected to',
      'Wait 2 weeks, like their latest post',
      'Wait 2 weeks, like their latest post',
      'Wait 2 weeks, like their latest post',
      'Send a casual check-in message and finish',
    ],
    build: () => graph([
      { id: 'start', type: 'start', label: 'Start', next: 'connected_check' },
      { id: 'connected_check', type: 'wait_connection', label: 'Connected?', config: { window_days: 1, subtasks: [] }, branches: { connected: 'delay_1', no_connect: 'end_not_connected' } },
      { id: 'end_not_connected', type: 'end', label: 'Not connected' },
      { id: 'delay_1', type: 'delay', label: 'Wait 2 weeks', config: { amount: 14, unit: 'days', jitter_pct: 20 }, next: 'like_1' },
      { id: 'like_1', type: 'like_latest_post', label: 'Like latest post', next: 'delay_2' },
      { id: 'delay_2', type: 'delay', label: 'Wait 2 weeks', config: { amount: 14, unit: 'days', jitter_pct: 20 }, next: 'like_2' },
      { id: 'like_2', type: 'like_latest_post', label: 'Like latest post', next: 'delay_3' },
      { id: 'delay_3', type: 'delay', label: 'Wait 2 weeks', config: { amount: 14, unit: 'days', jitter_pct: 20 }, next: 'like_3' },
      { id: 'like_3', type: 'like_latest_post', label: 'Like latest post', next: 'check_in' },
      { id: 'check_in', type: 'send_message', label: 'Check-in message', config: { text: NURTURE_MESSAGE, send_always: false }, next: 'end_done' },
      { id: 'end_done', type: 'end', label: 'Done' },
    ]),
  },
];

export function findTemplate(id: string): SequenceTemplate | undefined {
  return SEQUENCE_TEMPLATES.find((t) => t.id === id);
}
