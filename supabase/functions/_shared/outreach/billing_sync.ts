// The billing job (pricing-billing-PRD §10.3, §12). It never changes a Stripe quantity: the customer buys a number of
// accounts up front and usage does not move the bill.
//   hourly: trial expiry → disconnect, past-due day 7 → suspend, 14-day billing pause → disconnect, reconciliation,
//           connector deletes (with retries), the emails the lifecycle owes, a safety-net re-read of subscriptions whose
//           period ended without a webhook
//   daily:  one usage row per workspace (information only), the connector cost report, deletion of workspaces past their date
import { admin, audit, log, rpc } from "./supabase.ts";
import { unipile, unipileConfigured } from "./unipile.ts";
import { stripeConfigured } from "./stripe.ts";
import { settlePendingChange, syncWorkspaceFromStripe } from "./billing.ts";
import { processAccountDeletions } from "./disconnect.ts";
import { platformAlert, sendBillingNotice, type BillingNoticeKind } from "./billing_emails.ts";

type Row = Record<string, any>;

const BUCKETS = ["outreach-attachments", "outreach-exports", "outreach-imports", "outreach-profile-assets", "outreach-knowledge", "outreach-chat-notes", "outreach-webchat", "outreach-webchat-media"];

async function flagOn(key: string): Promise<boolean> {
  const { data } = await admin.from("outreach_flags").select("value").eq("key", key).maybeSingle();
  return data?.value === true || data?.value === "true";
}

async function sendDueNotices(): Promise<number> {
  const due = (await rpc<Array<{ workspace_id: string; kind: BillingNoticeKind; period_key: string; data: Row }>>("billing_notices_due")) ?? [];
  let sent = 0;
  for (const n of due) sent += await sendBillingNotice(n.workspace_id, n.kind, n.period_key, n.data ?? {});
  return sent;
}

/** Subscriptions whose period ended, or whose pending payment lapsed, with no event to tell us: read them from Stripe. */
async function catchUpWithStripe(): Promise<number> {
  if (!stripeConfigured()) return 0;
  const now = new Date().toISOString();
  const { data: stale } = await admin.from("outreach_workspaces").select("id")
    .not("stripe_subscription_id", "is", null).in("stripe_status", ["active", "trialing", "past_due", "unpaid"]).is("deleted_at", null)
    .lt("current_period_end", new Date(Date.now() - 30 * 60_000).toISOString()).limit(50);
  const { data: pending } = await admin.from("outreach_workspaces").select("id").not("pending_payment", "is", null).is("deleted_at", null).lt("pending_payment->>expires_at", now).limit(50);
  const ids = [...new Set([...(stale ?? []), ...(pending ?? [])].map((w) => String(w.id)))];
  for (const id of ids) {
    try { await syncWorkspaceFromStripe(id); await settlePendingChange(id); }
    catch (e) { log({ fn: "billing-sync", workspace: id, error: `catch-up failed: ${String((e as Error)?.message ?? e)}` }); }
  }
  return ids.length;
}

export async function runBillingHourly(): Promise<Row> {
  const tick = await rpc<Row>("billing_tick");
  const deletions = await processAccountDeletions(40);
  if (deletions.stuck.length) {
    await platformAlert(`${deletions.stuck.length} connector account(s) could not be deleted for 24 hours`, ["We keep paying for these until they are removed. Delete them by hand on the connector dashboard if this persists."], deletions.stuck);
  }
  if ((tick?.reconciled ?? []).length) {
    await platformAlert(`${tick.reconciled.length} workspace(s) had more active accounts than their plan`, ["The extra accounts were paused (over_plan_limit). No code path should allow this: check the audit log entry billing.reconciled."], tick.reconciled);
  }
  const notices = await sendDueNotices();
  const caughtUp = await catchUpWithStripe();
  return { mode: "hourly", ...tick, account_deletions: { deleted: deletions.deleted, failed: deletions.failed }, notices_sent: notices, subscriptions_reread: caughtUp };
}

/** Remove every stored file of a workspace (objects live under `<workspace id>/` in each bucket). */
async function emptyWorkspaceStorage(workspaceId: string): Promise<number> {
  let removed = 0;
  for (const bucket of BUCKETS) {
    const stack = [workspaceId];
    for (let guard = 0; stack.length && guard < 2000; guard++) {
      const prefix = stack.pop()!;
      const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
      if (error || !data?.length) continue;
      const files = data.filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
      for (const o of data.filter((x) => !x.id)) stack.push(`${prefix}/${o.name}`);
      for (let i = 0; i < files.length; i += 100) {
        const { error: rmErr } = await admin.storage.from(bucket).remove(files.slice(i, i + 100));
        if (rmErr) throw new Error(`${bucket}: ${rmErr.message}`);
        removed += Math.min(100, files.length - i);
      }
      if (data.length === 1000) stack.push(prefix);          // more in this folder: list it again after the removals
    }
  }
  return removed;
}

export async function runBillingDaily(): Promise<Row> {
  const usage = await rpc<number>("billing_record_usage");

  // cost report: what is paid for vs what is connected, here and on the connector (PRD §12 #6)
  const report = (await rpc<Row>("billing_cost_report")) ?? {};
  if (unipileConfigured()) {
    try {
      const accounts = (await unipile.accounts.list()).items ?? [];
      report.connector_accounts = accounts.length;
      const { data: ours } = await admin.from("outreach_senders").select("unipile_account_id").not("unipile_account_id", "is", null);
      const known = new Set((ours ?? []).map((s) => String(s.unipile_account_id)));
      const { data: queued } = await admin.from("outreach_account_deletions").select("account_id").is("done_at", null);
      const pending = new Set((queued ?? []).map((q) => String(q.account_id)));
      // accounts on the connector that no sender owns and nothing is deleting: we pay for them and nobody uses them
      report.connector_orphans = accounts.filter((a: Row) => !known.has(String(a.id)) && !pending.has(String(a.id))).map((a: Row) => ({ id: a.id, name: a.name ?? null, type: a.type ?? null, created_at: a.created_at ?? null })).slice(0, 100);
    } catch (e) { report.connector_error = String((e as Error)?.message ?? e); }
  }
  const paidFor = Number(report.accounts_billed ?? 0) + Number(report.trial_accounts ?? 0);
  report.gap = report.connector_accounts != null ? Number(report.connector_accounts) - paidFor : null;
  await rpc("billing_save_cost_report", { p_report: report });
  const problems: string[] = [];
  if ((report.swaps ?? []).length) problems.push(`${report.swaps.length} workspace(s) swapped accounts more than 5 times this month (each swap is one extra connector account for the month).`);
  if ((report.connector_orphans ?? []).length) problems.push(`${report.connector_orphans.length} connector account(s) belong to no sender.`);
  if (report.enforced && report.connected_on_inactive_plans > 0) problems.push(`${report.connected_on_inactive_plans} account(s) are still connected on suspended, cancelled or lapsed workspaces (they are disconnected after 14 days).`);
  if (problems.length) await platformAlert("Daily connector cost report", problems, { accounts_billed: report.accounts_billed, trial_accounts: report.trial_accounts, connected: report.connected, connector_accounts: report.connector_accounts, gap: report.gap, swaps: report.swaps, orphans: report.connector_orphans });

  // workspaces past their date (trial ended 30 days ago / cancelled 90 days ago)
  const due = (await rpc<Row[]>("workspaces_due_for_deletion")) ?? [];
  const deleted: string[] = [];
  if (due.length) {
    if (await flagOn("billing_data_deletion")) {
      for (const w of due) {
        try {
          const files = await emptyWorkspaceStorage(w.workspace_id);
          const r = await rpc<Row>("purge_workspace", { p_ws: w.workspace_id });
          if (r?.deleted) { deleted.push(w.workspace_id); await audit(null, "workspace.data_deleted", "workspace", w.workspace_id, { name: w.name, plan: w.plan, files_removed: files, owner: w.owner_email }); }
        } catch (e) { log({ fn: "billing-sync", workspace: w.workspace_id, error: `deletion failed: ${String((e as Error)?.message ?? e)}` }); }
      }
    } else {
      await platformAlert(`${due.length} workspace(s) are past their deletion date`, ["Automatic deletion is off (platform flag billing_data_deletion). Turn it on in Settings → Admin → Billing, or delete them by hand."], due);
    }
  }
  const processed = await processAccountDeletions(60);
  return { mode: "daily", usage_rows: usage, report: { accounts_billed: report.accounts_billed, trial_accounts: report.trial_accounts, connected: report.connected, connector_accounts: report.connector_accounts ?? null, gap: report.gap },
    due_for_deletion: due.length, workspaces_deleted: deleted.length, account_deletions: { deleted: processed.deleted, failed: processed.failed } };
}
