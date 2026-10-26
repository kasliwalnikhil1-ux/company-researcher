// Standard Webhooks signatures (https://www.standardwebhooks.com): Resend's webhooks (headers svix-id / svix-timestamp /
// svix-signature) and Supabase's Auth Send Email hook (webhook-id / webhook-timestamp / webhook-signature) both use them.
// Signed content: `${id}.${timestamp}.${body}`, HMAC-SHA256 with the base64-decoded secret, base64 output; the header lists
// one or more `v1,<sig>` pairs. The secret may be given as `whsec_…` or `v1,whsec_…`.

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function secretBytes(secret: string): ArrayBuffer {
  let s = secret.trim();
  if (s.startsWith("v1,")) s = s.slice(3);
  if (s.startsWith("whsec_")) s = s.slice(6);
  const u = unb64(s);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export interface VerifyOpts { prefix?: "svix" | "webhook"; toleranceSecs?: number; nowMs?: number }

/** True when the request carries a valid signature for `rawBody` under `secret` and its timestamp is fresh. */
export async function verifyStandardWebhook(headers: Headers, rawBody: string, secret: string, opts: VerifyOpts = {}): Promise<boolean> {
  const p = opts.prefix ?? "svix";
  const id = headers.get(`${p}-id`) ?? "";
  const ts = headers.get(`${p}-timestamp`) ?? "";
  const sigHeader = headers.get(`${p}-signature`) ?? "";
  if (!id || !ts || !sigHeader || !secret) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const tol = opts.toleranceSecs ?? 300;
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(now - tsNum) > tol) return false;
  const key = await crypto.subtle.importKey("raw", secretBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${rawBody}`)));
  const expected = b64(mac);
  for (const part of sigHeader.split(/\s+/)) {
    const [version, sig] = part.split(",", 2);
    if (version === "v1" && sig && timingSafeEqual(sig, expected)) return true;
  }
  return false;
}

/** For tests and local tools: sign a body the way the sender would. */
export async function signStandardWebhook(id: string, timestamp: number, rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secretBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`)));
  return `v1,${b64(mac)}`;
}
