// F22 — CSV export (leads | messages | actions | audit) to the private exports bucket; returns a signed URL (manager+).
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, audit, rateLimit } from "../_shared/outreach/supabase.ts";

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

serve("exports-create", async (req) => {
  const user = await requireUser(req);
  await rateLimit(`user:${user.id}:exports`, 10, 600);
  const body = await readJson<{ workspace_id: string; kind: "leads" | "messages" | "actions" | "audit"; client_id?: string | null; filters?: Record<string, unknown> }>(req);
  if (!body.workspace_id || !body.kind) throw new HttpError(400, "E_PAYLOAD_INVALID");
  const m = await membership(user.id, body.workspace_id);
  requireRole(m, "manager");
  const ws = body.workspace_id;
  let columns: string[] = [];
  const rows: unknown[][] = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    let q;
    switch (body.kind) {
      case "leads": q = admin.from("outreach_leads").select("id, public_identifier, provider_id, profile_url, first_name, last_name, full_name, headline, company, title, location, email_work, email_personal, is_open_profile, do_not_contact, unsubscribed, source, list_id, stage_id, client_id, custom, created_at, updated_at").eq("workspace_id", ws).order("created_at"); if (body.client_id) q = q.eq("client_id", body.client_id); break;
      case "messages": q = admin.from("outreach_messages").select("id, chat_id, direction, text, sent_at, intent, intent_confidence, summary, opens, clicks, unipile_message_id, outreach_chats!inner(sender_id, lead_id, attendee_name, provider, client_id)").eq("workspace_id", ws).order("sent_at"); if (body.client_id) q = q.eq("outreach_chats.client_id", body.client_id); break;
      case "actions": q = admin.from("outreach_actions").select("id, enrollment_id, sender_id, lead_id, node_id, action_type, scheduled_for, status, attempt, error_code, decision, executed_at, created_at").eq("workspace_id", ws).order("created_at"); break;
      case "audit": q = admin.from("outreach_audit_log").select("id, actor, actor_type, action, entity, entity_id, diff, at").eq("workspace_id", ws).order("at"); break;
      default: throw new HttpError(400, "E_PAYLOAD_INVALID", "unknown kind");
    }
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) throw new HttpError(500, "E_INTERNAL", error.message);
    if (!data?.length) break;
    if (!columns.length) columns = Object.keys(data[0]).filter((k) => !k.startsWith("outreach_"));
    for (const r of data as any[]) {
      const flat: Record<string, unknown> = { ...r };
      if (r.outreach_chats) { flat.sender_id = r.outreach_chats.sender_id; flat.lead_id = r.outreach_chats.lead_id; flat.attendee_name = r.outreach_chats.attendee_name; flat.provider = r.outreach_chats.provider; delete flat.outreach_chats; }
      if (!columns.includes("attendee_name") && flat.attendee_name !== undefined) columns.push("sender_id", "lead_id", "attendee_name", "provider");
      rows.push(columns.map((c) => flat[c]));
    }
    if (data.length < pageSize || rows.length >= 200_000) break;
    from += pageSize;
  }
  const csv = [columns.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\r\n");
  const path = `${ws}/${body.kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  const { error: upErr } = await admin.storage.from("outreach-exports").upload(path, new Blob([csv], { type: "text/csv" }), { contentType: "text/csv", upsert: true });
  if (upErr) throw new HttpError(500, "E_INTERNAL", upErr.message);
  const { data: signed, error: sErr } = await admin.storage.from("outreach-exports").createSignedUrl(path, 3600);
  if (sErr) throw new HttpError(500, "E_INTERNAL", sErr.message);
  await audit(ws, "export.created", "export", path, { kind: body.kind, rows: rows.length, by: user.id }, "user");
  return json({ ok: true, url: signed.signedUrl, rows: rows.length, path });
});
