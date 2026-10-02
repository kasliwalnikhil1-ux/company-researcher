/**
 * Shared pieces of the demo's sequences area: lookups, graph diff and validation (the app's own validateGraph),
 * moving an enrollment on, sending a step now (manual / approved steps), the enrolment plan and the projection.
 * Mirrors migrations/outreach/012 (drafts, publish, enrolment), 011 (tasks, enrollments) and 026 (plan, projection).
 */
import { validateGraph, type GraphIssue } from '../../../graph';
import { NODE_CATALOG } from '../../../nodes';
import type { Graph, GraphNode } from '../../../types';
import { demoError, type Ctx } from '../ctx';
import { capFor } from '../sim/caps';
import { engineFor, LIVE, RATES, simHooks } from '../sim/engine';
import type { DemoStore, Row } from '../store';

export const H = 3_600_000;
export const D = 86_400_000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const LIVE_SET = new Set(LIVE);
export const RUNNABLE = new Set(['active', 'waiting_connection', 'waiting_delay']);
export const MAIL = new Set(['GMAIL', 'OUTLOOK', 'IMAP']);

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------
/** JSON with sorted keys: jsonb equality ignores key order. */
export function stable(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Row)[k])]));
    return x === undefined ? null : x;
  };
  return JSON.stringify(norm(v));
}
export const sameJson = (a: unknown, b: unknown) => stable(a) === stable(b);
export const clone = <T,>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** FNV-1a in [0, 1): the same hash the engine uses for A/B splits, so the demo can tell which branch a lead took. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/** Picks one entry by weight from a stable hash. */
export function pickWeighted<T extends { weight?: number | null }>(list: T[], key: string): T | undefined {
  const total = list.reduce((s, b) => s + Math.max(0, Number(b.weight) || 0), 0);
  if (!list.length) return undefined;
  if (total <= 0) return list[0];
  let x = hash01(key) * total;
  for (const b of list) { x -= Math.max(0, Number(b.weight) || 0); if (x <= 0) return b; }
  return list[list.length - 1];
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
export function seqOr404(ctx: Ctx, id: unknown): Row {
  const s = ctx.store.get('outreach_sequences', typeof id === 'string' ? id : null);
  if (!s || s.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Sequence not found');
  return s;
}

export function liveEnrollments(store: DemoStore, seqId: string): Row[] {
  return store.t('outreach_enrollments').filter((e) => e.sequence_id === seqId && LIVE_SET.has(e.status));
}

/** The graph an enrollment runs on (its pinned version, else the live graph). */
export function enrollmentGraph(store: DemoStore, e: Row): Graph | null {
  return (engineFor(store).graphOf(e) as Graph | null) ?? null;
}

/** Senders of a pool split by provider (the `sender_pools` column). */
export function poolsByProvider(store: DemoStore, pool: string[]): Row {
  const out: Row = {};
  for (const id of pool) { const p = store.get('outreach_senders', id)?.provider; if (p) (out[p] ??= []).push(id); }
  return out;
}

// ---------------------------------------------------------------------------
// Validation (outreach_validate_graph = the app's validateGraph with the pool's facts)
// ---------------------------------------------------------------------------
export function validate(store: DemoStore, graph: Graph | null | undefined, pool: string[], strict: boolean, settings?: Row | null): { errors: GraphIssue[]; warnings: GraphIssue[] } {
  if (!graph || typeof graph !== 'object' || !graph.nodes || typeof graph.nodes !== 'object') {
    return { errors: [{ code: 'E_GRAPH_INVALID', message: 'graph.nodes missing' }], warnings: [] };
  }
  const senders = pool.map((id) => store.get('outreach_senders', id)).filter((s): s is Row => !!s && !s.deleted_at);
  const vars = store.t('outreach_ai_variables').filter((v) => !v.deleted_at && v.key);
  return validateGraph(graph, {
    hasFreeSender: senders.some((s) => s.provider === 'LINKEDIN' && !s.is_premium),
    hasMailbox: senders.some((s) => s.provider !== 'LINKEDIN'),
    strict,
    poolProviders: Array.from(new Set(senders.map((s) => s.provider))),
    channelIndependent: settings?.channel_independent_continuation === true,
    aiVariables: vars.length ? vars.map((v) => ({ key: v.key, name: v.name, output: v.output ?? null, fields: v.fields ?? null, builtin: v.builtin ?? null })) : undefined,
  });
}

/** Raises E_GRAPH_INVALID with the issues as JSON, the way the database does (formatGraphError reads it). */
export function assertValid(store: DemoStore, graph: Graph, pool: string[], strict: boolean, settings?: Row | null) {
  const v = validate(store, graph, pool, strict, settings);
  if (v.errors.length) demoError('E_GRAPH_INVALID', JSON.stringify(v.errors));
  return v;
}

// ---------------------------------------------------------------------------
// Graph diff (outreach_graph_diff): position-only moves and label edits are not changes
// ---------------------------------------------------------------------------
export interface DiffRow { node_id: string; change: 'added' | 'removed' | 'changed'; text_changed: boolean; delay_changed: boolean; node_type: string }

export function graphDiff(oldG: Graph | null | undefined, newG: Graph | null | undefined): DiffRow[] {
  const o = (oldG?.nodes ?? {}) as Record<string, Row>;
  const n = (newG?.nodes ?? {}) as Record<string, Row>;
  const out: DiffRow[] = [];
  const strip = (x: Row) => { const { position: _p, label: _l, ...rest } = x; void _p; void _l; return rest; };
  const keys = Array.from(new Set([...Object.keys(o), ...Object.keys(n)])).sort();
  for (const k of keys) {
    const a = o[k], b = n[k];
    if (!a) { out.push({ node_id: k, change: 'added', text_changed: false, delay_changed: false, node_type: b.type }); continue; }
    if (!b) { out.push({ node_id: k, change: 'removed', text_changed: false, delay_changed: false, node_type: a.type }); continue; }
    if (sameJson(strip(a), strip(b))) continue;
    const ca = a.config ?? {}, cb = b.config ?? {};
    const { ai: _a, ...ra } = ca; const { ai: _b, ...rb } = cb; void _a; void _b;
    const text_changed = !sameJson(ra, rb) && (['text', 'note', 'subject', 'html'].some((f) => (ca[f] ?? null) !== (cb[f] ?? null)) || !sameJson(ca.variants ?? null, cb.variants ?? null));
    const delay_changed = (a.type === 'delay' && !sameJson(ca, cb)) || !sameJson(a.delay ?? null, b.delay ?? null);
    out.push({ node_id: k, change: 'changed', text_changed, delay_changed, node_type: b.type });
  }
  return out;
}
export const changeCount = (a: Graph | null | undefined, b: Graph | null | undefined) => graphDiff(a, b).length;

// ---------------------------------------------------------------------------
// Moving enrollments
// ---------------------------------------------------------------------------
/** Where a step leads for an exit (the default exit when none is given). */
export function nextOf(node: Row | undefined, exit: string | null): string | null {
  if (!node) return null;
  if (exit && node.branches && exit in node.branches && node.branches[exit]) return node.branches[exit];
  return node.next ?? node.branches?.next ?? null;
}

/** outreach_advance_enrollment: past `nodeId` to the step after it (completes when there is none). */
export function advance(store: DemoStore, e: Row, nodeId: string | null | undefined, exit: string | null, graph?: Graph | null, now = Date.now()) {
  const g = graph ?? enrollmentGraph(store, e);
  const node = nodeId ? (g?.nodes?.[nodeId] as Row | undefined) : undefined;
  const target = nextOf(node, exit);
  if (!target) { engineFor(store).complete(e, now, null); return; }
  store.update('outreach_enrollments', e.id, { current_node_id: target, node_entered_at: iso(now), wait_until: null, status: 'active', wait_reason: null, paused_from: null });
}

/** outreach_complete_enrollment: ends it and cancels what it still had queued. */
export function finish(store: DemoStore, e: Row, status: string, reason: string | null, now = Date.now()) {
  engineFor(store).exit(e, status, reason ?? '', now);
  store.update('outreach_enrollments', e.id, { exit_reason: reason, paused_from: null, wait_reason: null });
  engineFor(store).resetIndexes();
}

/** Runs an enrollment now when its sequence is running (the first steps of a new or resumed lead). */
export function stepNow(store: DemoStore, e: Row | undefined, now = Date.now()) {
  if (!e) return;
  const seq = store.get('outreach_sequences', e.sequence_id);
  if (!seq || seq.status !== 'active' || !RUNNABLE.has(e.status)) return;
  engineFor(store).step(e, now);
}

/** Count of sent actions (to tell whether something "went out" in a handler, for the Simulated notice). */
export const sentCount = (store: DemoStore) => store.t('outreach_actions').reduce((n, a) => n + (a.status === 'sent' ? 1 : 0), 0);

// ---------------------------------------------------------------------------
// A step sent by a person (manual step, approved draft): the action, the message and the usual follow-on
// ---------------------------------------------------------------------------
export function sendNow(ctx: Ctx, e: Row, node: Row, opts: { text: string | null; subject?: string | null; actionType?: string; taskId?: string }): Row | null {
  const store = ctx.store;
  const eng = engineFor(store);
  const now = Date.now();
  const lead = store.get('outreach_leads', e.lead_id);
  const type = opts.actionType ?? NODE_CATALOG[node.type as keyof typeof NODE_CATALOG]?.actionType ?? 'message';
  if (!lead || !type) return null;
  const seq = store.get('outreach_sequences', e.sequence_id);
  let sender = eng.sender(e.sender_id);
  if (type === 'email') {
    const mailId = node.config?.mailbox_sender_id || e.channel_sender_map?.GMAIL || e.channel_sender_map?.OUTLOOK
      || (seq?.sender_pool ?? []).find((id: string) => MAIL.has(store.get('outreach_senders', id)?.provider));
    sender = eng.sender(mailId) ?? sender;
  }
  if (!sender) return null;
  const text = (opts.text ?? '').trim();
  const payload: Row = { approved_task_id: opts.taskId ?? null, approved_by: ctx.userId };
  if (type === 'invite') payload.note = text; else if (type === 'email') { payload.html = text; payload.subject = opts.subject ?? node.config?.subject ?? null; } else payload.text = text;
  // a queued copy of this step (if the planner left one) becomes the sent one
  for (const a of store.t('outreach_actions')) if (a.enrollment_id === e.id && a.node_id === node.id && a.status === 'queued') { a.status = 'cancelled'; a.decision = 'sent_by_person'; }
  eng.resetIndexes();
  const action = store.insert('outreach_actions', {
    workspace_id: e.workspace_id, enrollment_id: e.id, import_job_id: null, lead_id: lead.id, node_id: node.id, variant_id: null, scheduled_for: iso(now), attempt: 1,
    decision: null, created_at: iso(now - 60_000), status: 'sent', executed_at: iso(now), reserved_at: iso(now - 30_000), payload, response: { ok: true }, error_code: null,
    action_type: type, sender_id: sender.id,
  })[0];
  eng.ledger.add(sender, now, type);
  for (const h of simHooks.onSent) { try { h(store, action); } catch (err) { console.error('[demo] send hook failed', err); } }
  if (type === 'invite') {
    const st = eng.state(lead.id, sender.id);
    if (st.relation !== 'first') store.update('outreach_lead_sender_state', (r) => r === st, { relation: 'pending_out', invite_sent_at: iso(now), invite_had_note: !!text, _accept_at: store.chance(RATES.accept) ? iso(now + store.int(3, 120) * H) : null });
  }
  if (['message', 'inmail', 'email'].includes(type) && text) {
    const subject = type === 'email' ? (payload.subject ?? null) : null;
    const chat = eng.ensureChat(lead, sender, now, subject);
    const plain = type === 'email' ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : text;
    eng.appendMessage(chat, { direction: 'out', text: plain, html: type === 'email' ? text : null, at: now, action_id: action.id, sent_by: ctx.userId, origin: 'sequence' });
    eng.state(lead.id, sender.id);
    store.update('outreach_lead_sender_state', (r) => r.lead_id === lead.id && r.sender_id === sender!.id, { last_outbound_at: iso(now), unipile_chat_id: chat.unipile_chat_id }, { silent: true });
    const stage = store.get('outreach_stages', lead.stage_id);
    if (!stage || stage.kind === 'new') { const c = store.t('outreach_stages').find((x) => x.kind === 'contacted'); if (c) store.update('outreach_leads', lead.id, { stage_id: c.id }); }
    if (store.chance(RATES.reply)) eng.scheduleReply({ chat_id: chat.id, lead_id: lead.id, sender_id: sender.id, enrollment_id: e.id, action_id: action.id }, now + store.int(1, 30) * H);
  }
  ctx.ui.simulated();
  return action;
}

// ---------------------------------------------------------------------------
// Suppression and identities (outreach_lead_suppression_reason, outreach_lead_identity)
// ---------------------------------------------------------------------------
const slugify = (v: unknown) => String(v ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function suppressionReason(store: DemoStore, lead: Row, clientId: string | null, seqId: string | null): string | null {
  if (lead.do_not_contact) return 'do_not_contact';
  if (lead.unsubscribed) return 'unsubscribed';
  const email = [lead.email_work, lead.email_personal].filter(Boolean).map((x: string) => x.toLowerCase());
  const domains = email.map((x) => x.split('@')[1]).filter(Boolean);
  const idents = store.t('outreach_lead_identities').filter((i) => i.lead_id === lead.id);
  const hits = store.t('outreach_suppressions').filter((sp) => sp.workspace_id === lead.workspace_id
    && (!sp.client_id || sp.client_id === (clientId ?? lead.client_id)) && (!sp.sequence_id || sp.sequence_id === seqId)
    && (() => {
      const v = String(sp.value ?? '').toLowerCase();
      switch (sp.kind) {
        case 'public_identifier': return !!lead.public_identifier && String(lead.public_identifier).toLowerCase() === v;
        case 'email': return email.includes(v);
        case 'domain': return domains.includes(v);
        case 'company': return (!!lead.company && (String(lead.company).toLowerCase().trim() === v || slugify(lead.company) === slugify(v))) || (!!lead.company_id && lead.company_id === sp.value);
        case 'phone': return idents.some((i) => i.provider === 'WHATSAPP' && i.identifier === sp.value);
        case 'handle': return idents.some((i) => i.provider === 'INSTAGRAM' && String(i.identifier).toLowerCase() === v);
        default: return false;
      }
    })());
  if (!hits.length) return null;
  hits.sort((a, b) => Number(!!b.sequence_id) - Number(!!a.sequence_id) || Number(!!b.client_id) - Number(!!a.client_id));
  const sp = hits[0];
  return `${sp.sequence_id ? 'sequence' : sp.client_id ? 'client' : 'workspace'}_blacklist:${sp.kind}`;
}

export function hasIdentity(store: DemoStore, lead: Row, provider: string): boolean {
  if (store.t('outreach_lead_identities').some((i) => i.lead_id === lead.id && i.provider === provider && i.verified !== false)) return true;
  if (provider === 'LINKEDIN') return !!(lead.public_identifier || lead.provider_id);
  if (MAIL.has(provider)) return !!(lead.email_work || lead.email_personal);
  return false;
}

const hasConsent = (store: DemoStore, leadId: string) => store.t('outreach_lead_consent').some((c) => c.lead_id === leadId && c.channel === 'WHATSAPP' && !c.revoked_at && (!c.expires_at || Date.parse(c.expires_at) > Date.now()));

// ---------------------------------------------------------------------------
// The enrolment plan (outreach__enroll_plan, 026): one plan for the preview and the commit
// ---------------------------------------------------------------------------
export interface PlanRow { lead_id: string; sender_id: string | null; reason: string | null; note: string | null }

export function enrollPlan(ctx: Ctx, s: Row, leadIds: string[], senderId: string | null, includeReplied: boolean): PlanRow[] {
  const store = ctx.store;
  let pool: string[] = [...(s.sender_pool ?? [])];
  if (senderId) {
    if (!pool.includes(senderId)) demoError('E_SENDER_NOT_IN_POOL', 'The sender is not in this sequence\'s pool');
    pool = [senderId];
  }
  let senders = pool.map((id) => store.get('outreach_senders', id)).filter((x): x is Row => !!x && !x.deleted_at && x.status !== 'disabled');
  // a mailbox in a mixed pool serves the email steps; leads are dealt to the LinkedIn / Instagram / WhatsApp senders (the demo engine works this way)
  if (senders.some((x) => !MAIL.has(x.provider))) senders = senders.filter((x) => !MAIL.has(x.provider));
  const ids = senders.map((x) => x.id);
  const n = ids.length;
  if (n === 0) demoError('E_POOL_EMPTY', 'The sender pool is empty');
  const prov = new Map(senders.map((x) => [x.id, x.provider as string]));
  const allEnr = store.t('outreach_enrollments');
  const offs = allEnr.filter((e) => e.sequence_id === s.id).length;
  const load = new Map(ids.map((id) => [id, allEnr.filter((e) => e.sender_id === id && ['active', 'waiting_connection', 'waiting_delay', 'waiting_task'].includes(e.status)).length]));
  const hasMsg = Object.values((s.graph?.nodes ?? {}) as Record<string, Row>).some((nd) => nd.type === 'send_message' || nd.type === 'send_voice_note');
  const states = store.t('outreach_lead_sender_state');
  const out: PlanRow[] = [];
  let i = 0;
  const now = Date.now();
  for (const lid of leadIds) {
    const row: PlanRow = { lead_id: lid, sender_id: null, reason: null, note: null };
    const l = store.get('outreach_leads', lid);
    if (!l || l.workspace_id !== s.workspace_id) { row.reason = 'not_in_workspace'; out.push(row); continue; }
    const why = suppressionReason(store, l, s.client_id ?? null, s.id);
    if (why) { row.reason = `suppressed:${why}`; out.push(row); continue; }
    if (!includeReplied && l.last_replied_at && now - Date.parse(l.last_replied_at) < 90 * D) { row.reason = 'replied_recently'; out.push(row); continue; }
    const busy = new Set(allEnr.filter((e) => e.lead_id === lid && ids.includes(e.sender_id) && LIVE_SET.has(e.status)).map((e) => e.sender_id));
    const hist = states.filter((h) => h.lead_id === lid && ids.includes(h.sender_id) && (h.last_outbound_at || h.last_inbound_at || h.invite_sent_at))
      .sort((a, b) => Math.max(Date.parse(b.last_outbound_at ?? 0) || 0, Date.parse(b.last_inbound_at ?? 0) || 0, Date.parse(b.invite_sent_at ?? 0) || 0)
        - Math.max(Date.parse(a.last_outbound_at ?? 0) || 0, Date.parse(a.last_inbound_at ?? 0) || 0, Date.parse(a.invite_sent_at ?? 0) || 0))
      .map((h) => h.sender_id as string);
    let free = ids.filter((x) => !busy.has(x));
    if (!free.length) { row.reason = 'already_enrolled'; out.push(row); continue; }
    const fit = free.filter((x) => hasIdentity(store, l, prov.get(x)!));
    if (!fit.length) {
      const p = prov.get(free[0]);
      row.reason = p === 'INSTAGRAM' ? 'no_identity:instagram' : p === 'WHATSAPP' ? 'no_identity:whatsapp' : 'no_identity';
      out.push(row); continue;
    }
    const fit2 = fit.filter((x) => !(hasMsg && prov.get(x) === 'WHATSAPP' && !hasConsent(store, lid)));
    if (!fit2.length) { row.reason = 'no_consent'; out.push(row); continue; }
    free = fit2;
    let rr: string | null = null;
    for (let t = 0; t < n; t++) { const c = ids[(offs + i + t) % n]; if (free.includes(c)) { rr = c; break; } }
    const byLoad = (xs: string[]) => [...xs].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b))[0] ?? null;
    let chosen: string | null = null;
    if (senderId) chosen = rr;
    else if (s.assignment === 'fresh_sender') {
      if (rr && !hist.includes(rr)) chosen = rr;
      else {
        chosen = byLoad(free.filter((x) => !hist.includes(x)));
        if (!chosen) { row.reason = 'no_fresh_sender'; out.push(row); continue; }
        row.note = 'moved_to_fresh_sender';
      }
    } else if (s.assignment === 'same_sender') {
      chosen = hist.find((x) => free.includes(x)) ?? null;
      if (chosen) row.note = chosen === rr ? null : 'kept_with_previous_sender'; else chosen = rr;
    } else if (s.assignment === 'least_loaded') chosen = byLoad(free);
    else chosen = rr;
    if (!chosen) { row.reason = 'already_enrolled'; out.push(row); continue; }
    if (!row.note && hist.includes(chosen)) row.note = 'contacted_before_by_this_sender';
    load.set(chosen, (load.get(chosen) ?? 0) + 1);
    row.sender_id = chosen; i++;
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Projection (outreach_project_sequence, 026)
// ---------------------------------------------------------------------------
export interface Projection { estimated_days: number; bottleneck: string | null; details: Row }

export function project(store: DemoStore, s: Row, leadCount: number): Projection {
  const counts = new Map<string, number>();
  let waitDays = 0;
  for (const n of Object.values((s.graph?.nodes ?? {}) as Record<string, Row>)) {
    const meta = NODE_CATALOG[n.type as keyof typeof NODE_CATALOG];
    if (meta?.actionType && n.type !== 'call_api') {
      counts.set(meta.actionType, (counts.get(meta.actionType) ?? 0) + 1);
      if (n.type === 'send_invite' || n.type === 'send_message') counts.set('profile_view', (counts.get('profile_view') ?? 0) + 1);
    } else if (n.type === 'wait_connection' || n.type === 'wait_follow_back') {
      waitDays = Math.max(waitDays, Math.floor(Number(n.config?.window_days ?? (n.type === 'wait_follow_back' ? 5 : 14)) / 2));
    } else if (n.type === 'wait_for_reply') {
      waitDays += Math.floor(Math.ceil(Number(n.config?.window_hours ?? 96) / 24) / 2);
    } else if (n.type === 'delay' && (n.config?.unit ?? 'days') === 'days') {
      waitDays += Number(n.config?.amount ?? 0) || 0;
    }
  }
  const pool: Row[] = (s.sender_pool ?? []).map((id: string) => store.get('outreach_senders', id)).filter(Boolean);
  const invCeil = store.t('outreach_platform_ceilings').find((c) => c.provider === 'LINKEDIN' && c.action_type === 'invite');
  let worst = 0; let worstT: string | null = null;
  const det: Row = {};
  for (const [t, perLead] of counts) {
    let capSum = 0;
    for (const sd of pool) {
      const fits = t === 'email' ? MAIL.has(sd.provider) : !MAIL.has(sd.provider);
      if (!fits) continue;
      const days = Object.values((sd.schedule ?? {}) as Row).filter((w) => Array.isArray(w) && w.length > 0).length;
      capSum += capFor(store, sd, t) * (days / 7);
      if (t === 'invite') capSum = Math.min(capSum, (Number(invCeil?.per_week ?? 150) / 7) * Math.max(pool.length, 1));
    }
    const need = perLead * leadCount;
    const d = capSum <= 0 ? 9999 : Math.ceil(need / capSum);
    det[t] = { total: need, per_day: Math.round(capSum * 10) / 10, days: d };
    if (d > worst) { worst = d; worstT = t; }
  }
  return { estimated_days: Math.min(worst + waitDays, 9999), bottleneck: worstT, details: { ...det, wait_days: waitDays, pool_size: pool.length } };
}

// ---------------------------------------------------------------------------
// outreach_reason_text
// ---------------------------------------------------------------------------
export function reasonText(code: string | null | undefined): string {
  const c = code ?? null;
  if (c == null) return 'Unknown reason';
  const has = (x: string) => c.includes(x);
  if (['E_LEAD_SUPPRESSED', 'suppressed', 'do_not_contact', 'unsubscribed'].includes(c)) return 'The lead is on a do-not-contact list';
  if (c === 'E_REPLIED' || c === 'replied') return 'The lead replied, so the sequence stopped';
  if (c === 'E_RELATION_INVALID') return 'LinkedIn says this profile cannot be invited (blocked or invalid)';
  if (c === 'E_RELATION_REQUIRED' || has('no_connection_with_recipient')) return 'Not connected yet, so a message could not be sent';
  if (c === 'E_PAYLOAD_INVALID' || has('payload_invalid')) return 'The step had no usable text for this lead';
  if (c === 'E_NO_EMAIL') return 'No email address on file';
  if (c === 'email_bounced' || c === 'bounced' || has('recipient_rejected')) return 'The email address bounced';
  if (c === 'E_ENROLLMENT_NOT_LIVE') return 'The lead had already left the sequence';
  if (c === 'E_ALREADY_CONNECTED' || has('already_connected')) return 'Already connected, so the invitation was skipped';
  if (c === 'network_timeout_max' || c.startsWith('net:')) return 'Could not reach LinkedIn after three tries';
  if (has('invalid_recipient') || has('user_unreachable') || c.startsWith('404:')) return 'The profile no longer exists or cannot be reached';
  if (has('blocked_recipient') || has('cannot_invite_attendee')) return 'This person cannot be invited (they limit who can connect)';
  if (has('already_invited_recently') || has('cannot_resend') || c === 'invitation_pending') return 'An invitation is already pending or was sent recently';
  if (has('insufficient_credits') || has('not_allowed_inmail') || c === 'not_open_profile') return 'No InMail credit for this lead';
  if (c === 'no_recent_post') return 'The lead has no recent post to react to';
  if (c === 'no_skills') return 'No skills to endorse on the profile';
  if (c === 'no_voice_clip') return 'This sender has not recorded a voice note for the step';
  if (c === 'no_invitation') return 'There was no pending invitation to withdraw';
  if (has('comments_disabled') || has('invalid_post')) return 'The post does not accept comments';
  if (c.startsWith('401:') || c === 'E_SENDER_NOT_OK') return 'The sender was disconnected from LinkedIn';
  if (c.startsWith('403:')) return 'LinkedIn restricted the sender for this action';
  if (c.startsWith('429:')) return 'LinkedIn rate-limited the sender';
  if (/^5..:/.test(c)) return 'LinkedIn had a temporary error';
  if (c.startsWith('http_')) return `The API call returned ${c.replace('http_', 'HTTP ')}`;
  if (c === 'graph_loop') return 'The sequence loops without a wait';
  if (c === 'unknown_node_type') return 'The sequence contains a step this version cannot run';
  if (c === 'user_skipped') return 'Skipped by a teammate';
  if (c === 'email_not_found') return 'No email address was found';
  if (c === 'E_NO_CONSENT' || c === 'no_consent') return 'No recorded consent for WhatsApp, so no new chat was started';
  if (c === 'E_NO_IDENTITY' || c === 'no_identity') return 'The lead has no handle or number on file for this channel';
  return c.replace(/E_/g, '').replace(/_/g, ' ');
}

export type { GraphNode };
