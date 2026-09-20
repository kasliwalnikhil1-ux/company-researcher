// crm-mcp/storage.ts — Oracle Object Storage through its S3-compatible API, by presigned URL only.
//
// The bucket is private and its customer secret key lives ONLY in this function's secrets (CRM_S3_*). Nobody else —
// not the browser, not the skill's script — ever holds it: they get a short-lived presigned URL for one object and
// upload/download straight to Oracle, so call audio never passes through this function either.
//
// SigV4 query presigning is ~40 lines with WebCrypto, so there is no AWS SDK here (the function stays self-contained).
// Oracle specifics: path-style addressing only (https://<ns>.compat.objectstorage.<region>.oci.customer-oci.com/<bucket>/<key>),
// region string as Oracle names it (ap-mumbai-1). Secrets are set with scripts/crm-set-storage-secrets.sh.

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key: ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
/** RFC 3986 — what SigV4 means by URI-encode (encodeURIComponent leaves !'()* alone). */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface PresignInput {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  host: string;            // no scheme
  path: string;            // "/bucket/key with spaces.m4a" — raw, encoded here
  region: string; accessKeyId: string; secretAccessKey: string;
  expiresIn: number;       // seconds
  now?: Date;
  query?: Record<string, string>;   // extra signed query params, e.g. response-content-disposition
}

/** Pure SigV4 query-string presigner (S3 flavour: single-encoded path, UNSIGNED-PAYLOAD, host is the only signed header). */
export async function presign(i: PresignInput): Promise<string> {
  const now = i.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");   // 20260920T170000Z
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${i.region}/s3/aws4_request`;
  const path = i.path.split("/").map(rfc3986).join("/");
  const params: Record<string, string> = {
    ...(i.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${i.accessKeyId}/${scope}`, "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(i.expiresIn), "X-Amz-SignedHeaders": "host",
  };
  const qs = Object.keys(params).sort().map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`).join("&");
  const canonical = [i.method, path, qs, `host:${i.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let key: ArrayBuffer = await hmac(enc.encode(`AWS4${i.secretAccessKey}`).buffer as ArrayBuffer, day);
  for (const part of [i.region, "s3", "aws4_request"]) key = await hmac(key, part);
  return `https://${i.host}${path}?${qs}&X-Amz-Signature=${hex(await hmac(key, toSign))}`;
}

// ---------------------------------------------------------------------------
// Configured bucket
// ---------------------------------------------------------------------------

export const MAX_RECORDING_BYTES = 300 * 1024 * 1024;   // the bucket's free tier is 10 GiB; an hour of call audio is ~15 MB
export const PUT_EXPIRES_S = 30 * 60;
export const GET_EXPIRES_S = 6 * 60 * 60;                 // long enough to scrub around an hour-long call in one sitting

export class StorageError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

function config() {
  const endpoint = (Deno.env.get("CRM_S3_ENDPOINT") ?? "").replace(/\/+$/, "");
  const c = { host: endpoint.replace(/^https?:\/\//, ""), region: Deno.env.get("CRM_S3_REGION") ?? "", bucket: Deno.env.get("CRM_S3_BUCKET") ?? "",
    accessKeyId: Deno.env.get("CRM_S3_ACCESS_KEY_ID") ?? "", secretAccessKey: Deno.env.get("CRM_S3_SECRET_ACCESS_KEY") ?? "" };
  if (!c.host || !c.region || !c.bucket || !c.accessKeyId || !c.secretAccessKey) {
    // shown to salespeople in the app and to Claude in the skill — keep it plain; the admin detail is in docs/crm/SETUP.md
    throw new StorageError("E_STORAGE_NOT_CONFIGURED", "Call-audio storage is not switched on yet, so the audio was not saved. Transcripts and captures still work. (Admin: see “Call audio storage” in docs/crm/SETUP.md.)");
  }
  return c;
}
export const storageConfigured = () => { try { config(); return true; } catch { return false; } };

const EXT: Record<string, string> = { "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/flac": "flac", "audio/x-flac": "flac", "audio/ogg": "ogg", "audio/opus": "opus", "audio/webm": "webm" };   // audio only - video is never stored

/** Only call AUDIO is stored. A video is a source to pull the audio out of (the crm skill does that), never an upload. */
export const isAudioType = (contentType: string | undefined) => (contentType ?? "").split(";")[0].trim().toLowerCase() in EXT;

/** crm/recordings/<meeting>/<utc stamp>-<random>.<ext> — the random part makes a replaced file a new object, never an overwrite. */
export function recordingKey(meetingId: string, contentType: string | undefined, filename: string | undefined): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(filename ?? "")?.[1]?.toLowerCase();
  const ext = EXT[(contentType ?? "").split(";")[0].trim().toLowerCase()] ?? (fromName && Object.values(EXT).includes(fromName) ? fromName : "bin");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const rand = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `crm/recordings/${meetingId}/${stamp}-${rand}.${ext}`;
}

export function signedUrl(method: PresignInput["method"], key: string, expiresIn: number, query?: Record<string, string>): Promise<string> {
  const c = config();
  return presign({ method, host: c.host, path: `/${c.bucket}/${key}`, region: c.region, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, expiresIn, query });
}

/** Does the object exist, and how big is it? (null = not there) */
export async function headObject(key: string): Promise<{ bytes: number; contentType: string | null } | null> {
  const r = await fetch(await signedUrl("HEAD", key, 60), { method: "HEAD" });
  if (r.status === 404) return null;
  if (!r.ok) throw new StorageError("E_STORAGE", `storage HEAD failed (${r.status})`);
  return { bytes: Number(r.headers.get("content-length") ?? 0), contentType: r.headers.get("content-type") };
}

/** Best effort — a leftover object costs a few MB, a thrown error here would fail the user's save. */
export async function deleteObject(key: string): Promise<boolean> {
  try { const r = await fetch(await signedUrl("DELETE", key, 60), { method: "DELETE" }); await r.body?.cancel(); return r.ok || r.status === 404; } catch { return false; }
}
