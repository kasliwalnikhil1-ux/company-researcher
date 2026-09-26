// Pure helpers for the sequence builder: graph mutations, layout, summaries, diffs.
import type { Graph, GraphNode, List, NodeDelay, NodeType, OutboundWebhook, Sender, Sequence, SequenceStatus, Stage, Tag } from '@/lib/outreach/types';
import { CONSENT_BASIS_LABELS, NODE_CATALOG, newNode, nodeExits } from '@/lib/outreach/nodes';
import { PROVIDER_LABELS } from '@/components/outreach/senders/helpers';
import { parseError } from '@/lib/outreach/api';
import { humanizeIssue } from '@/lib/outreach/graph';

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
/** Tree layout: one column per branch, one row per step (HeyReach-style, top to bottom). */
export const COL_W = NODE_W + 72;
export const ROW_H = 200;

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
    case 'end': return c.reason ? `Reason: ${truncate(c.reason, 50)}` : 'The sequence ends here for this lead';
    case 'visit_profile': return c.notify === false ? 'Silent visit' : 'Visit and notify the lead';
    case 'like_latest_post': return `${c.reaction || 'like'} · posts newer than ${c.max_age_days ?? 90}d`;
    case 'comment_latest_post': return truncate(c.text) || (c.ai ? 'AI-drafted comment (needs approval)' : 'No comment text');
    case 'endorse_skills': return `Endorse ${c.count ?? 1} skill${(c.count ?? 1) === 1 ? '' : 's'}`;
    case 'send_invite': return truncate(c.note) || (c.ai ? 'AI-drafted note (needs approval)' : 'Invitation without a note');
    case 'wait_connection': { const st = Array.isArray(c.subtasks) ? c.subtasks.length : 0; return `Up to ${c.window_days ?? 14} days${st ? ` · ${st} subtask${st === 1 ? '' : 's'}` : ''}`; }
    case 'withdraw_invite': return 'Withdraw the pending invitation';
    case 'send_message': {
      const text = truncate(c.text) || (c.ai ? 'AI-drafted message (needs approval)' : 'No message text');
      return c.channel && PROVIDER_LABELS[c.channel as keyof typeof PROVIDER_LABELS] ? `${PROVIDER_LABELS[c.channel as keyof typeof PROVIDER_LABELS]} · ${text}` : text;
    }
    case 'send_voice_note': return c.channel && PROVIDER_LABELS[c.channel as keyof typeof PROVIDER_LABELS] ? `Voice note on ${PROVIDER_LABELS[c.channel as keyof typeof PROVIDER_LABELS]}` : 'One recorded clip per sender';
    // channels
    case 'follow': return 'Follow the lead on Instagram';
    case 'unfollow': return 'Stop following the lead';
    case 'like_recent_posts': { const n = Math.min(3, Math.max(1, Number(c.count) || 1)); return `Like ${n} recent post${n === 1 ? '' : 's'} · newer than ${c.max_age_days ?? 60}d`; }
    case 'comment_post': return truncate(c.text) || (c.ai ? 'AI-drafted comment (needs approval)' : 'No comment text');
    case 'wait_follow_back': return `Up to ${c.window_days ?? 5} days`;
    case 'check_identifier': return 'Is the number on WhatsApp?';
    case 'require_consent': { const bases: string[] = Array.isArray(c.bases) ? c.bases : []; return bases.length ? bases.map((b) => CONSENT_BASIS_LABELS[b as keyof typeof CONSENT_BASIS_LABELS] ?? b).join(', ') : 'Any recorded consent'; }
    case 'wait_for_reply': { const h = Number(c.window_hours) || 96; return h % 24 === 0 ? `Up to ${h / 24} day${h === 24 ? '' : 's'}` : `Up to ${h} hour${h === 1 ? '' : 's'}`; }
    case 'channel_switch': return `Carry on with the lead on ${PROVIDER_LABELS[c.to_channel as keyof typeof PROVIDER_LABELS] ?? c.to_channel ?? '…'}`;
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

// ---------------------------------------------------------------------------
// Exits: tone + "add here" insertion
// ---------------------------------------------------------------------------
export type ExitTone = 'positive' | 'negative' | 'neutral';
const POSITIVE_EXITS = new Set(['true', 'connected', 'found', 'followed_back', 'has_consent', 'valid', 'replied']);
const NEGATIVE_EXITS = new Set(['false', 'no_connect', 'error', 'bounced', 'no_credit', 'no_email', 'not_found', 'wrong_number', 'no_follow_back', 'no_consent', 'invalid', 'no_reply', 'no_chat', 'unavailable']);

/** How a branch pill is coloured: the success path green, the failure path red, everything else neutral. */
export function exitTone(exit: string): ExitTone {
  if (POSITIVE_EXITS.has(exit)) return 'positive';
  if (NEGATIVE_EXITS.has(exit)) return 'negative';
  return 'neutral';
}

/** Exits of `n` with no (existing) step connected: the ones that get an "add step" button. */
export function openExits(n: GraphNode, nodes: Record<string, GraphNode>): string[] {
  const exits = nodeExits(n);
  if (exits.length === 0) return [];
  if (usesNext(n)) return n.next && nodes[n.next] ? [] : [exits[0]];
  return exits.filter((e) => {
    // a call task made outside the builder keeps its fallback in the top-level `next`
    const t = n.branches && e in n.branches ? n.branches[e] : e === 'next' ? n.next : null;
    return !(t && nodes[t]);
  });
}

/** The exit that carries on the main path when a step is inserted into an existing line. */
export function primaryExit(n: GraphNode): string | null {
  const exits = nodeExits(n);
  if (exits.length === 0) return null;
  if (exits.includes('next')) return 'next';
  return exits.find((e) => exitTone(e) === 'positive') ?? exits[0];
}

/**
 * Add a step on exit `handle` of `source` and wire it in: the "+" button on a line / dangling branch.
 * With a `target` (the exit already leads somewhere) the new step goes between the two and keeps the old
 * target on its primary exit. The tree is laid out again afterwards, so positions never need a hand.
 */
export function insertNode(g: Graph, type: NodeType, source: string, handle: string, target: string | null): { graph: Graph; node: GraphNode } | null {
  const src = g.nodes[source];
  if (!src) return null;
  const exits = nodeExits(src);
  if (exits.length === 0) return null;
  const exit = exits.includes(handle) ? handle : exits[0];
  const tgt = target ? g.nodes[target] ?? null : null;
  const added = addNode(g, type, { x: src.position.x, y: src.position.y + ROW_H });
  let out = connectNodes(added.graph, source, exit, added.node.id);
  if (tgt) {
    const onward = primaryExit(added.node);
    if (onward) out = connectNodes(out, added.node.id, onward, tgt.id);
  }
  out = autoLayout(out);
  return { graph: out, node: out.nodes[added.node.id] };
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

// ---------------------------------------------------------------------------
// Layout: a top-to-bottom tree (start at the top, every branch fans out below its step)
// ---------------------------------------------------------------------------
/** Steps this one leads to, in exit order, each once. */
function childrenOf(n: GraphNode): string[] {
  const out: string[] = [];
  const push = (t: string | null | undefined) => { if (t && !out.includes(t)) out.push(t); };
  if (usesNext(n)) push(n.next);
  else for (const e of nodeExits(n)) push(n.branches && e in n.branches ? n.branches[e] : e === 'next' ? n.next : null);
  return out;
}

/**
 * Where every step sits. Columns come from a depth-first walk (each step is centred over the steps under it,
 * branches side by side in exit order), rows from the longest path down from the start, so a step two branches
 * join into sits below both. Steps not reachable from the start line up in a row at the bottom.
 */
export function layoutPositions(g: Graph): Record<string, { x: number; y: number }> {
  const nodes = g.nodes;
  const kids = new Map<string, string[]>();
  const treeDepth = new Map<string, number>();
  const visit = (id: string, d: number) => {
    treeDepth.set(id, d);
    const own: string[] = [];
    for (const c of childrenOf(nodes[id])) if (nodes[c] && !treeDepth.has(c)) { own.push(c); visit(c, d + 1); }
    kids.set(id, own);
  };
  if (nodes[g.start]) visit(g.start, 0);

  // rows: longest path from the start; steps caught in a loop keep their walk depth
  const reach = Array.from(treeDepth.keys());
  const indeg = new Map<string, number>(reach.map((id) => [id, 0]));
  for (const u of reach) for (const v of childrenOf(nodes[u])) if (indeg.has(v)) indeg.set(v, (indeg.get(v) ?? 0) + 1);
  const depth = new Map<string, number>();
  const queue = reach.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (const id of queue) depth.set(id, treeDepth.get(id) ?? 0);
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of childrenOf(nodes[u])) {
      if (!indeg.has(v)) continue;
      depth.set(v, Math.max(depth.get(v) ?? 0, (depth.get(u) ?? 0) + 1));
      indeg.set(v, (indeg.get(v) ?? 0) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  for (const id of reach) if (!depth.has(id)) depth.set(id, treeDepth.get(id) ?? 0);

  // columns: a step is as wide as everything under it
  const width = new Map<string, number>();
  const measure = (id: string): number => {
    const w = Math.max(1, (kids.get(id) ?? []).reduce((s, c) => s + measure(c), 0));
    width.set(id, w);
    return w;
  };
  if (nodes[g.start]) measure(g.start);

  const pos: Record<string, { x: number; y: number }> = {};
  const place = (id: string, left: number) => {
    const w = width.get(id) ?? 1;
    pos[id] = { x: Math.round(left + (w * COL_W) / 2 - NODE_W / 2), y: (depth.get(id) ?? 0) * ROW_H };
    let cursor = left;
    for (const c of kids.get(id) ?? []) { place(c, cursor); cursor += (width.get(c) ?? 1) * COL_W; }
  };
  if (nodes[g.start]) place(g.start, 0);

  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  const loose = Object.keys(nodes).filter((id) => !pos[id]).sort();
  loose.forEach((id, i) => { pos[id] = { x: i * COL_W, y: (maxDepth + 2) * ROW_H }; });
  return pos;
}

/** Store the tree layout in the graph (positions travel with the saved draft). */
export function autoLayout(g: Graph): Graph {
  const pos = layoutPositions(g);
  const next = cloneGraph(g);
  for (const [id, p] of Object.entries(pos)) if (next.nodes[id]) next.nodes[id].position = p;
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

/**
 * Turn a server-side rejection of the sequence (a JSON list of issues, or a bare code) into plain language.
 * Pass the graph so an issue can name the step instead of its id.
 */
export function formatGraphError(e: unknown, graph?: Graph | null): string {
  const err = parseError(e);
  const stepName = (id: unknown) => (typeof id === 'string' ? nodeTitle(graph?.nodes?.[id]) : '') || (typeof id === 'string' ? id : '');
  if (err.code === 'E_GRAPH_INVALID') {
    try {
      const arr = JSON.parse(err.message);
      if (Array.isArray(arr)) {
        const parts = arr.map((i: { node_id?: string; message?: string; code?: string }) => (i.node_id ? `“${stepName(i.node_id)}”: ` : '') + humanizeIssue(i.message ?? i.code));
        return `The sequence cannot be saved yet. ${parts.join('. ')}.`;
      }
    } catch { /* not json */ }
    return `The sequence cannot be saved yet: ${err.message}`;
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
