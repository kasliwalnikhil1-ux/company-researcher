// F16 — Edit / delete a sent LinkedIn message within 60 minutes. body: {message_id, action: 'edit'|'delete', text?}
import { admin, json, serve, requireUser, membership, requireRole, clientVisible, readJson, HttpError, audit } from "../_shared/outreach/supabase.ts";
import { unipile } from "../_shared/outreach/unipile.ts";

serve("edit-message", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ message_id: string; action: "edit" | "delete"; text?: string }>(req);
  const { data: msg } = await admin.from("outreach_messages").select("*, outreach_chats(*, outreach_senders(*))").eq("id", body.message_id ?? "").maybeSingle();
  if (!msg) throw new HttpError(404, "E_NOT_FOUND");
  const chat = (msg as any).outreach_chats; const sender = chat?.outreach_senders;
  const m = await membership(user.id, msg.workspace_id);
  requireRole(m, "client_viewer");
  if (!m.can_reply || !clientVisible(m, chat?.client_id)) throw new HttpError(403, "E_FORBIDDEN");
  if (msg.direction !== "out" || !msg.unipile_message_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "only sent messages can be edited");
  if (sender?.provider !== "LINKEDIN") throw new HttpError(400, "E_PAYLOAD_INVALID", "only LinkedIn messages can be edited or deleted");
  if (Date.now() - new Date(msg.sent_at).getTime() > 60 * 60_000) throw new HttpError(409, "E_WINDOW_CLOSED", "messages can only be edited within 60 minutes");
  if (body.action === "edit") {
    if (!body.text?.trim()) throw new HttpError(400, "E_PAYLOAD_INVALID", "text required");
    await unipile.messages.edit(msg.unipile_message_id, body.text.trim());
    await admin.from("outreach_messages").update({ text: body.text.trim(), edited_at: new Date().toISOString() }).eq("id", msg.id);
  } else if (body.action === "delete") {
    await unipile.messages.delete(msg.unipile_message_id);
    await admin.from("outreach_messages").update({ deleted_at: new Date().toISOString() }).eq("id", msg.id);
  } else throw new HttpError(400, "E_PAYLOAD_INVALID", "action must be edit or delete");
  await audit(msg.workspace_id, `message.${body.action}`, "message", msg.id, { by: user.id }, "user");
  return json({ ok: true });
});
