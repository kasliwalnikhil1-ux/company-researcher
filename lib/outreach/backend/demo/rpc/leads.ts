/**
 * Demo handlers: Leads: bulk actions, timeline, custom keys, enrichment, import schedules, table layouts, channel identities and consent.
 * Owns: bulk_leads, consent_grant, consent_list, consent_revoke, identity_add, identity_list, identity_remove, identity_verify, lead_custom_keys, lead_queued_actions, lead_timeline, request_enrichment, save_import_schedule, sequence_chat_ids, table_layout_get, table_layout_set
 */
import { reasonText } from '../../../reasons';
import type { Ctx, RpcArea } from '../ctx';
import { demoError } from '../ctx';
import { processDueEnrichment, requestEnrichment } from '../leads/enrich';
import { upsertIdentity } from '../leads/upsert';
import { audit, cascadeLeadDelete, deleteLeads, initcap, leadDefaults, leadTriggers, profileSearchText, rowsOf } from '../leads/util';
import { tableHooks } from '../query';
import { DEMO_WS_ID } from '../seed/ids';
import { engineFor, LIVE } from '../sim/engine';
import type { DemoStore, Row } from '../store';


function wsGuard(ctx: Ctx, ws: unknown) {
  if (ws !== ctx.ws) demoError('E_FORBIDDEN', 'not a member of this workspace');
}
function leadOr404(ctx: Ctx, id: unknown): Row {
  const l = ctx.store.get('outreach_leads', String(id ?? ''));
  if (!l || l.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
  return l;
}
const iso = (v: unknown) => (v == null || v === '' ? null : new Date(String(v)).toISOString());

// ---------------------------------------------------------------------------
function bulkLeads(args: Row, ctx: Ctx): number {
  const { store } = ctx;
  wsGuard(ctx, args.p_ws);
  const ids: string[] = Array.isArray(args.p_lead_ids) ? args.p_lead_ids : [];
  if (ids.length > 10000) demoError('E_TOO_MANY', 'max 10000 per request');
  const want = new Set(ids);
  const leads = store.t('outreach_leads').filter((l) => l.workspace_id === ctx.ws && want.has(l.id));
  const set = new Set(leads.map((l) => l.id));
  const value: string | null = args.p_value == null || args.p_value === '' ? null : String(args.p_value);
  const op = String(args.p_op ?? '');
  let cnt = 0;
  const patch = (p: Row) => store.update('outreach_leads', (r) => set.has(r.id), p);
  switch (op) {
    case 'add_tag': {
      if (!value || !store.get('outreach_tags', value)) demoError('E_NOT_FOUND', 'tag');
      const have = new Set(store.t('outreach_lead_tags').filter((t) => t.tag_id === value).map((t) => t.lead_id));
      const rows = leads.filter((l) => !have.has(l.id)).map((l) => ({ lead_id: l.id, tag_id: value }));
      if (rows.length) store.insert('outreach_lead_tags', rows, { noId: true });
      cnt = rows.length;
      break;
    }
    case 'remove_tag':
      cnt = store.remove('outreach_lead_tags', (t) => t.tag_id === value && set.has(t.lead_id)).length;
      break;
    case 'set_list': cnt = patch({ list_id: value }).length; break;
    case 'set_stage': { const u = patch({ stage_id: value }); leadTriggers(store, u); cnt = u.length; break; }
    case 'set_client':
      if (value && !store.get('outreach_clients', value)) demoError('E_FORBIDDEN', 'client not visible');
      cnt = patch({ client_id: value }).length;
      break;
    case 'set_dnc': { const u = patch({ do_not_contact: true }); leadTriggers(store, u); cnt = u.length; break; }
    case 'clear_dnc': cnt = patch({ do_not_contact: false }).length; break;
    case 'delete': cnt = deleteLeads(store, set); break;
    default: demoError('E_PAYLOAD_INVALID', `unknown op ${op}`);
  }
  audit(store, ctx.ws, ctx.userId, 'leads.bulk', 'lead', null, { op, value, count: cnt });
  return cnt;
}

// ---------------------------------------------------------------------------
// Channel identities and consent (026)
function memberEmail(store: DemoStore, ws: string, userId: string | null): string | null {
  if (!userId) return null;
  return store.t('outreach_members').find((m) => m.workspace_id === ws && m.user_id === userId)?.email ?? null;
}

function consentRow(store: DemoStore, ws: string, c: Row): Row {
  return {
    id: c.id, lead_id: c.lead_id, lead_name: store.get('outreach_leads', c.lead_id)?.full_name ?? null, channel: c.channel, basis: c.basis, evidence: c.evidence ?? {},
    attested_by: c.attested_by ?? null, attested_by_email: memberEmail(store, ws, c.attested_by), obtained_at: c.obtained_at, expires_at: c.expires_at ?? null,
    revoked_at: c.revoked_at ?? null, revoked_reason: c.revoked_reason ?? null, created_at: c.created_at,
  };
}

/** outreach__consent_exit: live enrollments on that channel leave, queued actions on it are cancelled. */
function consentExit(store: DemoStore, leadId: string, channel: string, reason: string) {
  const engine = engineFor(store);
  const now = Date.now();
  const providerOf = (id: string) => store.get('outreach_senders', id)?.provider;
  for (const e of store.t('outreach_enrollments').filter((x) => x.lead_id === leadId && LIVE.includes(x.status))) {
    if ((e.current_channel ?? providerOf(e.sender_id)) === channel) engine.exit(e, 'exited_suppressed', reason, now);
  }
  for (const a of store.t('outreach_actions')) {
    if (a.lead_id === leadId && (a.status === 'queued' || a.status === 'reserved') && a.action_type !== 'reply' && providerOf(a.sender_id) === channel) { a.status = 'cancelled'; a.decision = reason; }
  }
}

function consentGrant(args: Row, ctx: Ctx): string {
  const { store } = ctx;
  const lead = leadOr404(ctx, args.p_lead);
  const basis = String(args.p_basis ?? '');
  const ev: Row = args.p_evidence && typeof args.p_evidence === 'object' ? args.p_evidence : {};
  const has = (k: string) => typeof ev[k] === 'string' && ev[k].trim() !== '';
  if ((basis === 'form_optin' || basis === 'existing_customer') && !has('url') && !has('note')) demoError('E_PAYLOAD_INVALID', 'evidence required for this basis');
  const obtained = iso(args.p_obtained_at) ?? ctx.now();
  const expires = iso(args.p_expires_at);
  if (expires && Date.parse(expires) <= Date.parse(obtained)) demoError('E_PAYLOAD_INVALID', 'expiry must be after the date consent was obtained');
  const channel = String(args.p_channel ?? '');
  store.update('outreach_lead_consent', (c) => c.lead_id === lead.id && c.channel === channel && !c.revoked_at, { revoked_at: ctx.now(), revoked_reason: 'replaced' });
  const row = store.insert('outreach_lead_consent', {
    workspace_id: lead.workspace_id, lead_id: lead.id, channel, basis, evidence: ev, attested_by: ctx.userId, obtained_at: obtained, expires_at: expires, revoked_at: null, revoked_reason: null,
  })[0];
  audit(store, ctx.ws, ctx.userId, 'consent.granted', 'lead', lead.id, { consent_id: row.id, channel, basis, evidence: ev, expires_at: expires });
  return row.id;
}

function consentList(args: Row, ctx: Ctx): Row[] {
  const { store } = ctx;
  wsGuard(ctx, args.p_ws);
  const limit = Math.min(Math.max(Number(args.p_limit ?? 200) || 200, 1), 2000);
  return rowsOf(store, 'outreach_lead_consent')
    .filter((c) => c.workspace_id === ctx.ws && store.get('outreach_leads', c.lead_id)
      && (!args.p_lead || c.lead_id === args.p_lead) && (!args.p_channel || c.channel === args.p_channel) && (!args.p_basis || c.basis === args.p_basis)
      && (args.p_include_revoked || !c.revoked_at))
    .sort((a, b) => String(b.obtained_at).localeCompare(String(a.obtained_at)))
    .slice(0, limit)
    .map((c) => consentRow(store, ctx.ws, c));
}

function consentRevoke(args: Row, ctx: Ctx): null {
  const { store } = ctx;
  const c = store.get('outreach_lead_consent', String(args.p_id ?? ''));
  if (!c || c.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
  if (c.revoked_at) return null;
  const reason = String(args.p_reason ?? '').trim() || 'manual';
  store.update('outreach_lead_consent', c.id, { revoked_at: ctx.now(), revoked_reason: reason });
  consentExit(store, c.lead_id, c.channel, 'consent_revoked');
  audit(store, ctx.ws, ctx.userId, 'consent.revoked', 'lead', c.lead_id, { consent_id: c.id, channel: c.channel, basis: c.basis, reason });
  return null;
}

function identityAdd(args: Row, ctx: Ctx): string {
  const lead = leadOr404(ctx, args.p_lead);
  const provider = String(args.p_provider ?? '').toUpperCase();
  const source = String(args.p_source ?? '') || 'operator';
  const verified = args.p_verified == null ? true : !!args.p_verified;
  const row = upsertIdentity(ctx.store, lead.workspace_id, lead.id, provider, args.p_identifier, source, verified, args.p_provider_id ?? null);
  audit(ctx.store, ctx.ws, ctx.userId, 'identity.added', 'lead', lead.id, { identity_id: row.id, provider, verified, source });
  return row.id;
}

function identityList(args: Row, ctx: Ctx): Row[] {
  const lead = leadOr404(ctx, args.p_lead);
  const rows = ctx.store.t('outreach_lead_identities').filter((i) => i.lead_id === lead.id)
    .sort((a, b) => String(a.provider).localeCompare(String(b.provider)) || String(a.created_at).localeCompare(String(b.created_at)))
    .map((i) => ({ id: i.id, provider: i.provider, identifier: i.identifier, provider_id: i.provider_id ?? null, verified: !!i.verified, source: i.source ?? null, is_valid: i.is_valid ?? null, last_checked_at: i.last_checked_at ?? null, created_at: i.created_at }));
  if (lead.public_identifier && !rows.some((r) => r.provider === 'LINKEDIN')) {
    rows.unshift({ id: null, provider: 'LINKEDIN', identifier: lead.public_identifier, provider_id: lead.provider_id ?? null, verified: true, source: 'lead', is_valid: null, last_checked_at: null, created_at: lead.created_at });
  }
  return rows;
}

function identityOr404(ctx: Ctx, id: unknown): Row {
  const i = ctx.store.get('outreach_lead_identities', String(id ?? ''));
  if (!i || i.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
  return i;
}

// ---------------------------------------------------------------------------
function leadCustomKeys(args: Row, ctx: Ctx): string[] {
  wsGuard(ctx, args.p_ws);
  const n = new Map<string, number>();
  for (const l of ctx.store.t('outreach_leads')) {
    if (l.workspace_id !== ctx.ws || !l.custom || typeof l.custom !== 'object' || Array.isArray(l.custom)) continue;
    for (const k of Object.keys(l.custom)) n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40).map(([k]) => k);
}

function leadQueuedActions(args: Row, ctx: Ctx): Row[] {
  const { store } = ctx;
  const lead = leadOr404(ctx, args.p_lead);
  const engine = engineFor(store);
  return store.t('outreach_actions')
    .filter((a) => a.lead_id === lead.id && a.status === 'queued' && !a.payload?.prefetch)
    .sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)))
    .map((a) => {
      const e = a.enrollment_id ? store.get('outreach_enrollments', a.enrollment_id) : undefined;
      const q = e ? store.get('outreach_sequences', e.sequence_id) : undefined;
      const graph = e ? engine.graphOf(e) : null;
      const s = store.get('outreach_senders', a.sender_id);
      return {
        action_id: a.id, enrollment_id: a.enrollment_id ?? null, sequence_id: q?.id ?? null, sequence_name: q?.name ?? null, node_id: a.node_id ?? null,
        node_label: graph?.nodes?.[a.node_id]?.label ?? String(a.action_type).replace(/_/g, ' '), action_type: a.action_type, sender_id: a.sender_id, sender_name: s?.display_name ?? null,
        scheduled_for: a.scheduled_for, body: a.payload?.text ?? a.payload?.note ?? null, subject: a.payload?.subject ?? null, variant_id: a.variant_id ?? null,
        editable: ['invite', 'message', 'inmail', 'email', 'comment'].includes(a.action_type),
      };
    });
}

/** outreach_lead_timeline (014): everything that happened to the lead, newest first, at most 400 rows. */
function leadTimeline(args: Row, ctx: Ctx): Row[] {
  const { store } = ctx;
  const lead = store.get('outreach_leads', String(args.p_lead ?? ''));
  if (!lead || lead.workspace_id !== ctx.ws) return [];
  const id = lead.id;
  const out: Row[] = [];
  for (const a of store.t('outreach_actions')) {
    if (a.lead_id !== id || !a.executed_at) continue;
    const why = a.status === 'failed' || a.status === 'skipped' ? reasonText(a.error_code, a.decision) : null;
    out.push({ at: a.executed_at, kind: 'action', title: `${initcap(String(a.action_type).replace(/_/g, ' '))} ${a.status}${why ? ` — ${why}` : ''}`, data: { id: a.id, sender_id: a.sender_id, node_id: a.node_id, variant_id: a.variant_id ?? null, decision: a.decision ?? null, error_code: a.error_code ?? null } });
  }
  const chats = new Set(store.t('outreach_chats').filter((c) => c.lead_id === id).map((c) => c.id));
  if (chats.size) for (const m of rowsOf(store, 'outreach_messages')) {
    if (!chats.has(m.chat_id)) continue;
    out.push({ at: m.sent_at, kind: 'message', title: m.direction === 'in' ? 'Reply received' : 'Message sent', data: { id: m.id, chat_id: m.chat_id, text: String(m.text ?? '').slice(0, 200), intent: m.intent ?? null, action_id: m.action_id ?? null, replied_to_action_id: m.replied_to_action_id ?? null } });
  }
  for (const e of store.t('outreach_enrollments')) {
    if (e.lead_id !== id) continue;
    out.push({ at: e.created_at, kind: 'enrollment', title: `Enrolled${e.rule_id ? ' by an auto-enrol rule' : ''}`, data: { id: e.id, sequence_id: e.sequence_id, sender_id: e.sender_id, rule_id: e.rule_id ?? null } });
    if (e.completed_at) out.push({ at: e.completed_at, kind: 'enrollment', title: `Enrollment ${String(e.status).replace(/_/g, ' ')}`, data: { id: e.id, sequence_id: e.sequence_id, reason: e.exit_reason ?? null, reason_text: e.exit_reason ? reasonText(e.exit_reason) : null } });
    if (e.held_at) out.push({ at: e.held_at, kind: 'enrollment', title: 'Held for review after a reply', data: { id: e.id, sequence_id: e.sequence_id } });
  }
  for (const t of rowsOf(store, 'outreach_tasks')) if (t.lead_id === id) out.push({ at: t.created_at, kind: 'task', title: t.title, data: { id: t.id, kind: t.kind, completed_at: t.completed_at ?? null, result: t.result ?? null } });
  for (const d of rowsOf(store, 'outreach_ai_route_decisions')) if (d.lead_id === id && d.decided_at) out.push({ at: d.decided_at, kind: 'ai_route', title: `AI routing → ${d.branch ?? '?'}`, data: { enrollment_id: d.enrollment_id, node_id: d.node_id, branch: d.branch, reason: d.reason, facts: d.facts } });
  for (const ms of rowsOf(store, 'outreach_lead_milestones')) if (ms.lead_id === id) out.push({ at: ms.at, kind: 'milestone', title: initcap(String(ms.kind)), data: { kind: ms.kind, source: ms.source, value: ms.value ?? null, sequence_id: ms.sequence_id ?? null } });
  const p = store.get('outreach_lead_profiles', id, 'lead_id');
  if (p?.enriched_at) out.push({ at: p.enriched_at, kind: 'enrichment', title: 'Profile enriched', data: { source: p.source ?? null, sender_id: p.enriched_by_sender ?? null, empty_sections: p.empty_sections ?? [] } });
  return out.sort((a, b) => (a.at == null ? 1 : b.at == null ? -1 : Date.parse(b.at) - Date.parse(a.at))).slice(0, 400);
}

function requestEnrichmentRpc(args: Row, ctx: Ctx) {
  wsGuard(ctx, args.p_ws);
  const ids: string[] = Array.isArray(args.p_lead_ids) ? args.p_lead_ids : [];
  if (!ids.length) return { queued: 0 };
  if (ids.length > 5000) demoError('E_TOO_MANY', 'max 5000 per request');
  return requestEnrichment(ctx.store, ctx.ws, ids, { wantPosts: !!args.p_want_posts, force: !!args.p_force, reason: args.p_reason ?? 'manual' });
}

const REPEATABLE = ['search_url', 'post_engagement', 'sn_saved_search', 'sn_lead_list', 'relations', 'company_people'];
const CADENCE_MS: Record<string, number> = { daily: 86_400_000, weekly: 7 * 86_400_000 };

function saveImportSchedule(args: Row, ctx: Ctx): string {
  const { store } = ctx;
  const p: Row = args.p ?? {};
  wsGuard(ctx, p.workspace_id);
  const kind = String(p.kind ?? '');
  if (!REPEATABLE.includes(kind)) demoError('E_PAYLOAD_INVALID', 'this source cannot repeat');
  if (!['daily', 'weekly', 'monthly'].includes(p.cadence)) demoError('E_PAYLOAD_INVALID', 'cadence must be daily, weekly or monthly');
  const sender = p.sender_id ? store.get('outreach_senders', p.sender_id) : undefined;
  if (!sender || sender.workspace_id !== ctx.ws || sender.provider !== 'LINKEDIN' || sender.deleted_at) demoError('E_NOT_FOUND', 'sender');
  if (store.t('outreach_import_schedules').filter((s) => s.workspace_id === ctx.ws && s.active).length >= 50) demoError('E_TOO_MANY', 'at most 50 repeating imports');
  if (p.id) {
    const cur = store.get('outreach_import_schedules', p.id);
    if (!cur || cur.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
    store.update('outreach_import_schedules', cur.id, {
      name: p.name ?? cur.name, cadence: p.cadence, active: p.active == null ? cur.active : !!p.active, params: p.params ?? cur.params,
      list_id: p.list_id || null, enrich: p.enrich == null ? cur.enrich : !!p.enrich,
    });
    return cur.id;
  }
  const now = Date.now();
  const next = p.cadence === 'monthly' ? (() => { const d = new Date(now); d.setMonth(d.getMonth() + 1); return d.getTime(); })() : now + CADENCE_MS[p.cadence];
  const label = kind.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  // the run that started with the schedule ("Runs now, then again on this rhythm") is its first job
  const first = store.t('outreach_import_jobs').filter((j) => j.workspace_id === ctx.ws && j.kind === kind && j.sender_id === sender.id && !j.schedule_id && now - Date.parse(j.created_at) < 60_000)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  const row = store.insert('outreach_import_schedules', {
    workspace_id: ctx.ws, client_id: p.client_id || null, sender_id: sender.id, name: (typeof p.name === 'string' && p.name.trim()) || `${label} (${p.cadence})`, kind,
    params: p.params ?? {}, list_id: p.list_id || null, tag_ids: Array.isArray(p.tag_ids) ? p.tag_ids : [], enrich: !!p.enrich, cadence: p.cadence, active: true,
    next_run_at: new Date(next).toISOString(), last_job_id: first?.id ?? null, last_run_at: first ? first.created_at : null, runs: first ? 1 : 0, created_by: ctx.userId,
  })[0];
  if (first) store.update('outreach_import_jobs', first.id, (j) => ({ schedule_id: row.id, params: { ...(j.params ?? {}), repeat_run: 1 } }));
  return row.id;
}

function sequenceChatIds(args: Row, ctx: Ctx): string[] {
  const { store } = ctx;
  const seq = store.get('outreach_sequences', String(args.p_sequence ?? ''));
  if (!seq || seq.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
  const enr = new Set(store.t('outreach_enrollments').filter((e) => e.sequence_id === seq.id).map((e) => e.id));
  const acts = new Set(store.t('outreach_actions').filter((a) => a.enrollment_id && enr.has(a.enrollment_id)).map((a) => a.id));
  const out = new Set<string>();
  for (const m of rowsOf(store, 'outreach_messages')) {
    const aid = m.action_id ?? m.replied_to_action_id;
    if (aid && acts.has(aid)) out.add(m.chat_id);
    if (out.size >= 5000) break;
  }
  return [...out];
}

function tableLayoutGet(args: Row, ctx: Ctx): unknown {
  wsGuard(ctx, args.p_ws);
  return ctx.store.t('outreach_table_layouts').find((t) => t.workspace_id === ctx.ws && t.user_id === ctx.userId && t.table_key === args.p_table)?.layout ?? null;
}

function tableLayoutSet(args: Row, ctx: Ctx): unknown {
  const { store } = ctx;
  wsGuard(ctx, args.p_ws);
  const table = String(args.p_table ?? '');
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(table)) demoError('E_PAYLOAD_INVALID', 'table');
  const layout = args.p_layout;
  const mine = (t: Row) => t.workspace_id === ctx.ws && t.user_id === ctx.userId && t.table_key === table;
  if (layout == null || (typeof layout === 'object' && !Array.isArray(layout) && Object.keys(layout).length === 0)) {
    store.remove('outreach_table_layouts', mine);
    return null;
  }
  if (typeof layout !== 'object' || Array.isArray(layout) || JSON.stringify(layout).length > 20000) demoError('E_PAYLOAD_INVALID', 'layout');
  const cur = store.t('outreach_table_layouts').find(mine);
  if (cur) store.update('outreach_table_layouts', (t) => t === cur, { layout, updated_at: ctx.now() });
  else store.insert('outreach_table_layouts', { user_id: ctx.userId, workspace_id: ctx.ws, table_key: table, layout, updated_at: ctx.now() }, { noId: true });
  return layout;
}

// ---------------------------------------------------------------------------
export const leadsRpc = {
  bulk_leads: bulkLeads,
  consent_grant: consentGrant,
  consent_list: consentList,
  consent_revoke: consentRevoke,
  identity_add: identityAdd,
  identity_list: identityList,
  identity_remove: (args, ctx) => {
    const i = identityOr404(ctx, args.p_id);
    ctx.store.remove('outreach_lead_identities', i.id);
    audit(ctx.store, ctx.ws, ctx.userId, 'identity.removed', 'lead', i.lead_id, { identity_id: i.id, provider: i.provider, identifier: i.identifier });
    return null;
  },
  identity_verify: (args, ctx) => {
    const i = identityOr404(ctx, args.p_id);
    ctx.store.update('outreach_lead_identities', i.id, { verified: true });
    audit(ctx.store, ctx.ws, ctx.userId, 'identity.verified', 'lead', i.lead_id, { identity_id: i.id, provider: i.provider });
    return null;
  },
  lead_custom_keys: leadCustomKeys,
  lead_queued_actions: leadQueuedActions,
  lead_timeline: leadTimeline,
  request_enrichment: requestEnrichmentRpc,
  save_import_schedule: saveImportSchedule,
  sequence_chat_ids: sequenceChatIds,
  table_layout_get: tableLayoutGet,
  table_layout_set: tableLayoutSet,
} satisfies RpcArea;

// ---------------------------------------------------------------------------
// Table hooks: the defaults, triggers and cascades of the leads tables, for the UI's own db.from() writes.
function duplicate(constraint: string): never {
  throw Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505' });
}

/** Profiles written by any area get the trigger-kept search columns before the leads list filters on them. */
function profileTexts(store: DemoStore) {
  for (const p of rowsOf(store, 'outreach_lead_profiles')) if (p.companies_text === undefined) profileSearchText(p);
}

/** Table hooks (insert defaults, side effects) for this area's tables. Called once at boot. */
export function registerLeads(): void {
  tableHooks.outreach_leads = {
    ...tableHooks.outreach_leads,
    readOnly: ['workspace_id', 'created_at'],
    beforeInsert: (row, store) => {
      const r = leadDefaults(row, row.workspace_id ?? DEMO_WS_ID);
      const same = store.t('outreach_leads').filter((l) => l.workspace_id === r.workspace_id);
      if (r.public_identifier && same.some((l) => l.public_identifier && String(l.public_identifier).toLowerCase() === r.public_identifier)) duplicate('outreach_leads_ws_pubid');
      if (!r.public_identifier && r.email_work && same.some((l) => !l.public_identifier && l.email_work === r.email_work)) duplicate('outreach_leads_ws_email');
      return r;
    },
    afterWrite: (kind, rows, store) => {
      if (kind === 'delete') cascadeLeadDelete(store, new Set(rows.map((r) => r.id)));
      else leadTriggers(store, rows);
    },
    beforeRead: (store) => { processDueEnrichment(store); profileTexts(store); },
  };
  tableHooks.outreach_lead_profiles = {
    ...tableHooks.outreach_lead_profiles,
    beforeRead: (store) => { processDueEnrichment(store); profileTexts(store); },
    afterWrite: (kind, rows) => { if (kind !== 'delete') for (const p of rows) profileSearchText(p); },
  };
  tableHooks.outreach_lead_tags = {
    ...tableHooks.outreach_lead_tags,
    beforeInsert: (row, store) => {
      if (store.t('outreach_lead_tags').some((t) => t.lead_id === row.lead_id && t.tag_id === row.tag_id)) duplicate('outreach_lead_tags_pkey');
      return { lead_id: row.lead_id, tag_id: row.tag_id };
    },
  };
  tableHooks.outreach_tags = {
    ...tableHooks.outreach_tags,
    beforeInsert: (row, store) => {
      const name = String(row.name ?? '').trim();
      const ws = row.workspace_id ?? DEMO_WS_ID;
      if (store.t('outreach_tags').some((t) => t.workspace_id === ws && String(t.name).toLowerCase() === name.toLowerCase())) duplicate('outreach_tags_workspace_id_name_key');
      return { color: null, ...row, workspace_id: ws, name };
    },
    afterWrite: (kind, rows, store) => {
      if (kind !== 'delete') return;
      const gone = new Set(rows.map((r) => r.id));
      store.remove('outreach_lead_tags', (t) => gone.has(t.tag_id));
    },
  };
  tableHooks.outreach_lists = {
    ...tableHooks.outreach_lists,
    beforeInsert: (row) => ({ client_id: null, ...row, workspace_id: row.workspace_id ?? DEMO_WS_ID, name: String(row.name ?? '').trim() }),
    afterWrite: (kind, rows, store) => {
      if (kind !== 'delete') return;
      const gone = new Set(rows.map((r) => r.id));
      for (const t of ['outreach_leads', 'outreach_import_jobs', 'outreach_import_schedules', 'outreach_auto_enroll_rules']) if (store.has(t)) store.update(t, (r) => gone.has(r.list_id), { list_id: null });
    },
  };
  tableHooks.outreach_stages = {
    ...tableHooks.outreach_stages,
    beforeInsert: (row, store) => {
      const ws = row.workspace_id ?? DEMO_WS_ID;
      const max = Math.max(-1, ...store.t('outreach_stages').filter((s) => s.workspace_id === ws).map((s) => Number(s.position ?? 0)));
      return { position: max + 1, color: null, kind: null, deal_value: null, ...row, workspace_id: ws };
    },
    afterWrite: (kind, rows, store) => {
      if (kind !== 'delete') return;
      const gone = new Set(rows.map((r) => r.id));
      store.update('outreach_leads', (l) => gone.has(l.stage_id), { stage_id: null });
    },
  };
  tableHooks.outreach_import_schedules = {
    ...tableHooks.outreach_import_schedules,
    afterWrite: (kind, rows, store) => {
      if (kind !== 'delete') return;
      const gone = new Set(rows.map((r) => r.id));
      store.update('outreach_import_jobs', (j) => gone.has(j.schedule_id), { schedule_id: null });
    },
  };
}
