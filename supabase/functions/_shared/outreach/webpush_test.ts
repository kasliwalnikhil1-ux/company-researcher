// deno test --node-modules-dir=none supabase/functions/_shared/outreach/webpush_test.ts
import { b64u, type Bytes, concat, encryptPayload, generateVapidKeys, pushEndpointAllowed, sendPush, utf8, vapidAuthorization } from "./webpush.ts";

function eq(got: unknown, want: unknown, label: string): void {
  if (got !== want) throw new Error(`${label}\n--- got ---\n${String(got)}\n--- want ---\n${String(want)}`);
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** The browser's side: decrypt an aes128gcm body with the subscription's private key. */
async function decrypt(body: Bytes, ua: CryptoKeyPair, auth: Bytes): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  if (rs !== 4096) throw new Error(`rs ${rs}`);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ct));
  if (pt[pt.length - 1] !== 2) throw new Error("missing last-record delimiter");
  return new TextDecoder().decode(pt.slice(0, -1));
}

async function browserSubscription() {
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { ua, auth, p256dh: b64u.enc(new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey))), authB64: b64u.enc(auth) };
}

Deno.test("RFC 8291 §5 test vector: the exact aes128gcm body", async () => {
  const asPub = b64u.dec("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const jwk = { kty: "EC", crv: "P-256", d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", x: b64u.enc(asPub.slice(1, 33)), y: b64u.enc(asPub.slice(33, 65)), ext: true };
  const asKeys = {
    privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, true, []),
  } as CryptoKeyPair;
  const body = await encryptPayload(utf8("When I grow up, I want to be a watermelon"),
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg",
    { salt: b64u.dec("DGv6ra1nlYgDCS1FRnbzlw"), asKeys });
  eq(b64u.enc(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    "RFC 8291 body");
});

Deno.test("round trip: a browser decrypts what we send (unicode, a realistic alert payload)", async () => {
  const s = await browserSubscription();
  const payload = JSON.stringify({ v: 1, title: "Priya Nair · Razorpay", text: "Sure — happy to chat next week 🙂", channel: "LinkedIn", to: "Naman", count: 3 });
  const body = await encryptPayload(utf8(payload), s.p256dh, s.authB64);
  eq(await decrypt(body, s.ua, s.auth), payload, "decrypted");
  const again = await encryptPayload(utf8(payload), s.p256dh, s.authB64);
  if (b64u.enc(again) === b64u.enc(body)) throw new Error("two encryptions of one payload must differ (fresh salt + key)");
});

Deno.test("bad subscription keys and oversized payloads are refused", async () => {
  const s = await browserSubscription();
  let msg = "";
  try { await encryptPayload(utf8("x"), s.p256dh.slice(0, 40), s.authB64); } catch (e) { msg = String((e as Error).message); }
  eq(msg.startsWith("E_PUSH_KEYS"), true, "short p256dh");
  msg = "";
  try { await encryptPayload(utf8("x".repeat(5000)), s.p256dh, s.authB64); } catch (e) { msg = String((e as Error).message); }
  eq(msg, "E_PUSH_TOO_LARGE", "too large");
});

Deno.test("VAPID: an ES256 JWT for the push service origin that verifies with the public key", async () => {
  const keys = await generateVapidKeys();
  eq(b64u.dec(keys.publicKey).length, 65, "public key is an uncompressed point");
  const h = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "https://app.example.com", 1_760_000_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  if (!m) throw new Error(`header shape: ${h}`);
  eq(m[4], keys.publicKey, "k");
  const claims = JSON.parse(new TextDecoder().decode(b64u.dec(m[2])));
  eq(claims.aud, "https://fcm.googleapis.com", "aud is the origin");
  eq(claims.sub, "https://app.example.com", "sub");
  eq(claims.exp, 1_760_000_000 + 12 * 3600, "exp");
  const pub = await crypto.subtle.importKey("raw", b64u.dec(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64u.dec(m[3]), utf8(`${m[1]}.${m[2]}`));
  eq(ok, true, "signature verifies");
  eq(await vapidAuthorization("https://fcm.googleapis.com/fcm/send/other", keys, "https://app.example.com", 1_760_000_000_000), h, "cached per audience");
});

Deno.test("only real push services", () => {
  eq(pushEndpointAllowed("https://fcm.googleapis.com/fcm/send/x"), true, "fcm");
  eq(pushEndpointAllowed("https://updates.push.services.mozilla.com/wpush/v2/x"), true, "mozilla");
  eq(pushEndpointAllowed("https://web.push.apple.com/QAbc"), true, "apple");
  eq(pushEndpointAllowed("https://wns2-par02p.notify.windows.com/w/?token=x"), true, "windows");
  eq(pushEndpointAllowed("http://fcm.googleapis.com/fcm/send/x"), false, "http");
  eq(pushEndpointAllowed("https://169.254.169.254/latest"), false, "metadata ip");
  eq(pushEndpointAllowed("https://googleapis.com.evil.test/x"), false, "suffix trick");
  eq(pushEndpointAllowed("https://fcm.googleapis.com:8443/x"), false, "port");
});

Deno.test("sendPush maps push service answers: 201 sent · 410 gone · 429 retry with Retry-After · 400 failed", async () => {
  const s = await browserSubscription();
  const keys = await generateVapidKeys();
  const sub = { id: "s1", endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: s.p256dh, auth: s.authB64 };
  let seen: Request | null = null;
  const reply = (status: number, headers: Record<string, string> = {}) => (async (input: RequestInfo | URL, init?: RequestInit) => { seen = new Request(input, init); return new Response(status === 201 ? null : "nope", { status, headers }); }) as typeof fetch;
  const r1 = await sendPush(sub, { v: 1 }, keys, "https://app.example.com", "0123456789abcdef0123456789abcdef", { fetchImpl: reply(201) });
  eq(r1.kind, "sent", "201");
  const req = seen as unknown as Request;
  eq(req.headers.get("content-encoding"), "aes128gcm", "encoding");
  eq(req.headers.get("ttl"), "3600", "ttl");
  eq(req.headers.get("urgency"), "high", "urgency");
  eq(req.headers.get("topic"), "0123456789abcdef0123456789abcdef", "topic");
  eq((await sendPush(sub, { v: 1 }, keys, "https://x", "t", { fetchImpl: reply(410) })).kind, "gone", "410");
  eq((await sendPush(sub, { v: 1 }, keys, "https://x", "t", { fetchImpl: reply(404) })).kind, "gone", "404");
  const r429 = await sendPush(sub, { v: 1 }, keys, "https://x", "t", { fetchImpl: reply(429, { "retry-after": "120" }) });
  eq(r429.kind === "retry" && r429.retryAfterS === 120, true, "429 retry-after");
  eq((await sendPush(sub, { v: 1 }, keys, "https://x", "t", { fetchImpl: reply(400) })).kind, "failed", "400");
  eq((await sendPush({ ...sub, endpoint: "https://evil.test/x" }, { v: 1 }, keys, "https://x", "t", { fetchImpl: reply(201) })).kind, "gone", "not a push service");
});
