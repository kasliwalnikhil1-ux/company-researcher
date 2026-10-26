// Resend domains and domain-scoped API keys (custom-sending-domain-PRD.md §4, D2), plus the DMARC lookup over DNS-over-HTTPS
// (§4.2; Edge Functions have no raw DNS). Only email.ts sends mail; this module manages domains with the account key.
import { fetchWithHealth, noteCallError } from "../health.ts";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const API = "https://api.resend.com";
type Row = Record<string, any>;

export class ResendError extends Error {
  constructor(public status: number, public body: string) { super(`Resend ${status}: ${body.slice(0, 200)}`); }
}

async function call<T = Row>(method: "GET" | "POST" | "DELETE", path: string, group: string, body?: Row): Promise<T> {
  if (!RESEND_KEY) throw new ResendError(503, "RESEND_API_KEY is not set");
  const res = await fetchWithHealth("resend", group, `${API}${path}`, {
    method, headers: { authorization: `Bearer ${RESEND_KEY}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) { noteCallError("resend", group, text); throw new ResendError(res.status, text); }
  try { return (text ? JSON.parse(text) : {}) as T; } catch { return {} as T; }
}

export interface DnsRecord { record: string; name: string; type: string; ttl?: string; status: string; value: string; priority?: number }
export interface ResendDomain { id: string; name: string; status: string; region?: string; created_at?: string; records?: DnsRecord[] }

export const resendDomains = {
  create: (name: string, region: string, customReturnPath = "send"): Promise<ResendDomain> => call<ResendDomain>("POST", "/domains", "domains.create", { name, region, custom_return_path: customReturnPath }),
  get: (id: string): Promise<ResendDomain> => call<ResendDomain>("GET", `/domains/${encodeURIComponent(id)}`, "domains.get"),
  verify: (id: string): Promise<Row> => call("POST", `/domains/${encodeURIComponent(id)}/verify`, "domains.verify"),
  delete: async (id: string): Promise<boolean> => {
    try { await call("DELETE", `/domains/${encodeURIComponent(id)}`, "domains.delete"); return true; }
    catch (e) { if (e instanceof ResendError && e.status === 404) return true; throw e; }
  },
  list: (): Promise<{ data: ResendDomain[] }> => call<{ data: ResendDomain[] }>("GET", "/domains", "domains.list"),
};

export const resendApiKeys = {
  /** The token is returned once; the caller encrypts and stores it at once. */
  createForDomain: (name: string, domainId: string): Promise<{ id: string; token: string }> => call<{ id: string; token: string }>("POST", "/api-keys", "api_keys.create", { name, permission: "sending_access", domain_id: domainId }),
  delete: async (id: string): Promise<boolean> => {
    try { await call("DELETE", `/api-keys/${encodeURIComponent(id)}`, "api_keys.delete"); return true; }
    catch (e) { if (e instanceof ResendError && e.status === 404) return true; throw e; }
  },
};

/** Resend's domain status → our state (§4.1 step 4, §5.4). */
export function stateForResendStatus(status: string | null | undefined, identityConfirmed: boolean, current: string): string {
  const s = String(status ?? "").toLowerCase();
  if (s === "verified") return current === "active" ? "active" : identityConfirmed ? "ready" : "ready";
  if (s === "failed" || s === "partially_failed") return "failed";
  if (s === "pending" || s === "temporary_failure" || s === "not_started") return current === "active" ? "active" : "verifying";
  return current;
}

/** Normalise Resend's record list for storage and the UI. */
export function normaliseRecords(records: DnsRecord[] | undefined): DnsRecord[] {
  return (records ?? []).map((r) => ({ record: String(r.record ?? ""), name: String(r.name ?? ""), type: String(r.type ?? ""), ttl: r.ttl ? String(r.ttl) : undefined, status: String(r.status ?? "not_started"), value: String(r.value ?? ""), priority: r.priority != null ? Number(r.priority) : undefined }));
}

// ---------------------------------------------------------------------------
// DNS over HTTPS (Cloudflare, Google as the second try)
// ---------------------------------------------------------------------------
const MULTI_LABEL_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.in", "net.in", "org.in", "co.nz", "co.za", "com.br", "com.mx", "co.jp", "com.sg", "com.hk", "com.my", "co.id", "com.tr", "com.ar", "com.co", "com.pe", "co.kr", "com.tw", "com.ph", "com.vn", "co.il", "com.eg", "com.ng", "co.ke", "com.pk", "com.bd", "com.sa", "ae.org"]);

/** The registrable domain of a hostname (a small suffix list; enough for "_dmarc.<root>"). */
export function registrableRoot(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const last2 = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(last2) && labels.length >= 3) return labels.slice(-3).join(".");
  return last2;
}

export interface DmarcResult { found: boolean; record: string | null; policy: string | null; error?: string }

async function dohTxt(name: string, endpoint: string): Promise<string[] | null> {
  const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(6_000) });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null) as Row | null;
  if (!j) return null;
  if (j.Status !== 0 && j.Status !== 3) return null;       // 3 = NXDOMAIN: a definite "no record"
  return (j.Answer ?? []).filter((a: Row) => a.type === 16).map((a: Row) => String(a.data ?? "").replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
}

/** `_dmarc.<root>` TXT: found + the policy (p=…). Not blocking: a warning on the page (§4.2). */
export async function dmarcLookup(hostname: string): Promise<DmarcResult> {
  const root = registrableRoot(hostname);
  const name = `_dmarc.${root}`;
  for (const endpoint of ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"]) {
    try {
      const txts = await dohTxt(name, endpoint);
      if (txts === null) continue;
      const rec = txts.find((t) => /^v=dmarc1/i.test(t.trim())) ?? null;
      const policy = rec ? (/(?:^|;)\s*p=([a-z]+)/i.exec(rec)?.[1]?.toLowerCase() ?? null) : null;
      return { found: !!rec, record: rec, policy };
    } catch (e) { void e; }
  }
  return { found: false, record: null, policy: null, error: "lookup failed" };
}

/** A record check that does not depend on Resend: is the host's TXT/MX visible on public DNS? (used for "Not found" hints) */
export async function recordVisible(rec: DnsRecord): Promise<boolean | null> {
  const type = rec.type.toUpperCase() === "MX" ? "MX" : "TXT";
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(rec.name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null) as Row | null;
    if (!j) return null;
    const answers: string[] = (j.Answer ?? []).map((a: Row) => String(a.data ?? "").replace(/"/g, "").toLowerCase());
    const want = rec.value.toLowerCase().replace(/"/g, "");
    return answers.some((a) => a.includes(want.split(" ").pop() ?? want) || a.replace(/\s+/g, "") === want.replace(/\s+/g, ""));
  } catch { return null; }
}
