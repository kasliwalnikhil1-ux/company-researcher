// Billing v2 (pricing-billing-PRD.md): quote → change / checkout / cancel / resume against Stripe, and the one function that
// makes a workspace follow its live Stripe subscription. Used by outreach-billing (owner actions), outreach-stripe-webhook
// (events) and outreach-billing-sync (hourly job). Rules without I/O live in billing_core.ts and pricing_core.ts.
import { admin, audit, HttpError, log, rpc, WEB_ORIGIN } from "./supabase.ts";
import { stripe, stripeConfigured, StripeError, stripeList } from "./stripe.ts";
import { pricing, discountedCents, formatUsd } from "./pricing.ts";
import type { BillingPeriod, BillingState, ChangeSplit, PlanId } from "./pricing.ts";
import {
  addPeriod, chargeTodayFromPreview, deriveSubscriptionState, describeSplit, expectedProrationCents, immediateUpdateParams, previewParams,
  prorationNote, schedulePhases, type DerivedSubscription, type ScheduledChange,
} from "./billing_core.ts";

type Row = Record<string, any>;

export const QUOTE_TTL_MIN = 15;
/** Stripe Tax is switched on by the operator once the account has a tax registration (without one Stripe collects nothing). */
const TAX_ENABLED = (Deno.env.get("STRIPE_TAX_ENABLED") ?? "").toLowerCase() === "true";
const PORTAL_CONFIGURATION = Deno.env.get("STRIPE_PORTAL_CONFIGURATION") ?? "";
/** Custom deals may go above the self-serve limit; this is only a sanity ceiling. */
const CUSTOM_MAX_ACCOUNTS = 5000;
const PAID: string[] = ["launch", "scale", "enterprise"];
const LIVE_STATUSES = ["active", "trialing", "past_due", "unpaid"];

export function requireStripe(): void {
  if (!stripeConfigured()) throw new HttpError(503, "E_NOT_CONFIGURED", "Billing is not switched on for this deployment yet.");
}

export async function loadWorkspace(id: string): Promise<Row> {
  const { data, error } = await admin.from("outreach_workspaces").select("*").eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) throw new HttpError(500, "E_INTERNAL", error.message);
  if (!data) throw new HttpError(404, "E_NOT_FOUND", "workspace not found");
  return data;
}

export function hasLiveSubscription(ws: Row): boolean {
  return !!ws.stripe_subscription_id && LIVE_STATUSES.includes(String(ws.stripe_status ?? ""));
}

/** The billing state a change starts from, or null when the workspace has no paid plan on record. */
export function currentState(ws: Row): BillingState | null {
  const plan = PAID.includes(ws.plan) ? ws.plan : ws.plan === "suspended" && PAID.includes(ws.plan_before_suspension) ? ws.plan_before_suspension : null;
  if (!plan || !pricing.isPeriod(ws.billing_period) || !Number.isInteger(ws.accounts_billed)) return null;
  return { plan, period: ws.billing_period, accounts: ws.accounts_billed };
}

// ---------------------------------------------------------------------------
// Stripe prices by lookup key (PRD §8.1). Cached for the life of the isolate.
// ---------------------------------------------------------------------------
const priceCache = new Map<string, { id: string; interval: "month" | "year"; interval_count: number }>();

export async function priceFor(plan: PlanId, period: BillingPeriod, version?: string): Promise<{ id: string; interval: "month" | "year"; interval_count: number }> {
  const key = pricing.lookupKey(plan, period, version);
  const hit = priceCache.get(key);
  if (hit) return hit;
  const list = await stripeList<any>("/prices", { lookup_keys: [key], active: true }, 1);
  const p = list[0];
  if (!p) throw new HttpError(503, "E_NOT_CONFIGURED", `The Stripe price ${key} does not exist. Run scripts/stripe-setup.ts.`);
  const v = { id: String(p.id), interval: p.recurring?.interval, interval_count: p.recurring?.interval_count ?? 1 };
  priceCache.set(key, v);
  return v;
}

async function priceById(id: string): Promise<{ id: string; interval: "month" | "year"; interval_count: number }> {
  const p = await stripe<any>("GET", `/prices/${encodeURIComponent(id)}`);
  return { id: String(p.id), interval: p.recurring?.interval, interval_count: p.recurring?.interval_count ?? 1 };
}

const couponOf = (ws: Row): string | null => pricing.couponForDiscount(Number(ws.early_supporter_discount ?? 0));

// ---------------------------------------------------------------------------
// The workspace follows Stripe
// ---------------------------------------------------------------------------
async function fetchSubscription(id: string): Promise<{ sub: any; schedule: any | null }> {
  const sub = await stripe<any>("GET", `/subscriptions/${encodeURIComponent(id)}`, { expand: ["latest_invoice"] });
  const schedId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
  const schedule = schedId ? await stripe<any>("GET", `/subscription_schedules/${encodeURIComponent(schedId)}`, { expand: ["phases.items.price"] }) : null;
  return { sub, schedule };
}

/**
 * Read the live subscription and write what it says to the workspace (plan, accounts, period, scheduled change, pending
 * payment). Event order and duplicates do not matter: the result only depends on what Stripe says now (PRD §8.6, #35).
 */
export async function syncWorkspaceFromStripe(wsId: string, subscriptionId?: string | null): Promise<{ state: DerivedSubscription | null; result: Row | null }> {
  const ws = await loadWorkspace(wsId);
  const subId = subscriptionId ?? ws.stripe_subscription_id;
  if (!subId) return { state: null, result: null };
  let fetched: { sub: any; schedule: any | null };
  try { fetched = await fetchSubscription(subId); }
  catch (e) {
    if (e instanceof StripeError && e.code === "resource_missing") { log({ fn: "billing", workspace: wsId, warn: "subscription not found at Stripe", subscription: subId }); return { state: null, result: null }; }
    throw e;
  }
  const state = deriveSubscriptionState(pricing, fetched.sub, fetched.schedule, { customPriceId: ws.custom_price_id, prevScheduled: ws.scheduled_change as ScheduledChange | null });
  // a pending payment keeps the change it belongs to
  if (state.pending_payment && ws.pending_payment?.change_id) state.pending_payment.change_id = ws.pending_payment.change_id;
  const result = await rpc<Row>("billing_apply_subscription", { p_ws: wsId, p: state });
  return { state, result };
}

// ---------------------------------------------------------------------------
// Quote (PRD §4.9, §10.1)
// ---------------------------------------------------------------------------
export interface Target { plan: PlanId; accounts: number; period: BillingPeriod }

export function parseTarget(body: Row): Target {
  const plan = body.plan, period = body.period ?? body.billing_period, accounts = Number(body.accounts);
  if (!pricing.isPlan(plan)) throw new HttpError(400, "E_PAYLOAD_INVALID", "plan must be launch, scale or enterprise");
  if (!pricing.isPeriod(period)) throw new HttpError(400, "E_PAYLOAD_INVALID", "period must be monthly, quarterly or annual");
  if (!Number.isInteger(accounts) || accounts < 1) throw new HttpError(400, "E_PAYLOAD_INVALID", "accounts must be a whole number of 1 or more");
  return { plan, accounts, period };
}

function cleanKeep(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const ids = [...new Set(v.map(String).filter((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)))];
  return ids.length ? ids.slice(0, 500) : null;
}

/** What a first subscription costs (Stripe Checkout takes it from here). */
function checkoutQuote(ws: Row, target: Target): Row {
  if (target.accounts > pricing.book.max_self_serve_accounts) throw new HttpError(409, "E_TALK_TO_US", `Plans with more than ${pricing.book.max_self_serve_accounts} accounts are set up with our team. Talk to us.`);
  const q = pricing.quote(target.plan, target.period, target.accounts);
  const discount = Number(ws.early_supporter_discount ?? 0);
  const list = q.period_total * 100;
  const cents = discountedCents(list, discount);
  return {
    mode: "checkout", to: target, final: { plan: q.plan, period: q.period, accounts: q.billed },
    per_account: q.per_account, months: q.months, period_total_cents: list, charge_today_cents: cents, tax_note: "Tax, where it applies, is added at checkout.",
    next_invoice: { at: addPeriod(new Date(), q.months).toISOString(), cents, list_cents: list },
    best_price: q.best_price ? { requested: q.requested, billed: q.billed, requested_total_cents: q.requested_total * 100, billed_total_cents: q.period_total * 100,
      note: `${q.billed} accounts cost ${q.requested_total === q.period_total ? "the same as" : "less than"} ${q.requested} (${formatUsd(q.period_total * 100)} vs ${formatUsd(q.requested_total * 100)}). You'll get ${q.billed}.` } : null,
    early_supporter: discount > 0 ? { discount, saves_cents: list - cents } : null,
    now_changes: [`${pricing.planById(q.plan).name} plan`, `${q.billed} account${q.billed === 1 ? "" : "s"}`, `${pricing.periodById(q.period).label} billing`],
    later_changes: [], non_refundable: true,
  };
}

/** Preconditions shared by quote and change (PRD §4.8). */
function assertChangeAllowed(ws: Row, split: ChangeSplit): void {
  if (ws.pending_payment) throw new HttpError(409, "E_PAYMENT_PENDING", "A payment for an earlier change is waiting to be completed. Finish or abandon it first.");
  if (ws.plan === "suspended" || String(ws.stripe_status) === "unpaid") throw new HttpError(402, "E_PAST_DUE", "This workspace is suspended. Pay the open invoice first.");
  const pastDue = String(ws.stripe_status) === "past_due" || !!ws.past_due_since;
  if (pastDue && split.applies_now) throw new HttpError(402, "E_PAST_DUE", "Pay the open invoice first. Until then only reductions and cancelling are possible.");
}

async function effectsFor(ws: Row, from: BillingState, final: BillingState, keep: string[] | null): Promise<{ effects: Row[]; senders: Row[] }> {
  const effects = pricing.planRank(final.plan) < pricing.planRank(from.plan) ? ((await rpc<Row[]>("downgrade_effects", { p_ws: ws.id, p_to_plan: final.plan })) ?? []) : [];
  let senders: Row[] = [];
  if (final.accounts < from.accounts) {
    const all = (await rpc<Row[]>("senders_to_pause", { p_ws: ws.id, p_limit: final.accounts, p_keep: keep })) ?? [];
    if (all.some((x) => x.action !== "keep")) senders = all;
  }
  return { effects, senders };
}

export interface QuoteResult { quote_id: string; expires_at: string; quote: Row }

/**
 * Price a change before the customer confirms it. For a workspace with a subscription the amount charged today is Stripe's
 * own preview of the same update, pinned to a proration date so the charge equals the quote when it is confirmed.
 */
export async function buildQuote(ws: Row, target: Target, userId: string | null, keepIn?: unknown, prorationDate?: number): Promise<QuoteResult> {
  requireStripe();
  if (ws.billing_comp && !hasLiveSubscription(ws)) throw new HttpError(409, "E_MANAGED_PLAN", "This workspace's plan is managed by our team. Talk to us to change it.");
  const keep = cleanKeep(keepIn);
  const expires = new Date(Date.now() + QUOTE_TTL_MIN * 60_000).toISOString();
  let quote: Row, fromState: Row, immediate: Row | null = null, scheduled: Row | null = null;

  if (!hasLiveSubscription(ws)) {
    quote = checkoutQuote(ws, target);
    fromState = { plan: ws.plan, accounts_billed: null, billing_period: null };
    immediate = quote.final;
  } else {
    const from = currentState(ws);
    if (!from) throw new HttpError(409, "E_STATE", "The subscription has no plan on record yet. Try again in a minute.");
    if (ws.custom_price_id && (target.plan !== from.plan || target.period !== from.period)) throw new HttpError(409, "E_TALK_TO_US", "This workspace is on a custom agreement. Talk to us to change the plan or billing period.");
    const split = pricing.splitChange(from, target, ws.custom_price_id ? CUSTOM_MAX_ACCOUNTS : pricing.book.max_self_serve_accounts);
    if (split.blocked) throw new HttpError(split.blocked.code === "E_PAYLOAD_INVALID" ? 400 : 409, split.blocked.code, split.blocked.message);
    assertChangeAllowed(ws, split);

    const discount = Number(ws.early_supporter_discount ?? 0);
    const periodStart = Math.floor(new Date(ws.current_period_start).getTime() / 1000), periodEnd = Math.floor(new Date(ws.current_period_end).getTime() / 1000);
    const at = prorationDate ?? Math.floor(Date.now() / 1000);
    const anchorNow = split.up.period;
    let today = { cents: 0, tax_cents: 0, pre_tax_cents: 0, lines: [] as Row[], includes_renewal: false };
    let prorationCheck: Row | null = null;
    if (split.applies_now) {
      const { sub } = await fetchSubscription(ws.stripe_subscription_id);
      const item = sub.items?.data?.[0];
      if (!item) throw new HttpError(409, "E_STATE", "The subscription has no item.");
      const price = ws.custom_price_id && item.price?.id === ws.custom_price_id ? { id: ws.custom_price_id } : await priceFor(split.immediate.plan, split.immediate.period, split.immediate.plan === from.plan ? ws.price_version : undefined);
      const preview = await stripe<any>("POST", "/invoices/create_preview", previewParams({ subscriptionId: sub.id, itemId: item.id, priceId: price.id, quantity: split.immediate.accounts, prorationDate: at, anchorNow }));
      today = chargeTodayFromPreview(preview, { anchorReset: anchorNow, periodEnd });
      // PRD §15 / §17 Q2: Stripe must re-price every unit of a volume-tiered quantity change. Our own sum is the reference.
      const expected = ws.custom_price_id ? null : expectedProrationCents(pricing, from, split.immediate, periodStart, periodEnd, at, discount);
      if (expected != null) {
        const ok = Math.abs(expected - today.pre_tax_cents) <= Math.max(5, Math.round(expected * 0.005));
        prorationCheck = { expected_cents: expected, stripe_cents: today.pre_tax_cents, ok };
        if (!ok) log({ fn: "billing", workspace: ws.id, warn: "proration_mismatch", expected_cents: expected, stripe_cents: today.pre_tax_cents, from, to: split.immediate });
      }
    }
    const fq = split.final_quote;
    const custom = !!ws.custom_price_id;
    const nextAt = anchorNow ? addPeriod(new Date(at * 1000), pricing.periodById(split.immediate.period).months) : new Date(periodEnd * 1000);
    const finalTotal = pricing.rawTotal(split.final.plan, split.final.period, split.final.accounts) * 100;
    const { now, later } = describeSplit(pricing, split);
    const fx = await effectsFor(ws, from, split.final, keep);
    quote = {
      mode: "change", from, to: target, immediate: split.immediate, final: split.final, applies_now: split.applies_now, applies_at_renewal: split.applies_at_renewal,
      charge_today_cents: today.cents, tax_today_cents: today.tax_cents, lines: today.lines,
      proration_note: split.applies_now ? prorationNote(periodStart, periodEnd, at, anchorNow) : null,
      proration_date: at, anchor_now: anchorNow, proration_check: prorationCheck,
      per_account: custom ? null : pricing.perAccount(split.final.plan, split.final.period, split.final.accounts), months: pricing.periodById(split.final.period).months,
      next_invoice: { at: nextAt.toISOString(), cents: custom ? null : discountedCents(finalTotal, discount), list_cents: custom ? null : finalTotal },
      later_at: split.applies_at_renewal ? nextAt.toISOString() : null,
      now_changes: now, later_changes: later,
      best_price: fq.best_price && !custom ? { requested: fq.requested, billed: fq.billed, requested_total_cents: fq.requested_total * 100, billed_total_cents: fq.period_total * 100,
        note: `${fq.billed} accounts cost ${fq.requested_total === fq.period_total ? "the same as" : "less than"} ${fq.requested} (${formatUsd(fq.period_total * 100)} vs ${formatUsd(fq.requested_total * 100)}). You'll get ${fq.billed}.` } : null,
      early_supporter: discount > 0 ? { discount } : null,
      effects: fx.effects, senders_to_pause: fx.senders,
      resumes_subscription: !!ws.cancel_at_period_end, replaces_scheduled: !!ws.scheduled_change,
      price_version_change: !custom && split.final.plan !== from.plan && ws.price_version !== pricing.book.version ? { from: ws.price_version, to: pricing.book.version } : null,
      non_refundable: true,
    };
    fromState = { plan: from.plan, accounts_billed: from.accounts, billing_period: from.period };
    immediate = split.applies_now ? split.immediate : null;
    scheduled = split.applies_at_renewal ? split.final : null;
  }

  const { data, error } = await admin.from("outreach_billing_changes").insert({
    workspace_id: ws.id, requested_by: userId, kind: quote.mode === "checkout" ? "checkout" : "change", from_state: fromState,
    to_state: { plan: target.plan, accounts: target.accounts, billing_period: target.period }, immediate, scheduled, quote, keep_sender_ids: keep, status: "quoted", expires_at: expires,
  }).select("id").single();
  if (error) throw new HttpError(500, "E_INTERNAL", error.message);
  return { quote_id: data.id, expires_at: expires, quote };
}

async function loadQuote(ws: Row, quoteId: string, kind: "change" | "checkout"): Promise<Row> {
  const { data } = await admin.from("outreach_billing_changes").select("*").eq("id", quoteId ?? "").eq("workspace_id", ws.id).maybeSingle();
  if (!data || data.kind !== kind) throw new HttpError(409, "E_QUOTE_STALE", "This quote is no longer valid. Review the new amount.");
  if (data.status !== "quoted" || new Date(data.expires_at).getTime() < Date.now()) throw new HttpError(409, "E_QUOTE_STALE", "This quote has expired. Review the new amount.");
  return data;
}

async function finishChange(id: string, patch: Row): Promise<void> {
  const { error } = await admin.from("outreach_billing_changes").update(patch).eq("id", id);
  if (error) log({ fn: "billing", error: `billing change ${id} not updated: ${error.message}` });
}

// ---------------------------------------------------------------------------
// Checkout: the first subscription (PRD §5.1 "Subscribe", §10.1 `checkout`)
// ---------------------------------------------------------------------------
export async function createCheckout(ws: Row, quoteId: string, user: { id: string; email: string | null }): Promise<{ url: string }> {
  requireStripe();
  if (hasLiveSubscription(ws)) throw new HttpError(409, "E_ALREADY_SUBSCRIBED", "This workspace already has a subscription. Change the plan instead.");
  const row = await loadQuote(ws, quoteId, "checkout");
  const target: Target = { plan: row.to_state.plan, accounts: row.to_state.accounts, period: row.to_state.billing_period };
  const q = pricing.quote(target.plan, target.period, target.accounts);
  const price = await priceFor(q.plan, q.period);
  const coupon = couponOf(ws);
  const meta = { workspace_id: ws.id, accounts_requested: String(q.requested), price_version: pricing.book.version, billing_change_id: row.id };
  const params: Row = {
    mode: "subscription",
    line_items: [{ price: price.id, quantity: q.billed }],
    success_url: `${WEB_ORIGIN}/outreach/billing?checkout=success`,
    cancel_url: `${WEB_ORIGIN}/outreach/billing/change?checkout=cancel`,
    client_reference_id: ws.id,
    metadata: meta, subscription_data: { metadata: meta },
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    integration_identifier: "outreach_subscribe_wqkzbtmh",
    ...(coupon ? { discounts: [{ coupon }] } : {}),              // never promotion codes: the early-supporter coupon is ours to attach
    ...(TAX_ENABLED ? { automatic_tax: { enabled: true } } : {}),
    ...(ws.stripe_customer_id ? { customer: ws.stripe_customer_id, customer_update: { name: "auto", address: "auto" } } : user.email ? { customer_email: user.email } : {}),
  };
  const session = await stripe<any>("POST", "/checkout/sessions", params, { idempotencyKey: `co_${row.id}` });
  await finishChange(row.id, { quote: { ...row.quote, checkout_session_id: session.id } });
  await audit(ws.id, "billing.checkout_started", "workspace", ws.id, { plan: q.plan, accounts: q.billed, period: q.period, by: user.id }, "user");
  return { url: session.url };
}

/** Checkout finished (webhook): bind customer and subscription, mark the quote applied. */
export async function completeCheckout(wsId: string, session: any): Promise<void> {
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  const custId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (custId) await admin.from("outreach_workspaces").update({ stripe_customer_id: custId }).eq("id", wsId);
  if (subId) await syncWorkspaceFromStripe(wsId, subId);
  const changeId = session.metadata?.billing_change_id;
  if (changeId) await finishChange(changeId, { status: "applied", applied_at: new Date().toISOString(), stripe_invoice_id: typeof session.invoice === "string" ? session.invoice : session.invoice?.id ?? null });
}

// ---------------------------------------------------------------------------
// Change (PRD §4, §8.3, §8.4)
// ---------------------------------------------------------------------------
async function releaseSchedule(scheduleId: string | null | undefined): Promise<void> {
  if (!scheduleId) return;
  try { await stripe("POST", `/subscription_schedules/${encodeURIComponent(scheduleId)}/release`); }
  catch (e) {
    // already released / completed / gone: nothing to undo
    if (e instanceof StripeError && (e.code === "resource_missing" || /released|completed|canceled|not active/i.test(e.message))) return;
    throw e;
  }
}

/** Put a change on the subscription's renewal: a two-phase schedule that releases after the new period starts. */
async function scheduleAtRenewal(ws: Row, final: BillingState, requested: number, idem: string): Promise<string> {
  const { sub } = await fetchSubscription(ws.stripe_subscription_id);
  const item = sub.items.data[0];
  const custom = ws.custom_price_id && item.price?.id === ws.custom_price_id;
  const next = custom ? await priceById(ws.custom_price_id) : await priceFor(final.plan, final.period, final.plan === ws.plan ? ws.price_version : undefined);
  const sched = await stripe<any>("POST", "/subscription_schedules", { from_subscription: sub.id }, { idempotencyKey: `${idem}_s0` });
  const cur = sched.phases?.[0];
  const params = schedulePhases({
    currentPriceId: item.price.id, currentQuantity: item.quantity,
    phaseStart: cur?.start_date ?? item.current_period_start, phaseEnd: cur?.end_date ?? item.current_period_end,
    nextPriceId: next.id, nextQuantity: final.accounts, nextInterval: next.interval, nextIntervalCount: next.interval_count,
    coupon: couponOf(ws), accountsRequested: Math.min(requested, final.accounts), priceVersion: custom || final.plan === ws.plan ? ws.price_version : pricing.book.version,
  });
  try { await stripe("POST", `/subscription_schedules/${encodeURIComponent(sched.id)}`, params, { idempotencyKey: `${idem}_s1` }); }
  catch (e) { await releaseSchedule(sched.id).catch(() => null); throw e; }
  return String(sched.id);
}

/** The scheduled change Stripe held before this request, put back after a failed payment (PRD §4.2 "nothing changes"). */
async function restoreScheduled(ws: Row, prev: ScheduledChange | null, idem: string): Promise<void> {
  if (!prev || !prev.plan || !prev.billing_period) return;
  try { await scheduleAtRenewal(ws, { plan: prev.plan, period: prev.billing_period, accounts: prev.accounts_billed }, prev.accounts_requested ?? prev.accounts_billed, `${idem}_restore`); }
  catch (e) { log({ fn: "billing", workspace: ws.id, error: `scheduled change could not be restored: ${String((e as Error)?.message ?? e)}` }); }
}

export interface ChangeResult { status: "applied" | "scheduled" | "requires_action"; client_secret?: string | null; hosted_invoice_url?: string | null; charged_cents?: number; effective_at?: string | null }

/**
 * Apply a quoted change. What goes up is charged and applied now; what goes down is scheduled for renewal. If the payment
 * fails nothing changes; if it needs 3-D Secure the change waits (Stripe `pending_update`) and the client secret is returned.
 */
export async function applyChange(ws: Row, quoteId: string, keepIn: unknown, userId: string): Promise<ChangeResult> {
  requireStripe();
  if (!hasLiveSubscription(ws)) throw new HttpError(409, "E_NO_SUBSCRIPTION", "This workspace has no subscription yet. Subscribe first.");
  const row = await loadQuote(ws, quoteId, "change");
  const from = currentState(ws);
  const target: Target = { plan: row.to_state.plan, accounts: row.to_state.accounts, period: row.to_state.billing_period };
  // someone else changed the subscription since the quote (PRD #8)
  if (!from || from.plan !== row.from_state.plan || from.accounts !== row.from_state.accounts_billed || from.period !== row.from_state.billing_period) {
    throw new HttpError(409, "E_QUOTE_STALE", "The subscription changed since this quote. Review the new amount.");
  }
  const keep = cleanKeep(keepIn) ?? (row.keep_sender_ids as string[] | null) ?? null;
  // price it again with the same proration date: the charge must equal what was shown
  const fresh = await buildQuoteDry(ws, target, row.quote.proration_date);
  if (fresh.charge_today_cents !== row.quote.charge_today_cents) throw new HttpError(409, "E_QUOTE_STALE", "The amount changed since this quote. Review the new amount.");
  const split = fresh.split;
  const idem = `chg_${row.id}`;
  const prevScheduled = (ws.scheduled_change ?? null) as ScheduledChange | null;

  // any change resumes a subscription that was set to cancel, and replaces an earlier scheduled change (PRD §4.8)
  if (ws.cancel_at_period_end) await stripe("POST", `/subscriptions/${encodeURIComponent(ws.stripe_subscription_id)}`, { cancel_at_period_end: false }, { idempotencyKey: `${idem}_resume` });
  if (ws.stripe_schedule_id) await releaseSchedule(ws.stripe_schedule_id);

  let invoiceId: string | null = null, charged = 0;
  if (split.applies_now) {
    const { sub } = await fetchSubscription(ws.stripe_subscription_id);
    const item = sub.items.data[0];
    const custom = ws.custom_price_id && item.price?.id === ws.custom_price_id;
    const price = custom ? { id: ws.custom_price_id } : await priceFor(split.immediate.plan, split.immediate.period, split.immediate.plan === from.plan ? ws.price_version : undefined);
    let updated: any;
    try {
      updated = await stripe<any>("POST", `/subscriptions/${encodeURIComponent(sub.id)}`, immediateUpdateParams({
        itemId: item.id, priceId: price.id, quantity: split.immediate.accounts, prorationDate: row.quote.proration_date, anchorNow: split.up.period,
        accountsRequested: split.up.accounts ? Math.min(target.accounts, split.immediate.accounts) : Math.min(ws.accounts_requested ?? split.immediate.accounts, split.immediate.accounts),
        priceVersion: custom || split.immediate.plan === from.plan ? ws.price_version : pricing.book.version,
      }), { idempotencyKey: `${idem}_now` });
    } catch (e) {
      await restoreScheduled(ws, prevScheduled, idem);
      await syncWorkspaceFromStripe(ws.id).catch(() => null);
      const msg = e instanceof StripeError ? e.message : String((e as Error)?.message ?? e);
      await finishChange(row.id, { status: "failed", error: msg.slice(0, 500) });
      await audit(ws.id, "billing.change_failed", "workspace", ws.id, { change_id: row.id, error: msg, by: userId }, "user");
      if (e instanceof StripeError && e.isCard) throw new HttpError(402, "E_PAYMENT_FAILED", `${msg} Nothing was changed. Update your card and try again.`, { decline_code: e.declineCode });
      throw e;
    }
    const inv = updated.latest_invoice && typeof updated.latest_invoice === "object" ? updated.latest_invoice : null;
    invoiceId = inv?.id ?? (typeof updated.latest_invoice === "string" ? updated.latest_invoice : null);
    if (updated.pending_update) {
      // 3-D Secure: Stripe keeps the old items until the payment is confirmed (PRD #6). The scheduled half waits with it.
      const pending = { invoice_id: invoiceId, hosted_invoice_url: inv?.hosted_invoice_url ?? null, change_id: row.id, created_at: new Date().toISOString(),
        expires_at: new Date((updated.pending_update.expires_at ?? 0) * 1000).toISOString() };
      await admin.from("outreach_workspaces").update({ pending_payment: pending }).eq("id", ws.id);
      await finishChange(row.id, { status: "pending_payment", stripe_invoice_id: invoiceId, keep_sender_ids: keep, expires_at: pending.expires_at, quote: { ...row.quote, prev_scheduled: prevScheduled } });
      await audit(ws.id, "billing.change_pending_payment", "workspace", ws.id, { change_id: row.id, by: userId }, "user");
      return { status: "requires_action", client_secret: inv?.confirmation_secret?.client_secret ?? null, hosted_invoice_url: inv?.hosted_invoice_url ?? null };
    }
    charged = Number(inv?.amount_paid ?? inv?.amount_due ?? row.quote.charge_today_cents ?? 0);
    if (inv && Number(inv.amount_due ?? charged) !== row.quote.charge_today_cents) {
      log({ fn: "billing", workspace: ws.id, warn: "charged_amount_differs_from_quote", quoted: row.quote.charge_today_cents, invoiced: inv.amount_due, invoice: inv.id });
      await audit(ws.id, "billing.charge_differs_from_quote", "workspace", ws.id, { change_id: row.id, quoted_cents: row.quote.charge_today_cents, invoiced_cents: inv.amount_due, invoice: inv.id });
    }
    await syncWorkspaceFromStripe(ws.id);
  }

  let effectiveAt: string | null = null;
  if (split.applies_at_renewal) {
    const cur = await loadWorkspace(ws.id);
    try { await scheduleAtRenewal(cur, split.final, target.accounts, idem); }
    catch (e) {
      const msg = String((e as Error)?.message ?? e);
      await finishChange(row.id, { status: split.applies_now ? "applied" : "failed", error: `scheduling failed: ${msg}`.slice(0, 500), stripe_invoice_id: invoiceId, applied_at: split.applies_now ? new Date().toISOString() : null });
      if (!split.applies_now) await restoreScheduled(cur, prevScheduled, idem);
      await syncWorkspaceFromStripe(ws.id).catch(() => null);
      throw new HttpError(502, "E_SCHEDULE_FAILED", split.applies_now ? "The part that applies now went through, but the change for your next renewal could not be scheduled. Try that part again." : "The change could not be scheduled. Nothing was changed.");
    }
    // the keep list lives with us (Stripe has no place for it): the sync below carries it into scheduled_change
    if (keep) await admin.from("outreach_workspaces").update({ scheduled_change: { plan: split.final.plan, accounts_billed: split.final.accounts, billing_period: split.final.period, keep_sender_ids: keep } }).eq("id", ws.id);
    const synced = await syncWorkspaceFromStripe(ws.id);
    effectiveAt = synced.state?.scheduled_change?.effective_at ?? cur.current_period_end ?? null;
  }
  await finishChange(row.id, { status: split.applies_now ? "applied" : "scheduled", applied_at: new Date().toISOString(), stripe_invoice_id: invoiceId, keep_sender_ids: keep });
  await audit(ws.id, "billing.changed", "workspace", ws.id, { change_id: row.id, from, immediate: split.applies_now ? split.immediate : null, scheduled: split.applies_at_renewal ? split.final : null, charged_cents: charged, by: userId }, "user");
  return { status: split.applies_now ? "applied" : "scheduled", charged_cents: charged, effective_at: effectiveAt };
}

/** Quote arithmetic without writing a row (used to re-check a quote at confirmation). */
async function buildQuoteDry(ws: Row, target: Target, prorationDate: number): Promise<{ charge_today_cents: number; split: ChangeSplit }> {
  const from = currentState(ws)!;
  const split = pricing.splitChange(from, target, ws.custom_price_id ? CUSTOM_MAX_ACCOUNTS : pricing.book.max_self_serve_accounts);
  if (split.blocked) throw new HttpError(409, split.blocked.code, split.blocked.message);
  assertChangeAllowed(ws, split);
  if (!split.applies_now) return { charge_today_cents: 0, split };
  const periodEnd = Math.floor(new Date(ws.current_period_end).getTime() / 1000);
  if (prorationDate >= periodEnd) throw new HttpError(409, "E_QUOTE_STALE", "The billing period renewed since this quote. Review the new amount.");
  const { sub } = await fetchSubscription(ws.stripe_subscription_id);
  const item = sub.items.data[0];
  const price = ws.custom_price_id && item.price?.id === ws.custom_price_id ? { id: ws.custom_price_id } : await priceFor(split.immediate.plan, split.immediate.period, split.immediate.plan === from.plan ? ws.price_version : undefined);
  const preview = await stripe<any>("POST", "/invoices/create_preview", previewParams({ subscriptionId: sub.id, itemId: item.id, priceId: price.id, quantity: split.immediate.accounts, prorationDate, anchorNow: split.up.period }));
  return { charge_today_cents: chargeTodayFromPreview(preview, { anchorReset: split.up.period, periodEnd }).cents, split };
}

/**
 * A change that waited for 3-D Secure has been paid (webhook: the subscription no longer has a pending update and carries
 * the new items) or has lapsed. Finish it: schedule its renewal half, or put the earlier scheduled change back.
 */
export async function settlePendingChange(wsId: string): Promise<void> {
  const ws = await loadWorkspace(wsId);
  const { data: rows } = await admin.from("outreach_billing_changes").select("*").eq("workspace_id", wsId).eq("status", "pending_payment").order("created_at", { ascending: false }).limit(5);
  for (const row of rows ?? []) {
    const want = row.immediate as BillingState | null;
    const applied = !!want && ws.plan === want.plan && ws.accounts_billed === want.accounts && ws.billing_period === want.period;
    if (applied) {
      const final = row.scheduled as BillingState | null;
      if (final) {
        try {
          await scheduleAtRenewal(ws, final, Number(row.to_state?.accounts ?? final.accounts), `chg_${row.id}`);
          if (row.keep_sender_ids?.length) await admin.from("outreach_workspaces").update({ scheduled_change: { plan: final.plan, accounts_billed: final.accounts, billing_period: final.period, keep_sender_ids: row.keep_sender_ids } }).eq("id", wsId);
          await syncWorkspaceFromStripe(wsId);
        } catch (e) { log({ fn: "billing", workspace: wsId, error: `renewal half of change ${row.id} not scheduled: ${String((e as Error)?.message ?? e)}` }); }
      }
      await finishChange(row.id, { status: "applied", applied_at: new Date().toISOString() });
      await audit(wsId, "billing.changed", "workspace", wsId, { change_id: row.id, immediate: want, scheduled: final, after: "payment_confirmed" });
    } else if (!ws.pending_payment) {
      await finishChange(row.id, { status: "failed", error: "payment was not completed" });
      // the change replaced an earlier scheduled change when it was confirmed: that one comes back
      if (!ws.stripe_schedule_id) await restoreScheduled(ws, (row.quote?.prev_scheduled ?? null) as ScheduledChange | null, `chg_${row.id}`);
      await audit(wsId, "billing.change_abandoned", "workspace", wsId, { change_id: row.id });
    }
  }
}

/** Give up a change that is waiting for 3-D Secure: voiding its invoice drops the pending update (PRD §4.8 last row). */
export async function abandonPendingPayment(ws: Row, userId: string): Promise<void> {
  requireStripe();
  const invoiceId = ws.pending_payment?.invoice_id;
  if (!invoiceId) throw new HttpError(409, "E_NO_PENDING_PAYMENT", "There is no payment waiting.");
  try { await stripe("POST", `/invoices/${encodeURIComponent(invoiceId)}/void`); }
  catch (e) { if (!(e instanceof StripeError && /void|paid|status/i.test(e.message))) throw e; }
  await admin.from("outreach_workspaces").update({ pending_payment: null }).eq("id", ws.id);
  await syncWorkspaceFromStripe(ws.id);
  await settlePendingChange(ws.id);
  await audit(ws.id, "billing.pending_payment_abandoned", "workspace", ws.id, { invoice: invoiceId, by: userId }, "user");
}

// ---------------------------------------------------------------------------
// Scheduled change, cancel, resume, portal, pay now
// ---------------------------------------------------------------------------
export async function cancelScheduledChange(ws: Row, userId: string): Promise<void> {
  requireStripe();
  if (!ws.stripe_schedule_id) throw new HttpError(409, "E_NO_SCHEDULED_CHANGE", "There is no scheduled change.");
  await releaseSchedule(ws.stripe_schedule_id);
  await syncWorkspaceFromStripe(ws.id);
  await admin.from("outreach_billing_changes").insert({ workspace_id: ws.id, requested_by: userId, kind: "cancel_scheduled", from_state: { plan: ws.plan, accounts_billed: ws.accounts_billed, billing_period: ws.billing_period },
    to_state: { plan: ws.plan, accounts_billed: ws.accounts_billed, billing_period: ws.billing_period }, scheduled: ws.scheduled_change, quote: { charge_today_cents: 0 }, status: "cancelled", applied_at: new Date().toISOString() });
  await audit(ws.id, "billing.scheduled_change_cancelled", "workspace", ws.id, { was: ws.scheduled_change, by: userId }, "user");
}

export const CANCEL_REASONS = ["too_expensive", "missing_feature", "switched_tool", "not_using", "technical_issues", "temporary", "other"] as const;

/** Cancel at the end of the paid period; full access until then, no refund (PRD §4.7). */
export async function cancelSubscription(ws: Row, reason: string, comment: string, userId: string): Promise<{ access_until: string | null }> {
  requireStripe();
  if (!hasLiveSubscription(ws)) throw new HttpError(409, "E_NO_SUBSCRIPTION", "This workspace has no subscription to cancel.");
  if (!(CANCEL_REASONS as readonly string[]).includes(reason)) throw new HttpError(400, "E_PAYLOAD_INVALID", "Choose a reason.");
  // a scheduled downgrade is moot once the subscription ends, and a schedule would keep the subscription alive
  if (ws.stripe_schedule_id) await releaseSchedule(ws.stripe_schedule_id);
  await stripe("POST", `/subscriptions/${encodeURIComponent(ws.stripe_subscription_id)}`, { cancel_at_period_end: true });
  await syncWorkspaceFromStripe(ws.id);
  const state = { plan: ws.plan, accounts_billed: ws.accounts_billed, billing_period: ws.billing_period };
  await admin.from("outreach_billing_changes").insert({ workspace_id: ws.id, requested_by: userId, kind: "cancel", from_state: state, to_state: { ...state, cancel: true },
    quote: { charge_today_cents: 0, reason, comment: String(comment ?? "").slice(0, 2000), access_until: ws.current_period_end }, status: "scheduled", applied_at: new Date().toISOString() });
  await audit(ws.id, "billing.cancel_scheduled", "workspace", ws.id, { reason, comment: String(comment ?? "").slice(0, 2000), access_until: ws.current_period_end, by: userId }, "user");
  return { access_until: ws.current_period_end ?? null };
}

/** Undo a cancellation before the period ends: everything continues, the early-supporter price included. */
export async function resumeSubscription(ws: Row, userId: string): Promise<void> {
  requireStripe();
  if (!hasLiveSubscription(ws) || !ws.cancel_at_period_end) throw new HttpError(409, "E_NOT_CANCELLING", "This subscription is not set to cancel.");
  await stripe("POST", `/subscriptions/${encodeURIComponent(ws.stripe_subscription_id)}`, { cancel_at_period_end: false });
  await syncWorkspaceFromStripe(ws.id);
  const state = { plan: ws.plan, accounts_billed: ws.accounts_billed, billing_period: ws.billing_period };
  await admin.from("outreach_billing_changes").insert({ workspace_id: ws.id, requested_by: userId, kind: "resume", from_state: { ...state, cancel: true }, to_state: state, quote: { charge_today_cents: 0 }, status: "applied", applied_at: new Date().toISOString() });
  await audit(ws.id, "billing.cancel_undone", "workspace", ws.id, { by: userId }, "user");
}

/** Customer portal: payment methods, invoices, billing address and tax IDs only (PRD §8.5). */
export async function portalSession(ws: Row): Promise<{ url: string }> {
  requireStripe();
  if (!ws.stripe_customer_id) throw new HttpError(409, "E_NO_CUSTOMER", "There is no billing account yet. Subscribe first.");
  const s = await stripe<any>("POST", "/billing_portal/sessions", { customer: ws.stripe_customer_id, return_url: `${WEB_ORIGIN}/outreach/billing`, ...(PORTAL_CONFIGURATION ? { configuration: PORTAL_CONFIGURATION } : {}) });
  return { url: s.url };
}

/** The page where the open invoice can be paid (past due, or a payment that needs confirming). */
export async function payNowUrl(ws: Row): Promise<{ url: string | null; amount_due_cents: number | null }> {
  requireStripe();
  if (!ws.stripe_subscription_id) throw new HttpError(409, "E_NO_SUBSCRIPTION", "This workspace has no subscription.");
  const sub = await stripe<any>("GET", `/subscriptions/${encodeURIComponent(ws.stripe_subscription_id)}`, { expand: ["latest_invoice"] });
  const inv = sub.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
  if (inv && inv.status === "open" && inv.hosted_invoice_url) return { url: inv.hosted_invoice_url, amount_due_cents: inv.amount_remaining ?? inv.amount_due ?? null };
  const open = ws.stripe_customer_id ? await stripeList<any>("/invoices", { customer: ws.stripe_customer_id, status: "open" }, 1) : [];
  const first = open.find((i) => i.hosted_invoice_url);
  return { url: first?.hosted_invoice_url ?? null, amount_due_cents: first?.amount_remaining ?? null };
}

// ---------------------------------------------------------------------------
// Webhook helpers: which workspace an event is about (object graph first, metadata only as a fallback)
// ---------------------------------------------------------------------------
async function workspaceBy(col: "stripe_subscription_id" | "stripe_customer_id", value: string | null | undefined): Promise<Row | null> {
  if (!value) return null;
  const { data } = await admin.from("outreach_workspaces").select("*").eq(col, value).is("deleted_at", null).order("created_at", { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

const strId = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" ? ((v as { id?: string }).id ?? null) : null);

/** The subscription an invoice belongs to (2026 API: under invoice.parent). */
export function subscriptionOfInvoice(inv: any): string | null {
  return strId(inv?.parent?.subscription_details?.subscription) ?? strId(inv?.subscription) ?? null;
}

export async function resolveEventWorkspace(event: any): Promise<{ ws: Row | null; subscriptionId: string | null }> {
  const obj = event?.data?.object ?? {};
  const type = String(event?.type ?? "");
  let subId: string | null = null, custId: string | null = strId(obj.customer), metaWs: string | null = obj.metadata?.workspace_id ?? null;
  if (type.startsWith("customer.subscription.")) subId = strId(obj.id);
  else if (type.startsWith("subscription_schedule.")) subId = strId(obj.subscription) ?? strId(obj.released_subscription);
  else if (type.startsWith("invoice.")) { subId = subscriptionOfInvoice(obj); metaWs = obj.parent?.subscription_details?.metadata?.workspace_id ?? metaWs; }
  else if (type === "checkout.session.completed") { subId = strId(obj.subscription); metaWs = obj.client_reference_id ?? metaWs; }
  else if (type.startsWith("charge.dispute.")) {
    // dispute → payment intent → invoice → subscription
    const pi = strId(obj.payment_intent);
    if (pi && stripeConfigured()) {
      try {
        const pays = await stripe<any>("GET", "/invoice_payments", { payment: { type: "payment_intent", payment_intent: pi }, limit: 1 });
        const invId = strId(pays?.data?.[0]?.invoice);
        if (invId) { const inv = await stripe<any>("GET", `/invoices/${encodeURIComponent(invId)}`); subId = subscriptionOfInvoice(inv); custId = strId(inv.customer) ?? custId; }
      } catch (e) { log({ fn: "billing", warn: "dispute invoice lookup failed", error: String((e as Error)?.message ?? e) }); }
    }
    if (!subId && !custId && strId(obj.charge) && stripeConfigured()) {
      try { const ch = await stripe<any>("GET", `/charges/${encodeURIComponent(strId(obj.charge)!)}`); custId = strId(ch.customer); } catch { /* fall through */ }
    }
  }
  let ws = await workspaceBy("stripe_subscription_id", subId);
  if (!ws) ws = await workspaceBy("stripe_customer_id", custId);
  if (!ws && metaWs && /^[0-9a-f-]{36}$/i.test(metaWs)) {
    const { data } = await admin.from("outreach_workspaces").select("*").eq("id", metaWs).maybeSingle();
    ws = data ?? null;
  }
  return { ws, subscriptionId: subId };
}
