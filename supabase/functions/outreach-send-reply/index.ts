// F15 — Inbox reply (user JWT). Logged as an action of type `reply` (uncapped) but not budgeted.
import { admin, json, serve, requireUser, membership, requireRole, clientVisible, readJson, rateLimit, HttpError, rpc, emitEvent, sha256Hex } from "../_shared/outreach/supabase.ts";
import { unipile, UnipileError } from "../_shared/outreach/unipile.ts";

serve("send-reply", async (req) => {
  const user = await requireUser(req);
  await rateLimit(`user:${user.id}:send-reply`, 60, 60);
  const body = await readJson<{ chat_id: string; text: string; attachments?: string[]; subject?: string }>(req);
  if (!body.chat_id || !body.text?.trim()) throw new HttpError(400, "E_PAYLOAD_INVALID", "chat_id and text required");
  const { data: chat } = await admin.from("outreach_chats").select("*, outreach_senders(*)").eq("id", body.chat_id).maybeSingle();
  if (!chat) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, chat.workspace_id);
  requireRole(m, "client_viewer");
  if (!m.can_reply) throw new HttpError(403, "E_FORBIDDEN", "replies are disabled for your account");
  if (!clientVisible(m, chat.client_id)) throw new HttpError(403, "E_FORBIDDEN");
  const sender = (chat as any).outreach_senders;
  if (!sender || sender.status !== "ok" || !sender.unipile_account_id) throw new HttpError(409, "E_SENDER_NOT_OK", "sender is not connected");
  const text = body.text.trim();

  const key = await sha256Hex(`reply|${chat.id}|${user.id}|${Date.now()}|${Math.random()}`);
  const { data: action } = await admin.from("outreach_actions").insert({
    workspace_id: chat.workspace_id, sender_id: sender.id, lead_id: chat.lead_id, action_type: "reply", scheduled_for: new Date().toISOString(), status: "reserved", reserved_at: new Date().toISOString(),
    idempotency_key: key, payload: { text, by: user.id },
  }).select("*").single();

  const attachments: Blob[] = [];
  for (const path of body.attachments ?? []) {
    if (!path.startsWith(`${chat.workspace_id}/`)) continue;
    const { data: blob } = await admin.storage.from("outreach-attachments").download(path);
    if (blob) attachments.push(new File([blob], path.split("/").pop() ?? "attachment", { type: blob.type }));
  }
  try {
    let messageId: string | null = null;
    let html: string | null = null;
    if (sender.provider === "LINKEDIN") {
      const r = await unipile.chats.send(chat.unipile_chat_id, { account_id: sender.unipile_account_id, text, attachments });
      messageId = r.message_id ?? null;
    } else {
      // email thread reply: reply to the last message in the thread
      const { data: last } = await admin.from("outreach_messages").select("unipile_message_id").eq("chat_id", chat.id).not("unipile_message_id", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle();
      const to = chat.attendee_provider_id;
      if (!to) throw new HttpError(400, "E_NO_EMAIL", "no recipient address on this thread");
      html = text.replace(/\n/g, "<br/>");
      const r = await unipile.mails.send({ account_id: sender.unipile_account_id, to: [{ identifier: to, display_name: chat.attendee_name ?? undefined }], subject: body.subject ?? (chat.subject ? (chat.subject.startsWith("Re:") ? chat.subject : `Re: ${chat.subject}`) : undefined), body: html, reply_to: last?.unipile_message_id ?? undefined, tracking_options: { opens: true, links: true } });
      messageId = r.provider_id ?? r.tracking_id ?? null;
    }
    const { data: msg } = await admin.from("outreach_messages").insert({ workspace_id: chat.workspace_id, chat_id: chat.id, unipile_message_id: messageId, direction: "out", text, html, sent_at: new Date().toISOString(), action_id: action.id, attachments: (body.attachments ?? []).map((p) => ({ id: p, storage: true, name: p.split("/").pop() })) }).select("*").single();
    await admin.from("outreach_actions").update({ status: "sent", executed_at: new Date().toISOString(), response: { message_id: messageId } }).eq("id", action.id);
    await admin.from("outreach_chats").update({ unread: false, unread_count: 0, archived: false }).eq("id", chat.id);
    if (chat.lead_id) await admin.from("outreach_lead_sender_state").update({ last_outbound_at: new Date().toISOString(), unipile_chat_id: chat.unipile_chat_id }).eq("lead_id", chat.lead_id).eq("sender_id", sender.id);
    await emitEvent(chat.workspace_id, "message.sent", { id: msg?.id, chat_id: chat.id, lead_id: chat.lead_id, sender_id: sender.id, by: user.id, reply: true });
    return json({ ok: true, message: msg });
  } catch (e) {
    const code = e instanceof UnipileError ? `${e.status}:${e.code}` : String((e as any)?.message ?? e);
    await admin.from("outreach_actions").update({ status: "failed", executed_at: new Date().toISOString(), error_code: code.slice(0, 120) }).eq("id", action.id);
    if (e instanceof UnipileError) {
      if (e.status === 401) await admin.from("outreach_senders").update({ status: "credentials", status_reason: e.code, last_disconnect_at: new Date().toISOString() }).eq("id", sender.id).eq("status", "ok");
      throw new HttpError(e.status >= 400 && e.status < 600 ? e.status : 502, `E_UNIPILE_${e.code.toUpperCase()}`, e.message);
    }
    throw e;
  }
});
