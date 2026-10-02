// Billing v2 — owner actions (pricing-billing-PRD.md §10.1). Stripe events are handled by outreach-stripe-webhook.
//   quote {plan, accounts, period, keep_sender_ids?}      price a change (or a first subscription) before confirming it
//   change {quote_id, keep_sender_ids?}                    apply it: up now (charged), down at renewal (scheduled)
//   checkout {quote_id}                                    Stripe Checkout for the first subscription
//   cancel_scheduled_change                                drop the change waiting for renewal
//   cancel {reason, comment}                               cancel at the end of the paid period
//   resume                                                 undo the cancellation
//   portal                                                 Stripe portal: payment method, invoices, tax details only
//   pay_now                                                link to the open invoice (past due)
//   abandon_payment                                        give up a change waiting for 3-D Secure
//   sync                                                   re-read the subscription from Stripe (after 3-D Secure / checkout)
// Owner only. A suspended, cancelled or lapsed workspace can still use every action here: that is how it gets out.
import { admin, HttpError, json, rateLimit, readJson, requireUser, rpc, serve } from "../_shared/outreach/supabase.ts";
import {
  abandonPendingPayment, applyChange, buildQuote, CANCEL_REASONS, cancelScheduledChange, cancelSubscription, createCheckout, hasLiveSubscription, loadWorkspace,
  parseTarget, payNowUrl, portalSession, resumeSubscription, settlePendingChange, syncWorkspaceFromStripe,
} from "../_shared/outreach/billing.ts";
import { stripeConfigured } from "../_shared/outreach/stripe.ts";

type Action = "quote" | "change" | "checkout" | "cancel_scheduled_change" | "cancel" | "resume" | "portal" | "pay_now" | "abandon_payment" | "sync";

serve("billing", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<Record<string, any>>(req);
  const action = String(body.action ?? "") as Action;
  const wsId = String(body.workspace_id ?? "");
  if (!wsId) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id required");
  const { data: m } = await admin.from("outreach_members").select("role").eq("workspace_id", wsId).eq("user_id", user.id).maybeSingle();
  if (!m) throw new HttpError(403, "E_FORBIDDEN", "not a member of this workspace");
  if (m.role !== "owner") throw new HttpError(403, "E_FORBIDDEN", "Only the workspace owner can manage billing.");
  await rateLimit(`user:${user.id}:billing`, 60, 60);
  const ws = await loadWorkspace(wsId);
  const state = () => rpc("billing_state", { p_ws: wsId });

  switch (action) {
    case "quote": {
      const target = parseTarget(body);
      const q = await buildQuote(ws, target, user.id, body.keep_sender_ids);
      return json({ ...q, has_subscription: hasLiveSubscription(ws) });
    }
    case "change": {
      const r = await applyChange(ws, String(body.quote_id ?? ""), body.keep_sender_ids, user.id);
      return json({ ...r, state: await state() });
    }
    case "checkout": {
      const r = await createCheckout(ws, String(body.quote_id ?? ""), { id: user.id, email: user.email });
      return json(r);
    }
    case "cancel_scheduled_change": {
      await cancelScheduledChange(ws, user.id);
      return json({ ok: true, state: await state() });
    }
    case "cancel": {
      const r = await cancelSubscription(ws, String(body.reason ?? ""), String(body.comment ?? ""), user.id);
      return json({ ok: true, ...r, state: await state() });
    }
    case "resume": {
      await resumeSubscription(ws, user.id);
      return json({ ok: true, state: await state() });
    }
    case "portal": return json(await portalSession(ws));
    case "pay_now": return json(await payNowUrl(ws));
    case "abandon_payment": {
      await abandonPendingPayment(ws, user.id);
      return json({ ok: true, state: await state() });
    }
    case "sync": {
      if (stripeConfigured() && ws.stripe_subscription_id) { await syncWorkspaceFromStripe(wsId); await settlePendingChange(wsId); }
      return json({ ok: true, state: await state() });
    }
    default:
      throw new HttpError(400, "E_PAYLOAD_INVALID", `unknown action ${action || "(none)"}. One of: quote, change, checkout, cancel_scheduled_change, cancel, resume, portal, pay_now, abandon_payment, sync. Cancel reasons: ${CANCEL_REASONS.join(", ")}`);
  }
});
