// F43 — Private-note attachments (private-notes-PRD.md §4.2, §8.3). User JWT. POST {action, ...}:
//   upload_url {chat_id, name, size, mime}   → {path, token, name}   signed upload URL under <ws>/<chat>/<pending-id>/<file>
//                                              (the caller then uploads with supabase.storage.uploadToSignedUrl and passes
//                                              {path, name, size, mime} to outreach_note_create, which re-validates the prefix)
//   read_url   {note_id, path}               → {url}                 10-minute signed URL, only when the note is readable
// The bucket is private and has no insert policy: every upload goes through this access check, every read through
// outreach_can_read_note(). Send functions never touch this bucket (see _shared/outreach/reply.ts).
import { admin, json, serve, requireUser, membership, requireRole, clientVisible, readJson, rateLimit, HttpError } from "../_shared/outreach/supabase.ts";
import { NOTES_BUCKET } from "../_shared/outreach/notes.ts";

const MAX_BYTES = 25 * 1024 * 1024;
const safeName = (name: string) => (String(name ?? "").replace(/[\\/]+/g, "_").replace(/[^A-Za-z0-9._ -]+/g, "_").trim().slice(0, 120) || "file");

serve("note-attachment", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ action?: string; chat_id?: string; name?: string; size?: number; mime?: string; note_id?: string; path?: string }>(req);
  if (body.action === "upload_url") {
    await rateLimit(`user:${user.id}:note-upload`, 120, 3600);
    if (!body.chat_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "chat_id required");
    const size = Number(body.size ?? 0);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) throw new HttpError(400, "E_PAYLOAD_INVALID", "files up to 25 MB");
    const { data: chat } = await admin.from("outreach_chats").select("id, workspace_id, client_id").eq("id", body.chat_id).maybeSingle();
    if (!chat) throw new HttpError(404, "E_NOT_FOUND");
    const m = await membership(user.id, chat.workspace_id);
    requireRole(m, "client_viewer");
    if (!clientVisible(m, chat.client_id)) throw new HttpError(404, "E_NOT_FOUND");
    const name = safeName(body.name ?? "file");
    const path = `${chat.workspace_id}/${chat.id}/${crypto.randomUUID()}/${name}`;
    const { data, error } = await admin.storage.from(NOTES_BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw new HttpError(500, "E_INTERNAL", error?.message ?? "signed upload failed");
    return json({ ok: true, path, token: data.token, name, max_bytes: MAX_BYTES });
  }
  if (body.action === "read_url") {
    await rateLimit(`user:${user.id}:note-read`, 600, 3600);
    if (!body.note_id || !body.path) throw new HttpError(400, "E_PAYLOAD_INVALID", "note_id and path required");
    // the caller's RLS view decides: a note they cannot read is simply not found
    const { data: note, error } = await user.client.from("outreach_chat_notes").select("id, attachments, deleted_at").eq("id", body.note_id).maybeSingle();
    if (error) throw new HttpError(500, "E_INTERNAL", error.message);
    if (!note || note.deleted_at) throw new HttpError(404, "E_NOT_FOUND");
    const att = (Array.isArray(note.attachments) ? note.attachments : []).find((a: { path?: string }) => a?.path === body.path);
    if (!att) throw new HttpError(404, "E_NOT_FOUND", "attachment not on note");
    const { data, error: sErr } = await admin.storage.from(NOTES_BUCKET).createSignedUrl(body.path, 600);
    if (sErr || !data) throw new HttpError(404, "E_NOT_FOUND", sErr?.message ?? "file missing");
    return json({ ok: true, url: data.signedUrl, expires_in: 600 });
  }
  throw new HttpError(400, "E_PAYLOAD_INVALID", "action must be upload_url or read_url");
});
