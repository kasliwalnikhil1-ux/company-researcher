// F16 — Message actions from the inbox thread.
//   {message_id, action: 'edit', text}      our message; LinkedIn within 60 minutes, WhatsApp within 15 minutes
//   {message_id, action: 'delete'}          our message; LinkedIn within 60 minutes, WhatsApp within 2 days (deleted for everyone)
//   {message_id, action: 'react', emoji}    any message; WhatsApp, Instagram, LinkedIn (the connector has no "remove reaction")
//   {message_id, action: 'forward', to_chat_id}   WhatsApp only, into another chat of the same sender
//   {chat_id, action: 'read' | 'unread'}    WhatsApp: mirrors the inbox read state to the phone (read sends blue ticks)
import { admin, json, serve, requireUser, membership, requireRole, clientVisible, readJson, HttpError, audit } from "../_shared/outreach/supabase.ts";
import { unipile, UnipileError } from "../_shared/outreach/unipile.ts";

const EDIT_WINDOW_MS: Record<string, number> = { LINKEDIN: 60 * 60_000, WHATSAPP: 15 * 60_000 };
const DELETE_WINDOW_MS: Record<string, number> = { LINKEDIN: 60 * 60_000, WHATSAPP: 2 * 24 * 60 * 60_000 };
const REACT_PROVIDERS = ["WHATSAPP", "INSTAGRAM", "LINKEDIN"];

type Body = { message_id?: string; chat_id?: string; action: "edit" | "delete" | "react" | "forward" | "read" | "unread"; text?: string; emoji?: string; to_chat_id?: string };

function connectorError(e: unknown): never {
  if (e instanceof UnipileError) throw new HttpError(e.status >= 400 && e.status < 600 ? e.status : 502, `E_UNIPILE_${e.code.toUpperCase()}`, e.message);
  throw e;
}

serve("edit-message", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<Body>(req);

  // chat-level: read / unread
  if (body.action === "read" || body.action === "unread") {
    const { data: chat } = await admin.from("outreach_chats").select("*, outreach_senders(*)").eq("id", body.chat_id ?? "").maybeSingle();
    if (!chat) throw new HttpError(404, "E_NOT_FOUND");
    const m = await membership(user.id, chat.workspace_id);
    requireRole(m, "client_viewer");
    if (!clientVisible(m, chat.client_id)) throw new HttpError(403, "E_FORBIDDEN");
    const sender = (chat as any).outreach_senders;
    if (sender?.provider !== "WHATSAPP" || sender.status !== "ok" || !chat.unipile_chat_id) return json({ ok: true, synced: false });
    try { await unipile.chats.patch(chat.unipile_chat_id, "setReadStatus", body.action === "read"); } catch (e) { connectorError(e); }
    return json({ ok: true, synced: true });
  }

  const { data: msg } = await admin.from("outreach_messages").select("*, outreach_chats(*, outreach_senders(*))").eq("id", body.message_id ?? "").maybeSingle();
  if (!msg) throw new HttpError(404, "E_NOT_FOUND");
  const chat = (msg as any).outreach_chats; const sender = chat?.outreach_senders;
  const m = await membership(user.id, msg.workspace_id);
  requireRole(m, "client_viewer");
  if (!m.can_reply || !clientVisible(m, chat?.client_id)) throw new HttpError(403, "E_FORBIDDEN");
  if (!msg.unipile_message_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "this message is not known to the connected account yet");
  if (sender?.status !== "ok") throw new HttpError(409, "E_SENDER_NOT_OK", "sender is not connected");
  const provider = String(sender?.provider ?? "");
  const age = Date.now() - new Date(msg.sent_at).getTime();

  if (body.action === "edit" || body.action === "delete") {
    if (msg.direction !== "out") throw new HttpError(400, "E_PAYLOAD_INVALID", "only sent messages can be edited or deleted");
    const window = (body.action === "edit" ? EDIT_WINDOW_MS : DELETE_WINDOW_MS)[provider];
    if (!window) throw new HttpError(400, "E_PAYLOAD_INVALID", "only LinkedIn and WhatsApp messages can be edited or deleted");
    if (age > window) throw new HttpError(409, "E_WINDOW_CLOSED", `this message can no longer be ${body.action === "edit" ? "edited" : "deleted"}`);
    if (body.action === "edit") {
      if (!body.text?.trim()) throw new HttpError(400, "E_PAYLOAD_INVALID", "text required");
      try { await unipile.messages.edit(msg.unipile_message_id, body.text.trim()); } catch (e) { connectorError(e); }
      await admin.from("outreach_messages").update({ text: body.text.trim(), edited_at: new Date().toISOString() }).eq("id", msg.id);
    } else {
      try { await unipile.messages.delete(msg.unipile_message_id); } catch (e) { connectorError(e); }
      await admin.from("outreach_messages").update({ deleted_at: new Date().toISOString() }).eq("id", msg.id);
    }
  } else if (body.action === "react") {
    const emoji = String(body.emoji ?? "").trim();
    if (!emoji || emoji.length > 16) throw new HttpError(400, "E_PAYLOAD_INVALID", "emoji required");
    if (!REACT_PROVIDERS.includes(provider)) throw new HttpError(400, "E_PAYLOAD_INVALID", "reactions are not available on this channel");
    try { await unipile.messages.react(msg.unipile_message_id, emoji); } catch (e) { connectorError(e); }
    // one reaction per person: ours replaces our previous one (the webhook echo lands on the same entry)
    const reactions = (Array.isArray(msg.reactions) ? msg.reactions : []).filter((r: any) => !(r?.mine === true || r?.by === "us"));
    reactions.push({ emoji, by: "You", by_id: sender.provider_user_id ?? null, mine: true, at: new Date().toISOString() });
    await admin.from("outreach_messages").update({ reactions }).eq("id", msg.id);
  } else if (body.action === "forward") {
    if (provider !== "WHATSAPP") throw new HttpError(400, "E_PAYLOAD_INVALID", "forwarding is available on WhatsApp only");
    const { data: target } = await admin.from("outreach_chats").select("id, workspace_id, client_id, sender_id, unipile_chat_id").eq("id", body.to_chat_id ?? "").maybeSingle();
    if (!target || target.sender_id !== chat.sender_id || !target.unipile_chat_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "forward to a chat of the same WhatsApp number");
    if (!clientVisible(m, target.client_id)) throw new HttpError(403, "E_FORBIDDEN");
    let r: { message_id?: string | null } = {};
    try { r = await unipile.messages.forward(msg.unipile_message_id, target.unipile_chat_id); } catch (e) { connectorError(e); }
    const now = new Date().toISOString();
    // the webhook echo of the forwarded message dedupes on unipile_message_id
    await admin.from("outreach_messages").insert({ workspace_id: target.workspace_id, chat_id: target.id, unipile_message_id: r.message_id ?? null, direction: "out", text: msg.text, attachments: msg.attachments ?? [], sent_at: now, is_forwarded: true, sent_by: user.id }).then(() => null, () => null);
    await admin.from("outreach_chats").update({ last_message_at: now, last_message_preview: (msg.text ?? "Forwarded message").slice(0, 200), last_direction: "out" }).eq("id", target.id).then(() => null, () => null);
  } else throw new HttpError(400, "E_PAYLOAD_INVALID", "action must be edit, delete, react, forward, read or unread");

  await audit(msg.workspace_id, `message.${body.action}`, "message", msg.id, { by: user.id, ...(body.emoji ? { emoji: body.emoji } : {}), ...(body.to_chat_id ? { to_chat_id: body.to_chat_id } : {}) }, "user");
  return json({ ok: true });
});
