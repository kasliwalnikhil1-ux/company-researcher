// crm-mcp/recordings.ts — HTTP routes for call audio. Used by BOTH the /crm app (member JWT) and the crm skill's
// save_transcript.py (one-time upload ticket), so there is one upload path, not two.
//
//   POST /crm-mcp/recording/upload-url   → {put_url, key}      presigned PUT, straight to Oracle (no audio passes through here)
//   POST /crm-mcp/recording/confirm      → the saved row       verifies the object really arrived, then crm_save_recording
//   POST /crm-mcp/recording/play-url     → {url}               presigned GET for the player            (JWT only)
//   POST /crm-mcp/recording/delete       → {deleted}           row + object                            (JWT only)
//
// Bearer = a Supabase JWT of a CRM member, or a 64-hex upload ticket (crm_ticket_peek — not consumed here; saving the
// transcript consumes it). The meeting comes from the ticket when there is one, never from the request body.
import type { Hono } from "npm:hono@4.9.7";
import { admin, buildCtx, sha256Hex, log, type Ctx } from "./ctx.ts";
import { MAX_RECORDING_BYTES, PUT_EXPIRES_S, GET_EXPIRES_S, StorageError, deleteObject, headObject, isAudioType, recordingKey, signedUrl } from "./storage.ts";

type Row = Record<string, any>;
type Auth = { kind: "member"; ctx: Ctx } | { kind: "ticket"; sha: string; meetingId: string };

const STATUS: Record<string, number> = { E_UNAUTHORIZED: 401, E_FORBIDDEN: 403, E_NOT_FOUND: 404, E_PAYLOAD_INVALID: 400, E_TOO_LARGE: 413, E_STORAGE_NOT_CONFIGURED: 503, E_STORAGE: 502 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class HttpError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

async function authenticate(header: string | undefined): Promise<Auth> {
  const bearer = (header ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) throw new HttpError("E_UNAUTHORIZED", "Send a CRM member's access token, or an upload ticket, as `Authorization: Bearer …`.");
  if (/^[0-9a-f]{64}$/.test(bearer)) {
    const sha = await sha256Hex(bearer);
    const { data, error } = await admin.rpc("crm_ticket_peek", { p_ticket_sha256: sha });
    if (error) throw new Error(error.message);
    return { kind: "ticket", sha, meetingId: (data as Row).meeting_id };
  }
  const ctx = await buildCtx(header);
  if (!ctx) throw new HttpError("E_UNAUTHORIZED", "The session expired; sign in again.");
  if (!ctx.isMember) throw new HttpError("E_FORBIDDEN", "This account is not on the CRM team.");
  return { kind: "member", ctx };
}

async function meetingOf(auth: Auth, body: Row): Promise<string> {
  if (auth.kind === "ticket") return auth.meetingId;
  const id = String(body.meeting_id ?? "");
  if (!UUID.test(id)) throw new HttpError("E_PAYLOAD_INVALID", "meeting_id is required");
  const { data, error } = await auth.ctx.user.from("crm_meetings").select("id").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError("E_NOT_FOUND", `meeting ${id} not found`);
  return id;
}

export function registerRecordingRoutes(app: Hono, cors: Record<string, string>): void {
  const reply = (status: number, body: Row) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

  const route = (path: string, ticketAllowed: boolean, handler: (auth: Auth, body: Row) => Promise<Row>) =>
    app.post(path, async (c) => {
      const t0 = Date.now();
      try {
        const auth = await authenticate(c.req.header("authorization"));
        if (auth.kind === "ticket" && !ticketAllowed) throw new HttpError("E_FORBIDDEN", "An upload ticket can only upload; sign in to play or delete a recording.");
        const body = (await c.req.json().catch(() => ({}))) as Row;
        const out = await handler(auth, body);
        log({ fn: "crm-mcp", route: path, status: "ok", via: auth.kind, duration_ms: Date.now() - t0 });
        return reply(200, { ok: true, ...out });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const m = /^(E_[A-Z_]+)(?::\s*([\s\S]*))?$/.exec(msg.trim());
        const code = e instanceof HttpError || e instanceof StorageError ? e.code : m?.[1] ?? "E_INTERNAL";
        log({ fn: "crm-mcp", route: path, status: "error", code, duration_ms: Date.now() - t0 });
        return reply(STATUS[code] ?? 500, { error: true, code, message: m?.[2] ?? msg });
      }
    });

  route("/recording/upload-url", true, async (auth, body) => {
    const meetingId = await meetingOf(auth, body);
    if (!isAudioType(body.content_type)) throw new HttpError("E_PAYLOAD_INVALID", "Only the call audio is stored, not video. Give the video to Claude (“here is the recording”) — it keeps just the audio — or export the audio (m4a / mp3 / wav) and upload that.");
    const bytes = Number(body.bytes ?? 0);
    if (bytes > MAX_RECORDING_BYTES) throw new HttpError("E_TOO_LARGE", `That file is ${Math.round(bytes / 1048576)} MB; the limit is ${MAX_RECORDING_BYTES / 1048576} MB. Upload the audio only (an hour of call audio is about 15 MB).`);
    const key = recordingKey(meetingId, body.content_type, body.filename);
    return { meeting_id: meetingId, key, put_url: await signedUrl("PUT", key, PUT_EXPIRES_S), expires_in: PUT_EXPIRES_S, max_bytes: MAX_RECORDING_BYTES };
  });

  route("/recording/confirm", true, async (auth, body) => {
    const meetingId = await meetingOf(auth, body);
    const key = String(body.key ?? "");
    if (!key.startsWith(`crm/recordings/${meetingId}/`)) throw new HttpError("E_PAYLOAD_INVALID", "key does not belong to this meeting");
    const head = await headObject(key);
    if (!head) throw new HttpError("E_PAYLOAD_INVALID", "The upload did not arrive in storage — PUT the file to put_url first, then confirm.");
    if (head.bytes > MAX_RECORDING_BYTES) { await deleteObject(key); throw new HttpError("E_TOO_LARGE", `The uploaded file is ${Math.round(head.bytes / 1048576)} MB; the limit is ${MAX_RECORDING_BYTES / 1048576} MB. It was removed.`); }
    const p = { storage_key: key, bytes: head.bytes, content_type: body.content_type ?? head.contentType, duration_seconds: body.duration_seconds, original_name: body.filename, uploaded_via: auth.kind === "ticket" ? "skill" : "app" };
    const { data, error } = auth.kind === "ticket"
      ? await admin.rpc("crm_save_recording", { p_meeting_id: null, p, p_ticket_sha256: auth.sha })
      : await auth.ctx.user.rpc("crm_save_recording", { p_meeting_id: meetingId, p });
    if (error) throw new Error(error.message);
    const saved = data as Row;
    if (saved.replaced_key) await deleteObject(saved.replaced_key);   // the meeting's previous audio
    return { recording: { ...saved, replaced_key: undefined } };
  });

  route("/recording/play-url", false, async (auth, body) => {
    if (auth.kind !== "member") throw new HttpError("E_FORBIDDEN", "sign in");
    const { data, error } = await auth.ctx.user.rpc("crm_get_recording", { p_meeting_id: await meetingOf(auth, body) });
    if (error) throw new Error(error.message);
    const rec = data as Row;
    return { url: await signedUrl("GET", rec.storage_key, GET_EXPIRES_S), expires_in: GET_EXPIRES_S, recording: { ...rec, storage_key: undefined } };
  });

  route("/recording/delete", false, async (auth, body) => {
    if (auth.kind !== "member") throw new HttpError("E_FORBIDDEN", "sign in");
    const { data, error } = await auth.ctx.user.rpc("crm_delete_recording", { p_meeting_id: await meetingOf(auth, body) });
    if (error) throw new Error(error.message);
    return { deleted: true, object_removed: await deleteObject((data as Row).storage_key) };
  });
}
