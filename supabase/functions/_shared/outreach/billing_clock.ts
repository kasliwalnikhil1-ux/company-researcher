// The payment-failure clock (sender-lifecycle-PRD v1.2 §5.9, D15–D18) and cancellation (§5.10). Days count from the first
// failed charge (past_due_since) whatever Stripe's retries do; each step runs once (outreach_billing_steps); emails leave at
// 10:00 in the workspace's timezone. The hourly billing job calls runBillingSteps(); the Stripe webhook calls it for one
// workspace right after a failed charge so the day-0 email does not wait for the hour.
//
// Rollout (PRD §11 phase 5): while the flag billing_clock_enforce is false the mechanical steps (suspend, remove, erase)
// are recorded and the operators are alerted with the date the step would have acted on, but nothing is paused, removed
// or deleted; the emails go out. The existing hourly tick still suspends on day 7 when billing_enforced is on.
import { admin, log, rpc, flag } from "./supabase.ts";
import { emailBillingNotice, billingRecipients, platformAlert, type BillingNoticeKind } from "./billing_emails.ts";
import { notifyRemovalBilling, notifyReconnectAfterBilling } from "./lifecycle.ts";
import { processAccountDeletions } from "./disconnect.ts";

type Row = Record<string, any>;

const STEP_NOTICE: Record<string, BillingNoticeKind | null> = {
  d0: "payment_failed", d3: "past_due_reminder", d6: "suspension_tomorrow", suspend: "suspended", d14: "removal_warning", remove: "accounts_removed", d60: "deletion_warning", erase: null,
  cancel_remove: null, cancel_d53: "cancel_data_7d", cancel_erase: null,
};
const MECHANICAL = new Set(["suspend", "remove", "erase", "cancel_remove", "cancel_erase"]);

/** Run every due step (all workspaces, or one). */
export async function runBillingSteps(workspaceId?: string): Promise<Row> {
  const out: Row = { steps: [] as string[], emails: 0, blocked: [] as string[], errors: [] as string[] };
  const enforce = (await flag("billing_clock_enforce", false)) === true;
  const due = ((await rpc<Row[]>("billing_steps_due")) ?? []).filter((d) => !workspaceId || d.workspace_id === workspaceId);
  for (const d of due) {
    try {
      const claimed = await rpc<boolean>("billing_step_claim", { p_ws: d.workspace_id, p_period: d.period_start, p_step: d.step, p_data: { day: d.day, enforced: enforce || !MECHANICAL.has(d.step) } });
      if (!claimed) continue;
      const ctx = (await rpc<Row>("billing_email_context", { p_ws: d.workspace_id }).catch(() => ({}))) ?? {};
      const data = { ...(d.data ?? {}), ...ctx };
      let applied: Row | null = null;
      if (MECHANICAL.has(d.step)) {
        if (enforce) {
          applied = await rpc<Row>("billing_step_apply", { p_ws: d.workspace_id, p_step: d.step });
          if (d.step === "remove" || d.step === "cancel_remove") await processAccountDeletions(60).catch(() => null);
        } else {
          out.blocked.push(`${d.workspace_id}:${d.step}`);
          await platformAlert(`Billing clock: ${d.step} is due for ${String(data.name ?? d.workspace_id)} (emails-only mode)`, [
            `Day ${d.day} since ${d.period_start}. The flag billing_clock_enforce is false, so nothing was ${d.step === "suspend" ? "suspended" : d.step.includes("remove") ? "removed" : "deleted"}.`,
            "Turn the flag on in Settings → Admin → Billing once the dates have been checked for a week (sender-lifecycle-PRD §11 phase 5).",
          ], { workspace_id: d.workspace_id, step: d.step, period_start: d.period_start });
        }
      }
      const kind = STEP_NOTICE[d.step];
      if (kind && (enforce || !MECHANICAL.has(d.step) || d.step === "suspend" || d.step === "remove")) {
        out.emails += await emailBillingNotice(d.workspace_id, kind, data, `billing:${d.workspace_id}:${String(d.period_start).slice(0, 19)}:${d.step}`);
      }
      // day 14: each account's holder who is not already on the billing list (§5.9.2)
      if (d.step === "d14") {
        const recips = await billingRecipients(d.workspace_id);
        out.emails += await notifyRemovalBilling(d.workspace_id, String(data.remove_at ?? d.data?.remove_at ?? ""), recips).catch((e) => { out.errors.push(String(e)); return 0; });
      }
      out.steps.push(`${d.workspace_id}:${d.step}${applied ? ":applied" : ""}`);
      log({ fn: "billing-clock", workspace: d.workspace_id, step: d.step, day: d.day, applied, enforce });
    } catch (e) { out.errors.push(`${d.workspace_id}:${d.step}: ${String((e as Error)?.message ?? e)}`); log({ fn: "billing-clock", workspace: d.workspace_id, step: d.step, error: String(e) }); }
  }
  return out;
}

/** Payment recovered (invoice.paid / subscription active again): resume what billing paused, email the owners and whoever signs in to each removed account. */
export async function reactivateWorkspace(workspaceId: string): Promise<Row> {
  const r = await rpc<Row>("workspace_reactivated", { p_ws: workspaceId });
  const removed = (r?.removed_senders ?? []) as Row[];
  const reconnect = await notifyReconnectAfterBilling(workspaceId, removed).catch((e) => { log({ fn: "billing-clock", warn: "reconnect emails", error: String(e) }); return 0; });
  const ctx = (await rpc<Row>("billing_email_context", { p_ws: workspaceId }).catch(() => ({}))) ?? {};
  const emails = await emailBillingNotice(workspaceId, "reactivated", { ...ctx, removed_senders: removed, sequences_without_sender: r?.sequences_without_sender ?? [] }, `billing:${workspaceId}:reactivated:${new Date().toISOString().slice(0, 10)}`);
  return { ...r, reconnect_emails: reconnect, owner_emails: emails };
}

/** The webhook saw a failed charge: record it and run the day-0 step now. */
export async function paymentFailed(workspaceId: string, invoice: Row, actionRequired = false): Promise<Row> {
  const r = await rpc<Row>("billing_payment_failed", { p_ws: workspaceId, p_invoice_id: invoice?.id ?? null, p_invoice_url: invoice?.hosted_invoice_url ?? null, p_action_required: actionRequired });
  if (actionRequired) {
    const ctx = (await rpc<Row>("billing_email_context", { p_ws: workspaceId }).catch(() => ({}))) ?? {};
    await emailBillingNotice(workspaceId, "payment_action_required", { ...ctx, pay_url: invoice?.hosted_invoice_url ?? null }, `billing:${workspaceId}:action_required:${invoice?.id ?? Date.now()}`);
    return r;
  }
  const steps = await runBillingSteps(workspaceId);
  return { ...r, steps };
}

/** The day-67 / cancellation deletion email: sent to the owners captured before the purge (the daily job calls it). */
export async function notifyDataDeleted(workspaceId: string, recipients: string[], name: string): Promise<number> {
  if (!recipients.length) return 0;
  return emailBillingNotice(workspaceId, "data_deleted", { name }, `billing:${workspaceId}:data_deleted`, recipients);
}

/** Stripe details for the day-0 email (amount, card, reason) when the invoice is at hand. */
export function invoiceFacts(inv: Row | null | undefined): Row {
  if (!inv) return {};
  const cents = Number(inv.amount_due ?? inv.amount_remaining ?? 0);
  const cur = String(inv.currency ?? "usd").toUpperCase();
  const amount = cents ? `${(cents / 100).toFixed(2)} ${cur}` : null;
  const pm = inv.payment_intent?.last_payment_error ?? inv.last_finalization_error ?? null;
  return { amount, card_last4: inv.payment_intent?.payment_method?.card?.last4 ?? inv.charge?.payment_method_details?.card?.last4 ?? null, reason: pm?.message ?? pm?.decline_code ?? null, pay_url: inv.hosted_invoice_url ?? null };
}

export const _test = { STEP_NOTICE, MECHANICAL };
void admin;
