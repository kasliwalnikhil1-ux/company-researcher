// Stripe events → workspace billing state (pricing-billing-PRD.md §8.6, §10.2). Deploy with --no-verify-jwt: the caller is
// Stripe and the signature is checked here. Owner actions (quote, change, checkout, cancel …) live in outreach-billing.
//
// Every event is stored once (outreach_billing_events, unique on the Stripe event id), so a repeat is answered without doing
// anything. Handlers never trust the payload's state or the order events arrive in: they read the live subscription from
// Stripe and write what it says now (syncWorkspaceFromStripe → outreach_billing_apply_subscription).
import { admin, audit, HttpError, json, log, rpc, serve } from "../_shared/outreach/supabase.ts";
import { verifyStripeSignature } from "../_shared/outreach/stripe.ts";
import { completeCheckout, loadWorkspace, resolveEventWorkspace, settlePendingChange, syncWorkspaceFromStripe } from "../_shared/outreach/billing.ts";
import { platformAlert, sendBillingNotice } from "../_shared/outreach/billing_emails.ts";

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

const HANDLED = new Set([
  "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.pending_update_applied", "customer.subscription.pending_update_expired",
  "subscription_schedule.updated", "subscription_schedule.released", "subscription_schedule.completed", "subscription_schedule.canceled", "subscription_schedule.aborted",
  "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required",
  "charge.dispute.created", "charge.dispute.closed",
]);

async function handle(event: any, ws: Record<string, any>, subscriptionId: string | null): Promise<void> {
  const obj = event.data?.object ?? {};
  const type = String(event.type);
  const wsId = String(ws.id);

  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    // fulfil only a paid session; an unpaid async one is fulfilled by async_payment_succeeded
    if (obj.mode !== "subscription" || (obj.payment_status && obj.payment_status === "unpaid")) return;
    await completeCheckout(wsId, obj);
    return;
  }

  if (type.startsWith("charge.dispute.")) {
    const open = type === "charge.dispute.created";
    const won = String(obj.status ?? "") === "won";
    const r = await rpc("billing_dispute", { p_ws: wsId, p_open: open, p_won: open ? null : won, p_dispute: obj.id ?? null });
    await platformAlert(open ? `Card dispute opened: ${ws.name}` : `Card dispute closed (${obj.status}): ${ws.name}`,
      [open ? "The workspace was suspended at once (PRD §5.4)." : won ? "Won: the workspace resumed." : "Not won: the workspace stays suspended until someone decides."], { workspace_id: wsId, dispute: obj.id, amount: obj.amount, reason: obj.reason, result: r });
    return;
  }

  // everything else: the workspace follows the live subscription
  const before = ws;
  if (subscriptionId || ws.stripe_subscription_id) await syncWorkspaceFromStripe(wsId, subscriptionId ?? ws.stripe_subscription_id);
  const after = await loadWorkspace(wsId).catch(() => null);

  switch (type) {
    case "invoice.payment_failed": {
      // a failed renewal (not the first try of a change the customer is watching: that one answers on screen)
      if (obj.billing_reason === "subscription_update") break;
      await admin.from("outreach_workspaces").update({ stripe_status: "past_due", past_due_since: before.past_due_since ?? new Date().toISOString() }).eq("id", wsId).is("past_due_since", null);
      await sendBillingNotice(wsId, "payment_failed", String(obj.id ?? event.id), { pay_url: obj.hosted_invoice_url ?? null });
      break;
    }
    case "invoice.payment_action_required": {
      if (after?.pending_payment) break;                         // the customer is on the confirmation step in the app already
      await sendBillingNotice(wsId, "payment_action_required", String(obj.id ?? event.id), { pay_url: obj.hosted_invoice_url ?? null });
      break;
    }
    case "invoice.paid": {
      await audit(wsId, "billing.invoice_paid", "workspace", wsId, { invoice: obj.id, amount_paid: obj.amount_paid, billing_reason: obj.billing_reason });
      await settlePendingChange(wsId);
      break;
    }
    case "customer.subscription.pending_update_applied":
    case "customer.subscription.pending_update_expired":
    case "customer.subscription.updated":
      if (before.pending_payment || type !== "customer.subscription.updated") await settlePendingChange(wsId);
      break;
    case "customer.subscription.deleted":
      if (after?.plan === "cancelled" && before.plan !== "cancelled") {
        await sendBillingNotice(wsId, "subscription_cancelled", String(obj.id ?? event.id), { data_delete_after: after.data_delete_after });
      }
      break;
  }
}

serve("stripe-webhook", async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "E_PAYLOAD_INVALID", "POST only");
  const raw = await req.text();
  if (!WEBHOOK_SECRET) throw new HttpError(503, "E_NOT_CONFIGURED", "STRIPE_WEBHOOK_SECRET is not set");
  const event = await verifyStripeSignature(raw, req.headers.get("stripe-signature") ?? "", WEBHOOK_SECRET);
  if (!event?.id || !event?.type) throw new HttpError(400, "E_STRIPE_SIGNATURE", "bad signature");
  if (!HANDLED.has(event.type)) return json({ ok: true, ignored: event.type });

  // store first: a repeat of an event that was processed is done; one that failed is tried again
  const { error: insErr } = await admin.from("outreach_billing_events").insert({ stripe_event_id: event.id, type: event.type, payload: event });
  if (insErr) {
    if (insErr.code !== "23505") throw new HttpError(500, "E_INTERNAL", insErr.message);
    const { data: seen } = await admin.from("outreach_billing_events").select("processed_at").eq("stripe_event_id", event.id).maybeSingle();
    if (seen?.processed_at) return json({ ok: true, duplicate: true });
  }

  try {
    const { ws, subscriptionId } = await resolveEventWorkspace(event);
    if (!ws) {
      await admin.from("outreach_billing_events").update({ processed_at: new Date().toISOString(), error: "no workspace for this event" }).eq("stripe_event_id", event.id);
      return json({ ok: true, ignored: "no workspace" });
    }
    await admin.from("outreach_billing_events").update({ workspace_id: ws.id }).eq("stripe_event_id", event.id);
    await handle(event, ws, subscriptionId);
    await admin.from("outreach_billing_events").update({ processed_at: new Date().toISOString(), error: null }).eq("stripe_event_id", event.id);
    return json({ ok: true });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    log({ fn: "stripe-webhook", event: event.id, type: event.type, error: msg });
    await admin.from("outreach_billing_events").update({ error: msg.slice(0, 1000) }).eq("stripe_event_id", event.id);
    // 500 so Stripe delivers it again (processed_at stays empty, so the repeat is handled, not skipped)
    throw new HttpError(500, "E_INTERNAL", "event not processed; Stripe will retry");
  }
});
