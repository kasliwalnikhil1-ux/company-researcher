// One fetch wrapper for the three CRMs: timeout, JSON parsing, and errors sorted into kinds the sync worker acts on.
import { CrmError, type CrmErrorKind, type FetchLike } from "./types.ts";

export interface CrmRequest {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body */
  json?: unknown;
  /** application/x-www-form-urlencoded body */
  form?: Record<string, string>;
  timeoutMs?: number;
}

function kindFor(status: number, body: string): CrmErrorKind {
  if (status === 401) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 403 && /REQUEST_LIMIT_EXCEEDED|RATE_LIMIT|rate limit/i.test(body)) return "rate_limit";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 500) return "transient";
  // OAuth token endpoints answer 400 when the refresh token was revoked
  if (status === 400 && /invalid_grant|BAD_REFRESH_TOKEN|expired access\/refresh token|inactive user/i.test(body)) return "auth";
  return "validation";
}

function shortMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const first = Array.isArray(j) ? j[0] : j;
    const m = first?.message ?? first?.error_description ?? first?.error ?? first?.error_info;
    if (typeof m === "string" && m) return m.slice(0, 300);
  } catch { /* not JSON */ }
  return body.replace(/\s+/g, " ").slice(0, 300);
}

export async function crmRequest<T = any>(fetchFn: FetchLike | undefined, provider: string, url: string, req: CrmRequest = {}): Promise<T> {
  const f = fetchFn ?? fetch;
  const headers: Record<string, string> = { accept: "application/json", ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(req.json); }
  else if (req.form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(req.form).toString(); }
  let res: Response;
  try {
    res = await f(url, { method: req.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(req.timeoutMs ?? 15_000) });
  } catch (e) {
    throw new CrmError(provider, "transient", 0, `${provider} did not answer: ${(e as Error)?.message ?? e}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const ra = Number(res.headers.get("retry-after"));
    throw new CrmError(provider, kindFor(res.status, text), res.status, shortMessage(text) || `HTTP ${res.status}`, text.slice(0, 2000), Number.isFinite(ra) && ra > 0 ? ra : null);
  }
  if (!text) return null as T;
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** A sentence an agency admin can act on. Never includes tokens. */
export function plainError(e: unknown): string {
  if (e instanceof CrmError) {
    const who = e.provider ? e.provider[0].toUpperCase() + e.provider.slice(1) : "The CRM";
    switch (e.kind) {
      case "auth": return `${who} no longer accepts our access. Reconnect the integration.`;
      case "rate_limit": return `${who} asked us to slow down. The sync continues on the next run.`;
      case "forbidden": return `${who} refused this action: ${e.message}. Check the connected user's permissions and the app's scopes.`;
      case "not_found": return `${who} could not find the record: ${e.message}`;
      case "transient": return `${who} had a temporary problem: ${e.message}. We will try again.`;
      case "config": return e.message;
      default: return `${who} rejected the data: ${e.message}`;
    }
  }
  return String((e as Error)?.message ?? e).slice(0, 300);
}
