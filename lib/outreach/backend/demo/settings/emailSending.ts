/**
 * Demo: custom sending domain + email log (custom-sending-domain-PRD.md). The domain lives in a demo table
 * `outreach_sending_domains`; verification "succeeds" on the second check; the log has a few seeded rows.
 */
import { DAY, HOUR, demoError, isoAgo, type Ctx } from '../ctx';
import type { Row } from '../store';
import { audit, EMAIL_RE, requireWs } from './common';

const PLATFORM_FROM = 'GrowthxAI <notifications@updates.growthxai.com>';

const T = (a: string, d: string, s: boolean, k: string, n: string | null = null): Row => ({ key: k, audience: a, safety_critical: s, note: n, domain_rule: d });
/** The catalogue (migration 099), the part the page shows. */
export const EMAIL_TYPES: Row[] = [
  T('team', 'platform', false, 'team_invite'), T('team', 'platform', false, 'reply_alert'), T('team', 'platform', false, 'mention'), T('team', 'platform', false, 'ai_handoff'), T('team', 'platform', false, 'ai_handback'),
  T('team', 'platform', false, 'ai_reply_scheduled'), T('team', 'platform', false, 'ai_reply_breaker'), T('team', 'platform', false, 'assignment'), T('team', 'platform', false, 'manager_daily_digest'),
  T('team', 'platform', false, 'sequence_stalled'), T('team', 'platform', false, 'sender_running_dry'), T('team', 'platform', false, 'import_failed'), T('team', 'platform', false, 'sender_paused'), T('team', 'platform', false, 'sender_error'),
  T('team', 'platform', false, 'sender_level_up'), T('team', 'platform', false, 'removal_pending'), T('team', 'platform', false, 'sender_auto_remove_team'), T('team', 'platform', false, 'sender_owner_action'), T('team', 'platform', false, 'health_alert'),
  T('team', 'platform', false, 'sender_disconnected_team', 'combined, 4 h after the sign-in email'), T('team', 'platform', true, 'sender_mass_disconnect'), T('team', 'platform', false, 'weekly_digest'), T('team', 'platform', false, 'sender_weekly'),
  T('team', 'platform', false, 'voice_minutes'), T('team', 'platform', false, 'export_ready'), T('team', 'platform', false, 'webchat_handoff'),
  T('team', 'platform', true, 'billing_payment_failed'), T('team', 'platform', true, 'billing_action_required'), T('team', 'platform', true, 'billing_reminder'), T('team', 'platform', true, 'billing_suspension_tomorrow'), T('team', 'platform', true, 'billing_suspended'),
  T('team', 'platform', true, 'billing_removal_warning'), T('team', 'platform', true, 'billing_accounts_removed'), T('team', 'platform', true, 'billing_deletion_warning'), T('team', 'platform', true, 'billing_data_deleted'), T('team', 'platform', true, 'billing_reactivated'),
  T('team', 'platform', true, 'billing_plan_ending'), T('team', 'platform', true, 'billing_subscription_cancelled'), T('team', 'platform', true, 'billing_trial_ending'), T('team', 'platform', true, 'billing_trial_expired'), T('team', 'platform', true, 'billing_trial_data_warning'),
  T('holder', 'brand', false, 'sender_connect_request'), T('holder', 'brand', true, 'sender_connected_notice', 'outside holders only'), T('holder', 'brand', true, 'sender_reconnect_needed'), T('holder', 'brand', true, 'sender_reconnect_manual'),
  T('holder', 'brand', true, 'sender_reconnect_reminder'), T('holder', 'brand', true, 'ai_reply_consent_request'), T('holder', 'brand', true, 'ai_reply_consent_confirmed'), T('holder', 'brand', false, 'ai_reply_owner_digest'),
  T('holder', 'brand', true, 'profile_authority_request'), T('holder', 'brand', true, 'profile_change_applied'), T('holder', 'brand', true, 'profile_change_proposed'), T('holder', 'brand', true, 'sender_removed_notice'),
  T('holder', 'brand', true, 'sender_auto_remove_notice'), T('holder', 'brand', true, 'sender_erase_notice'), T('holder', 'brand', true, 'sender_holder_changed'), T('holder', 'brand', true, 'sender_removal_billing_notice'), T('holder', 'brand', true, 'sender_reconnect_after_billing'),
  T('client', 'brand', false, 'client_viewer_invite'), T('client', 'brand', false, 'client_report'), T('client', 'brand', false, 'webchat_transcript'), T('client', 'brand', false, 'webchat_continuity'),
  T('auth', 'brand', true, 'auth_magic_link'), T('auth', 'brand', true, 'auth_signup'), T('auth', 'brand', true, 'auth_recovery'), T('auth', 'brand', true, 'auth_invite'), T('auth', 'brand', true, 'auth_email_change'), T('auth', 'brand', true, 'auth_reauthentication'),
  T('team', 'platform', false, 'sending_domain_records'), T('team', 'platform', true, 'sending_domain_status'), T('client', 'brand', false, 'sending_domain_test'),
];

export function typesByRule(): Row {
  const pick = (r: Row) => ({ key: r.key, audience: r.audience, safety_critical: r.safety_critical, note: r.note });
  return {
    brand: EMAIL_TYPES.filter((t) => t.domain_rule === 'brand' && t.audience !== 'auth').map(pick),
    platform: EMAIL_TYPES.filter((t) => t.domain_rule === 'platform' && t.audience !== 'platform').map(pick),
    auth: EMAIL_TYPES.filter((t) => t.audience === 'auth').map((t) => t.key),
  };
}

const HOST_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const root = (d: string) => d.split('.').slice(-2).join('.');

function records(domain: string, status: string): Row[] {
  return [
    { record: 'SPF', type: 'MX', name: `send.${domain}`, value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10, ttl: 'Auto', status },
    { record: 'SPF', type: 'TXT', name: `send.${domain}`, value: 'v=spf1 include:amazonses.com ~all', ttl: 'Auto', status },
    { record: 'DKIM', type: 'TXT', name: `resend._domainkey.${domain}`, value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDemoKeyForTheTourOnlyNotARealKey0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000IDAQAB', ttl: 'Auto', status },
  ];
}

function liveDomains(ctx: Ctx, ws: string): Row[] {
  return ctx.store.t('outreach_sending_domains').filter((d) => d.workspace_id === ws && d.state !== 'removed');
}

function viewOf(ctx: Ctx, d: Row): Row {
  const log = ctx.store.t('outreach_email_log').filter((l) => l.sending_domain_id === d.id && Date.parse(l.sent_at) > Date.now() - 7 * DAY);
  return {
    ...d, from_address: `${d.from_local_part}@${d.domain}`,
    sent_today: ctx.store.t('outreach_email_log').filter((l) => l.sending_domain_id === d.id && Date.parse(l.sent_at) > Date.now() - DAY).length,
    last7: { sent: log.length, delivered: log.filter((l) => l.delivery_status === 'delivered').length, bounced: log.filter((l) => l.delivery_status === 'bounced').length, complained: log.filter((l) => l.delivery_status === 'complained').length },
    fallbacks7: ctx.store.t('outreach_email_log').filter((l) => l.workspace_id === d.workspace_id && l.fell_back && Date.parse(l.sent_at) > Date.now() - 7 * DAY).length,
  };
}

export function listDomains(ctx: Ctx, ws: string, clientId: string | null): Row {
  const w = ctx.store.get('outreach_workspaces', ws);
  const plan = String(w?.plan ?? 'trial');
  const feature = plan !== 'launch';
  const enterprise = plan === 'enterprise' || plan === 'trial';
  return {
    domains: liveDomains(ctx, ws).filter((d) => !clientId || d.client_id === clientId).map((d) => viewOf(ctx, d)),
    feature, client_domains: enterprise, client_domain_limit: enterprise ? 10 : null, min_plan: 'Scale',
  };
}

export function checkDomain(ctx: Ctx, ws: string, domain: unknown, clientId: string | null): Row {
  const d = String(domain ?? '').trim().toLowerCase();
  const errors: string[] = []; const warnings: string[] = [];
  if (!HOST_RE.test(d)) errors.push('Enter a hostname such as notify.yourcompany.com');
  if (d.split('.').length > 4) errors.push('Use at most two levels under your domain (for example notify.mail.yourcompany.com)');
  if (ctx.store.t('outreach_sending_domains').some((x) => x.domain === d && x.state !== 'removed' && x.workspace_id !== ws)) errors.push('This domain is in use by another GrowthxAI workspace. Contact support');
  if (ctx.store.t('outreach_sending_domains').some((x) => x.domain === d && x.state !== 'removed' && x.workspace_id === ws && (x.client_id ?? null) !== clientId)) errors.push('This domain is already set up in this workspace. Use a different subdomain for this client.');
  if (d.split('.').length <= 2 && HOST_RE.test(d)) warnings.push(`This is your root domain. A subdomain like notify.${d} keeps these emails apart from your other mail.`);
  const outreachDomains = ctx.store.t('outreach_senders').filter((s) => s.workspace_id === ws && ['GMAIL', 'OUTLOOK', 'IMAP'].includes(String(s.provider))).map((s) => String(s.owner_email ?? s.public_identifier ?? '').split('@')[1]).filter(Boolean);
  const r = root(d);
  if (outreachDomains.some((od) => od === d || od === r || d.endsWith(`.${od}`))) warnings.push(`This looks like the domain you send outreach from. Use a subdomain like notify.${r} so outreach complaints don't affect these emails.`);
  return { ok: !errors.length, domain: d, errors, warnings, root: r };
}

function need(ctx: Ctx, ws: string, id: unknown): Row {
  const d = ctx.store.get('outreach_sending_domains', String(id ?? ''));
  if (!d || d.workspace_id !== ws || d.state === 'removed') demoError('E_NOT_FOUND', 'domain not found');
  return d;
}

function patch(ctx: Ctx, id: string, p: Row): Row {
  return ctx.store.update('outreach_sending_domains', id, { ...p, updated_at: ctx.now() })[0];
}

export async function sendingDomainFn(ctx: Ctx, b: Record<string, unknown>): Promise<unknown> {
  const action = String(b.action ?? '');
  const { ws, member } = requireWs(ctx, b.workspace_id, action === 'list' || action === 'types' ? 'member' : 'manager', false);
  const clientId = b.client_id ? String(b.client_id) : null;
  switch (action) {
    case 'list': return listDomains(ctx, ws, clientId);
    case 'types': return typesByRule();
    case 'check': return checkDomain(ctx, ws, b.domain, clientId);
    case 'create': {
      const c = checkDomain(ctx, ws, b.domain, clientId);
      if (!c.ok) demoError('E_PAYLOAD_INVALID', c.errors.join(' '));
      if (!listDomains(ctx, ws, null).feature) demoError('E_PLAN_REQUIRED', 'Available on Scale. Your own sending domain is not part of the Launch plan.');
      const w = ctx.store.get('outreach_workspaces', ws);
      const client = clientId ? ctx.store.get('outreach_clients', clientId) : null;
      const row = ctx.store.insert('outreach_sending_domains', {
        workspace_id: ws, client_id: clientId, domain: c.domain, region: 'eu-west-1', state: 'verifying', resend_status: 'not_started', records: records(c.domain, 'not_started'),
        from_name: client?.name ?? w?.name ?? null, from_local_part: 'notifications', reply_to: null, branding: {}, dmarc_found: false, verified_at: null, activated_at: null, paused_at: null, paused_reason: null, paused_detail: null,
        warmup_started_at: null, daily_cap: null, last_checked_at: null, failed_at: null, created_by: ctx.userId, removed_at: null, checks: 0,
      })[0];
      audit(ctx.store, ws, ctx.userId, 'sending_domain.created', 'sending_domain', row.id, { domain: c.domain });
      ctx.ui.simulated('Demo: the records are shown; press Check now twice and the domain verifies.');
      return { ...viewOf(ctx, row), warnings: c.warnings };
    }
    case 'verify': {
      const d = need(ctx, ws, b.id);
      const checks = Number(d.checks ?? 0) + 1;
      const done = checks >= 2;
      const after = patch(ctx, d.id, { checks, last_checked_at: ctx.now(), resend_status: done ? 'verified' : 'pending', records: records(d.domain, done ? 'verified' : 'pending'), state: done && d.state !== 'active' ? 'ready' : d.state, verified_at: done ? (d.verified_at ?? ctx.now()) : d.verified_at });
      if (!done) ctx.ui.simulated('Demo: the records are still propagating. Check once more.');
      return viewOf(ctx, after);
    }
    case 'update': {
      const d = need(ctx, ws, b.id);
      const p: Row = {};
      if (b.from_name !== undefined) p.from_name = String(b.from_name ?? '').trim() || null;
      if (b.from_local_part !== undefined) { const lp = String(b.from_local_part ?? '').trim().toLowerCase(); if (!/^[a-z0-9._-]{1,64}$/.test(lp)) demoError('E_PAYLOAD_INVALID', 'The part before @ may only use letters, numbers, dots, dashes and underscores'); p.from_local_part = lp; }
      if (b.reply_to !== undefined) { const rt = String(b.reply_to ?? '').trim().toLowerCase(); if (!EMAIL_RE.test(rt)) demoError('E_PAYLOAD_INVALID', 'Reply-to must be a real address you read'); p.reply_to = rt; }
      if (b.branding && typeof b.branding === 'object') p.branding = { ...(d.branding ?? {}), ...(b.branding as Row) };
      return viewOf(ctx, patch(ctx, d.id, p));
    }
    case 'test': {
      const d = need(ctx, ws, b.id);
      if (!d.reply_to) demoError('E_CONFLICT', 'Set the reply-to address first');
      if (d.state !== 'ready' && d.state !== 'active') demoError('E_CONFLICT', 'The domain is not verified yet');
      const to = String(b.to ?? member.email ?? 'you@example.com');
      const row = ctx.store.insert('outreach_email_log', { workspace_id: ws, client_id: clientId, sender_id: null, type: 'sending_domain_test', audience: 'client', subject: `Test from ${d.domain}`, to_address: to, from_address: `${d.from_local_part}@${d.domain}`, sending_domain_id: d.id, fell_back: false, fallback_reason: null, delivery_status: 'delivered', bounce_type: null, events: [{ event: 'email.sent', at: ctx.now() }, { event: 'email.delivered', at: ctx.now() }], sent_at: ctx.now(), updated_at: ctx.now() })[0];
      ctx.ui.simulated('Demo: no email leaves the tour; the log shows it as delivered.');
      return { ok: true, outbox_id: row.id, from: `${d.from_name ? `"${d.from_name}" ` : ''}<${d.from_local_part}@${d.domain}>`, fell_back: false, error: null };
    }
    case 'activate': {
      const d = need(ctx, ws, b.id);
      if (d.state !== 'ready') demoError('E_CONFLICT', d.state === 'active' ? 'The domain is already on' : 'Verify the DNS records first');
      if (!d.reply_to) demoError('E_CONFLICT', 'Set the reply-to address first');
      audit(ctx.store, ws, ctx.userId, 'sending_domain.activated', 'sending_domain', d.id);
      return viewOf(ctx, patch(ctx, d.id, { state: 'active', activated_at: ctx.now(), warmup_started_at: ctx.now(), daily_cap: 50, paused_at: null, paused_reason: null, paused_detail: null }));
    }
    case 'pause': { const d = need(ctx, ws, b.id); return viewOf(ctx, patch(ctx, d.id, { paused_at: ctx.now(), paused_reason: 'manual', paused_detail: b.note ? String(b.note) : null })); }
    case 'resume': {
      const d = need(ctx, ws, b.id);
      if (d.paused_reason === 'plan') demoError('E_PLAN_REQUIRED', 'The plan does not include a sending domain');
      if ((d.paused_reason === 'bounces' || d.paused_reason === 'complaints') && !String(b.note ?? '').trim()) demoError('E_PAYLOAD_INVALID', 'Say what was fixed before resuming after bounces or complaints');
      return viewOf(ctx, patch(ctx, d.id, { paused_at: null, paused_reason: null, paused_detail: null, state: d.state === 'failed' ? 'active' : d.state }));
    }
    case 'remove': { const d = need(ctx, ws, b.id); audit(ctx.store, ws, ctx.userId, 'sending_domain.removed', 'sending_domain', d.id); return viewOf(ctx, patch(ctx, d.id, { state: 'removed', removed_at: ctx.now() })); }
    case 'email_records': { need(ctx, ws, b.id); if (!EMAIL_RE.test(String(b.to ?? ''))) demoError('E_PAYLOAD_INVALID', 'enter the IT person\'s email'); ctx.ui.simulated('Demo: no email leaves the tour.'); return { ok: true }; }
    case 'dmarc': { const d = need(ctx, ws, b.id); const found = Number(d.checks ?? 0) >= 2; patch(ctx, d.id, { dmarc_found: found }); return { found, record: found ? 'v=DMARC1; p=none' : null, policy: found ? 'none' : null, root: root(d.domain) }; }
    default: return demoError('E_PAYLOAD_INVALID', `unknown action ${action}`);
  }
}

/** A few seeded rows so the Email log is not empty on first open. */
export function ensureSeedLog(ctx: Ctx, ws: string): void {
  const s = ctx.store;
  if (s.t('outreach_email_log').some((l) => l.workspace_id === ws)) return;
  const members = s.t('outreach_members').filter((m) => m.workspace_id === ws && m.email);
  const to = String(members[0]?.email ?? 'you@example.com');
  const holder = s.t('outreach_senders').find((x) => x.workspace_id === ws && x.owner_email)?.owner_email ?? 'avi@client.example';
  const rows: Array<[string, string, string, string, string, string[]]> = [
    ['reply_alert', 'team', 'New reply from Priya Nair', to, 'delivered', ['email.sent', 'email.delivered']],
    ['sender_reconnect_needed', 'holder', 'Action needed: sign in to Naman Kasliwal again', String(holder), 'delivered', ['email.sent', 'email.delivered']],
    ['weekly_digest', 'team', 'Your weekly outreach digest', to, 'delivered', ['email.sent', 'email.delivered']],
    ['client_report', 'client', 'Weekly report: Acme', 'ops@acme.example', 'bounced', ['email.sent', 'email.bounced']],
    ['mention', 'team', 'Rohan mentioned you in Priya Nair', to, 'sent', ['email.sent']],
  ];
  rows.forEach(([type, audience, subject, addr, status, events], i) => {
    const at = isoAgo((i + 1) * 9 * HOUR);
    s.insert('outreach_email_log', { workspace_id: ws, client_id: null, sender_id: null, type, audience, subject, to_address: addr, from_address: PLATFORM_FROM, sending_domain_id: null, fell_back: false, fallback_reason: null,
      delivery_status: status, bounce_type: status === 'bounced' ? 'Permanent' : null, events: events.map((e, j) => ({ event: e, at: isoAgo((i + 1) * 9 * HOUR - j * 60_000) })), sent_at: at, updated_at: at }, { silent: true });
  });
}

export function emailLogSearch(ctx: Ctx, a: Record<string, unknown>): Row {
  const { ws } = requireWs(ctx, a.p_ws, 'manager', false);
  ensureSeedLog(ctx, ws);
  const to = a.p_to ? String(a.p_to).toLowerCase() : null;
  const rows = ctx.store.t('outreach_email_log').filter((l) => l.workspace_id === ws && (!to || String(l.to_address).includes(to)) && (!a.p_type || l.type === a.p_type) && (!a.p_status || l.delivery_status === a.p_status)
    && (!a.p_since || Date.parse(l.sent_at) >= Date.parse(String(a.p_since))) && (!a.p_until || Date.parse(l.sent_at) <= Date.parse(String(a.p_until))))
    .sort((x, y) => Date.parse(y.sent_at) - Date.parse(x.sent_at));
  const limit = Math.max(1, Math.min(500, Number(a.p_limit ?? 50)));
  const offset = Math.max(0, Number(a.p_offset ?? 0));
  return {
    total: rows.length,
    limit,
    offset,
    rows: rows.slice(offset, offset + limit).map((l) => ({ id: l.id, at: l.sent_at, type: l.type, audience: l.audience, subject: l.subject, to: l.to_address, from: l.from_address, fell_back: !!l.fell_back, fallback_reason: l.fallback_reason ?? null,
      status: l.delivery_status, bounce_type: l.bounce_type ?? null, events: l.events ?? [], sender_id: l.sender_id ?? null, client_id: l.client_id ?? null, domain: l.sending_domain_id ? ctx.store.get('outreach_sending_domains', l.sending_domain_id)?.domain ?? null : null })),
  };
}
