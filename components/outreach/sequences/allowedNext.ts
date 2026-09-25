// Which steps make sense after a given branch. The "+" picker greys the rest out and says why, so a sequence
// cannot be built in an order LinkedIn (or the engine) would reject. Mirrors the checks in lib/outreach/graph.ts.
//
// The picker is context-aware: it looks at every step above the spot, including which branch was taken. After
// "Already connected?" → true the lead is a connection, so "Send message" is offered and "Send invitation" is not;
// on the false branch it is the other way round (invite, wait for the connection, then message).
import type { Graph, GraphNode, NodeType } from '@/lib/outreach/types';
import { NODE_CATALOG } from '@/lib/outreach/nodes';
import { branchConnectionFact, type ConnectionFact } from '@/lib/outreach/graph';

interface Above {
  /** Step types on any path from the start down to (and including) the source step. */
  types: Set<NodeType>;
  /** The closest thing the path proves about the lead's connection (a "Wait for connection" exit or an "Already connected?" branch). */
  connection: ConnectionFact | null;
}

/** Walk up from `source` (leaving it through `exit`) to the start, collecting step types and connection facts. */
function above(g: Graph, source: string, exit: string): Above {
  const parents = new Map<string, Array<{ id: string; exit: string }>>();
  for (const n of Object.values(g.nodes)) {
    const targets: Array<[string, string | null | undefined]> = [['next', n.next], ...Object.entries(n.branches ?? {})];
    for (const [ex, t] of targets) if (t) parents.set(t, [...(parents.get(t) ?? []), { id: n.id, exit: ex }]);
  }
  const types = new Set<NodeType>();
  let connection: ConnectionFact | null = null;
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
    for (const p of parents.get(cur.id) ?? []) queue.push(p);
  }
  return { types, connection };
}

/** For every step type: null when it can follow `exit` of `source`, otherwise a short reason it cannot. */
export function allowedNext(g: Graph, source: string, exit: string): Record<NodeType, string | null> {
  const src = g.nodes[source];
  const up = src ? above(g, source, exit) : { types: new Set<NodeType>(), connection: null };
  const has = (t: NodeType) => up.types.has(t);
  const first = src?.type === 'start';
  const afterNoConnect = src?.type === 'wait_connection' && exit === 'no_connect';
  const connected = up.connection === 'connected';          // proven by a wait's "connected" exit or an "Already connected?" branch
  const notConnected = up.connection === 'not_connected';   // proven the other way round
  const invited = has('send_invite');
  const waited = has('wait_connection');
  const withdrawn = has('withdraw_invite');
  const canMessage = connected || (waited && !notConnected) || has('send_inmail');

  const out = {} as Record<NodeType, string | null>;
  for (const type of Object.keys(NODE_CATALOG) as NodeType[]) {
    let reason: string | null = null;
    switch (type) {
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
        if (connected) reason = null;
        else if (afterNoConnect) reason = 'The lead did not connect on this branch. Try an InMail or an email instead';
        else if (invited && !waited) reason = 'Add “Wait for connection” first so the message goes out once the lead accepts';
        else if (!canMessage) reason = 'Messages need a connection first: send an invitation and wait for it, or use an InMail';
        break;
      case 'send_inmail':
        if (connected) reason = 'Connected leads can be messaged directly. Use “Send message”';
        break;
      default: reason = null;
    }
    out[type] = reason;
  }
  return out;
}
