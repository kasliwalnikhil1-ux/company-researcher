// Item 22 — CRM sync worker (cron, every 5 minutes). For every active integration: push the waiting events to the CRM,
// then, at most every 6 hours, refresh the "customers and open deals" blacklist. Every write lands in outreach_crm_sync_log.
import { admin, json, log, requireCron, serve } from "../_shared/outreach/supabase.ts";
import { INTEGRATION_COLUMNS, pruneEvents, syncIntegration, toIntegration, type SyncSummary } from "../_shared/outreach/crm/worker.ts";

const RUN_BUDGET_MS = 50_000;
const MIN_SHARE_MS = 8_000;

serve("crm-sync", async (req) => {
  requireCron(req);
  const started = Date.now();
  const deadline = started + RUN_BUDGET_MS;

  // round-robin: whoever was synced longest ago goes first, and everyone gets a share of the 50 seconds
  const { data, error } = await admin.from("outreach_integrations").select(INTEGRATION_COLUMNS).eq("status", "active").order("last_sync_at", { ascending: true, nullsFirst: true }).limit(200);
  if (error) throw new Error(error.message);
  const integrations = (data ?? []).map(toIntegration);

  const results: SyncSummary[] = [];
  const workspaces = new Set<string>();
  for (let i = 0; i < integrations.length; i++) {
    const left = deadline - Date.now();
    if (left < 4_000) break; // the rest goes first next time (oldest last_sync_at)
    const share = Math.min(left, Math.max(MIN_SHARE_MS, Math.floor(left / (integrations.length - i))));
    const integ = integrations[i];
    try {
      const r = await syncIntegration(integ, { deadline: Date.now() + share, pull: "auto" });
      results.push(r);
      workspaces.add(integ.workspace_id);
      if (r.events || r.pulled || r.stop) log({ fn: "crm-sync", ...r });
    } catch (e) {
      // our own failure (database, decrypt): leave the integration alone and try again next run
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      log({ fn: "crm-sync", integration_id: integ.id, error: msg });
      results.push({ integration_id: integ.id, provider: integ.provider, events: 0, synced: 0, skipped: 0, ignored: 0, failed: 0, stop: "internal", error: msg, pulled: false });
    }
  }
  for (const ws of workspaces) { if (Date.now() > deadline) break; await pruneEvents(ws); }

  return json({ ok: true, integrations: integrations.length, processed: results.length, duration_ms: Date.now() - started, results });
});
