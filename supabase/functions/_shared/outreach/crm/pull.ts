// The pull half: "never contact existing customers or open deals" (plan item 17), kept fresh from the CRM,
// and the segment import. Blacklist rows only block enrolment and sending. They delete nothing.
import { admin, rpc } from "../supabase.ts";
import type { CrmSession, Integration } from "./engine.ts";
import { diffSuppressions, linkedinIdentifier, type SuppressionRow } from "./mapping.ts";
import { writeLog } from "./store.ts";
import type { BlacklistPage, CrmProvider, ImportedLead, SegmentPage } from "./types.ts";

const MAX_BLACKLIST_VALUES = 60_000;
const MAX_PAGES = 400;

export interface BlacklistResult { complete: boolean; total: number; added: number; removed: number }

export async function refreshBlacklist(integ: Integration, provider: CrmProvider, session: CrmSession, deadline: number): Promise<BlacklistResult> {
  const source = `crm:${integ.provider}`;
  const fresh = { emails: [] as string[], domains: [] as string[], companies: [] as string[] };
  let cursor: string | null = null, complete = false;
  for (let i = 0; i < MAX_PAGES; i++) {
    if (Date.now() > deadline || fresh.emails.length + fresh.domains.length + fresh.companies.length > MAX_BLACKLIST_VALUES) break;
    const c: string | null = cursor;
    const page: BlacklistPage = await session.call((t) => provider.listCustomersAndOpenDeals(t, c));
    fresh.emails.push(...page.emails); fresh.domains.push(...page.domains); fresh.companies.push(...page.companies);
    cursor = page.next;
    if (!cursor) { complete = true; break; }
  }

  const existing: SuppressionRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("outreach_suppressions").select("id, kind, value").eq("workspace_id", integ.workspace_id).eq("source", source).is("client_id", null).is("sequence_id", null).order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    existing.push(...((data ?? []) as SuppressionRow[]));
    if ((data ?? []).length < 1000) break;
  }
  const diff = diffSuppressions(existing, fresh);

  // outreach_add_suppressions normalises the value and inserts with "on conflict do nothing": an entry somebody added by hand stays theirs
  let added = 0;
  for (let i = 0; i < diff.add.length; i += 5000) {
    const r = await rpc<{ added: number }>("add_suppressions", { p_ws: integ.workspace_id, p_rows: diff.add.slice(i, i + 5000).map((x) => ({ kind: x.kind, value: x.value, reason: `Customer or open deal in ${provider.label}` })), p_client: null, p_sequence: null, p_source: source });
    added += Number(r?.added ?? 0);
  }
  // rows are only removed after a complete read, otherwise a slow CRM would unblock customers
  let removed = 0;
  if (complete) {
    for (let i = 0; i < diff.removeIds.length; i += 200) {
      const ids = diff.removeIds.slice(i, i + 200);
      const { error } = await admin.from("outreach_suppressions").delete().in("id", ids).eq("source", source);
      if (error) throw new Error(error.message);
      removed += ids.length;
    }
  }
  await writeLog(integ, { lead_id: null, direction: "pull", op: "suppress.refresh", status: "ok", detail: `Customers and open deals: ${diff.total} entries (${added} new, ${removed} removed)${complete ? "" : ". The CRM list was not read to the end this time, so nothing was removed."}` });
  return { complete, total: diff.total, added, removed };
}

// ---------------------------------------------------------------------------
// Segment import
// ---------------------------------------------------------------------------
export const IMPORT_CAP = 5000;

export interface ImportResult { imported: number; created: number; updated: number; skipped_no_identity: number; failed: number; next_cursor: string | null; done: boolean; capped: boolean }

function toLeadJson(l: ImportedLead, listId: string | null, clientId: string | null): Record<string, unknown> | null {
  const pid = linkedinIdentifier(l.linkedin_url);
  const email = l.email?.trim().toLowerCase() || null;
  if (!pid && !email) return null;
  const out: Record<string, unknown> = { first_name: l.first_name ?? null, last_name: l.last_name ?? null, full_name: l.full_name ?? null, title: l.title ?? null, company: l.company ?? null };
  if (pid) { out.public_identifier = pid; out.profile_url = `https://www.linkedin.com/in/${pid}`; }
  if (email) out.email_work = email;
  if (listId) out.list_id = listId;
  if (clientId) out.client_id = clientId;
  return out;
}

export async function importSegment(integ: Integration, provider: CrmProvider, session: CrmSession, args: { segmentId: string; segmentName?: string | null; listId: string | null; clientId: string | null; cursor: string | null; deadline: number }): Promise<ImportResult> {
  const res: ImportResult = { imported: 0, created: 0, updated: 0, skipped_no_identity: 0, failed: 0, next_cursor: args.cursor, done: false, capped: false };
  const source = `crm:${integ.provider}`;
  let cursor = args.cursor;
  let seen = 0;
  while (true) {
    const c: string | null = cursor;
    const page: SegmentPage = await session.call((t) => provider.importSegment(t, args.segmentId, c));
    const links: { integration_id: string; lead_id: string; crm_contact_id: string; crm_company_id: string | null; last_synced_at: string }[] = [];
    // upsert_lead is one call per lead: run a few at a time
    for (let i = 0; i < page.leads.length; i += 8) {
      await Promise.all(page.leads.slice(i, i + 8).map(async (l) => {
        const json = toLeadJson(l, args.listId, args.clientId);
        if (!json) { res.skipped_no_identity++; return; }
        try {
          const r = await rpc<any>("upsert_lead", { p_ws: integ.workspace_id, p_lead: json, p_source: source });
          const row = Array.isArray(r) ? r[0] : r;
          if (!row?.id) { res.failed++; return; }
          if (l.phone) await admin.from("outreach_leads").update({ phone: l.phone }).eq("id", row.id).is("phone", null);
          res.imported++; if (row.created) res.created++; else res.updated++;
          links.push({ integration_id: integ.id, lead_id: row.id, crm_contact_id: l.crm_contact_id, crm_company_id: l.crm_company_id ?? null, last_synced_at: new Date().toISOString() });
        } catch { res.failed++; }
      }));
    }
    if (links.length) {
      const unique = [...new Map(links.map((x) => [x.lead_id, x])).values()];
      const { error } = await admin.from("outreach_crm_links").upsert(unique, { onConflict: "integration_id,lead_id" });
      if (error) throw new Error(`could not link the imported leads: ${error.message}`);
    }
    seen += page.leads.length;
    cursor = page.next;
    res.next_cursor = cursor;
    if (!cursor) { res.done = true; break; }
    if (seen >= IMPORT_CAP) { res.capped = true; break; }
    if (Date.now() > args.deadline) break;
  }
  const name = args.segmentName ? `"${args.segmentName}"` : `segment ${args.segmentId}`;
  const tail = res.done ? "" : res.capped ? ` Stopped at the ${IMPORT_CAP} per run limit: run the import again to continue.` : " Ran out of time: run the import again to continue.";
  await writeLog(integ, { lead_id: null, direction: "pull", op: "list.import", status: res.failed && !res.imported ? "error" : "ok", detail: `Imported ${name}: ${res.imported} leads (${res.created} new, ${res.updated} already known), ${res.skipped_no_identity} without an email or LinkedIn URL${res.failed ? `, ${res.failed} failed` : ""}.${tail}` });
  return res;
}
