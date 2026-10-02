/**
 * Demo handlers: Senders: pause, settings, caps, schedule, insights, tracking domains, "why not sending", Profile Studio.
 * Owns: add_tracking_domain, channel_capacity, effective_cap, issue_sender_token, pause_sender, profile_authority_list, profile_authority_revoke, profile_authority_self, profile_bulk_preview, profile_cancel_change, profile_changes_list, profile_draft_change, profile_experiment_abandon, profile_experiment_create, profile_experiment_result, profile_experiments_list, profile_history, profile_link_sequence, profile_overview, profile_qa_correlation, profile_revert_build, profile_template_delete, profile_template_save, profile_update_draft, remove_tracking_domain, sender_insights, sender_scopes_today, set_manual_caps, set_sender_schedule, update_sender, weekly_invites_used, why_not_sending
 */
import { demoError, inWs, type Ctx, type RpcArea } from '../ctx';
import { tableHooks } from '../query';
import type { DemoStore, Row } from '../store';
import { storedUrl } from '../storage';
import { DEMO_USER_EMAIL } from '../seed/ids';
import { channelCapacity, senderInsights, weeklyInvitesUsed, whyNotSending } from '../senders/diagnosis';
import {
  cancelChange, CEILINGS, experimentResult, groupsOf, latestSnapshot, newChange, payloadProblem, prohibited, renderJson, revertBuild,
  senderVars, settleProfiles, T, validate, whyNot,
} from '../senders/profile';
import { addEvent, ceilingProvider, channelTotal, D, effectiveCap, iso, randomHex, scopesToday, senderOr404 } from '../senders/util';
import { localParts } from '../sim/caps';

const ASSETS_BUCKET = 'outreach-profile-assets';
const assetUrl = (path: string) => storedUrl(ASSETS_BUCKET, path);
const settle = (ctx: Ctx) => settleProfiles(ctx.store, assetUrl);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HOST_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function changeOr404(ctx: Ctx, id: unknown): Row {
  const ch = typeof id === 'string' ? ctx.store.get(T.changes, id) : undefined;
  if (!ch || ch.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Change not found');
  return ch;
}

/** The demo user owns the account when it is theirs by user id or by email. */
export const callerIsOwner = (ctx: Ctx, s: Row) => s.owner_user_id === ctx.userId || String(s.owner_email ?? '').toLowerCase() === DEMO_USER_EMAIL;

function pendingOf(store: DemoStore, senderId: string): Row[] {
  return store.t(T.changes).filter((c) => c.sender_id === senderId && ['draft', 'awaiting_owner', 'approved', 'queued'].includes(c.status))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((c) => ({ id: c.id, status: c.status, field_groups: c.field_groups, source: c.source, scheduled_for: c.scheduled_for, created_at: c.created_at, mode: c.mode, note: c.note, payload: c.payload, assets: c.assets, error_code: c.error_code }));
}

export function profileOverview(ctx: Ctx, senderId: string): Row {
  settle(ctx);
  const store = ctx.store;
  const s = senderOr404(ctx, senderId);
  if (s.deleted_at) demoError('E_NOT_FOUND', 'Sender not found');
  const snap = latestSnapshot(store, s.id);
  const qa = store.get(T.qa, s.id, 'sender_id');
  const exp = store.t(T.experiments).find((e) => (e.sender_ids ?? []).includes(s.id) && ['washout', 'running', 'ready'].includes(e.status));
  const lastWritten: Row = {};
  const applied = store.t(T.changes).filter((c) => c.sender_id === s.id && ['applied', 'partially_applied'].includes(c.status)).sort((a, b) => String(b.applied_at).localeCompare(String(a.applied_at)));
  for (const c of applied) for (const k of ['picture_settings', 'cover_picture_settings', 'custom_link', 'skills_follow', 'location']) if (k in (c.payload ?? {}) && !(k in lastWritten)) lastWritten[k] = c.payload[k];
  return {
    sender: { id: s.id, name: s.display_name, public_identifier: s.public_identifier, picture_url: s.picture_url, owner_email: s.owner_email, status: s.status, warmup_level: s.warmup_level, connections_count: s.connections_count, timezone: s.timezone, auth_method: s.auth_method, identity_unverified: !!s.profile_identity_unverified },
    snapshot: snap ? { id: snap.id, kind: snap.kind, captured_at: snap.captured_at, fidelity: snap.fidelity, sections: snap.sections, data: snap.data } : null,
    qa: qa ? { score: qa.score, checks: qa.checks, computed_at: qa.computed_at } : null,
    status: whyNot(store, s),
    pending: pendingOf(store, s.id),
    last_written: lastWritten,
    experiment: exp ? { id: exp.id, name: exp.name, status: exp.status, field_group: exp.field_group } : null,
    ceilings: Object.fromEntries(Object.entries(CEILINGS).map(([k, v]) => [k, { max: v.max, window_days: v.window_days }])),
  };
}

function draftChange(ctx: Ctx, a: Row): Row {
  const store = ctx.store;
  const s = senderOr404(ctx, a.p_sender);
  if (s.deleted_at) demoError('E_NOT_FOUND', 'Sender not found');
  const p: Row = a.p_payload ?? {};
  const assets: Row = a.p_assets ?? {};
  const source = a.p_source ?? 'manual';
  if (!['manual', 'template', 'experiment', 'ai_draft', 'rollback', 'mcp'].includes(source)) demoError('E_PAYLOAD_INVALID', 'source');
  const bad = prohibited(p);
  if (bad) demoError('E_PROFILE_PROHIBITED', `the platform never writes ${bad}`);
  const prob = payloadProblem(p);
  if (prob) demoError('E_PAYLOAD_INVALID', prob);
  const groups = groupsOf(p, assets);
  if (!groups.length) demoError('E_PAYLOAD_INVALID', 'nothing to change');
  const ch = newChange(store, s, { payload: p, assets, source, template_id: a.p_template ?? null, experiment_id: a.p_experiment ?? null, note: a.p_note ?? null });
  return { id: ch.id, status: 'draft', field_groups: groups, validation: validate(store, s, p, assets, { change: ch.id, experiment: a.p_experiment ?? null }) };
}

export const sendersRpc = {
  // ---------------------------------------------------------------- tracking domains
  add_tracking_domain: (a, ctx) => {
    const h = String(a.p_hostname ?? '').trim().toLowerCase();
    if (!HOST_RE.test(h)) demoError('E_PAYLOAD_INVALID', 'enter a hostname such as link.agency.com');
    if (a.p_sender) {
      const s = ctx.store.get('outreach_senders', a.p_sender);
      if (!s || s.workspace_id !== ctx.ws || s.provider === 'LINKEDIN') demoError('E_NOT_FOUND', 'mailbox');
    }
    if (ctx.store.t('outreach_tracking_domains').some((d) => String(d.hostname).toLowerCase() === h)) demoError('E_PAYLOAD_INVALID', 'this hostname is already registered');
    const d = ctx.store.insert('outreach_tracking_domains', {
      workspace_id: ctx.ws, sender_id: a.p_sender ?? null, hostname: h, status: 'pending_dns', cname_target: 'track.links.example.com', checked_at: null, approved_at: null, note: null, created_by: ctx.userId,
    })[0];
    ctx.ui.simulated('Simulated. No DNS was checked: the demo domain verifies itself over the next minute.');
    return {
      id: d.id, hostname: d.hostname, status: d.status, dns: { type: 'CNAME', name: d.hostname, value: d.cname_target },
      next: 'Add the CNAME. We check it automatically; once it resolves the domain moves to "awaiting approval" while the email provider authorises it. Until it is active the default tracking domain is used.',
    };
  },
  remove_tracking_domain: (a, ctx) => {
    const d = ctx.store.get('outreach_tracking_domains', a.p_id);
    if (!d || d.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Tracking domain not found');
    ctx.store.remove('outreach_tracking_domains', d.id);
    return null;
  },

  // ---------------------------------------------------------------- caps and capacity
  channel_capacity: (a, ctx) => channelCapacity(ctx, a.p_client ?? null),
  effective_cap: (a, ctx) => {
    const s = ctx.store.get('outreach_senders', a.p_sender);
    if (!s) return 0;
    return effectiveCap(ctx.store, s, String(a.p_type ?? ''));
  },
  sender_scopes_today: (a, ctx) => scopesToday(ctx.store, senderOr404(ctx, a.p_sender)),
  weekly_invites_used: (a, ctx) => {
    const s = senderOr404(ctx, a.p_sender);
    return weeklyInvitesUsed(ctx.store, s, String(a.p_day ?? localParts(Date.now(), s.timezone ?? 'UTC').day));
  },
  set_manual_caps: (a, ctx) => {
    const s = senderOr404(ctx, a.p_sender);
    const clean: Row = {};
    for (const [k, raw] of Object.entries((a.p_caps ?? {}) as Row)) {
      const v = Math.trunc(Number(raw));
      if (!Number.isFinite(v)) demoError('E_PAYLOAD_INVALID', `bad value for ${k}`);
      const c = k === 'all_metered' ? channelTotal(ctx.store, s.provider, 5)
        : ctx.store.t('outreach_platform_ceilings').find((x) => x.provider === ceilingProvider(s.provider) && x.action_type === k)?.per_day ?? null;
      if (c == null) demoError('E_PAYLOAD_INVALID', `unknown action type ${k}`);
      if (v > c) demoError('E_CAP_ABOVE_CEILING', `${k} max is ${c}`);
      if (v >= 0) clean[k] = v;
    }
    ctx.store.update('outreach_senders', s.id, { manual_caps: clean });
    addEvent(ctx.store, s.id, 'caps', clean);
    return null;
  },
  set_sender_schedule: (a, ctx) => {
    const s = senderOr404(ctx, a.p_sender);
    const tz = String(a.p_timezone ?? '');
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); } catch { demoError('E_PAYLOAD_INVALID', 'unknown timezone'); }
    if (!tz) demoError('E_PAYLOAD_INVALID', 'unknown timezone');
    const sched = (a.p_schedule ?? {}) as Row;
    for (const [k, wins] of Object.entries(sched)) {
      if (!WEEKDAYS.includes(k)) demoError('E_PAYLOAD_INVALID', `bad weekday ${k}`);
      for (const w of (wins ?? []) as unknown[]) {
        if (!Array.isArray(w) || w.length !== 2 || !/^\d\d:\d\d$/.test(String(w[0])) || !/^\d\d:\d\d$/.test(String(w[1])) || String(w[0]) >= String(w[1])) demoError('E_PAYLOAD_INVALID', `bad window on ${k}`);
      }
    }
    ctx.store.update('outreach_senders', s.id, { schedule: sched, timezone: tz });
    addEvent(ctx.store, s.id, 'schedule', { timezone: tz, schedule: sched });
    return null;
  },

  // ---------------------------------------------------------------- sender settings
  pause_sender: (a, ctx) => {
    const s = senderOr404(ctx, a.p_sender);
    if (a.p_pause) {
      if (s.status === 'ok') {
        ctx.store.update('outreach_senders', s.id, { status: 'paused', status_reason: 'user_paused' });
        addEvent(ctx.store, s.id, 'status', { from: 'ok', to: 'paused', reason: 'user_paused' });
        ctx.store.update('outreach_actions', (x) => x.sender_id === s.id && x.status === 'reserved', { status: 'queued', reserved_at: null }, { silent: true });
      }
    } else if (s.status === 'paused') {
      ctx.store.update('outreach_senders', s.id, { status: 'ok', status_reason: null, last_ok_at: ctx.now() });
      addEvent(ctx.store, s.id, 'status', { from: 'paused', to: 'ok', reason: null });
    }
    return null;
  },
  update_sender: (a, ctx) => {
    const s = senderOr404(ctx, a.p_sender);
    const p = (a.p_patch ?? {}) as Row;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(p, k);
    const blank = (v: unknown) => (v == null || v === '' ? null : v);
    if (has('alert_emails')) {
      const list = Array.isArray(p.alert_emails) ? p.alert_emails.map(String) : [];
      for (const em of list) if (!EMAIL_RE.test(em)) demoError('E_PAYLOAD_INVALID', `"${em}" is not an email address`);
      if (list.length > 10) demoError('E_PAYLOAD_INVALID', 'at most 10 alert recipients');
    }
    if (has('booking_link') && blank(p.booking_link) && !/^https:\/\//.test(String(p.booking_link))) demoError('E_PAYLOAD_INVALID', 'booking link must start with https://');
    if (has('parent_sender_id') && blank(p.parent_sender_id)) {
      const parent = ctx.store.get('outreach_senders', p.parent_sender_id);
      if (!parent || parent.workspace_id !== s.workspace_id || parent.provider !== 'LINKEDIN') demoError('E_PAYLOAD_INVALID', 'a mailbox can only belong to a LinkedIn sender of the same workspace');
    }
    if (has('label') && String(p.label ?? '').trim().length > 80) demoError('E_PAYLOAD_INVALID', 'the label can be up to 80 characters');
    const patch: Row = {};
    if (p.display_name != null) patch.display_name = p.display_name;
    if (has('client_id')) patch.client_id = blank(p.client_id);
    if (has('owner_email')) patch.owner_email = blank(p.owner_email) ? String(p.owner_email).trim().toLowerCase() : null;
    if (has('alert_emails')) patch.alert_emails = (p.alert_emails ?? []).map((x: string) => String(x).trim().toLowerCase());
    if (has('booking_link')) patch.booking_link = blank(p.booking_link);
    if (has('signature')) patch.signature = blank(p.signature);
    if (has('bcc_address')) patch.bcc_address = blank(p.bcc_address) ? String(p.bcc_address).trim().toLowerCase() : null;
    if (has('monthly_cost')) patch.monthly_cost = blank(p.monthly_cost) == null ? null : Number(p.monthly_cost);
    if (has('parent_sender_id')) patch.parent_sender_id = blank(p.parent_sender_id);
    if (has('track_replies')) patch.track_replies = p.track_replies == null ? null : !!p.track_replies;
    if (has('label')) patch.label = String(p.label ?? '').trim() || null;
    ctx.store.update('outreach_senders', s.id, patch);
    return null;
  },
  issue_sender_token: (a, ctx) => {
    const s = senderOr404(ctx, a.p_sender);
    const tok = randomHex(ctx.store, 32);
    ctx.store.upsert('outreach_sender_tokens', { sender_id: s.id, token_hash: `demo-${tok.slice(0, 16)}`, issued_at: ctx.now(), last_used_at: null }, ['sender_id']);
    ctx.store.update('outreach_senders', s.id, { extension_token_issued_at: ctx.now() });
    return tok;
  },

  // ---------------------------------------------------------------- insights
  sender_insights: (a, ctx) => senderInsights(ctx, a.p_sender),
  why_not_sending: (a, ctx) => whyNotSending(ctx, a),

  // ---------------------------------------------------------------- Profile Studio: reads
  profile_overview: (a, ctx) => profileOverview(ctx, a.p_sender),
  profile_history: (a, ctx) => {
    settle(ctx);
    const s = senderOr404(ctx, a.p_sender);
    const lim = Math.max(1, Math.min(Number(a.p_limit ?? 50), 200));
    return ctx.store.t(T.changes).filter((c) => c.sender_id === s.id).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, lim).map((c) => ({
      id: c.id, status: c.status, field_groups: c.field_groups, source: c.source, mode: c.mode, payload: c.payload, assets: c.assets, applied_fields: c.applied_fields ?? [], failed_fields: c.failed_fields ?? {},
      error_code: c.error_code, requested_by_email: c.requested_by_email, approved_by_email: c.approved_by_email, owner_notified_at: c.owner_notified_at, scheduled_for: c.scheduled_for,
      applied_at: c.applied_at, verified_at: c.verified_at, reverted_at: c.reverted_at, created_at: c.created_at, note: c.note, reverts_change_id: c.reverts_change_id,
      pre_snapshot_id: c.pre_snapshot_id, post_snapshot_id: c.post_snapshot_id, before: c.pre_snapshot_id ? ctx.store.get(T.snapshots, c.pre_snapshot_id)?.data ?? null : null,
      can_revert: ['applied', 'partially_applied'].includes(c.status) && !!c.pre_snapshot_id,
    }));
  },
  profile_changes_list: (a, ctx) => {
    settle(ctx);
    const statuses: string[] | null = Array.isArray(a.p_statuses) && a.p_statuses.length ? a.p_statuses : null;
    const lim = Math.max(1, Math.min(Number(a.p_limit ?? 100), 500));
    return inWs(ctx, T.changes, (c) => !statuses || statuses.includes(c.status)).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, lim).flatMap((c) => {
      const s = ctx.store.get('outreach_senders', c.sender_id);
      if (!s) return [];
      return [{ id: c.id, sender_id: c.sender_id, sender_name: s.display_name, sender_picture: s.picture_url, status: c.status, field_groups: c.field_groups, source: c.source, mode: c.mode, scheduled_for: c.scheduled_for, applied_at: c.applied_at, created_at: c.created_at, error_code: c.error_code, template_id: c.template_id, experiment_id: c.experiment_id, owner_email: s.owner_email, payload: c.payload }];
    });
  },
  profile_authority_list: (a, ctx) => {
    const s = senderOr404(ctx, a.p_sender);
    const now = Date.now();
    const grants = ctx.store.t(T.authority).filter((g) => g.sender_id === s.id)
      .sort((x, y) => (x.revoked_at ? 1 : 0) - (y.revoked_at ? 1 : 0) || String(y.granted_at).localeCompare(String(x.granted_at)))
      .map((g) => ({ id: g.id, field_group: g.field_group, mode: g.mode, granted_by_email: g.granted_by_email, granted_via: g.granted_via, granted_at: g.granted_at, expires_at: g.expires_at, revoked_at: g.revoked_at, revoked_reason: g.revoked_reason, active: !g.revoked_at && (!g.expires_at || Date.parse(g.expires_at) > now) }));
    const links = ctx.store.t(T.links).filter((l) => l.sender_id === s.id && Date.parse(l.created_at) > now - 90 * D).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))
      .map((l) => ({ id: l.id, field_groups: l.field_groups, mode: l.mode, owner_email: l.owner_email, expires_at: l.expires_at, accepted_at: l.accepted_at, declined_at: l.declined_at, created_at: l.created_at }));
    return { grants, links, owner_email: s.owner_email ?? null, caller_is_owner: callerIsOwner(ctx, s) };
  },
  profile_experiments_list: (a, ctx) => {
    settle(ctx);
    void a;
    return inWs(ctx, T.experiments).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).map((e) => ({
      id: e.id, name: e.name, field_group: e.field_group, status: e.status, variants: e.variants, sender_ids: e.sender_ids, assignment: e.assignment, washout_days: e.washout_days,
      min_invites_per_variant: e.min_invites_per_variant, started_at: e.started_at, washout_until: e.washout_until, concluded_at: e.concluded_at, result: e.result, created_at: e.created_at,
      senders: (e.sender_ids as string[]).map((id) => ctx.store.get('outreach_senders', id)).filter(Boolean).map((s) => ({ id: s!.id, name: s!.display_name, variant: e.assignment?.[s!.id] ?? null })),
      changes: ctx.store.t(T.changes).filter((c) => c.experiment_id === e.id).map((c) => ({ id: c.id, sender_id: c.sender_id, status: c.status })),
    }));
  },
  profile_experiment_result: (a, ctx) => {
    settle(ctx);
    const e = ctx.store.get(T.experiments, a.p_id);
    if (!e || e.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Experiment not found');
    return experimentResult(ctx.store, e);
  },
  profile_qa_correlation: (a, ctx) => {
    void a;
    const now = Date.now();
    return inWs(ctx, 'outreach_senders', (s) => !s.deleted_at && s.provider === 'LINKEDIN').sort((x, y) => String(x.display_name ?? '').localeCompare(String(y.display_name ?? ''))).map((s) => {
      const st = ctx.store.t('outreach_lead_sender_state').filter((x) => x.sender_id === s.id && x.invite_sent_at && Date.parse(x.invite_sent_at) > now - 30 * D);
      const inv = st.length; const acc = st.filter((x) => x.invite_accepted_at).length;
      return { sender_id: s.id, name: s.display_name, qa: s.profile_qa_score ?? null, health: s.health_score, invites_30d: inv, accepted_30d: acc, acceptance_rate: inv >= 10 ? Math.round((1000 * acc) / inv) / 10 : null };
    });
  },
  profile_revert_build: (a, ctx) => revertBuild(ctx.store, changeOr404(ctx, a.p_change)),

  // ---------------------------------------------------------------- Profile Studio: writes
  profile_draft_change: (a, ctx) => draftChange(ctx, a),
  profile_update_draft: (a, ctx) => {
    const store = ctx.store;
    const ch = changeOr404(ctx, a.p_change);
    const s = store.get('outreach_senders', ch.sender_id);
    if (ch.status !== 'draft') demoError('E_PROFILE_STATE', `only drafts can be edited (this change is ${ch.status})`);
    const p: Row = a.p_payload ?? {};
    const bad = prohibited(p);
    if (bad) demoError('E_PROFILE_PROHIBITED', `the platform never writes ${bad}`);
    const prob = payloadProblem(p);
    if (prob) demoError('E_PAYLOAD_INVALID', prob);
    const assets: Row = a.p_assets ?? ch.assets ?? {};
    const groups = groupsOf(p, assets);
    if (!groups.length) demoError('E_PAYLOAD_INVALID', 'nothing to change');
    store.update(T.changes, ch.id, { payload: p, assets, field_groups: groups, note: a.p_note != null ? String(a.p_note).slice(0, 500) : ch.note, updated_at: ctx.now() });
    return { id: ch.id, status: 'draft', field_groups: groups, validation: validate(store, s, p, assets, { change: ch.id, experiment: ch.experiment_id }) };
  },
  profile_cancel_change: (a, ctx) => { cancelChange(ctx.store, changeOr404(ctx, a.p_change), a.p_reason ?? 'cancelled'); return null; },
  profile_authority_self: (a, ctx) => {
    const s = senderOr404(ctx, a.p_sender);
    if (s.deleted_at) demoError('E_NOT_FOUND', 'Sender not found');
    if (!callerIsOwner(ctx, s)) demoError('E_FORBIDDEN', "only the account owner can grant this for themselves (set the sender's owner email to your own address, or send the owner a permission link)");
    if (!['propose_only', 'direct'].includes(a.p_mode)) demoError('E_PAYLOAD_INVALID', 'mode');
    const groups: string[] = Array.isArray(a.p_groups) ? a.p_groups : [];
    if (!groups.length) demoError('E_PAYLOAD_INVALID', 'pick at least one field group');
    const now = ctx.now();
    for (const g of groups) {
      ctx.store.update(T.authority, (x) => x.sender_id === s.id && x.field_group === g && !x.revoked_at, { revoked_at: now, revoked_reason: 'replaced', revoked_by: ctx.userId });
      ctx.store.insert(T.authority, { workspace_id: s.workspace_id, sender_id: s.id, field_group: g, mode: a.p_mode, granted_by_email: DEMO_USER_EMAIL, granted_via: 'owner_is_operator', evidence: { user_id: ctx.userId, signed_at: now }, granted_at: now, expires_at: a.p_expires_days ? iso(Date.now() + Number(a.p_expires_days) * D) : null, revoked_at: null, revoked_reason: null, revoked_by: null });
    }
    return { granted: groups.length, mode: a.p_mode };
  },
  profile_authority_revoke: (a, ctx) => {
    const g = ctx.store.get(T.authority, a.p_authority);
    if (!g || g.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Permission not found');
    if (g.revoked_at) return null;
    ctx.store.update(T.authority, g.id, { revoked_at: ctx.now(), revoked_reason: String(a.p_reason ?? 'revoked').slice(0, 200), revoked_by: ctx.userId });
    ctx.store.update(T.changes, (c) => c.sender_id === g.sender_id && ['awaiting_owner', 'approved'].includes(c.status) && (c.field_groups ?? []).includes(g.field_group), { status: 'cancelled', cancelled_reason: 'authority_revoked' });
    return null;
  },
  profile_template_save: (a, ctx) => {
    const name = String(a.p_name ?? '').trim();
    if (!name) demoError('E_PAYLOAD_INVALID', 'name');
    const body: Row = a.p_body ?? {};
    const bad = prohibited(body);
    if (bad) demoError('E_PROFILE_PROHIBITED', `the platform never writes ${bad}`);
    if ('picture' in body || 'cover_picture' in body) demoError('E_PAYLOAD_INVALID', 'templates hold text fields only (photos are per sender)');
    const groups = groupsOf(body, {});
    if (!groups.length) demoError('E_PAYLOAD_INVALID', 'the template has no fields');
    if (a.p_client && !ctx.store.t('outreach_clients').some((c) => c.id === a.p_client && c.workspace_id === ctx.ws)) demoError('E_NOT_FOUND', 'client');
    const now = ctx.now();
    if (!a.p_id) return ctx.store.insert(T.templates, { workspace_id: ctx.ws, client_id: a.p_client ?? null, name, field_groups: groups, body, variables: a.p_variables ?? {}, created_by: ctx.userId, updated_by: ctx.userId, created_at: now, updated_at: now })[0].id;
    const t = ctx.store.get(T.templates, a.p_id);
    if (!t || t.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Template not found');
    ctx.store.update(T.templates, t.id, { name, client_id: a.p_client ?? null, field_groups: groups, body, variables: a.p_variables ?? {}, updated_by: ctx.userId, updated_at: now });
    return t.id;
  },
  profile_template_delete: (a, ctx) => {
    const t = ctx.store.get(T.templates, a.p_id);
    if (!t || t.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Template not found');
    ctx.store.remove(T.templates, t.id);
    ctx.store.update(T.changes, (c) => c.template_id === t.id, { template_id: null }, { silent: true });
    return null;
  },
  profile_bulk_preview: (a, ctx) => {
    settle(ctx);
    const store = ctx.store;
    const t = store.get(T.templates, a.p_template);
    if (!t || t.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Template not found');
    const ids: string[] = Array.isArray(a.p_sender_ids) ? a.p_sender_ids : [];
    if (!ids.length) demoError('E_PAYLOAD_INVALID', 'pick at least one sender');
    if (ids.length > 50) demoError('E_TOO_MANY', 'at most 50 senders per run');
    const rows: Row[] = [];
    let ok = 0, excluded = 0;
    for (const sid of ids) {
      const s = store.get('outreach_senders', sid);
      if (!s || s.workspace_id !== t.workspace_id || s.deleted_at) { rows.push({ sender_id: sid, ok: false, causes: [{ code: 'E_NOT_FOUND', blocking: true, detail: 'Sender not found in this workspace' }] }); excluded++; continue; }
      const vars = { ...(t.variables ?? {}), ...senderVars(store, s), ...(a.p_vars ?? {}) };
      const payload = renderJson(t.body, vars) as Row;
      const v = validate(store, s, payload, {}, { bulk: ids.length });
      rows.push({ sender_id: sid, name: s.display_name, picture_url: s.picture_url, owner_email: s.owner_email, payload, field_groups: v.groups, ok: v.ok, mode: v.mode, causes: v.causes.filter((c: Row) => c.blocking) });
      if (v.ok) ok++; else excluded++;
    }
    const expires = iso(Date.now() + 30 * 60_000);
    const run = store.insert(T.runs, { workspace_id: ctx.ws, template_id: t.id, experiment_id: null, sender_ids: ids, variables: a.p_vars ?? {}, rows, eligible: ok, excluded, status: 'preview', expires_at: expires, committed_at: null, result: null, created_by: ctx.userId })[0];
    return { run_id: run.id, template: { id: t.id, name: t.name, field_groups: t.field_groups }, rows, eligible: ok, excluded, expires_at: expires, pacing: "Changes are spread out: at most one sender per hour and 8 per day for the workspace, each inside the sender's working hours." };
  },
  profile_link_sequence: (a, ctx) => {
    const q = ctx.store.get('outreach_sequences', a.p_sequence);
    if (!q || q.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Sequence not found');
    if (a.p_template && !ctx.store.t(T.templates).some((t) => t.id === a.p_template && t.workspace_id === ctx.ws)) demoError('E_NOT_FOUND', 'template');
    ctx.store.update('outreach_sequences', q.id, (r) => {
      const settings = { ...(r.settings ?? {}) };
      if (a.p_template) settings.profile_template_id = a.p_template; else delete settings.profile_template_id;
      return { settings, updated_at: ctx.now() };
    });
    return null;
  },
  profile_experiment_create: (a, ctx) => {
    const store = ctx.store;
    if (!['headline', 'about', 'photo'].includes(a.p_field_group)) demoError('E_PAYLOAD_INVALID', 'experiments cover headline, about or photo');
    const variants: Row[] = Array.isArray(a.p_variants) ? a.p_variants : [];
    const nv = variants.length;
    if (nv < 2 || nv > 4) demoError('E_PAYLOAD_INVALID', '2 to 4 variants');
    if (variants.some((v) => !v?.key || v.value == null || v.value === '')) demoError('E_PAYLOAD_INVALID', 'every variant needs a key and a value');
    if (new Set(variants.map((v) => v.key)).size !== nv) demoError('E_PAYLOAD_INVALID', 'variant keys must be unique');
    const ids: string[] = Array.isArray(a.p_sender_ids) ? a.p_sender_ids : [];
    if (ids.length < 2 * nv) demoError('E_PAYLOAD_INVALID', `at least 2 senders per variant (${2 * nv} needed)`);
    for (const sid of ids) {
      const s = store.get('outreach_senders', sid);
      if (!s || s.workspace_id !== ctx.ws || s.deleted_at || s.provider !== 'LINKEDIN') demoError('E_NOT_FOUND', `sender ${sid} is not a LinkedIn sender of this workspace`);
      const busy = store.t(T.experiments).find((e) => (e.sender_ids ?? []).includes(sid) && ['draft', 'washout', 'running', 'ready'].includes(e.status));
      if (busy) demoError('E_EXPERIMENT_LOCK', `${s.display_name} is already in the experiment "${busy.name}"`);
    }
    return store.insert(T.experiments, {
      workspace_id: ctx.ws, name: String(a.p_name ?? '').trim() || 'Experiment', field_group: a.p_field_group, variants, sender_ids: ids, assignment: {}, metric: 'acceptance_rate',
      washout_days: Number(a.p_washout_days ?? 3), min_invites_per_variant: Number(a.p_min_invites ?? 120), status: 'draft', started_at: null, washout_until: null, concluded_at: null, result: null, notes: [], created_by: ctx.userId,
    })[0].id;
  },
  profile_experiment_abandon: (a, ctx) => {
    const e = ctx.store.get(T.experiments, a.p_id);
    if (!e || e.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Experiment not found');
    if (['concluded', 'abandoned'].includes(e.status)) return null;
    for (const c of ctx.store.t(T.changes).filter((x) => x.experiment_id === e.id && ['draft', 'awaiting_owner', 'approved', 'queued'].includes(x.status))) cancelChange(ctx.store, c, 'experiment_abandoned');
    ctx.store.update(T.experiments, e.id, { status: 'abandoned', concluded_at: ctx.now(), result: { ...(e.result ?? {}), reason: String(a.p_reason ?? 'abandoned').slice(0, 200) } });
    return null;
  },
} satisfies RpcArea;

/** Table hooks (insert defaults, side effects) for this area's tables. Called once at boot. */
export function registerSenders(): void {
  // A tracking domain added in the demo "resolves" on its own: DNS found after ~30 s, approved after ~90 s (simulated time).
  tableHooks.outreach_tracking_domains = {
    ...(tableHooks.outreach_tracking_domains ?? {}),
    beforeInsert: (row) => ({ status: 'pending_dns', cname_target: 'track.links.example.com', checked_at: null, approved_at: null, note: null, sender_id: null, ...row }),
    beforeRead: (store) => {
      const now = Date.now();
      for (const d of store.t('outreach_tracking_domains')) {
        const age = now - Date.parse(d.created_at);
        if (d.status === 'pending_dns' && age > 30_000) store.update('outreach_tracking_domains', d.id, { status: 'awaiting_approval', checked_at: iso(now), note: null }, { silent: true });
        else if (d.status === 'awaiting_approval' && age > 90_000) store.update('outreach_tracking_domains', d.id, { status: 'active', checked_at: iso(now), approved_at: iso(now) }, { silent: true });
      }
    },
  };
  tableHooks.outreach_profile_templates = {
    ...(tableHooks.outreach_profile_templates ?? {}),
    beforeInsert: (row, store) => ({ client_id: null, variables: {}, field_groups: groupsOf(row.body ?? {}, {}), updated_at: store.nowIso(), ...row }),
  };
}

