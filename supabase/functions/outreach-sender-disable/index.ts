// F13 — Disable a sender: cancels queued actions, exits enrollments (trigger), optionally deletes the Unipile account.
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, audit, emitEvent } from "../_shared/outreach/supabase.ts";
import { unipile, unipileConfigured } from "../_shared/outreach/unipile.ts";

serve("sender-disable", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ sender_id: string; delete_unipile?: boolean; purge_secrets?: boolean }>(req);
  const { data: s } = await admin.from("outreach_senders").select("*").eq("id", body.sender_id ?? "").maybeSingle();
  if (!s) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, s.workspace_id);
  requireRole(m, "manager");
  await admin.from("outreach_senders").update({ status: "disabled", status_reason: "disabled_by_user", deleted_at: body.delete_unipile ? new Date().toISOString() : null }).eq("id", s.id);
  let unipileDeleted = false;
  if (body.delete_unipile && s.unipile_account_id && unipileConfigured()) {
    try { await unipile.accounts.delete(s.unipile_account_id); unipileDeleted = true; } catch (e) { await audit(s.workspace_id, "sender.unipile_delete_failed", "sender", s.id, { error: String(e) }, "user"); }
  }
  if (body.delete_unipile || body.purge_secrets) {
    await admin.from("outreach_sender_secrets").delete().eq("sender_id", s.id);
    await admin.from("outreach_sender_tokens").delete().eq("sender_id", s.id);
  }
  await audit(s.workspace_id, "sender.disabled", "sender", s.id, { by: user.id, delete_unipile: !!body.delete_unipile, unipile_deleted: unipileDeleted }, "user");
  await emitEvent(s.workspace_id, "sender.disconnected", { id: s.id, status: "disabled" });
  return json({ ok: true, unipile_deleted: unipileDeleted });
});
