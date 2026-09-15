// F11 — Hosted-auth notify_url callback ({status, account_id, name}). Deploy with --no-verify-jwt.
// Persist as an inbound event and process immediately (idempotent).
import { admin, json, serve, log } from "../_shared/outreach/supabase.ts";
import { handleHostedNotify } from "../_shared/outreach/inbound.ts";

serve("sender-notify", async (req) => {
  if (req.method !== "POST") return json({ ok: true });
  const url = new URL(req.url);
  let payload: any = {};
  try { payload = await req.json(); } catch { const t = await req.text(); try { payload = JSON.parse(t); } catch { payload = Object.fromEntries(new URLSearchParams(t)); } }
  const sid = url.searchParams.get("sid");
  if (!payload.name && sid) payload.name = sid;
  // basic guard: the sender id in `name` must exist and be in connecting/credentials/ok state
  const { data: s } = await admin.from("outreach_senders").select("id").eq("id", payload.name ?? "").maybeSingle();
  if (!s) { log({ fn: "sender-notify", warn: "unknown sender", payload }); return json({ ok: true }); }
  await admin.from("outreach_inbound_events").insert({ source: "hosted_notify", event_type: String(payload.status ?? "").toUpperCase(), unipile_account_id: payload.account_id ?? null, payload, processed_at: new Date().toISOString() });
  try { await handleHostedNotify(payload); } catch (e) { log({ fn: "sender-notify", error: String(e) }); }
  return json({ ok: true });
});
