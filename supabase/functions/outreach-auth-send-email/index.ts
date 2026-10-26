// F58 — Supabase Auth "Send Email" hook (custom-sending-domain-PRD.md §7, D8). Deploy with --no-verify-jwt; the Standard
// Webhooks signature (webhook-id / -timestamp / -signature) is checked with SUPABASE_AUTH_HOOK_SECRET.
// The user is waiting, so nothing is queued: branded domain (3 s), then the platform (3 s), both logged as outbox rows.
// Brand only when every membership of the user is client_viewer in workspaces (or clients) that resolve to one active domain.
// Both attempts failed → 500, so Supabase shows the failure instead of a silent "check your email".
// Runbook: if this function misbehaves, disable the hook in the dashboard (Auth → Hooks) and SMTP takes over within seconds.
import { admin, json, serve, HttpError, log, rpc, WEB_ORIGIN } from "../_shared/outreach/supabase.ts";
import { verifyStandardWebhook } from "../_shared/outreach/webhook_sig.ts";
import { sendEmail, type EmailType } from "../_shared/outreach/email.ts";
import { layout, esc, button, workspaceBranding, type Branding } from "../_shared/outreach/notify.ts";

const SECRET = Deno.env.get("SUPABASE_AUTH_HOOK_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
type Row = Record<string, any>;

const TYPE: Record<string, EmailType> = { signup: "auth_signup", magiclink: "auth_magic_link", recovery: "auth_recovery", invite: "auth_invite", email_change: "auth_email_change", email_change_current: "auth_email_change", email_change_new: "auth_email_change", reauthentication: "auth_reauthentication" };

function verifyUrl(siteUrl: string, tokenHash: string, type: string, redirectTo: string): string {
  const base = (SUPABASE_URL || siteUrl).replace(/\/$/, "");
  return `${base}/auth/v1/verify?token=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(type)}&redirect_to=${encodeURIComponent(redirectTo || siteUrl)}`;
}

/** D8: the one branded workspace of a pure client viewer, else null (platform). */
async function brandContext(userId: string): Promise<{ workspace_id: string; client_id: string | null } | null> {
  const { data: ms } = await admin.from("outreach_members").select("workspace_id, role, client_ids").eq("user_id", userId);
  if (!ms?.length || ms.some((m) => m.role !== "client_viewer")) return null;
  const domains = new Set<string>();
  let ctx: { workspace_id: string; client_id: string | null } | null = null;
  for (const m of ms) {
    const clientId = (m.client_ids ?? []).length === 1 ? String(m.client_ids[0]) : null;
    const c = await rpc<Row>("email_domain_for", { p_type: "auth_magic_link", p_ws: m.workspace_id, p_client: clientId, p_outside: true }).catch(() => null);
    if (!c || c.platform !== false || !c.domain_id) return null;
    domains.add(String(c.domain_id));
    ctx = { workspace_id: m.workspace_id, client_id: clientId };
  }
  return domains.size === 1 ? ctx : null;
}

function content(action: string, d: Row, link: string, branding: Branding, email: string): { subject: string; html: string } {
  const name = branding.product_name || branding.workspace_name || "GrowthxAI";
  const b = (t: string, body: string, cta: string) => ({ subject: t, html: layout(esc(t), `${body}<p style="margin-top:18px">${button(link, cta, branding)}</p><p style="font-size:12px;color:#777">${d.token ? `Or enter this code: <b>${esc(d.token)}</b>. ` : ""}If you did not ask for this, ignore this email.</p>`, branding, { audience: "client" }) });
  switch (action) {
    case "signup": return b(`Confirm your email for ${name}`, `<p>Welcome. Confirm <b>${esc(email)}</b> to finish creating your account.</p>`, "Confirm email");
    case "magiclink": return b(`Your sign-in link for ${name}`, `<p>Use the button to sign in as <b>${esc(email)}</b>. The link works once.</p>`, "Sign in");
    case "recovery": return b(`Reset your ${name} password`, `<p>Someone asked to reset the password of <b>${esc(email)}</b>. If that was you, choose a new one here.</p>`, "Reset password");
    case "invite": return b(`You have been invited to ${name}`, `<p>An account was created for <b>${esc(email)}</b>. Accept the invitation to set your password.</p>`, "Accept invitation");
    case "email_change_current": return b(`Confirm your email change on ${name}`, `<p>You asked to change the email of your account from <b>${esc(email)}</b>. Confirm from this address to allow it.</p>`, "Confirm change");
    case "email_change_new": return b(`Confirm your new email on ${name}`, `<p>Confirm that <b>${esc(email)}</b> is your new address for ${esc(name)}.</p>`, "Confirm new email");
    case "email_change": return b(`Confirm your email change on ${name}`, `<p>Confirm the change of email on your ${esc(name)} account.</p>`, "Confirm change");
    case "reauthentication": return { subject: `Your ${name} verification code`, html: layout("Verification code", `<p>Your code is <b style="font-size:20px">${esc(d.token ?? "")}</b>. It works for a few minutes.</p>`, branding, { audience: "client" }) };
    default: return b(`${name}: action needed`, `<p>Open the link to continue.</p>`, "Continue");
  }
}

serve("auth-send-email", async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "E_PAYLOAD_INVALID", "POST only");
  const raw = await req.text();
  if (!SECRET) throw new HttpError(503, "E_NOT_CONFIGURED", "SUPABASE_AUTH_HOOK_SECRET is not set");
  if (!(await verifyStandardWebhook(req.headers, raw, SECRET, { prefix: "webhook" }))) throw new HttpError(401, "E_SIGNATURE", "bad signature");
  const body: Row = JSON.parse(raw);
  const user: Row = body.user ?? {};
  const d: Row = body.email_data ?? {};
  const action = String(d.email_action_type ?? "");
  const siteUrl = String(d.site_url ?? WEB_ORIGIN);
  const redirectTo = String(d.redirect_to ?? "");
  const ctx = user.id ? await brandContext(String(user.id)).catch(() => null) : null;
  const branding = ctx ? await workspaceBranding(ctx.workspace_id) : {};
  const sends: Array<{ to: string; kind: string; link: string; token?: string }> = [];
  if (action === "email_change" && d.token_hash_new) {
    // secure email change: the current address confirms with token_hash_new + token; the new address with token_hash + token_new
    sends.push({ to: String(user.email), kind: "email_change_current", link: verifyUrl(siteUrl, String(d.token_hash_new), "email_change", redirectTo), token: d.token });
    sends.push({ to: String(user.new_email ?? d.new_email ?? ""), kind: "email_change_new", link: verifyUrl(siteUrl, String(d.token_hash), "email_change", redirectTo), token: d.token_new });
  } else {
    const to = action === "email_change" ? String(user.new_email ?? user.email) : String(user.email);
    sends.push({ to, kind: action, link: verifyUrl(siteUrl, String(d.token_hash ?? ""), action === "signup" ? "signup" : action, redirectTo), token: d.token });
  }
  const results: Row[] = [];
  let failed = 0;
  for (const s of sends) {
    if (!s.to) continue;
    const c = content(s.kind, { token: s.token }, s.link, branding, s.to);
    const r = await sendEmail({ type: TYPE[s.kind] ?? "auth_magic_link", to: s.to, subject: c.subject, html: c.html, workspace_id: ctx?.workspace_id ?? null, client_id: ctx?.client_id ?? null, direct: true,
      idempotency_key: `auth:${s.kind}:${String(d.token_hash ?? d.token_hash_new ?? "").slice(0, 24)}:${s.to}`, data: { action: s.kind, user_id: user.id ?? null } });
    results.push({ to: s.to, status: r.status, fell_back: r.fell_back });
    if (r.status !== "sent") failed++;
  }
  if (failed && failed === results.length) {
    log({ fn: "auth-send-email", error: "every attempt failed", action, results });
    return json({ error: { http_code: 500, message: "The email could not be sent. Try again in a minute." } }, 500);
  }
  return json({});
});
