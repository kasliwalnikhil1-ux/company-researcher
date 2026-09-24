// Transactional email via Resend (reconnect needed, paused, alerts, digests, client reports). No-op when RESEND_API_KEY is unset.
// Every email is branded from outreach_workspaces.branding (item 23). Emails that can reach client viewers never show the
// platform name when branding.hide_platform_name is true.
import { admin, log, WEB_ORIGIN, audit } from "./supabase.ts";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("OUTREACH_EMAIL_FROM") ?? Deno.env.get("EMAIL_FROM") ?? "GrowthxAI Outreach <no-reply@capitalxai.com>";
const PLATFORM_NAME = "GrowthxAI Outreach";

export function emailConfigured(): boolean { return !!RESEND_KEY; }

export type NotifyKind = "reconnect_needed" | "reconnect_needed_manual" | "sender_paused" | "sender_error" | "invite" | "digest" | "level_up";
export type WorkspaceNotifyKind = "sequence_stalled" | "sender_running_dry" | "import_failed" | "weekly_digest" | "client_report" | "sender_weekly";

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
  return PLATFORM_NAME;
}

export function accentOf(b: Branding = {}): string {
  return /^#[0-9a-fA-F]{6}$/.test(String(b.accent ?? "")) ? String(b.accent) : "#4f46e5";
}

export function button(href: string, label: string, b: Branding = {}): string {
  return `<a href="${esc(href)}" data-disable-tracking="true" style="display:inline-block;background:${accentOf(b)};color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">${esc(label)}</a>`;
}

/**
 * audience 'team' = owners, managers, sender owners. 'client' = anyone outside the agency (client viewers, report recipients, invitees).
 * The platform name is only ever printed for the team, and never when hide_platform_name is on.
 */
export function layout(title: string, body: string, branding: Branding = {}, opts: { audience?: "team" | "client"; width?: number } = {}): string {
  const name = brandName(branding);
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

function platformAddress(): string { return /<([^>]+)>/.exec(FROM)?.[1] ?? FROM; }
function cleanName(n: string): string { return n.replace(/["<>\r\n]/g, "").trim(); }

/** From header for a workspace: the agency's own name/address when set, otherwise the platform sender. */
function fromHeaders(b: Branding | undefined): { primary: string; fallback: string; replyTo?: string } {
  if (!b || (!b.email_from_address && !b.email_from_name && !b.hide_platform_name && !b.product_name)) return { primary: FROM, fallback: FROM };
  const name = cleanName(b.email_from_name || b.product_name || (b.hide_platform_name ? (b.workspace_name || "Outreach") : "") || "");
  const fallback = name ? `${name} <${platformAddress()}>` : FROM;
  if (b.email_from_address) return { primary: `${name || cleanName(b.email_from_address)} <${b.email_from_address}>`, fallback, replyTo: b.email_from_address };
  return { primary: fallback, fallback, replyTo: b.support_email ?? undefined };
}

export interface SendEmailOpts { branding?: Branding; replyTo?: string }

async function resendSend(payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; error: string }> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.ok) { await res.body?.cancel(); return { ok: true, status: res.status, error: "" }; }
  return { ok: false, status: res.status, error: await res.text() };
}

export async function sendEmail(to: string, subject: string, html: string, text?: string, opts: SendEmailOpts = {}): Promise<boolean> {
  if (!RESEND_KEY) { log({ fn: "notify", skipped: "RESEND_API_KEY unset", to, subject }); return false; }
  const from = fromHeaders(opts.branding);
  const replyTo = opts.replyTo ?? from.replyTo;
  const base: Record<string, unknown> = { to: [to], subject, html, text: text ?? html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
  try {
    const firstReplyTo = opts.replyTo ?? (from.primary === from.fallback ? from.replyTo : undefined);
    let r = await resendSend({ ...base, from: from.primary, ...(firstReplyTo ? { reply_to: firstReplyTo } : {}) });
    // Resend only sends from verified domains. When the agency's own address is not verified there yet, send from the
    // platform address under the agency's name and put the agency address in Reply-To.
    if (!r.ok && from.primary !== from.fallback && (r.status === 403 || r.status === 422 || /domain|not verified|verify/i.test(r.error))) {
      log({ fn: "notify", warn: "agency from-address rejected, falling back to the platform sender", status: r.status, detail: r.error.slice(0, 200) });
      r = await resendSend({ ...base, from: from.fallback, ...(replyTo ? { reply_to: replyTo } : {}) });
    }
    if (!r.ok) { log({ fn: "notify", error: r.error.slice(0, 400), status: r.status, to, subject }); return false; }
    return true;
  } catch (e) { log({ fn: "notify", error: String((e as any)?.message ?? e), to, subject }); return false; }
}

const validEmail = (s: unknown): s is string => typeof s === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/** Owners + managers, plus a sender's alert recipients / owner, plus explicit extras. Lower-cased and de-duplicated. */
export async function workspaceRecipients(workspaceId: string, opts: { senderId?: string | null; clientId?: string | null; extra?: string[]; includeClientViewers?: boolean; team?: boolean } = {}): Promise<string[]> {
  const out = new Set<string>();
  if (opts.team !== false) {
    const { data: team } = await admin.from("outreach_members").select("email").eq("workspace_id", workspaceId).in("role", ["owner", "manager"]);
    for (const m of team ?? []) if (validEmail(m.email)) out.add(m.email.toLowerCase());
  }
  if (opts.senderId) {
    const { data: s } = await admin.from("outreach_senders").select("alert_emails").eq("id", opts.senderId).maybeSingle();
    for (const e of (s?.alert_emails ?? []) as string[]) if (validEmail(e)) out.add(e.toLowerCase());
  }
  if (opts.includeClientViewers && opts.clientId) {
    const { data: viewers } = await admin.from("outreach_members").select("email, client_ids").eq("workspace_id", workspaceId).eq("role", "client_viewer").contains("client_ids", [opts.clientId]);
    for (const v of viewers ?? []) if (validEmail(v.email)) out.add(v.email.toLowerCase());
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
  const recipients = await workspaceRecipients(workspaceId, { senderId: opts.senderId, clientId: opts.clientId, extra: opts.recipients, includeClientViewers: opts.includeClientViewers, team: opts.team ?? !isClient });
  if (!recipients.length) return { recipients, sent: 0, configured: emailConfigured() };

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

  let sent = 0;
  for (const to of recipients) if (await sendEmail(to, subject, html, undefined, { branding })) sent++;
  await audit(workspaceId, `notify.${kind}`, opts.senderId ? "sender" : opts.clientId ? "client" : "workspace", opts.senderId ?? opts.clientId ?? (data.entity_id as string | undefined) ?? workspaceId,
    { recipients, sent, subject, alert_id: data.alert_id ?? null });
  return { recipients, sent, configured: emailConfigured() };
}

/** Notify a sender's owner, its alert recipients and the workspace owners / managers about a sender event. */
export async function notifySender(senderId: string, kind: NotifyKind, extra: Record<string, unknown> = {}): Promise<void> {
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, display_name, owner_email, owner_user_id, status, provider, unipile_account_id, alert_emails").eq("id", senderId).maybeSingle();
  if (!s) return;
  const recipients = new Set<string>(await workspaceRecipients(s.workspace_id, { senderId: s.id }));
  if (validEmail(s.owner_email)) recipients.add(String(s.owner_email).toLowerCase());
  if (recipients.size === 0) return;
  const branding = await workspaceBranding(s.workspace_id);
  const name = esc(s.display_name ?? "your sender");
  const plainName = String(s.display_name ?? "your sender");
  const senderUrl = `${WEB_ORIGIN}/outreach/senders/${s.id}`;
  let subject = "", html = "";
  switch (kind) {
    case "reconnect_needed":
      subject = `Action needed: reconnect ${plainName}`;
      html = layout(`${name} needs to be reconnected`, `<p>LinkedIn ended the session for <b>${name}</b>. Outreach is paused for this sender until it is reconnected.</p><p>${button((extra.link as string) ?? senderUrl, "Reconnect now", branding)}</p><p>Log in with your own credentials; the password is never shared with the agency.</p>`, branding);
      break;
    case "reconnect_needed_manual":
      subject = `Automatic reconnect failed for ${plainName}`;
      html = layout(`We could not reconnect ${name} automatically`, `<p>We tried to restore the session ${esc(extra.attempts ?? 4)} times using the browser extension without success.</p><p>Please open LinkedIn in the browser where the extension is installed and make sure you are logged in as <b>${name}</b>, or use the re-login link on the sender page.</p><p><a href="${senderUrl}">Open sender page</a></p>`, branding);
      break;
    case "sender_paused":
      subject = `${plainName} paused: ${extra.reason ?? "safety"}`;
      html = layout(`${name} has been paused`, `<p>Reason: <b>${esc(extra.reason ?? "health score below 50")}</b>.</p><p>Paused until ${esc(extra.until ?? "the next health check")}. Nothing will be sent from this sender in the meantime.</p><p><a href="${senderUrl}">Review sender health</a></p>`, branding);
      break;
    case "sender_error":
      subject = `${plainName} is in error state`;
      html = layout(`${name} stopped syncing`, `<p>The provider reported repeated errors for this sender (${esc(extra.reason ?? "ERROR")}). Try a resync from the sender page; if it persists, reconnect.</p><p><a href="${senderUrl}">Open sender page</a></p>`, branding);
      break;
    case "level_up":
      subject = `${plainName} moved to warmup level ${extra.level}`;
      html = layout(`Warmup level increased`, `<p><b>${name}</b> kept a health score ≥ 85 for 14 days and is now at level ${esc(extra.level)}. Daily caps have been raised accordingly.</p>`, branding);
      break;
    default:
      subject = `Update for ${plainName}`;
      html = layout(esc(subject), `<pre>${esc(JSON.stringify(extra, null, 2))}</pre>`, branding);
  }
  for (const to of recipients) await sendEmail(to, subject, html, undefined, { branding });
  await audit(s.workspace_id, `notify.${kind}`, "sender", s.id, { recipients: [...recipients], ...extra });
}

export async function notifyInvitation(to: string, workspaceName: string, token: string, role: string): Promise<boolean> {
  // The invitee may be a client viewer: brand the email from the inviting workspace and never print the platform name when it is hidden.
  let branding: Branding = { workspace_name: workspaceName };
  try {
    const { data: inv } = await admin.from("outreach_invitations").select("workspace_id").eq("token", token).maybeSingle();
    if (inv?.workspace_id) branding = { ...(await workspaceBranding(inv.workspace_id)), workspace_name: workspaceName };
  } catch { /* fall back to the plain layout */ }
  const link = `${WEB_ORIGIN}/outreach/invite/${token}`;
  const named = !!branding.product_name || !!branding.hide_platform_name;
  const subject = named ? `You're invited to ${workspaceName}${branding.product_name ? ` on ${branding.product_name}` : ""}` : `You're invited to ${workspaceName} on ${PLATFORM_NAME}`;
  return sendEmail(to, subject,
    layout(`Join ${esc(workspaceName)}`, `<p>You have been invited as <b>${esc(role.replace("_", " "))}</b>.</p><p>${button(link, "Accept invitation", branding)}</p><p>This link expires in 7 days. Sign in (or sign up) with <b>${esc(to)}</b> to accept.</p>`, branding, { audience: "client" }),
    undefined, { branding });
}
