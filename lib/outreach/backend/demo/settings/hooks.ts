/**
 * Database defaults and triggers of the settings tables (what the real DB fills when the UI writes through `db.from`),
 * plus the simulated event stream: sends and replies of the simulator fan out to the workspace's outbound webhooks
 * (`outreach_emit_event`) and to a connected CRM's sync log, like the real workers do.
 */
import { simHooks } from '../sim/engine';
import type { DemoStore, Row } from '../store';
import { refreshUsage } from './billing';
import { addHooks, defaults, hex, lowerTrim, nextNum } from './common';

const SET_NULL_ON_CLIENT_DELETE = ['outreach_senders', 'outreach_lists', 'outreach_leads', 'outreach_import_jobs', 'outreach_sequences', 'outreach_chats', 'outreach_tasks', 'outreach_alerts', 'outreach_import_schedules', 'outreach_profile_templates', 'outreach_chat_notes', 'outreach_webchat_inboxes'];
const CASCADE_ON_CLIENT_DELETE = ['outreach_suppressions', 'outreach_report_schedules', 'outreach_workspace_domains'];
const MAX_DELIVERIES = 400;
const MAX_SYNC_LOG = 300;

const iso = (ms: number) => new Date(ms).toISOString();

/** `outreach_emit_event`: one delivery per active webhook that listens to the event. Deliveries succeed (200) in the demo. */
export function emitEvent(store: DemoStore, ws: string, event: string, data: Row, at = store.nowIso()): number {
  const hooks = store.t('outreach_outbound_webhooks').filter((w) => w.workspace_id === ws && w.active && Array.isArray(w.events) && (w.events.includes(event) || w.events.includes('*')));
  if (!hooks.length) return 0;
  let id = nextNum(store, 'outreach_outbound_webhook_deliveries');
  const delivered = iso(Date.parse(at) + 400 + Math.floor(store.random() * 900));
  for (const w of hooks) {
    store.insert('outreach_outbound_webhook_deliveries', {
      id: id++, webhook_id: w.id, workspace_id: ws, event, payload: { event, workspace_id: ws, at, data }, status: 200, attempts: 1,
      next_at: at, delivered_at: delivered, last_error: null, replay_of: null, created_at: at,
    });
  }
  const all = store.t('outreach_outbound_webhook_deliveries');
  const mine = all.filter((d) => d.workspace_id === ws);
  if (mine.length > MAX_DELIVERIES) {
    const drop = new Set(mine.sort((a, b) => a.id - b.id).slice(0, mine.length - MAX_DELIVERIES));
    store.remove('outreach_outbound_webhook_deliveries', (d) => drop.has(d), { silent: true });
  }
  return hooks.length;
}

/** One sync log row of a connected CRM (`outreach_crm_sync_log`). */
export function syncLog(store: DemoStore, integ: Row, row: { lead_id: string | null; direction: 'push' | 'pull'; op: string; status: 'ok' | 'skipped' | 'error'; detail: string | null; at?: string }): void {
  store.insert('outreach_crm_sync_log', { id: nextNum(store, 'outreach_crm_sync_log'), integration_id: integ.id, workspace_id: integ.workspace_id, ...row, at: row.at ?? store.nowIso() }, { noId: true });
  const rows = store.t('outreach_crm_sync_log').filter((r) => r.integration_id === integ.id);
  if (rows.length > MAX_SYNC_LOG) {
    const drop = new Set(rows.sort((a, b) => a.id - b.id).slice(0, rows.length - MAX_SYNC_LOG));
    store.remove('outreach_crm_sync_log', (r) => drop.has(r), { silent: true });
  }
}

const SENT_EVENT: Record<string, string> = { invite: 'invite.sent', message: 'message.sent', inmail: 'message.sent', email: 'email.sent', new_chat: 'message.sent' };

let simRegistered = false;
function registerSimHooks(): void {
  if (simRegistered) return;
  simRegistered = true;
  simHooks.onSent.push((store, action) => {
    const ev = SENT_EVENT[String(action.action_type)];
    if (!ev || !action.workspace_id) return;
    emitEvent(store, action.workspace_id, ev, { id: action.id, lead_id: action.lead_id, sender_id: action.sender_id, enrollment_id: action.enrollment_id, node_id: action.node_id }, action.executed_at ?? store.nowIso());
  });
  simHooks.onReply.push((store, { chat, message, lead, intent }) => {
    const ws = chat.workspace_id ?? lead?.workspace_id;
    if (!ws) return;
    const data = { id: message.id, chat_id: chat.id, lead_id: lead?.id ?? chat.lead_id ?? null, lead_name: lead?.full_name ?? null, provider: chat.provider, text: message.text ?? null };
    emitEvent(store, ws, 'message.received', data, message.created_at ?? message.sent_at ?? store.nowIso());
    if (intent) emitEvent(store, ws, 'message.classified', { ...data, intent });
    // a connected CRM pushes leads who replied (the default sync rule)
    for (const integ of store.t('outreach_integrations')) {
      if (integ.workspace_id !== ws || integ.status !== 'active' || !lead) continue;
      const name = lead.full_name ?? 'Lead';
      syncLog(store, integ, { lead_id: lead.id, direction: 'push', op: 'contact.upsert', status: 'ok', detail: `${name} (${lead.company ?? 'no company'})` });
      if (integ.settings?.log_messages !== false) syncLog(store, integ, { lead_id: lead.id, direction: 'push', op: 'note.create', status: 'ok', detail: 'Reply logged on the timeline' });
      if (intent === 'interested' && integ.settings?.create_deal_on_interested) syncLog(store, integ, { lead_id: lead.id, direction: 'push', op: 'deal.create', status: 'ok', detail: `Deal for ${name}` });
      store.update('outreach_integrations', integ.id, { last_sync_at: store.nowIso() }, { silent: true });
    }
  });
}

export function registerSettingsHooks(): void {
  addHooks('outreach_clients', {
    beforeInsert: (r, store) => {
      defaults(r, { settings: {}, slug: null, timezone: null });
      if (r.slug && store.t('outreach_clients').some((c) => c.workspace_id === r.workspace_id && c.slug === r.slug)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "outreach_clients_workspace_id_slug_key"'), { code: '23505' });
      }
      return r;
    },
    afterWrite: (kind, rows, store) => {
      if (kind !== 'delete') return;
      const ids = new Set(rows.map((r) => r.id));
      for (const t of SET_NULL_ON_CLIENT_DELETE) if (store.has(t)) store.update(t, (x) => x.client_id != null && ids.has(x.client_id), { client_id: null });
      for (const t of CASCADE_ON_CLIENT_DELETE) if (store.has(t)) store.remove(t, (x) => x.client_id != null && ids.has(x.client_id));
      store.update('outreach_members', (m) => Array.isArray(m.client_ids) && m.client_ids.some((c: string) => ids.has(c)), (m) => ({ client_ids: m.client_ids.filter((c: string) => !ids.has(c)) }));
    },
  });

  addHooks('outreach_invitations', {
    beforeInsert: (r, store) => defaults({ ...r, email: lowerTrim(r.email) }, {
      role: 'member', client_ids: [], token: () => hex(store, 48), expires_at: () => iso(Date.now() + 7 * 86_400_000), accepted_at: null, created_by: null,
    }),
  });

  addHooks('outreach_suppressions', {
    beforeInsert: (r) => defaults({ ...r, value: lowerTrim(r.value) }, { client_id: null, sequence_id: null, reason: null, source: 'manual', created_by: null }),
  });

  addHooks('outreach_outbound_webhooks', {
    beforeInsert: (r, store) => defaults(r, { secret: () => hex(store, 48), events: [], active: true, failures: 0 }),
    afterWrite: (kind, rows, store) => {
      if (kind !== 'delete') return;
      const ids = new Set(rows.map((r) => r.id));
      store.remove('outreach_outbound_webhook_deliveries', (d) => ids.has(d.webhook_id));
    },
  });

  addHooks('outreach_api_keys', {
    beforeInsert: (r, store) => defaults(r, { role: 'member', client_ids: [], last_used_at: null, expires_at: null, revoked_at: null, key_hash: () => `demo:${hex(store, 16)}`, prefix: 'ok_demo_' }),
    readOnly: ['key_hash'],
  });

  addHooks('outreach_integrations', {
    beforeInsert: (r) => defaults(r, {
      status: 'connecting', account_label: null, settings: () => ({ sync_rule: 'replied', log_messages: true, create_deal_on_interested: false, suppress_customers: false }),
      field_mapping: {}, stage_mapping: {}, last_event_id: 0, last_sync_at: null, last_pull_at: null, last_error: null, created_by: null,
    }),
    afterWrite: (kind, rows, store) => {
      if (kind !== 'delete') return;
      const ids = new Set(rows.map((r) => r.id));
      store.remove('outreach_crm_sync_log', (l) => ids.has(l.integration_id));
      store.remove('outreach_integration_secrets', (l) => ids.has(l.integration_id));
    },
  });

  addHooks('outreach_audit_log', {
    beforeInsert: (r, store) => defaults(r, { id: () => nextNum(store, 'outreach_audit_log'), actor: null, actor_type: 'user', entity: null, entity_id: null, diff: null, at: () => store.nowIso() }),
  });
  addHooks('outreach_crm_sync_log', {
    beforeInsert: (r, store) => defaults(r, { id: () => nextNum(store, 'outreach_crm_sync_log'), lead_id: null, detail: null, at: () => store.nowIso() }),
  });
  addHooks('outreach_alerts', {
    beforeInsert: (r, store) => defaults(r, { client_id: null, label: null, detail: {}, opened_at: () => store.nowIso(), notified_at: null, resolved_at: null }),
  });

  // plan, accounts and every Stripe field are written by billing, never by the browser (column grants since 057)
  addHooks('outreach_workspaces', {
    readOnly: ['plan', 'stripe_customer_id', 'stripe_subscription_id', 'stripe_status', 'past_due_since', 'trial_ends_at', 'billing_period', 'accounts_requested', 'accounts_billed',
      'trial_account_limit', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'cancelled_at', 'data_delete_after', 'scheduled_change', 'pending_payment',
      'price_version', 'billing_comp', 'custom_price_id', 'branding', 'created_by', 'deleted_at', 'plan_before_suspension', 'disputed_at', 'suspended_at'],
  });

  addHooks('outreach_billing_usage', { beforeRead: (store) => refreshUsage(store) });

  registerSimHooks();
}
