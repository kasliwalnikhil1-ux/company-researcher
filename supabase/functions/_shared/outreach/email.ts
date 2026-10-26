// The one sending path for every platform email (custom-sending-domain-PRD.md §5). No other module talks to Resend:
// scripts/check-email-path.mjs fails the build on any other `api.resend.com`.
//
//   sendEmail        render done by the caller (notify.ts layout) → a row in outreach_email_outbox → outbox worker sends it
//   sendHolderEmail  a holder email (sender-lifecycle-PRD v1.2 §5.8.1): the address comes from the database, never from the
//                    caller; an outside holder gets the "on behalf of … via GrowthxAI" footer and the disconnect link, the
//                    connecting member gets a "Copy: sent to …" of it; a member's own account gets "Open in GrowthxAI"
//   sendTeamEmail    owners and managers (per preference) on their sign-in emails
//   outboxTick       F27: due rows → Resend with the chosen domain's key; fallback to the platform on a domain error (§5.3)
//   sendDirect       the auth hook (§7): the user is waiting, so no queue; both attempts are still logged as outbox rows
//
// Domain choice is the database's (outreach_email_domain_for); this module only carries the From it was given.
import { admin, log, rpc, flag, WEB_ORIGIN, audit } from "./supabase.ts";
import { fetchWithHealth, noteCallError } from "../health.ts";
import { decrypt } from "./crypto.ts";

type Row = Record<string, any>;

const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const PLATFORM_FROM = Deno.env.get("OUTREACH_EMAIL_FROM") ?? Deno.env.get("EMAIL_FROM") ?? "GrowthxAI <notifications@updates.growthxai.com>";
const PLATFORM_REPLY_TO = Deno.env.get("OUTREACH_EMAIL_REPLY_TO") ?? "";
export const PLATFORM_NAME = "GrowthxAI";
const RESEND_API = "https://api.resend.com";

export function emailConfigured(): boolean { return !!RESEND_KEY; }
export function platformFrom(): string { return PLATFORM_FROM; }
export function platformAddress(): string { return /<([^>]+)>/.exec(PLATFORM_FROM)?.[1] ?? PLATFORM_FROM; }

/** Every key in outreach_email_types. The database refuses anything else; this keeps call sites honest at compile time. */
export type EmailType =
  | "team_invite" | "reply_alert" | "mention" | "ai_handoff" | "ai_handback" | "ai_reply_scheduled" | "ai_reply_cancelled" | "ai_reply_breaker" | "assignment" | "manager_daily_digest"
  | "sequence_stalled" | "sender_running_dry" | "import_failed" | "sender_paused" | "sender_error" | "sender_level_up" | "removal_pending" | "sender_auto_remove_team"
  | "sender_owner_action" | "health_alert" | "sender_disconnected_team" | "sender_mass_disconnect" | "weekly_digest" | "sender_weekly" | "voice_minutes" | "export_ready" | "webchat_handoff"
  | "billing_payment_failed" | "billing_action_required" | "billing_reminder" | "billing_suspension_tomorrow" | "billing_suspended" | "billing_removal_warning" | "billing_accounts_removed"
  | "billing_deletion_warning" | "billing_data_deleted" | "billing_reactivated" | "billing_plan_ending" | "billing_subscription_cancelled" | "billing_trial_ending" | "billing_trial_expired" | "billing_trial_data_warning"
  | "sender_connect_request" | "sender_connected_notice" | "sender_reconnect_needed" | "sender_reconnect_manual" | "sender_reconnect_reminder" | "ai_reply_consent_request" | "ai_reply_consent_confirmed"
  | "ai_reply_owner_digest" | "profile_authority_request" | "profile_change_applied" | "profile_change_proposed" | "sender_removed_notice" | "sender_auto_remove_notice" | "sender_erase_notice"
  | "sender_holder_changed" | "sender_removal_billing_notice" | "sender_reconnect_after_billing"
  | "client_viewer_invite" | "client_report" | "webchat_transcript" | "webchat_continuity"
  | "auth_magic_link" | "auth_signup" | "auth_recovery" | "auth_invite" | "auth_email_change" | "auth_reauthentication"
  | "platform_alert" | "health_urgent" | "health_daily" | "sending_domain_records" | "sending_domain_status" | "sending_domain_test";

export const HOLDER_TYPES: ReadonlySet<string> = new Set([
  "sender_connect_request", "sender_connected_notice", "sender_reconnect_needed", "sender_reconnect_manual", "sender_reconnect_reminder", "ai_reply_consent_request", "ai_reply_consent_confirmed",
  "ai_reply_owner_digest", "profile_authority_request", "profile_change_applied", "profile_change_proposed", "sender_removed_notice", "sender_auto_remove_notice", "sender_erase_notice",
  "sender_holder_changed", "sender_removal_billing_notice", "sender_reconnect_after_billing",
]);

export interface SendEmailInput {
  type: EmailType;
  to: string;
  subject: string;
  html: string;
  text?: string | null;
  workspace_id?: string | null;
  client_id?: string | null;
  sender_id?: string | null;
  /** `${type}:${entity}:${version}`; without one the same subject + body to the same address is sent once */
  idempotency_key?: string | null;
  /** a team email honours this member's notification preference for the type (safety-critical types ignore it) */
  recipient_user_id?: string | null;
  /** holder emails only: set by sendHolderEmail */
  outside_holder?: boolean;
  copy_of?: string | null;
  reply_to?: string | null;
  /** small facts for the log page (never the body) */
  data?: Record<string, unknown>;
  /** send now instead of queueing (auth hook, the test send) */
  direct?: boolean;
}

export interface SendEmailResult { outbox_id: string | null; status: "queued" | "sent" | "failed" | "skipped" | "duplicate"; from?: string; fell_back?: boolean; reason?: string }

const validEmail = (s: unknown): s is string => typeof s === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const stripHtml = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Queue one email. Holder types are refused here: they go through sendHolderEmail, which resolves the address itself (§5.8.1). */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (HOLDER_TYPES.has(input.type) && !input.outside_holder && !input.copy_of && !(input as Row).__holder) {
    throw new Error(`E_PAYLOAD_INVALID: ${input.type} is a holder email; use sendHolderEmail(sender_id, …) so the address comes from the holder record`);
  }
  const to = String(input.to ?? "").trim().toLowerCase();
  if (!validEmail(to)) { log({ fn: "email", skipped: "invalid recipient", type: input.type, to }); return { outbox_id: null, status: "skipped", reason: "invalid_recipient" }; }
  const queueOn = (await flag("email_outbox_enabled", true)) !== false;
  if (input.direct || !queueOn) return sendDirect(input);
  const r = await rpc<Row>("email_enqueue", { p: payloadOf(input, to) });
  if (r?.skipped) return { outbox_id: null, status: "skipped", reason: String(r.skipped) };
  if (r?.duplicate) return { outbox_id: String(r.outbox_id), status: "duplicate" };
  return { outbox_id: String(r.outbox_id), status: "queued", from: r.from_address, fell_back: !!r.fallback_reason, reason: r.fallback_reason ?? undefined };
}

function payloadOf(input: SendEmailInput, to: string): Row {
  return {
    workspace_id: input.workspace_id ?? null, client_id: input.client_id ?? null, sender_id: input.sender_id ?? null, type: input.type, to,
    subject: input.subject.slice(0, 500), html: input.html, text: input.text ?? stripHtml(input.html), idempotency_key: input.idempotency_key ?? null,
    outside_holder: !!input.outside_holder, copy_of: input.copy_of ?? null, recipient_user_id: input.recipient_user_id ?? null, reply_to: input.reply_to ?? null, data: input.data ?? {},
  };
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------
export type SendOutcome = "sent" | "domain_error" | "transient" | "invalid" | "no_transport";
interface ResendResult { outcome: SendOutcome; id: string | null; status: number; error: string }

async function resendSend(apiKey: string, payload: Row, idempotencyKey: string | null, group = "emails.send"): Promise<ResendResult> {
  if (!apiKey) return { outcome: "no_transport", id: null, status: 0, error: "no API key" };
  try {
    const res = await fetchWithHealth("resend", group, `${RESEND_API}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey.slice(0, 256) } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.ok) {
      let id: string | null = null;
      try { id = JSON.parse(text)?.id ?? null; } catch { /* no body */ }
      return { outcome: "sent", id, status: res.status, error: "" };
    }
    noteCallError("resend", group, text);
    return { outcome: classify(res.status, text), id: null, status: res.status, error: text.slice(0, 600) };
  } catch (e) {
    return { outcome: "transient", id: null, status: 0, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

/** What a failed Resend call means for the outbox (§5.3): the domain, the recipient, or try again. */
export function classify(status: number, text: string): SendOutcome {
  const t = text.toLowerCase();
  if (status === 429 || status >= 500) return "transient";
  if (status === 401 || status === 403 || /domain|not verified|verify|restricted|not allowed|api key|unauthor/.test(t)) return "domain_error";
  if (status === 422 || status === 400) {
    if (/recipient|"to"|to address|invalid.*(email|address)|not a valid/i.test(t) && !/from/.test(t)) return "invalid";
    if (/from/.test(t)) return "domain_error";
    return "invalid";
  }
  return "transient";
}

function cleanName(n: string): string { return n.replace(/["<>\r\n]/g, "").trim(); }
function fromHeader(name: string | null | undefined, address: string): string { const n = cleanName(name ?? ""); return n ? `"${n}" <${address}>` : address; }

interface Carrier { apiKey: string; from: string; replyTo: string | null; platform: boolean }

/** Platform From always exists; a customer's domain only with its key. */
async function carrierFor(row: Row): Promise<Carrier> {
  if (row.sending_domain_id && row.api_key_enc) {
    try {
      const key = await decrypt(String(row.api_key_enc));
      return { apiKey: key, from: fromHeader(row.from_name, String(row.from_address)), replyTo: row.reply_to ?? row.domain_reply_to ?? null, platform: false };
    } catch (e) { log({ fn: "email", warn: "domain key could not be read", domain: row.domain, error: String(e) }); }
  }
  // a platform row keeps the name the chooser or the caller gave it ("Acme via GrowthxAI" for a fallback), on the platform address
  const name = row.from_address && row.from_address !== "platform" && !/@/.test(String(row.from_address)) ? String(row.from_address) : null;
  return { apiKey: RESEND_KEY, from: name ? fromHeader(name, platformAddress()) : PLATFORM_FROM, replyTo: row.reply_to ?? (PLATFORM_REPLY_TO || null), platform: true };
}

function tagsFor(row: Row): Array<{ name: string; value: string }> {
  const safe = (v: unknown) => String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
  const tags = [{ name: "type", value: safe(row.type) }];
  if (row.workspace_id) tags.push({ name: "workspace", value: safe(row.workspace_id) });
  return tags;
}

/** F27 — send due outbox rows. Returns counts; never throws for one bad row. */
export async function outboxTick(limit = 50): Promise<Row> {
  const out: Row = { claimed: 0, sent: 0, failed: 0, retried: 0, fell_back: 0, domains_paused: [] as string[] };
  const rows = (await rpc<Row[]>("email_outbox_claim", { p_limit: limit })) ?? [];
  out.claimed = rows.length;
  for (const row of rows) {
    try {
      const c = await carrierFor(row);
      const r = await resendSend(c.apiKey, {
        from: c.from, to: [row.to_address], subject: row.subject, html: row.html ?? "", text: row.text_body ?? stripHtml(row.html ?? ""),
        ...(c.replyTo ? { reply_to: c.replyTo } : {}), tags: tagsFor(row),
      }, `${row.idempotency_key}:${row.attempts}:${c.platform ? "p" : "d"}`);
      // a domain error on a platform send is not the customer's domain: treat it as a retry
      const outcome: SendOutcome = r.outcome === "domain_error" && c.platform ? "transient" : r.outcome;
      const res = await rpc<Row>("email_outbox_result", { p_id: row.id, p_outcome: outcome, p_resend_id: r.id, p_error: r.error || null, p_platform_from: c.platform ? null : fallbackName(row) });
      if (outcome === "sent") out.sent++;
      else if (res?.fell_back) { out.fell_back++; if (res.domain_paused) { out.domains_paused.push(String(res.domain_paused)); await domainPausedNotice(String(res.domain_paused), r.error); } }
      else if (res?.status === "failed") { out.failed++; log({ fn: "email", failed: row.id, type: row.type, to: row.to_address, error: r.error.slice(0, 200) }); }
      else out.retried++;
    } catch (e) {
      out.failed++;
      log({ fn: "email", error: String((e as Error)?.message ?? e), outbox_id: row.id });
      await rpc("email_outbox_result", { p_id: row.id, p_outcome: "transient", p_error: String((e as Error)?.message ?? e).slice(0, 300) }).catch(() => null);
    }
  }
  return out;
}

/** "Acme via GrowthxAI": the name a brand email carries when it leaves from the platform instead (D5). */
function fallbackName(row: Row): string {
  const n = cleanName(String(row.from_name ?? ""));
  return n ? `${n} via ${PLATFORM_NAME}` : PLATFORM_NAME;
}

/** The customer's domain stopped working mid-send: the owners hear it from the platform address (§5.3 step 3). */
async function domainPausedNotice(domainId: string, error: string): Promise<void> {
  const { data: d } = await admin.from("outreach_sending_domains").select("id, workspace_id, domain, paused_reason, paused_detail").eq("id", domainId).maybeSingle();
  if (!d) return;
  const { esc, layout, button } = await import("./notify.ts");
  const subject = `Emails from ${d.domain} are paused`;
  const html = layout(esc(subject), `<p>An email could not be sent from <b>${esc(d.domain)}</b>: ${esc((d.paused_detail ?? error ?? "").slice(0, 200) || "the domain was refused by the email provider")}.</p>
    <p>The domain is paused. Every email that would have used it goes from the ${PLATFORM_NAME} address until you resume it, so nothing is lost. Check the DNS records on the Email sending page, then press <b>Resume</b>.</p>
    <p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/settings/email-sending`, "Open Email sending")}</p>`);
  await sendTeamEmail({ workspace_id: String(d.workspace_id), type: "sending_domain_status", subject, html, idempotency_key: `sending_domain_status:${d.id}:paused:${new Date().toISOString().slice(0, 13)}`, roles: ["owner"] });
  await audit(String(d.workspace_id), "sending_domain.paused", "sending_domain", String(d.id), { reason: d.paused_reason, detail: d.paused_detail }, "system");
}

// ---------------------------------------------------------------------------
// direct sends (the auth hook, the domain test): queue bypassed, rows still written
// ---------------------------------------------------------------------------
async function sendDirect(input: SendEmailInput): Promise<SendEmailResult> {
  const to = input.to.trim().toLowerCase();
  const choice: Row = (await rpc<Row>("email_domain_for", { p_type: input.type, p_ws: input.workspace_id ?? null, p_client: input.client_id ?? null, p_outside: input.outside_holder !== false }).catch((): Row => ({ platform: true }))) ?? { platform: true };
  const base = { ...payloadOf(input, to), direct: true };
  let fellBack = false, reason: string | null = choice?.fallback_reason ?? null;
  let attempt: ResendResult | null = null;
  let carrier: Carrier = { apiKey: RESEND_KEY, from: PLATFORM_FROM, replyTo: input.reply_to ?? (PLATFORM_REPLY_TO || null), platform: true };
  if (choice && choice.platform === false && choice.domain_id) {
    const { data: k } = await admin.from("outreach_sending_domain_keys").select("api_key_enc").eq("sending_domain_id", choice.domain_id).maybeSingle();
    if (k?.api_key_enc) {
      try {
        carrier = { apiKey: await decrypt(String(k.api_key_enc)), from: fromHeader(choice.from_name, String(choice.from_address)), replyTo: input.reply_to ?? choice.reply_to ?? null, platform: false };
      } catch { /* platform */ }
    }
  }
  const text = input.text ?? stripHtml(input.html);
  const idem = input.idempotency_key ?? null;
  if (!carrier.platform) {
    attempt = await resendSend(carrier.apiKey, { from: carrier.from, to: [to], subject: input.subject, html: input.html, text, ...(carrier.replyTo ? { reply_to: carrier.replyTo } : {}), tags: tagsFor({ type: input.type, workspace_id: input.workspace_id }) }, idem ? `${idem}:d` : null, "emails.send");
    if (attempt.outcome !== "sent") {
      fellBack = true; reason = attempt.outcome === "domain_error" ? "send_error" : "retries";
      if (attempt.outcome === "domain_error") {
        await admin.from("outreach_sending_domains").update({ paused_at: new Date().toISOString(), paused_reason: "send_error", paused_detail: attempt.error.slice(0, 300), updated_at: new Date().toISOString() }).eq("id", choice.domain_id).is("paused_at", null);
        await domainPausedNotice(String(choice.domain_id), attempt.error).catch(() => null);
      }
      carrier = { apiKey: RESEND_KEY, from: fromHeader(`${cleanName(choice.from_name ?? "")} via ${PLATFORM_NAME}`.replace(/^ via /, ""), platformAddress()), replyTo: input.reply_to ?? (PLATFORM_REPLY_TO || null), platform: true };
    }
  }
  if (!attempt || attempt.outcome !== "sent") {
    attempt = await resendSend(carrier.apiKey, { from: carrier.from, to: [to], subject: input.subject, html: input.html, text, ...(carrier.replyTo ? { reply_to: carrier.replyTo } : {}), tags: tagsFor({ type: input.type, workspace_id: input.workspace_id }) }, idem ? `${idem}:p` : null, "emails.send");
  }
  const ok = attempt.outcome === "sent";
  const r = await rpc<Row>("email_enqueue", { p: { ...base, ok, error: attempt.error || null, resend_email_id: attempt.id, from_address: carrier.platform ? carrier.from : String(choice.from_address),
    sending_domain_id: carrier.platform ? null : choice.domain_id, platform: carrier.platform, fell_back: fellBack, fallback_reason: reason, reply_to: carrier.replyTo } }).catch((e) => { log({ fn: "email", warn: "direct send not logged", error: String(e) }); return null; });
  if (!ok) log({ fn: "email", direct_failed: input.type, to, status: attempt.status, error: attempt.error.slice(0, 200) });
  return { outbox_id: r?.outbox_id ? String(r.outbox_id) : null, status: ok ? "sent" : "failed", from: carrier.from, fell_back: fellBack, reason: ok ? undefined : attempt.error.slice(0, 200) };
}

// ---------------------------------------------------------------------------
// holder emails (sender-lifecycle-PRD v1.2 §5.8.1, §4)
// ---------------------------------------------------------------------------
export interface HolderEmailInput {
  sender_id: string;
  type: EmailType;
  subject: string;
  /** the body inside the layout (no footer: this module adds it) */
  body: string;
  idempotency_key?: string | null;
  data?: Record<string, unknown>;
  /** true = send even when the holder is a member (default); 'outside_only' = only outside holders get it (connected notice, consent requests) */
  audience?: "any" | "outside_only" | "members_only";
  /** a button for the member's own copy instead of the default "Open in GrowthxAI" (a sign-in link, a revert link) */
  action?: { label: string; url: string } | null;
  width?: number;
}

export interface HolderEmailResult { to: string | null; outside: boolean; sent: boolean; copies: string[]; skipped?: string; outbox_id?: string | null }

/** Sends to whoever signs in to the account, with the right footer, and the "Copy" to the connecting member for an outside holder. */
export async function sendHolderEmail(input: HolderEmailInput): Promise<HolderEmailResult> {
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, client_id, display_name, provider, status, owner_user_id, owner_email").eq("id", input.sender_id).maybeSingle();
  if (!s) return { to: null, outside: false, sent: false, copies: [], skipped: "sender_not_found" };
  const rec = await rpc<Row>("sender_email_recipients", { p_sender: s.id, p_kind: "holder" });
  if (!rec?.to) return { to: null, outside: false, sent: false, copies: [], skipped: "no_holder" };
  const outside = !!rec.outside;
  if (input.audience === "outside_only" && !outside) return { to: rec.to, outside, sent: false, copies: [], skipped: "member_holder" };
  if (input.audience === "members_only" && outside) return { to: rec.to, outside, sent: false, copies: [], skipped: "outside_holder" };
  const { layout, button, esc, workspaceBranding, brandName, ownerLink } = await import("./notify.ts");
  const branding = await workspaceBranding(s.workspace_id);
  const wsName = brandName(branding);
  const senderUrl = `${WEB_ORIGIN}/outreach/senders/${s.id}`;
  let footer = "";
  if (outside && s.status !== "removed" && s.status !== "erased") {
    const link = await ownerLink(s.id, "disconnect", rec.to);
    footer = `<p style="margin-top:28px;padding-top:12px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px">Sent on behalf of ${esc(wsName)} via ${PLATFORM_NAME}.${link ? ` This is your account: you can <a href="${esc(link)}" data-disable-tracking="true" style="color:#6b7280">disconnect it from ${PLATFORM_NAME}</a> at any time, without logging in. The link works once, for 30 days.` : ""}</p>`;
  } else if (outside) {
    footer = `<p style="margin-top:28px;padding-top:12px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px">Sent on behalf of ${esc(wsName)} via ${PLATFORM_NAME}.</p>`;
  }
  const action = input.action ?? (outside ? null : { label: `Open in ${PLATFORM_NAME}`, url: senderUrl });
  const actionHtml = action ? `<p style="margin-top:18px">${button(action.url, action.label, branding)}</p>` : "";
  const html = layout(esc(input.subject), `${input.body}${actionHtml}${footer}`, branding, { audience: outside ? "client" : "team", width: input.width });
  const key = input.idempotency_key ?? `${input.type}:${s.id}:${new Date().toISOString().slice(0, 10)}`;
  const primary = await sendEmail({ ...({ __holder: true } as Row), type: input.type, to: rec.to, subject: input.subject, html, workspace_id: s.workspace_id, client_id: s.client_id, sender_id: s.id,
    idempotency_key: key, outside_holder: outside, recipient_user_id: rec.to_user_id ?? null, data: { ...(input.data ?? {}), holder: rec.kind, outside } });
  const copies: string[] = [];
  if (outside) {
    // the copy to the connecting member (or the owners): same email, a banner, no disconnect link (the link is the holder's alone)
    const banner = `<p style="margin:0 0 14px;padding:10px 12px;background:#eef2ff;border-radius:8px;color:#3730a3;font-size:13px"><b>Copy:</b> sent to ${esc(rec.to)}, who signs in to ${esc(s.display_name ?? "this account")}.</p>`;
    const copyHtml = layout(esc(input.subject), `${banner}${input.body}<p style="margin-top:18px">${button(senderUrl, `Open in ${PLATFORM_NAME}`, branding)}</p>`, branding, { audience: "team", width: input.width });
    for (const c of (rec.cc ?? []) as Row[]) {
      if (!validEmail(c.email) || String(c.email).toLowerCase() === rec.to) continue;
      const r = await sendEmail({ ...({ __holder: true } as Row), type: input.type, to: c.email, subject: `Copy: ${input.subject}`, html: copyHtml, workspace_id: s.workspace_id, client_id: s.client_id, sender_id: s.id,
        idempotency_key: `${key}:copy:${String(c.email).toLowerCase()}`, outside_holder: false, copy_of: primary.outbox_id, recipient_user_id: c.user_id ?? null, data: { copy_of: rec.to } });
      if (r.status === "queued" || r.status === "sent") copies.push(String(c.email).toLowerCase());
    }
  }
  const sent = primary.status === "queued" || primary.status === "sent" || primary.status === "duplicate";
  await audit(s.workspace_id, `notify.${input.type}`, "sender", s.id, { to: rec.to, outside, copies, outbox_id: primary.outbox_id, status: primary.status }, "system");
  return { to: rec.to, outside, sent, copies, outbox_id: primary.outbox_id };
}

// ---------------------------------------------------------------------------
// team emails: owners and managers on their sign-in emails, each by their own preference
// ---------------------------------------------------------------------------
export interface TeamEmailInput {
  workspace_id: string;
  type: EmailType;
  subject: string;
  html: string;
  text?: string | null;
  idempotency_key?: string | null;
  sender_id?: string | null;
  client_id?: string | null;
  roles?: Array<"owner" | "manager" | "member">;
  /** explicit extra addresses (report schedule recipients) */
  extra?: string[];
  /** specific members instead of the role set */
  user_ids?: string[];
  data?: Record<string, unknown>;
}

export interface TeamEmailResult { recipients: string[]; queued: number; skipped: number }

export async function teamRecipients(workspaceId: string, opts: { roles?: string[]; client_id?: string | null; sender_id?: string | null; user_ids?: string[] } = {}): Promise<Array<{ user_id: string; email: string; role: string }>> {
  if (opts.sender_id && !opts.user_ids) {
    const r = await rpc<Row>("sender_email_recipients", { p_sender: opts.sender_id, p_kind: "team" }).catch(() => null);
    if (r?.recipients) return (r.recipients as Row[]).filter((x) => validEmail(x.email) && (!opts.roles || opts.roles.includes(String(x.role)))).map((x) => ({ user_id: String(x.user_id), email: String(x.email).toLowerCase(), role: String(x.role) }));
  }
  let q = admin.from("outreach_members").select("user_id, role, client_ids").eq("workspace_id", workspaceId);
  q = opts.user_ids ? q.in("user_id", opts.user_ids) : q.in("role", opts.roles ?? ["owner", "manager"]);
  const { data: members } = await q;
  const out: Array<{ user_id: string; email: string; role: string }> = [];
  for (const m of members ?? []) {
    if (opts.client_id && m.role !== "owner" && (m.client_ids ?? []).length && !(m.client_ids ?? []).includes(opts.client_id)) continue;
    let email = "";
    try { email = (await admin.auth.admin.getUserById(m.user_id)).data?.user?.email ?? ""; } catch { /* skip */ }
    if (validEmail(email)) out.push({ user_id: String(m.user_id), email: email.toLowerCase(), role: String(m.role) });
  }
  return out;
}

export async function sendTeamEmail(input: TeamEmailInput): Promise<TeamEmailResult> {
  const people = await teamRecipients(input.workspace_id, { roles: input.roles, client_id: input.client_id, sender_id: input.sender_id, user_ids: input.user_ids });
  const seen = new Set<string>();
  let queued = 0, skipped = 0;
  const recipients: string[] = [];
  for (const p of people) {
    if (seen.has(p.email)) continue; seen.add(p.email);
    const r = await sendEmail({ type: input.type, to: p.email, subject: input.subject, html: input.html, text: input.text, workspace_id: input.workspace_id, client_id: input.client_id, sender_id: input.sender_id,
      idempotency_key: input.idempotency_key ? `${input.idempotency_key}:${p.email}` : null, recipient_user_id: p.user_id, data: input.data });
    if (r.status === "queued" || r.status === "sent" || r.status === "duplicate") { queued++; recipients.push(p.email); } else skipped++;
  }
  for (const e of input.extra ?? []) {
    const em = String(e).trim().toLowerCase();
    if (!validEmail(em) || seen.has(em)) continue; seen.add(em);
    const r = await sendEmail({ type: input.type, to: em, subject: input.subject, html: input.html, text: input.text, workspace_id: input.workspace_id, client_id: input.client_id, sender_id: input.sender_id,
      idempotency_key: input.idempotency_key ? `${input.idempotency_key}:${em}` : null, data: input.data });
    if (r.status === "queued" || r.status === "sent" || r.status === "duplicate") { queued++; recipients.push(em); } else skipped++;
  }
  return { recipients, queued, skipped };
}
