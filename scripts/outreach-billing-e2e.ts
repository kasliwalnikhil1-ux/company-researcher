// End-to-end check of billing v2 against a LOCAL Supabase stack and a fake Stripe (pricing-billing-PRD.md §15).
// It drives the same functions the edge functions call (quote → checkout / change / cancel / resume → workspace state) and
// asserts what lands in the database. The fake Stripe speaks the 2026-08-26.dahlia shapes the code relies on and prices a
// volume-tiered quantity change by re-pricing every unit; whether real Stripe does the same is checked separately with test
// clocks (docs/outreach/BILLING.md §Verify in Stripe test mode).
//
// Needs migrations 056–060 applied to the local database. It refuses to run against anything that is not localhost.
//   SUPABASE_URL=http://127.0.0.1:55321 SUPABASE_SERVICE_ROLE_KEY=… SUPABASE_ANON_KEY=… \
//   deno run -A --node-modules-dir=none scripts/outreach-billing-e2e.ts
const FAKE_PORT = 55998;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(SUPABASE_URL)) { console.error("This test only runs against a local Supabase stack (SUPABASE_URL must be localhost)."); Deno.exit(2); }
Deno.env.set("STRIPE_SECRET_KEY", "sk_test_fake");
Deno.env.set("STRIPE_API_BASE", `http://127.0.0.1:${FAKE_PORT}`);
Deno.env.set("OUTREACH_WEB_ORIGIN", "http://localhost:3000");

const { admin } = await import("../supabase/functions/_shared/outreach/supabase.ts");
const { pricing } = await import("../supabase/functions/_shared/outreach/pricing.ts");
const B = await import("../supabase/functions/_shared/outreach/billing.ts");

type Row = Record<string, any>;
const DAY = 86400;

const { startFakeStripe } = await import("./outreach-fake-stripe.ts");
const fakeStripe = startFakeStripe(FAKE_PORT);
const S = fakeStripe.state;
const { payCheckout, renew } = fakeStripe;
const id = (p: string) => `${p}_e2e_${Math.random().toString(36).slice(2, 8)}`;

// ============================================================================================ test harness
let fails = 0, oks = 0;
function check(cond: unknown, label: string, detail?: unknown): void {
  if (cond) { oks++; console.log(`ok    ${label}`); } else { fails++; console.log(`FAIL  ${label}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}
async function expectError(p: Promise<unknown>, code: string, label: string): Promise<Row | null> {
  try { await p; check(false, `${label} (expected ${code}, got success)`); return null; }
  catch (e) { const got = (e as Row).code ?? String((e as Error).message); check(got === code, `${label} → ${code}`, got); return e as Row; }
}
const sql = async <T = Row>(fn: string, args: Row = {}) => { const { data, error } = await admin.rpc(fn, args); if (error) throw new Error(`${fn}: ${error.message}`); return data as T; };
const ws = async (wsId: string): Promise<Row> => (await admin.from("outreach_workspaces").select("*").eq("id", wsId).single()).data!;
/** Our clock follows the fake's: the code reads the period from the workspace row, and proration dates from Date.now(). */
const realNow = Date.now;
const setClock = () => { Date.now = () => S.now * 1000; };

const tag = `e2e${Math.random().toString(36).slice(2, 8)}`;
const { data: created, error: userErr } = await admin.auth.admin.createUser({ email: `${tag}@billing-e2e.example`, password: crypto.randomUUID(), email_confirm: true });
if (userErr || !created?.user) { console.error("could not create the test user:", userErr?.message); Deno.exit(2); }
const userId = created.user.id;
const flagBefore = (await admin.from("outreach_flags").select("value").eq("key", "billing_enforced").maybeSingle()).data?.value ?? false;
let wsId = "";

try {
  await admin.from("outreach_flags").upsert({ key: "billing_enforced", value: true });
  await admin.from("platform_user_access").upsert({ user_id: userId, status: "active" }, { onConflict: "user_id" });
  const { data: w, error: wErr } = await admin.from("outreach_workspaces").insert({ name: `Billing e2e ${tag}`, slug: tag, created_by: userId }).select("*").single();
  if (wErr) throw new Error(wErr.message);
  wsId = w.id;
  await admin.from("outreach_members").insert({ workspace_id: wsId, user_id: userId, role: "owner", email: `${tag}@billing-e2e.example` });
  // the first workspace of the test database may not get an early-supporter place; give this one tier 2 (30%) to cover discounts
  await admin.from("outreach_workspaces").update({ early_supporter_discount: 0, early_supporter_tier: null }).eq("id", wsId);
  const sender = async (name: string, status = "ok") => (await admin.from("outreach_senders").insert({ workspace_id: wsId, provider: "LINKEDIN", display_name: name, status, unipile_account_id: `${tag}-${name}`, timezone: "UTC", owner_user_id: userId }).select("id").single()).data!.id as string;
  const s1 = await sender("one");
  setClock();

  // ------------------------------------------------------------------ 1. trial → subscribe (checkout)
  check((await ws(wsId)).plan === "trial", "a new workspace is on trial");
  let q = await B.buildQuote(await ws(wsId), { plan: "launch", accounts: 8, period: "monthly" }, userId);
  check(q.quote.mode === "checkout" && q.quote.final.accounts === 10 && q.quote.charge_today_cents === 29000 && q.quote.best_price?.billed === 10, "#1 quote: 8 accounts on Launch monthly → 10 for $290 (best price)", q.quote);
  const co = await B.createCheckout(await ws(wsId), q.quote_id, { id: userId, email: `${tag}@billing-e2e.example` });
  const sess = S.sessions.get([...S.sessions.keys()].pop()!)!;
  check(co.url.startsWith("https://checkout.stripe.test/") && sess.params.line_items[0].quantity === "10" && sess.params.line_items[0].price === "price_launch_monthly_v1" && sess.params.client_reference_id === wsId
    && sess.params.tax_id_collection?.enabled === "true" && sess.params.billing_address_collection === "required" && !sess.params.allow_promotion_codes && !sess.params.payment_method_types && !sess.params.discounts,
    "checkout session: volume price × 10, tax id collection, no promotion codes, no payment_method_types", sess.params);
  await expectError(B.createCheckout(await ws(wsId), q.quote_id, { id: userId, email: null }).then(() => { throw Object.assign(new Error("x"), { code: "SAME_SESSION_OK" }); }), "SAME_SESSION_OK", "the same quote creates the same session again (idempotent)");
  const paid = payCheckout(sess.id);
  const subId = paid.subscription as string;
  await B.completeCheckout(wsId, paid);
  let w1 = await ws(wsId);
  check(w1.plan === "launch" && w1.accounts_billed === 10 && w1.accounts_requested === 8 && w1.billing_period === "monthly" && w1.stripe_subscription_id === subId && w1.stripe_status === "active" && !!w1.current_period_end,
    "after checkout the workspace is Launch · 10 accounts (8 requested) · monthly", { plan: w1.plan, billed: w1.accounts_billed, req: w1.accounts_requested });
  check((await admin.from("outreach_billing_changes").select("status").eq("id", q.quote_id).single()).data?.status === "applied", "the checkout quote is marked applied");
  await expectError(B.createCheckout(await ws(wsId), q.quote_id, { id: userId, email: null }), "E_ALREADY_SUBSCRIBED", "a second checkout is refused");

  // ------------------------------------------------------------------ 2. more accounts now, prorated; the charge equals the quote
  S.now += 15 * DAY;
  q = await B.buildQuote(await ws(wsId), { plan: "launch", accounts: 20, period: "monthly" }, userId);
  check(q.quote.applies_now && !q.quote.applies_at_renewal && q.quote.charge_today_cents === 10500 && q.quote.proration_check?.ok === true && q.quote.next_invoice.cents === 50000,
    "10 → 20 with 15 of 30 days left: ($500 − $290) × 15/30 = $105 today, $500 next", { today: q.quote.charge_today_cents, check: q.quote.proration_check, next: q.quote.next_invoice });
  S.now += 600;                                                         // the customer reads the quote for ten minutes
  let r = await B.applyChange(await ws(wsId), q.quote_id, null, userId);
  w1 = await ws(wsId);
  check(r.status === "applied" && r.charged_cents === 10500 && w1.accounts_billed === 20 && w1.plan === "launch", "the change is applied and the amount charged equals the quote ($105), ten minutes later", r);
  await expectError(B.applyChange(await ws(wsId), q.quote_id, null, userId), "E_QUOTE_STALE", "#8 the same quote cannot be confirmed twice");

  // ------------------------------------------------------------------ 3. declined card: nothing changes
  S.card = "decline";
  q = await B.buildQuote(await ws(wsId), { plan: "scale", accounts: 20, period: "monthly" }, userId);
  const declined = await expectError(B.applyChange(await ws(wsId), q.quote_id, null, userId), "E_PAYMENT_FAILED", "#7 declined card");
  w1 = await ws(wsId);
  check(w1.plan === "launch" && w1.accounts_billed === 20 && /Nothing was changed/.test(String(declined?.message)), "after a decline the workspace is unchanged and says so");
  check((await admin.from("outreach_billing_changes").select("status").eq("id", q.quote_id).single()).data?.status === "failed", "the declined change is recorded as failed");
  S.card = "ok";

  // ------------------------------------------------------------------ 4. #14 mixed change: plan up now, accounts down at renewal
  q = await B.buildQuote(await ws(wsId), { plan: "scale", accounts: 10, period: "monthly" }, userId);
  check(q.quote.immediate.plan === "scale" && q.quote.immediate.accounts === 20 && q.quote.final.accounts === 10 && q.quote.applies_now && q.quote.applies_at_renewal
    && q.quote.now_changes[0] === "Scale plan (was Launch)" && q.quote.later_changes[0] === "10 accounts (20 until then)", "#14 Launch 20 → Scale 10 = Scale 20 now + Scale 10 at renewal", q.quote);
  r = await B.applyChange(await ws(wsId), q.quote_id, null, userId);
  w1 = await ws(wsId);
  check(r.status === "applied" && w1.plan === "scale" && w1.accounts_billed === 20 && w1.scheduled_change?.accounts_billed === 10 && w1.scheduled_change?.plan === "scale" && !!w1.stripe_schedule_id && !!w1.scheduled_change?.effective_at,
    "Scale 20 now; Scale 10 scheduled for renewal", { plan: w1.plan, billed: w1.accounts_billed, scheduled: w1.scheduled_change });
  const sc = S.schedules.get(w1.stripe_schedule_id)!;
  check(sc.phases.length === 2 && sc.phases[0].items[0].quantity === 20 && sc.phases[1].items[0].quantity === 10 && sc.phases[1].start_date === sc.phases[0].end_date && sc.end_behavior === "release", "the schedule has two phases and releases afterwards", sc.phases);

  // ------------------------------------------------------------------ 5. cancel the scheduled change; a decrease alone; blocked decrease
  await B.cancelScheduledChange(await ws(wsId), userId);
  w1 = await ws(wsId);
  check(!w1.scheduled_change && !w1.stripe_schedule_id && S.subs.get(subId)!.schedule === null, "cancelling the scheduled change releases the schedule");
  await expectError(B.buildQuote(await ws(wsId), { plan: "scale", accounts: 19, period: "monthly" }, userId), "E_DECREASE_COSTS_MORE", "#2 a decrease into a best-price range is blocked");
  await expectError(B.buildQuote(await ws(wsId), { plan: "scale", accounts: 20, period: "monthly" }, userId), "E_NO_CHANGE", "the plan they already have");
  await expectError(B.buildQuote(await ws(wsId), { plan: "scale", accounts: 150, period: "monthly" }, userId), "E_TALK_TO_US", "#25 150 accounts");

  const s2 = await sender("two"), s3 = await sender("three");
  q = await B.buildQuote(await ws(wsId), { plan: "scale", accounts: 2, period: "monthly" }, userId, [s3, s1]);
  check(q.quote.charge_today_cents === 0 && !q.quote.applies_now && q.quote.senders_to_pause.filter((x: Row) => x.action === "pause").length === 1 && q.quote.senders_to_pause.find((x: Row) => x.action === "pause")?.sender_id === s2,
    "20 → 2 is free today and lists the one account that would pause (keep list respected)", q.quote.senders_to_pause);
  r = await B.applyChange(await ws(wsId), q.quote_id, [s3, s1], userId);
  w1 = await ws(wsId);
  check(r.status === "scheduled" && w1.accounts_billed === 20 && w1.scheduled_change?.accounts_billed === 2 && JSON.stringify(w1.scheduled_change?.keep_sender_ids) === JSON.stringify([s3, s1]), "the decrease is scheduled with the keep list", w1.scheduled_change);

  // ------------------------------------------------------------------ 6. renewal: the decrease lands, the extra account pauses
  renew(subId);
  await B.syncWorkspaceFromStripe(wsId);
  w1 = await ws(wsId);
  const st = async (sid: string) => { const x = (await admin.from("outreach_senders").select("status, status_reason").eq("id", sid).single()).data!; return `${x.status}:${x.status_reason ?? "-"}`; };
  check(w1.accounts_billed === 2 && !w1.scheduled_change && !w1.stripe_schedule_id && (await st(s2)) === "paused:over_plan_limit" && (await st(s1)) === "ok:-" && (await st(s3)) === "ok:-",
    "at renewal: 2 accounts, the sender outside the keep list is paused (over_plan_limit)", { billed: w1.accounts_billed, s1: await st(s1), s2: await st(s2), s3: await st(s3) });

  // ------------------------------------------------------------------ 7. 3-D Secure: nothing applies until the payment is confirmed
  S.now += 10 * DAY; S.card = "3ds";
  q = await B.buildQuote(await ws(wsId), { plan: "scale", accounts: 5, period: "monthly" }, userId);
  r = await B.applyChange(await ws(wsId), q.quote_id, null, userId);
  w1 = await ws(wsId);
  check(r.status === "requires_action" && !!r.client_secret && w1.accounts_billed === 2 && !!w1.pending_payment?.invoice_id && w1.pending_payment?.change_id === q.quote_id, "#6 3-D Secure: client secret returned, the workspace still has 2 accounts", r);
  await expectError(B.buildQuote(await ws(wsId), { plan: "scale", accounts: 10, period: "monthly" }, userId), "E_PAYMENT_PENDING", "no other change while a payment is pending");
  S.subs.get(subId)!.pending_update.apply();                            // the customer confirms with their bank
  await B.syncWorkspaceFromStripe(wsId); await B.settlePendingChange(wsId);
  w1 = await ws(wsId);
  check(w1.accounts_billed === 5 && !w1.pending_payment && (await st(s2)) === "ok:-" && (await admin.from("outreach_billing_changes").select("status").eq("id", q.quote_id).single()).data?.status === "applied",
    "after confirmation: 5 accounts, the paused sender resumed, the change is applied", { billed: w1.accounts_billed, s2: await st(s2) });
  // …and abandoning one
  q = await B.buildQuote(await ws(wsId), { plan: "enterprise", accounts: 5, period: "monthly" }, userId);
  r = await B.applyChange(await ws(wsId), q.quote_id, null, userId);
  await B.abandonPendingPayment(await ws(wsId), userId);
  w1 = await ws(wsId);
  check(r.status === "requires_action" && w1.plan === "scale" && !w1.pending_payment && (await admin.from("outreach_billing_changes").select("status").eq("id", q.quote_id).single()).data?.status === "failed", "an abandoned 3-D Secure payment changes nothing");
  S.card = "ok";

  // ------------------------------------------------------------------ 8. monthly → annual: credit for unused days, new period starts today
  q = await B.buildQuote(await ws(wsId), { plan: "scale", accounts: 5, period: "annual" }, userId);
  const item = S.subs.get(subId)!.items.data[0];
  const left = (item.current_period_end - S.now) / (item.current_period_end - item.current_period_start);
  const want = 5 * 39 * 12 * 100 - Math.round(5 * 49 * 100 * left);
  check(q.quote.anchor_now === true && Math.abs(q.quote.charge_today_cents - want) <= 1 && q.quote.proration_check?.ok && /unused day/.test(q.quote.proration_note), "#15 monthly → annual: annual in full less the unused days", { got: q.quote.charge_today_cents, want });
  r = await B.applyChange(await ws(wsId), q.quote_id, null, userId);
  w1 = await ws(wsId);
  check(r.status === "applied" && w1.billing_period === "annual" && Math.abs(new Date(w1.current_period_start).getTime() / 1000 - S.now) < 5, "the annual period starts today");
  // annual → monthly waits for the end of the term
  q = await B.buildQuote(await ws(wsId), { plan: "scale", accounts: 5, period: "monthly" }, userId);
  check(!q.quote.applies_now && q.quote.applies_at_renewal && q.quote.charge_today_cents === 0, "#16 annual → monthly applies at the end of the annual term");

  // ------------------------------------------------------------------ 9. early supporter: the discount is on the quote, the checkout and the schedule
  await admin.from("outreach_workspaces").update({ early_supporter_discount: 0.3, early_supporter_tier: 2 }).eq("id", wsId);
  S.subs.get(subId)!.coupon = "early_30";
  S.now += 100 * DAY;
  q = await B.buildQuote(await ws(wsId), { plan: "scale", accounts: 10, period: "annual" }, userId);
  check(q.quote.early_supporter?.discount === 0.3 && q.quote.proration_check?.ok && q.quote.next_invoice.cents === Math.round(10 * 32 * 12 * 100 * 0.7), "#26 early supporter: 30% off the proration and the next invoice", { check: q.quote.proration_check, next: q.quote.next_invoice });
  q = await B.buildQuote(await ws(wsId), { plan: "launch", accounts: 5, period: "annual" }, userId);
  r = await B.applyChange(await ws(wsId), q.quote_id, null, userId);
  w1 = await ws(wsId);
  const sc2 = S.schedules.get(w1.stripe_schedule_id)!;
  check(r.status === "scheduled" && sc2.phases.every((ph: Row) => ph.discounts?.[0]?.coupon === "early_30"), "#27 a scheduled downgrade keeps the coupon on both phases", sc2.phases.map((p: Row) => p.discounts));
  check(q.quote.effects.some((e: Row) => e.feature === "ai_auto_reply") && q.quote.effects.some((e: Row) => e.feature === "clients"), "the downgrade quote lists what switches off", q.quote.effects.map((e: Row) => e.feature));

  // ------------------------------------------------------------------ 10. cancel, undo, cancel again, period ends
  let c = await B.cancelSubscription(await ws(wsId), "too_expensive", "testing", userId);
  w1 = await ws(wsId);
  check(w1.cancel_at_period_end === true && !w1.scheduled_change && !!c.access_until && w1.plan === "scale", "cancel: at period end, full access until then, the scheduled downgrade is dropped");
  await expectError(B.cancelSubscription(await ws(wsId), "because", "", userId), "E_PAYLOAD_INVALID", "a cancel reason must be one of the choices");
  await B.resumeSubscription(await ws(wsId), userId);
  w1 = await ws(wsId);
  check(w1.cancel_at_period_end === false && Number(w1.early_supporter_discount) === 0.3, "undo cancel: everything continues, the early-supporter discount stays");
  // #17 a change while cancelling resumes the subscription
  c = await B.cancelSubscription(await ws(wsId), "temporary", "", userId);
  q = await B.buildQuote(await ws(wsId), { plan: "scale", accounts: 10, period: "annual" }, userId);
  check(q.quote.resumes_subscription === true, "#17 a quote made while cancelling says it resumes the subscription");
  r = await B.applyChange(await ws(wsId), q.quote_id, null, userId);
  w1 = await ws(wsId);
  check(r.status === "applied" && w1.cancel_at_period_end === false && w1.accounts_billed === 10, "the change resumed the subscription and added the accounts");
  await B.cancelSubscription(await ws(wsId), "not_using", "", userId);
  renew(subId);
  await B.syncWorkspaceFromStripe(wsId);
  w1 = await ws(wsId);
  check(w1.plan === "cancelled" && Number(w1.early_supporter_discount) === 0 && !!w1.data_delete_after && (await st(s1)) === "paused:billing_cancelled", "period ended: cancelled, senders paused, discount gone, 90-day clock running", { plan: w1.plan, s1: await st(s1) });
  await expectError(B.buildQuote(await ws(wsId), { plan: "launch", accounts: 1, period: "monthly" }, userId).then((x) => { if (x.quote.mode !== "checkout" || x.quote.early_supporter) throw Object.assign(new Error("x"), { code: "WRONG" }); throw Object.assign(new Error("x"), { code: "CHECKOUT_AT_LIST_PRICE" }); }), "CHECKOUT_AT_LIST_PRICE", "coming back is a new subscription at list price");

  // ------------------------------------------------------------------ 11. which workspace an event belongs to
  const ev = (type: string, object: Row) => ({ id: id("evt"), type, data: { object } });
  check((await B.resolveEventWorkspace(ev("customer.subscription.updated", { id: subId, customer: "cus_x" }))).ws?.id === wsId, "event → workspace by subscription id");
  check((await B.resolveEventWorkspace(ev("invoice.paid", { id: "in_x", parent: { type: "subscription_details", subscription_details: { subscription: subId } } }))).ws?.id === wsId, "invoice → workspace through invoice.parent.subscription_details");
  check((await B.resolveEventWorkspace(ev("subscription_schedule.released", { id: "sub_sched_x", released_subscription: subId }))).ws?.id === wsId, "schedule → workspace");
  check((await B.resolveEventWorkspace(ev("invoice.paid", { id: "in_y", customer: "cus_nobody" }))).ws === null, "an event of an unknown customer matches no workspace");
  check(S.calls.every((c2) => !c2.includes("subscription_items")), "no call ever sets a quantity from usage (no /subscription_items calls)");
} catch (e) {
  fails++;
  console.log(`FAIL  unexpected error: ${(e as Error)?.stack ?? e}`);
} finally {
  Date.now = realNow;
  if (wsId) await admin.from("outreach_workspaces").delete().eq("id", wsId);
  await admin.from("outreach_trial_claims").delete().eq("user_id", userId);
  await admin.auth.admin.deleteUser(userId).catch(() => null);
  await admin.from("outreach_flags").upsert({ key: "billing_enforced", value: flagBefore });
  await fakeStripe.shutdown();
}
console.log(`\n${fails ? `E2E FAIL (${fails} failed, ${oks} passed)` : `E2E OK (${oks} checks)`}`);
Deno.exit(fails ? 1 : 0);
