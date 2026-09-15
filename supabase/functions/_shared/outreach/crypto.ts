// AES-256-GCM encryption for LinkedIn cookie secrets. Key from OUTREACH_COOKIE_KEY (base64, 32 bytes).
const KEY_B64 = Deno.env.get("OUTREACH_COOKIE_KEY") ?? "";

async function key(): Promise<CryptoKey> {
  if (!KEY_B64) throw new Error("OUTREACH_COOKIE_KEY not set");
  const raw = Uint8Array.from(atob(KEY_B64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("OUTREACH_COOKIE_KEY must be 32 bytes base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encrypt(plain: string): Promise<string> {
  const k = await key();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64(out);
}

export async function decrypt(enc: string): Promise<string> {
  const k = await key();
  const buf = unb64(enc);
  const iv = buf.slice(0, 12), ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, ct);
  return new TextDecoder().decode(pt);
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
