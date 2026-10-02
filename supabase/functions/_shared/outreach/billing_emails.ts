// Emails the billing lifecycle sends to workspace owners (pricing-billing-PRD §5): trial ending, trial ended, payment failed,
// suspended, data about to be deleted. Each is sent once (claimed in outreach_billing_notices). Platform alerts go to the
// operator address OUTREACH_PLATFORM_ALERT_EMAIL. No-ops and logs when email is not configured.
import { admin, log, rpc, WEB_ORIGIN } from "./supabase.ts";
import { button, esc, layout, sendEmail } from "./notify.ts";

const BILLING_URL = `${WEB_ORIGIN}/outreach/billing`;
const ALERT_TO = (Deno.env.get("OUTREACH_PLATFORM_ALERT_EMAIL") ?? "").trim();

export type BillingNoticeKind =
  | "trial_ends_soon" | "trial_ends_tomorrow" | "trial_expired" | "trial_data_23d" | "trial_data_7d" | "trial_data_1d"
  | "payment_failed" | "past_due_reminder" | "suspended" | "cancel_data_30d" | "cancel_data_7d" | "cancel_data_1d"
  | "subscription_cancelled" | "payment_action_required";

async function owners(workspaceId: string): Promise<string[]> {
  const { data } = await admin.from("outreach_members").select("user_id, email").eq("workspace_id", workspaceId).eq("role", "owner");
  const out = new Set<string>();
  for (const m of data ?? []) {
    let email = m.email ? String(m.email) : "";
    if (!email) { try { email = (await admin.auth.admin.getUserById(m.user_id)).data?.user?.email ?? ""; } catch { /* skip */ } }
    if (email) out.add(email.trim().toLowerCase());
  }
  return [...out];
}

const day = (iso: unknown): string => {
  const d = new Date(String(iso ?? ""));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};
const channel = (p: unknown): string => ({ LINKEDIN: "LinkedIn account", INSTAGRAM: "Instagram account", WHATSAPP: "WhatsApp number", GMAIL: "mailbox", OUTLOOK: "mailbox", IMAP: "mailbox" } as Record<string, string>)[String(p ?? "")] ?? "account";

/** Subject, body and button for one notice. Copy follows the PRD's own wording where it gives any. */
export function billingNoticeContent(kind: BillingNoticeKind, d: Record<string, unknown>, workspaceName: string): { subject: string; html: string; cta: [string, string] } {
  const ws = esc(workspaceName);
  const acct = d.account ? `<strong>${esc(d.account)}</strong>` : `your ${channel(d.provider)}`;
  const kept = "Your sequences, leads and conversations stay exactly as they are.";
  switch (kind) {
    case "trial_ends_soon":
      return { subject: "Your trial ends in 2 days", cta: ["Subscribe", `${BILLING_URL}/change`],
        html: `<p>Your trial of ${ws} ends on ${esc(day(d.trial_ends_at))}. Subscribe to keep your account connected.</p><p>${kept}</p>` };
    case "trial_ends_tomorrow":
      return { subject: `Tomorrow your ${channel(d.provider)} will be disconnected`, cta: ["Subscribe", `${BILLING_URL}/change`],
        html: `<p>Your trial of ${ws} ends tomorrow. Without a subscription, ${acct} is disconnected at that point and nothing more is sent.</p><p>${kept} Subscribe and it carries on without a break.</p>` };
    case "trial_expired":
      return { subject: "Your trial has ended", cta: ["Subscribe and reconnect", `${BILLING_URL}/change`],
        html: `<p>The trial of ${ws} has ended and your account is disconnected. Nothing is being sent.</p><p>Everything is still here until ${esc(day(d.data_delete_after))}: subscribe, reconnect the account, and your sequences pick up where they stopped.</p>` };
    case "trial_data_23d": case "trial_data_7d": case "trial_data_1d":
      return { subject: kind === "trial_data_1d" ? "Your workspace is deleted tomorrow" : `Your workspace is deleted in ${esc(d.days_left)} days`, cta: ["Subscribe", `${BILLING_URL}/change`],
        html: `<p>The trial of ${ws} ended and nobody subscribed. Its sequences, leads and conversations are deleted on ${esc(day(d.data_delete_after))}.</p><p>Subscribe before then and reconnect your account to keep everything.</p>` };
    case "payment_failed":
      return { subject: "Your payment didn't go through", cta: ["Pay now", String(d.pay_url ?? BILLING_URL)],
        html: `<p>We couldn't take the payment for ${ws}. We'll try the card again over the next days.</p><p>Nothing changes for now. If the payment is still open after 7 days, sending pauses until it is paid.</p>` };
    case "past_due_reminder":
      return { subject: "Reminder: your payment is still open", cta: ["Pay now", BILLING_URL],
        html: `<p>The payment for ${ws} has been open since ${esc(day(d.past_due_since))}. Sending pauses 7 days after the first failed attempt.</p><p>Update the card or pay the invoice and everything carries on.</p>` };
    case "suspended":
      return { subject: "Sending is paused until your invoice is paid", cta: ["Pay now", BILLING_URL],
        html: `<p>${ws} is suspended because the invoice is still unpaid. Senders are paused and the workspace is read-only.</p><p>Nothing is lost. As soon as the payment goes through, the senders resume on their own.</p>` };
    case "payment_action_required":
      return { subject: "Your bank needs you to confirm a payment", cta: ["Confirm the payment", String(d.pay_url ?? BILLING_URL)],
        html: `<p>The payment for ${ws} is waiting for a confirmation from your bank (3-D Secure). The change you made applies as soon as it is confirmed.</p>` };
    case "subscription_cancelled":
      return { subject: "Your subscription has ended", cta: ["Subscribe again", `${BILLING_URL}/change`],
        html: `<p>The subscription of ${ws} has ended. Senders are paused and the workspace is read-only.</p><p>Your data is kept until ${esc(day(d.data_delete_after))}. Subscribe again before then and everything comes back.</p>` };
    case "cancel_data_30d": case "cancel_data_7d": case "cancel_data_1d":
      return { subject: kind === "cancel_data_1d" ? "Your workspace is deleted tomorrow" : `Your workspace is deleted in ${esc(d.days_left)} days`, cta: ["Subscribe again", `${BILLING_URL}/change`],
        html: `<p>The subscription of ${ws} ended. Its sequences, leads and conversations are deleted on ${esc(day(d.data_delete_after))}.</p><p>Subscribe again before then to keep everything.</p>` };
  }
}

/** Send one billing notice to the workspace owners, once. Returns how many emails went out (0 when already sent or email is off). */
export async function sendBillingNotice(workspaceId: string, kind: BillingNoticeKind, periodKey: string, data: Record<string, unknown> = {}): Promise<number> {
  let claimed = false;
  try { claimed = await rpc<boolean>("billing_notice_claim", { p_ws: workspaceId, p_kind: kind, p_period_key: periodKey }); }
  catch (e) { log({ fn: "billing-notice", error: String((e as Error)?.message ?? e), workspace: workspaceId, kind }); return 0; }
  if (!claimed) return 0;
  const { data: ws } = await admin.from("outreach_workspaces").select("name").eq("id", workspaceId).maybeSingle();
  const c = billingNoticeContent(kind, data, ws?.name ?? "your workspace");
  const html = layout(esc(c.subject), `${c.html}<p style="margin:20px 0">${button(c.cta[1], c.cta[0])}</p><p style="font-size:12px;color:#777">Payments are non-refundable. You can cancel any time and keep access until the end of the period you paid for.</p>`);
  let sent = 0;
  for (const to of await owners(workspaceId)) if (await sendEmail(to, c.subject, html)) sent++;
  log({ fn: "billing-notice", workspace: workspaceId, kind, sent });
  return sent;
}

/** Operator alert (account swaps, connector deletes stuck for a day, reconciliation, disputes). Logged always; emailed when an address is set. */
export async function platformAlert(subject: string, lines: string[], data: unknown = null): Promise<void> {
  log({ fn: "billing-alert", subject, lines, data });
  if (!ALERT_TO) return;
  const html = layout(esc(subject), `${lines.map((l) => `<p>${esc(l)}</p>`).join("")}${data ? `<pre style="font-size:12px;background:#f6f6f6;padding:12px;border-radius:8px;white-space:pre-wrap">${esc(JSON.stringify(data, null, 2).slice(0, 4000))}</pre>` : ""}`);
  await sendEmail(ALERT_TO, `[Outreach billing] ${subject}`, html);
}
