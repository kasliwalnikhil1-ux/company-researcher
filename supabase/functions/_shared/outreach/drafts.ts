// AI drafting → approval tasks (F19). Never auto-sends.
import { admin, log, rpc } from "./supabase.ts";
import { unipile } from "./unipile.ts";
import { draftCopy, aiConfigured } from "./ai.ts";

type Row = Record<string, any>;
const LIMIT: Record<string, number> = { invite_note: 300, invite_note_free: 200, message: 8000, comment: 1250 };

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
    const { data: seq } = await admin.from("outreach_sequences").select("graph, brief").eq("id", enr!.sequence_id).single();
    const node = seq?.graph?.nodes?.[t.node_id];
    brief = node?.config?.ai?.brief ?? node?.config?.brief ?? brief ?? seq?.brief ?? "";
    if (node?.config?.kind) kind = node.config.kind;
    else if (node?.type === "send_invite") kind = "invite_note";
    else if (node?.type === "comment_latest_post") kind = "comment";
    if (!brief && seq?.brief) brief = seq.brief;
  }
  // profile + posts (uses profile_view budget when possible)
  let posts: Array<{ text: string; date?: string }> = [];
  let l = lead;
  if (lead && sender?.unipile_account_id && sender.status === "ok") {
    try {
      const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
      const ok = await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" });
      if (ok) {
        const prof = await unipile.users.profile(sender.unipile_account_id, lead.provider_id ?? lead.public_identifier, { linkedin_sections: "*_preview" });
        await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" });
        const cur = (prof.work_experience ?? []).find((w: Row) => w.current) ?? prof.work_experience?.[0];
        const { data: upd } = await admin.from("outreach_leads").update({ provider_id: prof.provider_id ?? lead.provider_id, headline: prof.headline ?? lead.headline, company: cur?.company ?? lead.company, title: cur?.position ?? lead.title, location: prof.location ?? lead.location, is_open_profile: prof.is_open_profile ?? lead.is_open_profile, last_profile_fetch_at: new Date().toISOString() }).eq("id", lead.id).select("*").single();
        l = upd ?? lead;
        if (l.provider_id) {
          const p = await unipile.users.posts(sender.unipile_account_id, l.provider_id, 2);
          posts = (p.items ?? []).slice(0, 2).map((x: Row) => ({ text: x.text ?? "", date: x.parsed_datetime ?? x.date }));
        }
      }
    } catch (e) { log({ fn: "draft", warn: String(e) }); }
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
