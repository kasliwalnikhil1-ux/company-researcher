// Disconnect (pricing-billing-PRD §12.1): the connector account is deleted so it stops costing us, while the sender row, its
// conversations, relations and enrolments stay. The owner signs in again later onto the same sender.
// The database half is outreach_disconnect_sender(); the connector delete is tried at once and, when it fails, retried by the
// hourly billing job with backoff (outreach_account_deletions).
import { admin, log, rpc } from "./supabase.ts";
import { unipile, unipileConfigured, UnipileError } from "./unipile.ts";

export type DisconnectReason = "trial_expired" | "billing_suspended" | "billing_cancelled" | "over_plan_limit" | "user_disconnected";

/** Delete one connector account. "Already gone" counts as done. */
export async function deleteConnectorAccount(accountId: string): Promise<{ ok: boolean; error?: string }> {
  if (!unipileConfigured()) return { ok: false, error: "connector not configured" };
  try { await unipile.accounts.delete(accountId); return { ok: true }; }
  catch (e) {
    if (e instanceof UnipileError && e.status === 404) return { ok: true };
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Queue an account for deletion without a sender (an orphan left by a refused or mismatched sign-in) and try it now. */
export async function dropConnectorAccount(accountId: string, workspaceId: string | null, reason: string): Promise<boolean> {
  await admin.from("outreach_account_deletions").upsert({ account_id: accountId, workspace_id: workspaceId, reason }, { onConflict: "account_id", ignoreDuplicates: true });
  const r = await deleteConnectorAccount(accountId);
  await rpc("account_deletion_result", { p_account: accountId, p_ok: r.ok, p_error: r.error ?? null }).catch((e) => log({ fn: "disconnect", error: String(e) }));
  return r.ok;
}

/** Disconnect a sender now. Returns whether the connector account is already gone (false = queued for retry). */
export async function disconnectSender(senderId: string, reason: DisconnectReason): Promise<{ account_id: string | null; deleted: boolean; already?: boolean }> {
  const r = await rpc<{ account_id: string | null; already?: boolean }>("disconnect_sender", { p_sender: senderId, p_reason: reason });
  if (!r?.account_id) return { account_id: null, deleted: true, already: !!r?.already };
  const d = await deleteConnectorAccount(r.account_id);
  await rpc("account_deletion_result", { p_account: r.account_id, p_ok: d.ok, p_error: d.error ?? null }).catch((e) => log({ fn: "disconnect", error: String(e) }));
  return { account_id: r.account_id, deleted: d.ok };
}

/** Work through the deletion queue. Returns counts and the rows that have been failing for a day (alert the operator once). */
export async function processAccountDeletions(limit = 25): Promise<{ deleted: number; failed: number; stuck: Array<Record<string, unknown>> }> {
  const due = (await rpc<Array<{ account_id: string; sender_id: string | null; workspace_id: string | null; reason: string }>>("account_deletions_due", { p_limit: limit })) ?? [];
  let deleted = 0, failed = 0;
  const stuck: Array<Record<string, unknown>> = [];
  for (const d of due) {
    const r = await deleteConnectorAccount(d.account_id);
    const res = await rpc<{ alert?: boolean }>("account_deletion_result", { p_account: d.account_id, p_ok: r.ok, p_error: r.error ?? null }).catch(() => null);
    if (r.ok) deleted++; else { failed++; if (res?.alert) stuck.push({ ...d, error: r.error }); }
  }
  return { deleted, failed, stuck };
}
