// F14 — Cookie sync from the Chrome extension. Auth: Bearer <sender_token> (hashed in outreach_sender_tokens).
// Deploy with --no-verify-jwt. Rate limit 1 / 10 min / sender.
import { admin, json, serve, readJson, rpc, HttpError, rateLimit, audit } from "../_shared/outreach/supabase.ts";
import { encrypt } from "../_shared/outreach/crypto.ts";
import { reconnectSender } from "../_shared/outreach/workers.ts";

serve("cookie-sync", async (req) => {
  if (req.method !== "POST") return json({ ok: true, fn: "outreach-cookie-sync" });
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) throw new HttpError(401, "E_FORBIDDEN", "sender token required");
  const senderId = await rpc<string | null>("verify_sender_token", { p_token: token });
  if (!senderId) throw new HttpError(401, "E_FORBIDDEN", "invalid sender token");
  await rateLimit(`cookie:${senderId}`, 1, 600);
  const body = await readJson<{ li_at?: string; li_a?: string; user_agent?: string; ip?: string; plain_id?: string; public_identifier?: string }>(req);
  if (!body.li_at || !body.user_agent) throw new HttpError(400, "E_PAYLOAD_INVALID", "li_at and user_agent required");
  const { data: s } = await admin.from("outreach_senders").select("*").eq("id", senderId).single();
  if (!s || s.status === "disabled") throw new HttpError(404, "E_NOT_FOUND");
  // identity guard: the logged-in LinkedIn account must be the sender's own
  if (s.provider_user_id && body.plain_id && body.plain_id !== s.provider_user_id && body.plain_id !== s.provider_user_id?.replace(/^ACo/, "")) {
    await audit(s.workspace_id, "cookie.identity_mismatch", "sender", s.id, { got: body.plain_id });
    throw new HttpError(409, "E_IDENTITY_MISMATCH", "The LinkedIn account in this browser is not the sender's account");
  }
  if (s.public_identifier && body.public_identifier && body.public_identifier.toLowerCase() !== String(s.public_identifier).toLowerCase() && !body.plain_id) {
    throw new HttpError(409, "E_IDENTITY_MISMATCH", "The LinkedIn account in this browser is not the sender's account");
  }
  const li_at_enc = await encrypt(body.li_at);
  const li_a_enc = body.li_a ? await encrypt(body.li_a) : null;
  const ip = body.ip ?? (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ?? null;
  await admin.from("outreach_sender_secrets").upsert({ sender_id: s.id, li_at_enc, li_a_enc, cookie_captured_at: new Date().toISOString(), cookie_ip: ip || null, cookie_user_agent: body.user_agent, updated_at: new Date().toISOString() });
  await admin.from("outreach_secret_access_log").insert({ sender_id: s.id, fn: "cookie-sync:write" });
  const { data: ws } = await admin.from("outreach_workspaces").select("settings").eq("id", s.workspace_id).single();
  const patch: Record<string, unknown> = { user_agent: body.user_agent };
  if (s.auth_method === "credentials" && (ws?.settings?.cookie_mode_opt_in ?? true)) patch.auth_method = "cookie";
  await admin.from("outreach_senders").update(patch).eq("id", s.id);
  let reconnect: unknown = null;
  if (s.status === "credentials" && s.unipile_account_id) reconnect = await reconnectSender({ ...s, ...patch });
  return json({ ok: true, reconnect, sender: { id: s.id, display_name: s.display_name, status: s.status } });
});
