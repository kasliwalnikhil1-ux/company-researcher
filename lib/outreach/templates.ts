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

// --- channels (docs/outreach/CHANNELS-BUILD-CONTRACT.md §3) -------------------

const IG_FOLLOW_BACK_MESSAGE = 'Hey {{first_name|there}}, thanks for the follow back! {Loved|Really enjoyed} your recent posts. What are you working on at the moment?';
const IG_NO_FOLLOW_BACK_MESSAGE = 'Hi {{first_name|there}}, I have been following your posts for a bit and {enjoy|like} what you share. Would love to hear what you are working on.';
const IG_CHECK_IN_MESSAGE = 'Hey {{first_name|there}}, just checking in. Happy to chat whenever it suits you.';
const IG_COMMENT = 'Great point. Thanks for sharing this.';

const LI_FIRST_MESSAGE = '{Hi|Hey} {{first_name|there}}, {thanks for connecting|great to connect}! What are you focused on at {{company|your company}} these days?';
const LI_SECOND_MESSAGE = 'Hi {{first_name|there}}, just bumping this in case it got buried. Happy to chat whenever it suits you.';

const WA_FIRST_MESSAGE = 'Hi {{first_name|there}}, this is {{sender.first_name}}. Thanks for agreeing to hear from us here. Is now a good time for a quick question?';
const WA_SECOND_MESSAGE = 'Hi {{first_name|there}}, a quick follow-up in case my last message got lost. Happy to chat when it suits you.';

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
  {
    id: 'instagram_ladder',
    name: 'Instagram engagement ladder',
    tagline: 'Follow, like, wait for a follow-back, then message.',
    description: 'The Instagram sequence that gets replies: a follow and a couple of likes first, then a message once the lead follows back (or a comment and a message when they do not). Instagram is a low-volume, high-touch channel: every action counts against 10 per hour, and an account keeps roughly 40 leads in flight. Do not expect LinkedIn volumes.',
    needs: 'An Instagram account in the sender pool, and leads with an Instagram handle on file.',
    steps: [
      'Follow the lead, wait a day, like two recent posts',
      'Wait 2 days, then up to 5 days for a follow-back (the account’s followers are checked a couple of times a day)',
      'Followed back: send a message. Not followed back: comment on a post, wait 3 days, then message',
      'Wait 4 days for a reply',
      'Replied: finish, the inbox takes over. No reply: wait 5 days, send one last message, finish',
    ],
    build: () => graph([
      { id: 'start', type: 'start', label: 'Start', next: 'follow' },
      { id: 'follow', type: 'follow', label: 'Follow', next: 'delay_after_follow' },
      { id: 'delay_after_follow', type: 'delay', label: 'Wait 1 day', config: { amount: 1, unit: 'days', jitter_pct: 20 }, next: 'like_posts' },
      { id: 'like_posts', type: 'like_recent_posts', label: 'Like 2 recent posts', config: { count: 2, max_age_days: 60 }, next: 'delay_after_likes' },
      { id: 'delay_after_likes', type: 'delay', label: 'Wait 2 days', config: { amount: 2, unit: 'days', jitter_pct: 20 }, next: 'wait_follow_back' },
      { id: 'wait_follow_back', type: 'wait_follow_back', label: 'Wait for follow-back', config: { window_days: 5, poll_budget: 2 }, branches: { followed_back: 'message_followed', no_follow_back: 'comment_post' } },
      { id: 'message_followed', type: 'send_message', label: 'Message after follow-back', config: { text: IG_FOLLOW_BACK_MESSAGE, send_always: false, new_chat_allowed: true, channel: 'INSTAGRAM' }, next: 'wait_for_reply' },
      { id: 'comment_post', type: 'comment_post', label: 'Comment on a post', config: { text: IG_COMMENT, max_age_days: 60 }, next: 'delay_after_comment' },
      { id: 'delay_after_comment', type: 'delay', label: 'Wait 3 days', config: { amount: 3, unit: 'days', jitter_pct: 20 }, next: 'message_not_followed' },
      { id: 'message_not_followed', type: 'send_message', label: 'Message without follow-back', config: { text: IG_NO_FOLLOW_BACK_MESSAGE, send_always: false, new_chat_allowed: true, channel: 'INSTAGRAM' }, next: 'wait_for_reply' },
      { id: 'wait_for_reply', type: 'wait_for_reply', label: 'Wait for a reply', config: { window_hours: 96 }, branches: { replied: 'end_replied', no_reply: 'delay_before_check_in' } },
      { id: 'end_replied', type: 'end', label: 'Replied' },
      { id: 'delay_before_check_in', type: 'delay', label: 'Wait 5 days', config: { amount: 5, unit: 'days', jitter_pct: 20 }, next: 'check_in' },
      { id: 'check_in', type: 'send_message', label: 'Check-in message', config: { text: IG_CHECK_IN_MESSAGE, send_always: false, new_chat_allowed: true, channel: 'INSTAGRAM' }, next: 'end_done' },
      { id: 'end_done', type: 'end', label: 'Done' },
    ]),
  },
  {
    id: 'linkedin_to_whatsapp',
    name: 'LinkedIn first, WhatsApp through the conversation',
    tagline: 'Connect and message on LinkedIn; WhatsApp follows once they reply.',
    description: 'The cross-channel pattern that is both allowed and effective. The sequence itself runs on LinkedIn: a visit, an invitation, a message once connected, and a wait for the reply. WhatsApp is reached through the inbox: when the lead replies and shares a number, that reply is the consent you record on the lead, and the conversation continues on WhatsApp from there. WhatsApp is never contacted in parallel or without that consent.',
    needs: 'A LinkedIn account in the sender pool. To continue on WhatsApp later, a WhatsApp number in the workspace and a recorded consent on the lead.',
    steps: [
      'Visit the profile and send a connection request',
      'Wait up to 10 days for the connection',
      'Connected: send a message and wait 4 days for a reply',
      'Replied: finish, carry on in the inbox (record the WhatsApp consent when they share a number). No reply: wait a week, send one more message, finish',
      'Not connected: withdraw the invitation and finish',
    ],
    build: () => graph([
      { id: 'start', type: 'start', label: 'Start', next: 'visit_profile' },
      { id: 'visit_profile', type: 'visit_profile', label: 'Visit profile', config: { notify: true }, next: 'send_invite' },
      { id: 'send_invite', type: 'send_invite', label: 'Send invitation', config: { note: '', require_note_for_free: false }, next: 'wait_connection' },
      { id: 'wait_connection', type: 'wait_connection', label: 'Wait for connection', config: { window_days: INVITE_WINDOW_DAYS, subtasks: WAIT_SUBTASKS }, branches: { connected: 'first_message', no_connect: 'withdraw_invite' } },
      { id: 'first_message', type: 'send_message', label: 'First message', config: { text: LI_FIRST_MESSAGE, send_always: false, new_chat_allowed: true }, next: 'wait_for_reply' },
      { id: 'wait_for_reply', type: 'wait_for_reply', label: 'Wait for a reply', config: { window_hours: 96 }, branches: { replied: 'end_replied', no_reply: 'delay_before_second' } },
      { id: 'end_replied', type: 'end', label: 'Replied' },
      { id: 'delay_before_second', type: 'delay', label: 'Wait 1 week', config: { amount: 7, unit: 'days', jitter_pct: 20 }, next: 'second_message' },
      { id: 'second_message', type: 'send_message', label: 'Second message', config: { text: LI_SECOND_MESSAGE, send_always: false, new_chat_allowed: true }, next: 'end_done' },
      { id: 'end_done', type: 'end', label: 'Done' },
      ...withdrawAndEnd(),
    ]),
  },
  {
    id: 'whatsapp_consented_followup',
    name: 'WhatsApp follow-up for consented leads',
    tagline: 'Only people who agreed to hear from you; check the number, message, follow up once.',
    description: 'For leads who already agreed to hear from you on WhatsApp: a form opt-in, an existing customer, a number shared in a conversation. The sequence checks that consent first and that the number is actually on WhatsApp, sends one message, waits three days for a reply and follows up once. Leads without a recorded consent or with a number that is not on WhatsApp leave without being contacted.',
    needs: 'A WhatsApp number in the sender pool (connected for at least 24 hours), and leads with a phone number and a recorded WhatsApp consent. WhatsApp only reaches people who agreed to hear from you.',
    steps: [
      'Only continue with leads who have a recorded WhatsApp consent',
      'Check that the number is on WhatsApp',
      'Send a first message and wait 3 days for a reply',
      'Replied: finish, the inbox takes over. No reply: wait 3 days, send one follow-up, finish',
      'No consent or number not on WhatsApp: finish without contact',
    ],
    build: () => graph([
      { id: 'start', type: 'start', label: 'Start', next: 'require_consent' },
      { id: 'require_consent', type: 'require_consent', label: 'Check consent', config: { bases: [] }, branches: { has_consent: 'check_number', no_consent: 'end_no_consent' } },
      { id: 'end_no_consent', type: 'end', label: 'No consent' },
      { id: 'check_number', type: 'check_identifier', label: 'Check the number', branches: { valid: 'first_message', invalid: 'end_not_on_whatsapp' } },
      { id: 'end_not_on_whatsapp', type: 'end', label: 'Not on WhatsApp' },
      { id: 'first_message', type: 'send_message', label: 'First message', config: { text: WA_FIRST_MESSAGE, send_always: false, new_chat_allowed: true, channel: 'WHATSAPP' }, next: 'wait_for_reply' },
      { id: 'wait_for_reply', type: 'wait_for_reply', label: 'Wait for a reply', config: { window_hours: 72 }, branches: { replied: 'end_replied', no_reply: 'delay_before_follow_up' } },
      { id: 'end_replied', type: 'end', label: 'Replied' },
      { id: 'delay_before_follow_up', type: 'delay', label: 'Wait 3 days', config: { amount: 3, unit: 'days', jitter_pct: 20 }, next: 'follow_up' },
      { id: 'follow_up', type: 'send_message', label: 'Follow-up', config: { text: WA_SECOND_MESSAGE, send_always: false, new_chat_allowed: true, channel: 'WHATSAPP' }, next: 'end_done' },
      { id: 'end_done', type: 'end', label: 'Done' },
    ]),
  },
];

export function findTemplate(id: string): SequenceTemplate | undefined {
  return SEQUENCE_TEMPLATES.find((t) => t.id === id);
}
