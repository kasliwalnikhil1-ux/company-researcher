// F10 — Create a Hosted Auth Wizard link for a new sender (manager+). connect_method "browser" (LinkedIn only) offers the
// extension-based sign-in (UniLogin) instead of a password login; the sender is stored with auth_method = browser.
// Channels (CHANNELS-BUILD-CONTRACT §4): INSTAGRAM and WHATSAPP connect through the same hosted page (WhatsApp shows a QR /
// pairing code). A WhatsApp number must be attested as at least 6 months old with real use before it is created.
import { admin, json, serve, requireUser, membership, requireRole, readJson, rateLimit, HttpError, FUNCTIONS_BASE, WEB_ORIGIN, audit, rpc } from "../_shared/outreach/supabase.ts";
import { unipile, unipileConfigured, hostedBrowserOptions } from "../_shared/outreach/unipile.ts";

type Provider = "LINKEDIN" | "INSTAGRAM" | "WHATSAPP" | "GMAIL" | "OUTLOOK" | "IMAP";
const PROVIDERS: Provider[] = ["LINKEDIN", "INSTAGRAM", "WHATSAPP", "GMAIL", "OUTLOOK", "IMAP"];
const HOSTED: Record<Provider, string[]> = { LINKEDIN: ["LINKEDIN"], INSTAGRAM: ["INSTAGRAM"], WHATSAPP: ["WHATSAPP"], GMAIL: ["GOOGLE"], OUTLOOK: ["OUTLOOK"], IMAP: ["MAIL"] };
const DEFAULT_NAME: Record<Provider, string> = { LINKEDIN: "LinkedIn sender", INSTAGRAM: "Instagram account", WHATSAPP: "WhatsApp number", GMAIL: "GMAIL mailbox", OUTLOOK: "OUTLOOK mailbox", IMAP: "IMAP mailbox" };
const MIN_WHATSAPP_MONTHS = 6;

interface Body {
  workspace_id: string; provider: Provider; client_id?: string | null; owner_email?: string | null; display_name?: string | null; recruiter?: boolean; timezone?: string;
  connect_method?: "credentials" | "browser";
  /** WhatsApp only: the operator attests the number has at least 6 months of real use. */
  account_age_months?: number; account_age_attested?: boolean;
  /** The same owner email is already connected on this channel and the manager still wants a second, separate sender. */
  allow_duplicate?: boolean;
}

serve("sender-connect", async (req) => {
  const user = await requireUser(req);
  await rateLimit(`user:${user.id}:sender-connect`, 20, 60);
  const body = await readJson<Body>(req);
  if (!body.workspace_id || !body.provider) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id and provider required");
  const provider = String(body.provider).toUpperCase() as Provider;
  if (!PROVIDERS.includes(provider)) throw new HttpError(400, "E_PAYLOAD_INVALID", `unknown provider ${body.provider}`);
  const m = await membership(user.id, body.workspace_id);
  requireRole(m, "manager");
  if (!unipileConfigured()) throw new HttpError(503, "E_NOT_CONFIGURED", "Account connection is not configured on this deployment");
  const { data: ws } = await admin.from("outreach_workspaces").select("plan, settings, trial_ends_at").eq("id", body.workspace_id).single();
  // WhatsApp: fresh numbers are blocked after two or three new chats; the operator attests the number's age before it is connected
  let ageMonths: number | null = null;
  if (provider === "WHATSAPP") {
    const months = Number(body.account_age_months);
    if (!Number.isFinite(months) || months < MIN_WHATSAPP_MONTHS || body.account_age_attested !== true) {
      throw new HttpError(409, "E_ACCOUNT_TOO_NEW", "WhatsApp numbers need at least 6 months of real use before outreach");
    }
    ageMonths = Math.floor(months);
  }
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  const ua = req.headers.get("user-agent");
  const isLinkedIn = provider === "LINKEDIN";
  const isChannel = provider === "INSTAGRAM" || provider === "WHATSAPP";
  const isMail = !isLinkedIn && !isChannel;
  const browser = isLinkedIn && body.connect_method === "browser";
  const row: Record<string, unknown> = {
    workspace_id: body.workspace_id, client_id: body.client_id ?? null, owner_email: String(body.owner_email ?? "").trim().toLowerCase() || null, owner_user_id: user.id,
    provider, auth_method: browser ? "browser" : isMail ? "oauth" : "credentials", display_name: body.display_name ?? DEFAULT_NAME[provider],
    status: "connecting", proxy_ip_hint: ip, user_agent: ua, timezone: body.timezone ?? "UTC", warmup_level: isMail ? 3 : 0,
  };
  if (provider === "WHATSAPP") {
    // the attestation (a manager RPC elsewhere) is written directly here: the service role is not a member of the workspace
    row.account_age_attested_at = new Date().toISOString();
    row.account_age_attested_by = user.id;
    row.account_age_months = ageMonths;
  }
  // One sender per owner email and channel. An unfinished sign-in for the same owner (the hosted page was never completed, so the
  // row has no account yet) is reused: the new link replaces the expired one instead of leaving two "connecting" rows behind.
  // An owner that is already connected is refused unless the manager explicitly wants a second sender.
  let reused: Record<string, unknown> | null = null;
  if (row.owner_email) {
    const { data: twins } = await admin.from("outreach_senders").select("id, display_name, status, unipile_account_id, created_at")
      .eq("workspace_id", body.workspace_id).eq("provider", provider).eq("owner_email", String(row.owner_email)).is("deleted_at", null).neq("status", "disabled").order("created_at");
    const connected = (twins ?? []).find((t) => t.unipile_account_id);
    if (connected && !body.allow_duplicate) {
      throw new HttpError(409, "E_DUPLICATE_SENDER", `${connected.display_name ?? "This account"} is already connected with this owner email. Reconnect it instead of connecting it again.`,
        { existing_sender_id: connected.id, existing_display_name: connected.display_name, existing_status: connected.status });
    }
    reused = (twins ?? []).find((t) => !t.unipile_account_id && t.status === "connecting") ?? null;
  }
  let sender: Record<string, unknown>;
  if (reused) {
    const { status: _s, ...details } = row;
    const { data, error } = await admin.from("outreach_senders").update({ ...details, status_reason: null }).eq("id", reused.id).select("*").single();
    if (error) throw new HttpError(500, "E_INTERNAL", error.message);
    sender = data;
  } else {
    const { data, error } = await admin.from("outreach_senders").insert(row).select("*").single();
    if (error) throw new HttpError(500, "E_INTERNAL", error.message);
    sender = data;
  }
  const senderId = String(sender.id);
  // Accounts are bought up front (billing v2): the sign-in link holds one account for its 15-minute life, so two links opened at
  // once cannot both take the last free one. E_ACCOUNT_LIMIT when none is free ("Add an account" in the app).
  try { await rpc("slot_reserve", { p_ws: body.workspace_id, p_purpose: isMail ? "mailbox" : "hosted_auth", p_sender: senderId, p_minutes: 15, p_by: user.id }); }
  catch (e) {
    if (!reused) await admin.from("outreach_senders").delete().eq("id", senderId);
    const m = /^(E_ACCOUNT_LIMIT|E_PLAN_SUSPENDED):\s*(.*)$/s.exec(String((e as Error)?.message ?? e).trim());
    if (m) throw new HttpError(m[1] === "E_ACCOUNT_LIMIT" ? 402 : 403, m[1], m[2], m[1] === "E_ACCOUNT_LIMIT" ? { slots: await rpc("slots", { p_ws: body.workspace_id }).catch(() => null) } : undefined);
    throw e;
  }
  const providers = HOSTED[provider];
  const recruiter = !!body.recruiter && !!(ws?.settings?.recruiter_enabled);
  try {
    const link = await unipile.hosted.link({
      type: "create", providers,
      expiresOn: new Date(Date.now() + 15 * 60_000).toISOString(),
      notify_url: `${FUNCTIONS_BASE}outreach-sender-notify?sid=${senderId}`,
      name: senderId,
      success_redirect_url: `${WEB_ORIGIN}/outreach/senders/${senderId}?connected=1`,
      failure_redirect_url: `${WEB_ORIGIN}/outreach/senders/${senderId}?connected=0`,
      disabled_features: isLinkedIn && !recruiter ? ["linkedin_recruiter"] : undefined,
      bypass_success_screen: false,
      ...(browser ? hostedBrowserOptions() : {}),
    });
    await audit(body.workspace_id, "sender.connect_link", "sender", senderId, { provider, ip, connect_method: browser ? "browser" : "default", reused_sender: !!reused, ...(ageMonths != null ? { account_age_months: ageMonths, account_age_attested_by: user.id } : {}) }, "user");
    if (provider === "WHATSAPP") await audit(body.workspace_id, "sender.attest_account_age", "sender", senderId, { months: ageMonths, by: user.id, at_connect: true }, "user");
    // the sweep that flags abandoned sign-ins counts from the latest link, not from the row's creation
    await admin.from("outreach_sender_events").insert({ sender_id: senderId, kind: "reconnect", data: { method: "connect_link", reused: !!reused, connect_method: browser ? "browser" : "credentials" } });
    return json({ link: link.url, sender_id: senderId, reused: !!reused });
  } catch (e) {
    await rpc("slot_release_sender", { p_sender: senderId, p_reason: "failed" }).catch(() => null);
    if (!reused) await admin.from("outreach_senders").delete().eq("id", senderId);
    throw e;
  }
});
