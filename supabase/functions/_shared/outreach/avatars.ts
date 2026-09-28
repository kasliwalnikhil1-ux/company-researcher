// Chat attendee pictures. Uses GET /chats/{id}/attendees (messaging data, so no
// LinkedIn profile view is spent). attendee_picture_url: null = not looked up yet,
// '' = looked up, none available.
// WhatsApp / Instagram picture links from the connector expire, so their pictures are downloaded
// (GET /chat_attendees/{id}/picture; a group chat's id gives the group picture) and kept in storage
// under outreach-attachments/<ws>/avatars/, served by a long-lived signed URL.
import { admin, log } from "./supabase.ts";
import { unipile, unipileConfigured, UnipileError } from "./unipile.ts";
import { isWhatsappGroup } from "./channels.ts";

const BUCKET = "outreach-attachments";
const SIGNED_URL_TTL_S = 365 * 24 * 3600;
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;

function safeUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try { return new URL(v).protocol === "https:" ? v : null; } catch { return null; }
}

type PictureChat = { id: string; workspace_id?: string; provider?: string; unipile_chat_id: string; lead_id: string | null; attendee_provider_id?: string | null };

/** Picture bytes from the connector → storage → signed URL; null when the attendee has none (or privacy hides it). */
async function storePicture(chat: PictureChat, attendeeOrChatId: string): Promise<string | null> {
  const res = await unipile.chatAttendees.picture(attendeeOrChatId);
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 404 || res.status === 400 || res.status === 422) return null;
    throw new UnipileError(res.status, "", `picture ${res.status}`, null);
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_PICTURE_BYTES || type.startsWith("application/json") || type.startsWith("text/")) return null;
  const mime = type.startsWith("image/") ? type : "image/jpeg";
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const path = `${chat.workspace_id}/avatars/${chat.id}.${ext}`;
  const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: true });
  if (error) throw new Error(`avatar upload: ${error.message}`);
  const { data } = await admin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_S);
  return data?.signedUrl ?? null;
}

/**
 * Copy a picture link that browsers cannot show or keep (Instagram / Facebook CDN: cross-origin blocked; WhatsApp: expiring)
 * into storage and return a long-lived signed URL. The server fetch is not subject to the browser's cross-origin block.
 * null when the link does not answer with an image.
 */
export async function persistPictureUrl(url: string | null | undefined, workspaceId: string, key: string): Promise<string | null> {
  const src = safeUrl(url);
  if (!src || !workspaceId) return null;
  if (src.includes("/storage/v1/object/")) return src;   // already ours
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(15000) });
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!res.ok || !type.startsWith("image/")) { await res.body?.cancel(); return null; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_PICTURE_BYTES) return null;
    const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
    const path = `${workspaceId}/avatars/${key}.${ext}`;
    const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: true });
    if (error) return null;
    const { data } = await admin.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_S);
    return data?.signedUrl ?? null;
  } catch (e) { log({ fn: "avatars", warn: `persist picture: ${String(e)}` }); return null; }
}

export async function fillChatPicture(chat: PictureChat): Promise<string | null> {
  let provider = chat.provider, workspaceId = chat.workspace_id;
  if (!provider || !workspaceId) {
    const { data } = await admin.from("outreach_chats").select("provider, workspace_id").eq("id", chat.id).maybeSingle();
    provider = data?.provider; workspaceId = data?.workspace_id;
  }
  let url: string | null = null;
  if (provider === "WHATSAPP" || provider === "INSTAGRAM") {
    const c = { ...chat, provider, workspace_id: workspaceId };
    if (provider === "WHATSAPP" && isWhatsappGroup({ attendee_provider_id: chat.attendee_provider_id })) {
      url = await storePicture(c, chat.unipile_chat_id);
    } else {
      const res = await unipile.chats.attendees(chat.unipile_chat_id);
      const others = (res.items ?? []).filter((a: any) => !(a.is_self === 1 || a.is_self === true));
      const who = others.find((a: any) => chat.attendee_provider_id && a.provider_id === chat.attendee_provider_id) ?? others[0];
      if (who?.id) url = await storePicture(c, String(who.id));
    }
  } else {
    const res = await unipile.chats.attendees(chat.unipile_chat_id);
    const others = (res.items ?? []).filter((a: any) => !(a.is_self === 1 || a.is_self === true));
    const who = others.find((a: any) => chat.attendee_provider_id && a.provider_id === chat.attendee_provider_id) ?? others[0];
    url = safeUrl(who?.picture_url);
  }
  await admin.from("outreach_chats").update({ attendee_picture_url: url ?? "" }).eq("id", chat.id);
  // the lead takes the picture when it has none, or only an Instagram / Facebook CDN link (browsers block those cross-site)
  if (url && chat.lead_id) await admin.from("outreach_leads").update({ picture_url: url }).eq("id", chat.lead_id).or("picture_url.is.null,picture_url.like.%fbcdn.net%,picture_url.like.%cdninstagram.com%");
  return url;
}

/** Bounded backfill for chats never looked up (called from the hourly health cron; per sender from outreach-sender-manage). */
export async function backfillChatPictures(limit = 40, senderId?: string): Promise<number> {
  if (!unipileConfigured()) return 0;
  // connected senders only: a disconnected account answers 4xx, which would wrongly mark every chat "no picture"
  let q = admin.from("outreach_chats").select("id, workspace_id, provider, unipile_chat_id, lead_id, attendee_provider_id, outreach_senders!inner(status)")
    .in("provider", ["LINKEDIN", "WHATSAPP", "INSTAGRAM"]).eq("outreach_senders.status", "ok").is("attendee_picture_url", null).not("unipile_chat_id", "is", null);
  if (senderId) q = q.eq("sender_id", senderId);
  const { data } = await q.order("last_message_at", { ascending: false, nullsFirst: false }).limit(limit);
  let found = 0;
  for (const c of data ?? []) {
    try { if (await fillChatPicture(c)) found++; } catch (e) {
      log({ fn: "avatars", chat_id: c.id, warn: String(e) });
      // Permanent errors (chat gone, account removed): stop retrying this chat.
      if (e instanceof UnipileError && e.status >= 400 && e.status < 500 && e.status !== 429) await admin.from("outreach_chats").update({ attendee_picture_url: "" }).eq("id", c.id);
    }
  }
  return found;
}
