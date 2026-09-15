// F10 — Create a Unipile Hosted Auth link for a new sender (manager+).
import { admin, json, serve, requireUser, membership, requireRole, readJson, rateLimit, HttpError, FUNCTIONS_BASE, WEB_ORIGIN, audit } from "../_shared/outreach/supabase.ts";
import { unipile, unipileConfigured } from "../_shared/outreach/unipile.ts";

serve("sender-connect", async (req) => {
  const user = await requireUser(req);
  await rateLimit(`user:${user.id}:sender-connect`, 20, 60);
  const body = await readJson<{ workspace_id: string; provider: "LINKEDIN" | "GMAIL" | "OUTLOOK" | "IMAP"; client_id?: string | null; owner_email?: string | null; display_name?: string | null; recruiter?: boolean; timezone?: string }>(req);
  if (!body.workspace_id || !body.provider) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id and provider required");
  const m = await membership(user.id, body.workspace_id);
  requireRole(m, "manager");
  if (!unipileConfigured()) throw new HttpError(503, "E_NOT_CONFIGURED", "Unipile is not configured (UNIPILE_DSN / UNIPILE_API_KEY)");
  const { data: ws } = await admin.from("outreach_workspaces").select("plan, settings, trial_ends_at").eq("id", body.workspace_id).single();
  // Trial limits only apply when billing is actually configured; self-hosted / pre-billing installs are unlimited.
  if (ws?.plan === "trial" && Deno.env.get("STRIPE_SECRET_KEY")) {
    const { count } = await admin.from("outreach_senders").select("id", { count: "exact", head: true }).eq("workspace_id", body.workspace_id).is("deleted_at", null).neq("status", "disabled");
    if ((count ?? 0) >= 3) throw new HttpError(402, "E_PLAN_LIMIT", "Trial workspaces can connect up to 3 senders. Add billing to connect more.");
  }
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  const ua = req.headers.get("user-agent");
  const provider = body.provider;
  const isLinkedIn = provider === "LINKEDIN";
  const { data: sender, error } = await admin.from("outreach_senders").insert({
    workspace_id: body.workspace_id, client_id: body.client_id ?? null, owner_email: body.owner_email ?? null, owner_user_id: user.id,
    provider, auth_method: isLinkedIn ? "credentials" : "oauth", display_name: body.display_name ?? (isLinkedIn ? "LinkedIn sender" : `${provider} mailbox`),
    status: "connecting", proxy_ip_hint: ip, user_agent: ua, timezone: body.timezone ?? "UTC", warmup_level: isLinkedIn ? 0 : 3,
  }).select("*").single();
  if (error) throw new HttpError(500, "E_INTERNAL", error.message);
  const providers = isLinkedIn ? ["LINKEDIN"] : provider === "GMAIL" ? ["GOOGLE"] : provider === "OUTLOOK" ? ["OUTLOOK"] : ["MAIL"];
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
    });
    await audit(body.workspace_id, "sender.connect_link", "sender", sender.id, { provider, ip }, "user");
    return json({ link: link.url, sender_id: sender.id });
  } catch (e) {
    await admin.from("outreach_senders").delete().eq("id", sender.id);
    throw e;
  }
});
