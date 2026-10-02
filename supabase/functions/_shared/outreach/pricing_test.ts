// deno test --node-modules-dir=none --allow-read supabase/functions/_shared/outreach/pricing_test.ts
// Price book rules against the tables in pricing-billing-PRD.md (§1.2, §2, §4, §14).
import { pricing, PRICE_BOOK, discountedCents, formatUsd } from "./pricing.ts";
import type { BillingPeriod, PlanId } from "./pricing.ts";

function eq<T>(got: T, want: T, label: string): void {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) throw new Error(`${label}\n   got  ${a}\n   want ${b}`);
}

const PLANS: PlanId[] = ["launch", "scale", "enterprise"];
const PERIODS: BillingPeriod[] = ["monthly", "quarterly", "annual"];

Deno.test("the generated copy is the JSON", () => {
  const json = JSON.parse(Deno.readTextFileSync(new URL("../../../../pricing/v1.json", import.meta.url)));
  eq(PRICE_BOOK as unknown, json, "pricing.gen.ts is stale: run node scripts/pricing-sync.mjs");
});

Deno.test("§1.2: the 54 per-account prices", () => {
  const table: Record<PlanId, Record<BillingPeriod, number[]>> = {
    launch: { monthly: [49, 39, 29, 25, 22, 16], quarterly: [44, 35, 26, 23, 20, 14], annual: [39, 31, 23, 20, 18, 13] },
    scale: { monthly: [69, 49, 40, 35, 30, 20], quarterly: [62, 44, 36, 32, 27, 18], annual: [55, 39, 32, 28, 24, 16] },
    enterprise: { monthly: [99, 69, 55, 50, 40, 30], quarterly: [89, 62, 50, 45, 36, 27], annual: [79, 55, 44, 40, 32, 24] },
  };
  const steps = [1, 5, 10, 20, 50, 100];
  for (const p of PLANS) for (const per of PERIODS) steps.forEach((s, i) => {
    eq(pricing.perAccount(p, per, s), table[p][per][i], `${p} ${per} at ${s}`);
    // a count between two steps pays the step at or below it
    if (i + 1 < steps.length) eq(pricing.perAccount(p, per, steps[i + 1] - 1), table[p][per][i], `${p} ${per} at ${steps[i + 1] - 1}`);
  });
  eq(pricing.perAccount("launch", "monthly", 250), 16, "100+ covers everything above");
});

/** "4→5, 8–9→10" → the set of counts that round up, with the step they land on. */
function ranges(spec: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const part of spec.split(",")) {
    const [lhs, to] = part.trim().split("→");
    const [a, b] = lhs.split("–").map(Number);
    for (let n = a; n <= (b ?? a); n++) out.set(n, Number(to));
  }
  return out;
}

Deno.test("§2: best-price ranges for every plan and period", () => {
  const table: Record<PlanId, Record<BillingPeriod, string>> = {
    launch: {
      monthly: "4→5, 8–9→10, 18–19→20, 44–49→50, 73–99→100",
      quarterly: "4→5, 8–9→10, 18–19→20, 44–49→50, 70–99→100",
      annual: "4→5, 8–9→10, 18–19→20, 45–49→50, 73–99→100",
    },
    scale: {
      monthly: "4→5, 9→10, 18–19→20, 43–49→50, 67–99→100",
      quarterly: "4→5, 9→10, 18–19→20, 43–49→50, 67–99→100",
      annual: "4→5, 9→10, 18–19→20, 43–49→50, 67–99→100",
    },
    enterprise: {
      monthly: "4→5, 8–9→10, 19→20, 40–49→50, 75–99→100",
      quarterly: "4→5, 9→10, 18–19→20, 40–49→50, 75–99→100",
      annual: "4→5, 8–9→10, 19→20, 40–49→50, 75–99→100",
    },
  };
  for (const p of PLANS) for (const per of PERIODS) {
    const want = ranges(table[p][per]);
    for (let n = 1; n <= 100; n++) {
      const q = pricing.quote(p, per, n);
      eq(q.billed, want.get(n) ?? n, `${p} ${per}: billed count for ${n}`);
      eq(q.best_price, want.has(n), `${p} ${per}: best-price flag for ${n}`);
      eq(q.period_total, q.per_account * q.billed * q.months, `${p} ${per}: total for ${n}`);
    }
  }
});

Deno.test("§15: a bigger count never costs less than a smaller one", () => {
  for (const p of PLANS) for (const per of PERIODS) {
    let prev = 0;
    for (let n = 1; n <= 100; n++) {
      const t = pricing.quote(p, per, n).period_total;
      if (t < prev) throw new Error(`${p} ${per}: ${n} accounts cost ${t}, less than ${n - 1} accounts (${prev})`);
      prev = t;
    }
  }
});

Deno.test("§2 and §14 worked examples", () => {
  const q8 = pricing.quote("launch", "monthly", 8);
  eq([q8.billed, q8.period_total, q8.requested_total, q8.best_price], [10, 290, 312, true], "#1: 8 on Launch monthly is billed 10 at $290");
  eq(pricing.quote("launch", "monthly", 9).requested_total, 351, "9 × $39");
  eq(pricing.quote("launch", "monthly", 99).requested_total, 2178, "99 × $22");
  eq(pricing.quote("launch", "monthly", 100).period_total, 1600, "100 × $16");
  eq(pricing.quote("launch", "monthly", 7).period_total, 273, "#3: 7 × $39");
  eq(pricing.quote("launch", "annual", 10).period_total, 2760, "§4.2: 10 × $23 × 12");
  eq(pricing.quote("launch", "annual", 20).period_total, 4800, "§4.2: 20 × $20 × 12");
  eq(pricing.quote("scale", "monthly", 10).period_total, 400, "§4.4: Scale 10");
  eq(pricing.quote("launch", "monthly", 150).period_total, 2400, "#25: above 100 keeps the 100+ price");
});

Deno.test("Stripe volume tiers", () => {
  eq(pricing.stripeTiers("launch", "monthly"), [
    { up_to: 4, unit_amount: 4900 }, { up_to: 9, unit_amount: 3900 }, { up_to: 19, unit_amount: 2900 },
    { up_to: 49, unit_amount: 2500 }, { up_to: 99, unit_amount: 2200 }, { up_to: "inf", unit_amount: 1600 },
  ], "launch monthly");
  eq(pricing.stripeTiers("scale", "annual")[0], { up_to: 4, unit_amount: 55 * 12 * 100 }, "annual unit amount covers 12 months");
  eq(pricing.stripeTiers("enterprise", "quarterly")[5], { up_to: "inf", unit_amount: 27 * 3 * 100 }, "quarterly unit amount covers 3 months");
  // a Stripe volume price charges quantity × the tier's unit amount: that must equal our quote for every billed count
  for (const p of PLANS) for (const per of PERIODS) for (let n = 1; n <= 120; n++) {
    const tiers = pricing.stripeTiers(p, per);
    const tier = tiers.find((t) => t.up_to === "inf" || n <= t.up_to)!;
    eq(tier.unit_amount * n, pricing.rawTotal(p, per, n) * 100, `${p} ${per} × ${n}`);
  }
});

Deno.test("lookup keys and intervals", () => {
  eq(pricing.lookupKey("scale", "annual"), "scale_annual_v1", "key");
  eq(pricing.parseLookupKey("scale_annual_v1"), { plan: "scale", period: "annual", version: "v1" }, "parse");
  eq(pricing.parseLookupKey("enterprise_custom_abc"), null, "custom price is not a book key");
  eq(pricing.parseLookupKey("team_sender"), null, "old key");
  eq(pricing.periodOfInterval("month", 3), "quarterly", "quarterly = 3 months");
  eq(pricing.periodOfInterval("year", 1), "annual", "annual");
  eq(pricing.periodOfInterval("week", 1), null, "unknown interval");
});

Deno.test("early-supporter tiers", () => {
  eq(pricing.earlySupporterTier(1)?.discount, 0.5, "first");
  eq(pricing.earlySupporterTier(50)?.discount, 0.5, "50th");
  eq(pricing.earlySupporterTier(51)?.discount, 0.3, "51st");
  eq(pricing.earlySupporterTier(150)?.discount, 0.1, "150th");
  eq(pricing.earlySupporterTier(151), null, "151st gets none");
  eq(pricing.couponForDiscount(0.3), "early_30", "coupon");
  eq(pricing.couponForDiscount(0), null, "no coupon");
  eq(discountedCents(3900, 0.3), 2730, "D6: 30% off $39 is $27.30");
});

Deno.test("features per plan", () => {
  eq(pricing.feature("launch", "ai_auto_reply").enabled, false, "launch has no Auto");
  eq(pricing.feature("scale", "ai_auto_reply").enabled, true, "scale has Auto");
  eq(pricing.feature("scale", "webhooks").enabled, false, "webhooks are Enterprise");
  eq([pricing.feature("launch", "webchat_inboxes").limit, pricing.feature("scale", "webchat_inboxes").limit, pricing.feature("enterprise", "webchat_inboxes").limit], [1, 3, null], "inbox limits");
  eq(pricing.planFor("clients"), "scale", "clients unlock on Scale");
  eq(pricing.planFor("white_label"), "enterprise", "white-label unlocks on Enterprise");
});

Deno.test("§4: what applies now and what waits for renewal", () => {
  const split = (from: [PlanId, number, BillingPeriod], to: [PlanId, number, BillingPeriod]) =>
    pricing.splitChange({ plan: from[0], accounts: from[1], period: from[2] }, { plan: to[0], accounts: to[1], period: to[2] });

  // §4.2 more accounts: now
  let s = split(["launch", 5, "monthly"], ["launch", 10, "monthly"]);
  eq([s.applies_now, s.applies_at_renewal, s.immediate.accounts, s.blocked], [true, false, 10, null], "5 → 10 applies now");

  // §4.3 fewer accounts: at renewal
  s = split(["launch", 10, "monthly"], ["launch", 5, "monthly"]);
  eq([s.applies_now, s.applies_at_renewal, s.immediate.accounts, s.final.accounts], [false, true, 10, 5], "10 → 5 waits for renewal");

  // #2: 10 → 8 is blocked (8 costs more than 10)
  s = split(["launch", 10, "monthly"], ["launch", 8, "monthly"]);
  eq(s.blocked?.code, "E_DECREASE_COSTS_MORE", "10 → 8 blocked");
  eq(s.blocked?.message, "8 accounts would cost more than your current 10.", "10 → 8 reason");

  // #3: 10 → 7 allowed at renewal
  s = split(["launch", 10, "monthly"], ["launch", 7, "monthly"]);
  eq([s.blocked, s.applies_now, s.final.accounts], [null, false, 7], "10 → 7 at renewal");

  // §4.4 upgrade: now. §4.5 downgrade: at renewal
  s = split(["launch", 10, "monthly"], ["scale", 10, "monthly"]);
  eq([s.applies_now, s.applies_at_renewal, s.immediate.plan], [true, false, "scale"], "upgrade now");
  s = split(["scale", 10, "monthly"], ["launch", 10, "monthly"]);
  eq([s.applies_now, s.applies_at_renewal, s.immediate.plan, s.final.plan], [false, true, "scale", "launch"], "downgrade at renewal");

  // §4.6 longer period: now. Shorter: at the end of the term
  s = split(["launch", 10, "monthly"], ["launch", 10, "annual"]);
  eq([s.applies_now, s.applies_at_renewal, s.immediate.period], [true, false, "annual"], "monthly → annual now");
  s = split(["launch", 10, "annual"], ["launch", 10, "monthly"]);
  eq([s.applies_now, s.applies_at_renewal, s.immediate.period, s.final.period], [false, true, "annual", "monthly"], "annual → monthly at term end");

  // #14: Launch 20 → Scale 10 = plan up now (Scale 20), accounts down at renewal (Scale 10)
  s = split(["launch", 20, "monthly"], ["scale", 10, "monthly"]);
  eq([s.immediate, s.final], [{ plan: "scale", period: "monthly", accounts: 20 }, { plan: "scale", period: "monthly", accounts: 10 }], "mixed change is split");
  eq([s.applies_now, s.applies_at_renewal], [true, true], "both parts");

  // accounts up now + plan down at renewal
  s = split(["scale", 10, "monthly"], ["launch", 20, "monthly"]);
  eq([s.immediate, s.final], [{ plan: "scale", period: "monthly", accounts: 20 }, { plan: "launch", period: "monthly", accounts: 20 }], "accounts now, plan later");

  // best price on the way up: asking for 8 on Launch from 5 gives 10 now
  s = split(["launch", 5, "monthly"], ["launch", 8, "monthly"]);
  eq([s.immediate.accounts, s.final_quote.best_price, s.applies_at_renewal], [10, true, false], "5 → 8 becomes 10");

  // an upgrade can round the count up under the new plan's prices (Enterprise: 8 costs more than 10)
  s = split(["scale", 8, "monthly"], ["enterprise", 8, "monthly"]);
  eq([s.immediate, s.applies_at_renewal], [{ plan: "enterprise", period: "monthly", accounts: 10 }, false], "Scale 8 → Enterprise gives 10");

  // nothing changed
  eq(split(["scale", 10, "monthly"], ["scale", 10, "monthly"]).blocked?.code, "E_NO_CHANGE", "no change");
  // #25: self-serve stops at 100
  eq(split(["scale", 10, "monthly"], ["scale", 150, "monthly"]).blocked?.code, "E_TALK_TO_US", "150 accounts");
  eq(split(["scale", 10, "monthly"], ["scale", 0, "monthly"]).blocked?.code, "E_PAYLOAD_INVALID", "0 accounts");
  // a custom deal may go above 100 when the caller raises the limit
  eq(pricing.splitChange({ plan: "enterprise", accounts: 120, period: "annual" }, { plan: "enterprise", accounts: 150, period: "annual" }, 500).blocked, null, "custom limit");
});

Deno.test("money formatting", () => {
  eq(formatUsd(4750), "$47.50", "cents");
  eq(formatUsd(136000), "$1,360", "whole dollars");
  eq(formatUsd(-19333), "-$193.33", "credit");
});
