// Which steps make sense after a given branch. The "+" picker greys the rest out and says why, so a sequence
// cannot be built in an order LinkedIn (or the engine) would reject. Mirrors the checks in lib/outreach/graph.ts.
import type { Graph, GraphNode, NodeType } from '@/lib/outreach/types';
import { NODE_CATALOG } from '@/lib/outreach/nodes';

/** Step types on any path from the start down to (and including) `id`. */
function typesAbove(g: Graph, id: string): Set<NodeType> {
  const parents = new Map<string, string[]>();
  for (const n of Object.values(g.nodes)) {
    const targets = [n.next, ...Object.values(n.branches ?? {})];
    for (const t of targets) if (t) parents.set(t, [...(parents.get(t) ?? []), n.id]);
  }
  const out = new Set<NodeType>();
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const n: GraphNode | undefined = g.nodes[cur];
    if (!n) continue;
    out.add(n.type);
    for (const p of parents.get(cur) ?? []) queue.push(p);
  }
  return out;
}

/** For every step type: null when it can follow `exit` of `source`, otherwise a short reason it cannot. */
export function allowedNext(g: Graph, source: string, exit: string): Record<NodeType, string | null> {
  const src = g.nodes[source];
  const above = src ? typesAbove(g, source) : new Set<NodeType>();
  const has = (t: NodeType) => above.has(t);
  const first = src?.type === 'start';
  const afterConnected = src?.type === 'wait_connection' && exit === 'connected';
  const afterNoConnect = src?.type === 'wait_connection' && exit === 'no_connect';
  const invited = has('send_invite');
  const waited = has('wait_connection');
  const withdrawn = has('withdraw_invite');
  const canMessage = waited || has('send_inmail') || afterConnected;

  const out = {} as Record<NodeType, string | null>;
  for (const type of Object.keys(NODE_CATALOG) as NodeType[]) {
    let reason: string | null = null;
    switch (type) {
      case 'start': reason = 'Every sequence already has a start'; break;
      case 'end': if (first) reason = 'Add at least one action before ending the sequence'; break;
      case 'rotate_sender': if (first) reason = 'Needs an earlier step to restart from'; break;
      case 'wait_connection':
        if (afterConnected) reason = 'The lead is already connected on this branch';
        else if (!invited) reason = 'Send an invitation first, then wait for it';
        break;
      case 'withdraw_invite':
        if (afterConnected) reason = 'The lead accepted, so there is nothing to withdraw';
        else if (!invited) reason = 'Only possible after an invitation was sent';
        else if (withdrawn) reason = 'The invitation was already withdrawn on this path';
        break;
      case 'send_invite':
        if (afterConnected) reason = 'The lead is already connected on this branch';
        else if (invited && !withdrawn) reason = 'An invitation was already sent on this path. Withdraw it before sending another';
        break;
      case 'follow_profile':
        if (invited) reason = 'Sending an invitation already follows the lead';
        break;
      case 'send_message':
      case 'send_voice_note':
        if (afterNoConnect) reason = 'The lead did not connect on this branch. Try an InMail or an email instead';
        else if (invited && !waited && !afterConnected) reason = 'Add “Wait for connection” first so the message goes out once the lead accepts';
        else if (!canMessage) reason = 'Messages need a connection first: send an invitation and wait for it, or use an InMail';
        break;
      case 'send_inmail':
        if (afterConnected) reason = 'Connected leads can be messaged directly. Use “Send message”';
        break;
      default: reason = null;
    }
    out[type] = reason;
  }
  return out;
}
