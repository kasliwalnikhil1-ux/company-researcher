// F13 — Disable a sender: cancels queued actions, exits enrollments (trigger), and removes the connected account on the
// connector side the same day (a connected account nobody uses still costs us; pricing-billing-PRD §12). `delete_unipile`
// also removes the sender from the workspace for good. Disabling frees the account slot at once.
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, audit, emitEvent, rpc } from "../_shared/outreach/supabase.ts";
import { dropConnectorAccount } from "../_shared/outreach/disconnect.ts";

serve("sender-disable", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ sender_id: string; delete_unipile?: boolean; purge_secrets?: boolean }>(req);
  const { data: s } = await admin.from("outreach_senders").select("*").eq("id", body.sender_id ?? "").maybeSingle();
  if (!s) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, s.workspace_id);
  requireRole(m, "manager");
  const account = s.unipile_account_id as string | null;
  const { error } = await admin.from("outreach_senders").update({
    status: "disabled", status_reason: "disabled_by_user", deleted_at: body.delete_unipile ? new Date().toISOString() : null,
    unipile_account_id: null, previous_unipile_account_id: account ?? s.previous_unipile_account_id ?? null,
  }).eq("id", s.id);
  if (error) throw new HttpError(500, "E_INTERNAL", error.message);
  await rpc("slot_release_sender", { p_sender: s.id, p_reason: "failed" }).catch(() => null);
  const unipileDeleted = account ? await dropConnectorAccount(account, s.workspace_id, "disabled") : false;
  // the saved sign-in only works for an account that still exists
  await admin.from("outreach_sender_secrets").delete().eq("sender_id", s.id);
  if (body.delete_unipile || body.purge_secrets) await admin.from("outreach_sender_tokens").delete().eq("sender_id", s.id);
  await audit(s.workspace_id, "sender.disabled", "sender", s.id, { by: user.id, removed: !!body.delete_unipile, account_deleted: unipileDeleted, account_queued: !!account && !unipileDeleted }, "user");
  await emitEvent(s.workspace_id, "sender.disconnected", { id: s.id, status: "disabled" });
  return json({ ok: true, unipile_deleted: unipileDeleted, account_queued: !!account && !unipileDeleted });
});
