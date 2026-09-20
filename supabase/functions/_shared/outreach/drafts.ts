// AI drafting → approval tasks (F19). Never auto-sends.
// Item 14, last bullet: drafts read the STORED enrichment first and only fetch the profile when nothing is stored.
// Every LinkedIn read here is budgeted (profile_view, post_fetch); with no budget the draft is simply written without it.
import { admin, log, rpc } from "./supabase.ts";
import { unipile } from "./unipile.ts";
import { draftCopy, aiConfigured } from "./ai.ts";
import { sectionsFor, saveProfile, fetchPostsBudgeted } from "./enrich.ts";

type Row = Record<string, any>;
const LIMIT: Record<string, number> = { invite_note: 300, invite_note_free: 200, message: 8000, comment: 1250 };
const POSTS_FRESH_DAYS = 7;

/** Profile fetch for a draft, only when nothing is stored: reserve profile_view → fetch (full sections, no visit notification) → consume → store. */
async function fetchProfileForDraft(sender: Row, lead: Row): Promise<Row> {
  const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
  const ok = await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => false);
  if (!ok) return lead;
  let prof: Row;
  const sec = sectionsFor(sender);
  try { prof = await unipile.users.profile(sender.unipile_account_id, lead.provider_id ?? lead.public_identifier, { notify: false, linkedin_sections: sec.query }); }
  catch (e) { await rpc("release_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => null); throw e; }
  await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => null);
  const cur = (prof.work_experience ?? []).find((w: Row) => w.current) ?? prof.work_experience?.[0];
  const { data: upd } = await admin.from("outreach_leads").update({ provider_id: prof.provider_id ?? lead.provider_id, headline: prof.headline ?? lead.headline, company: cur?.company ?? lead.company, title: cur?.position ?? lead.title, location: prof.location ?? lead.location, is_open_profile: prof.is_open_profile ?? lead.is_open_profile, last_profile_fetch_at: new Date().toISOString() }).eq("id", lead.id).select("*").single();
  const l = upd ?? lead;
  await saveProfile(l, prof, sender, "draft", sec.requested);
  return l;
}

/** Fill ai_draft on a review task. Returns the draft text. */
export async function draftForTask(taskId: string): Promise<string | null> {
  const { data: t } = await admin.from("outreach_tasks").select("*").eq("id", taskId).single();
  if (!t || t.kind !== "review_ai_draft" || t.completed_at) return null;
  if (!aiConfigured()) { await admin.from("outreach_tasks").update({ body: (t.body ?? "") + "\n\n[AI drafting unavailable: GEMINI_API_KEY not configured — write the copy manually]" }).eq("id", taskId); return null; }
  const [{ data: lead }, { data: sender }] = await Promise.all([
    t.lead_id ? admin.from("outreach_leads").select("*").eq("id", t.lead_id).single() : Promise.resolve({ data: null } as any),
    t.sender_id ? admin.from("outreach_senders").select("*").eq("id", t.sender_id).single() : Promise.resolve({ data: null } as any),
  ]);
  let brief = t.body ?? "";
  let kind = (t.draft_kind ?? "message") as "invite_note" | "message" | "comment";
  if (t.enrollment_id && t.node_id) {
    const { data: enr } = await admin.from("outreach_enrollments").select("sequence_id").eq("id", t.enrollment_id).single();
    const [{ data: seq }, graph] = await Promise.all([
      admin.from("outreach_sequences").select("brief").eq("id", enr!.sequence_id).single(),
      rpc<Row | null>("enrollment_graph", { p_enrollment: t.enrollment_id }).catch(() => null),   // pinned version when the lead is pinned
    ]);
    const node = graph?.nodes?.[t.node_id];
    brief = node?.config?.ai?.brief ?? node?.config?.brief ?? brief ?? seq?.brief ?? "";
    if (node?.config?.kind) kind = node.config.kind;
    else if (node?.type === "send_invite") kind = "invite_note";
    else if (node?.type === "comment_latest_post") kind = "comment";
    if (!brief && seq?.brief) brief = seq.brief;
  }

  let posts: Array<{ text: string; date?: string }> = [];
  let l: Row | null = lead;
  if (lead) {
    // 1. what we already know (free)
    const { data: stored } = await admin.from("outreach_lead_profiles").select("enriched_at, posts, posts_fetched_at").eq("lead_id", lead.id).maybeSingle();
    // LinkedIn reads only from a healthy sender, inside its working hours (drafts are filled from the every-minute tick)
    const canRead = !!sender?.unipile_account_id && sender.status === "ok" && sender.provider === "LINKEDIN"
      && !(sender.paused_until && new Date(sender.paused_until).getTime() > Date.now())
      && (await rpc<boolean>("in_schedule", { p_sender: sender.id, p_at: new Date().toISOString() }).catch(() => false));
    try {
      // 2. the profile, only when nothing is stored
      if (!stored?.enriched_at && canRead && (lead.provider_id || lead.public_identifier)) l = await fetchProfileForDraft(sender, lead);
      // 3. posts: stored when fresh, otherwise one budgeted read; no budget → the draft goes without posts
      const postsFresh = !!stored?.posts_fetched_at && Date.now() - new Date(stored.posts_fetched_at).getTime() < POSTS_FRESH_DAYS * 86400_000;
      let rows: Row[] = Array.isArray(stored?.posts) ? stored!.posts : [];
      if (!postsFresh && canRead && l?.provider_id) {
        const r = await fetchPostsBudgeted(sender, l, 5);
        if (r.ok) rows = r.posts;
      }
      posts = rows.slice(0, 2).map((x: Row) => ({ text: String(x.text ?? ""), date: x.date || undefined })).filter((p) => p.text);
    } catch (e) { log({ fn: "draft", warn: String(e) }); }
    // hand the stored enrichment to the writer through the lead's custom fields (draftCopy serialises lead.custom)
    const enrich = await rpc<Row>("lead_enrich_ctx", { p_lead: lead.id }).catch(() => ({} as Row));
    if (enrich && Object.keys(enrich).length) l = { ...(l ?? lead), custom: { ...((l ?? lead).custom ?? {}), linkedin_profile: enrich } };
  }
  const limit = kind === "invite_note" ? (sender?.is_premium ? LIMIT.invite_note : LIMIT.invite_note_free) : LIMIT[kind] ?? 8000;
  const text = await draftCopy({ workspaceId: t.workspace_id, kind, brief: brief || "Write a short, relevant opener.", limit, lead: l ?? {}, sender: sender ?? {}, posts });
  await admin.from("outreach_tasks").update({ ai_draft: text, draft_kind: kind }).eq("id", taskId);
  return text;
}

/** Fill drafts for pending review tasks (called from tick + ai-draft). */
export async function fillPendingDrafts(limit = 5): Promise<number> {
  if (!aiConfigured()) return 0;
  const { data: tasks } = await admin.from("outreach_tasks").select("id").eq("kind", "review_ai_draft").is("completed_at", null).is("ai_draft", null).order("created_at").limit(limit);
  let n = 0;
  for (const t of tasks ?? []) { try { if (await draftForTask(t.id)) n++; } catch (e) { log({ fn: "draft", error: String(e), task: t.id }); await admin.from("outreach_tasks").update({ ai_draft: "" }).eq("id", t.id); } }
  return n;
}
