/**
 * Demo edge functions: sender-connect, sender-disable, sender-lifecycle, sender-manage, sender-update-proxy, profile.
 *
 * Connecting or reconnecting an account shows the shell's fake connect screen (`ctx.ui.dialog({ kind: 'connect' })`) and
 * then creates / revives a fictional sender locally. The "sign-in link" handed back is a same-app page
 * (`/product-tour/senders/<id>?connected=1`), so the wizard's full-page redirect lands on the new sender.
 */
import { OutreachError } from '../../../errors';
import { demoError, type Ctx, type FnArea, type FnRequest } from '../ctx';
import type { Row } from '../store';
import { storedUrl } from '../storage';
import { FIRST_NAMES, LAST_NAMES, slug } from '../seed/names';
import { engineFor } from '../sim/engine';
import {
  baselineDoc, computeQa, experimentPayload, experimentResult, latestSnapshot, newChange, ownerApprove, recordSnapshot, revertBuild, settleProfiles, submitChange, T, tokenHex, validate,
} from '../senders/profile';
import { addEvent, D, iso, isMail, MIN, senderOr404, setStatus } from '../senders/util';
import { holderView, profileOverview } from '../rpc/senders';
import { DEMO_USER_EMAIL } from '../seed/ids';
import { DEMO_PREFIX } from '@/lib/outreach/mode';

const PROVIDERS = ['LINKEDIN', 'INSTAGRAM', 'WHATSAPP', 'GMAIL', 'OUTLOOK', 'IMAP'];
const WEEKDAYS = { mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [['09:00', '18:00']], thu: [['09:00', '18:00']], fri: [['09:00', '18:00']], sat: [], sun: [] };
const ASSETS_BUCKET = 'outreach-profile-assets';
const assetUrl = (path: string) => storedUrl(ASSETS_BUCKET, path);

/** The page the hosted sign-in would return to. A same-app page: the demo state is saved on pagehide. */
const landing = (id: string) => `${DEMO_PREFIX}/senders/${id}?connected=1`;

/** What the connect screen shows for a provider and a sign-in method. */
function connectMethod(provider: string, method?: string | null): string {
  if (provider === 'LINKEDIN') return method === 'browser' ? 'browser' : method === 'cookie' ? 'cookie' : 'credentials';
  if (provider === 'WHATSAPP') return 'qr';
  if (provider === 'GMAIL' || provider === 'OUTLOOK') return 'oauth';
  if (provider === 'IMAP') return 'imap';
  return 'credentials';
}

async function fakeSignIn(ctx: Ctx, provider: string, method: string) {
  const ok = await ctx.ui.dialog({ kind: 'connect', provider, method });
  if (!ok) demoError('E_CANCELLED', 'Cancelled');
}

/** A fictional identity for a newly connected account. */
function fictional(ctx: Ctx, provider: string, displayName: string | null, ownerEmail: string | null): Row {
  const st = ctx.store;
  const first = st.pick(FIRST_NAMES); const last = st.pick(LAST_NAMES);
  const person = `${first} ${last}`;
  const handle = `${slug(first)}.${slug(last)}`;
  const phone = `+1555010${st.int(10, 99)}`;
  switch (provider) {
    case 'LINKEDIN': return { display_name: displayName || person, public_identifier: `demo-${slug(person)}`, connections_count: st.int(320, 1400), is_premium: st.chance(0.3) };
    case 'INSTAGRAM': return { display_name: displayName || handle, public_identifier: handle, connections_count: st.int(400, 3200) };
    case 'WHATSAPP': return { display_name: displayName || `${first}'s WhatsApp`, public_identifier: phone, connections_count: null };
    default: return { display_name: displayName || ownerEmail || `${slug(first)}@example.com`, public_identifier: null, connections_count: null };
  }
}

/** A sender row with every column the screens read (the same defaults the seed uses). */
function senderRow(ctx: Ctx, o: Row): Row {
  const id = ctx.store.uid();
  const now = ctx.now();
  return {
    id, workspace_id: ctx.ws, client_id: null, owner_user_id: ctx.userId, owner_email: null, provider: 'LINKEDIN', unipile_account_id: null, previous_unipile_account_id: null,
    disconnected_at: null, billing_paused_at: null, auth_method: 'credentials', display_name: null, label: null, public_identifier: null, provider_user_id: `demo-${id.slice(-6)}`,
    picture_url: null, is_premium: false, has_sales_nav: false, has_recruiter: false, connections_count: null, status: 'connecting', status_reason: null, deleted_at: null,
    proxy_country: 'US', user_agent: null, timezone: 'UTC', schedule: WEEKDAYS, warmup_level: 1, warmup_locked_until: null, health_score: 90,
    health_breakdown: { acceptance: 90, pending: 92, rejects: 100, activity: 80 }, manual_caps: {}, rejects_1h: 0, paused_until: null, invite_blocked_until: null,
    reconnect_attempts: 0, connected_at: null, last_ok_at: null, last_disconnect_at: null, last_reconnect_at: null, last_synced_at: now, extension_token_issued_at: null, running_dry_at: null,
    alert_emails: [], booking_link: null, signature: null, bcc_address: null, parent_sender_id: null, monthly_cost: 0, track_replies: null, enrich_empty_streak: 0,
    enrich_backoff_until: null, profile_qa_score: null, profile_identity_unverified: false, profile_snapshot_at: null, outreach_allowed_from: null, provider_warning: null,
    account_age_attested_at: null, account_age_attested_by: null, account_age_months: null, health_high_since: null, created_at: now, updated_at: now, ...o,
  };
}

/** Brings a sender back to "ok" after the fake sign-in: a new account id, the reconnect bookkeeping, the quiet period. */
function reconnect(ctx: Ctx, s: Row, via: string): Row {
  const st = ctx.store;
  const patch: Row = { last_reconnect_at: ctx.now(), last_synced_at: ctx.now(), disconnected_at: null };
  if (!s.unipile_account_id) patch.unipile_account_id = `demo-acc-${st.uid().slice(-8)}`;
  addEvent(st, s.id, 'reconnect', { result: 'ok', via });
  const fresh = setStatus(st, s, 'ok', null, patch);
  engineFor(st).resetIndexes();
  return fresh;
}

// ---------------------------------------------------------------------------
async function senderConnect(req: FnRequest, ctx: Ctx) {
  const st = ctx.store;
  const b = req.body;
  const provider = String(b.provider ?? '').toUpperCase();
  if (!b.workspace_id || !provider) demoError('E_PAYLOAD_INVALID', 'workspace_id and provider required');
  if (!PROVIDERS.includes(provider)) demoError('E_PAYLOAD_INVALID', `unknown provider ${b.provider}`);
  let ageMonths: number | null = null;
  if (provider === 'WHATSAPP') {
    const m = Number(b.account_age_months);
    if (!Number.isFinite(m) || m < 6 || b.account_age_attested !== true) demoError('E_ACCOUNT_TOO_NEW', 'WhatsApp numbers need at least 6 months of real use before outreach');
    ageMonths = Math.floor(m);
  }
  // Whose account is this? Mine → the demo user; a teammate's email → that member; anyone else is refused (103)
  const typed = String(b.holder?.email ?? b.owner_email ?? '').trim().toLowerCase();
  let ownerUserId: string | null = ctx.userId; let holderMember: Row | undefined;
  if (b.holder?.mine !== true && typed) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(typed)) demoError('E_PAYLOAD_INVALID', 'Enter the email of the person who signs in to this account');
    if (typed !== DEMO_USER_EMAIL.toLowerCase()) {
      holderMember = st.t('outreach_members').find((m) => m.workspace_id === ctx.ws && String(m.email ?? '').toLowerCase() === typed);
      if (!holderMember) demoError('E_HOLDER_OUTSIDE', `Emails about an account only go to a teammate's sign-in email. Invite ${typed} to the workspace first, or connect the account under your own name.`);
      ownerUserId = holderMember.user_id;
    }
  }
  const browser = provider === 'LINKEDIN' && b.connect_method === 'browser';
  // one sender per owner email and channel (an unfinished sign-in for the same owner is reused)
  let reused: Row | undefined;
  if (ownerUserId) {
    const twins = st.t('outreach_senders').filter((s) => s.workspace_id === ctx.ws && s.provider === provider && s.owner_user_id === ownerUserId && !s.owner_email && !s.deleted_at && s.status !== 'disabled')
      .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
    const connected = twins.find((t) => t.unipile_account_id);
    if (connected && !b.allow_duplicate) {
      const details = { existing_sender_id: connected.id, existing_display_name: connected.display_name, existing_status: connected.status };
      throw new OutreachError(`${connected.display_name ?? 'This account'} is already connected for this person. Reconnect it instead of connecting it again.`, 'E_DUPLICATE_SENDER', { code: 'E_DUPLICATE_SENDER', details });
    }
    reused = twins.find((t) => !t.unipile_account_id && t.status === 'connecting');
  }

  await fakeSignIn(ctx, provider, connectMethod(provider, browser ? 'browser' : 'credentials'));

  const who = fictional(ctx, provider, String(b.display_name ?? '').trim() || null, null);
  const mail = isMail(provider);
  const nowMs = Date.now();
  const base: Row = {
    client_id: b.client_id || null, owner_email: null, owner_user_id: ownerUserId, connected_by: ctx.userId, provider,
    auth_method: browser ? 'browser' : mail ? 'oauth' : 'credentials', timezone: b.timezone || 'UTC', warmup_level: mail ? 3 : 1,
    has_recruiter: provider === 'LINKEDIN' && !!b.recruiter, ...who,
    warmup_locked_until: provider === 'LINKEDIN' || provider === 'INSTAGRAM' ? iso(nowMs + 7 * D) : null,
    ...(provider === 'WHATSAPP' ? { account_age_attested_at: ctx.now(), account_age_attested_by: ctx.userId, account_age_months: ageMonths } : {}),
  };
  let s: Row;
  if (reused) s = st.update('outreach_senders', reused.id, { ...base, status_reason: null })[0];
  else s = st.insert('outreach_senders', senderRow(ctx, base))[0];
  addEvent(st, s.id, 'reconnect', { method: 'connect_link', reused: !!reused, connect_method: browser ? 'browser' : 'credentials' });
  if (provider === 'WHATSAPP') addEvent(st, s.id, 'attest_account_age', { months: ageMonths, by: ctx.userId, at_connect: true });
  // the hosted page finished: the account exists and the sender is ok (warm-up level 1; mailboxes do not warm up)
  s = setStatus(st, s, 'ok', null, { unipile_account_id: `demo-acc-${s.id.slice(-8)}`, connected_at: ctx.now(), last_synced_at: ctx.now() });
  if (provider === 'LINKEDIN') { recordSnapshot(st, s, 'baseline', baselineDoc(st, s)); computeQa(st, st.get('outreach_senders', s.id)!); }
  ctx.ui.simulated('Demo account connected. Nothing left the browser.');
  return { link: landing(s.id), sender_id: s.id, reused: !!reused, holder: { kind: 'member', user_id: ownerUserId, name: holderMember?.display_name ?? null, mine: ownerUserId === ctx.userId } };
}

async function senderManage(req: FnRequest, ctx: Ctx) {
  const st = ctx.store;
  const b = req.body;
  const s = senderOr404(ctx, b.sender_id);
  switch (b.action) {
    case 'reconnect_link': {
      if (s.status === 'disabled') demoError('E_SENDER_NOT_OK', 'This sender is disabled.');
      const method = b.connect_method === 'browser' || b.connect_method === 'credentials' ? b.connect_method : s.auth_method === 'browser' ? 'browser' : 'credentials';
      await fakeSignIn(ctx, s.provider, connectMethod(s.provider, method));
      reconnect(ctx, s, b.mode === 'copy' ? 'relogin_link' : 'hosted_link');
      if (s.provider === 'LINKEDIN' && method === 'browser') st.update('outreach_senders', s.id, { auth_method: 'browser' });
      ctx.ui.simulated('Demo account signed in again. Nothing left the browser.');
      const link = landing(s.id);
      return b.mode === 'copy' ? { link, relogin_url: link } : { link };
    }
    case 'disconnect': {
      if (s.provider === 'WEBCHAT') demoError('E_PAYLOAD_INVALID', 'a website inbox has no connected account');
      const fresh = lifecycleRemove(ctx, s, 'app');
      ctx.ui.simulated();
      return { ok: true, account_deleted: true, state: 'removed', sender: fresh };
    }
    case 'enable': {
      if (s.status !== 'disabled' || s.deleted_at) demoError('E_SENDER_NOT_OK', 'Only a disabled sender can be re-enabled.');
      const fresh = lifecycleEnable(ctx, s);
      return { ok: true, state: fresh.status === 'removed' ? 'removed' : 'ok', sender: fresh };
    }
    case 'reconnect_cookie': {
      if (s.auth_method !== 'cookie' || s.status !== 'credentials') return { ok: false, reason: s.auth_method !== 'cookie' ? 'no_cookie' : 'not_disconnected' };
      reconnect(ctx, s, 'cookie');
      ctx.ui.simulated();
      return { ok: true };
    }
    case 'sign_in_incomplete': {
      if (s.status !== 'connecting' || s.unipile_account_id || s.status_reason) return { ok: false };
      st.update('outreach_senders', s.id, { status_reason: 'SIGN_IN_INCOMPLETE' });
      addEvent(st, s.id, 'reconnect', { result: 'incomplete', via: 'failure_redirect' });
      return { ok: true };
    }
    case 'set_cookie': {
      if (s.provider !== 'LINKEDIN') demoError('E_PAYLOAD_INVALID', 'session cookies apply to LinkedIn senders only');
      if (st.get('outreach_workspaces', ctx.ws)?.settings?.cookie_mode_opt_in === false) demoError('E_FORBIDDEN', 'Cookie mode is switched off for this workspace');
      const clean = (v?: string) => String(v ?? '').trim().replace(/^li_(at|a)\s*=\s*/i, '').replace(/^"|"$/g, '').replace(/;.*$/, '').trim();
      const liAt = clean(b.li_at); const liA = clean(b.li_a); const ua = String(b.user_agent ?? '').trim();
      if (!/^[^\s;",]{60,}$/.test(liAt)) demoError('E_PAYLOAD_INVALID', 'That does not look like a LinkedIn li_at cookie value');
      if (liA && !/^[^\s;",]{20,}$/.test(liA)) demoError('E_PAYLOAD_INVALID', 'That does not look like a LinkedIn li_a cookie value');
      if (ua.length < 20) demoError('E_PAYLOAD_INVALID', 'user_agent required');
      const patch: Row = { user_agent: ua };
      if (s.auth_method === 'credentials') patch.auth_method = 'cookie';
      st.update('outreach_senders', s.id, patch);
      ctx.ui.simulated('Simulated. The cookie stays in this browser tab.');
      let rec: Row | null = null;
      if (s.status === 'credentials') { reconnect(ctx, st.get('outreach_senders', s.id)!, 'cookie'); rec = { ok: true }; }
      return { ok: true, reconnect: rec };
    }
    case 'resync': {
      if (!s.unipile_account_id) demoError('E_SENDER_NOT_OK', 'The account is not connected');
      st.update('outreach_senders', s.id, { last_synced_at: ctx.now() });
      ctx.ui.simulated();
      return { ok: true };
    }
    case 'checkpoint': {
      if (!s.unipile_account_id || !b.code) demoError('E_PAYLOAD_INVALID', 'code required');
      addEvent(st, s.id, 'checkpoint', { solved: true });
      ctx.ui.simulated();
      return { ok: true, result: { object: 'Checkpoint', solved: true } };
    }
    case 'refresh_profile': {
      const fresh = st.update('outreach_senders', s.id, { last_synced_at: ctx.now(), connections_count: s.connections_count != null ? s.connections_count + st.int(0, 6) : null })[0];
      ctx.ui.simulated();
      return { ok: true, sender: fresh };
    }
    case 'backfill_inbox': ctx.ui.simulated(); return { ok: true, inserted: 0 };
    case 'resolve_chat_names': return { ok: true, resolved: 0, checked: 0 };
    case 'fill_chat_pictures': return { ok: true, found: 0 };
    case 'recompute_health': {
      const hb = (s.health_breakdown ?? {}) as Row;
      const vals = Object.entries(hb).filter(([k, v]) => typeof v === 'number' && k !== 'computed_at').map(([, v]) => v as number);
      const score = vals.length ? Math.round(vals.reduce((x, y) => x + y, 0) / vals.length) : Number(s.health_score ?? 90);
      if (score !== s.health_score) { addEvent(st, s.id, 'health', { from: s.health_score, to: score, breakdown: hb }); st.update('outreach_senders', s.id, { health_score: score }); }
      return { ok: true, score, breakdown: hb };
    }
    case 'plan_now': {
      if (s.status !== 'ok') demoError('E_SENDER_NOT_OK', 'The sender is not connected');
      const engine = engineFor(st);
      const before = st.t('outreach_actions').length;
      const now = Date.now();
      for (const e of st.t('outreach_enrollments').filter((x) => x.sender_id === s.id && ['active', 'waiting_connection', 'waiting_delay'].includes(x.status) && (!x.wait_until || Date.parse(x.wait_until) <= now))) engine.step(e, now);
      const planned = st.t('outreach_actions').length - before;
      return { ok: true, planned };
    }
    case 'account_status': return { status: s.unipile_account_id ? ['OK'] : null, connection_method: s.unipile_account_id ? s.auth_method : null };
    case 'attest_account_age': {
      if (s.provider !== 'WHATSAPP') demoError('E_PAYLOAD_INVALID', 'account age attestation applies to WhatsApp numbers only');
      const months = Math.floor(Number(b.months));
      if (!Number.isFinite(months) || months < 0) demoError('E_PAYLOAD_INVALID', 'months required');
      if (months < 6) demoError('E_ACCOUNT_TOO_NEW', 'WhatsApp numbers need at least 6 months of real use before outreach');
      const fresh = st.update('outreach_senders', s.id, { account_age_months: months, account_age_attested_at: ctx.now(), account_age_attested_by: ctx.userId })[0];
      addEvent(st, s.id, 'attest_account_age', { months, by: ctx.userId });
      return { ok: true, sender: fresh };
    }
    case 'resume_after_warning': {
      const fresh = st.update('outreach_senders', s.id, { provider_warning: null, paused_until: null, status_reason: s.status_reason === 'provider_warning' ? null : s.status_reason })[0];
      addEvent(st, s.id, 'status', { resumed_after_warning: true, by: ctx.userId });
      return { ok: true, sender: fresh };
    }
    case 'check_identifiers': {
      if (s.provider !== 'WHATSAPP') demoError('E_PAYLOAD_INVALID', 'identifier checks apply to WhatsApp numbers only');
      if (!s.unipile_account_id) demoError('E_SENDER_NOT_OK', 'this number is not connected');
      const ids = st.t('outreach_lead_identities').filter((x) => x.provider === 'WHATSAPP' && x.is_valid == null).slice(0, 50);
      let valid = 0;
      for (const x of ids) { const ok = st.chance(0.85); if (ok) valid++; st.update('outreach_lead_identities', x.id, { is_valid: ok, last_checked_at: ctx.now() }); }
      ctx.ui.simulated();
      return { ok: true, checked: ids.length, valid, invalid: ids.length - valid };
    }
    default: demoError('E_PAYLOAD_INVALID', `unknown action ${b.action}`);
  }
}

function senderDisable(req: FnRequest, ctx: Ctx) {
  const s = senderOr404(ctx, req.body.sender_id);
  if (req.body.delete_unipile) { lifecycleRemove(ctx, s, 'app'); ctx.ui.simulated(); return { ok: true, state: 'removed', unipile_deleted: true, account_queued: false }; }
  lifecycleDisable(ctx, s, null);
  ctx.ui.simulated();
  return { ok: true, state: 'disabled', unipile_deleted: false, account_queued: false };
}

// ---------------------------------------------------------------------------
// sender-lifecycle (sender-lifecycle-PRD.md): what the database functions of migration 096 do, on the local store
// ---------------------------------------------------------------------------
const LIVE_ENR = ['active', 'waiting_connection', 'waiting_delay', 'waiting_task', 'paused'];

function lifecyclePreview(ctx: Ctx, s: Row, action: string): Row {
  const st = ctx.store;
  const actions = st.t('outreach_actions').filter((a) => a.sender_id === s.id);
  const enr = st.t('outreach_enrollments').filter((e) => e.sender_id === s.id && LIVE_ENR.includes(e.status));
  const seqs = st.t('outreach_sequences').filter((q) => q.workspace_id === ctx.ws);
  const otherOk = (q: Row) => (q.sender_pool ?? []).filter((id: string) => id !== s.id && st.get('outreach_senders', id)?.status === 'ok' && !st.get('outreach_senders', id)?.deleted_at).length;
  const bySeq = new Map<string, number>();
  for (const e of enr) bySeq.set(e.sequence_id, (bySeq.get(e.sequence_id) ?? 0) + 1);
  const left = seqs.filter((q) => q.status === 'active' && (q.sender_pool ?? []).includes(s.id) && otherOk(q) === 0);
  const chats = st.t('outreach_chats').filter((c) => c.sender_id === s.id);
  const chatIds = new Set(chats.map((c) => c.id));
  return {
    sender: { id: s.id, name: s.display_name, provider: s.provider, status: s.status, status_reason: s.status_reason, unipile_linked: !!s.unipile_account_id, auto_remove_after_days: s.auto_remove_after_days ?? 30, auto_remove_at: s.auto_remove_at ?? null,
      erase_scheduled_at: s.erase_scheduled_at ?? null, pause_resume_at: s.pause_resume_at ?? null, removal_pending: false },
    action,
    queued_actions: actions.filter((a) => a.status === 'queued').length, in_flight_actions: actions.filter((a) => a.status === 'reserved').length, live_enrollments: enr.length,
    sequences: [...bySeq.entries()].map(([id, leads]) => { const q = st.get('outreach_sequences', id); return { sequence_id: id, name: q?.name ?? 'Sequence', status: q?.status ?? 'active', leads, other_active_senders: q ? otherOk(q) : 0 }; }).sort((a, b) => b.leads - a.leads),
    sequences_left_without_sender: left.length,
    rules_to_pause: st.t('outreach_auto_enroll_rules').filter((r) => r.active && left.some((q) => q.id === r.sequence_id)).length,
    imports_to_pause: st.t('outreach_import_jobs').filter((j) => j.sender_id === s.id && (j.status === 'queued' || j.status === 'running')).length,
    ai_runs_scheduled: st.t('outreach_ai_reply_runs').filter((r) => r.sender_id === s.id && r.status === 'scheduled').length,
    profile_changes_queued: st.t('outreach_profile_changes').filter((c) => c.sender_id === s.id && c.status === 'queued').length,
    open_tasks: st.t('outreach_tasks').filter((t) => t.sender_id === s.id && !t.completed_at).length,
    chats: chats.length, messages: st.t('outreach_messages').filter((m) => chatIds.has(m.chat_id)).length,
    leads_contacted: st.t('outreach_lead_sender_state').filter((x) => x.sender_id === s.id && (x.last_outbound_at || x.invite_sent_at)).length,
    ai_consents: 0, profile_authority: 0,
    slot_freed: (action === 'remove' || action === 'erase') && !!s.unipile_account_id && s.provider !== 'WEBCHAT',
  };
}

function lifecycleDisable(ctx: Ctx, s: Row, reason: string | null): Row {
  const st = ctx.store;
  const pv = lifecyclePreview(ctx, s, 'disable');
  const exited = pv.sequences.map((q: Row) => ({ sequence_id: q.sequence_id, name: q.name, lead_ids: st.t('outreach_enrollments').filter((e) => e.sender_id === s.id && e.sequence_id === q.sequence_id && LIVE_ENR.includes(e.status)).map((e) => e.lead_id) }));
  const left = new Set(st.t('outreach_sequences').filter((q) => q.status === 'active' && (q.sender_pool ?? []).includes(s.id) && !(q.sender_pool ?? []).some((id: string) => id !== s.id && st.get('outreach_senders', id)?.status === 'ok')).map((q) => q.id));
  const fresh = setStatus(st, s, 'disabled', reason ?? 'disabled_by_user', { disabled_at: ctx.now(), disabled_by: ctx.userId, disable_reason: reason, auto_remove_at: iso(Date.now() + (s.auto_remove_after_days ?? 30) * D), paused_at: null, pause_resume_at: null });
  st.update('outreach_auto_enroll_rules', (r) => r.active && left.has(r.sequence_id), { active: false, paused_reason: 'sender_disabled', paused_at: ctx.now() });
  st.update('outreach_import_jobs', (j) => j.sender_id === s.id && (j.status === 'queued' || j.status === 'running'), { status: 'paused', paused_reason: 'sender_disabled' });
  st.update('outreach_ai_reply_runs', (r) => r.sender_id === s.id && r.status === 'scheduled', { status: 'cancelled' });
  addEvent(st, s.id, 'lifecycle', { action: 'disable', by: ctx.userId, reason, counts: { queued_actions: pv.queued_actions, live_enrollments: pv.live_enrollments } });
  return { ...fresh, exited, counts: pv };
}

function lifecycleEnable(ctx: Ctx, s: Row): Row {
  const st = ctx.store;
  if (!s.unipile_account_id) {
    const fresh = setStatus(st, s, 'removed', s.status_reason ?? 'disabled_by_user', { removed_at: s.disabled_at ?? ctx.now(), removed_via: 'app', auto_remove_at: null });
    addEvent(st, s.id, 'lifecycle', { action: 'enable', by: ctx.userId, result: 'removed' });
    return fresh;
  }
  const fresh = setStatus(st, s, 'ok', null, { disabled_at: null, disabled_by: null, disable_reason: null, auto_remove_at: null, auto_remove_notice_at: null });
  addEvent(st, s.id, 'lifecycle', { action: 'enable', by: ctx.userId, result: 'ok' });
  return fresh;
}

function lifecycleRemove(ctx: Ctx, s: Row, via: string): Row {
  const st = ctx.store;
  let cur = s;
  if (cur.status !== 'disabled') cur = lifecycleDisable(ctx, cur, `remove:${via}`);
  const account = cur.unipile_account_id ?? null;
  const fresh = setStatus(st, cur, 'removed', cur.status_reason ?? null, { removed_at: ctx.now(), removed_via: via, removed_by: ctx.userId, previous_unipile_account_id: account ?? cur.previous_unipile_account_id ?? null,
    unipile_account_id_history: [...(cur.unipile_account_id_history ?? []), ...(account ? [account] : [])], auto_remove_at: null, auto_remove_notice_at: null, extension_token_issued_at: null });
  st.update('outreach_import_jobs', (j) => j.sender_id === s.id && ['queued', 'running', 'paused'].includes(j.status), { status: 'cancelled', error: 'sender_removed' });
  st.update('outreach_tasks', (t) => t.sender_id === s.id && t.kind === 'reconnect' && !t.completed_at, { completed_at: ctx.now() });
  addEvent(st, s.id, 'lifecycle', { action: 'remove', via, by: ctx.userId, account_id: account });
  return fresh;
}

function senderLifecycle(req: FnRequest, ctx: Ctx) {
  const st = ctx.store;
  const b = req.body;
  const s = senderOr404(ctx, b.sender_id);
  const action = String(b.action ?? '');
  if (s.provider === 'WEBCHAT' && action !== 'preview') demoError('E_PAYLOAD_INVALID', 'A website inbox is managed from its Website agents page.');
  switch (action) {
    case 'preview': return lifecyclePreview(ctx, s, String(b.preview_action ?? 'disable'));
    case 'pause': {
      if (s.status !== 'ok') demoError('E_SENDER_NOT_OK', `only a connected sender can be paused (it is ${s.status})`);
      const at = b.resume_at ? String(b.resume_at) : null;
      const fresh = setStatus(st, s, 'paused', 'user_paused', { paused_at: ctx.now(), paused_by: ctx.userId, pause_resume_at: at });
      st.update('outreach_ai_reply_runs', (r) => r.sender_id === s.id && r.status === 'scheduled', { status: 'draft_ready' });
      addEvent(st, s.id, 'lifecycle', { action: 'pause', by: ctx.userId, resume_at: at });
      return { ok: true, pause_resume_at: at, sender: fresh };
    }
    case 'resume': {
      if (s.status !== 'paused') demoError('E_SENDER_NOT_OK', 'the sender is not paused');
      if (s.status_reason === 'over_plan_limit') demoError('E_ACCOUNT_LIMIT', 'This account is paused because the plan has fewer accounts than are connected.');
      const overdue = st.t('outreach_actions').filter((a) => a.sender_id === s.id && a.status === 'queued' && new Date(a.scheduled_for).getTime() < Date.now());
      overdue.forEach((a, i) => st.update('outreach_actions', a.id, { scheduled_for: iso(Date.now() + Math.floor(i / 5) * D + (5 + (i % 5) * 90) * MIN) }));
      const fresh = setStatus(st, s, 'ok', null, { paused_at: null, paused_by: null, pause_resume_at: null });
      addEvent(st, s.id, 'lifecycle', { action: 'resume', by: ctx.userId, backlog_spread: overdue.length });
      return { ok: true, backlog_spread: overdue.length, sender: fresh };
    }
    case 'disable': {
      if (s.status === 'removed' || s.status === 'erased') demoError('E_SENDER_NOT_OK', `this sender is ${s.status}`);
      if (s.status === 'disabled') return { ok: true, already: true, sender: s };
      const r = lifecycleDisable(ctx, s, b.reason ? String(b.reason) : null);
      ctx.ui.simulated();
      const { exited, counts, ...sender } = r;
      return { ok: true, exited, counts, sender };
    }
    case 'enable': {
      if (s.status !== 'disabled') demoError('E_SENDER_NOT_OK', `only a disabled sender can be enabled (it is ${s.status})`);
      const fresh = lifecycleEnable(ctx, s);
      return { ok: true, state: fresh.status === 'removed' ? 'removed' : 'ok', sender: fresh };
    }
    case 'remove': {
      if (s.status === 'removed' || s.status === 'erased') return { ok: true, state: 'already', sender: s };
      const fresh = lifecycleRemove(ctx, s, 'app');
      ctx.ui.simulated();
      return { ok: true, state: 'removed', account_deleted: true, sender: fresh };
    }
    case 'erase_schedule': {
      let cur = s;
      if (cur.status !== 'removed' && cur.status !== 'erased') cur = lifecycleRemove(ctx, cur, 'app');
      const at = iso(Date.now() + 24 * 60 * MIN);
      const fresh = st.update('outreach_senders', cur.id, { erase_scheduled_at: at, erase_requested_by: ctx.userId })[0] ?? cur;
      addEvent(st, s.id, 'lifecycle', { action: 'erase_scheduled', by: ctx.userId, at });
      ctx.ui.simulated('Demo: the erase is scheduled; nothing is deleted in the tour.');
      return { ok: true, erase_scheduled_at: at, sender: fresh };
    }
    case 'erase_cancel': {
      const fresh = st.update('outreach_senders', s.id, { erase_scheduled_at: null, erase_requested_by: null })[0] ?? s;
      addEvent(st, s.id, 'lifecycle', { action: 'erase_cancelled', by: ctx.userId });
      return { ok: true, sender: fresh };
    }
    // ---------------------------------------------------------------- whose account (sender-lifecycle v1.2 §5.8.1)
    case 'holder': return holderView(ctx, s);
    case 'set_holder': {
      const h = b.holder && typeof b.holder === 'object' ? (b.holder as Row) : null;
      if (!h || (!h.mine && !h.user_id && !h.email)) demoError('E_PAYLOAD_INVALID', 'holder must be {mine: true}, {user_id} or {email}');
      if (s.status === 'erased') demoError('E_CONFLICT', 'an erased sender has no holder');
      const old = { user_id: s.owner_user_id ?? null, email: s.owner_email ?? null };
      let user_id: string | null = ctx.userId; const email: string | null = null; let notify_member: string | null = null;
      if (!h.mine && h.user_id) {
        const m = st.t('outreach_members').find((x) => x.workspace_id === ctx.ws && x.user_id === String(h.user_id));
        if (!m) demoError('E_PAYLOAD_INVALID', 'that person is not a member of this workspace');
        user_id = m.user_id; if (m.user_id !== ctx.userId) notify_member = m.user_id;
      } else if (!h.mine) {
        const em = String(h.email ?? '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) demoError('E_PAYLOAD_INVALID', 'enter the email of the person who signs in to this account');
        if (em !== DEMO_USER_EMAIL.toLowerCase()) {
          const m = st.t('outreach_members').find((x) => x.workspace_id === ctx.ws && String(x.email ?? '').toLowerCase() === em);
          if (!m) demoError('E_HOLDER_OUTSIDE', `Emails about an account only go to a teammate's sign-in email. Invite ${em} to the workspace first.`);
          user_id = m.user_id; notify_member = m.user_id;
        }
      }
      const changed = user_id !== old.user_id || email !== old.email;
      if (!changed) return { ok: true, changed: false, holder: holderView(ctx, s), view: holderView(ctx, s) };
      const fresh = st.update('outreach_senders', s.id, { owner_user_id: user_id, owner_email: email, connected_by: s.connected_by ?? ctx.userId })[0] ?? s;
      const links = st.update(T.links, (l) => l.sender_id === s.id && !l.accepted_at && !l.declined_at && new Date(l.expires_at).getTime() > Date.now(), { expires_at: ctx.now() }).length;
      const grants = st.update('outreach_profile_authority', (g) => g.sender_id === s.id && !g.revoked_at, { revoked_at: ctx.now(), revoked_reason: 'holder_changed' }).length
        + st.update('outreach_ai_reply_consent', (g) => g.sender_id === s.id && !g.revoked_at, { revoked_at: ctx.now(), revoked_reason: 'holder_changed' }).length;
      addEvent(st, s.id, 'lifecycle', { action: 'holder_changed', by: ctx.userId, from: old, to: { user_id, email }, links_cancelled: links, grants_revoked: grants });
      ctx.ui.simulated(old.email && !user_id ? undefined : old.email ? `Demo: ${old.email} would be told they are no longer the contact.` : undefined);
      return { ok: true, changed: true, old, new: { user_id, email }, notify_member, old_outside_email: old.user_id ? null : old.email, links_cancelled: links, grants_revoked: grants, holder: holderView(ctx, fresh), view: holderView(ctx, fresh) };
    }
    case 'send_signin_link': {
      if (!['credentials', 'error'].includes(String(s.status))) demoError('E_SENDER_NOT_OK', 'This sender is not signed out');
      const fresh = st.update('outreach_senders', s.id, { holder_notified_at: ctx.now(), holder_reminders_sent: 0, holder_email_held_until: null, reconnect_notified_at: ctx.now(), reconnect_reminders: 0 })[0] ?? s;
      const h = holderView(ctx, fresh);
      ctx.ui.simulated('Demo: the sign-in email is not sent in the tour.');
      return { ok: true, sent: true, to: h.email ?? DEMO_USER_EMAIL, sender: fresh };
    }
    default: demoError('E_PAYLOAD_INVALID', `unknown action ${action}`);
  }
}

function senderUpdateProxy(req: FnRequest, ctx: Ctx) {
  const st = ctx.store;
  const s = senderOr404(ctx, req.body.sender_id);
  if (!s.unipile_account_id) demoError('E_SENDER_NOT_OK', 'sender not connected yet');
  const country = req.body.country ? String(req.body.country).toUpperCase().slice(0, 2) : undefined;
  if (!country && !req.body.proxy) demoError('E_PAYLOAD_INVALID', 'country or proxy required');
  if (country && country !== s.proxy_country) {
    st.update('outreach_senders', s.id, { proxy_country: country });
    addEvent(st, s.id, 'proxy', { from: s.proxy_country, to: country, by: ctx.userId, custom_proxy: !!req.body.proxy });
  }
  ctx.ui.simulated();
  return { ok: true, proxy_country: country ?? s.proxy_country };
}

// ---------------------------------------------------------------------------
// Profile Studio actions
// ---------------------------------------------------------------------------
const PUBLIC = new Set(['authority_preview', 'authority_accept', 'approval_preview', 'approval_decide', 'revert_preview', 'revert_apply']);
const GROUPS = ['headline', 'about', 'photo', 'cover', 'location', 'experience', 'education', 'skills', 'custom_link'];

/** A proposal waits for the owner. In the demo the visitor plays the owner on a fake approval screen. */
async function askOwner(ctx: Ctx, r: Row): Promise<Row> {
  const ch = ctx.store.get(T.changes, r.id);
  const s = ch ? ctx.store.get('outreach_senders', ch.sender_id) : undefined;
  if (!ch || !s) return r;
  const owner = s.owner_email ?? 'the account owner';
  ctx.ui.simulated(`Simulated. No email was sent to ${owner}.`);
  const ok = await ctx.ui.dialog({ kind: 'consent', app: `${s.display_name ?? 'Sender'}: owner approval`, scopes: (ch.field_groups ?? []).map((g: string) => `Change ${g.replace(/_/g, ' ')}`) });
  if (!ok) return { ...r, approval: { status: 'awaiting_owner', email_sent: true, recipients: [owner], email_configured: true } };
  const at = ownerApprove(ctx.store, ch.id, owner);
  return { id: ch.id, status: 'queued', mode: 'propose_only', scheduled_for: at, approval: { status: 'approved', email_sent: true, recipients: [owner], email_configured: true } };
}

function draftAi(ctx: Ctx, s: Row, group: string, brief: string): string {
  const st = ctx.store;
  const d: Row = latestSnapshot(st, s.id)?.data ?? baselineDoc(st, s);
  const exp: Row[] = Array.isArray(d.experience) ? d.experience : [];
  const cur = exp.find((e) => e.current) ?? exp[0] ?? {};
  const company = cur.company ?? st.get('outreach_workspaces', s.workspace_id)?.name ?? 'Northwind Growth';
  const title = cur.title ?? 'Growth';
  const skills = (Array.isArray(d.skills) ? d.skills : []).slice(0, 3).map((x: Row) => x.name).filter(Boolean);
  const focus = brief.trim() ? brief.trim().replace(/\s+/g, ' ').slice(0, 60).replace(/[.!?]+$/, '') : 'B2B teams book more first meetings';
  if (group === 'headline') {
    const options = [
      `${title} at ${company} | Helping ${focus.toLowerCase().startsWith('help') ? focus.slice(4).trim() : focus}`,
      `I help ${focus.toLowerCase().startsWith('help') ? focus.slice(4).trim() : focus} | ${title}, ${company}`,
    ];
    return st.pick(options).replace(/\s+/g, ' ').slice(0, 220);
  }
  return [
    `I am the ${title} at ${company}. My work is simple to describe: ${focus.charAt(0).toLowerCase() + focus.slice(1)}, without adding headcount.`,
    `Most of my week goes into ${skills.length ? skills.join(', ').toLowerCase() : 'outbound programmes, partner campaigns and pipeline reviews'}. I keep the process light so a small team can run it every week.`,
    'If that sounds like something your team is working on, send me a message. I am happy to share what has worked for teams like yours.',
  ].join('\n\n');
}

async function profileFn(req: FnRequest, ctx: Ctx) {
  const st = ctx.store;
  const b = req.body;
  const action = String(b.action ?? '');
  if (PUBLIC.has(action)) throw new OutreachError('This link is not valid.', 'E_INVALID_LINK');
  settleProfiles(st, assetUrl);
  switch (action) {
    case 'snapshot': {
      const s = senderOr404(ctx, b.sender_id);
      if (s.provider !== 'LINKEDIN') demoError('E_PROFILE_PROVIDER', 'Profile snapshots are for LinkedIn accounts');
      if (s.status !== 'ok') demoError('E_PROFILE_SENDER_NOT_OK', 'The account must be connected');
      const prev = latestSnapshot(st, s.id);
      const data = prev ? { ...prev.data, connections_count: s.connections_count ?? prev.data?.connections_count ?? null } : baselineDoc(st, s);
      const snap = recordSnapshot(st, s, prev ? 'drift_check' : 'baseline', data);
      st.insert('outreach_actions', { workspace_id: s.workspace_id, sender_id: s.id, action_type: 'profile_view', status: 'sent', scheduled_for: ctx.now(), executed_at: ctx.now(), reserved_at: ctx.now(), enrollment_id: null, lead_id: null, node_id: null, variant_id: null, attempt: 1, decision: null, payload: { own_profile: true }, response: { ok: true, demo: true }, error_code: null });
      computeQa(st, st.get('outreach_senders', s.id)!);
      ctx.ui.simulated('Simulated. The profile was read from the demo data.');
      return { ok: true, snapshot_id: snap.id, data: snap.data, overview: profileOverview(ctx, s.id) };
    }
    case 'submit': {
      const r = submitChange(ctx, String(b.change_id ?? ''));
      if (r.status === 'awaiting_owner') return { ok: true, ...(await askOwner(ctx, r)) };
      ctx.ui.simulated('Scheduled in the demo. It is applied locally once the demo clock reaches that time.');
      return { ok: true, ...r };
    }
    case 'revert': {
      const ch = st.get(T.changes, String(b.change_id ?? ''));
      if (!ch || ch.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Change not found');
      const build = revertBuild(st, ch);
      if (!build.possible) demoError('E_PROFILE_UNRECOVERABLE', 'nothing in this change can be restored automatically');
      const s = st.get('outreach_senders', ch.sender_id)!;
      const n = newChange(st, s, { payload: build.payload, assets: build.assets, source: 'rollback', reverts_change_id: ch.id, note: `Rollback of the change applied ${String(ch.applied_at ?? '').slice(0, 16).replace('T', ' ')}` });
      let r: Row;
      try { r = submitChange(ctx, n.id); } catch (e) { st.update(T.changes, n.id, { status: 'cancelled', cancelled_reason: (e as { code?: string }).code ?? 'failed' }); throw e; }
      st.update(T.changes, ch.id, { status: 'reverted', reverted_at: ctx.now() });
      const out: Row = { ...r, fields: build.fields, unrecoverable: build.unrecoverable };
      if (r.status === 'awaiting_owner') return { ok: true, ...(await askOwner(ctx, out)), fields: build.fields, unrecoverable: build.unrecoverable };
      return { ok: true, ...out };
    }
    case 'authority_link': {
      const s = senderOr404(ctx, b.sender_id);
      const groups = (Array.isArray(b.field_groups) ? b.field_groups : []).filter((g: unknown) => GROUPS.includes(String(g)));
      if (!groups.length) demoError('E_PAYLOAD_INVALID', 'pick at least one field group');
      const mode = b.mode === 'direct' ? 'direct' : 'propose_only';
      const owner = String(b.owner_email ?? s.owner_email ?? '').trim().toLowerCase();
      if (!owner) demoError('E_PAYLOAD_INVALID', 'The sender has no owner email. Add one first.');
      const link = st.insert(T.links, { workspace_id: s.workspace_id, sender_id: s.id, token_hash: tokenHex(st), field_groups: groups, mode, owner_email: owner, expires_at: iso(Date.now() + 7 * D), grant_days: b.grant_days ?? null, accepted_at: null, declined_at: null, evidence: null, created_by: ctx.userId })[0];
      ctx.ui.simulated(`Simulated. No email was sent to ${owner}.`);
      // the visitor plays the owner on a fake permission screen
      const ok = await ctx.ui.dialog({ kind: 'consent', app: `${s.display_name ?? 'Sender'}: profile permission`, scopes: groups.map((g: string) => `${mode === 'direct' ? 'Edit' : 'Propose changes to'} ${g.replace(/_/g, ' ')}`) });
      if (ok) {
        const now = ctx.now();
        for (const g of groups) {
          st.update(T.authority, (x) => x.sender_id === s.id && x.field_group === g && !x.revoked_at, { revoked_at: now, revoked_reason: 'replaced' });
          st.insert(T.authority, { workspace_id: s.workspace_id, sender_id: s.id, field_group: g, mode, granted_by_email: owner, granted_via: 'signed_link', evidence: { link_id: link.id, signed_at: now, demo: true }, granted_at: now, expires_at: b.grant_days ? iso(Date.now() + Number(b.grant_days) * D) : null, revoked_at: null, revoked_reason: null, revoked_by: null });
        }
        st.update(T.links, link.id, { accepted_at: now, evidence: { demo: true } });
      }
      return { ok: true, link_id: link.id, owner_email: owner, expires_at: link.expires_at, email_sent: true, email_configured: true };
    }
    case 'ai_draft': {
      const s = senderOr404(ctx, b.sender_id);
      const group = String(b.field_group ?? '');
      if (group !== 'headline' && group !== 'about') demoError('E_PAYLOAD_INVALID', 'AI drafting covers the headline and the About section');
      const brief = String(b.brief ?? '').slice(0, 2000);
      const text = draftAi(ctx, s, group, brief);
      const payload = group === 'headline' ? { headline: text } : { summary: text };
      const ch = newChange(st, s, { payload, source: 'ai_draft', note: `AI draft. ${brief ? `Brief: ${brief.slice(0, 200)}` : ''}`.trim() });
      return { ok: true, change_id: ch.id, text, facts_used: ['current position', 'skills'], validation: validate(st, s, payload, {}, { change: ch.id }), note: 'This is a draft for a human to edit. It is never applied on its own.' };
    }
    case 'bulk_commit': {
      const run = st.get(T.runs, String(b.run_id ?? ''));
      if (!run || run.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Preview not found');
      if (run.status !== 'preview') demoError('E_PREVIEW_EXPIRED', 'this preview was already committed or expired');
      if (Date.parse(run.expires_at) < Date.now()) { st.update(T.runs, run.id, { status: 'expired' }); demoError('E_PREVIEW_EXPIRED', 'run the preview again'); }
      let queued = 0, waiting = 0, failed = 0;
      const details: Row[] = []; const approvals: Row[] = [];
      for (const row of (run.rows as Row[]).filter((x) => x.ok)) {
        const s = st.get('outreach_senders', row.sender_id);
        if (!s) continue;
        const ch = newChange(st, s, { payload: row.payload, source: 'template', template_id: run.template_id, bulk_run_id: run.id });
        try {
          const r = submitChange(ctx, ch.id);
          if (r.status === 'queued') queued++; else { waiting++; approvals.push({ change_id: ch.id, sender_id: s.id, status: 'awaiting_owner', email_sent: true, recipients: [s.owner_email ?? ''], email_configured: true }); }
          details.push({ sender_id: s.id, change_id: ch.id, status: r.status, scheduled_for: r.scheduled_for ?? null });
        } catch (e) {
          failed++; st.update(T.changes, ch.id, { status: 'failed', error_code: (e as { code?: string }).code ?? 'E_FAILED' });
          details.push({ sender_id: s.id, status: 'failed', error: (e as Error).message });
        }
      }
      st.update(T.runs, run.id, { status: 'committed', committed_at: ctx.now(), result: { queued, awaiting_owner: waiting, failed, details } });
      if (waiting) ctx.ui.simulated('Simulated. No approval emails were sent.');
      return { ok: true, run_id: run.id, queued, awaiting_owner: waiting, failed, details, approvals };
    }
    case 'experiment_start': {
      const e = st.get(T.experiments, String(b.experiment_id ?? ''));
      if (!e || e.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Experiment not found');
      if (e.status !== 'draft') demoError('E_PROFILE_STATE', `experiment is ${e.status}`);
      const ids = [...(e.sender_ids as string[])];
      for (let i = ids.length - 1; i > 0; i--) { const j = st.int(0, i); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      const variants = e.variants as Row[];
      const assignment: Row = {};
      ids.forEach((sid, i) => { assignment[sid] = variants[i % variants.length].key; });
      for (const [i, sid] of ids.entries()) {
        const { payload, assets } = experimentPayload(e, variants[i % variants.length].value);
        const s = st.get('outreach_senders', sid);
        const v = validate(st, s, payload, assets, { experiment: e.id });
        if (!v.ok) demoError('E_EXPERIMENT_NOT_READY', `${s?.display_name ?? 'A sender'} — ${v.causes.find((c: Row) => c.blocking)?.detail ?? 'cannot take the change'}`);
      }
      st.update(T.experiments, e.id, { status: 'washout', assignment, started_at: ctx.now() });
      let queued = 0, waiting = 0, failed = 0;
      const details: Row[] = [];
      for (const [i, sid] of ids.entries()) {
        const s = st.get('outreach_senders', sid)!;
        const { payload, assets } = experimentPayload(e, variants[i % variants.length].value);
        const ch = newChange(st, s, { payload, assets, source: 'experiment', experiment_id: e.id, note: `Experiment "${e.name}", variant ${assignment[sid]}` });
        try { const r = submitChange(ctx, ch.id); if (r.status === 'queued') queued++; else waiting++; details.push({ sender_id: sid, variant: assignment[sid], change_id: ch.id, status: r.status }); }
        catch (err) { failed++; st.update(T.changes, ch.id, { status: 'failed' }); details.push({ sender_id: sid, variant: assignment[sid], status: 'failed', error: (err as Error).message }); }
      }
      ctx.ui.simulated('Scheduled in the demo. The changes are applied locally as the demo clock moves.');
      return { ok: true, id: e.id, status: 'washout', assignment, queued, awaiting_owner: waiting, failed, details, approvals: [],
        note: e.field_group === 'photo' ? 'Photo experiments need at least 21 days: the photo ceiling is one change per 30 days, so the losing arm can only be switched after that.' : null };
    }
    case 'experiment_conclude': {
      const e = st.get(T.experiments, String(b.experiment_id ?? ''));
      if (!e || e.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Experiment not found');
      if (!['running', 'ready', 'washout'].includes(e.status)) demoError('E_PROFILE_STATE', `experiment is ${e.status}`);
      const r = experimentResult(st, e);
      st.update(T.experiments, e.id, { status: 'concluded', concluded_at: ctx.now(), result: r });
      const win = r.verdict === 'b_better' ? r.comparison?.b : r.verdict === 'a_better' ? r.comparison?.a : null;
      let queued = 0, waiting = 0, failed = 0;
      const details: Row[] = [];
      if (b.apply_winner) {
        if (!win) demoError('E_EXPERIMENT_NO_WINNER', 'the readout did not declare a winner, so nothing is applied');
        const wv = (e.variants as Row[]).find((v) => v.key === win)?.value;
        const { payload, assets } = experimentPayload(e, wv);
        for (const [sid, key] of Object.entries(e.assignment ?? {})) {
          if (key === win) continue;
          const s = st.get('outreach_senders', sid);
          if (!s) continue;
          const ch = newChange(st, s, { payload, assets, source: 'experiment', experiment_id: e.id, note: `Winner of experiment "${e.name}" (${win})` });
          try { const x = submitChange(ctx, ch.id); if (x.status === 'queued') queued++; else waiting++; details.push({ sender_id: sid, change_id: ch.id, status: x.status }); }
          catch (err) { failed++; st.update(T.changes, ch.id, { status: 'failed' }); details.push({ sender_id: sid, status: 'failed', error: (err as Error).message }); }
        }
      }
      return { ok: true, id: e.id, status: 'concluded', result: r, winner: win, applied: { queued, awaiting_owner: waiting, failed, details }, approvals: [] };
    }
    default: demoError('E_PAYLOAD_INVALID', `unknown action ${action}`);
  }
}

export const sendersFn = {
  'sender-connect': senderConnect,
  'sender-disable': senderDisable,
  'sender-lifecycle': senderLifecycle,
  'sender-manage': senderManage,
  'sender-update-proxy': senderUpdateProxy,
  profile: profileFn,
} satisfies FnArea;

