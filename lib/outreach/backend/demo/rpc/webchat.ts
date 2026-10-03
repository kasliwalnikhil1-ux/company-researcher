/**
 * Demo handlers: Website agent: inboxes (websites) and their settings, canned replies, campaigns, blocks, report, voice.
 * Owns: hub_voice_calls, hub_voice_state, webchat_block, webchat_campaign_delete, webchat_campaign_save, webchat_canned_delete, webchat_canned_save, webchat_conversation_update, webchat_default_settings, webchat_inbox_create, webchat_inbox_delete, webchat_inbox_get, webchat_inbox_regenerate_hmac, webchat_inbox_set_members, webchat_inbox_update, webchat_inboxes, webchat_mailboxes, webchat_report, webchat_settings_history, webchat_settings_restore, webchat_unblock
 *
 * Shapes follow the last migration defining each outreach_<name> (051, 053, 060, 063, 068, 069). The live widget
 * preview and the Voice tab's sample call live in ../webchat (widget.ts, voice.ts).
 */
import { demoError, type Ctx, type RpcArea, type RpcHandler } from '../ctx';
import type { Row } from '../store';
import { postCsat, systemEvent } from '../webchat/chat';
import {
  DEFAULT_SETTINGS, T, agentName, checkSettings, inboxJson, inboxOr404, merge, productsFix, randHex, validTimeZone, websiteLimit,
} from '../webchat/core';
import { webchatReport } from '../webchat/report';
import { callJson, installSampleVoice, voicePool, voiceState } from '../webchat/voice';
import { bindWidgetCtx, installWidgetBridge } from '../webchat/widget';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const DOMAIN = /^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+(:[0-9]+)?$/;

/** Every handler binds the context the live preview bridge uses (a website screen always calls one of these first). */
const h = (fn: RpcHandler): RpcHandler => (args, ctx) => { bindWidgetCtx(ctx); return fn(args, ctx); };

function cleanDomains(list: unknown): string[] {
  const out = new Set<string>();
  for (const x of Array.isArray(list) ? list : []) {
    const d = String(x ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
    if (!d) continue;
    if (!DOMAIN.test(d) && d !== 'localhost') demoError('E_PAYLOAD_INVALID', `domain ${d}`);
    out.add(d);
  }
  return [...out];
}

/** outreach_webchat_inbox_update (053 + 068 products_fix + 069 voice check). */
function updateInbox(ctx: Ctx, id: string, patch: Row): Row {
  const s = ctx.store;
  const i = { ...inboxOr404(ctx, id) };
  const p = patch ?? {};
  if ('name' in p) { i.name = String(p.name ?? '').trim().slice(0, 80); if (!i.name) demoError('E_PAYLOAD_INVALID', 'name'); }
  if ('allowed_domains' in p) i.allowed_domains = cleanDomains(p.allowed_domains);
  if ('client_id' in p) {
    if (p.client_id != null && !s.get('outreach_clients', p.client_id)) demoError('E_NOT_FOUND', 'Client not found');
    i.client_id = p.client_id ?? null;
    s.update('outreach_senders', i.sender_id, { client_id: i.client_id });
    s.update('outreach_chats', (c) => c.webchat_inbox_id === i.id, { client_id: i.client_id });
  }
  if ('is_active' in p && p.is_active != null) i.is_active = !!p.is_active;
  if ('ai_enabled' in p && p.ai_enabled != null) i.ai_enabled = !!p.ai_enabled;
  if ('enforce_identity' in p && p.enforce_identity != null) i.enforce_identity = !!p.enforce_identity;
  if ('reply_mailbox_id' in p) {
    const mb = p.reply_mailbox_id ?? null;
    if (mb) { const snd = s.get('outreach_senders', mb); if (!snd || snd.workspace_id !== ctx.ws || !['GMAIL', 'OUTLOOK', 'IMAP'].includes(snd.provider) || snd.deleted_at) demoError('E_PAYLOAD_INVALID', 'reply_mailbox_id'); }
    i.reply_mailbox_id = mb;
  }
  if ('business_hours' in p) {
    const bh = p.business_hours ?? {};
    if (bh.tz && !validTimeZone(String(bh.tz))) demoError('E_PAYLOAD_INVALID', 'timezone');
    i.business_hours = bh;
  }
  if ('settings' in p && p.settings) {
    let ns = merge(i.settings ?? {}, p.settings);
    checkSettings(merge(DEFAULT_SETTINGS, ns));
    ns = productsFix(s, ctx.ws, ns, p);
    i.settings = ns;
  }
  i.config_version = (i.config_version ?? 1) + 1;
  s.update(T.inboxes, i.id, {
    name: i.name, allowed_domains: i.allowed_domains, client_id: i.client_id ?? null, is_active: i.is_active, ai_enabled: i.ai_enabled, enforce_identity: i.enforce_identity,
    reply_mailbox_id: i.reply_mailbox_id ?? null, business_hours: i.business_hours ?? {}, settings: i.settings ?? {}, config_version: i.config_version,
  });
  s.update('outreach_senders', i.sender_id, { display_name: i.name, status: i.is_active ? 'ok' : 'paused' });
  s.insert(T.history, { inbox_id: i.id, version: i.config_version, settings: JSON.parse(JSON.stringify(i.settings ?? {})), business_hours: i.business_hours ?? {}, allowed_domains: i.allowed_domains ?? [], changed_by: ctx.userId, diff: p, at: iso() });
  return inboxJson(ctx, s.get(T.inboxes, i.id)!);
}

export const webchatRpc = {
  webchat_default_settings: h(() => JSON.parse(JSON.stringify(DEFAULT_SETTINGS))),

  webchat_inboxes: h((a, ctx) => ctx.store.t(T.inboxes).filter((i) => i.workspace_id === (a.p_ws ?? ctx.ws) && !i.deleted_at)
    .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at))).map((i) => inboxJson(ctx, i))),

  webchat_inbox_get: h((a, ctx) => inboxJson(ctx, inboxOr404(ctx, a.p_id))),

  webchat_inbox_create: h((a, ctx) => {
    const s = ctx.store, ws = a.p_ws ?? ctx.ws;
    const name = String(a.p_name ?? '').trim().slice(0, 80);
    if (!name) demoError('E_PAYLOAD_INVALID', 'name');
    if (a.p_client && !s.get('outreach_clients', a.p_client)) demoError('E_NOT_FOUND', 'Client not found');
    const lim = websiteLimit(s, ws);
    if (lim != null && s.t(T.inboxes).filter((i) => i.workspace_id === ws && !i.deleted_at).length >= lim) demoError('E_PLAN_LIMIT', `website inboxes on this plan: ${lim}`);
    const domains = cleanDomains(a.p_domains);
    const sender = s.insert('outreach_senders', {
      workspace_id: ws, client_id: a.p_client ?? null, owner_user_id: ctx.userId, owner_email: null, provider: 'WEBCHAT', unipile_account_id: null, auth_method: 'oauth', display_name: name, label: null,
      status: 'ok', status_reason: null, deleted_at: null, timezone: 'UTC', schedule: {}, warmup_level: 5, health_score: 100, health_breakdown: {}, manual_caps: {}, connections_count: null,
      is_premium: false, has_sales_nav: false, has_recruiter: false, connected_at: iso(), last_ok_at: iso(),
    })[0];
    const inbox = s.insert(T.inboxes, {
      workspace_id: ws, client_id: a.p_client ?? null, sender_id: sender.id, name, website_token: randHex(s, 16), hmac_token: randHex(s, 24), enforce_identity: false, allowed_domains: domains,
      settings: { appearance: { brand_name: name.slice(0, 20) } }, config_version: 1, ai_enabled: false, reply_mailbox_id: null, business_hours: {}, is_active: true, installed_origins: {},
      created_by: ctx.userId, deleted_at: null,
    })[0];
    s.insert(T.members, { inbox_id: inbox.id, user_id: ctx.userId, auto_assign: true, last_assigned_at: null });
    s.insert(T.history, { inbox_id: inbox.id, version: 1, settings: inbox.settings, business_hours: {}, allowed_domains: domains, changed_by: ctx.userId, diff: { created: true }, at: iso() });
    return inboxJson(ctx, inbox);
  }),

  webchat_inbox_update: h((a, ctx) => updateInbox(ctx, String(a.p_id), a.p_patch ?? {})),

  webchat_inbox_set_members: h((a, ctx) => {
    const s = ctx.store, i = inboxOr404(ctx, a.p_id);
    const want: Row[] = Array.isArray(a.p_members) ? a.p_members : [];
    const ok = want.filter((m) => s.t('outreach_members').some((x) => x.workspace_id === i.workspace_id && x.user_id === m.user_id && x.role !== 'client_viewer'));
    s.remove(T.members, (m) => m.inbox_id === i.id && !ok.some((x) => x.user_id === m.user_id));
    for (const m of ok) s.upsert(T.members, { inbox_id: i.id, user_id: m.user_id, auto_assign: m.auto_assign !== false }, ['inbox_id', 'user_id']);
    return inboxJson(ctx, i);
  }),

  webchat_inbox_regenerate_hmac: h((a, ctx) => {
    const i = inboxOr404(ctx, a.p_id);
    ctx.store.update(T.inboxes, i.id, (x) => ({ hmac_token: randHex(ctx.store, 24), config_version: (x.config_version ?? 1) + 1 }));
    return inboxJson(ctx, ctx.store.get(T.inboxes, i.id)!);
  }),

  webchat_inbox_delete: h((a, ctx) => {
    const i = inboxOr404(ctx, a.p_id);
    ctx.store.update(T.inboxes, i.id, { deleted_at: iso(), is_active: false });
    ctx.store.update('outreach_senders', i.sender_id, { status: 'disabled', deleted_at: iso() });
    ctx.store.remove(T.voiceAgents, (x) => x.inbox_id === i.id);
    return null;
  }),

  webchat_settings_history: h((a, ctx) => {
    const i = inboxOr404(ctx, a.p_inbox);
    return ctx.store.t(T.history).filter((x) => x.inbox_id === i.id).sort((x, y) => y.version - x.version).slice(0, 50)
      .map((x) => ({ version: x.version, at: x.at ?? x.created_at, changed_by: x.changed_by ?? null, by: agentName(ctx.store, i.workspace_id, x.changed_by), diff: x.diff ?? null }));
  }),

  webchat_settings_restore: h((a, ctx) => {
    const i = inboxOr404(ctx, a.p_inbox);
    const v = ctx.store.t(T.history).find((x) => x.inbox_id === i.id && x.version === Number(a.p_version));
    if (!v) demoError('E_NOT_FOUND', 'Version not found');
    // the stored settings replace the current ones whole (the merge in update keeps nothing that the version lacks)
    ctx.store.update(T.inboxes, i.id, { settings: {} });
    return updateInbox(ctx, i.id, { settings: JSON.parse(JSON.stringify(v!.settings ?? {})), business_hours: v!.business_hours ?? {}, allowed_domains: v!.allowed_domains ?? [], restored_from: v!.version });
  }),

  webchat_block: h((a, ctx) => {
    const i = inboxOr404(ctx, a.p_inbox), kind = String(a.p_kind ?? ''), raw = String(a.p_value ?? '').trim();
    if (!['visitor', 'ip_hash', 'country'].includes(kind) || !raw) demoError('E_PAYLOAD_INVALID');
    const value = kind === 'country' ? raw.toUpperCase() : raw;
    if (!ctx.store.t(T.blocks).some((b) => b.inbox_id === i.id && b.kind === kind && b.value === value)) {
      ctx.store.insert(T.blocks, { inbox_id: i.id, kind, value, note: a.p_note ? String(a.p_note).slice(0, 300) : null, created_by: ctx.userId });
    }
    if (kind === 'visitor') ctx.store.update(T.visitors, (v) => v.id === value && v.inbox_id === i.id, (v) => ({ blocked_at: iso(), token_version: (v.token_version ?? 1) + 1 }));
    return null;
  }),

  webchat_unblock: h((a, ctx) => {
    const i = inboxOr404(ctx, a.p_inbox), kind = String(a.p_kind ?? ''), raw = String(a.p_value ?? '').trim();
    const value = kind === 'country' ? raw.toUpperCase() : raw;
    ctx.store.remove(T.blocks, (b) => b.inbox_id === i.id && b.kind === kind && b.value === value);
    if (kind === 'visitor') ctx.store.update(T.visitors, (v) => v.id === value && v.inbox_id === i.id, { blocked_at: null });
    return null;
  }),

  webchat_canned_save: h((a, ctx) => {
    const s = ctx.store, ws = a.p_ws ?? ctx.ws;
    const sc = String(a.p_short_code ?? '').trim().replace(/^\//, '').toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(sc)) demoError('E_PAYLOAD_INVALID', 'short_code');
    const content = String(a.p_content ?? '');
    if (!content.trim() || content.length > 5000) demoError('E_PAYLOAD_INVALID', 'content');
    const owner = a.p_personal ? ctx.userId : null;
    if (!a.p_id) {
      const ex = s.t(T.canned).find((r) => r.workspace_id === ws && (r.owner_id ?? null) === owner && String(r.short_code).toLowerCase() === sc);
      if (ex) return s.update(T.canned, ex.id, { content })[0];
      return s.insert(T.canned, { workspace_id: ws, owner_id: owner, short_code: sc, content, created_by: ctx.userId, updated_at: iso() })[0];
    }
    const r = s.get(T.canned, a.p_id);
    if (!r || r.workspace_id !== ws || (r.owner_id && r.owner_id !== ctx.userId)) demoError('E_NOT_FOUND', 'Canned response not found');
    if (s.t(T.canned).some((x) => x.id !== r!.id && x.workspace_id === ws && (x.owner_id ?? null) === owner && String(x.short_code).toLowerCase() === sc)) demoError('E_CONFLICT', `/${sc} already exists`);
    return s.update(T.canned, r!.id, { short_code: sc, content, owner_id: owner, updated_at: iso() })[0];
  }),

  webchat_canned_delete: h((a, ctx) => {
    const r = ctx.store.get(T.canned, a.p_id);
    if (!r || (r.owner_id && r.owner_id !== ctx.userId)) demoError('E_NOT_FOUND', 'Canned response not found');
    ctx.store.remove(T.canned, r!.id);
    return null;
  }),

  webchat_campaign_save: h((a, ctx) => {
    const s = ctx.store, i = inboxOr404(ctx, a.p_inbox), r: Row = a.p_row ?? {};
    if (!String(r.title ?? '').trim() || !String(r.message ?? '').trim()) demoError('E_PAYLOAD_INVALID');
    const qr = (Array.isArray(r.quick_replies) ? r.quick_replies : []).map((x: unknown) => String(x).slice(0, 60));
    let out: Row;
    if (!a.p_id) {
      out = s.insert(T.campaigns, { inbox_id: i.id, title: String(r.title).slice(0, 120), message: String(r.message).slice(0, 1000), sender_kind: r.sender_kind ?? 'bot', sender_user_id: r.sender_user_id ?? null,
        quick_replies: qr, rules: r.rules ?? {}, frequency: r.frequency ?? 'once', display: r.display ?? 'popup', enabled: r.enabled !== false, shown: 0, clicked: 0, started: 0, updated_at: iso() })[0];
    } else {
      const c = s.get(T.campaigns, a.p_id);
      if (!c || c.inbox_id !== i.id) demoError('E_NOT_FOUND', 'Campaign not found');
      out = s.update(T.campaigns, c!.id, (x) => ({ title: String(r.title).slice(0, 120), message: String(r.message).slice(0, 1000), sender_kind: r.sender_kind ?? x.sender_kind, sender_user_id: r.sender_user_id ?? null,
        quick_replies: qr, rules: r.rules ?? x.rules, frequency: r.frequency ?? x.frequency, display: r.display ?? x.display, enabled: r.enabled ?? x.enabled, updated_at: iso() }))[0];
    }
    s.update(T.inboxes, i.id, (x) => ({ config_version: (x.config_version ?? 1) + 1 }));
    return out;
  }),

  webchat_campaign_delete: h((a, ctx) => {
    const c = ctx.store.get(T.campaigns, a.p_id);
    if (!c) demoError('E_NOT_FOUND', 'Campaign not found');
    const i = inboxOr404(ctx, c!.inbox_id);
    ctx.store.remove(T.campaigns, c!.id);
    ctx.store.update(T.inboxes, i.id, (x) => ({ config_version: (x.config_version ?? 1) + 1 }));
    return null;
  }),

  // {status, snoozed_until, assigned_to, priority, labels, custom_attributes, mark_unread}
  webchat_conversation_update: h((a, ctx) => {
    const s = ctx.store, p: Row = a.p_patch ?? {};
    const c0 = s.get('outreach_chats', a.p_chat);
    if (!c0 || c0.provider !== 'WEBCHAT' || c0.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Conversation not found');
    const c: Row = { ...c0 };
    const who = agentName(s, c.workspace_id, ctx.userId);
    if ('assigned_to' in p) {
      if (p.assigned_to && !s.t('outreach_members').some((m) => m.workspace_id === c.workspace_id && m.user_id === p.assigned_to)) demoError('E_PAYLOAD_INVALID', 'assignee');
      if ((p.assigned_to ?? null) !== (c.assigned_to ?? null)) {
        c.assigned_to = p.assigned_to ?? null;
        systemEvent(s, c0!, { kind: c.assigned_to ? 'assigned' : 'unassigned', agent: c.assigned_to ? agentName(s, c.workspace_id, c.assigned_to) : null, by: who });
      }
    }
    if ('priority' in p) { if (p.priority != null && !['urgent', 'high', 'medium', 'low'].includes(p.priority)) demoError('E_PAYLOAD_INVALID', 'priority'); c.priority = p.priority ?? null; }
    if ('labels' in p) c.labels = [...new Set((Array.isArray(p.labels) ? p.labels : []).map((x: unknown) => String(x).trim().slice(0, 40)).filter(Boolean))].slice(0, 50);
    if ('custom_attributes' in p) c.custom_attributes = p.custom_attributes ?? {};
    let resolvedNow = false;
    if ('status' in p) {
      const st = String(p.status);
      if (!['open', 'pending', 'snoozed', 'resolved'].includes(st)) demoError('E_PAYLOAD_INVALID', 'status');
      c.snoozed_until = st === 'snoozed' ? p.snoozed_until || null : null;
      if (st !== c.status) {
        if (st === 'resolved') { c.resolved_at = iso(); c.resolved_by = 'agent'; resolvedNow = true; systemEvent(s, c0!, { kind: 'resolved', by: who }); }
        else if (c.status === 'resolved') { c.resolved_at = null; c.resolved_by = null; systemEvent(s, c0!, { kind: 'reopened', by: who }); }
        c.status = st;
      }
    }
    s.update('outreach_chats', c.id, {
      assigned_to: c.assigned_to ?? null, priority: c.priority ?? null, labels: c.labels ?? [], custom_attributes: c.custom_attributes ?? {}, status: c.status, snoozed_until: c.snoozed_until ?? null,
      resolved_at: c.resolved_at ?? null, resolved_by: c.resolved_by ?? null, unread: p.mark_unread ? true : c.status === 'resolved' ? false : c0!.unread, archived: c.status === 'resolved',
    });
    if (resolvedNow) postCsat(s, c.id);
    return { ...s.get('outreach_chats', c.id)! };
  }),

  webchat_mailboxes: h((a, ctx) => ctx.store.t('outreach_senders')
    .filter((s) => s.workspace_id === (a.p_ws ?? ctx.ws) && ['GMAIL', 'OUTLOOK', 'IMAP'].includes(s.provider) && !s.deleted_at)
    .sort((x, y) => String(x.display_name ?? '').localeCompare(String(y.display_name ?? '')))
    .map((s) => ({ id: s.id, name: s.display_name ?? null, email: s.owner_email ?? null, provider: s.provider, status: s.status, client_id: s.client_id ?? null }))),

  webchat_report: h((a, ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    return webchatReport(ctx, a.p_inbox ?? null, String(a.p_from ?? new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10)), String(a.p_to ?? today));
  }),

  hub_voice_state: h((a, ctx) => voiceState(ctx, inboxOr404(ctx, a.p_inbox))),

  hub_voice_calls: h((a, ctx) => {
    const s = ctx.store, ws = a.p_ws ?? ctx.ws;
    const f = Date.parse(`${String(a.p_from ?? new Date(Date.now() - 30 * 86_400_000).toISOString()).slice(0, 10)}T00:00:00Z`);
    const t = Date.parse(`${String(a.p_to ?? new Date().toISOString()).slice(0, 10)}T00:00:00Z`) + 86_400_000;
    const live = new Set(s.t(T.inboxes).filter((i) => i.workspace_id === ws).map((i) => i.id));
    const rows = s.t(T.voiceCalls).filter((k) => k.workspace_id === ws && live.has(k.inbox_id) && (!a.p_inbox || k.inbox_id === a.p_inbox) && k.status !== 'failed' && Date.parse(k.started_at) >= f && Date.parse(k.started_at) < t)
      .sort((x, y) => String(y.started_at).localeCompare(String(x.started_at)));
    const lim = Math.max(1, Math.min(Number(a.p_limit ?? 50) || 50, 200)), off = Math.max(0, Number(a.p_offset ?? 0) || 0);
    return { pool: voicePool(s, ws), total: rows.length, calls: rows.slice(off, off + lim).map((k) => callJson(s, k)) };
  }),
} satisfies RpcArea;

/** Table hooks (insert defaults, side effects) for this area's tables. Called once at boot. */
export function registerWebchat(): void {
  // browser only: the preview widget's bridge, and the voice SDK stand-in the Voice tab's test panel loads
  installWidgetBridge();
  installSampleVoice();
}
