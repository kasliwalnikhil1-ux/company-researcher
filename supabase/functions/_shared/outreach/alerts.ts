// Disconnect alerts (sender-lifecycle-PRD v1.2 §5.8, D12–D14). The database keeps the clock on the sender row
// (disconnected_at, holder_notified_at, holder_reminders_sent, holder_email_held_until, team_notified_at); this module sends:
//   sendDueHolderEmails   sign-in email to whoever signs in to the account (at once for a sign-in account, after 4 failed
//                         cookie retries for a LinkedIn cookie account), then exactly two reminders (day 1, day 3); never
//                         while a mass-disconnect hold applies or the workspace is suspended
//   sendTeamEmails        one combined email per workspace listing every account still down 4 h after its sign-in email,
//                         at most once a day per account, a final mention at day 7; the no-double-email rule (§5.8.3)
//   announceHolds         "likely an outage" to owners and managers (workspace holds) / the operators (platform holds)
//   accountAlertsTick     F60: all three, every 15 minutes
import { admin, log, rpc, WEB_ORIGIN, audit } from "./supabase.ts";
import { notifySender, layout, esc, button, workspaceBranding, sendEmail } from "./notify.ts";
import type { EmailType } from "./email.ts";
import { platformAlert } from "./billing_emails.ts";

type Row = Record<string, any>;
const CHANNEL: Record<string, string> = { LINKEDIN: "LinkedIn", INSTAGRAM: "Instagram", WHATSAPP: "WhatsApp", GMAIL: "mailbox", OUTLOOK: "mailbox", IMAP: "mailbox" };

/** The holder emails owed now (or for one sender). A hold or a suspended workspace keeps a sender out of the list (database side). */
export async function sendDueHolderEmails(opts: { senderId?: string; limit?: number } = {}): Promise<{ first: number; reminders: number; skipped: number }> {
  const out = { first: 0, reminders: 0, skipped: 0 };
  const due = ((await rpc<Row[]>("disconnect_holder_due", { p_limit: opts.limit ?? 100 })) ?? []).filter((d) => !opts.senderId || d.sender_id === opts.senderId);
  for (const d of due) {
    try {
      const { data: s } = await admin.from("outreach_senders").select("*").eq("id", d.sender_id).maybeSingle();
      if (!s) { out.skipped++; continue; }
      const { reloginUrl } = await import("./inbound.ts");
      const link = await reloginUrl(s as never).catch(() => null);
      const cookieManual = s.auth_method === "cookie" && s.provider === "LINKEDIN";
      if (d.kind === "first") {
        await notifySender(s.id, cookieManual ? "reconnect_needed_manual" : "reconnect_needed", { link, attempts: s.reconnect_attempts });
        await rpc("disconnect_holder_mark", { p_sender: s.id, p_kind: "first" });
        out.first++;
      } else {
        await notifySender(s.id, "reconnect_reminder", { link, reminder: Number(d.reminders) + 1 });
        await rpc("disconnect_holder_mark", { p_sender: s.id, p_kind: "reminder" });
        out.reminders++;
      }
    } catch (e) { out.skipped++; log({ fn: "account-alerts", sender_id: d.sender_id, error: String((e as Error)?.message ?? e) }); }
  }
  return out;
}

/** "Send a new sign-in link" on the sender page: the holder email goes out now and the clock starts again. */
export async function resendSignIn(senderId: string): Promise<{ sent: boolean; to: string | null }> {
  const { data: s } = await admin.from("outreach_senders").select("*").eq("id", senderId).maybeSingle();
  if (!s) return { sent: false, to: null };
  const { reloginUrl } = await import("./inbound.ts");
  const link = await reloginUrl(s as never).catch(() => null);
  await notifySender(s.id, "reconnect_needed", { link, reminder: `manual-${Date.now()}` });
  await rpc("disconnect_holder_mark", { p_sender: s.id, p_kind: "reset" });
  const rec = await rpc<Row>("sender_email_recipients", { p_sender: s.id, p_kind: "holder" }).catch(() => null);
  return { sent: true, to: rec?.to ?? null };
}

const fmt = (iso: unknown, tz = "UTC") => { const d = new Date(String(iso ?? "")); return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz }); };

function holderLine(h: Row, recipientUserId: string): string {
  if (!h || h.kind === "none") return "nobody";
  if (h.kind === "outside") return `${esc(h.email)} (outside${(h.copy ?? []).length ? `, copied to ${esc((h.copy as Row[]).map((c) => c.email).join(", "))}` : ""})`;
  if (h.user_id === recipientUserId) return "You";
  return `${esc(h.name ?? h.email ?? "a teammate")} (team)`;
}

function whatToDo(s: Row, recipientUserId: string): string {
  const h = s.holder ?? {};
  if (s.bounced) return "The sign-in email bounced: check who signs in to this account and send a new link";
  if (s.provider === "WHATSAPP") return "Reconnect by scanning the QR code";
  if (h.kind === "outside") return `Ask ${esc(h.email)} to sign in again`;
  if (h.user_id === recipientUserId) return "Open the sign-in email, or send yourself a new link";
  return `Ask ${esc(h.name ?? "them")} to open the email, or send a new link`;
}

/** The combined team email per workspace (§5.8.3). */
export async function sendTeamEmails(): Promise<{ workspaces: number; emails: number; senders: number }> {
  const out = { workspaces: 0, emails: 0, senders: 0 };
  const due = (await rpc<Row[]>("disconnect_team_due")) ?? [];
  for (const w of due) {
    const senders: Row[] = w.senders ?? [];
    if (!senders.length) continue;
    out.workspaces++;
    const branding = await workspaceBranding(w.workspace_id);
    const { data: wsRow } = await admin.from("outreach_workspaces").select("settings").eq("id", w.workspace_id).maybeSingle();
    const tz = String(wsRow?.settings?.timezone ?? "UTC");
    const listed = new Set<string>();
    for (const r of (w.recipients ?? []) as Row[]) {
      // client-scoped managers only see their clients' accounts
      const visible = senders.filter((s) => r.role === "owner" || !(r.client_ids ?? []).length || !s.client_id || (r.client_ids ?? []).includes(s.client_id));
      if (!visible.length) continue;
      // no double emails: accounts this person holds themselves appear only next to others; nothing when every one is theirs
      const theirs = visible.filter((s) => s.holder?.user_id === r.user_id);
      if (theirs.length === visible.length) continue;
      const rows = visible.map((s) => `<tr>
        <td style="padding:8px;border-top:1px solid #eee"><a href="${WEB_ORIGIN}/outreach/senders/${s.id}" style="color:#111">${esc(s.name ?? "Account")}</a> (${esc(CHANNEL[String(s.provider)] ?? s.provider)})${s.days_down >= 2 ? ` <span style="color:#b45309">down ${esc(s.days_down)} days</span>` : ""}${Number(s.drops_today) >= 3 ? ` <span style="color:#b45309">unstable: dropped ${esc(s.drops_today)} times today</span>` : ""}${s.final ? ` <b style="color:#b91c1c">down for 7 days</b>` : ""}</td>
        <td style="padding:8px;border-top:1px solid #eee">${holderLine(s.holder, r.user_id)}</td>
        <td style="padding:8px;border-top:1px solid #eee;white-space:nowrap">${esc(fmt(s.disconnected_at, tz))}</td>
        <td style="padding:8px;border-top:1px solid #eee">${esc(fmt(s.holder_notified_at, tz))}${Number(s.reminders) > 0 ? ` · reminded ${esc(s.reminders)}×` : ""}${s.auth_method === "cookie" ? " (cookie retries failed)" : ""}${s.bounced ? " · <b>sign-in email bounced</b>" : ""}</td>
        <td style="padding:8px;border-top:1px solid #eee">${s.final ? "Disable it to stop these emails, or remove it" : whatToDo(s, r.user_id)}</td></tr>`).join("");
      const back = ((w.back_online ?? []) as Row[]).length ? `<p style="margin-top:16px"><b>Back online:</b> ${(w.back_online as Row[]).map((b) => esc(b.name)).join(", ")}.</p>` : "";
      const n = visible.length;
      const subject = `${n} account${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} signing in again`;
      const html = layout(esc(subject), `<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr><th style="text-align:left;padding:8px">Account</th><th style="text-align:left;padding:8px">Signs in</th><th style="text-align:left;padding:8px">Down since</th><th style="text-align:left;padding:8px">Sign-in email sent</th><th style="text-align:left;padding:8px">What to do</th></tr></thead><tbody>${rows}</tbody></table>
        <p style="margin-top:14px">Sequences on these accounts are on hold until they are back.</p>${back}
        <p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/senders?status=credentials`, "Open senders", branding)}</p>
        <p style="font-size:12px;color:#9ca3af;margin-top:14px">You get this email at most once a day while an account is down. Turn it off under Settings → Notifications → Disconnected accounts.</p>`, branding, { audience: "team", width: 720 });
      const ok = await sendEmail(r.email, subject, html, undefined, { type: "sender_disconnected_team" as EmailType, workspaceId: w.workspace_id, recipientUserId: r.user_id,
        idempotencyKey: `sender_disconnected_team:${w.workspace_id}:${new Date().toISOString().slice(0, 10)}:${r.user_id}`, data: { senders: visible.map((s) => s.id) } });
      if (ok) { out.emails++; for (const s of visible) listed.add(String(s.id)); }
    }
    if (listed.size) {
      const finals = senders.filter((s) => s.final && listed.has(String(s.id))).map((s) => String(s.id));
      await rpc("disconnect_team_mark", { p_sender_ids: [...listed], p_final_ids: finals });
      out.senders += listed.size;
      await audit(w.workspace_id, "notify.sender_disconnected_team", "workspace", w.workspace_id, { senders: [...listed], finals }, "system");
    }
  }
  return out;
}

/** Holds opened by the trigger that nobody has been told about yet (§5.8.4). */
export async function announceHolds(): Promise<number> {
  const holds = (await rpc<Row[]>("disconnect_holds_unnotified")) ?? [];
  let n = 0;
  for (const h of holds) {
    if (h.scope === "platform") {
      await platformAlert(`${h.sender_count} of ${h.live_count} live senders disconnected within an hour`, [
        "Sign-in emails to account holders are held for 2 hours across the platform (sender-lifecycle-PRD §5.8.4).",
        "This looks like a LinkedIn or connector incident, not individual accounts. Check the connector status; extend the hold once from the health page if it is still going.",
      ], { hold_id: h.id, held_until: h.held_until });
      n++; continue;
    }
    const branding = await workspaceBranding(h.workspace_id);
    const subject = `${h.sender_count} accounts disconnected within an hour`;
    const html = layout(esc(subject), `<p><b>${esc(h.sender_count)}</b> of your ${esc(h.live_count)} connected accounts disconnected within an hour. This is usually a LinkedIn or connector problem, not your accounts.</p>
      <p>We are holding the sign-in emails for 2 hours (until ${esc(fmt(h.held_until))}). Automatic reconnects keep running. Accounts that come back on their own need nothing from anyone; whoever signs in to the ones still down gets the sign-in email after the hold.</p>
      <p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/senders`, "Open senders", branding)}</p>`, branding, { audience: "team" });
    for (const r of (h.recipients ?? []) as Row[]) {
      if (!r.email) continue;
      if (await sendEmail(r.email, subject, html, undefined, { type: "sender_mass_disconnect", workspaceId: h.workspace_id, recipientUserId: r.user_id, idempotencyKey: `sender_mass_disconnect:${h.id}:${r.email}` })) n++;
    }
    await audit(h.workspace_id, "notify.sender_mass_disconnect", "workspace", h.workspace_id, { hold_id: h.id, senders: h.sender_count }, "system");
  }
  return n;
}

/** F60 (every 15 minutes, only when a sender is disconnected or a hold is unannounced). */
export async function accountAlertsTick(): Promise<Row> {
  const holds = await announceHolds().catch((e) => { log({ fn: "account-alerts", error: String(e) }); return 0; });
  const holder = await sendDueHolderEmails();
  const team = await sendTeamEmails().catch((e) => { log({ fn: "account-alerts", error: String(e) }); return { workspaces: 0, emails: 0, senders: 0 }; });
  return { holds_announced: holds, holder, team };
}
