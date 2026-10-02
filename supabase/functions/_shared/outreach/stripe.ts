// Stripe over plain HTTP (form-encoded), pinned to one API version so object shapes never move under us.
// Shapes used here are those of 2026-08-26.dahlia: the billing period lives on the subscription ITEM, an invoice points to
// its subscription through invoice.parent.subscription_details, and the client secret of an invoice is
// invoice.confirmation_secret (expand it). See docs/outreach/BILLING.md §Stripe.
import { log } from "./supabase.ts";
import { hmacSha256Hex } from "./crypto.ts";

export const STRIPE_API_VERSION = Deno.env.get("STRIPE_API_VERSION") ?? "2026-08-26.dahlia";
const API_BASE = (Deno.env.get("STRIPE_API_BASE") ?? "https://api.stripe.com").replace(/\/+$/, "");

export function stripeKey(): string { return Deno.env.get("STRIPE_SECRET_KEY") ?? ""; }
export function stripeConfigured(): boolean { return !!stripeKey(); }

export class StripeError extends Error {
  status: number;
  type: string;          // card_error | invalid_request_error | api_error | idempotency_error | network
  code: string;          // card_declined, resource_missing, …
  declineCode: string | null;
  param: string | null;
  raw: unknown;
  constructor(status: number, err: any, fallback: string) {
    super(err?.message ?? fallback);
    this.status = status;
    this.type = err?.type ?? (status === 0 ? "network" : "api_error");
    this.code = err?.code ?? "";
    this.declineCode = err?.decline_code ?? null;
    this.param = err?.param ?? null;
    this.raw = err ?? null;
  }
  /** The customer's card was refused or needs attention (nothing to retry on our side). */
  get isCard(): boolean { return this.type === "card_error" || this.status === 402; }
}

/** Flatten nested params into Stripe's bracket notation: {items:[{price:"p"}]} → items[0][price]=p. null / undefined are skipped; "" is kept (it clears a field). */
export function encodeForm(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (key: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(`${key}[${i}]`, x)); return; }
    if (typeof v === "object") { for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(`${key}[${k}]`, x); return; }
    out.append(key, String(v));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (input, init) => fetch(input, init);
/** Tests replace the transport with a fake Stripe. */
export function setStripeFetch(f: Fetch | null): void { fetchImpl = f ?? ((input, init) => fetch(input, init)); }

export interface StripeOpts { idempotencyKey?: string; retries?: number }

/**
 * One Stripe call. GET sends params as the query string; POST / DELETE as the form body. A POST is only retried when it
 * carries an idempotency key (Stripe replays the first result for the same key, so a retry cannot charge twice).
 */
export async function stripe<T = any>(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, unknown>, opts: StripeOpts = {}): Promise<T> {
  const key = stripeKey();
  if (!key) throw new StripeError(503, { type: "not_configured", message: "Billing is not configured on this deployment" }, "not configured");
  const form = params ? encodeForm(params) : null;
  const url = `${API_BASE}/v1${path}${method === "GET" && form && [...form].length ? `?${form}` : ""}`;
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, "stripe-version": STRIPE_API_VERSION };
  if (method !== "GET") headers["content-type"] = "application/x-www-form-urlencoded";
  if (opts.idempotencyKey && method === "POST") headers["idempotency-key"] = opts.idempotencyKey.slice(0, 255);
  const canRetry = method === "GET" || (method === "POST" && !!opts.idempotencyKey);
  const max = canRetry ? (opts.retries ?? 2) : 0;
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(url, { method, headers, body: method === "GET" ? undefined : (form?.toString() ?? "") });
    } catch (e) {
      log({ fn: "stripe", endpoint: `${method} ${path}`, network_error: String((e as Error)?.message ?? e), attempt });
      if (attempt >= max) throw new StripeError(0, null, `Stripe could not be reached: ${String((e as Error)?.message ?? e)}`);
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    log({ fn: "stripe", endpoint: `${method} ${path}`, status: res.status, latency_ms: Date.now() - t0, request_id: res.headers.get("request-id") });
    if (res.ok) return data as T;
    if ((res.status === 429 || res.status >= 500) && attempt < max) { await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); continue; }
    throw new StripeError(res.status, data?.error, `Stripe returned ${res.status}`);
  }
}

/** Every page of a list endpoint (bounded: callers list small things — prices by lookup key, a customer's open invoices). */
export async function stripeList<T = any>(path: string, params: Record<string, unknown> = {}, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  let starting_after: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await stripe<{ data: T[]; has_more: boolean }>("GET", path, { limit: 100, ...params, starting_after });
    out.push(...(page.data ?? []));
    if (!page.has_more || !page.data?.length) break;
    starting_after = (page.data[page.data.length - 1] as any)?.id;
  }
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * Verify a webhook payload against the Stripe-Signature header (scheme v1, 5-minute tolerance). Returns the parsed event,
 * or null when the signature does not match. Several v1 signatures may be present while a secret is being rolled.
 */
export async function verifyStripeSignature(raw: string, header: string, secret: string, toleranceSecs = 300, nowMs = Date.now()): Promise<any | null> {
  if (!secret || !header) return null;
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v; else if (k === "v1") v1.push(v);
  }
  if (!t || !v1.length || !/^\d+$/.test(t)) return null;
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSecs) return null;
  const expected = await hmacSha256Hex(secret, `${t}.${raw}`);
  if (!v1.some((s) => timingSafeEqual(s, expected))) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Unix seconds → ISO string (null-safe). */
export function isoFromUnix(ts: number | null | undefined): string | null {
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null;
}
