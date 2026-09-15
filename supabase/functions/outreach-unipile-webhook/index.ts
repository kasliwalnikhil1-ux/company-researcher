// F1 — Unipile webhook receiver. Persist + ack fast (< 300ms). No business logic here.
// Deploy with --no-verify-jwt. Auth: header `unipile-auth` must equal UNIPILE_WEBHOOK_SECRET.
import { admin, json, serve, timingSafeEqual, HttpError } from "../_shared/outreach/supabase.ts";
import { deriveSource } from "../_shared/outreach/inbound.ts";

const SECRET = Deno.env.get("UNIPILE_WEBHOOK_SECRET") ?? "";

serve("unipile-webhook", async (req) => {
  if (req.method !== "POST") return json({ ok: true, fn: "outreach-unipile-webhook" });
  const auth = req.headers.get("unipile-auth") ?? req.headers.get("x-unipile-auth") ?? "";
  if (!SECRET || !timingSafeEqual(auth, SECRET)) throw new HttpError(401, "E_FORBIDDEN", "bad webhook secret");
  let payload: any;
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) payload = await req.json();
  else {
    const txt = await req.text();
    try { payload = JSON.parse(txt); } catch { payload = Object.fromEntries(new URLSearchParams(txt)); }
  }
  const { source, event_type, account_id } = deriveSource(payload);
  const { error } = await admin.from("outreach_inbound_events").insert({ source, event_type, unipile_account_id: account_id, payload });
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true });
});
