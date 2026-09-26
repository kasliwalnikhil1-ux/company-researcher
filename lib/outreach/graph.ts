// Client-side graph validation mirroring outreach_validate_graph() in SQL (011_engine_v2.sql). The server is authoritative.
import { z } from 'zod';
import type { AbBranch, AiRouteOption, ConditionRule, Graph, GraphNode, MessageVariant, NodeStats, NodeType, Provider } from './types';
import { AI_ROUTE_ELSE, CALL_OUTCOMES, CHANNEL_PROVIDERS, MAX_VARIANTS } from './types';
import { EXECUTABLE_TYPES, MESSAGE_TYPES, NODE_CATALOG, TEXT_LIMITS, VARIANT_TEXT_KEY, WAIT_TYPES, messageTextLimit, nodeChannels, nodeExits } from './nodes';
import { spintaxInfo } from './render';

export { nodeExits, exitLabel, syncNodeBranches } from './nodes';

/** A comment that sells instead of engaging. Instagram comments are public, so the validator warns (W_IG_COMMENT_PITCH). */
export const PITCH_RE = /(book a|demo|pricing|our (product|platform|tool)|sign up|free trial|dm me|link in bio)/i;

/**
 * The plain sentences for the channel validator codes (docs/outreach/CHANNELS-BUILD-CONTRACT.md §3). The SQL validator
 * (026_channels_functions.sql) and the connector emit these same sentences, so nothing needs translating; a bare code
 * (or `CODE: detail`) coming from the server maps to them as well (see humanizeIssue). Keys with a `:PROVIDER` suffix
 * are the per-channel wording of a code.
 */
export const CHANNEL_ISSUE_TEXT: Record<string, string> = {
  W_IG_DM_FIRST: 'The first Instagram step is a message. A follow and a like first get several times more replies',
  E_NO_CONSENT_GUARD: 'A WhatsApp message needs a “Check consent” step before it: WhatsApp messages only go to people who agreed to hear from you',
  E_LIKE_COUNT: 'Like between 1 and 3 recent posts in one step: each like is one of the 10 actions an Instagram account can do per hour',
  'E_NO_CHANNEL_SENDER:LINKEDIN': 'This step needs a LinkedIn account in the sender pool',
  'E_NO_CHANNEL_SENDER:INSTAGRAM': 'This step needs an Instagram account in the sender pool',
  'E_NO_CHANNEL_SENDER:WHATSAPP': 'This step needs a WhatsApp number in the sender pool',
  E_NO_CHANNEL_SENDER: 'This step needs a LinkedIn, Instagram or WhatsApp account in the sender pool',
  E_QUIET_PERIOD: 'Every WhatsApp number in the pool connected recently and is still in its 24-hour quiet period. Activate the sequence once it ends',
  E_HOURLY_DEMAND: 'More than 10 Instagram actions in a row with no wait between them. An Instagram account can do 10 actions per hour: add a delay',
  'W_SWITCH_NO_IDENTITY:LINKEDIN': 'Nothing before this step can learn the lead’s LinkedIn profile. Leads without one on file take the “unavailable” exit',
  'W_SWITCH_NO_IDENTITY:INSTAGRAM': 'Nothing before this step can learn the lead’s Instagram handle. Leads without one on file take the “unavailable” exit',
  'W_SWITCH_NO_IDENTITY:WHATSAPP': 'Nothing before this step can learn the lead’s WhatsApp number. Leads without one on file take the “unavailable” exit',
  W_SWITCH_NO_IDENTITY: 'Nothing before this step can learn the lead’s handle or number for that channel. Leads without one on file take the “unavailable” exit',
  W_WA_ATTESTED_ONLY: 'This consent check only accepts consent attested at import, the weakest basis. Prefer people who messaged first, opted in or shared their number',
  W_CHANNEL_INDEPENDENT: 'A reply on one channel will not stop this lead on the others, so two accounts can end up talking to the same person at once',
  W_IG_COMMENT_PITCH: 'This comment reads like a pitch. Instagram comments are public: keep them about their post, not your offer',
};

/** The sentence for a channel code, in its per-channel wording when there is one. */
export function channelIssueText(code: string, provider?: Provider | null): string {
  return (provider && CHANNEL_ISSUE_TEXT[`${code}:${provider}`]) || CHANNEL_ISSUE_TEXT[code] || code;
}

const providerIn = (s: string | undefined): Provider | undefined => s?.match(/linkedin|instagram|whatsapp/i)?.[0].toUpperCase() as Provider | undefined;

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
  // channel checks (CHANNEL_ISSUE_TEXT): the server sends the same sentences; these catch a technical phrasing of them
  [/^(?:the )?first (?:executable )?(?:instagram )?(?:step|node|action) (?:on an? instagram path )?is an? (?:send_message|message|dm)/i, CHANNEL_ISSUE_TEXT.W_IG_DM_FIRST],
  [/require_consent|consent (?:guard|ancestor)|without (?:a )?consent/i, CHANNEL_ISSUE_TEXT.E_NO_CONSENT_GUARD],
  [/like[_ ]?count|count (?:>|exceeds|above|more than) ?3|more than (?:3|three) (?:likes|posts)/i, CHANNEL_ISSUE_TEXT.E_LIKE_COUNT],
  [/(?:no|needs? an?|without an?) (linkedin|instagram|whatsapp) (?:sender|account|number)/i, (m) => channelIssueText('E_NO_CHANNEL_SENDER', providerIn(m[1]))],
  [/quiet period/i, CHANNEL_ISSUE_TEXT.E_QUIET_PERIOD],
  [/hourly (?:demand|ceiling|cap|limit)|per.hour (?:demand|ceiling|limit)|consecutive/i, CHANNEL_ISSUE_TEXT.E_HOURLY_DEMAND],
  [/identity source|no identity/i, (m) => channelIssueText('W_SWITCH_NO_IDENTITY', providerIn(m.input))],
  [/imported_attested|attested only/i, CHANNEL_ISSUE_TEXT.W_WA_ATTESTED_ONLY],
  [/channel.independent/i, CHANNEL_ISSUE_TEXT.W_CHANNEL_INDEPENDENT],
  [/comment.*pitch|pitch.*comment/i, CHANNEL_ISSUE_TEXT.W_IG_COMMENT_PITCH],
];

const CANONICAL_SENTENCES = new Set(Object.values(CHANNEL_ISSUE_TEXT));

export function humanizeIssue(message: string | null | undefined): string {
  const text = (message ?? '').trim();
  if (!text) return 'Something about this step needs a fix';
  if (CANONICAL_SENTENCES.has(text)) return text;
  // a bare channel code, or `CODE: detail`, from the server or the connector
  const coded = text.match(/^([EW]_[A-Z_]+)(?::\s*(.*))?$/);
  if (coded) {
    const code = coded[1] === 'E_SWITCH_NO_IDENTITY' ? 'W_SWITCH_NO_IDENTITY' : coded[1];
    const known = channelIssueText(code, providerIn(coded[2]));
    if (known !== code) return known;
  }
  for (const [re, out] of ISSUE_TRANSLATIONS) {
    const m = text.match(re);
    if (m) return typeof out === 'function' ? out(m) : out;
  }
  // last resort: soften the jargon without changing the meaning
  return text.replace(/\bnodes?\b/g, 'step').replace(/\benrol+ments?\b/gi, 'lead').replace(/\bpayload\b/gi, 'content').replace(/\bgraph\b/gi, 'sequence');
}

export type ConnectionFact = 'connected' | 'not_connected';

/** What one condition rule tells us when it holds (`t`) or fails (`f`). Only connection facts are of interest here. */
function ruleFacts(r: ConditionRule | null | undefined): { t: ConnectionFact | null; f: ConnectionFact | null } {
  if (!r || typeof r !== 'object') return { t: null, f: null };
  const v = String(r.value ?? '');
  if (r.field === 'relation') {
    if (r.op === 'eq' && v === 'first') return { t: 'connected', f: 'not_connected' };
    if (r.op === 'neq' && v === 'first') return { t: 'not_connected', f: 'connected' };
    if (r.op === 'eq' && v !== 'first') return { t: 'not_connected', f: null };   // "pending" or "none" → certainly not connected
    if (r.op === 'neq' && v !== 'first') return { t: null, f: 'not_connected' };
  }
  if (r.field === 'accepted' && r.op === 'eq') return v === 'true' ? { t: 'connected', f: null } : { t: null, f: 'connected' };
  return { t: null, f: null };
}

/**
 * What a branch of a step proves about the lead's LinkedIn connection. "Already connected?" → true means the lead is a
 * connection (a message can go out; an invitation is pointless); its false branch means the lead is not.
 * Also covers "Wait for connection". null when the branch says nothing about it.
 */
export function branchConnectionFact(n: GraphNode | null | undefined, exit: string): ConnectionFact | null {
  if (!n) return null;
  if (n.type === 'wait_connection') return exit === 'connected' ? 'connected' : exit === 'no_connect' ? 'not_connected' : null;
  if (n.type !== 'condition' || (exit !== 'true' && exit !== 'false')) return null;
  const rules: ConditionRule[] = Array.isArray(n.config?.rules) ? n.config.rules : [];
  if (!rules.length) return null;
  const all = (n.config?.match ?? 'all') !== 'any';
  // true exit under "match all" (or a single rule): every rule holds. false exit under "match any" (or a single rule): every rule fails.
  const every = exit === 'true' ? all || rules.length === 1 : !all || rules.length === 1;
  if (!every) return null;
  let fact: ConnectionFact | null = null;
  for (const r of rules) {
    const f = exit === 'true' ? ruleFacts(r).t : ruleFacts(r).f;
    if (!f) continue;
    if (fact && fact !== f) return null;   // contradictory rules: say nothing
    fact = f;
  }
  return fact;
}

/** True when some branch of the step proves the lead is connected (a valid path for a message). */
export function provesConnection(n: GraphNode): boolean {
  return ['send_invite', 'wait_connection', 'send_inmail'].includes(n.type)
    || (n.type === 'condition' && (branchConnectionFact(n, 'true') === 'connected' || branchConnectionFact(n, 'false') === 'connected'));
}

const TEXT_STEPS: NodeType[] = ['send_invite', 'send_message', 'send_inmail', 'send_email', 'comment_latest_post', 'comment_post'];
const WHAT: Partial<Record<NodeType, string>> = { send_invite: 'invite note', send_message: 'message', comment_latest_post: 'comment', comment_post: 'comment', send_inmail: 'InMail body' };

export interface ValidateOptions {
  hasFreeSender?: boolean;
  hasMailbox?: boolean;
  strict?: boolean;
  /** Providers of the senders in the pool: channel steps need an account of their channel, messages take their channel from it. */
  poolProviders?: Provider[];
  /** The sequence setting `channel_independent_continuation` (warned about when the pool spans two channels). */
  channelIndependent?: boolean;
}

/** Which platform a message limit belongs to, for the "X allows N characters" sentence. */
function limitOwner(type: NodeType, channels: Provider[]): string {
  if (type === 'comment_post') return 'Instagram';
  if (MESSAGE_TYPES.includes(type)) { if (channels.includes('INSTAGRAM')) return 'Instagram'; if (channels.includes('WHATSAPP')) return 'WhatsApp'; }
  return 'LinkedIn';
}

/** The variants of a step, or [] when it is not an A/B test. */
export function nodeVariants(n: GraphNode): MessageVariant[] {
  return Array.isArray(n.config?.variants) ? (n.config!.variants as MessageVariant[]) : [];
}

function str(v: unknown): string { return typeof v === 'string' ? v : ''; }

export function validateGraph(graph: Graph, opts: ValidateOptions = {}): { errors: GraphIssue[]; warnings: GraphIssue[] } {
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
  const pool = opts.poolProviders;
  const poolChannels = CHANNEL_PROVIDERS.filter((p) => pool?.includes(p));
  const inPool = (p: Provider) => poolChannels.includes(p);

  // steps above a step (any path), for "is there a … before it" checks
  const parents = new Map<string, string[]>();
  for (const n of Object.values(nodes)) for (const t of [n.next, ...Object.values(n.branches ?? {})]) if (t) parents.set(t, [...(parents.get(t) ?? []), n.id]);
  const ancestorCache = new Map<string, GraphNode[]>();
  const ancestors = (id: string): GraphNode[] => {
    const hit = ancestorCache.get(id);
    if (hit) return hit;
    const seen = new Set<string>();
    const out: GraphNode[] = [];
    const q = [...(parents.get(id) ?? [])];
    while (q.length) {
      const cur = q.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const a = nodes[cur];
      if (!a) continue;
      out.push(a);
      for (const p of parents.get(cur) ?? []) q.push(p);
    }
    ancestorCache.set(id, out);
    return out;
  };
  /** The channels a step runs on here: its own setting, else the channel a "Switch channel" above moved the lead to, else the pool's. */
  const channelsOf = (n: GraphNode): Provider[] => {
    const supported = NODE_CATALOG[n.type]?.channels ?? CHANNEL_PROVIDERS;
    const own = n.config?.channel;
    if (typeof own === 'string' && (supported as string[]).includes(own)) return [own as Provider];
    if (!NODE_CATALOG[n.type]?.channels || MESSAGE_TYPES.includes(n.type)) {
      const switched = ancestors(n.id).filter((a) => a.type === 'channel_switch').map((a) => a.config?.to_channel)
        .filter((c): c is Provider => typeof c === 'string' && (supported as string[]).includes(c));
      if (switched.length) return [...new Set(switched)];
    }
    return nodeChannels(n, pool);
  };

  let hasTerminal = false;
  let hasConnectPath = false;
  let hasLinkedInMessage = false;
  for (const [k, n] of Object.entries(nodes)) {
    const chans = channelsOf(n);
    if (n.id !== k) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: 'This step is stored under the wrong name. Delete it and add it again' });
    if (n.next && !nodes[n.next]) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: 'This step leads to a step that no longer exists. Connect it again' });
    for (const [b, t] of Object.entries(n.branches ?? {})) if (t && !nodes[t]) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: `The “${b.replace(/_/g, ' ')}” branch leads to a step that no longer exists. Connect it again` });
    if (n.type === 'end' || n.type === 'send_to_sequence' || (!n.next && !n.branches && n.type !== 'start')) hasTerminal = true;
    if (provesConnection(n)) hasConnectPath = true;   // an invite / wait / InMail, or an "Already connected?" check
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
      const lim = n.type === 'send_invite' ? noteLimit : n.type === 'send_message' ? messageTextLimit(chans) : n.type === 'comment_latest_post' ? TEXT_LIMITS.comment : n.type === 'comment_post' ? TEXT_LIMITS.ig_comment : n.type === 'send_inmail' ? TEXT_LIMITS.inmail_body : null;
      for (const t of texts) {
        if (texts.length > 1 && t.label === '' && t.text === '') continue;   // variants replace an empty base copy
        const ml = spintaxInfo(t.text).maxLen;
        if (lim != null && ml > lim) {
          errors.push({ node_id: k, code: n.type === 'send_invite' ? 'E_NOTE_TOO_LONG' : 'E_PAYLOAD_INVALID', message: `The ${WHAT[n.type]}${t.label} can run to ${ml} characters. ${limitOwner(n.type, chans)} allows ${lim.toLocaleString('en-US')}. Shorten it (the longest spin option counts)` });
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
    if (['send_invite', 'send_message', 'comment_latest_post', 'comment_post', 'send_inmail'].includes(n.type) && c.ai != null && !c.ai?.brief) warnings.push({ node_id: k, code: 'W_AI_BRIEF', message: 'AI drafting is on but there is no brief. Tell the AI what to write about' });
    if (n.type === 'ai_draft_approval' && !c.brief) warnings.push({ node_id: k, code: 'W_AI_BRIEF', message: 'AI drafting is on but there is no brief. Tell the AI what to write about' });
    if (n.type === 'send_voice_note' && opts.strict) warnings.push({ node_id: k, code: 'W_VOICE_CLIP', message: 'Every sender in the pool needs a recorded clip for this step. Senders without one skip it' });
    if (['add_tag', 'remove_tag'].includes(n.type) && !c.tag_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'Choose which tag' });
    if (n.type === 'change_list' && !c.list_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'Choose which list' });
    if (n.type === 'change_stage' && !c.stage_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'Choose which stage' });
    if (n.type === 'send_to_sequence' && !c.sequence_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'Choose which sequence' });
    if (n.type === 'call_webhook' && !c.webhook_id) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'Choose which webhook' });

    // --- channels (docs/outreach/CHANNELS-BUILD-CONTRACT.md §3) ---
    const meta = NODE_CATALOG[n.type];
    if (opts.strict && pool && meta?.channels && n.type !== 'send_email') {
      // a channel step needs an account of its channel in the pool (a message: of the channel it is set to, else of any it supports)
      const own = typeof c.channel === 'string' ? (c.channel as Provider) : null;
      const required: Provider[] = own && meta.channels.includes(own) ? [own] : meta.channels;
      if (!required.some(inPool)) errors.push({ node_id: k, code: 'E_NO_CHANNEL_SENDER', message: channelIssueText('E_NO_CHANNEL_SENDER', required.length === 1 ? required[0] : null) });
    }
    if (MESSAGE_TYPES.includes(n.type)) {
      if (!c.send_always && chans.includes('LINKEDIN')) hasLinkedInMessage = true;
      // WhatsApp only reaches people who agreed to hear from you: a message that may open a chat needs a consent check above it
      // (a "Switch channel" to WhatsApp checks consent itself before moving the lead)
      if (chans.includes('WHATSAPP') && c.new_chat_allowed !== false) {
        const guarded = ancestors(k).some((a) => a.type === 'require_consent' || (a.type === 'channel_switch' && a.config?.to_channel === 'WHATSAPP'));
        if (!guarded) errors.push({ node_id: k, code: 'E_NO_CONSENT_GUARD', message: CHANNEL_ISSUE_TEXT.E_NO_CONSENT_GUARD });
      }
    }
    if (n.type === 'like_recent_posts') {
      const count = Number(c.count ?? 1);
      if (!(count >= 1 && count <= 3)) errors.push({ node_id: k, code: 'E_LIKE_COUNT', message: CHANNEL_ISSUE_TEXT.E_LIKE_COUNT });
    }
    if (n.type === 'comment_post' && PITCH_RE.test(str(c.text))) warnings.push({ node_id: k, code: 'W_IG_COMMENT_PITCH', message: CHANNEL_ISSUE_TEXT.W_IG_COMMENT_PITCH });
    if (n.type === 'require_consent') {
      const bases: unknown[] = Array.isArray(c.bases) ? c.bases : [];
      if (bases.length === 1 && bases[0] === 'imported_attested') warnings.push({ node_id: k, code: 'W_WA_ATTESTED_ONLY', message: CHANNEL_ISSUE_TEXT.W_WA_ATTESTED_ONLY });
    }
    if (n.type === 'wait_follow_back' && !ancestors(k).some((a) => a.type === 'follow')) warnings.push({ node_id: k, code: 'W_CONFIG', message: 'Nothing above this step follows the lead, so there is no follow-back to wait for. Add “Follow” before it' });
    if (n.type === 'channel_switch') {
      const to = c.to_channel;
      if (!CHANNEL_PROVIDERS.includes(to)) errors.push({ node_id: k, code: 'E_GRAPH_INVALID', message: 'Choose which channel to switch to' });
      else {
        if (opts.strict && pool && !inPool(to)) errors.push({ node_id: k, code: 'E_NO_CHANNEL_SENDER', message: channelIssueText('E_NO_CHANNEL_SENDER', to) });
        // only a reply (a human conversation) can produce a handle or number the sequence did not start with
        if (c.require_identity !== false && !ancestors(k).some((a) => a.type === 'wait_for_reply')) warnings.push({ node_id: k, code: 'W_SWITCH_NO_IDENTITY', message: channelIssueText('W_SWITCH_NO_IDENTITY', to) });
      }
    }
  }

  // Instagram paths: the first Instagram action should not be a message, and no more than 10 actions may run back to back
  // (an account gets 10 per hour). Walked from the start; a delay / wait step, or a "wait before this step", breaks a run.
  {
    const dmFirst = new Set<string>();
    const overrun = new Set<string>();
    const best = new Map<string, number>();
    const stack: Array<{ id: string; run: number; igSeen: boolean }> = [{ id: graph.start, run: 0, igSeen: false }];
    while (stack.length) {
      const { id, run, igSeen } = stack.pop()!;
      const n = nodes[id];
      if (!n) continue;
      const key = `${id}|${igSeen ? 1 : 0}`;
      if ((best.get(key) ?? -1) >= run) continue;
      best.set(key, run);
      const ig = EXECUTABLE_TYPES.includes(n.type) && channelsOf(n).includes('INSTAGRAM');
      let r = WAIT_TYPES.includes(n.type) || n.delay ? 0 : run;
      if (ig) {
        r += 1;
        if (r > 10) overrun.add(id);
        if (!igSeen && MESSAGE_TYPES.includes(n.type)) dmFirst.add(id);
      }
      for (const t of [n.next, ...Object.values(n.branches ?? {})]) if (t) stack.push({ id: t, run: r, igSeen: igSeen || ig });
    }
    for (const id of dmFirst) warnings.push({ node_id: id, code: 'W_IG_DM_FIRST', message: CHANNEL_ISSUE_TEXT.W_IG_DM_FIRST });
    for (const id of overrun) errors.push({ node_id: id, code: 'E_HOURLY_DEMAND', message: CHANNEL_ISSUE_TEXT.E_HOURLY_DEMAND });
  }
  if (opts.channelIndependent && poolChannels.length >= 2) warnings.push({ code: 'W_CHANNEL_INDEPENDENT', message: CHANNEL_ISSUE_TEXT.W_CHANNEL_INDEPENDENT });

  if (opts.strict) {
    if (!hasTerminal) errors.push({ code: 'E_GRAPH_INVALID', message: 'The sequence never ends. Add an “End” step at the bottom of every branch' });
    // a LinkedIn message can only reach connections; Instagram and WhatsApp messages have no such rule
    if (hasLinkedInMessage && !hasConnectPath) errors.push({ code: 'E_RELATION_REQUIRED', message: 'A message can only reach connected leads. Put “Send invitation” and “Wait for connection” (or an InMail) before it' });
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
    const viaBranch = n.branches?.next;   // a call task / a message with a "no chat" exit mirrors its onward step into branches.next
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
  if (MESSAGE_TYPES.includes(n.type)) {
    // A message keeps its onward step in `next` (the engine reads it when the message completes). While the optional
    // "no chat" exit exists the canvas wires through branches, so branches.next wins and is mirrored back; a "no chat"
    // exit with nothing connected is dropped (the engine then skips the step for leads with no conversation).
    if (!n.branches) return n;
    const onward = 'next' in n.branches ? n.branches.next ?? null : n.next ?? null;
    if (nodeExits(n).length === 1) { const { branches: _b, ...rest } = n; return { ...rest, next: onward }; }
    const branches: Record<string, string | null> = { next: onward };
    if (n.branches.no_chat) branches.no_chat = n.branches.no_chat;
    if ((n.next ?? null) === onward && JSON.stringify(n.branches) === JSON.stringify(branches)) return n;
    return { ...n, next: onward, branches };
  }
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
