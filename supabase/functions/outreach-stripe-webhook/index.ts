// F24 — Stripe subscription lifecycle → outreach_workspaces.plan. Deploy with --no-verify-jwt.
// Also handles user-invoked billing actions with a JWT: {action:'checkout'|'portal', workspace_id, plan}
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, audit, WEB_ORIGIN, timingSafeEqual, rpc, log } from "../_shared/outreach/supabase.ts";
import { hmacSha256Hex } from "../_shared/outreach/crypto.ts";
import { stripeRequest } from "../_shared/outreach/workers.ts";

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const PRICES: Record<string, string | undefined> = {
  team: Deno.env.get("STRIPE_PRICE_TEAM_SENDER"), agency: Deno.env.get("STRIPE_PRICE_AGENCY_SENDER"), agency_plus: Deno.env.get("STRIPE_PRICE_AGENCY_PLUS_SENDER"), mailbox: Deno.env.get("STRIPE_PRICE_MAILBOX_ADDON"),
};

async function verifyStripe(req: Request, raw: string): Promise<any> {
  const sig = req.headers.get("stripe-signature") ?? "";
  const parts = Object.fromEntries(sig.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1 || !WEBHOOK_SECRET) throw new HttpError(400, "E_STRIPE_SIGNATURE", "missing signature");
  const expected = await hmacSha256Hex(WEBHOOK_SECRET, `${t}.${raw}`);
  if (!timingSafeEqual(expected, v1)) throw new HttpError(400, "E_STRIPE_SIGNATURE", "bad signature");
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) throw new HttpError(400, "E_STRIPE_SIGNATURE", "stale signature");
  return JSON.parse(raw);
}

function planFromSub(sub: any): string {
  const keys = (sub.items?.data ?? []).map((i: any) => i.price?.lookup_key ?? i.price?.nickname ?? i.price?.id ?? "");
  if (keys.some((k: string) => /agency_plus/i.test(k) || k === PRICES.agency_plus)) return "agency_plus";
  if (keys.some((k: string) => /agency/i.test(k) || k === PRICES.agency)) return "agency";
  return "team";
}

async function resumeAfterBilling(wsId: string): Promise<void> {
  try { const n = await rpc<number>("resume_after_billing", { p_ws: wsId }); log({ fn: "stripe-webhook", workspace: wsId, senders_resumed: n }); }
  catch (e) { log({ fn: "stripe-webhook", workspace: wsId, error: `resume_after_billing failed: ${String((e as any)?.message ?? e)}` }); }
}

serve("stripe-webhook", async (req) => {
  if (req.headers.get("stripe-signature")) {
    const raw = await req.text();
    const event = await verifyStripe(req, raw);
    const obj = event.data?.object ?? {};
    const customer = obj.customer ?? obj.customer_id;
    const wsId = obj.metadata?.workspace_id ?? obj.client_reference_id;
    let ws: any = null;
    if (wsId) ws = (await admin.from("outreach_workspaces").select("*").eq("id", wsId).maybeSingle()).data;
    if (!ws && customer) ws = (await admin.from("outreach_workspaces").select("*").eq("stripe_customer_id", customer).maybeSingle()).data;
    if (!ws) return json({ ok: true, ignored: "no workspace" });
    switch (event.type) {
      case "checkout.session.completed":
        await admin.from("outreach_workspaces").update({ stripe_customer_id: obj.customer, stripe_subscription_id: obj.subscription ?? ws.stripe_subscription_id }).eq("id", ws.id);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const status = obj.status;
        const patch: Record<string, unknown> = { stripe_subscription_id: obj.id, stripe_customer_id: obj.customer, stripe_status: status };
        const wasBlocked = ws.plan === "suspended" || !!ws.past_due_since || ["past_due", "unpaid"].includes(ws.stripe_status ?? "");
        if (status === "active" || status === "trialing") { patch.plan = planFromSub(obj); patch.past_due_since = null; }
        else if (status === "past_due" || status === "unpaid") { patch.past_due_since = ws.past_due_since ?? new Date().toISOString(); }
        else if (status === "canceled") { patch.plan = "suspended"; if (ws.plan !== "suspended") patch.settings = { ...(ws.settings ?? {}), plan_before_suspension: ws.plan }; }
        await admin.from("outreach_workspaces").update(patch).eq("id", ws.id);
        // Payment recovered: senders paused for billing resume on their own (nobody restarts them by hand).
        if ((status === "active" || status === "trialing") && wasBlocked) await resumeAfterBilling(ws.id);
        break;
      }
      case "customer.subscription.deleted":
        await admin.from("outreach_workspaces").update({ stripe_status: "canceled", plan: "suspended", ...(ws.plan !== "suspended" ? { settings: { ...(ws.settings ?? {}), plan_before_suspension: ws.plan } } : {}) }).eq("id", ws.id);
        await admin.from("outreach_senders").update({ status: "paused", status_reason: "billing_suspended" }).eq("workspace_id", ws.id).eq("status", "ok");
        break;
      case "invoice.payment_failed":
        await admin.from("outreach_workspaces").update({ stripe_status: "past_due", past_due_since: ws.past_due_since ?? new Date().toISOString() }).eq("id", ws.id);
        break;
      case "invoice.paid":
        await admin.from("outreach_workspaces").update({ stripe_status: "active", past_due_since: null }).eq("id", ws.id);
        // restores the plan remembered at suspension (or team) and resumes the senders that billing paused
        if (ws.plan === "suspended" || ws.past_due_since || ["past_due", "unpaid"].includes(ws.stripe_status ?? "")) await resumeAfterBilling(ws.id);
        break;
    }
    await audit(ws.id, `stripe.${event.type}`, "workspace", ws.id, { id: event.id });
    return json({ ok: true });
  }

  // user-invoked billing actions
  const user = await requireUser(req);
  const body = await readJson<{ action: "checkout" | "portal"; workspace_id: string; plan?: "team" | "agency" | "agency_plus" }>(req);
  const m = await membership(user.id, body.workspace_id ?? "");
  requireRole(m, "owner");
  const { data: ws } = await admin.from("outreach_workspaces").select("*").eq("id", body.workspace_id).single();
  if (body.action === "checkout") {
    const price = PRICES[body.plan ?? "team"];
    if (!price) throw new HttpError(503, "E_NOT_CONFIGURED", `Stripe price for ${body.plan ?? "team"} not configured`);
    const { count } = await admin.from("outreach_senders").select("id", { count: "exact", head: true }).eq("workspace_id", ws!.id).is("deleted_at", null).neq("status", "disabled");
    const params: Record<string, string> = {
      mode: "subscription", "line_items[0][price]": price, "line_items[0][quantity]": String(Math.max(1, count ?? 1)),
      success_url: `${WEB_ORIGIN}/outreach/settings/billing?checkout=success`, cancel_url: `${WEB_ORIGIN}/outreach/settings/billing?checkout=cancel`,
      client_reference_id: ws!.id, "metadata[workspace_id]": ws!.id, "subscription_data[metadata][workspace_id]": ws!.id,
    };
    if (ws!.stripe_customer_id) params.customer = ws!.stripe_customer_id; else if (user.email) params.customer_email = user.email;
    const session = await stripeRequest("POST", "/checkout/sessions", params);
    return json({ url: session.url });
  }
  if (body.action === "portal") {
    if (!ws!.stripe_customer_id) throw new HttpError(400, "E_NO_CUSTOMER", "no billing account yet");
    const portal = await stripeRequest("POST", "/billing_portal/sessions", { customer: ws!.stripe_customer_id, return_url: `${WEB_ORIGIN}/outreach/settings/billing` });
    return json({ url: portal.url });
  }
  throw new HttpError(400, "E_PAYLOAD_INVALID");
});
