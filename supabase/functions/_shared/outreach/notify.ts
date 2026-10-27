// Email rendering and the typed senders the workers call (reconnect needed, paused, alerts, digests, client reports).
// Sending itself lives in email.ts (one path, outbox, log, fallback); every email here names its catalogue type.
// Every email is branded from outreach_workspaces.branding (item 23). Emails that can reach client viewers never show the
// platform name when branding.hide_platform_name is true.
import { admin, log, WEB_ORIGIN, audit } from "./supabase.ts";
import { sendEmail as queueEmail, sendHolderEmail, sendTeamEmail, teamRecipients, emailConfigured, PLATFORM_NAME as PLATFORM, type EmailType } from "./email.ts";
export { emailConfigured };

export type NotifyKind = "reconnect_needed" | "reconnect_needed_manual" | "reconnect_reminder" | "sender_paused" | "sender_error" | "level_up";
export type WorkspaceNotifyKind = "sequence_stalled" | "sender_running_dry" | "import_failed" | "weekly_digest" | "client_report" | "sender_weekly" | "voice_minutes";
const PLATFORM_NAME = `${PLATFORM} Outreach`;

export interface Branding {
  workspace_name?: string | null;
  product_name?: string | null;
  logo_url?: string | null;
  accent?: string | null;
  support_email?: string | null;
  help_url?: string | null;
  email_from_name?: string | null;
  email_from_address?: string | null;
  hide_platform_name?: boolean | null;
}

export function esc(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A timestamp as people read it in an email: "28 Oct 2026" or, with time, "28 Oct 2026, 21:20 UTC" (in `tz`).
 * Anything that is not a date (e.g. "the next health check") is returned as it is.
 */
export function emailDate(v: unknown, opts: { time?: boolean; tz?: string | null } = {}): string {
  const d = new Date(String(v ?? ""));
  if (v == null || v === "" || Number.isNaN(d.getTime())) return String(v ?? "");
  const tz = opts.tz || "UTC";
  const fmt = (timeZone: string) => {
    const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone });
    if (!opts.time) return date;
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
    return `${date}, ${time} ${timeZone === "UTC" ? "UTC" : `(${timeZone.replace(/_/g, " ")})`}`;
  };
  try { return fmt(tz); } catch { return fmt("UTC"); }
}

/** The workspace's branding plus its name. Never throws. */
export async function workspaceBranding(workspaceId: string | null | undefined): Promise<Branding> {
  if (!workspaceId) return {};
  try {
    const { data } = await admin.from("outreach_workspaces").select("name, branding").eq("id", workspaceId).maybeSingle();
    return { workspace_name: data?.name ?? null, ...((data?.branding ?? {}) as Branding) };
  } catch (e) { log({ fn: "notify", warn: "branding read failed", error: String(e) }); return {}; }
}

/** Name shown in subjects, headers and footers. */
export function brandName(b: Branding = {}): string {
  if (b.product_name) return b.product_name;
  if (b.hide_platform_name) return b.workspace_name || "Outreach";
  return b.workspace_name || PLATFORM_NAME;
}

export function accentOf(b: Branding = {}): string {
  return /^#[0-9a-fA-F]{6}$/.test(String(b.accent ?? "")) ? String(b.accent) : "#4f46e5";
}

export function button(href: string, label: string, b: Branding = {}): string {
  return `<a href="${esc(href)}" data-disable-tracking="true" style="display:inline-block;background:${accentOf(b)};color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">${esc(label)}</a>`;
}

/**
 * audience 'team' = owners, managers, members. 'client' = anyone outside the agency (client viewers, report recipients, invitees, outside holders).
 * The platform name is only ever printed for the team, and never when hide_platform_name is on.
 */
export function layout(title: string, body: string, branding: Branding = {}, opts: { audience?: "team" | "client"; width?: number } = {}): string {
  const name = branding.product_name || (branding.hide_platform_name ? (branding.workspace_name || "Outreach") : PLATFORM_NAME);
  const hidePlatform = !!branding.hide_platform_name;
  const logo = branding.logo_url && /^https:\/\//.test(branding.logo_url)
    ? `<img src="${esc(branding.logo_url)}" alt="${esc(name)}" height="32" style="height:32px;max-width:200px;border:0;display:block;margin:0 0 16px"/>`
    : `<div style="font-size:13px;font-weight:700;color:${accentOf(branding)};margin:0 0 16px">${esc(name)}</div>`;
  const support = branding.support_email ? ` · Questions? <a href="mailto:${esc(branding.support_email)}" style="color:#777">${esc(branding.support_email)}</a>` : "";
  let footer: string;
  if (opts.audience === "client") footer = `${esc(name)}${support}`;
  else if (hidePlatform || branding.product_name) footer = `${esc(name)}${support} · This service is not affiliated with LinkedIn. Session tokens are held on your behalf and can be revoked at any time from LinkedIn settings.`;
  else footer = `${PLATFORM_NAME}${support} · This platform is not affiliated with LinkedIn. Session tokens are held on your behalf and can be revoked at any time from LinkedIn settings.`;
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:${opts.width ?? 560}px;margin:0 auto;padding:24px;color:#111">
  ${logo}
  <h2 style="margin:0 0 12px;font-size:18px">${title}</h2>
  <div style="font-size:14px;line-height:1.6">${body}</div>
  <p style="margin-top:24px;font-size:12px;color:#777">${footer}</p>
</div>`;
}

export interface SendEmailOpts {
  /** the catalogue key (outreach_email_types); required: it decides the domain, the audience and whether it may be turned off */
  type: EmailType;
  workspaceId?: string | null;
  clientId?: string | null;
  senderId?: string | null;
  idempotencyKey?: string | null;
  recipientUserId?: string | null;
  branding?: Branding;
  replyTo?: string;
  direct?: boolean;
  data?: Record<string, unknown>;
}

/** Queue one email for an address the caller already knows (team, client, platform types). Holder emails use notifySender / sendHolderEmail. */
export async function sendEmail(to: string, subject: string, html: string, text?: string | null, opts?: SendEmailOpts): Promise<boolean> {
  if (!opts?.type) throw new Error("sendEmail needs a catalogue type (custom-sending-domain-PRD §3)");
  const r = await queueEmail({ type: opts.type, to, subject, html, text: text ?? undefined, workspace_id: opts.workspaceId ?? null, client_id: opts.clientId ?? null, sender_id: opts.senderId ?? null,
    idempotency_key: opts.idempotencyKey ?? null, recipient_user_id: opts.recipientUserId ?? null, reply_to: opts.replyTo ?? null, direct: opts.direct, data: opts.data });
  return r.status === "queued" || r.status === "sent" || r.status === "duplicate";
}

const validEmail = (s: unknown): s is string => typeof s === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/** Owners + managers on their sign-in emails, plus a sender's alert recipients, plus explicit extras. Lower-cased and de-duplicated. */
export async function workspaceRecipients(workspaceId: string, opts: { senderId?: string | null; clientId?: string | null; extra?: string[]; includeClientViewers?: boolean; team?: boolean } = {}): Promise<string[]> {
  const out = new Set<string>();
  if (opts.team !== false) for (const p of await teamRecipients(workspaceId, { client_id: opts.clientId ?? null })) out.add(p.email);
  if (opts.senderId) {
    const { data: s } = await admin.from("outreach_senders").select("alert_emails").eq("id", opts.senderId).maybeSingle();
    for (const e of (s?.alert_emails ?? []) as string[]) if (validEmail(e)) out.add(e.toLowerCase());
  }
  if (opts.includeClientViewers && opts.clientId) {
    const { data: viewers } = await admin.from("outreach_members").select("user_id, client_ids").eq("workspace_id", workspaceId).eq("role", "client_viewer").contains("client_ids", [opts.clientId]);
    for (const v of viewers ?? []) {
      try { const e = (await admin.auth.admin.getUserById(v.user_id)).data?.user?.email; if (validEmail(e)) out.add(e.toLowerCase()); } catch { /* skip */ }
    }
  }
  for (const e of opts.extra ?? []) if (validEmail(e)) out.add(e.toLowerCase());
  return [...out];
}

export interface NotifyWorkspaceOpts {
  senderId?: string;
  clientId?: string;
  /** extra addresses (report schedule recipients) */
  recipients?: string[];
  /** also send to the client's client_viewer members (needs clientId) */
  includeClientViewers?: boolean;
  /** false = do not add owners and managers (client reports go to the client only) */
  team?: boolean;
  idempotencyKey?: string;
}

export interface NotifyResult { recipients: string[]; sent: number; configured: boolean }

const ALERT_COPY: Record<string, { subject: (l: string) => string; title: (l: string) => string; todo: string; cta: string }> = {
  sequence_stalled: {
    subject: (l) => `${l} has stopped sending`, title: (l) => `${esc(l)} has stopped sending`,
    todo: "Open the sequence and press \"Why isn't this sending?\" to see each cause with its fix. Usual fixes: reconnect or resume a sender, widen the working hours, or add a sender to the pool. You get one email per stall. We will tell the dashboard when it recovers.",
    cta: "Open the sequence",
  },
  sender_running_dry: {
    subject: (l) => `${l} is running out of leads`, title: (l) => `${esc(l)} is running out of leads`,
    todo: "Enrol more leads for this sender, or add an auto-enrol rule or a repeating import so the sequence stays topped up. Nothing is wrong with the account. It will simply go idle when the queue is empty.",
    cta: "Open the sender",
  },
  import_failed: {
    subject: (l) => `An import failed (${l})`, title: () => "An import failed",
    todo: "Open Leads → Import to see the job. Fix the cause named above (for example reconnect the sender or paste a valid URL) and start the import again. Leads imported before the failure are kept.",
    cta: "Open imports",
  },
};

/**
 * Email a workspace's owners and managers (+ a sender's alert_emails with opts.senderId) about something that needs them.
 * Alert kinds take data {label, reason, entity_id}; report kinds take data {subject, title, html} built by reports_email.ts.
 */
export async function notifyWorkspace(workspaceId: string, kind: WorkspaceNotifyKind, data: Record<string, unknown> = {}, opts: NotifyWorkspaceOpts = {}): Promise<NotifyResult> {
  const branding = await workspaceBranding(workspaceId);
  const isClient = kind === "client_report";
  let subject = "", html = "";
  if (kind === "sequence_stalled" || kind === "sender_running_dry" || kind === "import_failed") {
    const copy = ALERT_COPY[kind];
    const label = String(data.label ?? (kind === "import_failed" ? "import" : "Untitled"));
    const id = String(data.entity_id ?? "");
    const url = kind === "sequence_stalled" ? `${WEB_ORIGIN}/outreach/sequences/${id}` : kind === "sender_running_dry" ? `${WEB_ORIGIN}/outreach/senders/${id}` : `${WEB_ORIGIN}/outreach/leads/import`;
    subject = copy.subject(label.replace(/_/g, " "));
    html = layout(copy.title(label), `<p style="padding:12px 14px;background:#f6f6f7;border-radius:8px;margin:0 0 14px"><b>What happened.</b> ${esc(data.reason ?? "No reason recorded.")}</p><p><b>What to do.</b> ${copy.todo}</p><p style="margin-top:18px">${button(url, copy.cta, branding)}</p>`, branding, { audience: "team" });
  } else {
    subject = String(data.subject ?? `${brandName(branding)} report`);
    html = layout(esc(data.title ?? subject), String(data.html ?? ""), branding, { audience: isClient ? "client" : "team", width: 640 });
  }
  const type: EmailType = kind;
  const idem = opts.idempotencyKey ?? (data.alert_id ? `${kind}:${data.alert_id}` : undefined);
  const extra: string[] = [...(opts.recipients ?? [])];
  if (opts.senderId) {
    const { data: s } = await admin.from("outreach_senders").select("alert_emails").eq("id", opts.senderId).maybeSingle();
    for (const e of (s?.alert_emails ?? []) as string[]) if (validEmail(e)) extra.push(e.toLowerCase());
  }
  if (opts.includeClientViewers && opts.clientId) extra.push(...(await workspaceRecipients(workspaceId, { clientId: opts.clientId, includeClientViewers: true, team: false })));
  const r = await sendTeamEmail({ workspace_id: workspaceId, type, subject, html, idempotency_key: idem ?? null, sender_id: opts.senderId ?? null, client_id: opts.clientId ?? null,
    roles: (opts.team ?? !isClient) ? ["owner", "manager"] : [], user_ids: (opts.team ?? !isClient) ? undefined : [], extra, data: { alert_id: data.alert_id ?? null, entity_id: data.entity_id ?? null } });
  await audit(workspaceId, `notify.${kind}`, opts.senderId ? "sender" : opts.clientId ? "client" : "workspace", opts.senderId ?? opts.clientId ?? (data.entity_id as string | undefined) ?? workspaceId,
    { recipients: r.recipients, sent: r.queued, subject, alert_id: data.alert_id ?? null });
  return { recipients: r.recipients, sent: r.queued, configured: emailConfigured() };
}

const CHANNEL_NAME: Record<string, string> = { LINKEDIN: "LinkedIn", INSTAGRAM: "Instagram", WHATSAPP: "WhatsApp", GMAIL: "Google", OUTLOOK: "Microsoft", IMAP: "The mail server" };

// ---------------------------------------------------------------------------
// Owner links (sender-lifecycle-PRD.md §4): every holder email to an OUTSIDE holder carries "Disconnect my account", a signed
// single-use link (30 days) bound to the address it was sent to. The web app hosts the page (app/sender-link).
// ---------------------------------------------------------------------------
export function ownerLinkPageUrl(token: string): string {
  return `${WEB_ORIGIN.replace(/\/$/, "")}/sender-link?t=${encodeURIComponent(token)}`;
}

/** A fresh single-use link for an outside holder. Null for a member's own account, when the sender is gone, or when the token could not be made. */
export async function ownerLink(senderId: string, purpose: "disconnect" | "erase_request" = "disconnect", sentTo?: string | null): Promise<string | null> {
  try {
    const { data, error } = await admin.rpc("outreach_sender_owner_link_create", { p_sender: senderId, p_purpose: purpose, p_ttl_days: 30, p_sent_to: sentTo ?? null });
    if (error) { if (!/E_CONFLICT/.test(error.message)) throw new Error(error.message); return null; }
    return data ? ownerLinkPageUrl(String(data)) : null;
  } catch (e) { log({ fn: "notify", warn: "owner link not created", sender_id: senderId, error: String(e) }); return null; }
}

/** The footer line for an outside holder's copy of an email. Empty when no link could be made. */
export async function ownerDisconnectFooter(senderId: string, branding: Branding = {}, sentTo?: string | null): Promise<string> {
  const url = await ownerLink(senderId, "disconnect", sentTo);
  if (!url) return "";
  return `<p style="margin-top:28px;padding-top:12px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px">This is your account. You can <a href="${esc(url)}" data-disable-tracking="true" style="color:#6b7280">disconnect it from ${esc(brandName(branding))}</a> at any time, without logging in. The link works once, for 30 days.</p>`;
}

/**
 * Tell people about a sender event. Holder kinds (reconnect_needed, reconnect_needed_manual, reconnect_reminder) go to whoever
 * signs in to the account (sender-lifecycle §5.8.1) with the connecting member copied; team kinds go to owners, managers and
 * the sender's alert recipients on the platform domain.
 */
export async function notifySender(senderId: string, kind: NotifyKind, extra: Record<string, unknown> = {}): Promise<void> {
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, client_id, display_name, status, provider, unipile_account_id, alert_emails, auth_method, timezone").eq("id", senderId).maybeSingle();
  if (!s) return;
  const branding = await workspaceBranding(s.workspace_id);
  const name = esc(s.display_name ?? "your account");
  const plainName = String(s.display_name ?? "your account");
  const senderUrl = `${WEB_ORIGIN}/outreach/senders/${s.id}`;
  const channel = CHANNEL_NAME[String(s.provider)] ?? "The provider";
  const day = new Date().toISOString().slice(0, 10);
  if (kind === "reconnect_needed" || kind === "reconnect_reminder" || kind === "reconnect_needed_manual") {
    const link = typeof extra.link === "string" && extra.link ? extra.link : null;
    const how = s.provider === "WHATSAPP" ? "Scan the new QR code from WhatsApp → Linked devices on the phone with this number." : s.provider === "GMAIL" || s.provider === "OUTLOOK" || s.provider === "IMAP" ? "Sign in to the mailbox on the secure page that opens." : "Sign in with your own credentials on the secure page that opens; the password is never shared with anyone.";
    const reminder = kind === "reconnect_reminder";
    const manual = kind === "reconnect_needed_manual";
    const subject = manual ? `Automatic reconnect failed for ${plainName}` : reminder ? `Reminder: ${plainName} still needs to be signed in` : `Action needed: sign in to ${plainName} again`;
    const body = manual
      ? `<p>We tried to restore the session for <b>${name}</b> ${esc(extra.attempts ?? 4)} times using the browser extension without success.</p><p>Please open LinkedIn in the browser where the extension is installed and make sure you are logged in as <b>${name}</b>, or sign in again with the button below.</p>`
      : `<p>${esc(channel)} ended the session for <b>${name}</b>. Nothing is sent from this account until it is signed in again.${reminder ? " This is a reminder; the earlier email still works." : ""}</p><p>${esc(how)}</p>${link ? `<p style="font-size:12px;color:#666">The sign-in link works for 7 days. If it has expired, ask your team for a new one.</p>` : ""}`;
    await sendHolderEmail({ sender_id: s.id, type: manual ? "sender_reconnect_manual" : reminder ? "sender_reconnect_reminder" : "sender_reconnect_needed", subject, body,
      idempotency_key: `${manual ? "sender_reconnect_manual" : reminder ? "sender_reconnect_reminder" : "sender_reconnect_needed"}:${s.id}:${String(extra.reminder ?? day)}`,
      action: link ? { label: "Sign in again", url: link } : { label: "Open the sender page", url: senderUrl }, data: { reminder: extra.reminder ?? null } });
    return;
  }
  let subject = "", html = "", type: EmailType = "sender_error", idem = "";
  switch (kind) {
    case "sender_paused":
      type = "sender_paused"; subject = `${plainName} paused: ${extra.reason ?? "safety"}`; idem = `sender_paused:${s.id}:${day}:${String(extra.reason ?? "")}`;
      html = layout(`${name} has been paused`, `<p>Reason: <b>${esc(extra.reason ?? "health score below 50")}</b>.</p><p>Paused until ${esc(extra.until ? emailDate(extra.until, { time: true, tz: s.timezone }) : "the next health check")}. Nothing will be sent from this sender in the meantime.</p><p><a href="${senderUrl}">Review sender health</a></p>`, branding);
      break;
    case "sender_error":
      type = "sender_error"; subject = `${plainName} is in error state`; idem = `sender_error:${s.id}:${day}`;
      html = layout(`${name} stopped syncing`, `<p>The provider reported repeated errors for this sender (${esc(extra.reason ?? "ERROR")}). Try <strong>Refresh conversations</strong> on the sender page; if it persists, reconnect.</p><p><a href="${senderUrl}">Open sender page</a></p>`, branding);
      break;
    case "level_up":
      type = "sender_level_up"; subject = `${plainName} moved to warmup level ${extra.level}`; idem = `sender_level_up:${s.id}:${String(extra.level)}`;
      html = layout(`Warmup level increased`, `<p><b>${name}</b> kept a health score ≥ 85 for 14 days and is now at level ${esc(extra.level)}. Daily caps have been raised accordingly.</p>`, branding);
      break;
  }
  const r = await sendTeamEmail({ workspace_id: s.workspace_id, type, subject, html, idempotency_key: idem, sender_id: s.id, client_id: s.client_id, extra: ((s.alert_emails ?? []) as string[]).filter(validEmail) });
  await audit(s.workspace_id, `notify.${kind}`, "sender", s.id, { recipients: r.recipients, ...extra });
}

export async function notifyInvitation(to: string, workspaceName: string, token: string, role: string): Promise<boolean> {
  // The invitee may be a client viewer: brand the email from the inviting workspace and never print the platform name when it is hidden.
  let branding: Branding = { workspace_name: workspaceName };
  let workspaceId: string | null = null;
  try {
    const { data: inv } = await admin.from("outreach_invitations").select("workspace_id").eq("token", token).maybeSingle();
    if (inv?.workspace_id) { workspaceId = inv.workspace_id; branding = { ...(await workspaceBranding(inv.workspace_id)), workspace_name: workspaceName }; }
  } catch { /* fall back to the plain layout */ }
  const link = `${WEB_ORIGIN}/outreach/invite/${token}`;
  const named = !!branding.product_name || !!branding.hide_platform_name;
  const subject = named ? `You're invited to ${workspaceName}${branding.product_name ? ` on ${branding.product_name}` : ""}` : `You're invited to ${workspaceName} on ${PLATFORM_NAME}`;
  return sendEmail(to, subject,
    layout(`Join ${esc(workspaceName)}`, `<p>You have been invited as <b>${esc(role.replace("_", " "))}</b>.</p><p>${button(link, "Accept invitation", branding)}</p><p>This link expires in 7 days. Sign in (or sign up) with <b>${esc(to)}</b> to accept.</p>`, branding, { audience: "client" }),
    undefined, { type: role === "client_viewer" ? "client_viewer_invite" : "team_invite", workspaceId, idempotencyKey: `invite:${token}:${new Date().toISOString().slice(0, 10)}` });
}
