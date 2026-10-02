/** Demo seed: suppressions, webhooks, API key, integrations, branding, notifications, audit log, alerts, billing. */
import type { DemoStore, Row } from '../store';
import { addInvoice, addMonths, slots, totalCents } from '../settings/billing';
import { hex } from '../settings/common';
import { CLIENT, DEMO_WS_ID, MEMBER, SENDER, SEQ, STAGE } from './ids';

const D = 86_400_000;
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function seedSettings(s: DemoStore, now: number): void {
  const ws = DEMO_WS_ID;
  const w = s.get('outreach_workspaces', ws);
  if (!w) return;

  // the real column is created_by
  s.update('outreach_invitations', (r) => r.workspace_id === ws, (r) => ({ created_by: r.created_by ?? r.invited_by ?? MEMBER.maya }), { silent: true });

  seedBilling(s, w, now);
  seedBranding(s, now);
  seedSuppressions(s, now);
  seedWebhooks(s, now);
  seedApiKey(s, now);
  seedIntegrations(s, now);
  seedNotifications(s, now);
  seedAlerts(s, now);
  seedAudit(s, now);
}

// ---------------------------------------------------------------------------
// billing: Scale · 12 accounts · Monthly, active, 3 paid invoices, the history of how it got there
// ---------------------------------------------------------------------------
function seedBilling(s: DemoStore, w: Row, now: number) {
  const p0 = now - 12 * D;                       // the current period started 12 days ago
  const period = (k: number) => addMonths(p0, k); // k = -1: the period before, …
  s.update('outreach_workspaces', w.id, {
    plan: 'scale', stripe_customer_id: 'cus_demo', stripe_subscription_id: 'sub_demo', stripe_status: 'active', past_due_since: null, trial_ends_at: null,
    billing_period: 'monthly', accounts_requested: 12, accounts_billed: 12, trial_account_limit: 1, current_period_start: iso(p0), current_period_end: iso(period(1)),
    cancel_at_period_end: false, cancelled_at: null, data_delete_after: null, scheduled_change: null, pending_payment: null, stripe_schedule_id: null, price_version: 'v1',
    early_supporter_tier: null, early_supporter_discount: 0, custom_price_id: null, billing_comp: false, plan_before_suspension: null, disputed_at: null, suspended_at: null,
  }, { silent: true });

  const change = (o: Row) => s.insert('outreach_billing_changes', {
    workspace_id: w.id, requested_by: MEMBER.maya, keep_sender_ids: null, error: null, expires_at: null, status: 'applied', immediate: null, scheduled: null, ...o,
  }, { silent: true });
  const st = (plan: string | null, accounts: number | null, p: string | null) => ({ plan, accounts_billed: accounts, billing_period: p });
  const checkoutAt = period(-5);
  change({ kind: 'checkout', from_state: st('trial', null, null), to_state: st('launch', 5, 'monthly'), immediate: { plan: 'launch', accounts: 5, period: 'monthly' },
    quote: { charge_today_cents: totalCents('launch', 'monthly', 5), next_invoice_cents: totalCents('launch', 'monthly', 5) }, stripe_invoice_id: 'in_demo_checkout', applied_at: iso(checkoutAt + 60_000), created_at: iso(checkoutAt) });
  const upAt = period(-3) + 9 * D;
  const left = (period(-2) - upAt) / (period(-2) - period(-3));
  change({ kind: 'change', from_state: st('launch', 5, 'monthly'), to_state: st('scale', 10, 'monthly'), immediate: { plan: 'scale', accounts: 10, period: 'monthly' },
    quote: { charge_today_cents: Math.round((totalCents('scale', 'monthly', 10) - totalCents('launch', 'monthly', 5)) * left), next_invoice_cents: totalCents('scale', 'monthly', 10) },
    stripe_invoice_id: 'in_demo_upgrade', applied_at: iso(upAt + 30_000), created_at: iso(upAt) });
  change({ kind: 'change', from_state: st('scale', 10, 'monthly'), to_state: st('scale', 12, 'monthly'), scheduled: { plan: 'scale', accounts: 12, period: 'monthly' },
    quote: { charge_today_cents: 0, next_invoice_cents: totalCents('scale', 'monthly', 12) }, stripe_invoice_id: null, applied_at: iso(p0), created_at: iso(p0 - 3 * D) });

  addInvoice(s, w, { at: period(-2), periodEnd: period(-1), plan: 'scale', accounts: 10, period: 'monthly', cents: totalCents('scale', 'monthly', 10), kind: 'renewal' });
  addInvoice(s, w, { at: period(-1), periodEnd: p0, plan: 'scale', accounts: 10, period: 'monthly', cents: totalCents('scale', 'monthly', 10), kind: 'renewal' });
  addInvoice(s, w, { at: p0, periodEnd: period(1), plan: 'scale', accounts: 12, period: 'monthly', cents: totalCents('scale', 'monthly', 12), kind: 'renewal' });

  // accounts connected per day (information only): the warm-up sender joined 9 days ago
  const sl = slots(s, w);
  for (let d = 59; d >= 0; d--) {
    const dayMs = now - d * D;
    const accounts = d > 9 ? sl.used - 1 : sl.used;
    const mailboxes = sl.mailboxes;
    s.insert('outreach_billing_usage', {
      workspace_id: w.id, day: iso(dayMs).slice(0, 10), accounts, accounts_billed: dayMs >= p0 ? 12 : 10, active_senders: accounts - mailboxes, active_mailboxes: mailboxes,
    }, { noId: true, silent: true });
  }

  // service-only secrets: a booking webhook secret and one email-finder key (only its last 4 characters are kept)
  s.insert('outreach_workspace_secrets', {
    workspace_id: w.id, llm_provider: null, llm_model: null, llm_key_enc: null, llm_key_hint: null,
    finder_keys: [{ provider: 'hunter', key_enc: 'demo:masked', hint: '7f3a' }], verifier: null, booking_secret: hex(s, 36),
    elevenlabs_key_enc: null, elevenlabs_key_hint: null, elevenlabs_webhook_secret_enc: null, elevenlabs_webhook_id: null, updated_at: iso(now - 40 * D),
  }, { noId: true, silent: true });
}

// ---------------------------------------------------------------------------
function seedBranding(s: DemoStore, now: number) {
  s.update('outreach_workspaces', DEMO_WS_ID, {
    branding: {
      product_name: 'Northwind Client Hub', accent: '#0f766e', support_email: 'support@northwind.example.com', help_url: 'https://help.northwind.example.com',
      email_from_name: 'Northwind Growth', email_from_address: 'reports@northwind.example.com', hide_platform_name: true,
    },
  }, { silent: true });
  s.insert('outreach_workspace_domains', {
    workspace_id: DEMO_WS_ID, client_id: null, hostname: 'reports.northwind.example.com', status: 'active', verification_token: hex(s, 32), cname_target: 'cname.vercel-dns.com',
    verified_at: iso(now - 58 * D), last_checked_at: iso(now - 2 * H), last_error: null, created_by: MEMBER.maya, created_at: iso(now - 60 * D),
  }, { silent: true });
}

// ---------------------------------------------------------------------------
function seedSuppressions(s: DemoStore, now: number) {
  type Sup = [kind: string, value: string, reason: string | null, source: string, client: string | null, seq: string | null, daysAgo: number];
  const rows: Sup[] = [
    ['domain', 'rivalstack.example.com', 'Competitor', 'manual', null, null, 88],
    ['domain', 'brightpath-partners.example.org', 'Existing partner', 'manual', null, null, 80],
    ['domain', 'oakhaven-media.example.net', 'Former client', 'csv', null, null, 74],
    ['domain', 'silverline-staffing.example.com', 'Asked not to be contacted', 'manual', null, null, 66],
    ['domain', 'meridian-dental-group.example.com', 'Already a client of Orchard Lane', 'manual', CLIENT.orchard, null, 61],
    ['domain', 'copperfield-labs.example.org', 'Investor portfolio company', 'csv', null, null, 55],
    ['domain', 'tessellate-ai.example.com', null, 'csv', null, null, 55],
    ['domain', 'wavelength-events.example.net', 'Event sponsor', 'manual', CLIENT.lumen, null, 42],
    ['domain', 'nordhaven-freight.example.com', 'Customer in HubSpot', 'crm:hubspot', null, null, 20],
    ['domain', 'pebblebrook-retail.example.org', 'Open deal in HubSpot', 'crm:hubspot', null, null, 6],
    ['email', 'jane.whitlock@example.com', 'Unsubscribed from an email', 'unsubscribe', null, null, 70],
    ['email', 'r.castellano@example.com', 'Asked to stop', 'manual', null, null, 58],
    ['email', 'procurement@example.com', 'Shared inbox', 'manual', null, null, 50],
    ['email', 'tom.ferreira@example.com', 'Unsubscribed from an email', 'unsubscribe', null, null, 33],
    ['email', 'lila.morrow@example.com', 'Bounced twice', 'manual', null, null, 27],
    ['email', 'office.manager@example.com', null, 'csv', CLIENT.orchard, null, 25],
    ['email', 'kai.brennan@example.com', 'Already in the webinar sequence', 'manual', null, SEQ.webinar, 18],
    ['email', 'dana.okoye@example.com', 'Unsubscribed from an email', 'unsubscribe', null, null, 4],
    ['company', 'harborline capital', 'Investor', 'manual', null, null, 85],
    ['company', 'quillfeather studio', 'Former client', 'csv', null, null, 74],
    ['company', 'greystone advisory', 'Partner agency', 'manual', null, null, 47],
    ['company', 'lanternfish analytics', 'Customer in HubSpot', 'crm:hubspot', null, null, 20],
    ['company', 'bellwether dental', 'Already a client of Orchard Lane', 'manual', CLIENT.orchard, null, 12],
    ['public_identifier', 'demo-avery-sallow', 'Asked to stop on LinkedIn', 'manual', null, null, 38],
    ['public_identifier', 'demo-noor-halvorsen', 'Works at a client', 'manual', CLIENT.lumen, null, 9],
  ];
  const created = (by: number) => (by % 3 === 0 ? MEMBER.sam : MEMBER.maya);
  rows.forEach(([kind, value, reason, source, client_id, sequence_id, daysAgo], i) => s.insert('outreach_suppressions', {
    workspace_id: DEMO_WS_ID, client_id, sequence_id, kind, value, reason, source, created_by: source.startsWith('crm:') || source === 'unsubscribe' ? null : created(i), created_at: iso(now - daysAgo * D - i * 7 * 60_000),
  }, { silent: true }));
}

// ---------------------------------------------------------------------------
function seedWebhooks(s: DemoStore, now: number) {
  const a = s.insert('outreach_outbound_webhooks', { workspace_id: DEMO_WS_ID, url: 'https://hooks.example.com/northwind/crm-bridge', secret: hex(s, 48), events: ['*'], active: true, failures: 0, created_at: iso(now - 80 * D) }, { silent: true })[0];
  const b = s.insert('outreach_outbound_webhooks', { workspace_id: DEMO_WS_ID, url: 'https://automation.example.net/catch/4821/replies', secret: hex(s, 48), events: ['message.received', 'meeting.booked', 'lead.unsubscribed'], active: true, failures: 2, created_at: iso(now - 35 * D) }, { silent: true })[0];

  const chats = new Map(s.t('outreach_chats').map((c) => [c.id, c]));
  const leads = new Map(s.t('outreach_leads').map((l) => [l.id, l]));
  type Ev = { at: number; hook: Row; event: string; data: Row; fail?: boolean; replayOf?: number };
  const evs: Ev[] = [];
  // replies of the last three weeks go to both endpoints
  const replies = s.t('outreach_messages').filter((m) => m.workspace_id === DEMO_WS_ID && m.direction === 'in' && Date.parse(m.sent_at ?? m.created_at) > now - 21 * D)
    .sort((x, y) => Date.parse(x.sent_at ?? x.created_at) - Date.parse(y.sent_at ?? y.created_at)).slice(-12);
  replies.forEach((m, i) => {
    const chat = chats.get(m.chat_id); const lead = chat ? leads.get(chat.lead_id) : undefined;
    const data = { id: m.id, chat_id: m.chat_id, lead_id: lead?.id ?? null, lead_name: lead?.full_name ?? null, provider: chat?.provider ?? null, text: m.text ?? null };
    const at = Date.parse(m.sent_at ?? m.created_at) + 20_000;
    evs.push({ at, hook: a, event: 'message.received', data });
    if (Date.parse(b.created_at) < at) evs.push({ at: at + 500, hook: b, event: 'message.received', data, fail: i === replies.length - 3 || i === replies.length - 5 });
  });
  // the latest sends go to the catch-all endpoint
  const sent = s.t('outreach_actions').filter((x) => x.workspace_id === DEMO_WS_ID && x.status === 'sent' && ['invite', 'message', 'email'].includes(x.action_type) && x.executed_at)
    .sort((x, y) => Date.parse(x.executed_at) - Date.parse(y.executed_at)).slice(-14);
  for (const x of sent) evs.push({ at: Date.parse(x.executed_at) + 5_000, hook: a, event: x.action_type === 'invite' ? 'invite.sent' : x.action_type === 'email' ? 'email.sent' : 'message.sent', data: { id: x.id, lead_id: x.lead_id, sender_id: x.sender_id, enrollment_id: x.enrollment_id, node_id: x.node_id } });
  evs.push({ at: now - 3 * D, hook: a, event: 'sequence.published', data: { id: SEQ.saas, name: s.get('outreach_sequences', SEQ.saas)?.name ?? 'Sequence', version: 3 } });
  evs.sort((x, y) => x.at - y.at);

  let id = 1;
  const failedIds: number[] = [];
  for (const e of evs) {
    const at = iso(e.at);
    const row: Row = { id: id++, webhook_id: e.hook.id, workspace_id: DEMO_WS_ID, event: e.event, payload: { event: e.event, workspace_id: DEMO_WS_ID, at, data: e.data }, replay_of: null, created_at: at, next_at: at };
    if (e.fail) Object.assign(row, { status: 500, attempts: 5, delivered_at: null, last_error: 'HTTP 500: the endpoint did not answer in time' });
    else Object.assign(row, { status: 200, attempts: 1, delivered_at: iso(e.at + 600 + (id % 7) * 130), last_error: null });
    s.insert('outreach_outbound_webhook_deliveries', row, { silent: true });
    if (e.fail) failedIds.push(row.id);
  }
  // one of the failures was replayed once the endpoint was fixed
  const first = s.t('outreach_outbound_webhook_deliveries').find((d) => d.id === failedIds[0]);
  if (first) {
    const at = Math.min(Date.parse(first.created_at) + 6 * H, now - 10 * 60_000);
    s.insert('outreach_outbound_webhook_deliveries', {
      id: id++, webhook_id: first.webhook_id, workspace_id: DEMO_WS_ID, event: first.event, payload: { ...first.payload, replayed: true, replay_of: first.id }, status: 200, attempts: 1,
      delivered_at: iso(at + 700), last_error: null, replay_of: first.id, created_at: iso(at), next_at: iso(at),
    }, { silent: true });
  }
}

// ---------------------------------------------------------------------------
function seedApiKey(s: DemoStore, now: number) {
  s.insert('outreach_api_keys', {
    workspace_id: DEMO_WS_ID, user_id: MEMBER.sam, name: 'Reporting sheet sync', prefix: `ok_live_${hex(s, 6)}`, key_hash: `demo:${hex(s, 16)}`, role: 'manager', client_ids: [],
    last_used_at: iso(now - 2 * H - 14 * 60_000), expires_at: null, revoked_at: null, created_at: iso(now - 50 * D),
  }, { silent: true });
}

// ---------------------------------------------------------------------------
function seedIntegrations(s: DemoStore, now: number) {
  const i = s.insert('outreach_integrations', {
    workspace_id: DEMO_WS_ID, provider: 'hubspot', status: 'active', account_label: 'Northwind Growth · Connected (demo)',
    settings: { sync_rule: 'replied', log_messages: true, create_deal_on_interested: true, suppress_customers: true }, field_mapping: {}, stage_mapping: {},
    last_event_id: 0, last_sync_at: iso(now - 25 * 60_000), last_pull_at: iso(now - 6 * H), last_error: null, created_by: MEMBER.maya, created_at: iso(now - 45 * D), updated_at: iso(now - 25 * 60_000),
  }, { silent: true })[0];
  s.insert('outreach_integration_secrets', { integration_id: i.id, access_token_enc: 'demo:masked', refresh_token_enc: 'demo:masked', expires_at: iso(now + 5 * H), instance_url: null, oauth_state: null, updated_at: iso(now - 25 * 60_000) }, { noId: true, silent: true });

  // the sync log: leads who replied are pushed (the default rule), notes for their replies, a deal for interested ones
  type L = { lead_id: string | null; direction: 'push' | 'pull'; op: string; status: 'ok' | 'skipped' | 'error'; detail: string | null; at: number };
  const log: L[] = [];
  const replied = s.t('outreach_leads').filter((l) => l.workspace_id === DEMO_WS_ID && l.last_replied_at && Date.parse(l.last_replied_at) > now - 44 * D)
    .sort((x, y) => Date.parse(x.last_replied_at) - Date.parse(y.last_replied_at)).slice(-14);
  replied.forEach((l, k) => {
    const at = Date.parse(l.last_replied_at) + 8 * 60_000;
    log.push({ lead_id: l.id, direction: 'push', op: 'contact.upsert', status: 'ok', detail: `${l.full_name} (${l.company ?? 'no company'})`, at });
    log.push({ lead_id: l.id, direction: 'push', op: 'note.create', status: 'ok', detail: 'Reply logged on the timeline', at: at + 2_000 });
    if (l.stage_id === STAGE.interested || l.stage_id === STAGE.meeting) log.push({ lead_id: l.id, direction: 'push', op: 'deal.create', status: 'ok', detail: `Deal for ${l.full_name}`, at: at + 4_000 });
    if (k === 4) log.push({ lead_id: l.id, direction: 'push', op: 'stage.update', status: 'error', detail: 'HubSpot rejected the lifecycle stage "salesqualifiedlead" for this contact: a contact cannot move back to an earlier stage.', at: at + 6_000 });
  });
  for (let d = 6; d >= 0; d -= 3) log.push({ lead_id: null, direction: 'pull', op: 'suppress.refresh', status: 'ok', detail: d === 0 ? 'Customer blacklist refreshed: 1 new company.' : 'Customer blacklist refreshed: nothing new.', at: now - d * D - 6 * H });
  log.push({ lead_id: null, direction: 'pull', op: 'list.import', status: 'ok', detail: 'Imported Webinar attendees (Q2): 18 leads (12 new, 6 already known), 2 without an email or LinkedIn URL.', at: now - 30 * D });
  log.sort((x, y) => x.at - y.at).forEach((r, k) => s.insert('outreach_crm_sync_log', { id: k + 1, integration_id: i.id, workspace_id: DEMO_WS_ID, lead_id: r.lead_id, direction: r.direction, op: r.op, status: r.status, detail: r.detail, at: iso(r.at) }, { noId: true, silent: true }));
}

// ---------------------------------------------------------------------------
function seedNotifications(s: DemoStore, now: number) {
  const prefs: Array<[string, string, boolean, number]> = [
    [MEMBER.maya, 'note_mention', true, 30], [MEMBER.maya, 'assigned', true, 10], [MEMBER.maya, 'ai_handoff', false, 10],
    [MEMBER.sam, 'note_mention', true, 10], [MEMBER.priya, 'note_mention', false, 60],
  ];
  for (const [user_id, kind, email, email_delay_min] of prefs) s.insert('outreach_notification_prefs', { user_id, workspace_id: DEMO_WS_ID, kind, push: true, email, email_delay_min, updated_at: iso(now - 20 * D) }, { noId: true, silent: true });
}

// ---------------------------------------------------------------------------
function seedAlerts(s: DemoStore, now: number) {
  const sam = s.get('outreach_senders', SENDER.li_sam);
  const dental = s.get('outreach_sequences', SEQ.dental);
  s.insert('outreach_alerts', [
    { workspace_id: DEMO_WS_ID, client_id: null, kind: 'sender_running_dry', entity: 'sender', entity_id: SENDER.li_sam, label: sam?.display_name ?? 'Sam Okafor',
      reason: `${sam?.display_name ?? 'Sam Okafor'} has 31 new lead(s) left: about 1.2 day(s) of work at its current allowance`, detail: { backlog: 31, per_day: 25, days_left: 1.2 },
      opened_at: iso(now - 5 * H), notified_at: iso(now - 5 * H + 60_000), resolved_at: null },
    { workspace_id: DEMO_WS_ID, client_id: CLIENT.orchard, kind: 'sequence_stalled', entity: 'sequence', entity_id: SEQ.dental, label: dental?.name ?? 'Dental practices',
      reason: 'Leo Moreau needs to sign in to LinkedIn again, so this sequence has no sender that can send right now.', detail: { causes: [{ code: 'sender_credentials', sender_id: SENDER.li_reconnect }], movable_leads: 18 },
      opened_at: iso(now - 7 * H), notified_at: iso(now - 7 * H + 60_000), resolved_at: null },
    { workspace_id: DEMO_WS_ID, client_id: CLIENT.lumen, kind: 'import_failed', entity: 'import', entity_id: idOfImport(s), label: 'Search url import',
      reason: 'Import failed: the saved search returned no results', detail: { fetched: 0 }, opened_at: iso(now - 4 * D), notified_at: iso(now - 4 * D + 60_000), resolved_at: iso(now - 1 * D) },
  ], { silent: true });
}
const idOfImport = (s: DemoStore): string => s.t('outreach_import_jobs').find((j) => j.workspace_id === DEMO_WS_ID)?.id ?? '00000000-0000-4000-8000-1b0000000001';

// ---------------------------------------------------------------------------
// the audit log: 50 entries over 60 days, written by the team, the system and the AI
// ---------------------------------------------------------------------------
function seedAudit(s: DemoStore, now: number) {
  const seqs = s.t('outreach_sequences').filter((q) => q.workspace_id === DEMO_WS_ID);
  const seq = (k: number) => seqs[k % Math.max(seqs.length, 1)];
  const sup = s.t('outreach_suppressions').filter((r) => r.workspace_id === DEMO_WS_ID);
  const hook = s.t('outreach_outbound_webhooks').find((h) => h.workspace_id === DEMO_WS_ID);
  const key = s.t('outreach_api_keys').find((k) => k.workspace_id === DEMO_WS_ID);
  const integ = s.t('outreach_integrations').find((k) => k.workspace_id === DEMO_WS_ID);
  const team = [MEMBER.maya, MEMBER.sam, MEMBER.priya, MEMBER.leo];
  const leads = s.t('outreach_leads');
  type A = [action: string, entity: string, entityId: string | null, diff: Row | null, actor: string | null, type: 'user' | 'system' | 'ai'];
  const make = (k: number): A => {
    const q = seq(k); const lead = leads[(k * 37) % leads.length];
    switch (k % 17) {
      case 0: return ['sequence.published', 'sequence', q?.id ?? null, { name: q?.name, version: 1 + (k % 4) }, team[k % 2], 'user'];
      case 1: return ['enrollment.started', 'enrollment', lead.id, { lead: lead.full_name, sequence: q?.name, count: 12 + (k % 30) }, team[k % 3], 'user'];
      case 2: return ['message.classified', 'message', lead.id, { intent: ['interested', 'not_now', 'question'][k % 3], lead: lead.full_name }, null, 'ai'];
      case 3: return ['sender.paused', 'sender', SENDER.li_paused, { reason: 'Client asked for a pause', by: 'Maya Chen' }, MEMBER.maya, 'user'];
      case 4: return ['suppression.added', 'suppression', null, { added: 1 + (k % 9), skipped: k % 2, source: sup[k % sup.length]?.source ?? 'manual' }, team[k % 2], 'user'];
      case 5: return ['lead.updated', 'lead', lead.id, { stage: 'Interested', lead: lead.full_name }, null, 'system'];
      case 6: return ['sequence.paused', 'sequence', SEQ.revive, { name: s.get('outreach_sequences', SEQ.revive)?.name }, MEMBER.sam, 'user'];
      case 7: return ['export.created', 'export', null, { kind: ['leads', 'messages', 'actions'][k % 3], rows: 400 + k * 3 }, MEMBER.maya, 'user'];
      case 8: return ['member.updated', 'member', MEMBER.leo, { role: 'member', client_ids: [CLIENT.orchard] }, MEMBER.maya, 'user'];
      case 9: return ['invite.accepted', 'lead', lead.id, { lead: lead.full_name }, null, 'system'];
      case 10: return ['webhook.replayed', 'webhook', hook?.id ?? null, { delivery: 3 + k }, MEMBER.sam, 'user'];
      case 11: return ['integration.settings', 'integration', integ?.id ?? null, { settings: { create_deal_on_interested: true } }, MEMBER.maya, 'user'];
      case 12: return ['meeting.booked', 'lead', lead.id, { lead: lead.full_name, provider: 'calendly' }, null, 'system'];
      case 13: return ['ai.line_approved', 'lead', lead.id, { variable: 'opener', lead: lead.full_name }, MEMBER.priya, 'user'];
      case 14: return ['sender.level_changed', 'sender', SENDER.li_maya, { from: 3, to: 4 }, null, 'system'];
      case 15: return ['api_key.used', 'api_key', key?.id ?? null, { endpoint: 'GET /v1/leads', status: 200 }, null, 'system'];
      default: return ['workspace.settings', 'workspace', DEMO_WS_ID, { timezone: 'America/New_York' }, MEMBER.maya, 'user'];
    }
  };
  // a few entries with fixed dates: they match the rows they describe
  const fixed: Array<[number, A]> = [
    [60 * D, ['workspace.domain_added', 'workspace', DEMO_WS_ID, { hostname: 'reports.northwind.example.com' }, MEMBER.maya, 'user']],
    [50 * D, ['api_key.created', 'api_key', key?.id ?? null, { name: key?.name, role: 'manager', client_ids: [] }, MEMBER.sam, 'user']],
    [45 * D, ['integration.connected', 'integration', integ?.id ?? null, { provider: 'hubspot', account: 'HubSpot (demo)' }, MEMBER.maya, 'user']],
    [35 * D, ['webhook.created', 'webhook', s.t('outreach_outbound_webhooks')[1]?.id ?? null, { url: s.t('outreach_outbound_webhooks')[1]?.url, events: s.t('outreach_outbound_webhooks')[1]?.events }, MEMBER.sam, 'user']],
    [12 * D, ['billing.changed', 'workspace', DEMO_WS_ID, { to: { plan: 'scale', accounts_billed: 12, billing_period: 'monthly' } }, MEMBER.maya, 'user']],
    [2 * D, ['member.invited', 'invitation', s.t('outreach_invitations')[0]?.id ?? null, { email: 'jordan.ashford@example.com', role: 'member', emailed: true }, MEMBER.maya, 'user']],
  ];
  const entries: Array<{ at: number; a: A }> = fixed.map(([ago, a], k) => ({ at: now - ago - k * 13 * 60_000, a }));
  for (let k = 0; entries.length < 50; k++) entries.push({ at: now - Math.round(((k * 7919) % 5900) / 100 * D) - (k % 11) * H - 3 * 60_000, a: make(k) });
  entries.sort((x, y) => x.at - y.at).forEach(({ at, a: [action, entity, entity_id, diff, actor, actor_type] }, k) => s.insert('outreach_audit_log', {
    id: k + 1, workspace_id: DEMO_WS_ID, actor, actor_type, action, entity, entity_id, diff, at: iso(at),
  }, { silent: true }));
}
