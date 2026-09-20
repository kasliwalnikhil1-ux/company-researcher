// Pure helpers for the sequence builder: graph mutations, layout, summaries, diffs.
import type { Graph, GraphNode, List, NodeDelay, NodeType, OutboundWebhook, Sender, Sequence, SequenceStatus, Stage, Tag } from '@/lib/outreach/types';
import { NODE_CATALOG, newNode, nodeExits } from '@/lib/outreach/nodes';
import { parseError } from '@/lib/outreach/api';

export interface Lookup {
  tags?: Tag[];
  lists?: List[];
  stages?: Stage[];
  senders?: Sender[];
  webhooks?: OutboundWebhook[];
  sequences?: Sequence[];
}

export const STATUS_TONE: Record<SequenceStatus, 'gray' | 'green' | 'amber' | 'blue'> = { draft: 'gray', active: 'green', paused: 'amber', archived: 'blue' };

export const NODE_W = 240;
export const LAYOUT_X = 320;
export const LAYOUT_Y = 170;

export function senderName(s: Pick<Sender, 'display_name' | 'owner_email' | 'public_identifier' | 'provider'> | null | undefined): string {
  if (!s) return 'Unknown sender';
  return s.display_name || s.owner_email || s.public_identifier || s.provider;
}

export function nodeTitle(n: GraphNode | null | undefined): string {
  if (!n) return '—';
  return n.label || NODE_CATALOG[n.type]?.label || n.type;
}

export function truncate(s: string | null | undefined, n = 60): string {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function formatDelay(d: Partial<NodeDelay> | null | undefined): string {
  if (!d || d.amount == null) return '';
  const unit = d.unit ?? 'days';
  const base = `${d.amount} ${d.amount === 1 ? unit.replace(/s$/, '') : unit}`;
  return d.jitter_pct ? `${base} ±${d.jitter_pct}%` : base;
}

export function formatDays(days: number): string {
  if (days >= 9999) return 'no capacity (never)';
  if (days < 1) return 'less than a day';
  if (days <= 14) return `${days} day${days === 1 ? '' : 's'}`;
  const weeks = days / 7;
  return `${weeks % 1 === 0 ? weeks : weeks.toFixed(1)} weeks (${days} days)`;
}

export function nodeSummary(node: GraphNode, lookup: Lookup = {}, nodes: Record<string, GraphNode> = {}): string {
  const c = node.config ?? {};
  switch (node.type) {
    case 'start': return 'Entry point';
    case 'end': return c.reason ? `Reason: ${truncate(c.reason, 50)}` : 'Completes the enrollment';
    case 'visit_profile': return c.notify === false ? 'Silent visit' : 'Visit and notify the lead';
    case 'like_latest_post': return `${c.reaction || 'like'} · posts newer than ${c.max_age_days ?? 90}d`;
    case 'comment_latest_post': return truncate(c.text) || (c.ai ? 'AI-drafted comment (needs approval)' : 'No comment text');
    case 'endorse_skills': return `Endorse ${c.count ?? 1} skill${(c.count ?? 1) === 1 ? '' : 's'}`;
    case 'send_invite': return truncate(c.note) || (c.ai ? 'AI-drafted note (needs approval)' : 'Invitation without a note');
    case 'wait_connection': { const st = Array.isArray(c.subtasks) ? c.subtasks.length : 0; return `Up to ${c.window_days ?? 14} days${st ? ` · ${st} subtask${st === 1 ? '' : 's'}` : ''}`; }
    case 'withdraw_invite': return 'Withdraw the pending invitation';
    case 'send_message': return truncate(c.text) || (c.ai ? 'AI-drafted message (needs approval)' : 'No message text');
    case 'send_inmail': return truncate(c.subject) || truncate(c.text) || `InMail (${c.api || 'classic'})`;
    case 'send_email': return `${truncate(c.subject, 40) || 'No subject'} · to ${c.to || 'any'} email`;
    case 'delay': return formatDelay(c as NodeDelay) || 'No delay';
    case 'condition': { const n = Array.isArray(c.rules) ? c.rules.length : 0; return `${n} rule${n === 1 ? '' : 's'} · match ${c.match || 'all'}`; }
    case 'rotate_sender': return `Restart from ${nodeTitle(nodes[c.restart_from])} · max ${c.max_rotations ?? 2} rotations`;
    case 'change_sender': return c.sender_id && c.sender_id !== 'next_in_pool' ? senderName(lookup.senders?.find((s) => s.id === c.sender_id)) : 'Next sender in pool';
    case 'add_tag':
    case 'remove_tag': return lookup.tags?.find((t) => t.id === c.tag_id)?.name || 'No tag selected';
    case 'change_list': return lookup.lists?.find((l) => l.id === c.list_id)?.name || 'No list selected';
    case 'change_stage': return lookup.stages?.find((s) => s.id === c.stage_id)?.name || 'No stage selected';
    case 'call_webhook': { const w = lookup.webhooks?.find((x) => x.id === c.webhook_id); return w ? truncate(w.url, 50) : 'No webhook selected'; }
    case 'call_api': return c.url ? `${c.method || 'POST'} ${truncate(c.url, 45)}` : 'No URL';
    case 'send_to_sequence': return lookup.sequences?.find((s) => s.id === c.sequence_id)?.name || 'No sequence selected';
    case 'manual_task': return truncate(c.title) || 'Untitled task';
    case 'ai_draft_approval': return `${c.kind || 'message'}${c.brief ? ` · ${truncate(c.brief, 40)}` : ''}`;
    default: return '';
  }
}

/**
 * True when the step leaves through the top-level `next`. Steps whose exits come from their config
 * (A/B split, AI routing) always use `branches`, even with a single branch left.
 */
export function usesNext(n: GraphNode): boolean {
  return nodeExits(n).length === 1 && !NODE_CATALOG[n.type]?.dynamicExits;
}

export function cloneGraph(g: Graph): Graph {
  return JSON.parse(JSON.stringify(g)) as Graph;
}

/** Point `source`'s exit `handle` at `target` (replacing any previous target). */
export function connectNodes(g: Graph, source: string, handle: string, target: string): Graph {
  const next = cloneGraph(g);
  const n = next.nodes[source];
  if (!n || !next.nodes[target] || source === target) return g;
  const exits = nodeExits(n);
  if (exits.length === 0) return g;
  if (usesNext(n)) { n.next = target; }
  else { n.branches = { ...(n.branches ?? {}), [exits.includes(handle) ? handle : exits[0]]: target }; }
  return next;
}

export function disconnectNodes(g: Graph, source: string, handle: string): Graph {
  const next = cloneGraph(g);
  const n = next.nodes[source];
  if (!n) return g;
  if (usesNext(n)) n.next = null;
  else if (n.branches && handle in n.branches) n.branches[handle] = null;
  // a fallback that only lives in the top-level `next` (step made outside the builder): record the cut in branches,
  // normalizeGraph then clears `next` when the graph is saved
  else if (handle === 'next' && n.next && nodeExits(n).includes('next')) { n.branches = { ...(n.branches ?? {}), next: null }; n.next = null; }
  return next;
}

/** Remove a node and every reference to it. */
export function removeNode(g: Graph, id: string): Graph {
  if (id === g.start) return g;
  const next = cloneGraph(g);
  delete next.nodes[id];
  for (const n of Object.values(next.nodes)) {
    if (n.next === id) n.next = null;
    if (n.branches) for (const b of Object.keys(n.branches)) if (n.branches[b] === id) n.branches[b] = null;
    if (n.type === 'rotate_sender' && n.config?.restart_from === id) n.config = { ...n.config, restart_from: '' };
  }
  return next;
}

export function addNode(g: Graph, type: NodeType, position: { x: number; y: number }): { graph: Graph; node: GraphNode } {
  const next = cloneGraph(g);
  let node = newNode(type, position);
  while (next.nodes[node.id]) node = newNode(type, position);
  next.nodes[node.id] = node;
  return { graph: next, node };
}

export function duplicateNode(g: Graph, id: string): { graph: Graph; node: GraphNode } | null {
  const src = g.nodes[id];
  if (!src || src.type === 'start') return null;
  const next = cloneGraph(g);
  let fresh = newNode(src.type, { x: src.position.x + 40, y: src.position.y + 60 });
  while (next.nodes[fresh.id]) fresh = newNode(src.type, fresh.position);
  const copy: GraphNode = { ...JSON.parse(JSON.stringify(src)), id: fresh.id, position: fresh.position };
  if ('next' in copy) copy.next = null;
  if (copy.branches) copy.branches = Object.fromEntries(Object.keys(copy.branches).map((k) => [k, null]));
  next.nodes[copy.id] = copy;
  return { graph: next, node: copy };
}

export function updateNode(g: Graph, node: GraphNode): Graph {
  const next = cloneGraph(g);
  next.nodes[node.id] = JSON.parse(JSON.stringify(node));
  return next;
}

export function moveNodes(g: Graph, positions: Record<string, { x: number; y: number }>): Graph {
  const next = cloneGraph(g);
  let changed = false;
  for (const [id, p] of Object.entries(positions)) {
    const n = next.nodes[id];
    if (!n) continue;
    const x = Math.round(p.x), y = Math.round(p.y);
    if (n.position.x !== x || n.position.y !== y) { n.position = { x, y }; changed = true; }
  }
  return changed ? next : g;
}

function outgoing(n: GraphNode): string[] {
  const out: string[] = [];
  if (n.next) out.push(n.next);
  for (const t of Object.values(n.branches ?? {})) if (t) out.push(t);
  return out;
}

/** Simple left-to-right layered layout (BFS levels from start; unreachable nodes appended). */
export function autoLayout(g: Graph): Graph {
  const next = cloneGraph(g);
  const level = new Map<string, number>();
  const order: string[] = [];
  const queue: string[] = next.nodes[next.start] ? [next.start] : [];
  level.set(next.start, 0);
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    const n = next.nodes[cur];
    if (!n) continue;
    for (const t of outgoing(n)) {
      if (!next.nodes[t] || level.has(t)) continue;
      level.set(t, (level.get(cur) ?? 0) + 1);
      queue.push(t);
    }
  }
  let maxLevel = 0;
  for (const l of level.values()) maxLevel = Math.max(maxLevel, l);
  const unreachable = Object.keys(next.nodes).filter((id) => !level.has(id)).sort();
  unreachable.forEach((id, i) => { level.set(id, maxLevel + 1 + Math.floor(i / 4)); order.push(id); });
  const rows = new Map<number, number>();
  for (const id of order) {
    const l = level.get(id) ?? 0;
    const row = rows.get(l) ?? 0;
    rows.set(l, row + 1);
    next.nodes[id].position = { x: 60 + l * LAYOUT_X, y: 60 + row * LAYOUT_Y };
  }
  return next;
}

export function nodeSignature(n: GraphNode): string {
  const { position: _p, ...rest } = n;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

export function diffGraphs(base: Graph, other: Graph): { added: string[]; removed: string[]; changed: string[] } {
  const a = base.nodes, b = other.nodes;
  const added = Object.keys(b).filter((k) => !a[k]);
  const removed = Object.keys(a).filter((k) => !b[k]);
  const changed = Object.keys(b).filter((k) => a[k] && nodeSignature(a[k]) !== nodeSignature(b[k]));
  return { added, removed, changed };
}

/** Make E_GRAPH_INVALID payloads (JSON arrays of issues) human-readable. */
export function formatGraphError(e: unknown): string {
  const err = parseError(e);
  if (err.code === 'E_GRAPH_INVALID') {
    try {
      const arr = JSON.parse(err.message);
      if (Array.isArray(arr)) return `Graph invalid: ${arr.map((i: any) => (i.node_id ? `${i.node_id}: ` : '') + (i.message ?? i.code)).join('; ')}`;
    } catch { /* not json */ }
    return `Graph invalid: ${err.message}`;
  }
  return err.message;
}

export function nodeCount(g: Graph | null | undefined): number {
  return g ? Object.keys(g.nodes ?? {}).length : 0;
}

export function isTerminal(node: GraphNode): boolean {
  return nodeExits(node).length === 0;
}

export function poolSummary(pool: string[], senders: Sender[]): { ok: Sender[]; notOk: Sender[]; missing: number } {
  const ok: Sender[] = [], notOk: Sender[] = [];
  let missing = 0;
  for (const id of pool) {
    const s = senders.find((x) => x.id === id);
    if (!s) { missing++; continue; }
    (s.status === 'ok' ? ok : notOk).push(s);
  }
  return { ok, notOk, missing };
}
