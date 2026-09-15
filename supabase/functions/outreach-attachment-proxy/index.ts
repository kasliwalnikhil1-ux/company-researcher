// F17 — Stream an attachment from Unipile (never expose Unipile URLs). GET ?message_id=&attachment_id=
import { admin, serve, requireUser, membership, requireRole, clientVisible, HttpError, CORS } from "../_shared/outreach/supabase.ts";
import { unipile } from "../_shared/outreach/unipile.ts";

serve("attachment-proxy", async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const messageId = url.searchParams.get("message_id") ?? "";
  const attachmentId = url.searchParams.get("attachment_id") ?? "";
  const { data: msg } = await admin.from("outreach_messages").select("id, workspace_id, unipile_message_id, attachments, outreach_chats(client_id, provider, sender_id, outreach_senders(unipile_account_id))").eq("id", messageId).maybeSingle();
  if (!msg) throw new HttpError(404, "E_NOT_FOUND");
  const chat = (msg as any).outreach_chats;
  const m = await membership(user.id, msg.workspace_id);
  requireRole(m, "client_viewer");
  if (!clientVisible(m, chat?.client_id)) throw new HttpError(403, "E_FORBIDDEN");
  const att = (msg.attachments ?? []).find((a: any) => a.id === attachmentId);
  if (!att) throw new HttpError(404, "E_NOT_FOUND", "attachment not on message");
  if (att.storage) {
    const { data, error } = await admin.storage.from("outreach-attachments").download(att.id);
    if (error || !data) throw new HttpError(404, "E_NOT_FOUND");
    return new Response(data, { headers: { ...CORS, "content-type": data.type || "application/octet-stream", "content-disposition": `inline; filename="${att.name ?? "attachment"}"` } });
  }
  const upstream = att.email
    ? await unipile.mails.attachment(msg.unipile_message_id!, attachmentId, chat?.outreach_senders?.unipile_account_id)
    : await unipile.messages.attachment(msg.unipile_message_id!, attachmentId);
  if (!upstream.ok) throw new HttpError(upstream.status, "E_UPSTREAM", "attachment fetch failed");
  const headers = new Headers(CORS);
  headers.set("content-type", upstream.headers.get("content-type") ?? att.mimetype ?? "application/octet-stream");
  headers.set("content-disposition", `inline; filename="${att.name ?? "attachment"}"`);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(upstream.body, { status: 200, headers });
});
