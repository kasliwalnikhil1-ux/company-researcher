/**
 * Demo edge functions: billing, invite-member, crm-oauth, workspace-secrets, unipile-setup.
 * Payments, CRM sign-ins and invitation emails are stand-ins (PRD §3.4): a fake checkout or consent step, then the
 * change lands in the local tables. Return URLs stay inside /product-tour.
 */
import { faceFor } from '../seed/faces';
import { FIRST_NAMES, LAST_NAMES, COMPANIES, TITLES, LOCATIONS, slug } from '../seed/names';
import { DAY, demoError, type Ctx, type FnArea, type FnRequest } from '../ctx';
import type { Row } from '../store';
import { applyChange, billingState, buildQuote, checkout, downloadInvoice, parseTarget, recordChange } from '../settings/billing';
import { audit, EMAIL_RE, hex, lowerTrim, origin, requireWs, tourPath, workspaceRow } from '../settings/common';
import { syncLog } from '../settings/hooks';

const CRM: Record<string, { label: string; segments: Array<{ id: string; name: string; kind: string; count: number }> }> = {
  hubspot: { label: 'HubSpot', segments: [{ id: 'hs-list-118', name: 'Webinar attendees (Q3)', kind: 'list', count: 8 }, { id: 'hs-list-204', name: 'Open deals: SaaS', kind: 'list', count: 6 }, { id: 'hs-list-311', name: 'Churned customers', kind: 'list', count: 5 }] },
  pipedrive: { label: 'Pipedrive', segments: [{ id: 'pd-filter-7', name: 'Warm leads this month', kind: 'filter', count: 7 }, { id: 'pd-filter-12', name: 'Agency prospects', kind: 'filter', count: 6 }] },
  salesforce: { label: 'Salesforce', segments: [{ id: 'sf-view-a01', name: 'Event leads', kind: 'list view', count: 8 }, { id: 'sf-view-a02', name: 'Partner referrals', kind: 'list view', count: 5 }] },
};

const SCOPES: Record<string, string[]> = {
  hubspot: ['Read and write contacts and companies', 'Create notes and deals', 'Read lists'],
  pipedrive: ['Read and write people and organisations', 'Create notes and deals', 'Read filters'],
  salesforce: ['Read and write leads, contacts and accounts', 'Create tasks and opportunities', 'Read list views'],
};

function ownerOnly(ctx: Ctx, ws: unknown) {
  const id = String(ws ?? '');
  if (!id) demoError('E_PAYLOAD_INVALID', 'workspace_id required');
  const m = ctx.store.t('outreach_members').find((x) => x.workspace_id === id && x.user_id === ctx.userId);
  if (!m) demoError('E_FORBIDDEN', 'not a member of this workspace');
  if (m.role !== 'owner') demoError('E_FORBIDDEN', 'Only the workspace owner can manage billing.');
  return workspaceRow(ctx.store, id);
}

// ---------------------------------------------------------------------------
async function billing(req: FnRequest, ctx: Ctx): Promise<unknown> {
  const b = req.body;
  const w = ownerOnly(ctx, b.workspace_id);
  const state = () => billingState(ctx.store, w.id, ctx.userId);
  switch (String(b.action ?? '')) {
    case 'quote': return buildQuote(ctx, w, parseTarget(b), b.keep_sender_ids);
    case 'change': { const r = await applyChange(ctx, w, b.quote_id, b.keep_sender_ids); return { ...r, state: state() }; }
    case 'checkout': {
      await checkout(ctx, w, b.quote_id);
      // Stripe Checkout returns to the billing page; in the tour that page is local
      return { url: tourPath('/outreach/billing?checkout=success') };
    }
    case 'cancel_scheduled_change': {
      if (w.scheduled_change) {
        const sc = w.scheduled_change as Row;
        recordChange(ctx, w, 'cancel_scheduled', { scheduled: { plan: sc.plan, accounts: sc.accounts_billed, period: sc.billing_period } });
        ctx.store.update('outreach_billing_changes', (c) => c.workspace_id === w.id && c.status === 'scheduled', { status: 'cancelled' });
        ctx.store.update('outreach_workspaces', w.id, { scheduled_change: null });
        audit(ctx.store, w.id, ctx.userId, 'billing.scheduled_cancelled', 'workspace', w.id);
      }
      return { ok: true, state: state() };
    }
    case 'cancel': {
      const reason = String(b.reason ?? '');
      if (!['too_expensive', 'missing_feature', 'switched_tool', 'not_using', 'technical_issues', 'temporary', 'other'].includes(reason)) demoError('E_PAYLOAD_INVALID', 'choose a reason');
      if (!w.stripe_subscription_id) demoError('E_PAYLOAD_INVALID', 'There is no subscription to cancel.');
      ctx.store.update('outreach_billing_changes', (c) => c.workspace_id === w.id && c.status === 'scheduled', { status: 'cancelled' });
      ctx.store.update('outreach_workspaces', w.id, { cancel_at_period_end: true, cancelled_at: ctx.now(), scheduled_change: null });
      recordChange(ctx, w, 'cancel');
      audit(ctx.store, w.id, ctx.userId, 'billing.cancel_requested', 'workspace', w.id, { reason, comment: String(b.comment ?? '').slice(0, 2000) || null });
      ctx.ui.simulated('Simulated. Nothing was changed at a payment provider.');
      return { ok: true, access_until: w.current_period_end ?? null, state: state() };
    }
    case 'resume': {
      if (w.cancel_at_period_end) {
        ctx.store.update('outreach_workspaces', w.id, { cancel_at_period_end: false, cancelled_at: null });
        recordChange(ctx, w, 'resume');
        audit(ctx.store, w.id, ctx.userId, 'billing.resumed', 'workspace', w.id);
      }
      return { ok: true, state: state() };
    }
    case 'portal': {
      // the payment provider's portal: in the tour, the newest invoice is saved as a sample file instead
      const inv = downloadInvoice(ctx.store, w);
      ctx.ui.toast(inv ? `Sample invoice ${inv.number} downloaded. In the product this opens the billing portal (card, invoices, tax details).` : 'No invoices yet.');
      return { url: '#invoices' };
    }
    case 'pay_now': return { url: null, amount_due_cents: null };
    case 'abandon_payment': {
      if (w.pending_payment) ctx.store.update('outreach_workspaces', w.id, { pending_payment: null });
      ctx.store.update('outreach_billing_changes', (c) => c.workspace_id === w.id && c.status === 'pending_payment', { status: 'cancelled' });
      return { ok: true, state: state() };
    }
    case 'sync': return { ok: true, state: state() };
    default:
      return demoError('E_PAYLOAD_INVALID', `unknown action ${b.action || '(none)'}. One of: quote, change, checkout, cancel_scheduled_change, cancel, resume, portal, pay_now, abandon_payment, sync.`);
  }
}

// ---------------------------------------------------------------------------
function inviteMember(req: FnRequest, ctx: Ctx): unknown {
  const b = req.body;
  const { ws } = requireWs(ctx, b.workspace_id, 'owner');
  let inv: Row | undefined;
  if (b.resend_id) {
    inv = ctx.store.t('outreach_invitations').find((i) => i.id === b.resend_id && i.workspace_id === ws);
    if (!inv) demoError('E_NOT_FOUND');
    ctx.store.update('outreach_invitations', inv.id, { expires_at: new Date(Date.now() + 7 * DAY).toISOString() });
  } else {
    const email = lowerTrim(b.email);
    if (!EMAIL_RE.test(email)) demoError('E_PAYLOAD_INVALID', 'valid email required');
    const role = String(b.role ?? '');
    if (!['owner', 'manager', 'member', 'client_viewer'].includes(role)) demoError('E_PAYLOAD_INVALID', 'bad role');
    const clients = Array.isArray(b.client_ids) ? (b.client_ids as unknown[]).map(String).filter((id) => ctx.store.t('outreach_clients').some((c) => c.id === id && c.workspace_id === ws)) : [];
    inv = ctx.store.insert('outreach_invitations', {
      workspace_id: ws, email, role, client_ids: clients, token: hex(ctx.store, 48), expires_at: new Date(Date.now() + 7 * DAY).toISOString(), accepted_at: null, created_by: ctx.userId,
    })[0];
  }
  audit(ctx.store, ws, ctx.userId, 'member.invited', 'invitation', inv.id, { email: inv.email, role: inv.role, emailed: false });
  ctx.ui.simulated('Simulated. No invitation email was sent.');
  return { ok: true, invitation: inv, link: `${origin()}${tourPath(`/outreach/invite/${inv.token}`)}`, emailed: true };
}

// ---------------------------------------------------------------------------
function importLeads(ctx: Ctx, integ: Row, seg: { id: string; name: string; count: number }, listId: string | null, clientId: string | null): Row {
  const s = ctx.store;
  const tpl = s.t('outreach_leads')[0] ?? {};
  const known = new Set(s.t('outreach_leads').map((l) => l.public_identifier));
  let created = 0, updated = 0;
  const base = s.int(0, 997);
  for (let k = 0; k < seg.count; k++) {
    const n = base + k * 13 + seg.id.length;
    const first = FIRST_NAMES[n % FIRST_NAMES.length], last = LAST_NAMES[(n * 7 + 3) % LAST_NAMES.length];
    const ident = `demo-crm-${slug(`${first} ${last}`)}-${(n % 97).toString(36)}`;
    if (known.has(ident)) {
      s.update('outreach_leads', (l) => l.public_identifier === ident && l.workspace_id === integ.workspace_id, listId ? { list_id: listId } : {});
      updated++;
      continue;
    }
    known.add(ident);
    const company = COMPANIES[(n * 3 + 1) % COMPANIES.length], title = TITLES[(n * 5 + 2) % TITLES.length];
    const row: Row = Object.fromEntries(Object.keys(tpl).filter((key) => key !== 'id' && key !== 'created_at' && key !== 'updated_at').map((key) => [key, null]));
    Object.assign(row, {
      workspace_id: integ.workspace_id, client_id: clientId, public_identifier: ident, provider_id: null, profile_url: null, first_name: first, last_name: last, full_name: `${first} ${last}`, picture_url: faceFor(first, ident),
      headline: `${title} at ${company}`, company, title, location: LOCATIONS[n % LOCATIONS.length], email_work: `${slug(first)}.${slug(last)}.crm@example.com`.replace(/-/g, ''),
      custom: { crm_source: CRM[integ.provider]?.label ?? integ.provider, crm_segment: seg.name }, list_id: listId, stage_id: s.t('outreach_stages').find((x) => x.workspace_id === integ.workspace_id && x.kind === 'new')?.id ?? null,
      do_not_contact: false, unsubscribed: false, source: 'crm', import_job_id: null, enrich_status: 'none', email_status: 'unverified', is_open_profile: false,
    });
    s.insert('outreach_leads', row);
    created++;
  }
  const imported = created + updated;
  syncLog(s, integ, { lead_id: null, direction: 'pull', op: 'list.import', status: 'ok', detail: `Imported ${seg.name}: ${imported} leads (${created} new, ${updated} already known), 0 without an email or LinkedIn URL.` });
  return { imported, created, updated, skipped_no_identity: 0, failed: 0, next_cursor: null, done: true, capped: false };
}

async function crmOauth(req: FnRequest, ctx: Ctx): Promise<unknown> {
  const b = req.body;
  const action = String(b.action ?? '');
  const s = ctx.store;
  if (action === 'start') {
    const provider = String(b.provider ?? '');
    if (!b.workspace_id || !CRM[provider]) demoError('E_PAYLOAD_INVALID', 'workspace_id and provider (hubspot, pipedrive or salesforce) required');
    const { ws } = requireWs(ctx, b.workspace_id, 'manager');
    const label = CRM[provider].label;
    let integ = s.t('outreach_integrations').find((i) => i.workspace_id === ws && i.provider === provider);
    if (!integ) integ = s.insert('outreach_integrations', { workspace_id: ws, provider, status: 'connecting', created_by: ctx.userId, settings: { sync_rule: 'replied', log_messages: true, create_deal_on_interested: false, suppress_customers: false }, field_mapping: {}, stage_mapping: {}, last_event_id: 0, last_sync_at: null, last_pull_at: null, last_error: null, account_label: null })[0];
    else if (integ.status !== 'active') s.update('outreach_integrations', integ.id, { status: 'connecting' });
    audit(s, ws, ctx.userId, 'integration.connect_started', 'integration', integ.id, { provider });
    const ok = await ctx.ui.dialog({ kind: 'consent', app: label, scopes: SCOPES[provider] });
    if (!ok) {
      if (integ.status === 'connecting' || s.get('outreach_integrations', integ.id)?.status === 'connecting') s.update('outreach_integrations', integ.id, { status: 'disconnected' });
      demoError('E_CANCELLED', `You cancelled the ${label} sign-in, so nothing was connected.`);
    }
    const w = workspaceRow(s, ws);
    s.update('outreach_integrations', integ.id, { status: 'active', account_label: `${w.name} · Connected (demo)`, last_error: null });
    s.upsert('outreach_integration_secrets', { integration_id: integ.id, access_token_enc: 'demo:masked', refresh_token_enc: 'demo:masked', expires_at: new Date(Date.now() + 6 * 3_600_000).toISOString(), instance_url: null, oauth_state: null, updated_at: ctx.now() }, ['integration_id']);
    syncLog(s, integ, { lead_id: null, direction: 'pull', op: 'suppress.refresh', status: 'skipped', detail: 'Customer blacklist is off for this connection.' });
    audit(s, ws, ctx.userId, 'integration.connected', 'integration', integ.id, { provider, account: `${label} (demo)` });
    ctx.ui.simulated(`Simulated. ${label} was not contacted.`);
    const ret = new URLSearchParams({ connected: provider });
    return { url: `${tourPath('/outreach/settings/integrations')}?${ret.toString()}`, integration_id: integ.id };
  }

  if (!['segments', 'import_segment', 'sync_now', 'test'].includes(action)) demoError('E_PAYLOAD_INVALID', 'action must be start, segments, import_segment, sync_now or test');
  const integ = s.get('outreach_integrations', String(b.integration_id ?? ''));
  if (!integ) demoError('E_NOT_FOUND', 'integration not found');
  requireWs(ctx, integ.workspace_id, 'manager', action === 'segments' || action === 'test' ? false : true);
  const meta = CRM[integ.provider];
  if (!meta) demoError('E_NOT_FOUND', 'integration not found');
  if (integ.status !== 'active' && integ.status !== 'error') demoError('E_NOT_CONNECTED', `${meta.label} is not connected. Connect it first.`);

  if (action === 'test') {
    s.update('outreach_integrations', integ.id, { status: 'active', last_error: null });
    return { ok: true, account_label: integ.account_label, provider: integ.provider };
  }
  if (action === 'segments') return { segments: meta.segments.map((x) => ({ id: x.id, name: x.name, kind: x.kind, count: x.count })) };
  if (action === 'import_segment') {
    const seg = meta.segments.find((x) => x.id === String(b.segment_id ?? ''));
    if (!seg) demoError('E_PAYLOAD_INVALID', 'segment_id required');
    const listId = b.list_id ? String(b.list_id) : null, clientId = b.client_id ? String(b.client_id) : null;
    if (listId && !s.t('outreach_lists').some((l) => l.id === listId && l.workspace_id === integ.workspace_id)) demoError('E_NOT_FOUND', 'list not found in this workspace');
    if (clientId && !s.t('outreach_clients').some((c) => c.id === clientId && c.workspace_id === integ.workspace_id)) demoError('E_NOT_FOUND', 'client not found in this workspace');
    const result = importLeads(ctx, integ, seg, listId, clientId);
    s.update('outreach_integrations', integ.id, { last_pull_at: ctx.now() });
    audit(s, integ.workspace_id, ctx.userId, 'integration.segment_imported', 'integration', integ.id, { provider: integ.provider, segment_id: seg.id, imported: result.imported });
    ctx.ui.simulated(`Simulated. The people came from a sample ${meta.label} ${seg.kind}.`);
    return { ok: true, ...result };
  }
  // sync_now: push the leads who replied lately (the default rule), then report
  const since = Date.now() - 3 * DAY;
  const replied = s.t('outreach_leads').filter((l) => l.workspace_id === integ.workspace_id && l.last_replied_at && Date.parse(l.last_replied_at) >= since).slice(0, 5);
  for (const l of replied) syncLog(s, integ, { lead_id: l.id, direction: 'push', op: 'contact.upsert', status: 'ok', detail: `${l.full_name ?? 'Lead'} (${l.company ?? 'no company'})` });
  if (integ.settings?.suppress_customers) syncLog(s, integ, { lead_id: null, direction: 'pull', op: 'suppress.refresh', status: 'ok', detail: 'Customer blacklist refreshed: nothing new.' });
  s.update('outreach_integrations', integ.id, { last_sync_at: ctx.now(), status: 'active', last_error: null, ...(integ.settings?.suppress_customers ? { last_pull_at: ctx.now() } : {}) });
  ctx.ui.simulated(`Simulated. Nothing was sent to ${meta.label}.`);
  return { ok: true, pushed: replied.length, pulled: 0, errors: 0, stop: null };
}

// ---------------------------------------------------------------------------
const FINDERS = ['hunter', 'prospeo', 'findymail'];
const VERIFIERS = ['zerobounce', 'reacher'];
const LLMS = ['gemini', 'anthropic', 'openai'];
const DEFAULT_MODELS: Record<string, string> = { gemini: 'gemini-2.5-flash', anthropic: 'claude-sonnet-4-5', openai: 'gpt-4.1-mini' };
const MASK = 'demo:masked';

function cleanKey(v: unknown, what: string): string {
  const k = String(v ?? '').trim();
  if (k.length < 8 || k.length > 400 || /\s/.test(k)) demoError('E_PAYLOAD_INVALID', `${what}: that does not look like an API key`);
  return k;
}
function pickOne(v: unknown, allowed: string[], what: string): string {
  const p = lowerTrim(v);
  if (!allowed.includes(p)) demoError('E_PAYLOAD_INVALID', `${what} must be one of: ${allowed.join(', ')}`);
  return p;
}

function publicView(r: Row): Row {
  return {
    llm_provider: r.llm_key_enc ? r.llm_provider : 'platform', llm_model: r.llm_key_enc ? r.llm_model : null, llm_key_hint: r.llm_key_enc ? r.llm_key_hint : null, uses_own_key: !!r.llm_key_enc,
    finders: (Array.isArray(r.finder_keys) ? r.finder_keys : []).map((f: Row) => ({ provider: f.provider, hint: f.hint ?? null })),
    verifier: r.verifier ? { provider: r.verifier.provider, hint: r.verifier.hint ?? null } : null,
    elevenlabs_key_hint: r.elevenlabs_key_enc ? r.elevenlabs_key_hint ?? null : null,
  };
}

/** Keys are never kept: only the last four characters (the hint) and a masked placeholder. */
function workspaceSecrets(req: FnRequest, ctx: Ctx): unknown {
  const b = req.body;
  const { ws } = requireWs(ctx, b.workspace_id, 'manager');
  const s = ctx.store;
  const existing = s.t('outreach_workspace_secrets').find((r) => r.workspace_id === ws);
  const next: Row = {
    llm_provider: existing?.llm_provider ?? null, llm_model: existing?.llm_model ?? null, llm_key_enc: existing?.llm_key_enc ?? null, llm_key_hint: existing?.llm_key_hint ?? null,
    finder_keys: Array.isArray(existing?.finder_keys) ? existing!.finder_keys : [], verifier: existing?.verifier ?? null,
    elevenlabs_key_enc: existing?.elevenlabs_key_enc ?? null, elevenlabs_key_hint: existing?.elevenlabs_key_hint ?? null,
  };
  const changed: Row = {};
  const hint = (k: string) => k.slice(-4);

  if (b.llm !== undefined) {
    const llm = b.llm as Row | null;
    if (llm === null || llm.key === '') { Object.assign(next, { llm_provider: null, llm_model: null, llm_key_enc: null, llm_key_hint: null }); changed.llm = { removed: !!existing?.llm_key_enc }; }
    else {
      const provider = pickOne(llm.provider, LLMS, 'llm.provider');
      const model = String(llm.model ?? '').trim().slice(0, 100) || DEFAULT_MODELS[provider];
      if (!/^[A-Za-z0-9._:/-]+$/.test(model)) demoError('E_PAYLOAD_INVALID', 'llm.model has characters a model id cannot contain');
      let h: string;
      if (llm.key === undefined || llm.key === null) {
        if (!existing?.llm_key_enc || existing.llm_provider !== provider) demoError('E_PAYLOAD_INVALID', 'llm.key required');
        h = existing.llm_key_hint;
      } else h = hint(cleanKey(llm.key, 'llm.key'));
      Object.assign(next, { llm_provider: provider, llm_model: model, llm_key_enc: MASK, llm_key_hint: h });
      changed.llm = { provider, model, key_hint: h };
    }
  }
  if (b.finders !== undefined) {
    if (!Array.isArray(b.finders) || b.finders.length > FINDERS.length) demoError('E_PAYLOAD_INVALID', `finders must be a list of at most ${FINDERS.length} providers`);
    const saved = new Map<string, Row>((next.finder_keys as Row[]).map((f) => [String(f.provider), f]));
    const list: Row[] = [];
    for (const f of b.finders as Row[]) {
      const provider = pickOne(f?.provider, FINDERS, 'finders[].provider');
      if (list.some((x) => x.provider === provider)) demoError('E_PAYLOAD_INVALID', `${provider} is listed twice`);
      if (f.key === '') continue;
      if (f.key === undefined || f.key === null) {
        const old = saved.get(provider);
        if (!old?.key_enc) demoError('E_PAYLOAD_INVALID', `finders: a key is required for ${provider}`);
        list.push({ provider, key_enc: old.key_enc, hint: old.hint ?? null });
      } else list.push({ provider, key_enc: MASK, hint: hint(cleanKey(f.key, `finders: ${provider}`)) });
    }
    next.finder_keys = list;
    changed.finders = list.map((f) => ({ provider: f.provider, key_hint: f.hint }));
  }
  if (b.verifier !== undefined) {
    const v = b.verifier as Row | null;
    if (v === null || v.key === '') { next.verifier = null; changed.verifier = { removed: !!existing?.verifier }; }
    else {
      const provider = pickOne(v.provider, VERIFIERS, 'verifier.provider');
      let url: string | null = null;
      if (v.url != null && String(v.url).trim()) {
        if (provider !== 'reacher') demoError('E_PAYLOAD_INVALID', 'verifier.url is only for a self-hosted Reacher');
        if (!/^https:\/\//.test(String(v.url).trim())) demoError('E_PAYLOAD_INVALID', 'verifier.url must be an https address');
        url = String(v.url).trim().replace(/\/+$/, '');
      }
      const old = existing?.verifier as Row | null;
      let h: string | null;
      if (v.key === undefined || v.key === null) {
        if (!old?.key_enc || old.provider !== provider) demoError('E_PAYLOAD_INVALID', 'verifier.key required');
        h = old.hint ?? null;
      } else h = hint(cleanKey(v.key, 'verifier.key'));
      next.verifier = { provider, key_enc: MASK, hint: h, ...(url ? { url } : {}) };
      changed.verifier = { provider, key_hint: h, ...(url ? { url } : {}) };
    }
  }
  if (b.elevenlabs !== undefined) {
    const v = b.elevenlabs as Row | null;
    if (v === null || v.key === '') { Object.assign(next, { elevenlabs_key_enc: null, elevenlabs_key_hint: null, elevenlabs_webhook_id: null, elevenlabs_webhook_secret_enc: null }); changed.elevenlabs = { removed: !!existing?.elevenlabs_key_enc }; }
    else {
      const h = hint(cleanKey(v.key, 'elevenlabs.key'));
      Object.assign(next, { elevenlabs_key_enc: MASK, elevenlabs_key_hint: h, elevenlabs_webhook_id: null, elevenlabs_webhook_secret_enc: null });
      changed.elevenlabs = { key_hint: h, calls_confirmed_by: 'webhook' };
    }
  }

  if (!Object.keys(changed).length) {
    if (b.ensure && !existing) s.insert('outreach_workspace_secrets', { workspace_id: ws, ...next, booking_secret: hex(s, 36), updated_at: ctx.now() }, { noId: true });
    return { ok: true, changed: false, settings: publicView(next) };
  }
  if (existing) s.update('outreach_workspace_secrets', (r) => r === existing, { ...next, updated_at: ctx.now() });
  else s.insert('outreach_workspace_secrets', { workspace_id: ws, ...next, booking_secret: hex(s, 36), updated_at: ctx.now() }, { noId: true });
  audit(s, ws, ctx.userId, 'workspace.ai_settings', 'workspace', ws, changed);
  ctx.ui.simulated('Simulated. The key was not sent to the provider; only its last 4 characters are kept.');
  return { ok: true, changed: true, settings: publicView(next) };
}

// ---------------------------------------------------------------------------
export const settingsFn = {
  billing,
  'invite-member': inviteMember,
  'crm-oauth': crmOauth,
  'workspace-secrets': workspaceSecrets,
  // platform setup is an operator tool (Settings → Admin, hidden in the tour)
  'unipile-setup': () => demoError('E_FORBIDDEN', 'platform admin required'),
} satisfies FnArea;

