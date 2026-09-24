// Client-side graph validation mirroring outreach_validate_graph() in SQL (011_engine_v2.sql). The server is authoritative.
import { z } from 'zod';
import type { AbBranch, AiRouteOption, Graph, GraphNode, MessageVariant, NodeStats, NodeType } from './types';
import { AI_ROUTE_ELSE, CALL_OUTCOMES, MAX_VARIANTS } from './types';
import { NODE_CATALOG, TEXT_LIMITS, VARIANT_TEXT_KEY, nodeExits } from './nodes';
import { spintaxInfo } from './render';

export { nodeExits, exitLabel, syncNodeBranches } from './nodes';

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

/**
 * Server-side checks (SQL, edge functions) still speak in technical terms. Translate the known ones into plain
 * language; anything unrecognised passes through untouched. Client-side messages are already plain, so this is
 * safe to apply to every issue shown in the builder.
 */
const ISSUE_TRANSLATIONS: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
  [/^graph must be an object$|^graph\.nodes missing$/i, 'The sequence could not be read. Reload the page and try again'],
  [/^start node not found$/i, 'The sequence has no start'],
  [/^unknown node type (.+)$/i, (m) => `“${m[1]}” is not a step this version supports. Remove it`],
  [/^node id mismatch$/i, 'This step is stored under the wrong name. Delete it and add it again'],
  [/^next points to missing node/i, 'This step leads to a step that no longer exists. Connect it again'],
  [/^branch (\S+) points to missing node$/i, (m) => `The “${m[1].replace(/_/g, ' ')}” branch leads to a step that no longer exists. Connect it again`],
  [/^invite note exceeds (\d+) characters$/i, (m) => `The invitation note is longer than ${m[1]} characters`],
  [/^message exceeds (\d+) characters$/i, (m) => `The message is longer than ${m[1]} characters`],
  [/^comment exceeds (\d+) characters$/i, (m) => `The comment is longer than ${m[1]} characters`],
  [/^InMail subject\/body exceeds limits/i, 'The InMail is too long: subjects can be 200 characters and the body 1,900'],
  [/^condition should define true and false branches$/i, 'Give both the “true” and “false” branches a next step'],
  [/^wait_connection needs a connected branch$/i, 'Add what happens once the lead connects (the “connected” branch)'],
  [/^email node requires a mailbox sender in the pool$/i, 'Emails need a connected mailbox. Add one to the sender pool or pick a mailbox in this step'],
  [/^AI drafting enabled without a brief$/i, 'AI drafting is on but there is no brief. Tell the AI what to write about'],
  [/^no exit path/i, 'The sequence never ends. Add an “End” step at the bottom of every branch'],
  [/^a message node needs an invite/i, 'A message can only reach connected leads. Put “Send invitation” and “Wait for connection” (or an InMail) before it'],
  [/^node is not reachable from start$/i, 'This step is not connected to the sequence, so no lead will ever reach it'],
  [/^every variant needs an id$/i, 'One of the A/B versions is missing its name. Remove it and add it again'],
  [/^duplicate variant id/i, 'Two A/B versions share the same name. Rename one of them'],
  [/^variant weight cannot be negative$/i, 'An A/B version has a share below zero. Use 0 or more'],
  [/^an A\/B test needs at least two variants$/i, 'An A/B test needs at least two versions to compare'],
  [/^at most (\d+) variants per step$/i, (m) => `A step can have at most ${m[1]} A/B versions`],
  [/^A\/B split needs at least two weighted branches$/i, 'An A/B split needs at least two paths with a share each'],
  [/^A\/B branch (\S+) is not connected$/i, (m) => `Path “${m[1]}” of the A/B split has no next step`],
  [/^AI routing needs at least one described branch$/i, 'Describe at least one path for AI routing'],
  [/^AI routing needs an "everything else" branch$/i, 'Add a next step for “everything else” (leads that match no path)'],
];

export function humanizeIssue(message: string | null | undefined): string {
  const text = (message ?? '').trim();
  if (!text) return 'Something about this step needs a fix';
  for (const [re, out] of ISSUE_TRANSLATIONS) {
    const m = text.match(re);
    if (m) return typeof out === 'function' ? out(m) : out;
  }
  // last resort: soften the jargon without changing the meaning
  return text.replace(/\bnodes?\b/g, 'step').replace(/\benrol+ments?\b/gi, 'lead').replace(/\bpayload\b/gi, 'content').replace(/\bgraph\b/gi, 'sequence');
}

const TEXT_STEPS: NodeType[] = ['send_invite', 'send_message', 'send_inmail', 'send_email', 'comment_latest_post'];
const WHAT: Partial<Record<NodeType, string>> = { send_invite: 'invite note', send_message: 'message', comment_latest_post: 'comment', send_inmail: 'InMail body' };

/** The variants of a step, or [] when it is not an A/B test. */
export function nodeVariants(n: GraphNode): MessageVariant[] {
  return Array.isArray(n.config?.variants) ? (n.config!.variants as MessageVariant[]) : [];
}

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

export function validateGraph(graph: Graph, opts: { hasFreeSender?: boolean; hasMailbox?: boolean; strict?: boolean } = {}): { errors: GraphIssue[]; warnings: GraphIssue[] } {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  const parsed = graphSchema.safeParse(graph);
  if (!parsed.success) {
    errors.push({ code: 'E_GRAPH_INVALID', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    return { errors, warnings };
  }
  const nodes = graph.nodes;
  if (!nodes[graph.start]) errors.push({ code: 'E_GRAPH_INVALID', message: 'The sequence has no start' });
  const noteLimit = opts.hasFreeSender ? TEXT_LIMITS.invite_note_free : TEXT_LIMITS.invite_note;
  let hasTerminal = false;
  let hasConnectPath = false;
  for (const [k, n] of Object.entries(nodes)) {
    if (n.id !== k) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: 'This step is stored under the wrong name. Delete it and add it again' });
    if (n.next && !nodes[n.next]) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: 'This step leads to a step that no longer exists. Connect it again' });
    for (const [b, t] of Object.entries(n.branches ?? {})) if (t && !nodes[t]) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: `The “${b.replace(/_/g, ' ')}” branch leads to a step that no longer exists. Connect it again` });
    if (n.type === 'end' || n.type === 'send_to_sequence' || (!n.next && !n.branches && n.type !== 'start')) hasTerminal = true;
    if (['send_invite', 'wait_connection', 'send_inmail'].includes(n.type)) hasConnectPath = true;
    const c = n.config ?? {};

    // every text the step can send: the base copy plus each variant; the longest spintax combination is what counts
    if (TEXT_STEPS.includes(n.type)) {
      const texts: Array<{ label: string; text: string; subject: string }> = [{ label: '', text: str(c.text) || str(c.note) || str(c.html), subject: str(c.subject) }];
      if (Array.isArray(c.variants)) {
        const ids: string[] = [];
        for (const v of c.variants as MessageVariant[]) {
          if (!v?.id) errors.push({ node_id: k, code: 'E_VARIANT_INVALID', message: 'One of the A/B versions is missing its name. Remove it and add it again' });
          else if (ids.includes(v.id)) errors.push({ node_id: k, code: 'E_VARIANT_INVALID', message: 'Two A/B versions share the same name. Rename one of them' });
          ids.push(v?.id ?? '');
          if (Number(v?.weight ?? 1) < 0) errors.push({ node_id: k, code: 'E_VARIANT_INVALID', message: 'An A/B version has a share below zero. Use 0 or more' });
          texts.push({ label: ` (variant ${v?.label || v?.id || '?'})`, text: str(v?.text) || str(v?.note) || str(v?.html), subject: str(v?.subject) });
        }
        if (c.variants.length === 1) warnings.push({ node_id: k, code: 'W_SINGLE_VARIANT', message: 'An A/B test needs at least two versions to compare' });
        if (c.variants.length > MAX_VARIANTS) errors.push({ node_id: k, code: 'E_VARIANT_INVALID', message: `A step can have at most ${MAX_VARIANTS} A/B versions` });
      }
      const lim = n.type === 'send_invite' ? noteLimit : n.type === 'send_message' ? TEXT_LIMITS.message : n.type === 'comment_latest_post' ? TEXT_LIMITS.comment : n.type === 'send_inmail' ? TEXT_LIMITS.inmail_body : null;
      for (const t of texts) {
        if (texts.length > 1 && t.label === '' && t.text === '') continue;   // variants replace an empty base copy
        const ml = spintaxInfo(t.text).maxLen;
        if (lim != null && ml > lim) {
          errors.push({ node_id: k, code: n.type === 'send_invite' ? 'E_NOTE_TOO_LONG' : 'E_PAYLOAD_INVALID', message: `The ${WHAT[n.type]}${t.label} can run to ${ml} characters. LinkedIn allows ${lim}. Shorten it (the longest spin option counts)` });
        }
        if (n.type === 'send_inmail' && spintaxInfo(t.subject).maxLen > TEXT_LIMITS.inmail_subject) errors.push({ node_id: k, code: 'E_PAYLOAD_INVALID', message: `The InMail subject${t.label} is longer than 200 characters` });
        if (n.type === 'send_email' && opts.strict && t.text !== '' && !t.text.includes('unsubscribe_link')) warnings.push({ node_id: k, code: 'W_NO_UNSUBSCRIBE', message: `The email${t.label} has no unsubscribe link. Add {{unsubscribe_link}} so people can opt out` });
      }
    }

    if (n.type === 'condition' && !(n.branches?.true !== undefined && n.branches?.false !== undefined)) warnings.push({ node_id: k, code: 'W_BRANCH_MISSING', message: 'Give both the “true” and “false” branches a next step' });
    if (n.type === 'wait_connection' && !n.branches?.connected) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: 'Add what happens once the lead connects (the “connected” branch)' });
    if (n.type === 'ab_split') {
      const list: AbBranch[] = Array.isArray(c.branches) ? c.branches : [];
      if (list.length < 2) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: 'An A/B split needs at least two paths with a share each' });
      else for (const b of list) if (!(n.branches && (b?.id ?? '') in n.branches)) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: `Path “${b?.label || b?.id || '?'}” of the A/B split has no next step` });
    }
    if (n.type === 'ai_route') {
      const list: AiRouteOption[] = Array.isArray(c.routes) ? c.routes : [];
      if (list.length < 1) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: 'Describe at least one path for AI routing' });
      else for (const r of list) if (str(r?.description).trim().length < 3) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: `Describe the “${r?.label || r?.id || '?'}” path in a sentence so AI knows when to pick it` });
      if (!(n.branches && AI_ROUTE_ELSE in n.branches)) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: 'Add a next step for “everything else” (leads that match no path)' });
    }
    if (n.type === 'call_task') {
      const dead = CALL_OUTCOMES.filter((o) => n.branches && o in n.branches && !n.branches[o]);
      if (dead.length > 0 && opts.strict) warnings.push({ node_id: k, code: 'W_CALL_OUTCOME', message: `Nothing follows the call outcome ${dead.join(', ').replace(/_/g, ' ')}. Leads with that outcome finish the sequence here` });
    }
    const hasMailboxPool = Array.isArray(c.mailbox_pool) && c.mailbox_pool.length > 0;
    if (opts.strict && n.type === 'send_email' && !opts.hasMailbox && !c.mailbox_sender_id && !hasMailboxPool) errors.push({ node_id: k, code: 'E_NO_MAILBOX', message: 'Emails need a connected mailbox. Add one to the sender pool or pick a mailbox in this step' });
    if (['send_invite', 'send_message', 'comment_latest_post', 'send_inmail'].includes(n.type) && c.ai != null && !c.ai?.brief) warnings.push({ node_id: k, code: 'W_AI_BRIEF', message: 'AI drafting is on but there is no brief. Tell the AI what to write about' });
    if (n.type === 'ai_draft_approval' && !c.brief) warnings.push({ node_id: k, code: 'W_AI_BRIEF', message: 'AI drafting is on but there is no brief. Tell the AI what to write about' });
    if (n.type === 'send_voice_note' && opts.strict) warnings.push({ node_id: k, code: 'W_VOICE_CLIP', message: 'Every sender in the pool needs a recorded clip for this step. Senders without one skip it' });
    if (['add_tag', 'remove_tag'].includes(n.type) && !c.tag_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'Choose which tag' });
    if (n.type === 'change_list' && !c.list_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'Choose which list' });
    if (n.type === 'change_stage' && !c.stage_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'Choose which stage' });
    if (n.type === 'send_to_sequence' && !c.sequence_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'Choose which sequence' });
    if (n.type === 'call_webhook' && !c.webhook_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'Choose which webhook' });
  }
  if (opts.strict) {
    if (!hasTerminal) errors.push({ code: 'E_GRAPH_INVALID', message: 'The sequence never ends. Add an “End” step at the bottom of every branch' });
    const hasMsg = Object.values(nodes).some((n) => (n.type === 'send_message' || n.type === 'send_voice_note') && !n.config?.send_always);
    if (hasMsg && !hasConnectPath) errors.push({ code: 'E_RELATION_REQUIRED', message: 'A message can only reach connected leads. Put “Send invitation” and “Wait for connection” (or an InMail) before it' });
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
    for (const k of Object.keys(nodes)) if (!seen.has(k)) warnings.push({ node_id: k, code: 'W_UNREACHABLE', message: 'This step is not connected to the sequence, so no lead will ever reach it' });
  }
  return { errors, warnings };
}

export function graphEdges(graph: Graph): Array<{ id: string; source: string; target: string; label: string }> {
  const edges: Array<{ id: string; source: string; target: string; label: string }> = [];
  for (const n of Object.values(graph.nodes)) {
    const viaBranch = n.type === 'call_task' ? n.branches?.next : undefined;   // the builder mirrors the fallback into branches.next
    if (n.next && n.next !== viaBranch) edges.push({ id: `${n.id}-next-${n.next}`, source: n.id, target: n.next, label: 'next' });
    for (const [b, t] of Object.entries(n.branches ?? {})) if (t) edges.push({ id: `${n.id}-${b}-${t}`, source: n.id, target: t, label: b });
  }
  return edges;
}

/**
 * Make a call task match what the engine reads (outreach_advance_enrollment):
 *  - the fallback exit is the top-level `next`; the canvas stores it as branches.next, so mirror it;
 *  - an outcome key that exists with no target ENDS the sequence for that lead instead of falling back, so drop empty outcome keys.
 * Idempotent, returns the same object when nothing changes.
 */
export function normalizeNode(n: GraphNode): GraphNode {
  if (n.type !== 'call_task') return n;
  const branches = { ...(n.branches ?? {}) };
  let changed = false;
  for (const o of CALL_OUTCOMES) if (o in branches && !branches[o]) { delete branches[o]; changed = true; }
  const fallback = 'next' in branches ? branches.next ?? null : n.next ?? null;
  if ((n.next ?? null) !== fallback) changed = true;
  if (!changed) return n;
  return { ...n, next: fallback, branches };
}

/** Run before saving / publishing a graph. WEB-BUILDER: call this on the draft graph in the save path. */
export function normalizeGraph(graph: Graph): Graph {
  let changed = false;
  const nodes: Record<string, GraphNode> = {};
  for (const [k, n] of Object.entries(graph.nodes)) {
    const m = normalizeNode(n);
    if (m !== n) changed = true;
    nodes[k] = m;
  }
  return changed ? { ...graph, nodes } : graph;
}

/** outreach_node_stats has one row per (node, variant): sum them for the canvas badges. */
export function sumNodeStats(rows: NodeStats[] | null | undefined): Record<string, Omit<NodeStats, 'variant_id'>> {
  const out: Record<string, Omit<NodeStats, 'variant_id'>> = {};
  for (const r of rows ?? []) {
    const cur = out[r.node_id] ?? (out[r.node_id] = { sequence_id: r.sequence_id, node_id: r.node_id, queued: 0, sent: 0, failed: 0, skipped: 0, accepted: 0, replied: 0, interested: 0 });
    cur.queued += r.queued ?? 0; cur.sent += r.sent ?? 0; cur.failed += r.failed ?? 0; cur.skipped += r.skipped ?? 0;
    cur.accepted += r.accepted ?? 0; cur.replied += r.replied ?? 0; cur.interested += r.interested ?? 0;
  }
  return out;
}

/** The {{ai.<key>}} variables a graph uses (mirror of outreach_sequence_ai_keys). */
export function sequenceAiKeys(graph: Graph | null | undefined): string[] {
  const out = new Set<string>();
  const re = /\{\{\s*ai\.([a-z][a-z0-9_]*)/g;
  const text = JSON.stringify(graph ?? {});
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}

/** Steps that can run an A/B test on their copy. */
export function supportsVariants(type: NodeType): boolean {
  return type in VARIANT_TEXT_KEY;
}

/** True when any exit of the node is wired to a step. */
export function hasOutgoing(n: GraphNode): boolean {
  if (n.next) return true;
  return nodeExits(n).some((e) => !!n.branches?.[e]);
}
