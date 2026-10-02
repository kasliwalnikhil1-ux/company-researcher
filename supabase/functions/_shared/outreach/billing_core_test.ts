// deno test --node-modules-dir=none --allow-read --allow-env supabase/functions/_shared/outreach/billing_core_test.ts
// Billing rules without I/O, against the worked examples in pricing-billing-PRD.md §4 and Stripe object shapes of 2026-08-26.dahlia.
import { pricing } from "./pricing.ts";
import {
  addPeriod, chargeTodayFromPreview, deriveSubscriptionState, describeSplit, expectedProrationCents, immediateUpdateParams, isProrationLine,
  planOfPrice, previewParams, prorationNote, schedulePhases,
} from "./billing_core.ts";
import { encodeForm, verifyStripeSignature } from "./stripe.ts";
import { hmacSha256Hex } from "./crypto.ts";

function eq<T>(got: T, want: T, label: string): void {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) throw new Error(`${label}\n   got  ${a}\n   want ${b}`);
}

const DAY = 86400;
const T0 = 1_790_000_000;                       // period start
const price = (key: string, id = `price_${key}`, interval = "month", count = 1) => ({ id, lookup_key: key, recurring: { interval, interval_count: count } });
const sub = (over: Record<string, unknown> = {}) => ({
  id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, schedule: null, latest_invoice: "in_1", pending_update: null,
  metadata: { workspace_id: "ws", accounts_requested: "8" },
  items: { data: [{ id: "si_1", quantity: 10, price: price("launch_monthly_v1"), current_period_start: T0, current_period_end: T0 + 30 * DAY }] },
  ...over,
});

Deno.test("subscription → workspace state", () => {
  const d = deriveSubscriptionState(pricing, sub(), null);
  eq([d.plan, d.billing_period, d.accounts_billed, d.accounts_requested, d.price_version], ["launch", "monthly", 10, 8, "v1"], "plan, period, billed 10 for a requested 8");
  eq([d.current_period_start, d.current_period_end], [new Date(T0 * 1000).toISOString(), new Date((T0 + 30 * DAY) * 1000).toISOString()], "the period comes from the item");
  eq([d.status, d.cancel_at_period_end, d.schedule_id, d.scheduled_change, d.pending_payment, d.customer_id], ["active", false, null, null, null, "cus_1"], "no schedule, nothing pending");

  eq(deriveSubscriptionState(pricing, sub({ metadata: { accounts_requested: "99" } }), null).accounts_requested, 10, "a requested count above the billed one is ignored");
  eq(deriveSubscriptionState(pricing, sub({ metadata: {} }), null).accounts_requested, 10, "no metadata: requested = billed");

  const q = deriveSubscriptionState(pricing, sub({ items: { data: [{ id: "si", quantity: 20, price: price("scale_quarterly_v1", "p", "month", 3), current_period_start: T0, current_period_end: T0 + 90 * DAY }] } }), null);
  eq([q.plan, q.billing_period, q.accounts_billed], ["scale", "quarterly", 20], "quarterly = month × 3");

  // an unknown price leaves the plan to the database (it keeps the plan it has)
  const u = deriveSubscriptionState(pricing, sub({ items: { data: [{ id: "si", quantity: 3, price: { id: "price_x", lookup_key: "team_sender", recurring: { interval: "month", interval_count: 1 } }, current_period_start: T0, current_period_end: T0 + 30 * DAY }] } }), null);
  eq([u.plan, u.billing_period, u.custom_price_id], [null, "monthly", null], "unknown price");
  // the workspace's custom Enterprise price
  const c = deriveSubscriptionState(pricing, sub({ items: { data: [{ id: "si", quantity: 150, price: { id: "price_custom", lookup_key: null, recurring: { interval: "year", interval_count: 1 } }, current_period_start: T0, current_period_end: T0 + 365 * DAY }] } }), null, { customPriceId: "price_custom" });
  eq([c.plan, c.billing_period, c.accounts_billed, c.custom_price_id], ["enterprise", "annual", 150, "price_custom"], "custom deal");
  eq(planOfPrice(pricing, { id: "price_custom" }, null).plan, null, "a custom price of another workspace means nothing here");
});

Deno.test("scheduled change from the subscription schedule", () => {
  const end = T0 + 30 * DAY;
  const schedule = {
    id: "sub_sched_1", status: "active", current_phase: { start_date: T0, end_date: end },
    phases: [
      { start_date: T0, end_date: end, items: [{ price: price("scale_monthly_v1"), quantity: 10 }] },
      { start_date: end, end_date: end + 30 * DAY, metadata: { accounts_requested: "5" }, items: [{ price: price("launch_monthly_v1"), quantity: 5 }] },
    ],
  };
  const s = sub({ schedule: "sub_sched_1", items: { data: [{ id: "si", quantity: 10, price: price("scale_monthly_v1"), current_period_start: T0, current_period_end: end }] } });
  const d = deriveSubscriptionState(pricing, s, schedule);
  eq(d.schedule_id, "sub_sched_1", "schedule id");
  eq(d.scheduled_change, { plan: "launch", accounts_billed: 5, billing_period: "monthly", effective_at: new Date(end * 1000).toISOString(), accounts_requested: 5 }, "Scale 10 → Launch 5 at renewal");

  // the customer's keep list is ours, not Stripe's: it is carried while the target stays the same
  const keep = ["11111111-1111-1111-1111-111111111111"];
  eq(deriveSubscriptionState(pricing, s, schedule, { prevScheduled: { plan: "launch", accounts_billed: 5, billing_period: "monthly", effective_at: null, keep_sender_ids: keep } }).scheduled_change?.keep_sender_ids, keep, "keep list carried");
  eq(deriveSubscriptionState(pricing, s, schedule, { prevScheduled: { plan: "launch", accounts_billed: 7, billing_period: "monthly", effective_at: null, keep_sender_ids: keep } }).scheduled_change?.keep_sender_ids, undefined, "a keep list of another target is dropped");

  // a schedule whose next phase is the same as now is not a change; a released schedule is none either
  const same = { ...schedule, phases: [schedule.phases[0], { start_date: end, items: [{ price: price("scale_monthly_v1"), quantity: 10 }] }] };
  eq(deriveSubscriptionState(pricing, s, same).scheduled_change, null, "identical next phase");
  eq(deriveSubscriptionState(pricing, s, { ...schedule, status: "released" }).schedule_id, null, "released schedule");
});

Deno.test("pending payment (3-D Secure) and cancel at period end", () => {
  const d = deriveSubscriptionState(pricing, sub({ pending_update: { expires_at: T0 + DAY, subscription_items: [] }, latest_invoice: { id: "in_9", hosted_invoice_url: "https://invoice.stripe.com/i/x" } }), null);
  eq(d.pending_payment, { invoice_id: "in_9", hosted_invoice_url: "https://invoice.stripe.com/i/x", expires_at: new Date((T0 + DAY) * 1000).toISOString() }, "pending update");
  eq([d.plan, d.accounts_billed], ["launch", 10], "the subscription keeps its old items while a payment is pending");
  eq(deriveSubscriptionState(pricing, sub({ cancel_at_period_end: true }), null).cancel_at_period_end, true, "cancel at period end");
  eq(deriveSubscriptionState(pricing, sub({ status: "canceled" }), null).status, "canceled", "ended");
});

Deno.test("§4 worked examples: what a change should charge today", () => {
  const at = (daysLeft: number, total = 30) => T0 + (total - daysLeft) * DAY;
  const end = T0 + 30 * DAY;
  // §4.2 Launch monthly, 15 days left of 30, 5 → 10: ($290 − $195) × 15/30 = $47.50
  eq(expectedProrationCents(pricing, { plan: "launch", period: "monthly", accounts: 5 }, { plan: "launch", period: "monthly", accounts: 10 }, T0, end, at(15), 0), 4750, "5 → 10 mid-month");
  // §4.2 Launch annual, 8 months left, 10 → 20: ($4,800 − $2,760) × 8/12 = $1,360
  eq(expectedProrationCents(pricing, { plan: "launch", period: "annual", accounts: 10 }, { plan: "launch", period: "annual", accounts: 20 }, T0, T0 + 360 * DAY, T0 + 120 * DAY, 0), 136000, "annual 10 → 20");
  // §4.4 Launch → Scale, 10 accounts, 20 days left: $110 × 20/30 = $73.33
  eq(expectedProrationCents(pricing, { plan: "launch", period: "monthly", accounts: 10 }, { plan: "scale", period: "monthly", accounts: 10 }, T0, end, at(20), 0), 7333, "upgrade");
  // §4.6 Launch 10 monthly → annual, 20 days left: $2,760 − $193.33 = $2,566.67
  eq(expectedProrationCents(pricing, { plan: "launch", period: "monthly", accounts: 10 }, { plan: "launch", period: "annual", accounts: 10 }, T0, end, at(20), 0), 256667, "monthly → annual");
  // #4 last day of the period: a tiny charge
  eq(expectedProrationCents(pricing, { plan: "launch", period: "monthly", accounts: 5 }, { plan: "launch", period: "monthly", accounts: 10 }, T0, end, end - 3600, 0), 13, "last hour");
  // #26 early supporter: the discount stays on everything
  eq(expectedProrationCents(pricing, { plan: "launch", period: "monthly", accounts: 5 }, { plan: "launch", period: "monthly", accounts: 10 }, T0, end, at(15), 0.3), 3325, "30% off");
});

Deno.test("charge today from Stripe's preview", () => {
  const end = T0 + 30 * DAY;
  const pro = (amount: number, description: string, extra: Record<string, unknown> = {}) => ({ amount, description, period: { start: T0 + 15 * DAY, end }, parent: { type: "subscription_item_details", subscription_item_details: { proration: true } }, ...extra });
  // always_invoice preview of 5 → 10: a credit for the old total and a debit for the new one, re-pricing every unit
  const p1 = { amount_due: 4750, total: 4750, total_taxes: [], lines: { data: [pro(-9750, "Unused time on 5 × Launch"), pro(14500, "Remaining time on 10 × Launch")] } };
  const c1 = chargeTodayFromPreview(p1, { anchorReset: false, periodEnd: end });
  eq([c1.cents, c1.tax_cents, c1.pre_tax_cents, c1.includes_renewal, c1.lines.length], [4750, 0, 4750, false, 2], "prorations only");
  // a preview that also carries the next renewal: only the prorations are today's
  const renewal = { amount: 29000, description: "10 × Launch", period: { start: end, end: end + 30 * DAY }, parent: { type: "subscription_item_details", subscription_item_details: { proration: false } } };
  const c2 = chargeTodayFromPreview({ amount_due: 33750, total_taxes: [], lines: { data: [...p1.lines.data, renewal] } }, { anchorReset: false, periodEnd: end });
  eq([c2.cents, c2.includes_renewal, c2.lines.length], [4750, true, 2], "the renewal line is left out");
  // tax and a forever discount on the lines
  const c3 = chargeTodayFromPreview({ amount_due: 99999, total_taxes: [], lines: { data: [
    pro(-9750, "Unused", { discount_amounts: [{ amount: -2925 }], taxes: [{ amount: -1228, tax_behavior: "exclusive" }] }),
    pro(14500, "Remaining", { discount_amounts: [{ amount: 4350 }], taxes: [{ amount: 1827, tax_behavior: "exclusive" }] }), renewal] } }, { anchorReset: false, periodEnd: end });
  eq([c3.pre_tax_cents, c3.tax_cents, c3.cents], [3325, 599, 3924], "discount and tax per line");
  // monthly → annual restarts the period: the whole preview is today's invoice
  const c4 = chargeTodayFromPreview({ amount_due: 256667, total_taxes: [{ amount: 0, tax_behavior: "exclusive" }], lines: { data: [pro(-19333, "Unused time"), { amount: 276000, description: "10 × Launch (annual)", period: { start: T0 + 10 * DAY, end: T0 + 375 * DAY }, parent: { subscription_item_details: { proration: false } } }] } }, { anchorReset: true, periodEnd: end });
  eq([c4.cents, c4.lines.length], [256667, 2], "anchor reset");
  // a credit never becomes a negative charge
  eq(chargeTodayFromPreview({ amount_due: -500, lines: { data: [] } }, { anchorReset: true, periodEnd: end }).cents, 0, "no negative charge");
  eq(isProrationLine({ parent: { type: "invoice_item_details", invoice_item_details: { proration: true } } }), true, "invoice-item proration");
  eq(isProrationLine({ parent: {} }), false, "not a proration");
});

Deno.test("what is sent to Stripe", () => {
  const upd = immediateUpdateParams({ itemId: "si_1", priceId: "price_scale", quantity: 20, prorationDate: T0 + 5, anchorNow: false, accountsRequested: 20, priceVersion: "v1" });
  eq([...encodeForm(upd)].map(([k, v]) => `${k}=${v}`), [
    "items[0][id]=si_1", "items[0][price]=price_scale", "items[0][quantity]=20", "proration_behavior=always_invoice", "payment_behavior=pending_if_incomplete",
    `proration_date=${T0 + 5}`, "metadata[accounts_requested]=20", "metadata[price_version]=v1", "expand[0]=latest_invoice.confirmation_secret",
  ], "immediate update: always_invoice + pending_if_incomplete, no anchor change");
  eq(new Set(Object.keys(upd)).has("billing_cycle_anchor"), false, "anchor untouched for an account change");
  eq((immediateUpdateParams({ itemId: "si", priceId: "p", quantity: 1, prorationDate: 1, anchorNow: true, accountsRequested: 1, priceVersion: "v1" }) as Record<string, unknown>).billing_cycle_anchor, "now", "a longer billing period restarts the cycle today");
  // only parameters Stripe allows together with pending_if_incomplete
  const allowed = ["expand", "payment_behavior", "proration_behavior", "proration_date", "billing_cycle_anchor", "items", "trial_end", "trial_from_plan", "metadata", "discounts", "add_invoice_items"];
  eq(Object.keys(immediateUpdateParams({ itemId: "si", priceId: "p", quantity: 1, prorationDate: 1, anchorNow: true, accountsRequested: 1, priceVersion: "v1" })).filter((k) => !allowed.includes(k)), [], "pending_if_incomplete parameter whitelist");

  const prev = previewParams({ subscriptionId: "sub_1", itemId: "si_1", priceId: "price_scale", quantity: 20, prorationDate: T0 + 5, anchorNow: true });
  eq([...encodeForm(prev)].map(([k]) => k), ["subscription", "subscription_details[items][0][id]", "subscription_details[items][0][price]", "subscription_details[items][0][quantity]",
    "subscription_details[proration_behavior]", "subscription_details[proration_date]", "subscription_details[billing_cycle_anchor]"], "the preview is the same change");

  const ph = schedulePhases({ currentPriceId: "price_a", currentQuantity: 10, phaseStart: T0, phaseEnd: T0 + 30 * DAY, nextPriceId: "price_b", nextQuantity: 5, nextInterval: "month", nextIntervalCount: 1, coupon: "early_30", accountsRequested: 5, priceVersion: "v1" });
  eq([...encodeForm(ph)].map(([k, v]) => `${k}=${v}`), [
    "end_behavior=release",
    "phases[0][items][0][price]=price_a", "phases[0][items][0][quantity]=10", `phases[0][start_date]=${T0}`, `phases[0][end_date]=${T0 + 30 * DAY}`, "phases[0][discounts][0][coupon]=early_30",
    "phases[1][items][0][price]=price_b", "phases[1][items][0][quantity]=5", "phases[1][duration][interval]=month", "phases[1][duration][interval_count]=1",
    "phases[1][proration_behavior]=none", "phases[1][billing_cycle_anchor]=phase_start", "phases[1][metadata][accounts_requested]=5", "phases[1][metadata][price_version]=v1",
    "phases[1][discounts][0][coupon]=early_30",
  ], "two phases: now until the period ends, then the new state for one period; the discount on both");
  eq(JSON.stringify(schedulePhases({ currentPriceId: "a", currentQuantity: 1, phaseStart: 1, phaseEnd: 2, nextPriceId: "b", nextQuantity: 1, nextInterval: "year", nextIntervalCount: 1, coupon: null, accountsRequested: 1, priceVersion: "v1" })).includes("discounts"), false, "no coupon, no discounts key");
});

Deno.test("form encoding", () => {
  eq(encodeForm({ a: 1, b: null, c: undefined, d: "", e: { f: [true, "x"] }, g: [] }).toString(), "a=1&d=&e%5Bf%5D%5B0%5D=true&e%5Bf%5D%5B1%5D=x", "nested, nulls skipped, empty string kept");
});

Deno.test("webhook signature", async () => {
  const secret = "whsec_test", raw = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const t = 1_800_000_000;
  const sig = await hmacSha256Hex(secret, `${t}.${raw}`);
  eq((await verifyStripeSignature(raw, `t=${t},v1=${sig}`, secret, 300, t * 1000))?.id, "evt_1", "valid");
  eq((await verifyStripeSignature(raw, `t=${t},v1=deadbeef,v1=${sig}`, secret, 300, t * 1000))?.id, "evt_1", "one of several v1 signatures (secret roll)");
  eq(await verifyStripeSignature(raw + " ", `t=${t},v1=${sig}`, secret, 300, t * 1000), null, "tampered body");
  eq(await verifyStripeSignature(raw, `t=${t},v1=${sig}`, "whsec_other", 300, t * 1000), null, "wrong secret");
  eq(await verifyStripeSignature(raw, `t=${t},v1=${sig}`, secret, 300, (t + 301) * 1000), null, "stale timestamp");
  eq(await verifyStripeSignature(raw, "v1=abc", secret, 300, t * 1000), null, "no timestamp");
  eq(await verifyStripeSignature(raw, `t=${t},v1=${sig}`, "", 300, t * 1000), null, "no secret configured");
});

Deno.test("quote wording", () => {
  const split = pricing.splitChange({ plan: "launch", accounts: 20, period: "monthly" }, { plan: "scale", accounts: 10, period: "monthly" });
  eq(describeSplit(pricing, split), { now: ["Scale plan (was Launch)"], later: ["10 accounts (20 until then)"] }, "#14 Launch 20 → Scale 10");
  const up = pricing.splitChange({ plan: "launch", accounts: 10, period: "monthly" }, { plan: "launch", accounts: 10, period: "annual" });
  eq(describeSplit(pricing, up).now, ["Annual billing (was monthly); a new annual period starts today"], "period change");
  eq(prorationNote(T0, T0 + 30 * DAY, T0 + 15 * DAY, false), "You pay the difference for the 15 of 30 days left in this billing period.", "proration note");
  eq(prorationNote(T0, T0 + 30 * DAY, T0 + 10 * DAY, true), "The 20 unused days of your current period are credited, and the new period is charged in full today.", "period change note");
  eq(addPeriod(new Date("2026-01-31T10:00:00Z"), 1).toISOString(), "2026-02-28T10:00:00.000Z", "a month from the 31st is the last day of the next month");
  eq(addPeriod(new Date("2026-10-14T00:00:00Z"), 12).toISOString(), "2027-10-14T00:00:00.000Z", "a year");
});
