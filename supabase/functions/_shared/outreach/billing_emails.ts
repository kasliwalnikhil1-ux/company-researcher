// Emails the billing lifecycle sends to workspace owners and billing contacts (sender-lifecycle-PRD v1.2 §5.9–§5.10, D16;
// pricing-billing-PRD §5 for the trial): every one goes through the outbox with its catalogue type, from the platform
// domain, and cannot be turned off. Recipients come from outreach_billing_recipients (owners' sign-in emails + the extra
// contacts). Platform alerts go to the operator address OUTREACH_PLATFORM_ALERT_EMAIL.
import { admin, log, rpc, WEB_ORIGIN } from "./supabase.ts";
import { button, esc, layout, sendEmail } from "./notify.ts";
import type { EmailType } from "./email.ts";

const BILLING_URL = `${WEB_ORIGIN}/outreach/billing`;
const ALERT_TO = (Deno.env.get("OUTREACH_PLATFORM_ALERT_EMAIL") ?? "").trim();

export type BillingNoticeKind =
  | "trial_ends_soon" | "trial_ends_tomorrow" | "trial_expired" | "trial_data_23d" | "trial_data_7d" | "trial_data_1d"
  | "payment_failed" | "past_due_reminder" | "suspension_tomorrow" | "suspended" | "removal_warning" | "accounts_removed" | "deletion_warning" | "data_deleted" | "reactivated"
  | "plan_ending" | "cancel_data_30d" | "cancel_data_7d" | "cancel_data_1d" | "subscription_cancelled" | "payment_action_required";

/** The catalogue key for each notice. */
export const NOTICE_TYPE: Record<BillingNoticeKind, EmailType> = {
  trial_ends_soon: "billing_trial_ending", trial_ends_tomorrow: "billing_trial_ending", trial_expired: "billing_trial_expired",
  trial_data_23d: "billing_trial_data_warning", trial_data_7d: "billing_trial_data_warning", trial_data_1d: "billing_trial_data_warning",
  payment_failed: "billing_payment_failed", past_due_reminder: "billing_reminder", suspension_tomorrow: "billing_suspension_tomorrow", suspended: "billing_suspended",
  removal_warning: "billing_removal_warning", accounts_removed: "billing_accounts_removed", deletion_warning: "billing_deletion_warning", data_deleted: "billing_data_deleted",
  reactivated: "billing_reactivated", plan_ending: "billing_plan_ending", cancel_data_30d: "billing_deletion_warning", cancel_data_7d: "billing_deletion_warning", cancel_data_1d: "billing_deletion_warning",
  subscription_cancelled: "billing_subscription_cancelled", payment_action_required: "billing_action_required",
};

export async function billingRecipients(workspaceId: string): Promise<string[]> {
  const r = await rpc<string[]>("billing_recipients", { p_ws: workspaceId }).catch(() => null);
  return (r ?? []).map((e) => String(e).toLowerCase());
}

const day = (iso: unknown, tz = "UTC"): string => {
  const d = new Date(String(iso ?? ""));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: tz });
};
const channel = (p: unknown): string => ({ LINKEDIN: "LinkedIn account", INSTAGRAM: "Instagram account", WHATSAPP: "WhatsApp number", GMAIL: "mailbox", OUTLOOK: "mailbox", IMAP: "mailbox" } as Record<string, string>)[String(p ?? "")] ?? "account";

/** Subject, body and button for one notice. Copy follows the PRD's own wording where it gives any. */
export function billingNoticeContent(kind: BillingNoticeKind, d: Record<string, unknown>, workspaceName: string): { subject: string; html: string; cta: [string, string]; cta2?: [string, string] } {
  const ws = esc(workspaceName);
  const tz = String(d.tz ?? "UTC");
  const acct = d.account ? `<strong>${esc(d.account)}</strong>` : `your ${channel(d.provider)}`;
  const kept = "Your sequences, leads and conversations stay exactly as they are.";
  const pay = String(d.overdue_invoice_url ?? d.pay_url ?? BILLING_URL);
  const owner = esc(d.owner_name ?? "the workspace owner");
  switch (kind) {
    case "trial_ends_soon":
      return { subject: "Your trial ends in 2 days", cta: ["Subscribe", `${BILLING_URL}/change`],
        html: `<p>Your trial of ${ws} ends on ${esc(day(d.trial_ends_at, tz))}. Subscribe to keep your account connected.</p><p>${kept}</p>` };
    case "trial_ends_tomorrow":
      return { subject: `Tomorrow your ${channel(d.provider)} will be disconnected`, cta: ["Subscribe", `${BILLING_URL}/change`],
        html: `<p>Your trial of ${ws} ends tomorrow. Without a subscription, ${acct} is disconnected at that point and nothing more is sent.</p><p>${kept} Subscribe and it carries on without a break.</p>` };
    case "trial_expired":
      return { subject: "Your trial has ended", cta: ["Subscribe and reconnect", `${BILLING_URL}/change`],
        html: `<p>The trial of ${ws} has ended and your account is disconnected. Nothing is being sent.</p><p>Everything is still here until ${esc(day(d.data_delete_after, tz))}: subscribe, reconnect the account, and your sequences pick up where they stopped.</p>` };
    case "trial_data_23d": case "trial_data_7d": case "trial_data_1d":
      return { subject: kind === "trial_data_1d" ? "Your workspace is deleted tomorrow" : `Your workspace is deleted in ${esc(d.days_left)} days`, cta: ["Subscribe", `${BILLING_URL}/change`],
        html: `<p>The trial of ${ws} ended and nobody subscribed. Its sequences, leads and conversations are deleted on ${esc(day(d.data_delete_after, tz))}.</p><p>Subscribe before then and reconnect your account to keep everything.</p>` };
    case "payment_failed":
      return { subject: "Your payment failed", cta: ["Pay invoice", pay], cta2: ["Update card", BILLING_URL],
        html: `<p>We could not take the payment for ${ws}${d.amount ? ` (${esc(d.amount)})` : ""}${d.card_last4 ? `, card ending ${esc(d.card_last4)}` : ""}.${d.reason ? ` The bank said: ${esc(d.reason)}.` : ""}</p>
               <p>Nothing changes today. If it is still unpaid on <b>${esc(day(d.suspend_at, tz))}</b>, sending stops and the workspace becomes read-only. Connected accounts are disconnected on ${esc(day(d.remove_at, tz))} and the workspace data deleted on ${esc(day(d.erase_at, tz))}.</p>
               <p><b>Pay invoice</b> charges the open invoice now, without logging in. <b>Update card</b> changes the card for the next attempt.</p>` };
    case "past_due_reminder":
      return { subject: "Reminder: your payment is still open", cta: ["Pay invoice", pay], cta2: ["Update card", BILLING_URL],
        html: `<p>The payment for ${ws} has been open since ${esc(day(d.past_due_since, tz))}. Sending stops on <b>${esc(day(d.suspend_at, tz))}</b> unless it is paid before then.</p>` };
    case "suspension_tomorrow":
      return { subject: "Sending stops tomorrow", cta: ["Pay invoice", pay], cta2: ["Update card", BILLING_URL],
        html: `<p>The invoice for ${ws} is still unpaid. Tomorrow, ${esc(day(d.suspend_at, tz))}, sending stops and the workspace becomes read-only until it is paid.</p><p>Replies keep arriving; nothing is deleted.</p>` };
    case "suspended":
      return { subject: "Your workspace is paused", cta: ["Pay invoice", pay], cta2: ["Update card", BILLING_URL],
        html: `<p>${ws} is paused because the invoice is still unpaid. Nothing is sent, nothing can be edited or enrolled; your inbox, leads, reports and exports stay readable.</p>
               <p>Replies keep arriving; pay to answer them. Connected accounts are disconnected on <b>${esc(day(d.remove_at, tz))}</b> (history kept) and the workspace data deleted on ${esc(day(d.erase_at, tz))}.</p>` };
    case "removal_warning":
      return { subject: `Your connected accounts will be disconnected on ${day(d.remove_at, tz)}`, cta: ["Pay invoice", pay], cta2: ["Update card", BILLING_URL],
        html: `<p>${ws} has been paused for a week. On <b>${esc(day(d.remove_at, tz))}</b> every connected account is disconnected. Your history is kept: conversations, who was contacted, every report number.</p><p>Pay before then and nothing happens.</p>` };
    case "accounts_removed":
      return { subject: "Your connected accounts were disconnected", cta: ["Pay invoice", pay], cta2: ["Update card", BILLING_URL],
        html: `<p>The accounts connected to ${ws} were disconnected today because the invoice is still unpaid. Their stored sign-ins were deleted; their history is kept.</p>
               <p>Pay before <b>${esc(day(d.erase_at, tz))}</b> and whoever signs in to each account gets a link to reconnect it; its history comes back when they do. After that date the workspace data is deleted.</p>` };
    case "deletion_warning":
      return { subject: `Your workspace data will be deleted on ${day(d.data_delete_after, tz)}`, cta: ["Pay invoice", pay], cta2: ["Export everything", `${WEB_ORIGIN}/outreach/settings/workspace`],
        html: `<p>The sequences, leads and conversations of ${ws} are deleted on <b>${esc(day(d.data_delete_after, tz))}</b>. Pay, or export before then.</p>` };
    case "data_deleted":
      return { subject: "Your workspace data was deleted", cta: ["Start again", `${BILLING_URL}/change`],
        html: `<p>The data of ${ws} was deleted today, as announced. A new subscription starts with an empty workspace.</p>` };
    case "reactivated": {
      const removed = Array.isArray(d.removed_senders) ? (d.removed_senders as Array<Record<string, unknown>>) : [];
      const seqs = Array.isArray(d.sequences_without_sender) ? (d.sequences_without_sender as Array<Record<string, unknown>>) : [];
      return { subject: "Payment received — your workspace is back", cta: ["Open the workspace", `${WEB_ORIGIN}/outreach`],
        html: `<p>Thanks, the payment for ${ws} went through. Paused senders resumed; the planner spreads what was waiting over the next days.</p>` +
          (removed.length ? `<p><b>Accounts to reconnect</b> (disconnected while paused; whoever signs in to each one has been emailed a link): ${removed.map((r) => esc(r.name)).join(", ")}. Their history comes back when they sign in. Add them back to the sequences you want.</p>` : "") +
          (seqs.length ? `<p><b>Sequences without a sender:</b> ${seqs.map((q) => esc(q.name)).join(", ")}.</p>` : "") };
    }
    case "plan_ending":
      return { subject: `Your plan ends on ${day(d.current_period_end, tz)}`, cta: ["Keep it", BILLING_URL],
        html: `<p>The subscription of ${ws} was cancelled and ends on <b>${esc(day(d.current_period_end, tz))}</b>. Everything works until then. After that date the connected accounts are disconnected and the workspace is read-only for 60 days, then deleted.</p>` };
    case "payment_action_required":
      return { subject: "Confirm your payment", cta: ["Confirm the payment", pay],
        html: `<p>The payment for ${ws} is waiting for a confirmation from your bank. Open the invoice and confirm it; the payment goes through at once.</p>` };
    case "subscription_cancelled":
      return { subject: "Your subscription has ended", cta: ["Subscribe again", `${BILLING_URL}/change`],
        html: `<p>The subscription of ${ws} has ended. The connected accounts were disconnected (history kept) and the workspace is read-only.</p><p>Your data is kept until ${esc(day(d.data_delete_after, tz))}. Subscribe again before then and everything comes back; ${owner} reconnects the accounts.</p>` };
    case "cancel_data_30d": case "cancel_data_7d": case "cancel_data_1d":
      return { subject: kind === "cancel_data_1d" ? "Your workspace is deleted tomorrow" : `Your workspace is deleted in ${esc(d.days_left)} days`, cta: ["Subscribe again", `${BILLING_URL}/change`], cta2: ["Export everything", `${WEB_ORIGIN}/outreach/settings/workspace`],
        html: `<p>The subscription of ${ws} ended. Its sequences, leads and conversations are deleted on ${esc(day(d.data_delete_after, tz))}.</p><p>Subscribe again before then to keep everything, or export it.</p>` };
  }
}

/** Render one notice and queue it to the owners and billing contacts (or `to`). Returns how many were queued. */
export async function emailBillingNotice(workspaceId: string, kind: BillingNoticeKind, data: Record<string, unknown>, idempotencyKey: string, to?: string[]): Promise<number> {
  const { data: ws } = await admin.from("outreach_workspaces").select("name").eq("id", workspaceId).maybeSingle();
  const c = billingNoticeContent(kind, data, String(data.name ?? ws?.name ?? "your workspace"));
  const html = layout(esc(c.subject), `${c.html}<p style="margin:20px 0">${button(c.cta[1], c.cta[0])}${c.cta2 ? ` &nbsp; ${button(c.cta2[1], c.cta2[0])}` : ""}</p><p style="font-size:12px;color:#777">Payments are non-refundable. You can cancel any time and keep access until the end of the period you paid for.</p>`);
  let sent = 0;
  for (const addr of to ?? await billingRecipients(workspaceId)) {
    if (await sendEmail(addr, c.subject, html, undefined, { type: NOTICE_TYPE[kind], workspaceId, idempotencyKey: `${idempotencyKey}:${addr}`, data: { kind } })) sent++;
  }
  log({ fn: "billing-notice", workspace: workspaceId, kind, sent });
  return sent;
}

/** Send one billing notice to the workspace owners, once (claimed in outreach_billing_notices). Returns how many emails went out. */
export async function sendBillingNotice(workspaceId: string, kind: BillingNoticeKind, periodKey: string, data: Record<string, unknown> = {}): Promise<number> {
  let claimed = false;
  try { claimed = await rpc<boolean>("billing_notice_claim", { p_ws: workspaceId, p_kind: kind, p_period_key: periodKey }); }
  catch (e) { log({ fn: "billing-notice", error: String((e as Error)?.message ?? e), workspace: workspaceId, kind }); return 0; }
  if (!claimed) return 0;
  const ctx = await rpc<Record<string, unknown>>("billing_email_context", { p_ws: workspaceId }).catch(() => ({} as Record<string, unknown>));
  return emailBillingNotice(workspaceId, kind, { ...ctx, ...data }, `${NOTICE_TYPE[kind]}:${workspaceId}:${periodKey}:${kind}`);
}

/** Operator alert (account swaps, connector deletes stuck for a day, reconciliation, disputes). Logged always; emailed when an address is set. */
export async function platformAlert(subject: string, lines: string[], data: unknown = null): Promise<void> {
  log({ fn: "billing-alert", subject, lines, data });
  if (!ALERT_TO) return;
  const html = layout(esc(subject), `${lines.map((l) => `<p>${esc(l)}</p>`).join("")}${data ? `<pre style="font-size:12px;background:#f6f6f6;padding:12px;border-radius:8px;white-space:pre-wrap">${esc(JSON.stringify(data, null, 2).slice(0, 4000))}</pre>` : ""}`);
  await sendEmail(ALERT_TO, `[Outreach billing] ${subject}`, html, undefined, { type: "platform_alert", idempotencyKey: `platform_alert:${subject.slice(0, 80)}:${new Date().toISOString().slice(0, 13)}` });
}
