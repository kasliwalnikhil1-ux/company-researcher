// Item 13 — background enrichment (cron every 10 minutes).
// Budgeted path for leads that no sequence step is about to fetch: uses only the profile views LEFT OVER after the planner
// placed the day's sequence actions (≤30% of the cap, inside working hours, none at warm-up level 0–1). The database decides
// how many (outreach_enrich_allowance); this worker only spends what it is given, slowly.
// Priority leads = enrolments waiting on enrichment ("wait for enrichment" at enrol time).
// One invocation cannot wait 20–90 s between calls, so the pace is: at most 2 leads per sender per run, 3–8 s apart, every 10 minutes.
import { admin, json, serve, requireCron, log, rpc, flag, sleep, randInt } from "../_shared/outreach/supabase.ts";
import { unipile, UnipileError } from "../_shared/outreach/unipile.ts";
import { sectionsFor, enrichBackoff, saveProfile, fetchPostsBudgeted } from "../_shared/outreach/enrich.ts";

type Row = Record<string, any>;
const PER_SENDER = 2;
const LOOKAHEAD = 6;            // read a few more than we process, so a lead that only waits for post budget does not block the queue
const PROFILE_FRESH_MS = 24 * 3600_000;
const RUN_BUDGET_MS = 50_000;

interface OneResult { ok: boolean; viewSpent?: boolean; throttled?: boolean; stop?: boolean; skipped?: boolean; error?: string }

/** The profile is already stored (a step or an earlier run read it) and only the posts are missing: no profile view is spent. */
async function postsOnly(sender: Row, lead: Row): Promise<OneResult> {
  const r = await fetchPostsBudgeted(sender, lead, 5);
  if (r.ok) return { ok: true, viewSpent: false };                        // save_lead_posts clears the queue row
  if (r.reason === "no_budget") return { ok: false, skipped: true, error: "no_post_fetch_budget" };   // try again on a later run, costs nothing now
  await admin.from("outreach_enrich_queue").delete().eq("lead_id", lead.id);   // no provider id even after a profile read: nothing more to do
  return { ok: true, viewSpent: false };
}

async function enrichOne(sender: Row, item: Row): Promise<OneResult> {
  const { data: lead } = await admin.from("outreach_leads").select("*").eq("id", item.lead_id).maybeSingle();
  if (!lead) return { ok: false, error: "lead_missing" };
  if (lead.do_not_contact) return { ok: false, error: "do_not_contact" };
  const ident = lead.provider_id ?? lead.public_identifier;
  if (!ident) return { ok: false, error: "no_linkedin_identifier" };
  const { data: stored } = await admin.from("outreach_lead_profiles").select("enriched_at").eq("lead_id", lead.id).maybeSingle();
  if (item.want_posts && stored?.enriched_at && Date.now() - new Date(stored.enriched_at).getTime() < PROFILE_FRESH_MS) return postsOnly(sender, lead);

  const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
  const reserved = await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => false);
  if (!reserved) return { ok: false, stop: true, error: "no_profile_view_budget" };

  const sec = sectionsFor(sender);   // full named sections; this worker never runs for a sender that is backed off
  let prof: Row;
  try {
    prof = await unipile.users.profile(sender.unipile_account_id, ident, { notify: false, linkedin_sections: sec.query });
  } catch (e) {
    await rpc("release_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => null);
    const ue = e instanceof UnipileError ? e : null;
    // anything that smells like the account (auth, rate limit, provider down) stops this sender for the run; the health worker owns the rest
    const stop = !ue || ue.network || [401, 403, 429].includes(ue.status) || ue.status >= 500;
    return { ok: false, stop, error: ue ? `${ue.status}:${ue.code}` : String((e as any)?.message ?? e).slice(0, 200) };
  }
  await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch((e) => log({ fn: "worker-enrich", warn: `consume: ${String(e)}` }));

  // keep the lead row in step with what we just read (same fields the executor keeps)
  const cur = (prof.work_experience ?? []).find((w: Row) => w.current) ?? prof.work_experience?.[0];
  const { data: upd } = await admin.from("outreach_leads").update({
    provider_id: prof.provider_id ?? lead.provider_id,
    public_identifier: lead.public_identifier ?? (prof.public_identifier ? String(prof.public_identifier).toLowerCase() : null),
    headline: prof.headline ?? lead.headline, location: prof.location ?? lead.location, picture_url: prof.profile_picture_url ?? lead.picture_url,
    is_open_profile: typeof prof.is_open_profile === "boolean" ? prof.is_open_profile : lead.is_open_profile,
    company: cur?.company ?? lead.company, company_id: cur?.company_id ?? lead.company_id, title: cur?.position ?? lead.title,
    last_profile_fetch_at: new Date().toISOString(),
  }).eq("id", lead.id).select("*").maybeSingle();
  const l = upd ?? { ...lead, provider_id: prof.provider_id ?? lead.provider_id };

  const saved = await saveProfile(l, prof, sender, "background", sec.requested);
  if (!saved) return { ok: false, error: "save_failed" };
  if (saved.throttled) return { ok: false, viewSpent: true, throttled: true, stop: true, error: "sections_empty" };   // SQL counts the streak and sets the back-off

  if (item.want_posts && l.provider_id) {
    // separate endpoint, separate allowance; no budget or an error → the profile alone is stored
    try { await sleep(randInt(2000, 4000)); await fetchPostsBudgeted(sender, l, 5); }
    catch (e) { log({ fn: "worker-enrich", lead_id: l.id, warn: `posts: ${String((e as any)?.message ?? e)}` }); }
  }
  return { ok: true, viewSpent: true };
}

serve("worker-enrich", async (req) => {
  requireCron(req);
  if ((await flag("enrich_enabled", true)) === false) return json({ ok: true, skipped: "enrich_disabled" });
  const t0 = Date.now();
  const { data: senders } = await admin.from("outreach_senders").select("*").eq("status", "ok").is("deleted_at", null).eq("provider", "LINKEDIN").not("unipile_account_id", "is", null);
  const results: Row[] = [];
  let done = 0, failed = 0;

  for (const sender of (senders ?? []).sort(() => Math.random() - 0.5)) {
    if (Date.now() - t0 > RUN_BUDGET_MS) break;
    if (enrichBackoff(sender)) { results.push({ sender_id: sender.id, skipped: "enrich_backoff" }); continue; }
    try {
      // allowance is 0 outside working hours, when paused, backed off, or (for the backlog) at warm-up level 0–1
      const priorityAllow = await rpc<number>("enrich_allowance", { p_sender: sender.id, p_priority: true });
      const backlogAllow = await rpc<number>("enrich_allowance", { p_sender: sender.id, p_priority: false });
      if (priorityAllow <= 0 && backlogAllow <= 0) continue;
      const next = await rpc<Row[]>("enrich_next", { p_sender: sender.id, p_limit: LOOKAHEAD });
      const seen = new Set<string>();
      const items = (next ?? []).filter((x) => (seen.has(x.lead_id) ? false : (seen.add(x.lead_id), true)));   // priority rows come first
      let processed = 0, usedPriority = 0, usedBacklog = 0;
      for (const item of items) {
        if (processed >= PER_SENDER || Date.now() - t0 > RUN_BUDGET_MS) break;
        if (item.priority ? usedPriority >= priorityAllow : usedBacklog >= backlogAllow) continue;
        if (processed > 0) await sleep(randInt(3000, 8000));
        const r: OneResult = await enrichOne(sender, item).catch((e) => ({ ok: false, stop: true, error: String((e as any)?.message ?? e).slice(0, 200) }));
        if (r.skipped) { results.push({ sender_id: sender.id, lead_id: item.lead_id, skipped: r.error }); continue; }
        processed++;
        if (item.priority) usedPriority++; else usedBacklog++;
        // p_background = true counts a spent view against the 30% background share; priority leads belong to a campaign and do not.
        // Running out of budget is not the lead's fault: it is not recorded as a failed attempt.
        if (r.error !== "no_profile_view_budget") await rpc("enrich_done", { p_lead: item.lead_id, p_sender: sender.id, p_ok: r.ok, p_error: r.error ?? null, p_background: !!r.viewSpent && !item.priority }).catch((e) => log({ fn: "worker-enrich", warn: `enrich_done: ${String(e)}` }));
        if (r.ok) done++; else failed++;
        results.push({ sender_id: sender.id, lead_id: item.lead_id, priority: !!item.priority, ok: r.ok, error: r.error ?? null });
        if (r.stop) break;
      }
    } catch (e) { log({ fn: "worker-enrich", sender_id: sender.id, error: String((e as any)?.message ?? e) }); }
  }
  log({ fn: "worker-enrich", senders: senders?.length ?? 0, done, failed, duration_ms: Date.now() - t0 });
  return json({ ok: true, done, failed, results });
});
