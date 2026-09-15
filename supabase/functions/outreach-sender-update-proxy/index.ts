// F12 — Change proxy country (manager+). Every change audited.
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, audit } from "../_shared/outreach/supabase.ts";
import { unipile } from "../_shared/outreach/unipile.ts";

serve("sender-update-proxy", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ sender_id: string; country?: string; proxy?: { protocol: string; host: string; port: number; username?: string; password?: string } }>(req);
  const { data: s } = await admin.from("outreach_senders").select("*").eq("id", body.sender_id ?? "").maybeSingle();
  if (!s) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, s.workspace_id);
  requireRole(m, "manager");
  if (!s.unipile_account_id) throw new HttpError(400, "E_SENDER_NOT_OK", "sender not connected yet");
  const country = body.country ? body.country.toUpperCase().slice(0, 2) : undefined;
  if (!country && !body.proxy) throw new HttpError(400, "E_PAYLOAD_INVALID", "country or proxy required");
  const patch: Record<string, unknown> = {};
  if (body.proxy) patch.proxy = body.proxy;
  if (country) patch.country = country;
  await unipile.accounts.patch(s.unipile_account_id, patch);
  await admin.from("outreach_senders").update({ proxy_country: country ?? s.proxy_country }).eq("id", s.id);
  await admin.from("outreach_sender_events").insert({ sender_id: s.id, kind: "proxy", data: { by: user.id, country, custom_proxy: !!body.proxy } });
  await audit(s.workspace_id, "sender.proxy", "sender", s.id, { country, custom_proxy: !!body.proxy }, "user");
  return json({ ok: true, proxy_country: country ?? s.proxy_country });
});
