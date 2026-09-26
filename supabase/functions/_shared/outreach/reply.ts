// Inbox reply — the ONE implementation, used by outreach-send-reply (member JWT) and outreach-api (API key).
// Logged as an action of type `reply` (uncapped) but not budgeted.
// Item 4:  the recorded message carries sent_by = the teammate, so the thread reads "Sent by <name>".
// Item 20: a person's one-to-one email reply is sent WITHOUT open / link tracking unless
//          coalesce(sender.track_replies, workspace.settings.track_replies, false) is true.
// Item 24: {booking: true} appends the sender's booking link with the lead id; the link is never rewritten by tracking.
import { admin, membership, requireRole, clientVisible, HttpError, emitEvent, sha256Hex, log, type Role } from "./supabase.ts";
import { unipile, UnipileError } from "./unipile.ts";
import { messageLimit } from "./channels.ts";

const CHAT_PROVIDERS = ["LINKEDIN", "INSTAGRAM", "WHATSAPP"];
const CHANNEL_LABEL: Record<string, string> = { INSTAGRAM: "Instagram", WHATSAPP: "WhatsApp" };

export interface ReplyInput {
  userId: string;
  chat_id: string;
  text?: string;
  subject?: string;
  attachments?: string[];
  booking?: boolean;
  /** Set for API keys: narrows the member's rights to the key's role and client scope. */
  scope?: { workspaceId: string; role: Role; clientIds: string[] };
}

const escHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Same tracking parameter the templates use ({{booking_link}} → ?utm_content=<lead id>); Cal.com only echoes metadata[...] back to the webhook, so it gets both. */
function bookingLink(base: string, leadId: string | null): string {
  if (!leadId) return base;
  try {
    const u = new URL(base);
    u.searchParams.set("utm_content", leadId);
    if (/(^|\.)cal\.com$/i.test(u.hostname) || /(^|\.)cal\.(eu|dev)$/i.test(u.hostname)) u.searchParams.set("metadata[lead_id]", leadId);
    return u.toString();
  } catch { return base; }
}

export async function sendReply(input: ReplyInput): Promise<Record<string, unknown> | null> {
  if (!input.chat_id || (!input.text?.trim() && !input.booking)) throw new HttpError(400, "E_PAYLOAD_INVALID", "chat_id and text required");
  const { data: chat } = await admin.from("outreach_chats").select("*, outreach_senders(*)").eq("id", input.chat_id).maybeSingle();
  if (!chat) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(input.userId, chat.workspace_id);
  requireRole(m, "client_viewer");
  if (!m.can_reply) throw new HttpError(403, "E_FORBIDDEN", "replies are disabled for your account");
  if (!clientVisible(m, chat.client_id)) throw new HttpError(403, "E_FORBIDDEN");
  // an API key acts as its member but never above the key's own role / client scope
  if (input.scope) {
    if (input.scope.workspaceId !== chat.workspace_id) throw new HttpError(404, "E_NOT_FOUND");
    if (input.scope.role === "client_viewer") throw new HttpError(403, "E_FORBIDDEN", "member role required");
    if (input.scope.clientIds.length && chat.client_id && !input.scope.clientIds.includes(chat.client_id)) throw new HttpError(404, "E_NOT_FOUND");
  }
  const sender = (chat as any).outreach_senders;
  if (!sender || sender.status !== "ok" || !sender.unipile_account_id) throw new HttpError(409, "E_SENDER_NOT_OK", "sender is not connected");
  let text = (input.text ?? "").trim();
  let bookingUrl: string | null = null;
  if (input.booking) {
    if (!sender.booking_link) throw new HttpError(409, "E_NO_BOOKING_LINK", `${sender.display_name ?? "This sender"} has no booking link yet. Add one on the sender page.`);
    bookingUrl = bookingLink(String(sender.booking_link), chat.lead_id ?? null);
    if (!text) text = "Here is my calendar, pick any time that suits you:";
    text = `${text}\n\n${bookingUrl}`;
  }
  // Instagram 1000 / WhatsApp 4096 characters; replies into an existing chat are never gated by consent (consent gates new chats only)
  if (sender.provider === "INSTAGRAM" || sender.provider === "WHATSAPP") {
    const limit = messageLimit(sender.provider);
    if (text.length > limit) throw new HttpError(400, "E_PAYLOAD_INVALID", `${CHANNEL_LABEL[sender.provider]} messages can be up to ${limit} characters (this one is ${text.length})`);
  }

  const key = await sha256Hex(`reply|${chat.id}|${input.userId}|${Date.now()}|${Math.random()}`);
  const { data: action } = await admin.from("outreach_actions").insert({
    workspace_id: chat.workspace_id, sender_id: sender.id, lead_id: chat.lead_id, action_type: "reply", scheduled_for: new Date().toISOString(), status: "reserved", reserved_at: new Date().toISOString(),
    idempotency_key: key, payload: { text, by: input.userId, ...(bookingUrl ? { booking: true } : {}) },
  }).select("*").single();

  const attachments: Blob[] = [];
  for (const path of input.attachments ?? []) {
    if (!path.startsWith(`${chat.workspace_id}/`)) continue;
    const { data: blob } = await admin.storage.from("outreach-attachments").download(path);
    if (blob) attachments.push(new File([blob], path.split("/").pop() ?? "attachment", { type: blob.type }));
  }
  try {
    let messageId: string | null = null;
    let html: string | null = null;
    if (CHAT_PROVIDERS.includes(sender.provider)) {
      const r = await unipile.chats.send(chat.unipile_chat_id, { account_id: sender.unipile_account_id, text, attachments });
      messageId = r.message_id ?? null;
    } else {
      // email thread reply: reply to the last message in the thread
      const { data: last } = await admin.from("outreach_messages").select("unipile_message_id").eq("chat_id", chat.id).not("unipile_message_id", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle();
      const to = chat.attendee_provider_id;
      if (!to) throw new HttpError(400, "E_NO_EMAIL", "no recipient address on this thread");
      html = escHtml(text).replace(/\n/g, "<br/>");
      if (bookingUrl) html = html.replace(escHtml(bookingUrl), `<a href="${escHtml(bookingUrl)}" data-disable-tracking="true">${escHtml(bookingUrl)}</a>`);
      const { data: wsRow } = await admin.from("outreach_workspaces").select("settings").eq("id", chat.workspace_id).maybeSingle();
      const track = (sender.track_replies ?? wsRow?.settings?.track_replies ?? false) === true;
      const r = await unipile.mails.send({ account_id: sender.unipile_account_id, to: [{ identifier: to, display_name: chat.attendee_name ?? undefined }], subject: input.subject ?? (chat.subject ? (chat.subject.startsWith("Re:") ? chat.subject : `Re: ${chat.subject}`) : undefined), body: html, reply_to: last?.unipile_message_id ?? undefined, ...(track ? { tracking_options: { opens: true, links: true, label: `reply:${action.id}` } } : {}) });
      messageId = r.provider_id ?? r.tracking_id ?? null;
    }
    const { data: msg } = await admin.from("outreach_messages").insert({ workspace_id: chat.workspace_id, chat_id: chat.id, unipile_message_id: messageId, direction: "out", text, html, sent_at: new Date().toISOString(), action_id: action.id, sent_by: input.userId, attachments: (input.attachments ?? []).map((p) => ({ id: p, storage: true, name: p.split("/").pop() })) }).select("*").single();
    await admin.from("outreach_actions").update({ status: "sent", executed_at: new Date().toISOString(), response: { message_id: messageId } }).eq("id", action.id);
    await admin.from("outreach_chats").update({ unread: false, unread_count: 0, archived: false }).eq("id", chat.id);
    // Instagram: answering a message request accepts it; the thread is no longer a request
    if (sender.provider === "INSTAGRAM" && chat.is_request) {
      const { error: reqErr } = await admin.from("outreach_chats").update({ is_request: false }).eq("id", chat.id);
      if (reqErr) log({ fn: "reply", warn: `is_request: ${reqErr.message}` });
    }
    if (chat.lead_id) await admin.from("outreach_lead_sender_state").update({ last_outbound_at: new Date().toISOString(), unipile_chat_id: chat.unipile_chat_id }).eq("lead_id", chat.lead_id).eq("sender_id", sender.id);
    await emitEvent(chat.workspace_id, "message.sent", { id: msg?.id, chat_id: chat.id, lead_id: chat.lead_id, sender_id: sender.id, by: input.userId, reply: true });
    return msg;
  } catch (e) {
    const code = e instanceof UnipileError ? `${e.status}:${e.code}` : String((e as any)?.message ?? e);
    await admin.from("outreach_actions").update({ status: "failed", executed_at: new Date().toISOString(), error_code: code.slice(0, 120) }).eq("id", action.id);
    if (e instanceof UnipileError) {
      if (e.status === 401) await admin.from("outreach_senders").update({ status: "credentials", status_reason: e.code, last_disconnect_at: new Date().toISOString() }).eq("id", sender.id).eq("status", "ok");
      throw new HttpError(e.status >= 400 && e.status < 600 ? e.status : 502, `E_UNIPILE_${e.code.toUpperCase()}`, e.message);
    }
    throw e;
  }
}
