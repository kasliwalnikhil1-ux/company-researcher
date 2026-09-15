// F19 — AI draft (user JWT: {task_id} regenerate | {lead_id, sender_id, kind, brief} ad-hoc → creates a review task) or cron ({} fills pending).
import { admin, json, serve, requireUser, requireCron, membership, requireRole, readJson, HttpError, rateLimit } from "../_shared/outreach/supabase.ts";
import { draftForTask, fillPendingDrafts } from "../_shared/outreach/drafts.ts";

serve("ai-draft", async (req) => {
  const body = await readJson<{ task_id?: string; lead_id?: string; sender_id?: string; kind?: "invite_note" | "message" | "comment"; brief?: string; enrollment_id?: string; node_id?: string }>(req);
  const isCron = req.headers.get("x-cron-secret");
  if (isCron) { requireCron(req); return json({ ok: true, filled: await fillPendingDrafts(10) }); }
  const user = await requireUser(req);
  await rateLimit(`user:${user.id}:ai-draft`, 30, 60);
  if (body.task_id) {
    const { data: t } = await admin.from("outreach_tasks").select("workspace_id, client_id").eq("id", body.task_id).maybeSingle();
    if (!t) throw new HttpError(404, "E_NOT_FOUND");
    const m = await membership(user.id, t.workspace_id); requireRole(m, "member");
    const text = await draftForTask(body.task_id);
    return json({ ok: true, text });
  }
  if (!body.lead_id || !body.sender_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "task_id or lead_id+sender_id required");
  const { data: lead } = await admin.from("outreach_leads").select("id, workspace_id, client_id, full_name").eq("id", body.lead_id).maybeSingle();
  if (!lead) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, lead.workspace_id); requireRole(m, "member");
  const kind = body.kind ?? "message";
  const { data: task } = await admin.from("outreach_tasks").insert({
    workspace_id: lead.workspace_id, client_id: lead.client_id, kind: "review_ai_draft", lead_id: lead.id, sender_id: body.sender_id, enrollment_id: body.enrollment_id ?? null, node_id: body.node_id ?? null,
    title: `Review AI ${kind.replace("_", " ")} for ${lead.full_name ?? "lead"}`, body: body.brief ?? null, draft_kind: kind, assigned_to: user.id, due_at: new Date(Date.now() + 86400_000).toISOString(),
  }).select("*").single();
  const text = await draftForTask(task!.id);
  return json({ ok: true, task_id: task!.id, text });
});
