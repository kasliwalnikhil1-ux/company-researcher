// One sync pass for one integration: push the waiting events, then (at most every 6 hours) refresh the customer blacklist.
// Used by the cron worker (outreach-crm-sync) and by "Sync now" (outreach-crm-oauth).
import { admin, log } from "../supabase.ts";
import { processBatch, type Integration } from "./engine.ts";
import { plainError } from "./http.ts";
import { getProvider } from "./index.ts";
import type { IntegrationEvent } from "./mapping.ts";
import { refreshBlacklist } from "./pull.ts";
import { createSession, createStore, loadTokens, markAuthError, writeLog } from "./store.ts";
import { CrmError } from "./types.ts";

export const EVENT_BATCH = 200;
export const PULL_EVERY_MS = 6 * 3_600_000;
const EVENT_RETENTION_MS = 7 * 86_400_000;

export interface IntegrationRow extends Integration { status: string; last_pull_at: string | null; last_sync_at: string | null; account_label: string | null }

export interface SyncSummary { integration_id: string; provider: string; events: number; synced: number; skipped: number; ignored: number; failed: number; stop: string | null; error: string | null; pulled: boolean; blacklist?: { total: number; added: number; removed: number; complete: boolean } }

export const INTEGRATION_COLUMNS = "id, workspace_id, provider, status, account_label, settings, field_mapping, stage_mapping, last_event_id, last_sync_at, last_pull_at";

export function toIntegration(row: any): IntegrationRow {
  return { ...row, settings: row.settings ?? {}, field_mapping: row.field_mapping ?? {}, stage_mapping: row.stage_mapping ?? {}, last_event_id: Number(row.last_event_id ?? 0) };
}

export async function syncIntegration(integ: IntegrationRow, opts: { deadline: number; pull?: "auto" | "force" | "skip" }): Promise<SyncSummary> {
  const sum: SyncSummary = { integration_id: integ.id, provider: integ.provider, events: 0, synced: 0, skipped: 0, ignored: 0, failed: 0, stop: null, error: null, pulled: false };
  const provider = getProvider(integ.provider);
  if (!provider.configured()) { sum.stop = "not_configured"; return sum; } // operator removed the env: leave the integration as it is
  const tokens = await loadTokens(integ.id);
  if (!tokens) {
    sum.stop = "auth"; sum.error = `${provider.label} is not connected any more. Connect it again.`;
    await markAuthError(integ.id, sum.error);
    return sum;
  }
  const session = createSession(integ.id, provider, tokens);
  const store = createStore(integ);

  // ---- push ----
  const { data: events, error } = await admin.from("outreach_integration_events").select("id, event, payload, at").eq("workspace_id", integ.workspace_id).gt("id", integ.last_event_id).order("id", { ascending: true }).limit(EVENT_BATCH);
  if (error) throw new Error(error.message);
  const batch = (events ?? []).map((e: any) => ({ id: Number(e.id), event: e.event, payload: e.payload ?? {}, at: e.at })) as IntegrationEvent[];
  sum.events = batch.length;
  const r = await processBatch({ integration: integ, provider, store, session }, batch, opts.deadline);
  Object.assign(sum, { synced: r.synced, skipped: r.skipped, ignored: r.ignored, failed: r.failed, stop: r.stop, error: r.error });

  const patch: Record<string, unknown> = { last_event_id: r.lastEventId, last_sync_at: new Date().toISOString(), last_error: r.stop && r.stop !== "time" ? r.error : null };
  if (r.stop === "auth") patch.status = "error";
  await admin.from("outreach_integrations").update(patch).eq("id", integ.id);
  if (r.stop === "auth") await writeLog(integ, { lead_id: null, direction: "push", op: "contact.upsert", status: "error", detail: r.error ?? `${provider.label} no longer accepts our access. Reconnect the integration.` });

  // ---- pull ----
  const due = !integ.last_pull_at || Date.now() - new Date(integ.last_pull_at).getTime() >= PULL_EVERY_MS;
  const wantPull = integ.settings.suppress_customers === true && opts.pull !== "skip" && (opts.pull === "force" || due);
  if (wantPull && r.stop !== "auth" && r.stop !== "rate_limit" && Date.now() < opts.deadline - 3_000) {
    try {
      const b = await refreshBlacklist(integ, provider, session, opts.deadline);
      sum.pulled = true; sum.blacklist = b;
      await admin.from("outreach_integrations").update({ last_pull_at: new Date().toISOString() }).eq("id", integ.id);
    } catch (e) {
      const msg = plainError(e);
      if (e instanceof CrmError && e.kind === "auth") { await markAuthError(integ.id, msg); sum.stop = "auth"; }
      // try again in about an hour, not on every run
      else await admin.from("outreach_integrations").update({ last_pull_at: new Date(Date.now() - PULL_EVERY_MS + 3_600_000).toISOString() }).eq("id", integ.id);
      await writeLog(integ, { lead_id: null, direction: "pull", op: "suppress.refresh", status: "error", detail: msg });
      sum.error = sum.error ?? msg;
    }
  }
  return sum;
}

/** Events every active integration of the workspace has passed, older than a week, are no longer needed. */
export async function pruneEvents(workspaceId: string): Promise<void> {
  try {
    const { data } = await admin.from("outreach_integrations").select("last_event_id").eq("workspace_id", workspaceId).in("status", ["active", "error"]);
    if (!data?.length) return;
    const min = Math.min(...data.map((d: any) => Number(d.last_event_id ?? 0)));
    if (min > 0) await admin.from("outreach_integration_events").delete().eq("workspace_id", workspaceId).lte("id", min).lt("at", new Date(Date.now() - EVENT_RETENTION_MS).toISOString());
  } catch (e) { log({ fn: "crm-sync", prune_warn: String(e) }); }
}
