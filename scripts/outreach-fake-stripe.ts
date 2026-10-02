// A small fake Stripe for local tests of billing v2 (scripts/outreach-billing-e2e.ts and browser checks). It speaks the
// 2026-08-26.dahlia shapes the code relies on: the period on the subscription item, pending_update for 3-D Secure,
// invoice.confirmation_secret, schedules with phases, invoice.parent.subscription_details. It prices a volume-tiered
// quantity change by re-pricing every unit. It is NOT a statement about what real Stripe does: that is checked with test
// clocks (docs/outreach/BILLING.md §6).
import { pricing } from "../supabase/functions/_shared/outreach/pricing.ts";

type Row = Record<string, any>;
const DAY = 86400;

const S = { now: Math.floor(Date.now() / 1000), seq: 0, card: "ok" as "ok" | "decline" | "3ds", prices: new Map<string, Row>(), subs: new Map<string, Row>(), schedules: new Map<string, Row>(), invoices: new Map<string, Row>(), sessions: new Map<string, Row>(), calls: [] as string[], idem: new Map<string, Row>() };
const id = (p: string) => `${p}_${(++S.seq).toString(36).padStart(6, "0")}`;
for (const plan of pricing.book.plans) for (const period of pricing.book.periods) {
  const key = pricing.lookupKey(plan.id, period.id);
  S.prices.set(`price_${key}`, { id: `price_${key}`, object: "price", lookup_key: key, active: true, product: `outreach_${plan.id}`, billing_scheme: "tiered", tiers_mode: "volume",
    recurring: { interval: period.interval, interval_count: period.interval_count, usage_type: "licensed" }, tiers: pricing.stripeTiers(plan.id, period.id).map((t) => ({ up_to: t.up_to === "inf" ? null : t.up_to, unit_amount: t.unit_amount })) });
}
const periodSecs = (price: Row) => (price.recurring.interval === "year" ? 365 : 30 * price.recurring.interval_count) * DAY;
const totalOf = (price: Row, qty: number) => { const t = price.tiers.find((x: Row) => x.up_to == null || qty <= x.up_to); return t.unit_amount * qty; };
const discountOf = (sub: Row) => ({ early_50: 0.5, early_30: 0.3, early_10: 0.1 } as Record<string, number>)[sub.coupon ?? ""] ?? 0;
const afterDiscount = (cents: number, d: number) => cents - Math.round(cents * d);

function parseForm(body: string): Row {
  const out: Row = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const path = k.replace(/\]/g, "").split("[");
    let o = out;
    path.forEach((p, i) => { if (i === path.length - 1) o[p] = v; else { o[p] ??= /^\d+$/.test(path[i + 1]) ? [] : {}; o = o[p]; } });
  }
  return out;
}
const subView = (sub: Row, expandInvoice: boolean) => ({ ...sub, coupon: undefined, latest_invoice: expandInvoice && sub.latest_invoice ? S.invoices.get(sub.latest_invoice) ?? sub.latest_invoice : sub.latest_invoice });

/** Lines of the invoice a change raises now. Every unit is re-priced: credit the old total, debit the new one, for the time left. */
function prorate(sub: Row, price: Row, qty: number, at: number, anchorNow: boolean): { amount: number; lines: Row[] } {
  const item = sub.items.data[0], d = discountOf(sub);
  const left = Math.min(Math.max((item.current_period_end - at) / (item.current_period_end - item.current_period_start), 0), 1);
  const line = (amount: number, description: string, proration: boolean, start: number, end: number) => ({ amount, description, period: { start, end }, discount_amounts: [], taxes: [], parent: { type: "subscription_item_details", subscription_item_details: { proration } } });
  const credit = -Math.round(afterDiscount(totalOf(item.price, item.quantity), d) * left);
  if (anchorNow) {
    const full = afterDiscount(totalOf(price, qty), d);
    return { amount: full + credit, lines: [line(credit, "Unused time", true, at, item.current_period_end), line(full, `${qty} × new period`, false, at, at + periodSecs(price))] };
  }
  const debit = Math.round(afterDiscount(totalOf(price, qty), d) * left);
  return { amount: debit + credit, lines: [line(credit, `Unused time on ${item.quantity}`, true, at, item.current_period_end), line(debit, `Remaining time on ${qty}`, true, at, item.current_period_end)] };
}

function applyItems(sub: Row, price: Row, qty: number, anchorNow: boolean, meta?: Row): void {
  const item = sub.items.data[0];
  item.price = price; item.quantity = qty;
  if (anchorNow) { item.current_period_start = S.now; item.current_period_end = S.now + periodSecs(price); }
  if (meta) sub.metadata = { ...sub.metadata, ...meta };
}

function fake(req: Request, body: string): Row | Response {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v1/, "");
  const q = parseForm(req.method === "GET" ? url.search.slice(1) : body);
  S.calls.push(`${req.method} ${path}`);
  if (req.headers.get("stripe-version") !== "2026-08-26.dahlia") return err(400, "invalid_request_error", "api_version", "unexpected API version");
  const key = req.headers.get("idempotency-key");
  if (key && S.idem.has(key)) return S.idem.get(key)!;
  const done = (r: Row) => { if (key) S.idem.set(key, r); return r; };
  let m: RegExpExecArray | null;

  if (req.method === "GET" && path === "/prices") return { data: (q.lookup_keys ?? []).map((k: string) => [...S.prices.values()].find((p) => p.lookup_key === k)).filter(Boolean), has_more: false };
  if (req.method === "GET" && (m = /^\/prices\/(.+)$/.exec(path))) return S.prices.get(m[1]) ?? err(404, "invalid_request_error", "resource_missing", "no such price");
  if (req.method === "POST" && path === "/checkout/sessions") {
    const s = { id: id("cs"), object: "checkout.session", mode: q.mode, url: `https://checkout.stripe.test/${S.seq}`, params: q, payment_status: "unpaid" };
    S.sessions.set(s.id, s); return done(s);
  }
  if (req.method === "GET" && (m = /^\/subscriptions\/(.+)$/.exec(path))) { const sub = S.subs.get(m[1]); return sub ? subView(sub, (q.expand ?? []).includes("latest_invoice")) : err(404, "invalid_request_error", "resource_missing", "no such subscription"); }
  if (req.method === "POST" && (m = /^\/subscriptions\/(.+)$/.exec(path))) {
    const sub = S.subs.get(m[1]); if (!sub) return err(404, "invalid_request_error", "resource_missing", "no such subscription");
    if (q.cancel_at_period_end !== undefined) {
      if (q.payment_behavior) return err(400, "invalid_request_error", "parameter_invalid", "cancel_at_period_end cannot be combined with pending_if_incomplete");
      sub.cancel_at_period_end = q.cancel_at_period_end === "true"; return done(subView(sub, false));
    }
    if (sub.pending_update) return err(400, "invalid_request_error", "subscription_pending_update", "this subscription has a pending update");
    const it = q.items?.[0]; const price = S.prices.get(it.price); const qty = Number(it.quantity);
    if (!price || it.id !== sub.items.data[0].id) return err(400, "invalid_request_error", "parameter_invalid", "bad item");
    const anchorNow = q.billing_cycle_anchor === "now";
    const pr = prorate(sub, price, qty, Number(q.proration_date ?? S.now), anchorNow);
    if (S.card === "decline") return err(402, "card_error", "card_declined", "Your card was declined.", "insufficient_funds");
    const inv: Row = { id: id("in"), object: "invoice", amount_due: Math.max(pr.amount, 0), amount_paid: 0, status: "open", billing_reason: "subscription_update", hosted_invoice_url: `https://invoice.stripe.test/${S.seq}`, lines: { data: pr.lines },
      parent: { type: "subscription_details", subscription_details: { subscription: sub.id } }, confirmation_secret: { client_secret: `pi_${S.seq}_secret`, type: "payment_intent" } };
    S.invoices.set(inv.id, inv); sub.latest_invoice = inv.id;
    if (S.card === "3ds" && pr.amount > 0) {
      sub.pending_update = { expires_at: S.now + 23 * 3600, subscription_items: [{ id: it.id, price: price.id, quantity: qty }], apply: () => { applyItems(sub, price, qty, anchorNow, q.metadata); inv.status = "paid"; inv.amount_paid = inv.amount_due; sub.pending_update = null; } };
      return done({ ...subView(sub, true), pending_update: { expires_at: sub.pending_update.expires_at, subscription_items: sub.pending_update.subscription_items } });
    }
    inv.status = "paid"; inv.amount_paid = inv.amount_due;
    applyItems(sub, price, qty, anchorNow, q.metadata);
    return done(subView(sub, true));
  }
  if (req.method === "POST" && path === "/invoices/create_preview") {
    const sub = S.subs.get(q.subscription); if (!sub) return err(404, "invalid_request_error", "resource_missing", "no such subscription");
    const d = q.subscription_details; const price = S.prices.get(d.items[0].price);
    if (!price) return err(400, "invalid_request_error", "resource_missing", "no such price");
    const pr = prorate(sub, price, Number(d.items[0].quantity), Number(d.proration_date ?? S.now), d.billing_cycle_anchor === "now");
    return { object: "invoice", amount_due: Math.max(pr.amount, 0), total: pr.amount, total_taxes: [], lines: { data: pr.lines } };
  }
  if (req.method === "POST" && (m = /^\/invoices\/(.+)\/void$/.exec(path))) {
    const inv = S.invoices.get(m[1]); if (!inv) return err(404, "invalid_request_error", "resource_missing", "no such invoice");
    inv.status = "void"; for (const sub of S.subs.values()) if (sub.latest_invoice === inv.id) sub.pending_update = null;
    return done(inv);
  }
  if (req.method === "GET" && path === "/invoices") return { data: [...S.invoices.values()].filter((i) => i.status === q.status), has_more: false };
  if (req.method === "POST" && path === "/subscription_schedules") {
    const sub = S.subs.get(q.from_subscription); if (!sub) return err(404, "invalid_request_error", "resource_missing", "no such subscription");
    if (sub.schedule) return err(400, "invalid_request_error", "parameter_invalid", "subscription already has a schedule");
    const item = sub.items.data[0];
    const sc: Row = { id: id("sub_sched"), object: "subscription_schedule", status: "active", subscription: sub.id, end_behavior: "release", current_phase: { start_date: item.current_period_start, end_date: item.current_period_end },
      phases: [{ start_date: item.current_period_start, end_date: item.current_period_end, items: [{ price: item.price.id, quantity: item.quantity }] }] };
    S.schedules.set(sc.id, sc); sub.schedule = sc.id; return done(sc);
  }
  if (req.method === "POST" && (m = /^\/subscription_schedules\/(.+)\/release$/.exec(path))) {
    const sc = S.schedules.get(m[1]); if (!sc) return err(404, "invalid_request_error", "resource_missing", "no such schedule");
    if (sc.status !== "active") return err(400, "invalid_request_error", "parameter_invalid", "schedule is already released");
    sc.status = "released"; const sub = S.subs.get(sc.subscription); if (sub) sub.schedule = null; sc.released_subscription = sc.subscription; return done(sc);
  }
  if (req.method === "POST" && (m = /^\/subscription_schedules\/(.+)$/.exec(path))) {
    const sc = S.schedules.get(m[1]); if (!sc) return err(404, "invalid_request_error", "resource_missing", "no such schedule");
    if (!q.phases?.[0]?.start_date) return err(400, "invalid_request_error", "parameter_missing", "start_date must be set on the first phase");
    let cursor = Number(q.phases[0].start_date);
    sc.phases = q.phases.map((ph: Row) => {
      const price = S.prices.get(ph.items[0].price);
      const end = ph.end_date ? Number(ph.end_date) : cursor + (ph.duration.interval === "year" ? 365 : 30 * Number(ph.duration.interval_count)) * DAY;
      const out = { start_date: cursor, end_date: end, items: [{ price: price!.id, quantity: Number(ph.items[0].quantity) }], metadata: ph.metadata ?? {}, discounts: ph.discounts ?? [] };
      cursor = end; return out;
    });
    sc.end_behavior = q.end_behavior ?? sc.end_behavior;
    return done(sc);
  }
  if (req.method === "GET" && (m = /^\/subscription_schedules\/(.+)$/.exec(path))) {
    const sc = S.schedules.get(m[1]); if (!sc) return err(404, "invalid_request_error", "resource_missing", "no such schedule");
    return { ...sc, phases: sc.phases.map((ph: Row) => ({ ...ph, items: ph.items.map((it: Row) => ({ ...it, price: S.prices.get(it.price) })) })) };
  }
  if (req.method === "POST" && path === "/billing_portal/sessions") return { url: `https://billing.stripe.test/${q.customer}` };
  return err(404, "invalid_request_error", "unknown_route", `fake Stripe has no ${req.method} ${path}`);
}
function err(status: number, type: string, code: string, message: string, decline_code?: string): Response {
  return new Response(JSON.stringify({ error: { type, code, message, decline_code } }), { status, headers: { "content-type": "application/json" } });
}
/** Extra routes for driving the fake from a browser test (pay a checkout, move to renewal, pick how the card behaves). */
function control(url: URL): Row | null {
  const p = url.pathname;
  if (p === "/__test/card") { S.card = (url.searchParams.get("mode") ?? "ok") as typeof S.card; return { card: S.card }; }
  if (p === "/__test/pay-checkout") { const id2 = url.searchParams.get("session") ?? [...S.sessions.keys()].pop(); return id2 ? payCheckout(id2) : { error: "no session" }; }
  if (p === "/__test/renew") { const sub = url.searchParams.get("subscription") ?? [...S.subs.keys()].pop(); if (!sub) return { error: "no subscription" }; renew(sub); return { renewed: sub, now: S.now }; }
  if (p === "/__test/confirm-3ds") { for (const sub of S.subs.values()) sub.pending_update?.apply(); return { ok: true }; }
  if (p === "/__test/advance") { S.now += Number(url.searchParams.get("days") ?? 1) * DAY; return { now: S.now }; }
  if (p === "/__test/state") return { now: S.now, card: S.card, subscriptions: [...S.subs.values()].map((x) => ({ id: x.id, status: x.status, quantity: x.items.data[0].quantity, price: x.items.data[0].price.lookup_key, schedule: x.schedule, cancel_at_period_end: x.cancel_at_period_end })), sessions: [...S.sessions.keys()] };
  return null;
}

/** Start the fake on a local port. Point the code at it with STRIPE_API_BASE=http://127.0.0.1:<port>. */
export function startFakeStripe(port: number): { state: typeof S; payCheckout: typeof payCheckout; renew: typeof renew; shutdown: () => Promise<void> } {
  const server = Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const headers = { "content-type": "application/json", "request-id": "req_fake", "access-control-allow-origin": "*" };
    if (url.pathname.startsWith("/__test/")) return new Response(JSON.stringify(control(url) ?? { error: "unknown control route" }), { headers });
    const r = fake(req, req.method === "GET" ? "" : await req.text());
    return r instanceof Response ? r : new Response(JSON.stringify(r), { headers });
  });
  return { state: S, payCheckout, renew, shutdown: () => server.shutdown() };
}

/** What Checkout does when the customer pays: a customer and an active subscription with the session's line item. */
function payCheckout(sessionId: string): Row {
  const s = S.sessions.get(sessionId)!; const p = s.params;
  const price = S.prices.get(p.line_items[0].price)!;
  const sub: Row = { id: id("sub"), object: "subscription", customer: id("cus"), status: "active", cancel_at_period_end: false, schedule: null, pending_update: null, latest_invoice: null,
    metadata: p.subscription_data?.metadata ?? {}, coupon: p.discounts?.[0]?.coupon ?? null,
    items: { data: [{ id: id("si"), quantity: Number(p.line_items[0].quantity), price, current_period_start: S.now, current_period_end: S.now + periodSecs(price) }] } };
  S.subs.set(sub.id, sub);
  return { ...s, payment_status: "paid", subscription: sub.id, customer: sub.customer, client_reference_id: p.client_reference_id, metadata: p.metadata };
}
/** The period ends: a scheduled phase takes over, a cancelled subscription ends, otherwise it renews as it is. */
function renew(subId: string): void {
  const sub = S.subs.get(subId)!; const item = sub.items.data[0];
  S.now = item.current_period_end + 60;
  if (sub.cancel_at_period_end) { sub.status = "canceled"; return; }
  const sc = sub.schedule ? S.schedules.get(sub.schedule) : null;
  const next = sc?.phases.find((ph: Row) => ph.start_date >= item.current_period_end);
  const price = next ? S.prices.get(next.items[0].price)! : item.price;
  if (next) { item.price = price; item.quantity = next.items[0].quantity; sub.metadata = { ...sub.metadata, ...next.metadata }; sc!.status = "released"; sub.schedule = null; }
  item.current_period_start = item.current_period_end; item.current_period_end = item.current_period_start + periodSecs(price);
}
