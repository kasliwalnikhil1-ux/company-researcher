// Web Push for reply alerts (reply-notifications-PRD.md §7.2): RFC 8030 delivery, VAPID (RFC 8292) and aes128gcm
// payload encryption (RFC 8291 over RFC 8188), on WebCrypto only — no npm dependency, nothing Node-specific.
//
//   generateVapidKeys()            P-256 key pair: public key as base64url uncompressed point (what the browser's
//                                  applicationServerKey takes), private key as a JWK (kept in Vault)
//   encryptPayload(text, p256dh, auth)  the aes128gcm body for one browser subscription
//   sendPush(sub, payload, ...)    POST to the push service → {kind: sent | gone | retry | failed}
//   pushEndpointAllowed(url)       only real push services (mirrors outreach__push_endpoint_ok in SQL 076)

const te = new TextEncoder();
/** Bytes backed by a plain ArrayBuffer (what WebCrypto accepts as a BufferSource). */
export type Bytes = Uint8Array<ArrayBuffer>;
export const utf8 = (s: string): Bytes => te.encode(s) as Bytes;

export const b64u = {
  enc(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s: string): Bytes {
    const t = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(t + "===".slice((t.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface VapidKeys { publicKey: string; privateJwk: JsonWebKey }

export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: b64u.enc(raw), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

// ------------------------------------------------------------------------------------------------ VAPID (RFC 8292)
const signingKeys = new Map<string, Promise<CryptoKey>>();
const jwtCache = new Map<string, { header: string; exp: number }>();

function signingKey(jwk: JsonWebKey): Promise<CryptoKey> {
  const k = String(jwk.d);
  let p = signingKeys.get(k);
  if (!p) {
    p = crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    signingKeys.set(k, p);
  }
  return p;
}

/** `Authorization: vapid t=<jwt>, k=<public key>` for this push service. Tokens live 12 h and are reused for 11 h. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const cacheKey = `${aud}|${keys.publicKey}|${subject}`;
  const hit = jwtCache.get(cacheKey);
  if (hit && hit.exp - 3600 > nowMs / 1000) return hit.header;
  const exp = Math.floor(nowMs / 1000) + 12 * 3600;
  const head = b64u.enc(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.enc(utf8(JSON.stringify({ aud, exp, sub: subject })));
  // WebCrypto's ECDSA signature is already the raw r‖s (IEEE P1363) form that JWS ES256 expects
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(keys.privateJwk), utf8(`${head}.${claims}`)));
  const header = `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${keys.publicKey}`;
  jwtCache.set(cacheKey, { header, exp });
  return header;
}

// ------------------------------------------------------------------------------------------------ aes128gcm (RFC 8291)
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export const RECORD_SIZE = 4096;

/**
 * Encrypt one push message for a subscription (single record, no padding beyond the delimiter).
 * `opts` fixes the salt and the sender's ephemeral key pair — only for the RFC 8291 test vector.
 */
export async function encryptPayload(plaintext: Bytes, p256dh: string, auth: string, opts: { salt?: Bytes; asKeys?: CryptoKeyPair } = {}): Promise<Bytes> {
  const uaPublic = b64u.dec(p256dh);
  const authSecret = b64u.dec(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("E_PUSH_KEYS: p256dh is not an uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("E_PUSH_KEYS: auth secret must be 16 bytes");
  if (plaintext.length > RECORD_SIZE - 17 - 86) throw new Error("E_PUSH_TOO_LARGE");
  const as = opts.asKeys ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

// ------------------------------------------------------------------------------------------------ delivery
const ALLOWED_HOST = /^([a-z0-9-]+\.)*(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com|push\.services\.mozilla\.com)$/;

export function pushEndpointAllowed(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && (u.port === "" || u.port === "443") && ALLOWED_HOST.test(u.hostname);
  } catch { return false; }
}

export interface PushSubscriptionRow { id: string; endpoint: string; p256dh: string; auth: string }
export type PushOutcome =
  | { kind: "sent"; status: number }
  | { kind: "gone"; status: number }
  | { kind: "retry"; status: number; retryAfterS: number; error: string }
  | { kind: "failed"; status: number; error: string };

/**
 * Send one encrypted message. `topic` collapses pending messages for one conversation on the push service
 * (≤ 32 URL-safe base64 characters). TTL 1 hour, high urgency (PRD §9).
 */
export async function sendPush(sub: PushSubscriptionRow, payload: unknown, keys: VapidKeys, subject: string, topic: string, opts: { ttlS?: number; fetchImpl?: typeof fetch } = {}): Promise<PushOutcome> {
  if (!pushEndpointAllowed(sub.endpoint)) return { kind: "gone", status: 0 };
  let body: Bytes;
  try { body = await encryptPayload(utf8(JSON.stringify(payload)), sub.p256dh, sub.auth); }
  catch (e) { return String((e as Error)?.message).startsWith("E_PUSH_KEYS") ? { kind: "gone", status: 0 } : { kind: "failed", status: 0, error: String((e as Error)?.message ?? e) }; }
  const headers: Record<string, string> = {
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(opts.ttlS ?? 3600),
    Urgency: "high",
    Authorization: await vapidAuthorization(sub.endpoint, keys, subject),
  };
  if (/^[A-Za-z0-9_-]{1,32}$/.test(topic)) headers.Topic = topic;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(sub.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    return { kind: "retry", status: 0, retryAfterS: 30, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  const text = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 200);
  if (res.status >= 200 && res.status < 300) return { kind: "sent", status: res.status };
  if (res.status === 404 || res.status === 410) return { kind: "gone", status: res.status };
  if (res.status === 429 || res.status >= 500) {
    const ra = Number(res.headers.get("retry-after"));
    return { kind: "retry", status: res.status, retryAfterS: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 600) : 30, error: `${res.status} ${text}`.trim() };
  }
  return { kind: "failed", status: res.status, error: `${res.status} ${text}`.trim() };
}
