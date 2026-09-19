// Chat attendee pictures. Uses GET /chats/{id}/attendees (messaging data, so no
// LinkedIn profile view is spent). attendee_picture_url: null = not looked up yet,
// '' = looked up, none available.
import { admin, log } from "./supabase.ts";
import { unipile, unipileConfigured, UnipileError } from "./unipile.ts";

function safeUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try { return new URL(v).protocol === "https:" ? v : null; } catch { return null; }
}

export async function fillChatPicture(chat: { id: string; unipile_chat_id: string; lead_id: string | null; attendee_provider_id?: string | null }): Promise<string | null> {
  const res = await unipile.chats.attendees(chat.unipile_chat_id);
  const others = (res.items ?? []).filter((a: any) => !(a.is_self === 1 || a.is_self === true));
  const who = others.find((a: any) => chat.attendee_provider_id && a.provider_id === chat.attendee_provider_id) ?? others[0];
  const url = safeUrl(who?.picture_url);
  await admin.from("outreach_chats").update({ attendee_picture_url: url ?? "" }).eq("id", chat.id);
  if (url && chat.lead_id) await admin.from("outreach_leads").update({ picture_url: url }).eq("id", chat.lead_id).is("picture_url", null);
  return url;
}

/** Bounded backfill for chats never looked up (called from the hourly health cron). */
export async function backfillChatPictures(limit = 40): Promise<number> {
  if (!unipileConfigured()) return 0;
  const { data } = await admin.from("outreach_chats").select("id, unipile_chat_id, lead_id, attendee_provider_id")
    .eq("provider", "LINKEDIN").is("attendee_picture_url", null).not("unipile_chat_id", "is", null)
    .order("last_message_at", { ascending: false, nullsFirst: false }).limit(limit);
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
