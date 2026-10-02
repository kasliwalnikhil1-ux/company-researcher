// Stripe catalogue for billing v2 (pricing-billing-PRD.md §8, §13 step 3), built from pricing/v1.json:
//   3 products (Launch, Scale, Enterprise) · 9 volume-tiered prices by lookup key ({plan}_{period}_v1) · 3 forever coupons
//   (early_50 / early_30 / early_10) · a customer-portal configuration (payment methods, invoices, address, tax IDs only) ·
//   the webhook endpoint with the events outreach-stripe-webhook handles.
//
//   STRIPE_SECRET_KEY=sk_test_… deno run -A --node-modules-dir=none scripts/stripe-setup.ts            create / update everything
//   STRIPE_SECRET_KEY=sk_test_… deno run -A --node-modules-dir=none scripts/stripe-setup.ts --check    change nothing; exit 1 when Stripe differs from the JSON
//
// Optional env: OUTREACH_FUNCTIONS_BASE_URL (https://<ref>.supabase.co/functions/v1/) to create the webhook endpoint,
//               OUTREACH_WEB_ORIGIN for the portal's return link, STRIPE_API_VERSION.
// Safe to run again: it finds what exists by lookup key / id / metadata. A price whose amounts changed is replaced by a new
// price that takes over the lookup key (existing subscriptions keep the old price). For a real price change, add
// pricing/v2.json instead so existing subscribers stay on _v1 (PRD §13 step 7).
// Use a sandbox first. Prefer a restricted key with write access to Products, Prices, Coupons, Customer portal and Webhook endpoints.
import { makePricing, type PriceBook } from "../supabase/functions/_shared/outreach/pricing_core.ts";

const KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const VERSION = Deno.env.get("STRIPE_API_VERSION") ?? "2026-08-26.dahlia";
const CHECK = Deno.args.includes("--check");
const FUNCTIONS_BASE = (Deno.env.get("OUTREACH_FUNCTIONS_BASE_URL") ?? "").replace(/\/?$/, "/");
const WEB_ORIGIN = Deno.env.get("OUTREACH_WEB_ORIGIN") ?? "https://app.capitalxai.com";
if (!KEY) { console.error("STRIPE_SECRET_KEY is not set"); Deno.exit(2); }

const book = JSON.parse(await Deno.readTextFile(new URL("../pricing/v1.json", import.meta.url))) as PriceBook;
const pricing = makePricing(book);

const EVENTS = [
  "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.pending_update_applied", "customer.subscription.pending_update_expired",
  "subscription_schedule.updated", "subscription_schedule.released", "subscription_schedule.completed", "subscription_schedule.canceled", "subscription_schedule.aborted",
  "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required",
  "charge.dispute.created", "charge.dispute.closed",
];

function form(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (k: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(`${k}[${i}]`, x)); return; }
    if (typeof v === "object") { for (const [kk, x] of Object.entries(v as Record<string, unknown>)) walk(`${k}[${kk}]`, x); return; }
    out.append(k, String(v));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out;
}

async function api<T = any>(method: "GET" | "POST", path: string, params?: Record<string, unknown>): Promise<T> {
  const f = params ? form(params) : null;
  const res = await fetch(`https://api.stripe.com/v1${path}${method === "GET" && f ? `?${f}` : ""}`, {
    method, headers: { authorization: `Bearer ${KEY}`, "stripe-version": VERSION, ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: method === "POST" ? (f?.toString() ?? "") : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${data?.error?.message ?? res.status}`), { status: res.status, code: data?.error?.code });
  return data as T;
}
const maybe = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch (e) { if ((e as { status?: number }).status === 404) return null; throw e; } };

let problems = 0;
const say = (state: "ok" | "create" | "update" | "DIFF", what: string) => { if (state === "DIFF") problems++; console.log(`${state.padEnd(7)}${what}`); };

// ---------------------------------------------------------------------------------------------------------------- products
const productIds: Record<string, string> = {};
for (const plan of book.plans) {
  const id = `outreach_${plan.id}`;
  const existing = await maybe(api<any>("GET", `/products/${id}`));
  if (existing) {
    productIds[plan.id] = existing.id;
    if (existing.name !== plan.name || existing.active !== true) { if (CHECK) say("DIFF", `product ${id}: name "${existing.name}"`); else { await api("POST", `/products/${id}`, { name: plan.name, active: true }); say("update", `product ${id}`); } }
    else say("ok", `product ${id} (${plan.name})`);
  } else if (CHECK) say("DIFF", `product ${id} is missing`);
  else { const p = await api<any>("POST", "/products", { id, name: plan.name, description: plan.for, metadata: { outreach_plan: plan.id } }); productIds[plan.id] = p.id; say("create", `product ${id} (${plan.name})`); }
}

// ---------------------------------------------------------------------------------------------------------------- prices
for (const plan of book.plans) for (const period of book.periods) {
  const key = pricing.lookupKey(plan.id, period.id);
  const want = pricing.stripeTiers(plan.id, period.id);
  const found = (await api<any>("GET", "/prices", { lookup_keys: [key], active: true, expand: ["data.tiers"] })).data?.[0] ?? null;
  const same = found && found.billing_scheme === "tiered" && found.tiers_mode === "volume" && found.currency === book.currency
    && found.recurring?.interval === period.interval && (found.recurring?.interval_count ?? 1) === period.interval_count && (found.recurring?.usage_type ?? "licensed") === "licensed"
    && (found.tiers ?? []).length === want.length
    && want.every((t, i) => (found.tiers[i].up_to ?? "inf") === t.up_to && found.tiers[i].unit_amount === t.unit_amount);
  if (same) { say("ok", `price ${key} (${want.map((t) => `${t.up_to === "inf" ? "∞" : `≤${t.up_to}`}:$${t.unit_amount / 100}`).join(" ")})`); continue; }
  if (CHECK) { say("DIFF", `price ${key}: ${found ? "tiers or interval differ from pricing/v1.json" : "missing"}`); continue; }
  if (!productIds[plan.id]) throw new Error(`no product for ${plan.id}`);
  await api("POST", "/prices", {
    product: productIds[plan.id], currency: book.currency, nickname: `${plan.name} · ${period.label}`,
    billing_scheme: "tiered", tiers_mode: "volume", tiers: want.map((t) => ({ up_to: t.up_to, unit_amount: t.unit_amount })),
    recurring: { interval: period.interval, interval_count: period.interval_count, usage_type: "licensed" },
    tax_behavior: "exclusive", lookup_key: key, transfer_lookup_key: true,
    metadata: { outreach_plan: plan.id, outreach_period: period.id, outreach_price_version: book.version },
  });
  say(found ? "update" : "create", `price ${key}${found ? ` (replaces ${found.id}; existing subscriptions keep it)` : ""}`);
}

// ---------------------------------------------------------------------------------------------------------------- coupons
for (const t of book.early_supporter.tiers) {
  const pct = Math.round(t.discount * 100);
  const existing = await maybe(api<any>("GET", `/coupons/${t.coupon}`));
  if (existing) {
    if (Number(existing.percent_off) !== pct || existing.duration !== "forever") { say("DIFF", `coupon ${t.coupon}: ${existing.percent_off}% ${existing.duration} (a coupon cannot be edited: delete it in Stripe, then run this again)`); }
    else say("ok", `coupon ${t.coupon} (${pct}% off, forever)`);
  } else if (CHECK) say("DIFF", `coupon ${t.coupon} is missing`);
  else { await api("POST", "/coupons", { id: t.coupon, percent_off: pct, duration: "forever", name: `Early supporter ${pct}%`, metadata: { outreach_tier: String(t.tier) } }); say("create", `coupon ${t.coupon} (${pct}% off, forever)`); }
}

// ---------------------------------------------------------------------------------------------------------------- portal
// Plan switching, quantity changes and cancellation are OFF in the portal: they go through the app so the rules and the
// account-limit checks always run (PRD §8.5).
const portalParams = {
  business_profile: { headline: "Payment method, invoices and billing details" },
  default_return_url: `${WEB_ORIGIN}/outreach/billing`,
  features: {
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ["address", "tax_id", "name", "email"] },
    subscription_cancel: { enabled: false },
    subscription_update: { enabled: false },
  },
  metadata: { outreach: "billing_v2" },
};
const portals = (await api<any>("GET", "/billing_portal/configurations", { limit: 100 })).data ?? [];
const portal = portals.find((c: any) => c.metadata?.outreach === "billing_v2" && c.active);
let portalId = portal?.id ?? null;
if (portal) {
  const f = portal.features ?? {};
  const fine = f.payment_method_update?.enabled && f.invoice_history?.enabled && f.customer_update?.enabled && !f.subscription_cancel?.enabled && !f.subscription_update?.enabled;
  if (fine) say("ok", `portal configuration ${portal.id}`);
  else if (CHECK) say("DIFF", `portal configuration ${portal.id}: features differ`);
  else { await api("POST", `/billing_portal/configurations/${portal.id}`, portalParams); say("update", `portal configuration ${portal.id}`); }
} else if (CHECK) say("DIFF", "portal configuration is missing");
else { portalId = (await api<any>("POST", "/billing_portal/configurations", portalParams)).id; say("create", `portal configuration ${portalId}`); }

// ---------------------------------------------------------------------------------------------------------------- webhook
let webhookSecret: string | null = null;
if (FUNCTIONS_BASE.startsWith("https://")) {
  const url = `${FUNCTIONS_BASE}outreach-stripe-webhook`;
  const hooks = (await api<any>("GET", "/webhook_endpoints", { limit: 100 })).data ?? [];
  const hook = hooks.find((h: any) => h.url === url && h.status !== "disabled");
  if (hook) {
    const missing = EVENTS.filter((e) => !(hook.enabled_events ?? []).includes(e) && !(hook.enabled_events ?? []).includes("*"));
    if (!missing.length && hook.api_version === VERSION) say("ok", `webhook endpoint ${hook.id}`);
    else if (CHECK) say("DIFF", `webhook endpoint ${hook.id}: ${missing.length ? `missing events ${missing.join(", ")}` : `API version ${hook.api_version}, expected ${VERSION} (an endpoint's version cannot be changed: create a new one)`}`);
    else if (missing.length) { await api("POST", `/webhook_endpoints/${hook.id}`, { enabled_events: EVENTS }); say("update", `webhook endpoint ${hook.id} (events)`); }
    else say("DIFF", `webhook endpoint ${hook.id} uses API version ${hook.api_version}, expected ${VERSION}: delete it in Stripe and run this again`);
  } else if (CHECK) say("DIFF", `webhook endpoint for ${url} is missing`);
  else {
    const h = await api<any>("POST", "/webhook_endpoints", { url, enabled_events: EVENTS, api_version: VERSION, description: "Outreach billing v2", metadata: { outreach: "billing_v2" } });
    webhookSecret = h.secret ?? null;
    say("create", `webhook endpoint ${h.id} → ${url}`);
  }
} else console.log("skip   webhook endpoint (set OUTREACH_FUNCTIONS_BASE_URL to create it)");

console.log("");
if (CHECK) { console.log(problems ? `${problems} difference(s) between Stripe and pricing/${book.version}.json` : `Stripe matches pricing/${book.version}.json`); Deno.exit(problems ? 1 : 0); }
console.log("Set these as function secrets (scripts/outreach-set-secrets.sh):");
console.log(`  STRIPE_SECRET_KEY=<the key you ran this with, or a restricted key for the functions>`);
if (portalId) console.log(`  STRIPE_PORTAL_CONFIGURATION=${portalId}`);
if (webhookSecret) console.log(`  STRIPE_WEBHOOK_SECRET=${webhookSecret}    (shown once)`);
console.log(`  STRIPE_API_VERSION=${VERSION}              (optional: this is the default)`);
console.log("  STRIPE_TAX_ENABLED=true                    (only after Stripe Tax has an active registration: without one Stripe collects no tax)");
if (problems) Deno.exit(1);
