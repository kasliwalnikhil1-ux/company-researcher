// Find-email step (item 26). The workspace brings its own keys: providers are tried in the saved order and we stop at
// the first hit; an optional verifier then confirms the address. We never resell data and there is no platform key.
// Keys live in outreach_workspace_secrets (service only): finder_keys [{provider, key_enc, hint}], verifier {provider, key_enc, hint, url?}.
// No LinkedIn traffic happens here, so there is no sender budget to reserve (find_email is unbudgeted like call_api).
import { admin, log } from "./supabase.ts";
import { decrypt } from "./crypto.ts";

type Row = Record<string, any>;

export interface FoundEmail { email: string; status: "verified" | "unverified"; source: string }
export type FinderProvider = "hunter" | "prospeo" | "findymail";
export type VerifierProvider = "zerobounce" | "reacher";

const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "mail.com", "zoho.com", "yandex.com", "rediffmail.com"]);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** "https://www.Acme.com/about" → "acme.com". Returns null for anything that is not a plausible company domain. */
export function normalizeDomain(v: unknown): string | null {
  let s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@")) s = s.slice(s.lastIndexOf("@") + 1);
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:\s]/)[0];
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(s)) return null;
  if (FREE_MAIL.has(s) || s.endsWith("linkedin.com")) return null;
  return s;
}

/** `leads.company_domain` first; older imports and the API may also have put it in custom fields. A personal address is never used as a company domain. */
export function companyDomainOf(lead: Row): string | null {
  const own = lead?.company_domain ? normalizeDomain(String(lead.company_domain)) : null;
  if (own) return own;
  const c = lead?.custom ?? {};
  for (const k of ["company_domain", "domain", "company_website", "website", "company_url", "companyDomain", "Company Domain", "Website"]) {
    const d = normalizeDomain(c[k]);
    if (d) return d;
  }
  return normalizeDomain(lead?.email_work);
}

function namesOf(lead: Row): { first: string; last: string; full: string } {
  const full = String(lead?.full_name ?? [lead?.first_name, lead?.last_name].filter(Boolean).join(" ")).trim();
  const first = String(lead?.first_name ?? full.split(/\s+/)[0] ?? "").trim();
  const last = String(lead?.last_name ?? full.split(/\s+/).slice(1).join(" ")).trim();
  return { first, last, full: full || [first, last].filter(Boolean).join(" ") };
}

async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; data: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, data };
  } finally { clearTimeout(timer); }
}

type Hit = { email: string; verified: boolean } | null;

/** Provider errors that mean "the key is wrong / out of credits": worth surfacing, never worth retrying per lead. */
class FinderKeyError extends Error {}

const FINDERS: Record<FinderProvider, (key: string, lead: Row, domain: string) => Promise<Hit>> = {
  // https://hunter.io/api-documentation/v2#email-finder
  async hunter(key, lead, domain) {
    const n = namesOf(lead);
    const u = new URL("https://api.hunter.io/v2/email-finder");
    u.searchParams.set("domain", domain);
    if (n.first && n.last) { u.searchParams.set("first_name", n.first); u.searchParams.set("last_name", n.last); } else u.searchParams.set("full_name", n.full);
    u.searchParams.set("api_key", key);
    const { status, data } = await http(u.toString());
    if (status === 401 || status === 403 || status === 429) throw new FinderKeyError(`hunter ${status}`);
    const email = data?.data?.email;
    if (status !== 200 || !email) return null;
    return { email, verified: data?.data?.verification?.status === "valid" };
  },
  // https://prospeo.io/api-docs/enrich-person (the older /email-finder endpoint is gone from their reference)
  async prospeo(key, lead, domain) {
    const n = namesOf(lead);
    const body = { only_verified_email: false, data: { first_name: n.first || undefined, last_name: n.last || undefined, full_name: n.full || undefined, company_website: domain, linkedin_url: lead?.profile_url || undefined } };
    const { status, data } = await http("https://api.prospeo.io/enrich-person", { method: "POST", headers: { "content-type": "application/json", "X-KEY": key }, body: JSON.stringify(body) });
    if (status === 401 || status === 403 || status === 429 || data?.error_code === "INSUFFICIENT_CREDITS" || data?.error_code === "INVALID_API_KEY") throw new FinderKeyError(`prospeo ${status} ${data?.error_code ?? ""}`.trim());
    const e = data?.person?.email;
    const email = typeof e === "string" ? e : e?.email;
    if (data?.error || !email || String(email).includes("*")) return null;   // NO_MATCH comes back as HTTP 400; a masked address is not a hit
    return { email, verified: String(e?.status ?? "").toUpperCase() === "VERIFIED" };
  },
  // https://app.findymail.com/docs/ — returns only addresses it has verified
  async findymail(key, lead, domain) {
    const n = namesOf(lead);
    const { status, data } = await http("https://app.findymail.com/api/search/name", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ name: n.full, domain }), timeoutMs: 30000 });
    if (status === 401 || status === 402 || status === 423 || status === 429) throw new FinderKeyError(`findymail ${status}`);
    const email = data?.contact?.email;
    if (status !== 200 || !email) return null;
    return { email, verified: true };
  },
};

/** true = deliverable, false = do not use, null = the verifier could not tell (catch-all, unknown, verifier down). */
export async function verifyEmail(verifier: { provider: string; key: string; url?: string | null }, email: string): Promise<boolean | null> {
  try {
    if (verifier.provider === "zerobounce") {
      const u = new URL("https://api.zerobounce.net/v2/validate");
      u.searchParams.set("api_key", verifier.key); u.searchParams.set("email", email); u.searchParams.set("ip_address", "");
      const { status, data } = await http(u.toString(), { timeoutMs: 30000 });
      if (status !== 200) return null;
      const s = String(data?.status ?? "").toLowerCase();
      return s === "valid" ? true : s === "invalid" || s === "spamtrap" || s === "abuse" || s === "do_not_mail" ? false : null;
    }
    // Reacher-compatible: POST {base}/v0/check_email {to_email} → {is_reachable: safe|risky|invalid|unknown}. Self-hosted instances pass their own url.
    const base = String(verifier.url || "https://api.reacher.email").replace(/\/+$/, "");
    const { status, data } = await http(`${base}/v0/check_email`, { method: "POST", headers: { "content-type": "application/json", authorization: verifier.key, "x-reacher-secret": verifier.key }, body: JSON.stringify({ to_email: email }), timeoutMs: 45000 });
    if (status !== 200) return null;
    const r = String(data?.is_reachable ?? "").toLowerCase();
    return r === "safe" ? true : r === "invalid" ? false : null;
  } catch (e) { log({ fn: "finder", warn: "verifier failed", provider: verifier.provider, error: String((e as any)?.message ?? e) }); return null; }
}

async function loadSecrets(workspaceId: string): Promise<{ finders: Array<{ provider: FinderProvider; key: string }>; verifier: { provider: string; key: string; url?: string | null } | null }> {
  const { data } = await admin.from("outreach_workspace_secrets").select("finder_keys, verifier").eq("workspace_id", workspaceId).maybeSingle();
  const finders: Array<{ provider: FinderProvider; key: string }> = [];
  for (const f of (Array.isArray(data?.finder_keys) ? data!.finder_keys : []) as Row[]) {
    const provider = String(f?.provider ?? "").toLowerCase() as FinderProvider;
    if (!(provider in FINDERS) || !f?.key_enc) continue;
    try { finders.push({ provider, key: await decrypt(f.key_enc) }); } catch (e) { log({ fn: "finder", warn: "cannot decrypt finder key", provider, error: String((e as any)?.message ?? e) }); }
  }
  let verifier: { provider: string; key: string; url?: string | null } | null = null;
  const v = data?.verifier as Row | null;
  if (v?.provider && v?.key_enc) {
    try { verifier = { provider: String(v.provider).toLowerCase(), key: await decrypt(v.key_enc), url: v.url ?? v.base_url ?? null }; } catch (e) { log({ fn: "finder", warn: "cannot decrypt verifier key", error: String((e as any)?.message ?? e) }); }
  }
  return { finders, verifier };
}

export async function finderConfigured(workspaceId: string): Promise<boolean> {
  return (await loadSecrets(workspaceId)).finders.length > 0;
}

/**
 * Try the workspace's finders in order and stop at the first hit. Returns null when nothing was found, when the lead has
 * no company domain, or when no finder key is saved. The caller skips leads whose email is already verified.
 */
export async function findEmail(workspaceId: string, lead: Row): Promise<FoundEmail | null> {
  const domain = companyDomainOf(lead);
  if (!domain) return null;
  if (!namesOf(lead).full) return null;
  const { finders, verifier } = await loadSecrets(workspaceId);
  for (const f of finders) {
    let hit: Hit = null;
    try { hit = await FINDERS[f.provider](f.key, lead, domain); }
    catch (e) { log({ fn: "finder", workspace_id: workspaceId, provider: f.provider, key_problem: e instanceof FinderKeyError, error: String((e as any)?.message ?? e) }); continue; }
    if (!hit || !EMAIL_RE.test(hit.email)) continue;
    const email = hit.email.trim().toLowerCase();
    let verified = hit.verified;
    if (verifier) {
      const v = await verifyEmail(verifier, email);
      if (v === false) { log({ fn: "finder", workspace_id: workspaceId, provider: f.provider, rejected_by_verifier: true }); continue; }   // try the next provider
      if (v === true) verified = true;
    }
    return { email, status: verified ? "verified" : "unverified", source: f.provider };
  }
  return null;
}
