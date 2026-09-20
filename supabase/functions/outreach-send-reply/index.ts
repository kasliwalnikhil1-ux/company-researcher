// F15 — Inbox reply (user JWT). The send logic lives in _shared/outreach/reply.ts so the public API sends through the same code.
import { json, serve, requireUser, readJson, rateLimit } from "../_shared/outreach/supabase.ts";
import { sendReply } from "../_shared/outreach/reply.ts";

serve("send-reply", async (req) => {
  const user = await requireUser(req);
  await rateLimit(`user:${user.id}:send-reply`, 60, 60);
  const body = await readJson<{ chat_id: string; text?: string; attachments?: string[]; subject?: string; booking?: boolean }>(req);
  const message = await sendReply({ userId: user.id, ...body });
  return json({ ok: true, message });
});
