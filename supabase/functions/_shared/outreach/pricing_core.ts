// Price book rules (pricing-billing-PRD §1, §2, §4.1). No imports on purpose: the web app (lib/outreach/pricing.ts), the edge
// functions (./pricing.ts) and the Stripe setup script all run this one file over pricing/v1.json, so they cannot drift.
// The SQL twin is outreach_quote_accounts() (migrations/outreach/058); both are tested against the same PRD tables.

export type PlanId = "launch" | "scale" | "enterprise";
export type BillingPeriod = "monthly" | "quarterly" | "annual";

export interface PriceBookPeriod { id: BillingPeriod; label: string; months: number; discount: number; interval: "month" | "year"; interval_count: number }
export interface PriceBookPlan { id: PlanId; name: string; rank: number; for: string; highlights: string[]; prices: Record<BillingPeriod, number[]> }
export interface PriceBookFeature { key: string; label: string; launch: boolean; scale: boolean; enterprise: boolean; limits?: Record<PlanId, number | null>; limit_unit?: string }
export interface PriceBookTier { tier: number; spots: number; discount: number; coupon: string }
export interface PriceBook {
  version: string; currency: string; steps: number[]; max_self_serve_accounts: number;
  periods: PriceBookPeriod[]; plans: PriceBookPlan[]; features: PriceBookFeature[];
  trial: { days: number; accounts: number; features_of: PlanId; data_kept_days: number };
  cancellation: { data_kept_days: number; warn_days_before_deletion: number[] };
  past_due: { reminder_day: number; suspend_day: number };
  hygiene: { disconnect_billing_paused_after_days: number; swap_alert_per_month: number };
  early_supporter: { tiers: PriceBookTier[] };
}

/** What a number of accounts costs on a plan and billing period, after the best-price rule. Money is whole US dollars. */
export interface AccountQuote {
  plan: PlanId; period: BillingPeriod;
  /** the number the customer asked for */
  requested: number;
  /** the number on the subscription = the connection limit (a bigger step when that step costs the same or less) */
  billed: number;
  /** monthly-equivalent price of one account at the billed count */
  per_account: number;
  months: number;
  /** one invoice for the whole period: per_account × billed × months */
  period_total: number;
  /** what the requested count would have cost without the best-price rule */
  requested_total: number;
  best_price: boolean;
  lookup_key: string;
}

export interface BillingState { plan: PlanId; accounts: number; period: BillingPeriod }

/** A requested change split into the part that applies now and the part that waits for renewal (PRD §4.1). */
export interface ChangeSplit {
  from: BillingState;
  /** state right after the immediate part (equals `from` when nothing applies now) */
  immediate: BillingState;
  /** state from the next renewal on */
  final: BillingState;
  applies_now: boolean;
  applies_at_renewal: boolean;
  up: { plan: boolean; accounts: boolean; period: boolean };
  down: { plan: boolean; accounts: boolean; period: boolean };
  /** quote of the requested count on the final plan and period (carries the best-price note) */
  final_quote: AccountQuote;
  /** set when the request cannot go ahead */
  blocked: null | { code: "E_NO_CHANGE" | "E_DECREASE_COSTS_MORE" | "E_TALK_TO_US" | "E_PAYLOAD_INVALID"; message: string };
}

export function makePricing(book: PriceBook) {
  const steps = [...book.steps].sort((a, b) => a - b);
  const planIds = book.plans.map((p) => p.id);
  const periodIds = book.periods.map((p) => p.id);
  const planById = (id: string): PriceBookPlan => { const p = book.plans.find((x) => x.id === id); if (!p) throw new Error(`unknown plan ${id}`); return p; };
  const periodById = (id: string): PriceBookPeriod => { const p = book.periods.find((x) => x.id === id); if (!p) throw new Error(`unknown billing period ${id}`); return p; };
  const isPlan = (v: unknown): v is PlanId => typeof v === "string" && (planIds as string[]).includes(v);
  const isPeriod = (v: unknown): v is BillingPeriod => typeof v === "string" && (periodIds as string[]).includes(v);
  const planRank = (id: string): number => planById(id).rank;
  const periodRank = (id: string): number => periodById(id).months;

  /** Index of the step that prices a count: the last step at or below it. */
  const stepIndex = (n: number): number => { let i = -1; for (let k = 0; k < steps.length; k++) if (n >= steps[k]) i = k; return i; };
  /** Monthly-equivalent list price of one account at a count (every account pays the step's price). */
  function perAccount(plan: PlanId, period: BillingPeriod, n: number): number {
    const i = stepIndex(n);
    if (i < 0) throw new Error("at least one account");
    return planById(plan).prices[period][i];
  }
  const lookupKey = (plan: PlanId, period: BillingPeriod, version = book.version): string => `${plan}_${period}_${version}`;
  /** Cost of exactly n accounts for one period, before the best-price rule. */
  const rawTotal = (plan: PlanId, period: BillingPeriod, n: number): number => perAccount(plan, period, n) * n * periodById(period).months;

  /** Best price (PRD §2): if a bigger step costs the same or less, the customer gets the bigger step at its price. */
  function quote(plan: PlanId, period: BillingPeriod, accounts: number): AccountQuote {
    if (!Number.isInteger(accounts) || accounts < 1) throw new Error("accounts must be a whole number of 1 or more");
    const months = periodById(period).months;
    const requestedTotal = rawTotal(plan, period, accounts);
    let billed = accounts, total = requestedTotal;
    for (const s of steps) {
      if (s <= accounts) continue;
      const t = rawTotal(plan, period, s);
      if (t <= total) { billed = s; total = t; }
    }
    return {
      plan, period, requested: accounts, billed, per_account: perAccount(plan, period, billed), months,
      period_total: total, requested_total: requestedTotal, best_price: billed !== accounts, lookup_key: lookupKey(plan, period),
    };
  }

  /** Stripe volume tiers for one plan × period: up to 4 / 9 / 19 / 49 / 99 / ∞, unit amount in cents for the whole period. */
  function stripeTiers(plan: PlanId, period: BillingPeriod): Array<{ up_to: number | "inf"; unit_amount: number }> {
    const months = periodById(period).months;
    return steps.map((_s, i) => ({ up_to: i + 1 < steps.length ? steps[i + 1] - 1 : "inf" as const, unit_amount: planById(plan).prices[period][i] * months * 100 }));
  }

  /** Plan and period of one of our price lookup keys ("scale_annual_v1"), or null for anything else. */
  function parseLookupKey(key: string | null | undefined): { plan: PlanId; period: BillingPeriod; version: string } | null {
    const m = /^([a-z]+)_([a-z]+)_(v\d+)$/.exec(String(key ?? ""));
    if (!m || !isPlan(m[1]) || !isPeriod(m[2])) return null;
    return { plan: m[1], period: m[2], version: m[3] };
  }

  /** Billing period of a Stripe recurring interval. */
  function periodOfInterval(interval: string | null | undefined, count: number | null | undefined): BillingPeriod | null {
    const p = book.periods.find((x) => x.interval === interval && x.interval_count === (count ?? 1));
    return p ? p.id : null;
  }

  /** Early-supporter tier for a sign-up position (1-based), or null once every tier is taken. */
  function earlySupporterTier(position: number): PriceBookTier | null {
    let start = 0;
    for (const t of book.early_supporter.tiers) { if (position > start && position <= start + t.spots) return t; start += t.spots; }
    return null;
  }
  const couponForDiscount = (discount: number): string | null => book.early_supporter.tiers.find((t) => Math.abs(t.discount - discount) < 1e-9)?.coupon ?? null;

  /** Is a feature part of a plan, and its limit (null = no limit / not a counted feature). */
  function feature(plan: PlanId, key: string): { enabled: boolean; limit: number | null } {
    const f = book.features.find((x) => x.key === key);
    if (!f) return { enabled: true, limit: null };
    return { enabled: !!f[plan], limit: f.limits ? f.limits[plan] : null };
  }
  /** The cheapest plan that includes a feature (for "Available on Scale — Upgrade"). */
  function planFor(key: string): PlanId | null {
    const f = book.features.find((x) => x.key === key);
    if (!f) return null;
    return [...book.plans].sort((a, b) => a.rank - b.rank).find((p) => f[p.id])?.id ?? null;
  }

  /**
   * Split a requested change (PRD §4.1). Whatever goes up applies now; whatever goes down waits for renewal.
   * `from.accounts` is the billed count on the subscription; `to.accounts` is what the customer asks for.
   * `maxAccounts` lets a custom deal go above the self-serve limit.
   */
  function splitChange(from: BillingState, to: BillingState, maxAccounts = book.max_self_serve_accounts): ChangeSplit {
    const up = { plan: planRank(to.plan) > planRank(from.plan), accounts: false, period: periodRank(to.period) > periodRank(from.period) };
    const down = { plan: planRank(to.plan) < planRank(from.plan), accounts: false, period: periodRank(to.period) < periodRank(from.period) };
    const base: Omit<ChangeSplit, "blocked" | "final_quote"> = { from, immediate: from, final: from, applies_now: false, applies_at_renewal: false, up, down };
    if (!Number.isInteger(to.accounts) || to.accounts < 1) {
      return { ...base, final_quote: quote(from.plan, from.period, Math.max(1, from.accounts)), blocked: { code: "E_PAYLOAD_INVALID", message: "Choose at least 1 account." } };
    }
    const finalQuote = quote(to.plan, to.period, to.accounts);
    if (to.accounts > maxAccounts) {
      return { ...base, final_quote: finalQuote, blocked: { code: "E_TALK_TO_US", message: `Plans with more than ${maxAccounts} accounts are set up with our team. Talk to us.` } };
    }
    up.accounts = finalQuote.billed > from.accounts;
    down.accounts = finalQuote.billed < from.accounts;
    const immPlan = up.plan ? to.plan : from.plan;
    const immPeriod = up.period ? to.period : from.period;
    // accounts on the immediate state: the bigger of what they have and what they ask for when the count goes up; otherwise what
    // they have. Either way it goes through the best-price rule of the plan and period it sits on from now.
    const immediate: BillingState = { plan: immPlan, period: immPeriod, accounts: quote(immPlan, immPeriod, up.accounts ? Math.max(to.accounts, from.accounts) : from.accounts).billed };
    const final: BillingState = { plan: to.plan, period: to.period, accounts: finalQuote.billed };
    const same = (a: BillingState, b: BillingState) => a.plan === b.plan && a.period === b.period && a.accounts === b.accounts;
    const appliesNow = !same(immediate, from);
    const appliesAtRenewal = !same(final, immediate);
    let blocked: ChangeSplit["blocked"] = null;
    if (!appliesNow && !appliesAtRenewal) {
      blocked = to.accounts < from.accounts
        ? { code: "E_DECREASE_COSTS_MORE", message: `${to.accounts} account${to.accounts === 1 ? "" : "s"} would cost more than your current ${from.accounts}.` }
        : { code: "E_NO_CHANGE", message: "That is the plan you already have." };
    }
    return { from, immediate, final, applies_now: appliesNow, applies_at_renewal: appliesAtRenewal, up, down, final_quote: finalQuote, blocked };
  }

  return {
    book, steps, planIds, periodIds, planById, periodById, isPlan, isPeriod, planRank, periodRank,
    stepIndex, perAccount, lookupKey, rawTotal, quote, stripeTiers, parseLookupKey, periodOfInterval,
    earlySupporterTier, couponForDiscount, feature, planFor, splitChange,
  };
}

export type Pricing = ReturnType<typeof makePricing>;

/** Whole cents after a percentage discount, rounded the way Stripe rounds a percent-off coupon (half up, per invoice line). */
export function discountedCents(cents: number, discount: number): number {
  return cents - Math.round(cents * discount);
}

/** "$1,360" / "$47.50": whole dollars drop the cents. */
export function formatUsd(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = abs % 100 === 0;
  const s = (abs / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  return `${neg ? "-" : ""}$${s}`;
}
