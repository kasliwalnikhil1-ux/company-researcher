// Transactional email via Resend (reconnect needed, paused, digest). No-op when RESEND_API_KEY is unset.
import { admin, log, WEB_ORIGIN, audit } from "./supabase.ts";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("OUTREACH_EMAIL_FROM") ?? Deno.env.get("EMAIL_FROM") ?? "CapitalxAI Outreach <no-reply@capitalxai.com>";

export type NotifyKind = "reconnect_needed" | "reconnect_needed_manual" | "sender_paused" | "sender_error" | "invite" | "digest" | "level_up";

export async function sendEmail(to: string, subject: string, html: string, text?: string): Promise<boolean> {
  if (!RESEND_KEY) { log({ fn: "notify", skipped: "RESEND_API_KEY unset", to, subject }); return false; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html, text: text ?? html.replace(/<[^>]+>/g, " ") }),
  });
  if (!res.ok) { log({ fn: "notify", error: await res.text(), to, subject }); return false; }
  return true;
}

function layout(title: string, body: string): string {
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
  <h2 style="margin:0 0 12px;font-size:18px">${title}</h2>
  <div style="font-size:14px;line-height:1.6">${body}</div>
  <p style="margin-top:24px;font-size:12px;color:#777">CapitalxAI Outreach · This platform is not affiliated with LinkedIn. Session tokens are held on your behalf and can be revoked at any time from LinkedIn settings.</p>
</div>`;
}

/** Notify a sender's owner / workspace owners about a sender event. */
export async function notifySender(senderId: string, kind: NotifyKind, extra: Record<string, unknown> = {}): Promise<void> {
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, display_name, owner_email, owner_user_id, status, provider, unipile_account_id").eq("id", senderId).maybeSingle();
  if (!s) return;
  const recipients = new Set<string>();
  if (s.owner_email) recipients.add(String(s.owner_email));
  const { data: owners } = await admin.from("outreach_members").select("email").eq("workspace_id", s.workspace_id).in("role", ["owner", "manager"]);
  for (const o of owners ?? []) if (o.email) recipients.add(String(o.email));
  if (recipients.size === 0) return;
  const name = s.display_name ?? "your sender";
  const senderUrl = `${WEB_ORIGIN}/outreach/senders/${s.id}`;
  let subject = "", html = "";
  switch (kind) {
    case "reconnect_needed":
      subject = `Action needed: reconnect ${name}`;
      html = layout(`${name} needs to be reconnected`, `<p>LinkedIn ended the session for <b>${name}</b>. Outreach is paused for this sender until it is reconnected.</p><p><a href="${(extra.link as string) ?? senderUrl}" style="background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reconnect now</a></p><p>Log in with your own credentials; the password is never shared with the agency.</p>`);
      break;
    case "reconnect_needed_manual":
      subject = `Automatic reconnect failed for ${name}`;
      html = layout(`We could not reconnect ${name} automatically`, `<p>We tried to restore the session ${extra.attempts ?? 4} times using the browser extension without success.</p><p>Please open LinkedIn in the browser where the extension is installed and make sure you are logged in as <b>${name}</b>, or use the re-login link on the sender page.</p><p><a href="${senderUrl}">Open sender page</a></p>`);
      break;
    case "sender_paused":
      subject = `${name} paused: ${extra.reason ?? "safety"}`;
      html = layout(`${name} has been paused`, `<p>Reason: <b>${extra.reason ?? "health score below 50"}</b>.</p><p>Paused until ${extra.until ?? "the next health check"}. Nothing will be sent from this sender in the meantime.</p><p><a href="${senderUrl}">Review sender health</a></p>`);
      break;
    case "sender_error":
      subject = `${name} is in error state`;
      html = layout(`${name} stopped syncing`, `<p>Unipile reported repeated errors for this sender (${extra.reason ?? "ERROR"}). Try a resync from the sender page; if it persists, reconnect.</p><p><a href="${senderUrl}">Open sender page</a></p>`);
      break;
    case "level_up":
      subject = `${name} moved to warmup level ${extra.level}`;
      html = layout(`Warmup level increased`, `<p><b>${name}</b> kept a health score ≥ 85 for 14 days and is now at level ${extra.level}. Daily caps have been raised accordingly.</p>`);
      break;
    default:
      subject = `Update for ${name}`;
      html = layout(subject, `<pre>${JSON.stringify(extra, null, 2)}</pre>`);
  }
  for (const to of recipients) await sendEmail(to, subject, html);
  await audit(s.workspace_id, `notify.${kind}`, "sender", s.id, { recipients: [...recipients], ...extra });
}

export async function notifyInvitation(to: string, workspaceName: string, token: string, role: string): Promise<boolean> {
  const link = `${WEB_ORIGIN}/outreach/invite/${token}`;
  return sendEmail(to, `You're invited to ${workspaceName} on CapitalxAI Outreach`,
    layout(`Join ${workspaceName}`, `<p>You have been invited as <b>${role.replace("_", " ")}</b>.</p><p><a href="${link}" style="background:#4f46e5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Accept invitation</a></p><p>This link expires in 7 days. Sign in (or sign up) with <b>${to}</b> to accept.</p>`));
}
