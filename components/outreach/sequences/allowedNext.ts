// Which steps make sense after a given branch. The "+" picker greys the rest out and says why, so a sequence
// cannot be built in an order the channel (or the engine) would reject. Mirrors the checks in lib/outreach/graph.ts.
//
// The picker is context-aware: it looks at every step above the spot, including which branch was taken. After
// "Already connected?" → true the lead is a connection, so "Send message" is offered and "Send invitation" is not;
// on the false branch it is the other way round (invite, wait for the connection, then message).
//
// It is also channel-aware: a step that runs on one channel needs an account of that channel in the sender pool, the
// LinkedIn rules only apply where the lead is on LinkedIn, a WhatsApp message needs a consent check above it, and a
// "Switch channel" above moves the lead to that channel for everything below it.
import type { Graph, GraphNode, NodeType, Provider } from '@/lib/outreach/types';
import { CHANNEL_PROVIDERS } from '@/lib/outreach/types';
import { MESSAGE_TYPES, NODE_CATALOG } from '@/lib/outreach/nodes';
import { branchConnectionFact, type ConnectionFact } from '@/lib/outreach/graph';

interface Above {
  /** Step types on any path from the start down to (and including) the source step. */
  types: Set<NodeType>;
  /** The closest thing the path proves about the lead's connection (a "Wait for connection" exit or an "Already connected?" branch). */
  connection: ConnectionFact | null;
  /** The channel the nearest "Switch channel" above (left through its "next" exit) moved the lead to. */
  switchedTo: Provider | null;
}

/** Walk up from `source` (leaving it through `exit`) to the start, collecting step types, connection facts and channel switches. */
function above(g: Graph, source: string, exit: string): Above {
  const parents = new Map<string, Array<{ id: string; exit: string }>>();
  for (const n of Object.values(g.nodes)) {
    const targets: Array<[string, string | null | undefined]> = [['next', n.next], ...Object.entries(n.branches ?? {})];
    for (const [ex, t] of targets) if (t) parents.set(t, [...(parents.get(t) ?? []), { id: n.id, exit: ex }]);
  }
  const types = new Set<NodeType>();
  let connection: ConnectionFact | null = null;
  let switchedTo: Provider | null = null;
  const seen = new Set<string>();
  // breadth-first from the spot upwards, so the first fact met is the nearest one
  const queue: Array<{ id: string; exit: string }> = [{ id: source, exit }];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    const n: GraphNode | undefined = g.nodes[cur.id];
    if (!n) continue;
    types.add(n.type);
    if (!connection) connection = branchConnectionFact(n, cur.exit);
    if (!switchedTo && n.type === 'channel_switch' && cur.exit === 'next' && CHANNEL_PROVIDERS.includes(n.config?.to_channel)) switchedTo = n.config!.to_channel as Provider;
    for (const p of parents.get(cur.id) ?? []) queue.push(p);
  }
  return { types, connection, switchedTo };
}

const ADD_FIRST: Record<Provider, string> = {
  LINKEDIN: 'Add a LinkedIn account to the sender pool first',
  INSTAGRAM: 'Add an Instagram account to the sender pool first',
  WHATSAPP: 'Add a WhatsApp number to the sender pool first',
  GMAIL: 'Add a mailbox to the sender pool first',
  OUTLOOK: 'Add a mailbox to the sender pool first',
  IMAP: 'Add a mailbox to the sender pool first',
};
const CHANNEL_NAME: Record<Provider, string> = { LINKEDIN: 'LinkedIn', INSTAGRAM: 'Instagram', WHATSAPP: 'WhatsApp', GMAIL: 'Gmail', OUTLOOK: 'Outlook', IMAP: 'IMAP' };

/**
 * For every step type: null when it can follow `exit` of `source`, otherwise a short reason it cannot.
 * `poolProviders` are the providers of the senders in the sequence's pool (a LinkedIn-only pool when omitted).
 */
export function allowedNext(g: Graph, source: string, exit: string, poolProviders: Provider[] = ['LINKEDIN']): Record<NodeType, string | null> {
  const src = g.nodes[source];
  const up = src ? above(g, source, exit) : { types: new Set<NodeType>(), connection: null, switchedTo: null };
  const has = (t: NodeType) => up.types.has(t);
  const first = src?.type === 'start';
  const afterNoConnect = src?.type === 'wait_connection' && exit === 'no_connect';
  const connected = up.connection === 'connected';          // proven by a wait's "connected" exit or an "Already connected?" branch
  const notConnected = up.connection === 'not_connected';   // proven the other way round
  const invited = has('send_invite');
  const waited = has('wait_connection');
  const withdrawn = has('withdraw_invite');
  const canMessage = connected || (waited && !notConnected) || has('send_inmail');

  // the channels the lead can be on at this spot: after a "Switch channel" it is that one, otherwise any channel of the pool
  const poolChannels = CHANNEL_PROVIDERS.filter((p) => poolProviders.includes(p));
  const here: Provider[] = up.switchedTo ? [up.switchedTo] : poolChannels.length ? poolChannels : ['LINKEDIN'];
  const liOnly = here.length === 1 && here[0] === 'LINKEDIN';   // the LinkedIn rules only apply where the lead is on LinkedIn
  const waOnly = here.length === 1 && here[0] === 'WHATSAPP';
  const consentChecked = has('require_consent') || up.switchedTo === 'WHATSAPP';   // a switch to WhatsApp checks consent itself

  const out = {} as Record<NodeType, string | null>;
  for (const type of Object.keys(NODE_CATALOG) as NodeType[]) {
    const meta = NODE_CATALOG[type];
    let reason: string | null = null;

    // a channel step needs an account of its channel in the pool, and fits where the lead can be on that channel
    if (meta.channels && type !== 'send_email') {
      const inPool = meta.channels.filter((c) => poolChannels.includes(c));
      if (inPool.length === 0) {
        reason = meta.channels.length === 1 ? ADD_FIRST[meta.channels[0]]
          : MESSAGE_TYPES.includes(type) && meta.channels.length === 2 ? 'Add a LinkedIn account or a WhatsApp number to the sender pool first'
          : 'Add a LinkedIn, Instagram or WhatsApp account to the sender pool first';
      } else if (up.switchedTo && !meta.channels.includes(up.switchedTo)) {
        reason = `The lead is on ${CHANNEL_NAME[up.switchedTo]} after the switch above. This step runs on ${meta.channels.map((c) => CHANNEL_NAME[c]).join(' or ')}`;
      }
    }

    if (!reason) switch (type) {
      case 'start': reason = 'Every sequence already has a start'; break;
      case 'end': if (first) reason = 'Add at least one action before ending the sequence'; break;
      case 'rotate_sender': if (first) reason = 'Needs an earlier step to restart from'; break;
      case 'wait_connection':
        if (connected) reason = 'The lead is already connected on this branch';
        else if (!invited) reason = 'Send an invitation first, then wait for it';
        break;
      case 'withdraw_invite':
        if (connected) reason = 'The lead is already connected on this branch, so there is nothing to withdraw';
        else if (!invited) reason = 'Only possible after an invitation was sent';
        else if (withdrawn) reason = 'The invitation was already withdrawn on this path';
        break;
      case 'send_invite':
        if (connected) reason = 'The lead is already connected on this branch. Use “Send message”';
        else if (invited && !withdrawn) reason = 'An invitation was already sent on this path. Withdraw it before sending another';
        break;
      case 'follow_profile':
        if (invited) reason = 'Sending an invitation already follows the lead';
        break;
      case 'send_message':
      case 'send_voice_note':
        if (waOnly && !consentChecked) reason = 'Add “Check consent” first: WhatsApp messages need a recorded consent basis';
        else if (!liOnly) reason = null;   // Instagram and WhatsApp messages need no connection
        else if (connected) reason = null;
        else if (afterNoConnect) reason = 'The lead did not connect on this branch. Try an InMail or an email instead';
        else if (invited && !waited) reason = 'Add “Wait for connection” first so the message goes out once the lead accepts';
        else if (!canMessage) reason = 'Messages need a connection first: send an invitation and wait for it, or use an InMail';
        break;
      case 'send_inmail':
        if (connected) reason = 'Connected leads can be messaged directly. Use “Send message”';
        break;
      // Instagram
      case 'follow':
        if (has('follow') && !has('unfollow')) reason = 'The lead is already followed on this path';
        break;
      case 'unfollow':
        if (!has('follow')) reason = 'Only useful after a “Follow” step on this path';
        break;
      case 'wait_follow_back':
        if (!has('follow')) reason = 'Follow the person first, then wait to see whether they follow back';
        break;
      // WhatsApp
      case 'require_consent':
        if (has('require_consent')) reason = 'Consent was already checked on this path';
        break;
      // logic
      case 'wait_for_reply':
        if (first) reason = 'Send something first, then wait for the reply';
        break;
      case 'channel_switch':
        if (poolChannels.length < 2) reason = 'Add accounts of two different channels to the sender pool first (for example LinkedIn and WhatsApp)';
        break;
      default: reason = null;
    }
    out[type] = reason;
  }
  return out;
}
