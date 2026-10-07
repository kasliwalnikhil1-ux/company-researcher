/**
 * Demo handlers: Workspace, members, invitations, branding, billing, API keys, webhooks, domains, suppressions, integrations, admin.
 * Owns: accept_invitation, add_domain, add_suppressions, ai_reply_admin_list, ai_reply_admin_set, api_deliveries, billing_changes, billing_state, branding, branding_for_host, branding_for_invite, create_api_key, create_webhook, create_workspace, delete_webhook, domains, ensure_workspace, integration_disconnect, integration_save, invitation_preview, my_workspaces, remove_domain, remove_member, replay_delivery, revoke_api_key, set_branding, set_webhook_active, update_member, workspace_members
 */
import { DEMO_USER_EMAIL, DEMO_USER_NAME } from '../seed/ids';
import { DAY, demoError, type Ctx, type RpcArea } from '../ctx';
import type { DemoStore, Row } from '../store';
import { billingState } from '../settings/billing';
import { audit, EMAIL_RE, hex, lowerTrim, memberOf, nextNum, requireWs, workspaceRow } from '../settings/common';
import { registerSettingsHooks } from '../settings/hooks';

const ROLES = ['owner', 'manager', 'member', 'client_viewer'];
const RANK: Record<string, number> = { owner: 0, manager: 1, member: 2, client_viewer: 3 };

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------
function myWorkspaces(ctx: Ctx): Row[] {
  const out: Array<{ at: string; row: Row }> = [];
  for (const m of ctx.store.t('outreach_members')) {
    if (m.user_id !== ctx.userId) continue;
    const w = ctx.store.get('outreach_workspaces', m.workspace_id);
    if (!w || w.deleted_at) continue;
    out.push({
      at: m.created_at ?? '',
      row: {
        id: w.id, name: w.name, slug: w.slug, plan: w.plan, role: m.role, client_ids: m.client_ids ?? [], can_reply: m.can_reply !== false,
        settings: w.settings ?? {}, trial_ends_at: w.trial_ends_at ?? null, stripe_status: w.stripe_status ?? null, past_due_since: w.past_due_since ?? null,
      },
    });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((x) => x.row);
}

const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

function createWorkspace(ctx: Ctx, name: unknown): Row {
  const s = ctx.store;
  const base = slugify(String(name ?? '')) || 'workspace';
  let slug = base;
  for (let i = 0; s.t('outreach_workspaces').some((w) => w.slug === slug); i++) slug = `${base}-${hex(s, i > 10 ? 12 : 4)}`;
  const now = Date.now();
  const w = s.insert('outreach_workspaces', {
    name: String(name ?? '').trim() || 'My Workspace', slug, plan: 'trial', created_by: ctx.userId, deleted_at: null,
    settings: { recruiter_enabled: false, create_leads_from_inbound: true, cookie_mode_opt_in: true, timezone: 'UTC', auto_stage_interested: true, track_replies: false },
    branding: {}, stripe_customer_id: null, stripe_subscription_id: null, stripe_status: null, past_due_since: null, trial_ends_at: new Date(now + 7 * DAY).toISOString(),
    trial_account_limit: 1, billing_period: null, accounts_requested: null, accounts_billed: null, current_period_start: null, current_period_end: null,
    cancel_at_period_end: false, cancelled_at: null, data_delete_after: null, scheduled_change: null, pending_payment: null, price_version: 'v1',
    early_supporter_tier: null, early_supporter_discount: 0, custom_price_id: null, billing_comp: false, plan_before_suspension: null, disputed_at: null, suspended_at: null,
  })[0];
  s.insert('outreach_members', { workspace_id: w.id, user_id: ctx.userId, role: 'owner', client_ids: [], can_reply: true, email: DEMO_USER_EMAIL, display_name: DEMO_USER_NAME }, { noId: true });
  const stages: Array<[string, string, string]> = [['New', '#6b7280', 'new'], ['Contacted', '#3b82f6', 'contacted'], ['Connected', '#8b5cf6', 'connected'], ['Replied', '#f59e0b', 'replied'], ['Interested', '#10b981', 'interested'], ['Meeting', '#06b6d4', 'meeting'], ['Won', '#22c55e', 'won'], ['Lost', '#ef4444', 'lost']];
  stages.forEach(([n, color, kind], position) => s.insert('outreach_stages', { workspace_id: w.id, name: n, position, color, kind, deal_value: null }));
  audit(s, w.id, ctx.userId, 'workspace.created', 'workspace', w.id);
  return w;
}

// ---------------------------------------------------------------------------
// invitations
// ---------------------------------------------------------------------------
function inviteByToken(store: DemoStore, token: unknown): Row | undefined {
  return store.t('outreach_invitations').find((i) => i.token === String(token ?? ''));
}

function publicBranding(store: DemoStore, ws: string): Row | null {
  const w = store.get('outreach_workspaces', ws);
  if (!w || w.deleted_at) return null;
  const b: Row = { ...(w.branding ?? {}) };
  delete b.email_from_address; delete b.email_from_name;
  return { workspace_name: w.name, ...b };
}

// ---------------------------------------------------------------------------
// branding / domains
// ---------------------------------------------------------------------------
const HTTPS = /^https:\/\//;
function cleanBranding(p: Row): Row {
  const t = (v: unknown, n: number) => { const s = String(v ?? '').trim().slice(0, n); return s || undefined; };
  const email = (v: unknown) => (EMAIL_RE.test(String(v ?? '')) ? String(v).trim().toLowerCase() : undefined);
  const url = (v: unknown) => (HTTPS.test(String(v ?? '')) ? String(v) : undefined);
  const b: Row = {
    product_name: t(p.product_name, 60), logo_url: url(p.logo_url), accent: /^#[0-9a-fA-F]{6}$/.test(String(p.accent ?? '')) ? String(p.accent) : undefined,
    support_email: email(p.support_email), help_url: url(p.help_url), docs_url: url(p.docs_url), email_from_name: t(p.email_from_name, 60),
    email_from_address: email(p.email_from_address), hide_platform_name: p.hide_platform_name === true || p.hide_platform_name === 'true',
  };
  for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
  return b;
}

function domainView(d: Row): Row {
  return {
    id: d.id, hostname: d.hostname, client_id: d.client_id ?? null, status: d.status, verified_at: d.verified_at ?? null, last_checked_at: d.last_checked_at ?? null, last_error: d.last_error ?? null,
    dns: [{ type: 'CNAME', name: d.hostname, value: d.cname_target }, { type: 'TXT', name: `_outreach-verify.${d.hostname}`, value: d.verification_token }],
  };
}

// ---------------------------------------------------------------------------
// suppressions
// ---------------------------------------------------------------------------
const SUPPRESSION_KINDS = ['domain', 'public_identifier', 'email', 'company', 'phone', 'handle'];
function normaliseSuppression(r: Row): { kind: string; value: string } | null {
  let v = lowerTrim(r.value);
  let k = String(r.kind ?? '').trim();
  if (!k) k = EMAIL_RE.test(v) ? 'email' : /linkedin\.com\/in\//.test(v) ? 'public_identifier' : /linkedin\.com\/company\//.test(v) ? 'company' : /^https?:\/\//.test(v) || /^www\./.test(v) || /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(v) ? 'domain' : 'company';
  if (!v || !SUPPRESSION_KINDS.includes(k)) return null;
  if (k === 'public_identifier') v = v.replace(/^.*linkedin\.com\/in\//, '').replace(/[/?#].*$/, '');
  else if (k === 'domain') v = v.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  else if (k === 'company' && /linkedin\.com\/company\//.test(v)) v = v.replace(/^.*linkedin\.com\/company\//, '').replace(/[/?#].*$/, '');
  return v ? { kind: k, value: v } : null;
}

// ---------------------------------------------------------------------------
export const settingsRpc = {
  my_workspaces: (_a, ctx) => myWorkspaces(ctx),

  ensure_workspace: (a, ctx) => {
    const mine = ctx.store.t('outreach_members').filter((m) => m.user_id === ctx.userId)
      .map((m) => ({ m, w: ctx.store.get('outreach_workspaces', m.workspace_id) }))
      .filter((x) => x.w && !x.w.deleted_at)
      .sort((x, y) => Number(y.m.role === 'owner') - Number(x.m.role === 'owner') || Date.parse(x.m.created_at ?? '') - Date.parse(y.m.created_at ?? ''));
    if (mine.length) return mine[0].w;
    return createWorkspace(ctx, a.p_name ?? `${DEMO_USER_EMAIL.split('@')[0]}'s workspace`);
  },

  // The tour has one sample workspace: a second one would show the same sample data under another name.
  create_workspace: (a, ctx) => { void a; void createWorkspace; ctx.ui.toast('The demo has one sample workspace. Start your outreach to create your own.'); return demoError('E_DEMO_ONE_WORKSPACE', 'The demo has one sample workspace. Start your outreach to create your own'); },

  workspace_members: (a, ctx) => {
    const { ws } = requireWs(ctx, a.p_ws, 'member', false);
    return ctx.store.t('outreach_members').filter((m) => m.workspace_id === ws)
      .sort((x, y) => Date.parse(x.created_at ?? '') - Date.parse(y.created_at ?? ''))
      .map((m) => ({ user_id: m.user_id, role: m.role, client_ids: m.client_ids ?? [], can_reply: m.can_reply !== false, email: m.email ?? null, display_name: m.display_name ?? null, created_at: m.created_at }));
  },

  update_member: (a, ctx) => {
    const { ws } = requireWs(ctx, a.p_ws, 'owner');
    const role = String(a.p_role ?? '');
    if (!ROLES.includes(role)) demoError('E_PAYLOAD_INVALID', 'role must be owner, manager, member or client_viewer');
    if (a.p_user === ctx.userId && role !== 'owner') demoError('E_FORBIDDEN', 'cannot demote yourself');
    const target = memberOf(ctx.store, ws, String(a.p_user ?? ''));
    if (target) {
      const clients = Array.isArray(a.p_client_ids) ? (a.p_client_ids as unknown[]).map(String).filter((id) => ctx.store.t('outreach_clients').some((c) => c.id === id && c.workspace_id === ws)) : null;
      ctx.store.update('outreach_members', (m) => m === target, { role, client_ids: clients ?? target.client_ids ?? [], can_reply: typeof a.p_can_reply === 'boolean' ? a.p_can_reply : target.can_reply });
    }
    audit(ctx.store, ws, ctx.userId, 'member.updated', 'member', String(a.p_user ?? ''), { role });
    return null;
  },

  remove_member: (a, ctx) => {
    const { ws } = requireWs(ctx, a.p_ws, 'owner');
    if (a.p_user === ctx.userId) demoError('E_FORBIDDEN', 'cannot remove yourself');
    ctx.store.remove('outreach_members', (m) => m.workspace_id === ws && m.user_id === a.p_user);
    audit(ctx.store, ws, ctx.userId, 'member.removed', 'member', String(a.p_user ?? ''));
    return null;
  },

  invitation_preview: (a, ctx) => {
    const inv = inviteByToken(ctx.store, a.p_token);
    if (!inv) return [];
    const w = ctx.store.get('outreach_workspaces', inv.workspace_id);
    if (!w) return [];
    return [{ workspace_name: w.name, email: inv.email, role: inv.role, expired: Date.parse(inv.expires_at) < Date.now(), accepted: !!inv.accepted_at }];
  },

  accept_invitation: (a, ctx) => {
    const inv = inviteByToken(ctx.store, a.p_token);
    if (!inv) demoError('E_NOT_FOUND', 'invitation');
    if (inv.accepted_at) demoError('E_INVITE_USED');
    if (Date.parse(inv.expires_at) < Date.now()) demoError('E_INVITE_EXPIRED');
    if (lowerTrim(inv.email) !== lowerTrim(DEMO_USER_EMAIL)) demoError('E_INVITE_EMAIL_MISMATCH');
    ctx.store.upsert('outreach_members', { workspace_id: inv.workspace_id, user_id: ctx.userId, role: inv.role, client_ids: inv.client_ids ?? [], can_reply: true, email: DEMO_USER_EMAIL, display_name: DEMO_USER_NAME }, ['workspace_id', 'user_id']);
    ctx.store.update('outreach_invitations', inv.id, { accepted_at: ctx.now() });
    audit(ctx.store, inv.workspace_id, ctx.userId, 'member.joined', 'member', ctx.userId, { role: inv.role });
    return inv.workspace_id;
  },

  // --- branding -------------------------------------------------------------
  branding: (a, ctx) => {
    const { ws, member } = requireWs(ctx, a.p_ws, 'client_viewer', false);
    const w = workspaceRow(ctx.store, ws);
    return member.role === 'owner' || member.role === 'manager' ? { workspace_name: w.name, ...(w.branding ?? {}) } : publicBranding(ctx.store, ws);
  },

  set_branding: (a, ctx) => {
    const { ws } = requireWs(ctx, a.p_ws, 'owner');
    const b = cleanBranding((a.p_branding ?? {}) as Row);
    ctx.store.update('outreach_workspaces', ws, { branding: b });
    audit(ctx.store, ws, ctx.userId, 'workspace.branding', 'workspace', ws, b);
    return b;
  },

  branding_for_host: (a, ctx) => {
    const host = lowerTrim(a.p_hostname);
    const d = ctx.store.t('outreach_workspace_domains').find((x) => lowerTrim(x.hostname) === host && x.status === 'active');
    if (!d) return null;
    const b = publicBranding(ctx.store, d.workspace_id);
    return b ? { ...b, workspace_id: d.workspace_id, client_id: d.client_id ?? null, portal_only: true } : null;
  },

  branding_for_invite: (a, ctx) => {
    const inv = inviteByToken(ctx.store, a.p_token);
    return inv ? publicBranding(ctx.store, inv.workspace_id) : null;
  },

  add_domain: (a, ctx) => {
    const { ws } = requireWs(ctx, a.p_ws, 'owner');
    const h = lowerTrim(a.p_hostname);
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h)) demoError('E_PAYLOAD_INVALID', 'enter a hostname such as reports.agency.com');
    const client = a.p_client ? String(a.p_client) : null;
    if (client && !ctx.store.t('outreach_clients').some((c) => c.id === client && c.workspace_id === ws)) demoError('E_NOT_FOUND', 'client');
    if (ctx.store.t('outreach_workspace_domains').filter((d) => d.workspace_id === ws).length >= 10) demoError('E_TOO_MANY', 'at most 10 domains');
    if (ctx.store.t('outreach_workspace_domains').some((d) => lowerTrim(d.hostname) === h)) demoError('E_PAYLOAD_INVALID', 'this hostname is already in use');
    const d = ctx.store.insert('outreach_workspace_domains', {
      workspace_id: ws, client_id: client, hostname: h, status: 'pending_dns', verification_token: hex(ctx.store, 32), cname_target: 'cname.vercel-dns.com',
      verified_at: null, last_checked_at: null, last_error: null, created_by: ctx.userId,
    })[0];
    audit(ctx.store, ws, ctx.userId, 'workspace.domain_added', 'workspace', ws, { hostname: h });
    const v = domainView(d);
    return { id: v.id, hostname: v.hostname, status: v.status, dns: v.dns };
  },

  domains: (a, ctx) => {
    const { ws } = requireWs(ctx, a.p_ws, 'manager', false);
    const now = Date.now();
    // the DNS check runs on its own: a new domain shows as verified about a minute after it was added
    for (const d of ctx.store.t('outreach_workspace_domains')) {
      if (d.workspace_id !== ws || (d.status !== 'pending_dns' && d.status !== 'verifying')) continue;
      const age = now - Date.parse(d.created_at);
      if (age > 60_000) ctx.store.update('outreach_workspace_domains', d.id, { status: 'active', verified_at: ctx.now(), last_checked_at: ctx.now(), last_error: null });
      else if (age > 20_000 && d.status === 'pending_dns') ctx.store.update('outreach_workspace_domains', d.id, { status: 'verifying', last_checked_at: ctx.now() });
    }
    return ctx.store.t('outreach_workspace_domains').filter((d) => d.workspace_id === ws)
      .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at)).map(domainView);
  },

  remove_domain: (a, ctx) => {
    const d = ctx.store.get('outreach_workspace_domains', String(a.p_id ?? ''));
    if (!d) demoError('E_NOT_FOUND');
    requireWs(ctx, d.workspace_id, 'owner');
    ctx.store.remove('outreach_workspace_domains', d.id);
    return null;
  },

  // --- suppressions ---------------------------------------------------------
  add_suppressions: (a, ctx) => {
    const { ws } = requireWs(ctx, a.p_ws, 'manager');
    const client = a.p_client ? String(a.p_client) : null, seq = a.p_sequence ? String(a.p_sequence) : null;
    if (client && seq) demoError('E_PAYLOAD_INVALID', 'choose a client scope or a sequence scope, not both');
    if (client && !ctx.store.t('outreach_clients').some((c) => c.id === client && c.workspace_id === ws)) demoError('E_NOT_FOUND', 'client');
    if (seq && !ctx.store.t('outreach_sequences').some((x) => x.id === seq && x.workspace_id === ws)) demoError('E_NOT_FOUND', 'sequence');
    if (!Array.isArray(a.p_rows)) demoError('E_PAYLOAD_INVALID', 'rows must be an array');
    if (a.p_rows.length > 20000) demoError('E_TOO_MANY', 'max 20000 rows per upload');
    const source = String(a.p_source ?? 'manual');
    const existing = new Set(ctx.store.t('outreach_suppressions').filter((r) => r.workspace_id === ws).map((r) => `${r.client_id ?? ''}|${r.sequence_id ?? ''}|${r.kind}|${r.value}`));
    let added = 0, skipped = 0;
    const rows: Row[] = [];
    for (const r of a.p_rows as Row[]) {
      const n = normaliseSuppression(r ?? {});
      if (!n) { skipped++; continue; }
      const key = `${client ?? ''}|${seq ?? ''}|${n.kind}|${n.value}`;
      if (existing.has(key)) { skipped++; continue; }
      existing.add(key);
      rows.push({ workspace_id: ws, client_id: client, sequence_id: seq, kind: n.kind, value: n.value, reason: String(r.reason ?? '').trim() || null, source, created_by: ctx.userId });
      added++;
    }
    if (rows.length) ctx.store.insert('outreach_suppressions', rows);
    audit(ctx.store, ws, ctx.userId, 'suppression.added', 'suppression', null, { added, skipped, client_id: client, sequence_id: seq, source });
    return { added, skipped };
  },

  // --- API keys -------------------------------------------------------------
  create_api_key: (a, ctx) => {
    const { ws, member } = requireWs(ctx, a.p_ws, 'manager');
    const role = String(a.p_role ?? 'member');
    if (!ROLES.includes(role)) demoError('E_PAYLOAD_INVALID', 'role');
    if (role === 'owner') demoError('E_PAYLOAD_INVALID', 'API keys cannot have the owner role');
    if (RANK[role] < RANK[member.role]) demoError('E_FORBIDDEN', 'a key cannot have more rights than you');
    const name = String(a.p_name ?? '').trim();
    if (!name) demoError('E_PAYLOAD_INVALID', 'name required');
    const clients = Array.isArray(a.p_client_ids) ? (a.p_client_ids as unknown[]).map(String) : [];
    if (clients.some((c) => !ctx.store.t('outreach_clients').some((x) => x.id === c && x.workspace_id === ws))) demoError('E_NOT_FOUND', 'client');
    if (ctx.store.t('outreach_api_keys').filter((k) => k.workspace_id === ws && !k.revoked_at).length >= 25) demoError('E_TOO_MANY', 'at most 25 active keys per workspace');
    const key = `ok_demo_${hex(ctx.store, 40)}`;
    const row = ctx.store.insert('outreach_api_keys', {
      workspace_id: ws, user_id: ctx.userId, name: name.slice(0, 80), prefix: key.slice(0, 14), key_hash: `demo:${hex(ctx.store, 16)}`, role, client_ids: clients,
      last_used_at: null, expires_at: a.p_expires_at ?? null, revoked_at: null,
    })[0];
    audit(ctx.store, ws, ctx.userId, 'api_key.created', 'api_key', row.id, { name, role, client_ids: clients });
    ctx.ui.toast('Demo key: it only works inside this tour.');
    return { id: row.id, key, prefix: row.prefix, note: 'Copy the key now. It is not stored and cannot be shown again.' };
  },

  revoke_api_key: (a, ctx) => {
    const k = ctx.store.get('outreach_api_keys', String(a.p_id ?? ''));
    if (!k) demoError('E_NOT_FOUND');
    requireWs(ctx, k.workspace_id, 'manager');
    if (!k.revoked_at) ctx.store.update('outreach_api_keys', k.id, { revoked_at: ctx.now() });
    audit(ctx.store, k.workspace_id, ctx.userId, 'api_key.revoked', 'api_key', k.id);
    return null;
  },

  // --- webhooks -------------------------------------------------------------
  create_webhook: (a, ctx) => {
    const { ws } = requireWs(ctx, a.p_ws, 'manager');
    const url = String(a.p_url ?? '');
    if (!/^https:\/\/[^\s]+$/.test(url)) demoError('E_PAYLOAD_INVALID', 'url must be https');
    if (ctx.store.t('outreach_outbound_webhooks').filter((w) => w.workspace_id === ws).length >= 20) demoError('E_TOO_MANY', 'at most 20 webhooks');
    const events = Array.isArray(a.p_events) && a.p_events.length ? (a.p_events as unknown[]).map(String) : ['*'];
    const w = ctx.store.insert('outreach_outbound_webhooks', { workspace_id: ws, url, secret: hex(ctx.store, 48), events, active: true, failures: 0 })[0];
    audit(ctx.store, ws, ctx.userId, 'webhook.created', 'webhook', w.id, { url, events });
    return { id: w.id, url: w.url, events: w.events, secret: w.secret, note: 'Deliveries are signed: x-signature = HMAC-SHA256(secret, body).' };
  },

  set_webhook_active: (a, ctx) => {
    const w = ctx.store.get('outreach_outbound_webhooks', String(a.p_id ?? ''));
    if (!w) demoError('E_NOT_FOUND');
    requireWs(ctx, w.workspace_id, 'manager');
    const active = !!a.p_active;
    ctx.store.update('outreach_outbound_webhooks', w.id, { active, failures: active ? 0 : w.failures });
    audit(ctx.store, w.workspace_id, ctx.userId, `webhook.${active ? 'enabled' : 'disabled'}`, 'webhook', w.id);
    return null;
  },

  delete_webhook: (a, ctx) => {
    const w = ctx.store.get('outreach_outbound_webhooks', String(a.p_id ?? ''));
    if (!w) demoError('E_NOT_FOUND');
    requireWs(ctx, w.workspace_id, 'manager');
    ctx.store.remove('outreach_outbound_webhooks', w.id);
    ctx.store.remove('outreach_outbound_webhook_deliveries', (d) => d.webhook_id === w.id);
    return null;
  },

  api_deliveries: (a, ctx) => {
    const { ws } = requireWs(ctx, a.p_ws, 'manager', false);
    const limit = Math.min(Math.max(Number(a.p_limit ?? 50) || 50, 1), 200);
    return ctx.store.t('outreach_outbound_webhook_deliveries').filter((d) => d.workspace_id === ws && (!a.p_webhook || d.webhook_id === a.p_webhook))
      .sort((x, y) => y.id - x.id).slice(0, limit)
      .map((d) => ({ id: d.id, webhook_id: d.webhook_id, event: d.event, status: d.status ?? null, attempts: d.attempts ?? 0, created_at: d.created_at, delivered_at: d.delivered_at ?? null, last_error: d.last_error ?? null, replay_of: d.replay_of ?? null, payload: d.payload }));
  },

  replay_delivery: (a, ctx) => {
    const d = ctx.store.t('outreach_outbound_webhook_deliveries').find((x) => x.id === Number(a.p_delivery));
    if (!d) demoError('E_NOT_FOUND');
    requireWs(ctx, d.workspace_id, 'manager');
    const w = ctx.store.get('outreach_outbound_webhooks', d.webhook_id);
    if (!w || !w.active) demoError('E_PAYLOAD_INVALID', 'the webhook is gone or inactive');
    const id = nextNum(ctx.store, 'outreach_outbound_webhook_deliveries');
    const now = ctx.now();
    ctx.store.insert('outreach_outbound_webhook_deliveries', {
      id, webhook_id: d.webhook_id, workspace_id: d.workspace_id, event: d.event, payload: { ...(d.payload ?? {}), replayed: true, replay_of: d.id },
      status: 200, attempts: 1, next_at: now, delivered_at: now, last_error: null, replay_of: d.id, created_at: now,
    });
    audit(ctx.store, d.workspace_id, ctx.userId, 'webhook.replayed', 'webhook', d.webhook_id, { delivery: d.id, new_delivery: id });
    ctx.ui.simulated('Simulated. The endpoint answered 200 in the demo; nothing was sent.');
    return id;
  },

  // --- integrations ---------------------------------------------------------
  integration_save: (a, ctx) => {
    const i = ctx.store.get('outreach_integrations', String(a.p_id ?? ''));
    if (!i) demoError('E_NOT_FOUND');
    requireWs(ctx, i.workspace_id, 'manager');
    const st = (a.p_settings ?? null) as Row | null;
    if (st && 'sync_rule' in st && !['replied', 'interested', 'enrolled'].includes(String(st.sync_rule))) demoError('E_PAYLOAD_INVALID', 'sync_rule must be replied, interested or enrolled');
    ctx.store.update('outreach_integrations', i.id, {
      settings: { ...(i.settings ?? {}), ...(st ?? {}) },
      field_mapping: a.p_field_mapping ?? i.field_mapping ?? {},
      stage_mapping: a.p_stage_mapping ?? i.stage_mapping ?? {},
    });
    audit(ctx.store, i.workspace_id, ctx.userId, 'integration.settings', 'integration', i.id, { settings: st });
    return null;
  },

  integration_disconnect: (a, ctx) => {
    const i = ctx.store.get('outreach_integrations', String(a.p_id ?? ''));
    if (!i) demoError('E_NOT_FOUND');
    requireWs(ctx, i.workspace_id, 'manager');
    ctx.store.update('outreach_integrations', i.id, { status: 'disconnected', last_error: null });
    ctx.store.remove('outreach_integration_secrets', (s) => s.integration_id === i.id);
    ctx.store.remove('outreach_suppressions', (s) => s.workspace_id === i.workspace_id && s.source === `crm:${i.provider}`);
    audit(ctx.store, i.workspace_id, ctx.userId, 'integration.disconnected', 'integration', i.id, { provider: i.provider });
    return null;
  },

  // --- billing ----------------------------------------------------------------
  billing_state: (a, ctx) => billingState(ctx.store, String(a.p_ws ?? ''), ctx.userId),

  billing_changes: (a, ctx) => {
    const ws = String(a.p_ws ?? '');
    if (memberOf(ctx.store, ws, ctx.userId)?.role !== 'owner') demoError('E_FORBIDDEN', 'owner required');
    const limit = Math.min(Math.max(Number(a.p_limit ?? 50) || 50, 1), 200);
    const email = (uid: string | null) => (uid ? ctx.store.t('outreach_members').find((m) => m.user_id === uid)?.email ?? null : null);
    return ctx.store.t('outreach_billing_changes').filter((c) => c.workspace_id === ws && c.status !== 'quoted')
      .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at)).slice(0, limit)
      .map((c) => {
        const { quote, ...rest } = c;
        return { ...rest, charge_today_cents: quote?.charge_today_cents ?? null, next_invoice_cents: quote?.next_invoice_cents ?? quote?.next_invoice?.cents ?? null, requested_by_email: email(c.requested_by) };
      });
  },

  // --- platform admin (hidden in the tour) ----------------------------------------
  ai_reply_admin_list: () => demoError('E_FORBIDDEN', 'platform admin required'),
  ai_reply_admin_set: () => demoError('E_FORBIDDEN', 'platform admin required'),
  // Health page (health-page-PRD.md D1): never rendered in the tour, every RPC refuses
  health_overview: () => demoError('E_FORBIDDEN', 'platform admin required'),
  health_check: () => demoError('E_FORBIDDEN', 'platform admin required'),
  health_usage: () => demoError('E_FORBIDDEN', 'platform admin required'),
  health_stuck: () => demoError('E_FORBIDDEN', 'platform admin required'),
  health_snooze: () => demoError('E_FORBIDDEN', 'platform admin required'),
  health_set_threshold: () => demoError('E_FORBIDDEN', 'platform admin required'),
  health_set_enabled: () => demoError('E_FORBIDDEN', 'platform admin required'),
  health_settings_set: () => demoError('E_FORBIDDEN', 'platform admin required'),
  health_set_manual_usage: () => demoError('E_FORBIDDEN', 'platform admin required'),
  health_recheck_limits: () => demoError('E_FORBIDDEN', 'platform admin required'),
  health_run_now: () => demoError('E_FORBIDDEN', 'platform admin required'),
  // the tour records nothing (lib/outreach/clientEvents.ts returns before calling); accepted silently if it ever does
  report_client_event: () => null,
} satisfies RpcArea;

/** Table hooks (insert defaults, side effects) for this area's tables. Called once at boot. */
export function registerSettings(): void {
  registerSettingsHooks();
}
