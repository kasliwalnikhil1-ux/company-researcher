// Inbox reply — the ONE implementation, used by outreach-send-reply (member JWT) and outreach-api (API key).
// Logged as an action of type `reply` (uncapped) but not budgeted.
// Item 4:  the recorded message carries sent_by = the teammate, so the thread reads "Sent by <name>".
// Item 20: a person's one-to-one email reply is sent WITHOUT open / link tracking unless
//          coalesce(sender.track_replies, workspace.settings.track_replies, false) is true, and never when
//          workspace.settings.email_plain_text is on (the reply is then sent as text/plain).
// Item 24: {booking: true} appends the sender's booking link with the lead id; the link is never rewritten by tracking.
// AI replies (ai-auto-reply-PRD.md §12.1): deliverChatMessage() is the send path shared by a person (sendReply) and the
// autopilot dispatcher (ai_reply.ts). After a person sends, the AI engine is told (origin, edit distance, takeover pause).
import { admin, membership, requireRole, clientVisible, HttpError, emitEvent, sha256Hex, log, rpc, type Role } from "./supabase.ts";
import { unipile, UnipileError } from "./unipile.ts";
import { messageLimit } from "./channels.ts";
import { PLAIN_TEXT_HEADER } from "./plaintext.ts";
import { editDistance, factsChanged } from "./ai_reply_rules.ts";

const CHAT_PROVIDERS = ["LINKEDIN", "INSTAGRAM", "WHATSAPP"];
const CHANNEL_LABEL: Record<string, string> = { INSTAGRAM: "Instagram", WHATSAPP: "WhatsApp" };
type Row = Record<string, any>;

export interface ReplyInput {
  userId: string;
  chat_id: string;
  text?: string;
  subject?: string;
  /** Email only: extra recipients on the reply (addresses). */
  cc?: string[];
  bcc?: string[];
  attachments?: string[];
  booking?: boolean;
  /** Our id of the message this reply quotes (WhatsApp "reply"); sent as the connector's quote_id. */
  quote_message_id?: string;
  /** The AI reply run whose draft the composer held (AI replies §12.1): the server works out ai_draft_sent vs ai_edited. */
  ai_run_id?: string;
  /** Web chat in Review mode: the assistant's suggestion this text started from (docs/outreach/AI-HUB.md §6). */
  suggestion_id?: string;
  /** Set for API keys: narrows the member's rights to the key's role and client scope. */
  scope?: { workspaceId: string; role: Role; clientIds: string[] };
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
/** Cc / Bcc addresses from the composer: trimmed, lowercased, valid, unique, at most 20. */
export function cleanAddresses(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) {
    const e = String(v ?? "").trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) throw new HttpError(400, "E_PAYLOAD_INVALID", `"${e.slice(0, 80)}" is not an email address`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > 20) throw new HttpError(400, "E_PAYLOAD_INVALID", "up to 20 Cc / Bcc addresses");
  return out;
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

export interface DeliverInput {
  chat: Row;
  sender: Row;
  text: string;
  actionId: string;
  sentBy: string | null;
  subject?: string;
  cc?: string[];
  bcc?: string[];
  attachments?: Blob[];
  stored?: Array<Record<string, unknown>>;
  quoted?: Record<string, unknown> | null;
  bookingUrl?: string | null;
}

/**
 * Send one message into an existing chat / email thread and record it. Throws on a connector error (the caller settles its
 * action); a 401 moves the sender to `credentials` here, because every caller wants that.
 */
export async function deliverChatMessage(o: DeliverInput): Promise<{ msg: Row | null; messageId: string | null }> {
  const { chat, sender, text } = o;
  try {
    let messageId: string | null = null;
    let html: string | null = null;
    let attrs: Record<string, unknown> | null = null;
    if (CHAT_PROVIDERS.includes(sender.provider)) {
      const r = await unipile.chats.send(chat.unipile_chat_id, { account_id: sender.unipile_account_id, text, attachments: o.attachments ?? [], quote_id: (o.quoted?.unipile_message_id as string | undefined) ?? undefined });
      messageId = r.message_id ?? null;
    } else {
      // email thread reply: reply to the last message in the thread
      const { data: last } = await admin.from("outreach_messages").select("unipile_message_id").eq("chat_id", chat.id).not("unipile_message_id", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle();
      const to = chat.attendee_provider_id;
      if (!to) throw new HttpError(400, "E_NO_EMAIL", "no recipient address on this thread");
      html = escHtml(text).replace(/\n/g, "<br/>");
      if (o.bookingUrl) html = html.replace(escHtml(o.bookingUrl), `<a href="${escHtml(o.bookingUrl)}" data-disable-tracking="true">${escHtml(o.bookingUrl)}</a>`);
      const { data: wsRow } = await admin.from("outreach_workspaces").select("settings").eq("id", chat.workspace_id).maybeSingle();
      // workspace settings.email_plain_text: the reply goes out as text/plain and is never tracked
      const plain = wsRow?.settings?.email_plain_text === true;
      const track = !plain && (sender.track_replies ?? wsRow?.settings?.track_replies ?? false) === true;
      const subject = o.subject ?? (chat.subject ? (chat.subject.startsWith("Re:") ? chat.subject : `Re: ${chat.subject}`) : undefined);
      const cc = (o.cc ?? []).filter((e) => e !== to), bcc = (o.bcc ?? []).filter((e) => e !== to && !cc.includes(e));
      // the mail header the thread shows for this reply (inbound mail gets the same from the webhook)
      const ownEmail = String(sender.public_identifier ?? sender.owner_email ?? "").toLowerCase();
      attrs = { email: { from: ownEmail ? { name: sender.display_name ?? null, email: ownEmail } : null, to: [{ name: chat.attendee_name ?? null, email: to }], cc: cc.map((email) => ({ name: null, email })), bcc: bcc.map((email) => ({ name: null, email })), reply_to: [], subject: subject ?? null } };
      const r = await unipile.mails.send({ account_id: sender.unipile_account_id, to: [{ identifier: to, display_name: chat.attendee_name ?? undefined }], ...(cc.length ? { cc: cc.map((identifier) => ({ identifier })) } : {}), ...(bcc.length ? { bcc: bcc.map((identifier) => ({ identifier })) } : {}), subject, body: plain ? text : html, reply_to: last?.unipile_message_id ?? undefined, attachments: o.attachments ?? [], ...(plain ? { custom_headers: [{ ...PLAIN_TEXT_HEADER }] } : {}), ...(track ? { tracking_options: { opens: true, links: true, label: `reply:${o.actionId}` } } : {}) });
      messageId = r.provider_id ?? r.tracking_id ?? null;
    }
    // upsert: the messaging webhook may have recorded this message first; our row then takes over its action / author
    const { data: msg } = await admin.from("outreach_messages").upsert({ workspace_id: chat.workspace_id, chat_id: chat.id, unipile_message_id: messageId, direction: "out", text, html, sent_at: new Date().toISOString(), action_id: o.actionId, sent_by: o.sentBy, attachments: o.stored ?? [], quoted: o.quoted ?? null, ...(attrs ? { content_attributes: attrs } : {}) },
      { onConflict: "unipile_message_id", ignoreDuplicates: false }).select("*").single();
    await admin.from("outreach_chats").update({ unread: false, unread_count: 0, archived: false }).eq("id", chat.id);
    // Instagram: answering a message request accepts it; the thread is no longer a request
    if (sender.provider === "INSTAGRAM" && chat.is_request) {
      const { error: reqErr } = await admin.from("outreach_chats").update({ is_request: false }).eq("id", chat.id);
      if (reqErr) log({ fn: "reply", warn: `is_request: ${reqErr.message}` });
    }
    if (chat.lead_id) await admin.from("outreach_lead_sender_state").update({ last_outbound_at: new Date().toISOString(), unipile_chat_id: chat.unipile_chat_id }).eq("lead_id", chat.lead_id).eq("sender_id", sender.id);
    await emitEvent(chat.workspace_id, "message.sent", { id: msg?.id, chat_id: chat.id, lead_id: chat.lead_id, sender_id: sender.id, by: o.sentBy, reply: true });
    return { msg, messageId };
  } catch (e) {
    if (e instanceof UnipileError && e.status === 401) {
      await admin.from("outreach_senders").update({ status: "credentials", status_reason: e.code, last_disconnect_at: new Date().toISOString() }).eq("id", sender.id).eq("status", "ok");
    }
    throw e;
  }
}

/** Tell the AI engine a person sent into this chat: origin ai_draft_sent / ai_edited / inbox_user, stage, takeover pause. Never fails the send. */
async function afterHumanSend(chat: Row, msg: Row, input: ReplyInput, text: string): Promise<void> {
  try {
    let dist: number | null = null, changed: boolean | null = null, runId: string | null = null;
    if (input.ai_run_id) {
      const { data: run } = await admin.from("outreach_ai_reply_runs").select("id, chat_id, draft_text, status").eq("id", input.ai_run_id).maybeSingle();
      if (run && run.chat_id === chat.id && run.draft_text) {
        runId = run.id;
        dist = editDistance(run.draft_text, text);
        changed = factsChanged(run.draft_text, text);
      }
    }
    await rpc("ai_reply_on_human_send", { p_chat: chat.id, p_message: msg.id, p_run: runId, p_edit_distance: dist, p_facts_changed: changed, p_actor: input.userId });
  } catch (e) { log({ fn: "reply", warn: `ai_reply_on_human_send: ${String((e as any)?.message ?? e)}` }); }
}

/** Web chat attachments: the paths the composer uploaded to outreach-attachments, described (not downloaded: nothing leaves the platform). */
async function storedAttachments(chat: Row, input: ReplyInput): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const path of input.attachments ?? []) {
    if (!path.startsWith(`${chat.workspace_id}/${chat.id}/`) || /(^|\/)chat-notes(\/|$)/i.test(path) || path.includes("..")) continue;
    const dir = path.slice(0, path.lastIndexOf("/")), file = path.split("/").pop() ?? "attachment";
    const { data: list } = await admin.storage.from("outreach-attachments").list(dir, { search: file, limit: 1 });
    const meta = list?.find((f) => f.name === file);
    if (!meta) continue;
    const type = (meta.metadata as Record<string, unknown> | null)?.mimetype as string | undefined;
    out.push({ id: path, storage: true, name: file.replace(/^\d+-/, ""), type: type ?? null, mimetype: type ?? null, size: (meta.metadata as Record<string, unknown> | null)?.size ?? null });
  }
  return out;
}

export async function sendReply(input: ReplyInput): Promise<Record<string, unknown> | null> {
  if (!input.chat_id || (!input.text?.trim() && !input.booking && !input.attachments?.length)) throw new HttpError(400, "E_PAYLOAD_INVALID", "chat_id and text (or an attachment) required");
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
  // Cc / Bcc only exist on email threads: say so rather than dropping them (API callers would never know)
  const mail = !!sender && !CHAT_PROVIDERS.includes(sender.provider) && sender.provider !== "WEBCHAT";
  if (!mail && ((input.cc?.length ?? 0) > 0 || (input.bcc?.length ?? 0) > 0)) throw new HttpError(400, "E_PAYLOAD_INVALID", "cc and bcc can only be used on email threads");
  // web chat (web-chat-PRD.md): no connector; the message is a row + a Realtime broadcast, written by the same RPC the inbox uses
  if (sender?.provider === "WEBCHAT") {
    const stored = await storedAttachments(chat, input);
    const msg = await rpc<Record<string, unknown>>("webchat_agent_send", { p_chat: chat.id, p_text: input.text ?? "", p_content_type: stored.length ? "attachment" : "text", p_attrs: input.suggestion_id ? { internal: { suggestion_id: input.suggestion_id } } : {}, p_attachments: stored, p_actor: input.userId });
    return msg;
  }
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

  // Cc / Bcc only exist on email threads; validated before anything is reserved
  const cc = mail ? cleanAddresses(input.cc) : [], bcc = mail ? cleanAddresses(input.bcc) : [];

  // Before the connector call: the AI stops in this chat (pending runs cancelled, the draft being sent held back from the
  // dispatcher), and an AI send already in flight or done wins instead of going out twice. Chats without AI runs pass straight.
  const pre = await rpc<Record<string, unknown>>("ai_reply_before_human_send", { p_chat: chat.id, p_run: input.ai_run_id ?? null })
    .catch((e) => { log({ fn: "reply", warn: `ai_reply_before_human_send: ${String((e as any)?.message ?? e)}` }); return { ok: true } as Record<string, unknown>; });
  if (pre?.ok === false) {
    if (pre.why === "ai_sending") throw new HttpError(409, "E_AI_SENDING", "The AI is sending its reply in this chat right now. Check the thread before sending yours.");
    throw new HttpError(409, "E_AI_ALREADY_SENT", "The AI already sent its version of this reply. Check the thread before sending again.");
  }

  const key = await sha256Hex(`reply|${chat.id}|${input.userId}|${Date.now()}|${Math.random()}`);
  const { data: action } = await admin.from("outreach_actions").insert({
    workspace_id: chat.workspace_id, sender_id: sender.id, lead_id: chat.lead_id, action_type: "reply", scheduled_for: new Date().toISOString(), status: "reserved", reserved_at: new Date().toISOString(),
    idempotency_key: key, payload: { text, by: input.userId, ...(bookingUrl ? { booking: true } : {}), ...(input.ai_run_id ? { ai_run_id: input.ai_run_id } : {}) },
  }).select("*").single();

  // the quoted message must belong to this chat and be known to the connector
  let quoted: Record<string, unknown> | null = null;
  if (input.quote_message_id && CHAT_PROVIDERS.includes(sender.provider)) {
    const { data: q } = await admin.from("outreach_messages").select("id, unipile_message_id, text, direction, sender_name, attachments").eq("id", input.quote_message_id).eq("chat_id", chat.id).maybeSingle();
    if (!q?.unipile_message_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "that message cannot be replied to");
    const att = Array.isArray(q.attachments) ? (q.attachments[0] as Record<string, unknown> | undefined) : undefined;
    quoted = { unipile_message_id: q.unipile_message_id, text: q.text ? String(q.text).slice(0, 500) : null, sender_name: q.direction === "out" ? "You" : (q.sender_name ?? chat.attendee_name ?? null), attachment_type: att?.type ?? null };
  }

  const attachments: Blob[] = [];
  const stored: Array<Record<string, unknown>> = [];
  for (const path of input.attachments ?? []) {
    if (!path.startsWith(`${chat.workspace_id}/`)) continue;
    // private-notes-PRD §8.3: files of internal notes live in another bucket and are never sent out, whatever the path says
    if (/(^|\/)chat-notes(\/|$)/i.test(path) || path.includes("..")) continue;
    const { data: blob } = await admin.storage.from("outreach-attachments").download(path);
    if (!blob) continue;
    const name = path.split("/").pop() ?? "attachment";
    attachments.push(new File([blob], name, { type: blob.type }));
    // type + size kept so the thread renders a sent image / video inline after a refetch
    stored.push({ id: path, storage: true, name: name.replace(/^\d+-/, ""), type: blob.type || null, mimetype: blob.type || null, size: blob.size });
  }
  try {
    const { msg, messageId } = await deliverChatMessage({ chat, sender, text, actionId: action.id, sentBy: input.userId, subject: input.subject, cc, bcc, attachments, stored, quoted, bookingUrl });
    await admin.from("outreach_actions").update({ status: "sent", executed_at: new Date().toISOString(), response: { message_id: messageId } }).eq("id", action.id);
    if (msg?.id) await afterHumanSend(chat, msg, input, text);
    return msg;
  } catch (e) {
    const code = e instanceof UnipileError ? `${e.status}:${e.code}` : String((e as any)?.message ?? e);
    await admin.from("outreach_actions").update({ status: "failed", executed_at: new Date().toISOString(), error_code: code.slice(0, 120) }).eq("id", action.id);
    if (e instanceof UnipileError) throw new HttpError(e.status >= 400 && e.status < 600 ? e.status : 502, `E_UNIPILE_${e.code.toUpperCase()}`, e.message);
    throw e;
  }
}
