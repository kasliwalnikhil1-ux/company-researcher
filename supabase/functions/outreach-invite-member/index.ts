// Create a workspace invitation (owner) and email it. Acceptance is the SQL RPC outreach_accept_invitation(token).
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, audit, WEB_ORIGIN } from "../_shared/outreach/supabase.ts";
import { notifyInvitation } from "../_shared/outreach/notify.ts";

serve("invite-member", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ workspace_id: string; email: string; role: "owner" | "manager" | "member" | "client_viewer"; client_ids?: string[]; resend_id?: string }>(req);
  if (!body.workspace_id) throw new HttpError(400, "E_PAYLOAD_INVALID");
  const m = await membership(user.id, body.workspace_id);
  requireRole(m, "owner");
  const { data: ws } = await admin.from("outreach_workspaces").select("name").eq("id", body.workspace_id).single();
  let inv: any;
  if (body.resend_id) {
    const { data } = await admin.from("outreach_invitations").select("*").eq("id", body.resend_id).eq("workspace_id", body.workspace_id).maybeSingle();
    if (!data) throw new HttpError(404, "E_NOT_FOUND");
    const { data: upd } = await admin.from("outreach_invitations").update({ expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() }).eq("id", data.id).select("*").single();
    inv = upd;
  } else {
    const email = (body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "E_PAYLOAD_INVALID", "valid email required");
    if (!["owner", "manager", "member", "client_viewer"].includes(body.role)) throw new HttpError(400, "E_PAYLOAD_INVALID", "bad role");
    const { data, error } = await admin.from("outreach_invitations").insert({ workspace_id: body.workspace_id, email, role: body.role, client_ids: body.client_ids ?? [], created_by: user.id }).select("*").single();
    if (error) throw new HttpError(500, "E_INTERNAL", error.message);
    inv = data;
  }
  const sent = await notifyInvitation(inv.email, ws?.name ?? "workspace", inv.token, inv.role);
  await audit(body.workspace_id, "member.invited", "invitation", inv.id, { email: inv.email, role: inv.role, emailed: sent }, "user");
  return json({ ok: true, invitation: inv, link: `${WEB_ORIGIN}/outreach/invite/${inv.token}`, emailed: sent });
});
