// F13 (legacy name) — kept for older clients and the MCP skill text. The lifecycle lives in outreach-sender-lifecycle
// (sender-lifecycle-PRD.md). Body {sender_id, delete_unipile?} → delete_unipile: Remove (connector account deleted,
// history kept); otherwise Disable (leads exit, the connector link and the paid account stay).
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError } from "../_shared/outreach/supabase.ts";
import { removeSender } from "../_shared/outreach/lifecycle.ts";

serve("sender-disable", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ sender_id: string; delete_unipile?: boolean; purge_secrets?: boolean }>(req);
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, status, provider, deleted_at").eq("id", body.sender_id ?? "").maybeSingle();
  if (!s || s.deleted_at) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, s.workspace_id);
  requireRole(m, "manager");
  if (s.provider === "WEBCHAT") throw new HttpError(400, "E_PAYLOAD_INVALID", "A website inbox is managed from its Website agents page.");
  if (body.delete_unipile) {
    const r = await removeSender(s.id, "app", { by: user.id, reason: "sender-disable delete_unipile" });
    return json({ ok: true, state: r.state === "pending" ? "removal_pending" : r.state, unipile_deleted: r.account_deleted, account_queued: r.state === "pending" }, r.state === "pending" ? 202 : 200);
  }
  const { data, error } = await user.client.rpc("outreach_sender_disable", { p_sender: s.id, p_reason: null });
  if (error) {
    const mm = /^(E_[A-Z_]+):?\s*(.*)$/s.exec(error.message.trim());
    if (mm) throw new HttpError(mm[1] === "E_FORBIDDEN" ? 403 : 409, mm[1], mm[2] || undefined);
    throw new Error(error.message);
  }
  return json({ ok: true, state: "disabled", unipile_deleted: false, account_queued: false, ...(data as Record<string, unknown>) });
});
