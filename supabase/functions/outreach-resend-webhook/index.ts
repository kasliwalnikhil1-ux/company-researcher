// F57 — Resend webhooks (custom-sending-domain-PRD.md §5.4). Deploy with --no-verify-jwt; the Svix signature is checked here
// with RESEND_WEBHOOK_SECRET. Email events update outreach_email_log; a hard bounce or a suppression on a holder email
// opens a task for the connecting member / the owners; domain.updated and domain.deleted keep the domain row true.
import { json, serve, HttpError, log, rpc } from "../_shared/outreach/supabase.ts";
import { verifyStandardWebhook } from "../_shared/outreach/webhook_sig.ts";
import { onDomainEvent } from "../_shared/outreach/sending_domains.ts";

const SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";
type Row = Record<string, any>;

serve("resend-webhook", async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "E_PAYLOAD_INVALID", "POST only");
  const raw = await req.text();
  if (!SECRET) throw new HttpError(503, "E_NOT_CONFIGURED", "RESEND_WEBHOOK_SECRET is not set");
  if (!(await verifyStandardWebhook(req.headers, raw, SECRET, { prefix: "svix" }))) throw new HttpError(401, "E_SIGNATURE", "bad signature");
  let event: Row;
  try { event = JSON.parse(raw); } catch { throw new HttpError(400, "E_PAYLOAD_INVALID", "not JSON"); }
  const type = String(event.type ?? "");
  const data: Row = event.data ?? {};
  if (type.startsWith("domain.")) return json(await onDomainEvent(type, data));
  if (!type.startsWith("email.")) return json({ ok: true, ignored: type });
  const emailId = String(data.email_id ?? data.id ?? "");
  if (!emailId) return json({ ok: false, reason: "no email id" });
  const r = await rpc<Row>("email_event", { p_resend_id: emailId, p_event: type, p_payload: { created_at: event.created_at ?? data.created_at ?? null, bounce: data.bounce ?? null, failed: data.failed ?? null, type: data.bounce?.type ?? null } });
  if (!r?.ok) { log({ fn: "resend-webhook", warn: r?.reason ?? "unhandled", type, email_id: emailId }); return json({ ok: true, ignored: r?.reason ?? type }); }
  let task: string | null = null;
  if (r.audience === "holder" && ((type === "email.bounced" && r.hard_bounce) || type === "email.suppressed")) {
    task = await rpc<string | null>("email_bounce_task", { p_outbox: r.outbox_id }).catch((e) => { log({ fn: "resend-webhook", error: String(e) }); return null; });
  }
  return json({ ok: true, outbox_id: r.outbox_id, status: r.delivery_status, task });
});
