// Client-side graph validation mirroring outreach_validate_graph() in SQL (the server is authoritative).
import { z } from 'zod';
import type { Graph, GraphNode, NodeType } from './types';
import { NODE_CATALOG, TEXT_LIMITS } from './nodes';

export const nodeTypeSchema = z.enum(Object.keys(NODE_CATALOG) as [NodeType, ...NodeType[]]);

export const graphNodeSchema = z.object({
  id: z.string().min(1),
  type: nodeTypeSchema,
  label: z.string().optional(),
  config: z.record(z.any()).optional(),
  delay: z.object({ amount: z.number().min(0), unit: z.enum(['minutes', 'hours', 'days']), jitter_pct: z.number().min(0).max(100).optional() }).optional(),
  mode: z.enum(['auto', 'manual']).optional(),
  next: z.string().nullable().optional(),
  branches: z.record(z.string().nullable()).optional(),
  position: z.object({ x: z.number(), y: z.number() }),
});

export const graphSchema = z.object({
  version: z.literal(1),
  start: z.string(),
  nodes: z.record(graphNodeSchema),
});

export interface GraphIssue { node_id?: string; code: string; message: string }

export function validateGraph(graph: Graph, opts: { hasFreeSender?: boolean; hasMailbox?: boolean; strict?: boolean } = {}): { errors: GraphIssue[]; warnings: GraphIssue[] } {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  const parsed = graphSchema.safeParse(graph);
  if (!parsed.success) {
    errors.push({ code: 'E_GRAPH_INVALID', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return { errors, warnings };
  }
  const nodes = graph.nodes;
  if (!nodes[graph.start]) errors.push({ code: 'E_GRAPH_INVALID', message: 'start node not found' });
  const noteLimit = opts.hasFreeSender ? TEXT_LIMITS.invite_note_free : TEXT_LIMITS.invite_note;
  let hasTerminal = false;
  let hasConnectPath = false;
  for (const [k, n] of Object.entries(nodes)) {
    if (n.id !== k) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: 'node id mismatch' });
    if (n.next && !nodes[n.next]) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: `next points to missing node ${n.next}` });
    for (const [b, t] of Object.entries(n.branches ?? {})) if (t && !nodes[t]) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: `branch ${b} points to missing node` });
    const meta = NODE_CATALOG[n.type];
    if (n.type === 'end' || n.type === 'send_to_sequence' || (meta.exits.length === 1 && !n.next && n.type !== 'start')) hasTerminal = true;
    if (['send_invite', 'wait_connection', 'send_inmail'].includes(n.type)) hasConnectPath = true;
    const c = n.config ?? {};
    if (n.type === 'send_invite' && (c.note?.length ?? 0) > noteLimit) errors.push({ node_id: k, code: 'E_NOTE_TOO_LONG', message: `invite note exceeds ${noteLimit} characters` });
    if (n.type === 'send_message' && (c.text?.length ?? 0) > TEXT_LIMITS.message) errors.push({ node_id: k, code: 'E_PAYLOAD_INVALID', message: 'message exceeds 8000 characters' });
    if (n.type === 'comment_latest_post' && (c.text?.length ?? 0) > TEXT_LIMITS.comment) errors.push({ node_id: k, code: 'E_PAYLOAD_INVALID', message: 'comment exceeds 1250 characters' });
    if (n.type === 'send_inmail' && ((c.subject?.length ?? 0) > TEXT_LIMITS.inmail_subject || (c.text?.length ?? 0) > TEXT_LIMITS.inmail_body)) errors.push({ node_id: k, code: 'E_PAYLOAD_INVALID', message: 'InMail subject/body exceeds limits (200/1900)' });
    if (n.type === 'condition' && !(n.branches?.true !== undefined && n.branches?.false !== undefined)) warnings.push({ node_id: k, code: 'W_BRANCH_MISSING', message: 'condition should define true and false branches' });
    if (n.type === 'wait_connection' && !n.branches?.connected) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: 'wait_connection needs a connected branch' });
    if (opts.strict && n.type === 'send_email' && !opts.hasMailbox && !c.mailbox_sender_id) errors.push({ node_id: k, code: 'E_NO_MAILBOX', message: 'email node requires a mailbox sender in the pool' });
    if (n.type === 'ai_draft_approval' && !c.brief) warnings.push({ node_id: k, code: 'W_AI_BRIEF', message: 'AI drafting enabled without a brief' });
    if (['add_tag', 'remove_tag'].includes(n.type) && !c.tag_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'select a tag' });
    if (n.type === 'change_list' && !c.list_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'select a list' });
    if (n.type === 'change_stage' && !c.stage_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'select a stage' });
    if (n.type === 'send_to_sequence' && !c.sequence_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'select a sequence' });
    if (n.type === 'call_webhook' && !c.webhook_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'select a webhook' });
  }
  if (opts.strict) {
    if (!hasTerminal) errors.push({ code: 'E_GRAPH_INVALID', message: 'no exit path (add an End node)' });
    const hasMsg = Object.values(nodes).some((n) => n.type === 'send_message' && !n.config?.send_always);
    if (hasMsg && !hasConnectPath) errors.push({ code: 'E_RELATION_REQUIRED', message: 'a message node needs an invite / wait_connection (or InMail) path before it' });
    // reachability
    const seen = new Set<string>();
    const q = [graph.start];
    while (q.length) {
      const cur = q.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const n = nodes[cur];
      if (!n) continue;
      if (n.next) q.push(n.next);
      for (const t of Object.values(n.branches ?? {})) if (t) q.push(t);
    }
    for (const k of Object.keys(nodes)) if (!seen.has(k)) warnings.push({ node_id: k, code: 'W_UNREACHABLE', message: 'node is not reachable from start' });
  }
  return { errors, warnings };
}

export function nodeExits(n: GraphNode): string[] {
  return NODE_CATALOG[n.type]?.exits ?? [];
}

export function graphEdges(graph: Graph): Array<{ id: string; source: string; target: string; label: string }> {
  const edges: Array<{ id: string; source: string; target: string; label: string }> = [];
  for (const n of Object.values(graph.nodes)) {
    if (n.next) edges.push({ id: `${n.id}-next-${n.next}`, source: n.id, target: n.next, label: 'next' });
    for (const [b, t] of Object.entries(n.branches ?? {})) if (t) edges.push({ id: `${n.id}-${b}-${t}`, source: n.id, target: t, label: b });
  }
  return edges;
}
