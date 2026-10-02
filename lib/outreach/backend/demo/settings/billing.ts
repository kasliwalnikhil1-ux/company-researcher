/**
 * Billing in the demo (pricing-billing-PRD.md, demo stand-in for Stripe): the `billing_state` answer, quotes and plan
 * changes priced with the real price book (lib/outreach/pricing.ts), renewals when the simulated clock passes the end of a
 * period, invoices (table `_demo_invoices`, the stand-in for Stripe's) and the accounts-over-time rows.
 *
 * The demo user is on the top plan with every feature on: `features` reports every feature enabled whatever the plan.
 */
import { formatUsd, pricing, type BillingPeriod, type PlanId } from '../../../pricing';
import { DAY, demoError, type Ctx } from '../ctx';
import type { DemoStore, Row } from '../store';
import { audit, workspaceRow } from './common';

export const INVOICES = '_demo_invoices';
const PAID: string[] = ['launch', 'scale', 'enterprise'];
const PLAN_LABEL: Record<string, string> = { trial: 'Trial', trial_expired: 'Trial ended', launch: 'Launch', scale: 'Scale', enterprise: 'Enterprise', suspended: 'Suspended', cancelled: 'Cancelled' };
export const planLabel = (p: unknown) => PLAN_LABEL[String(p ?? '')] ?? String(p ?? '');
export const isPaid = (p: unknown): p is PlanId => PAID.includes(String(p));
const periodLabel = (p: string | null | undefined) => (p ? pricing.periodById(p).label : '');
export function planLine(plan: unknown, accounts: number | null | undefined, period: string | null | undefined): string {
  return [planLabel(plan), accounts != null ? `${accounts} account${accounts === 1 ? '' : 's'}` : null, period ? periodLabel(period) : null].filter(Boolean).join(' · ');
}
const longDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
const iso = (ms: number) => new Date(ms).toISOString();

export function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/** One period of a plan, in cents (the list price; the demo has no early-supporter discount). */
export const totalCents = (plan: PlanId, period: BillingPeriod, accounts: number) => pricing.quote(plan, period, accounts).period_total * 100;

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------
/** `outreach__occupies`: a live connection holds an account; website chat inboxes never count. */
export const occupies = (s: Row) => !s.deleted_at && s.provider !== 'WEBCHAT' && !['disabled', 'disconnected'].includes(String(s.status)) && s.unipile_account_id != null;
const MAILBOXES = ['GMAIL', 'OUTLOOK', 'MAIL', 'IMAP', 'GOOGLE', 'MICROSOFT'];

export function slots(store: DemoStore, w: Row) {
  const senders = store.t('outreach_senders').filter((s) => s.workspace_id === w.id && occupies(s));
  const used = senders.length;
  const over = senders.filter((s) => s.status === 'paused' && s.status_reason === 'over_plan_limit').length;
  const now = Date.now();
  const reserved = store.t('outreach_slot_reservations').filter((r) => r.workspace_id === w.id && !r.released_at && Date.parse(r.expires_at) > now).length;
  const billed: number | null = w.plan === 'trial' ? (w.trial_account_limit ?? 1) : ['launch', 'scale', 'enterprise', 'suspended'].includes(w.plan) ? (w.accounts_billed ?? null) : 0;
  return {
    enforced: true, plan: w.plan, trial: w.plan === 'trial', billed, requested: w.accounts_requested ?? null, used, reserved, over_limit: over,
    available: billed == null ? null : Math.max(billed - used - reserved, 0),
    mailboxes: senders.filter((s) => MAILBOXES.includes(String(s.provider))).length,
  };
}

/** Every feature on (the tour shows the whole product); limits are the top plan's. */
export function features(): Record<string, { enabled: boolean; limit: number | null; min_plan: PlanId | null }> {
  const out: Record<string, { enabled: boolean; limit: number | null; min_plan: PlanId | null }> = {};
  for (const f of pricing.book.features) out[f.key] = { enabled: true, limit: f.limits ? f.limits.enterprise : null, min_plan: pricing.planFor(f.key) };
  return out;
}

export const hasLiveSubscription = (w: Row) => !!w.stripe_subscription_id && ['active', 'trialing', 'past_due', 'unpaid'].includes(String(w.stripe_status ?? ''));

// ---------------------------------------------------------------------------
// renewals (the clock moves every timestamp into the past, so a period ends while the visitor watches)
// ---------------------------------------------------------------------------
export function addInvoice(store: DemoStore, w: Row, o: { at: number; plan: string; accounts: number; period: string; cents: number; kind: 'renewal' | 'change' | 'checkout'; lines?: Array<{ description: string; amount_cents: number }>; periodEnd?: number }): Row {
  const n = 1000 + store.t(INVOICES).filter((i) => i.workspace_id === w.id).length + 1;
  const description = planLine(o.plan, o.accounts, o.period);
  return store.insert(INVOICES, {
    workspace_id: w.id, number: `NW-${n}`, kind: o.kind, status: 'paid', currency: 'usd', amount_cents: o.cents, description,
    lines: o.lines ?? [{ description: `${description}${o.periodEnd ? ` (${longDate(o.at)} – ${longDate(o.periodEnd)})` : ''}`, amount_cents: o.cents }],
    period_start: iso(o.at), period_end: o.periodEnd ? iso(o.periodEnd) : null, paid_at: iso(o.at), created_at: iso(o.at),
  })[0];
}

export function tick(store: DemoStore, w: Row): void {
  if (!isPaid(w.plan) || !w.current_period_end || !w.billing_period) return;
  for (let guard = 0; guard < 24 && Date.parse(w.current_period_end) <= Date.now(); guard++) {
    const end = Date.parse(w.current_period_end);
    if (w.cancel_at_period_end) {
      store.update('outreach_workspaces', w.id, {
        plan: 'cancelled', plan_before_suspension: w.plan, stripe_status: 'canceled', cancel_at_period_end: false, scheduled_change: null,
        data_delete_after: iso(end + 90 * DAY),
      });
      audit(store, w.id, null, 'billing.cancelled', 'workspace', w.id, { plan: w.plan_before_suspension }, 'system');
      return;
    }
    const sc = w.scheduled_change as Row | null;
    const patch: Row = {};
    if (sc && (!sc.effective_at || Date.parse(sc.effective_at) <= end + 60_000)) {
      Object.assign(patch, { plan: sc.plan ?? w.plan, accounts_billed: sc.accounts_billed ?? w.accounts_billed, accounts_requested: sc.accounts_requested ?? sc.accounts_billed ?? w.accounts_requested, billing_period: sc.billing_period ?? w.billing_period, scheduled_change: null });
      store.update('outreach_billing_changes', (c) => c.workspace_id === w.id && c.status === 'scheduled', { status: 'applied', applied_at: iso(end) });
    }
    const plan = (patch.plan ?? w.plan) as PlanId, period = (patch.billing_period ?? w.billing_period) as BillingPeriod, accounts = Number(patch.accounts_billed ?? w.accounts_billed ?? 1);
    const next = addMonths(end, pricing.periodById(period).months);
    store.update('outreach_workspaces', w.id, { ...patch, current_period_start: iso(end), current_period_end: iso(next) });
    addInvoice(store, w, { at: end, periodEnd: next, plan, accounts, period, cents: totalCents(plan, period, accounts), kind: 'renewal' });
  }
}

// ---------------------------------------------------------------------------
// billing_state
// ---------------------------------------------------------------------------
export function billingState(store: DemoStore, wsId: string, userId: string): Row {
  const w = workspaceRow(store, wsId);
  tick(store, w);
  const m = store.t('outreach_members').find((x) => x.workspace_id === wsId && x.user_id === userId);
  if (!m) demoError('E_FORBIDDEN', 'not a member of workspace');
  const owner = m.role === 'owner';
  const featurePlan = isPaid(w.plan) ? w.plan : w.plan === 'trial' ? 'scale' : (isPaid(w.plan_before_suspension) ? w.plan_before_suspension : 'scale');
  const base: Row = {
    workspace_id: wsId, enforced: true, plan: w.plan, feature_plan: featurePlan, read_only: ['suspended', 'cancelled', 'trial_expired'].includes(w.plan), features: features(), is_owner: owner,
  };
  if (m.role === 'client_viewer') { delete base.features; return { ...base, access_blocked: null }; }
  const s = slots(store, w);
  const { mailboxes: _m, ...accounts } = s; void _m;
  Object.assign(base, {
    accounts,
    trial: { ends_at: w.trial_ends_at ?? null, account_limit: w.trial_account_limit ?? 1, days_left: w.plan === 'trial' && w.trial_ends_at ? Math.max(Math.ceil((Date.parse(w.trial_ends_at) - Date.now()) / DAY), 0) : null },
    past_due: ['past_due', 'unpaid'].includes(String(w.stripe_status)) || !!w.past_due_since, past_due_since: w.past_due_since ?? null,
    cancel_at_period_end: !!w.cancel_at_period_end, current_period_end: w.current_period_end ?? null, data_delete_after: w.data_delete_after ?? null,
    paused_over_limit: store.t('outreach_senders').filter((x) => x.workspace_id === wsId && !x.deleted_at && x.status === 'paused' && x.status_reason === 'over_plan_limit').map((x) => ({ sender_id: x.id, name: x.display_name ?? null })),
  });
  if (!owner) return base;
  return {
    ...base,
    billing_period: w.billing_period ?? null, accounts_requested: w.accounts_requested ?? null, accounts_billed: w.accounts_billed ?? null,
    current_period_start: w.current_period_start ?? null, cancelled_at: w.cancelled_at ?? null, scheduled_change: w.scheduled_change ?? null,
    pending_payment: w.pending_payment ?? null, stripe_status: w.stripe_status ?? null, has_customer: !!w.stripe_customer_id, has_subscription: hasLiveSubscription(w),
    comp: !!w.billing_comp, price_version: w.price_version ?? 'v1', custom_price: !!w.custom_price_id, plan_before_suspension: w.plan_before_suspension ?? null,
    disputed: !!w.disputed_at, early_supporter: null,
    quote_current: isPaid(w.plan) && w.billing_period && w.accounts_billed && !w.custom_price_id ? { ...pricing.quote(w.plan, w.billing_period, w.accounts_billed), version: w.price_version ?? 'v1' } : null,
  };
}

// ---------------------------------------------------------------------------
// quotes
// ---------------------------------------------------------------------------
type St = { plan: PlanId; accounts: number; period: BillingPeriod };
const same = (a: St, b: St) => a.plan === b.plan && a.accounts === b.accounts && a.period === b.period;

function changes(a: St, b: St): string[] {
  const out: string[] = [];
  if (a.plan !== b.plan) out.push(`Plan: ${planLabel(a.plan)} → ${planLabel(b.plan)}`);
  if (a.accounts !== b.accounts) out.push(`Accounts: ${a.accounts} → ${b.accounts}`);
  if (a.period !== b.period) out.push(`Billing period: ${periodLabel(a.period)} → ${periodLabel(b.period)}`);
  return out;
}

export function parseTarget(body: Row): St {
  const plan = body.plan, period = body.period, accounts = Number(body.accounts);
  if (!pricing.isPlan(plan)) demoError('E_PAYLOAD_INVALID', 'plan must be launch, scale or enterprise');
  if (!pricing.isPeriod(period)) demoError('E_PAYLOAD_INVALID', 'period must be monthly, quarterly or annual');
  if (!Number.isInteger(accounts) || accounts < 1) demoError('E_PAYLOAD_INVALID', 'Choose at least 1 account.');
  if (accounts > pricing.book.max_self_serve_accounts) demoError('E_TALK_TO_US', `Plans with more than ${pricing.book.max_self_serve_accounts} accounts are set up with our team. Talk to us.`);
  return { plan, period, accounts };
}

function activity14d(store: DemoStore, senderId: string): number {
  const since = Date.now() - 14 * DAY;
  let n = 0;
  for (const a of store.t('outreach_actions')) if (a.sender_id === senderId && a.status === 'sent' && a.executed_at && Date.parse(a.executed_at) >= since) n++;
  return n;
}

function sendersToPause(store: DemoStore, w: Row, limit: number, keep: unknown): Row[] {
  const live = store.t('outreach_senders').filter((s) => s.workspace_id === w.id && occupies(s));
  if (live.length <= limit) return [];
  const ranked = live.map((s) => ({ s, n: activity14d(store, s.id) })).sort((a, b) => b.n - a.n);
  const wanted = Array.isArray(keep) ? (keep as unknown[]).map(String).filter((id) => live.some((s) => s.id === id)).slice(0, limit) : null;
  const kept = new Set(wanted ?? ranked.slice(0, limit).map((x) => x.s.id));
  return ranked.map(({ s, n }) => ({ sender_id: s.id, name: s.display_name ?? null, provider: s.provider, status: s.status, activity_14d: n, keep: kept.has(s.id), action: kept.has(s.id) ? 'keep' : 'pause' }));
}

/** `quote`: prices a change (or a first subscription) and keeps it for 15 minutes as a `quoted` billing change. */
export function buildQuote(ctx: Ctx, w: Row, target: St, keep: unknown): Row {
  const store = ctx.store;
  tick(store, w);
  const now = Date.now();
  // quotes nobody confirmed are noise after an hour
  store.remove('outreach_billing_changes', (c) => c.workspace_id === w.id && c.status === 'quoted' && Date.parse(c.created_at) < now - 3_600_000, { silent: true });
  const sub = hasLiveSubscription(w) && isPaid(w.plan) && !!w.billing_period && !!w.accounts_billed;
  let q: Row;
  if (sub) {
    const from: St = { plan: w.plan, accounts: w.accounts_billed, period: w.billing_period };
    const split = pricing.splitChange(from, target);
    if (split.blocked) demoError(split.blocked.code, split.blocked.message);
    const imm = split.immediate, fin = split.final;
    const start = Date.parse(w.current_period_start ?? iso(now)), end = Date.parse(w.current_period_end ?? iso(now + 30 * DAY));
    const left = end > start ? Math.min(Math.max((end - now) / (end - start), 0), 1) : 1;
    const fromC = totalCents(from.plan, from.period, from.accounts), immC = totalCents(imm.plan, imm.period, imm.accounts);
    let charge = 0, nextAt = end;
    const lines: Row[] = [];
    if (split.applies_now) {
      if (imm.period !== from.period) {
        const credit = Math.round(fromC * left);
        charge = immC - credit;
        nextAt = addMonths(now, pricing.periodById(imm.period).months);
        lines.push({ description: `${planLine(imm.plan, imm.accounts, imm.period)}, from today`, amount_cents: immC, proration: false });
        lines.push({ description: `Unused time on ${planLine(from.plan, from.accounts, from.period)}`, amount_cents: -credit, proration: true });
      } else {
        const add = Math.round(immC * left), credit = Math.round(fromC * left);
        charge = add - credit;
        lines.push({ description: `Remaining time on ${planLine(imm.plan, imm.accounts, imm.period)}`, amount_cents: add, proration: true });
        lines.push({ description: `Unused time on ${planLine(from.plan, from.accounts, from.period)}`, amount_cents: -credit, proration: true });
      }
    }
    charge = Math.max(charge, 0);
    const fq = split.final_quote;
    const finC = totalCents(fin.plan, fin.period, fin.accounts);
    q = {
      mode: 'change', from, to: target, immediate: imm, final: fin, applies_now: split.applies_now, applies_at_renewal: split.applies_at_renewal,
      charge_today_cents: charge, tax_today_cents: 0, lines,
      proration_note: split.applies_now && imm.period === from.period ? `You pay the difference for the ${Math.max(1, Math.round((end - now) / DAY))} days left in this billing period.` : null,
      per_account: fq.per_account, months: fq.months,
      next_invoice: { at: iso(nextAt), cents: finC, list_cents: finC }, later_at: split.applies_at_renewal ? iso(nextAt) : null,
      now_changes: changes(from, imm), later_changes: changes(imm, fin),
      best_price: fq.best_price ? { requested: fq.requested, billed: fq.billed, requested_total_cents: fq.requested_total * 100, billed_total_cents: fq.period_total * 100, note: `${fq.billed} accounts cost ${fq.requested_total === fq.period_total ? 'the same as' : 'less than'} ${fq.requested}, so you get ${fq.billed}.` } : null,
      early_supporter: null, effects: [], senders_to_pause: sendersToPause(store, w, fin.accounts, keep),
      resumes_subscription: !!w.cancel_at_period_end, replaces_scheduled: !!w.scheduled_change, price_version_change: null, non_refundable: true,
    };
  } else {
    const fq = pricing.quote(target.plan, target.period, target.accounts);
    const fin: St = { plan: target.plan, period: target.period, accounts: fq.billed };
    const cents = fq.period_total * 100;
    const nextAt = addMonths(now, fq.months);
    q = {
      mode: 'checkout', to: target, immediate: fin, final: fin, applies_now: true, applies_at_renewal: false, charge_today_cents: cents, tax_today_cents: 0,
      lines: [{ description: planLine(fin.plan, fin.accounts, fin.period), amount_cents: cents, proration: false }], proration_note: null,
      per_account: fq.per_account, months: fq.months, next_invoice: { at: iso(nextAt), cents, list_cents: cents }, later_at: null,
      now_changes: [`${planLine(fin.plan, fin.accounts, fin.period)} starts today`], later_changes: [],
      best_price: fq.best_price ? { requested: fq.requested, billed: fq.billed, requested_total_cents: fq.requested_total * 100, billed_total_cents: fq.period_total * 100, note: `${fq.billed} accounts cost ${fq.requested_total === fq.period_total ? 'the same as' : 'less than'} ${fq.requested}, so you get ${fq.billed}.` } : null,
      early_supporter: null, effects: [], senders_to_pause: sendersToPause(store, w, fin.accounts, keep), resumes_subscription: false, replaces_scheduled: false,
      price_version_change: null, non_refundable: true,
    };
  }
  const expires = iso(now + 15 * 60_000);
  const row = store.insert('outreach_billing_changes', {
    workspace_id: w.id, requested_by: ctx.userId, kind: q.mode === 'checkout' ? 'checkout' : 'change',
    from_state: { plan: w.plan, accounts_billed: w.accounts_billed ?? null, billing_period: w.billing_period ?? null },
    to_state: { plan: q.final.plan, accounts_billed: q.final.accounts, accounts_requested: target.accounts, billing_period: q.final.period },
    immediate: q.applies_now ? q.immediate : null, scheduled: q.applies_at_renewal ? q.final : null, quote: q,
    keep_sender_ids: Array.isArray(keep) ? keep : null, status: 'quoted', error: null, stripe_invoice_id: null, expires_at: expires, applied_at: null,
  }, { silent: true })[0];
  return { quote_id: row.id, expires_at: expires, quote: q, has_subscription: sub };
}

function loadQuote(ctx: Ctx, w: Row, quoteId: unknown): Row {
  const row = ctx.store.get('outreach_billing_changes', String(quoteId ?? ''));
  if (!row || row.workspace_id !== w.id) demoError('E_NOT_FOUND', 'quote');
  if (row.status !== 'quoted') demoError('E_QUOTE_STALE', 'This quote was already used. Here is a fresh one.');
  if (Date.parse(row.expires_at) < Date.now()) demoError('E_QUOTE_STALE', 'The price is more than 15 minutes old. Here is a fresh one.');
  const f = row.from_state as Row;
  if (f.plan !== w.plan || (f.accounts_billed ?? null) !== (w.accounts_billed ?? null) || (f.billing_period ?? null) !== (w.billing_period ?? null)) demoError('E_QUOTE_STALE', 'The subscription changed since this price was worked out. Here is a fresh one.');
  return row;
}

async function pay(ctx: Ctx, q: Row, title: string): Promise<void> {
  const lines: string[] = (q.lines as Row[]).map((l) => `${l.description}: ${formatUsd(l.amount_cents)}`);
  if (q.next_invoice?.at) lines.push(`Next invoice on ${longDate(Date.parse(q.next_invoice.at))}: ${q.next_invoice.cents != null ? formatUsd(q.next_invoice.cents) : 'per your agreement'}`);
  const ok = await ctx.ui.dialog({ kind: 'checkout', title, amount: formatUsd(q.charge_today_cents), lines });
  if (!ok) demoError('E_CANCELLED', 'Cancelled');
}

/** `change`: applies a quoted change. Up now (paid in the fake checkout), down at renewal (scheduled). */
export async function applyChange(ctx: Ctx, w: Row, quoteId: unknown, keep: unknown): Promise<Row> {
  const store = ctx.store;
  const row = loadQuote(ctx, w, quoteId);
  const q = row.quote as Row;
  if (q.mode === 'checkout') demoError('E_PAYLOAD_INVALID', 'There is no subscription to change yet: continue to payment instead.');
  const charge = Number(q.charge_today_cents ?? 0);
  if (charge > 0) await pay(ctx, q, `Pay for ${planLine(q.immediate.plan, q.immediate.accounts, q.immediate.period)}`);
  const now = Date.now();
  const patch: Row = { cancel_at_period_end: false, cancelled_at: null };
  if (q.applies_now) {
    const imm = q.immediate as St;
    Object.assign(patch, { plan: imm.plan, accounts_billed: imm.accounts, accounts_requested: q.applies_at_renewal ? imm.accounts : Number(row.to_state.accounts_requested ?? imm.accounts), billing_period: imm.period });
    if (imm.period !== w.billing_period) Object.assign(patch, { current_period_start: iso(now), current_period_end: q.next_invoice.at });
  }
  const effectiveAt = q.applies_at_renewal ? (q.later_at ?? w.current_period_end) : null;
  patch.scheduled_change = q.applies_at_renewal
    ? { plan: q.final.plan, accounts_billed: q.final.accounts, accounts_requested: Number(row.to_state.accounts_requested ?? q.final.accounts), billing_period: q.final.period, effective_at: effectiveAt, keep_sender_ids: Array.isArray(keep) ? keep : row.keep_sender_ids ?? [] }
    : null;
  // an older scheduled change is replaced by this one
  store.update('outreach_billing_changes', (c) => c.workspace_id === w.id && c.status === 'scheduled', { status: 'cancelled' });
  store.update('outreach_workspaces', w.id, patch);
  if (charge > 0) addInvoice(store, w, { at: now, plan: q.immediate.plan, accounts: q.immediate.accounts, period: q.immediate.period, cents: charge, kind: 'change', lines: (q.lines as Row[]).map((l) => ({ description: l.description, amount_cents: l.amount_cents })) });
  const status = q.applies_now ? 'applied' : 'scheduled';
  store.update('outreach_billing_changes', row.id, { status, applied_at: q.applies_now ? iso(now) : null, expires_at: null, stripe_invoice_id: charge > 0 ? `in_demo_${row.id.slice(0, 8)}` : null, keep_sender_ids: Array.isArray(keep) ? keep : row.keep_sender_ids });
  audit(store, w.id, ctx.userId, 'billing.changed', 'workspace', w.id, { from: row.from_state, to: row.to_state, status, charged_cents: charge });
  ctx.ui.simulated(charge > 0 ? 'Simulated. No card was charged.' : 'Simulated. Nothing was charged.');
  return { status, charged_cents: charge, effective_at: effectiveAt, client_secret: null, hosted_invoice_url: null };
}

/** `checkout`: the first subscription (or one after a cancellation ended), paid in the fake checkout. */
export async function checkout(ctx: Ctx, w: Row, quoteId: unknown): Promise<void> {
  const store = ctx.store;
  const row = loadQuote(ctx, w, quoteId);
  const q = row.quote as Row;
  if (q.mode !== 'checkout') demoError('E_PAYLOAD_INVALID', 'This workspace already has a subscription: confirm the change instead.');
  await pay(ctx, q, `Subscribe to ${planLine(q.final.plan, q.final.accounts, q.final.period)}`);
  const now = Date.now();
  const fin = q.final as St;
  store.update('outreach_workspaces', w.id, {
    plan: fin.plan, accounts_billed: fin.accounts, accounts_requested: Number(row.to_state.accounts_requested ?? fin.accounts), billing_period: fin.period,
    stripe_customer_id: w.stripe_customer_id ?? 'cus_demo', stripe_subscription_id: `sub_demo_${row.id.slice(0, 8)}`, stripe_status: 'active',
    current_period_start: iso(now), current_period_end: q.next_invoice.at, cancel_at_period_end: false, cancelled_at: null, scheduled_change: null,
    plan_before_suspension: null, data_delete_after: null, past_due_since: null, trial_ends_at: null,
  });
  addInvoice(store, w, { at: now, periodEnd: Date.parse(q.next_invoice.at), plan: fin.plan, accounts: fin.accounts, period: fin.period, cents: q.charge_today_cents, kind: 'checkout' });
  store.update('outreach_billing_changes', row.id, { status: 'applied', applied_at: iso(now), expires_at: null, stripe_invoice_id: `in_demo_${row.id.slice(0, 8)}` });
  audit(store, w.id, ctx.userId, 'billing.subscribed', 'workspace', w.id, { plan: fin.plan, accounts: fin.accounts, period: fin.period });
  ctx.ui.simulated('Simulated. No card was charged.');
}

/** A billing change row that is not a quote (cancel, resume, dropped scheduled change). */
export function recordChange(ctx: Ctx, w: Row, kind: string, extra: Row = {}): void {
  const st = { plan: w.plan, accounts_billed: w.accounts_billed ?? null, billing_period: w.billing_period ?? null };
  ctx.store.insert('outreach_billing_changes', {
    workspace_id: w.id, requested_by: ctx.userId, kind, from_state: st, to_state: st, immediate: null, scheduled: null,
    quote: { charge_today_cents: 0, next_invoice_cents: null }, keep_sender_ids: null, status: 'applied', error: null, stripe_invoice_id: null,
    expires_at: null, applied_at: ctx.now(), ...extra,
  });
}

// ---------------------------------------------------------------------------
// invoices
// ---------------------------------------------------------------------------
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A sample invoice as a small HTML document (the visitor downloads it from "Payment method & invoices"). */
export function invoiceHtml(inv: Row, w: Row, all: Row[]): string {
  const rows = (inv.lines as Row[]).map((l) => `<tr><td>${esc(l.description)}</td><td class="r">${esc(formatUsd(l.amount_cents))}</td></tr>`).join('');
  const others = all.map((i) => `<tr><td>${esc(i.number)}</td><td>${esc(longDate(Date.parse(i.created_at)))}</td><td>${esc(i.description)}</td><td class="r">${esc(formatUsd(i.amount_cents))}</td><td>${esc(i.status)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(inv.number)} (sample)</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#111827;max-width:720px;margin:40px auto;padding:0 16px}h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #e5e7eb;text-align:left}.r{text-align:right}.note{background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:8px 12px;font-size:13px}.muted{color:#6b7280}</style></head>
<body><p class="note">Sample invoice from the product tour. It is not a real document and nothing was charged.</p>
<h1>Invoice ${esc(inv.number)}</h1><p class="muted">Paid ${esc(longDate(Date.parse(inv.paid_at ?? inv.created_at)))} · Visa ending 4242</p>
<p><strong>Billed to</strong><br>${esc(w.name)}<br>maya.chen@example.com</p>
<table><thead><tr><th>Description</th><th class="r">Amount</th></tr></thead><tbody>${rows}<tr><th>Total</th><th class="r">${esc(formatUsd(inv.amount_cents))}</th></tr></tbody></table>
<h2 style="font-size:16px">All invoices</h2><table><thead><tr><th>Number</th><th>Date</th><th>Plan</th><th class="r">Amount</th><th>Status</th></tr></thead><tbody>${others}</tbody></table>
</body></html>`;
}

/** Saves the newest invoice as a file (a Blob URL; nothing leaves the browser). */
export function downloadInvoice(store: DemoStore, w: Row): Row | null {
  const all = store.t(INVOICES).filter((i) => i.workspace_id === w.id).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const inv = all[0];
  if (!inv) return null;
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return inv;
  const url = URL.createObjectURL(new Blob([invoiceHtml(inv, w, all)], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url; a.download = `invoice-${inv.number}-sample.html`; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return inv;
}

// ---------------------------------------------------------------------------
// accounts connected over time (outreach_billing_usage): today's row follows the senders
// ---------------------------------------------------------------------------
export function refreshUsage(store: DemoStore): void {
  const today = new Date().toISOString().slice(0, 10);
  for (const w of store.t('outreach_workspaces')) {
    if (w.deleted_at || !store.t('outreach_members').some((m) => m.workspace_id === w.id)) continue;
    const s = slots(store, w);
    const cur = store.t('outreach_billing_usage').find((u) => u.workspace_id === w.id && u.day === today);
    const vals = { accounts: s.used, accounts_billed: s.billed, active_senders: s.used - s.mailboxes, active_mailboxes: s.mailboxes };
    if (!cur) store.insert('outreach_billing_usage', { workspace_id: w.id, day: today, ...vals }, { noId: true, silent: true });
    else if (cur.accounts !== vals.accounts || cur.accounts_billed !== vals.accounts_billed) Object.assign(cur, vals);
  }
}
