// Billing rules that need no network and no database (pricing-billing-PRD §4, §8, §10.2): how a Stripe subscription maps to
// workspace state, what a change sends to Stripe, and how much of a previewed invoice is charged today. The I/O around these
// lives in billing.ts; these are unit-tested in billing_core_test.ts.
import type { BillingPeriod, BillingState, ChangeSplit, PlanId, Pricing } from "./pricing_core.ts";
import { discountedCents } from "./pricing_core.ts";

export interface DerivedSubscription {
  subscription_id: string;
  customer_id: string | null;
  status: string;
  plan: PlanId | null;
  billing_period: BillingPeriod | null;
  accounts_billed: number | null;
  accounts_requested: number | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  schedule_id: string | null;
  scheduled_change: ScheduledChange | null;
  price_version: string | null;
  custom_price_id: string | null;
  pending_payment: PendingPayment | null;
}
export interface ScheduledChange { plan: PlanId | null; accounts_billed: number; accounts_requested?: number; billing_period: BillingPeriod | null; effective_at: string | null; keep_sender_ids?: string[] }
export interface PendingPayment { invoice_id: string | null; hosted_invoice_url: string | null; expires_at: string | null; change_id?: string | null }

const iso = (ts: unknown): string | null => (typeof ts === "number" && ts > 0 ? new Date(ts * 1000).toISOString() : null);
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" ? String((v as { id?: string }).id ?? "") || null : null);

/** Plan and period of a Stripe price: ours by lookup key, or the workspace's custom Enterprise price. */
export function planOfPrice(pricing: Pricing, price: any, customPriceId: string | null): { plan: PlanId | null; period: BillingPeriod | null; version: string | null; custom: boolean } {
  const parsed = pricing.parseLookupKey(price?.lookup_key);
  const period = pricing.periodOfInterval(price?.recurring?.interval, price?.recurring?.interval_count);
  if (parsed) return { plan: parsed.plan, period: parsed.period, version: parsed.version, custom: false };
  if (customPriceId && price?.id === customPriceId) return { plan: "enterprise", period, version: null, custom: true };
  return { plan: null, period, version: null, custom: false };
}

/**
 * What the workspace should look like for a live Stripe subscription (the webhook and every billing action end here).
 * `schedule` is the subscription's schedule with phases.items.price expanded, when it has one.
 * `prev` carries what Stripe does not know: the customer's keep list for a scheduled decrease.
 */
export function deriveSubscriptionState(pricing: Pricing, sub: any, schedule: any | null, ctx: { customPriceId?: string | null; prevScheduled?: ScheduledChange | null } = {}): DerivedSubscription {
  const item = sub?.items?.data?.[0] ?? null;
  const price = item?.price ?? null;
  const p = planOfPrice(pricing, price, ctx.customPriceId ?? null);
  const qty = typeof item?.quantity === "number" ? item.quantity : null;
  const reqRaw = Number(sub?.metadata?.accounts_requested);
  const requested = qty != null && Number.isInteger(reqRaw) && reqRaw >= 1 && reqRaw <= qty ? reqRaw : qty;
  const periodStart = item?.current_period_start ?? sub?.current_period_start ?? null;
  const periodEnd = item?.current_period_end ?? sub?.current_period_end ?? null;

  let scheduled: ScheduledChange | null = null;
  const scheduleLive = schedule && ["active", "not_started"].includes(String(schedule.status ?? ""));
  if (scheduleLive) {
    const curEnd = schedule.current_phase?.end_date ?? periodEnd;
    const next = (schedule.phases ?? []).find((ph: any) => typeof ph.start_date === "number" && curEnd != null && ph.start_date >= curEnd);
    const ni = next?.items?.[0];
    if (ni) {
      const nprice = typeof ni.price === "object" ? ni.price : { id: ni.price };
      const np = planOfPrice(pricing, nprice, ctx.customPriceId ?? null);
      const nqty = typeof ni.quantity === "number" ? ni.quantity : qty ?? 1;
      const samePrice = idOf(ni.price) === price?.id;
      if (!samePrice || nqty !== qty) {
        const nreq = Number(next?.metadata?.accounts_requested);
        scheduled = {
          plan: np.plan ?? (samePrice ? p.plan : null), accounts_billed: nqty, billing_period: np.period ?? (samePrice ? p.period : null), effective_at: iso(next.start_date),
          ...(Number.isInteger(nreq) && nreq >= 1 && nreq <= nqty ? { accounts_requested: nreq } : {}),
        };
        const prev = ctx.prevScheduled;
        if (prev?.keep_sender_ids?.length && prev.accounts_billed === scheduled.accounts_billed && prev.plan === scheduled.plan && prev.billing_period === scheduled.billing_period) {
          scheduled.keep_sender_ids = prev.keep_sender_ids;
        }
      }
    }
  }

  const inv = sub?.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
  const pending: PendingPayment | null = sub?.pending_update
    ? { invoice_id: idOf(sub.latest_invoice), hosted_invoice_url: inv?.hosted_invoice_url ?? null, expires_at: iso(sub.pending_update.expires_at) }
    : null;

  return {
    subscription_id: String(sub.id), customer_id: idOf(sub.customer), status: String(sub.status ?? ""),
    plan: p.plan, billing_period: p.period, accounts_billed: qty, accounts_requested: requested,
    current_period_start: iso(periodStart), current_period_end: iso(periodEnd),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    schedule_id: scheduleLive ? String(schedule.id) : null, scheduled_change: scheduled,
    price_version: p.version, custom_price_id: p.custom ? String(price.id) : null, pending_payment: pending,
  };
}

/** A previewed or real invoice line is a proration (2026 API: the flag sits under `parent`, by parent type). */
export function isProrationLine(line: any): boolean {
  const p = line?.parent ?? {};
  return !!(p.subscription_item_details?.proration ?? p.invoice_item_details?.proration ?? line?.proration ?? false);
}

export interface TodayCharge { cents: number; tax_cents: number; pre_tax_cents: number; lines: Array<{ description: string; amount_cents: number; proration: boolean }>; includes_renewal: boolean }

/**
 * What a previewed change charges today. When the billing period restarts (monthly → annual) the whole preview is today's
 * invoice. Otherwise today's invoice holds only the prorations; if Stripe's preview also carries the next renewal (lines
 * that start at the period end), those are left out.
 */
export function chargeTodayFromPreview(preview: any, opts: { anchorReset: boolean; periodEnd: number | null }): TodayCharge {
  const all: any[] = preview?.lines?.data ?? [];
  const taxOf = (l: any) => (l.taxes ?? []).filter((t: any) => t.tax_behavior !== "inclusive").reduce((s: number, t: any) => s + (t.amount ?? 0), 0);
  const discOf = (l: any) => (l.discount_amounts ?? []).reduce((s: number, d: any) => s + (d.amount ?? 0), 0);
  const toLine = (l: any) => ({ description: String(l.description ?? ""), amount_cents: Number(l.amount ?? 0), proration: isProrationLine(l) });
  const totalTax = (preview?.total_taxes ?? []).filter((t: any) => t.tax_behavior !== "inclusive").reduce((s: number, t: any) => s + (t.amount ?? 0), 0);
  const renewal = opts.anchorReset || opts.periodEnd == null ? [] : all.filter((l) => !isProrationLine(l) && typeof l.period?.start === "number" && l.period.start >= opts.periodEnd! - 60);
  if (opts.anchorReset || renewal.length === 0) {
    const due = Math.max(Number(preview?.amount_due ?? preview?.total ?? 0), 0);
    return { cents: due, tax_cents: totalTax, pre_tax_cents: Math.max(due - totalTax, 0), lines: all.map(toLine), includes_renewal: false };
  }
  const today = all.filter((l) => !renewal.includes(l));
  const pre = today.reduce((s, l) => s + Number(l.amount ?? 0) - discOf(l), 0);
  const tax = today.reduce((s, l) => s + taxOf(l), 0);
  return { cents: Math.max(pre + tax, 0), tax_cents: Math.max(tax, 0), pre_tax_cents: Math.max(pre, 0), lines: today.map(toLine), includes_renewal: true };
}

/**
 * What a change should charge today by the PRD's own sums, after the forever discount, before tax:
 *   same billing period (§4.2, §4.4): (new period total − current period total) × time left in the period
 *   longer billing period (§4.6):     the new period in full − the unused part of the current period
 */
export function expectedProrationCents(pricing: Pricing, from: BillingState, to: BillingState, periodStart: number, periodEnd: number, at: number, discount: number): number | null {
  if (!(periodEnd > periodStart)) return null;
  const left = Math.min(Math.max((periodEnd - at) / (periodEnd - periodStart), 0), 1);
  const oldTotal = discountedCents(pricing.rawTotal(from.plan, from.period, from.accounts) * 100, discount);
  const newTotal = discountedCents(pricing.rawTotal(to.plan, to.period, to.accounts) * 100, discount);
  if (from.period !== to.period) return Math.round(newTotal - oldTotal * left);
  return Math.round((newTotal - oldTotal) * left);
}

/** Parameters of the immediate subscription update (PRD §8.3). Nothing changes on Stripe's side unless the payment succeeds. */
export function immediateUpdateParams(args: { itemId: string; priceId: string; quantity: number; prorationDate: number; anchorNow: boolean; accountsRequested: number; priceVersion: string }): Record<string, unknown> {
  return {
    items: [{ id: args.itemId, price: args.priceId, quantity: args.quantity }],
    proration_behavior: "always_invoice",
    payment_behavior: "pending_if_incomplete",
    proration_date: args.prorationDate,
    ...(args.anchorNow ? { billing_cycle_anchor: "now" } : {}),
    metadata: { accounts_requested: String(args.accountsRequested), price_version: args.priceVersion },
    expand: ["latest_invoice.confirmation_secret"],
  };
}

/** The same change as an invoice preview (PRD §4.9: the quote is Stripe's own preview of the change). */
export function previewParams(args: { subscriptionId: string; itemId: string; priceId: string; quantity: number; prorationDate: number; anchorNow: boolean }): Record<string, unknown> {
  return {
    subscription: args.subscriptionId,
    subscription_details: {
      items: [{ id: args.itemId, price: args.priceId, quantity: args.quantity }],
      proration_behavior: "always_invoice",
      proration_date: args.prorationDate,
      ...(args.anchorNow ? { billing_cycle_anchor: "now" } : {}),
    },
  };
}

/**
 * Phases of the schedule that carries a change to renewal (PRD §8.4): phase 1 = what the subscription has now, until the
 * end of the current period; phase 2 = the new plan / count / period, for one period, then the schedule releases and the
 * subscription simply continues on phase 2's items. Every phase repeats the discount, or Stripe would drop it.
 */
export function schedulePhases(args: {
  currentPriceId: string; currentQuantity: number; phaseStart: number; phaseEnd: number;
  nextPriceId: string; nextQuantity: number; nextInterval: "month" | "year"; nextIntervalCount: number;
  coupon: string | null; accountsRequested: number; priceVersion: string;
}): Record<string, unknown> {
  const discounts = args.coupon ? [{ coupon: args.coupon }] : undefined;
  return {
    end_behavior: "release",
    phases: [
      { items: [{ price: args.currentPriceId, quantity: args.currentQuantity }], start_date: args.phaseStart, end_date: args.phaseEnd, ...(discounts ? { discounts } : {}) },
      {
        items: [{ price: args.nextPriceId, quantity: args.nextQuantity }],
        duration: { interval: args.nextInterval, interval_count: args.nextIntervalCount },
        proration_behavior: "none", billing_cycle_anchor: "phase_start",
        metadata: { accounts_requested: String(args.accountsRequested), price_version: args.priceVersion },
        ...(discounts ? { discounts } : {}),
      },
    ],
  };
}

const s = (n: number) => (n === 1 ? "" : "s");

/** Plain lines for the quote: what changes now and what changes at renewal. */
export function describeSplit(pricing: Pricing, split: ChangeSplit): { now: string[]; later: string[] } {
  const now: string[] = [], later: string[] = [];
  const { from, immediate, final } = split;
  if (immediate.plan !== from.plan) now.push(`${pricing.planById(immediate.plan).name} plan (was ${pricing.planById(from.plan).name})`);
  if (immediate.accounts !== from.accounts) now.push(`${immediate.accounts} account${s(immediate.accounts)} (was ${from.accounts})`);
  if (immediate.period !== from.period) now.push(`${pricing.periodById(immediate.period).label} billing (was ${pricing.periodById(from.period).label.toLowerCase()}); a new ${pricing.periodById(immediate.period).label.toLowerCase()} period starts today`);
  if (final.plan !== immediate.plan) later.push(`${pricing.planById(final.plan).name} plan (${pricing.planById(immediate.plan).name} until then)`);
  if (final.accounts !== immediate.accounts) later.push(`${final.accounts} account${s(final.accounts)} (${immediate.accounts} until then)`);
  if (final.period !== immediate.period) later.push(`${pricing.periodById(final.period).label} billing (${pricing.periodById(immediate.period).label.toLowerCase()} until then)`);
  return { now, later };
}

/** One line under "Charged today" explaining the proration. */
export function prorationNote(periodStart: number, periodEnd: number, at: number, anchorReset: boolean): string {
  const day = 86400;
  const left = Math.max(Math.round((periodEnd - at) / day), 0), total = Math.max(Math.round((periodEnd - periodStart) / day), 1);
  if (anchorReset) return `The ${left} unused day${s(left)} of your current period are credited, and the new period is charged in full today.`;
  if (left <= 0) return "Charged for the rest of today; the full new price applies from your next invoice.";
  return `You pay the difference for the ${left} of ${total} days left in this billing period.`;
}

/** Add one billing period to a date (the next invoice date after a period change that restarts the cycle). */
export function addPeriod(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}
