// F10 — Create a Hosted Auth Wizard link for a new sender (manager+). connect_method "browser" (LinkedIn only) offers the
// extension-based sign-in (UniLogin) instead of a password login; the sender is stored with auth_method = browser.
// Channels (CHANNELS-BUILD-CONTRACT §4): INSTAGRAM and WHATSAPP connect through the same hosted page (WhatsApp shows a QR /
// pairing code). A WhatsApp number must be attested as at least 6 months old with real use before it is created.
import { admin, json, serve, requireUser, membership, requireRole, readJson, rateLimit, HttpError, FUNCTIONS_BASE, WEB_ORIGIN, audit } from "../_shared/outreach/supabase.ts";
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
  // Trial limits only apply when billing is actually configured; self-hosted / pre-billing installs are unlimited.
  if (ws?.plan === "trial" && Deno.env.get("STRIPE_SECRET_KEY")) {
    const { count } = await admin.from("outreach_senders").select("id", { count: "exact", head: true }).eq("workspace_id", body.workspace_id).is("deleted_at", null).neq("status", "disabled");
    if ((count ?? 0) >= 3) throw new HttpError(402, "E_PLAN_LIMIT", "Trial workspaces can connect up to 3 senders. Add billing to connect more.");
  }
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
    workspace_id: body.workspace_id, client_id: body.client_id ?? null, owner_email: body.owner_email ?? null, owner_user_id: user.id,
    provider, auth_method: browser ? "browser" : isMail ? "oauth" : "credentials", display_name: body.display_name ?? DEFAULT_NAME[provider],
    status: "connecting", proxy_ip_hint: ip, user_agent: ua, timezone: body.timezone ?? "UTC", warmup_level: isMail ? 3 : 0,
  };
  if (provider === "WHATSAPP") {
    // the attestation (a manager RPC elsewhere) is written directly here: the service role is not a member of the workspace
    row.account_age_attested_at = new Date().toISOString();
    row.account_age_attested_by = user.id;
    row.account_age_months = ageMonths;
  }
  const { data: sender, error } = await admin.from("outreach_senders").insert(row).select("*").single();
  if (error) throw new HttpError(500, "E_INTERNAL", error.message);
  const providers = HOSTED[provider];
  const recruiter = !!body.recruiter && !!(ws?.settings?.recruiter_enabled);
  try {
    const link = await unipile.hosted.link({
      type: "create", providers,
      expiresOn: new Date(Date.now() + 15 * 60_000).toISOString(),
      notify_url: `${FUNCTIONS_BASE}outreach-sender-notify?sid=${sender.id}`,
      name: sender.id,
      success_redirect_url: `${WEB_ORIGIN}/outreach/senders/${sender.id}?connected=1`,
      failure_redirect_url: `${WEB_ORIGIN}/outreach/senders/${sender.id}?connected=0`,
      disabled_features: isLinkedIn && !recruiter ? ["linkedin_recruiter"] : undefined,
      bypass_success_screen: false,
      ...(browser ? hostedBrowserOptions() : {}),
    });
    await audit(body.workspace_id, "sender.connect_link", "sender", sender.id, { provider, ip, connect_method: browser ? "browser" : "default", ...(ageMonths != null ? { account_age_months: ageMonths, account_age_attested_by: user.id } : {}) }, "user");
    if (provider === "WHATSAPP") await audit(body.workspace_id, "sender.attest_account_age", "sender", sender.id, { months: ageMonths, by: user.id, at_connect: true }, "user");
    return json({ link: link.url, sender_id: sender.id });
  } catch (e) {
    await admin.from("outreach_senders").delete().eq("id", sender.id);
    throw e;
  }
});
