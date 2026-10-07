// Platform health measuring (health-page-PRD.md §5.1, D4, D11).
//
// Three functions, one write per run:
//   withHealth(name, handler)                 wraps a function's request handler: times the run, catches what it throws,
//                                             and at the end calls ops.run_done once with the run and every outside call
//   fetchWithHealth(provider, group, url, init) `fetch` for Unipile, the AI provider, Resend, Stripe and ElevenLabs:
//                                             records provider, endpoint group, status and time in memory for that run
//   recordCall(provider, group, fn)           the same for an SDK that cannot be given a custom fetch
//
// Rules: a failed write never fails the function; error text is cut to 300 characters and scrubbed of emails, phone
// numbers, query strings and anything shaped like a key before it leaves the process; no request or response bodies.
//
// This module imports nothing from ./outreach/supabase.ts on purpose (it is imported BY it, for serve()), and talks to
// the database over PostgREST with the service key: public.outreach_ops_run_done(payload) → ops.run_done.
import { AsyncLocalStorage } from "node:async_hooks";

export type HealthProvider = "unipile" | "ai" | "resend" | "stripe" | "elevenlabs";
export interface HealthCall { provider: string; group: string; status: number; ms: number; error_code?: string | null; error_text?: string | null }

interface RunStore {
  fn: string;
  calls: HealthCall[];
  items: number;
  workspaceId: string | null;
  errorCode: string | null;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
/** Set OUTREACH_HEALTH_OFF=1 to stop writing (never to stop measuring in memory). */
const OFF = (Deno.env.get("OUTREACH_HEALTH_OFF") ?? "") === "1";

// A request-scoped store so concurrent requests in one isolate never mix their calls. When AsyncLocalStorage is not
// available the calls land in `orphans`, which the next run that ends takes with it (counts stay right, attribution may not).
let als: AsyncLocalStorage<RunStore> | null = null;
try { als = new AsyncLocalStorage<RunStore>(); } catch { als = null; }
const orphans: HealthCall[] = [];

function store(): RunStore | undefined { try { return als?.getStore(); } catch { return undefined; } }

// ---------------------------------------------------------------------------------------------------------------
// Scrubbing (D7): what may be stored about an error
// ---------------------------------------------------------------------------------------------------------------
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?<![\w/.-])\+?\d[\d\s().-]{7,}\d(?![\w/.-])/g;
const QUERY = /\?[^\s"'<>)]*/g;
/** Keys and tokens: sk-…, sbp_…, AIza…, long hex / base64 runs, JWTs, Bearer values. */
const TOKEN = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|pk|rk|sbp|sb|xoxb|xoxp|ghp|gho)[-_][A-Za-z0-9_-]{8,}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b|\b[a-f0-9]{32,}\b|\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

/** First 300 characters of an error message with personal data and secrets replaced by [removed]. */
export function scrubErrorText(text: unknown): string | null {
  if (text == null) return null;
  let s = String((text as any)?.message ?? text).replace(/\s+/g, " ").trim();
  if (!s) return null;
  s = s.replace(TOKEN, (m, bearer) => (bearer ? `${bearer}[removed]` : "[removed]"))
    .replace(EMAIL, "[removed]")
    .replace(QUERY, "?[removed]")
    .replace(PHONE, "[removed]");
  return s.slice(0, 300);
}

/** The E_CODE at the front of an error message (the codebase's convention), or the error's own code / name. */
export function errorCodeOf(e: unknown): string | null {
  const code = (e as any)?.code;
  if (typeof code === "string" && code) return code.slice(0, 60);
  const m = /^(E_[A-Z_]+)/.exec(String((e as any)?.message ?? e ?? "").trim());
  if (m) return m[1];
  const name = (e as any)?.name;
  if (typeof name === "string" && name && name !== "Error") return name.slice(0, 60);
  return null;
}

/**
 * A stable endpoint group from a method and path: ids become `:id` ("POST /chats/Ab12…/messages" → "POST /chats/:id/messages").
 * A segment is an id when it is long, or mixes digits with letters, or is a uuid.
 */
export function endpointGroup(method: string, path: string): string {
  const clean = String(path).split("?")[0].split("/").filter(Boolean).map((seg) => {
    if (/^[0-9a-f-]{32,}$/i.test(seg) || /^\d+$/.test(seg) || seg.length > 24 || (/\d/.test(seg) && /[A-Za-z]/.test(seg) && seg.length > 8)) return ":id";
    return seg;
  });
  return `${String(method || "GET").toUpperCase()} /${clean.join("/")}`.slice(0, 120);
}

// ---------------------------------------------------------------------------------------------------------------
// Recording calls
// ---------------------------------------------------------------------------------------------------------------
function remember(call: HealthCall): void {
  const s = store();
  if (s) s.calls.push(call);
  else { orphans.push(call); if (orphans.length > 500) orphans.splice(0, orphans.length - 500); }
}

/** A network error or timeout is status 0 (counted as a failure with code `network` / `timeout`). */
function statusOfError(e: unknown): { status: number; code: string } {
  const name = String((e as any)?.name ?? "");
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted/i.test(String((e as any)?.message ?? ""))) return { status: 0, code: "timeout" };
  const st = Number((e as any)?.status ?? (e as any)?.statusCode ?? (e as any)?.response?.status);
  if (Number.isFinite(st) && st > 0) return { status: st, code: `http_${st}` };
  return { status: 0, code: "network" };
}

export interface HealthCallOpts {
  /** The call went out on a customer's own key: counted apart as `<provider>:own` and never turns a platform check red (D13). */
  own?: boolean;
  /** Error text to keep for a failed call (already known to the caller, e.g. a parsed provider message). */
  errorText?: string | null;
}

/**
 * `fetch` for calls to an outside service. The endpoint group is a short stable name ("chats.send", "reply_draft"), never a
 * URL with ids in it. Throws exactly what fetch throws; the throw is recorded as a network / timeout call.
 */
export async function fetchWithHealth(provider: HealthProvider, group: string, url: string | URL, init?: RequestInit, opts: HealthCallOpts = {}): Promise<Response> {
  const t0 = Date.now();
  const p = opts.own ? `${provider}:own` : provider;
  try {
    const res = await fetch(url, init);
    const bad = res.status >= 400;
    remember({ provider: p, group, status: res.status, ms: Date.now() - t0, error_code: bad ? `http_${res.status}` : null, error_text: bad ? (opts.errorText ?? null) : null });
    return res;
  } catch (e) {
    const { status, code } = statusOfError(e);
    remember({ provider: p, group, status, ms: Date.now() - t0, error_code: code, error_text: scrubErrorText(e) });
    throw e;
  }
}

/** For an SDK that cannot take a custom fetch: runs `fn`, times it, and reads the status from what it throws. */
export async function recordCall<T>(provider: HealthProvider, group: string, fn: () => Promise<T>, opts: HealthCallOpts = {}): Promise<T> {
  const t0 = Date.now();
  const p = opts.own ? `${provider}:own` : provider;
  try {
    const out = await fn();
    remember({ provider: p, group, status: 200, ms: Date.now() - t0 });
    return out;
  } catch (e) {
    const { status, code } = statusOfError(e);
    remember({ provider: p, group, status, ms: Date.now() - t0, error_code: (e as any)?.code && typeof (e as any).code === "string" ? String((e as any).code).slice(0, 60) : code, error_text: scrubErrorText(e) });
    throw e;
  }
}

/** Mark the error text of the LAST recorded call of this run (a client that parses the body after fetch returns). */
export function noteCallError(provider: HealthProvider, group: string, text: unknown, own = false): void {
  const s = store();
  const list = s ? s.calls : orphans;
  const p = own ? `${provider}:own` : provider;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].provider === p && list[i].group === group) { if (!list[i].error_text) list[i].error_text = scrubErrorText(text); return; }
  }
}

/** How many items this run processed (leads imported, events handled, actions sent), for `ops.fn_stats.items`. */
export function reportItems(n: number): void { const s = store(); if (s && Number.isFinite(n)) s.items += Math.max(0, Math.floor(n)); }

/** The workspace a run was for, when there is one (kept on problem rows only). */
export function reportWorkspace(id: string | null | undefined): void { const s = store(); if (s && id) s.workspaceId = id; }

/** A handler that caught its own error and answered 5xx can still name the code. */
export function reportErrorCode(code: string | null | undefined): void { const s = store(); if (s && code) s.errorCode = String(code).slice(0, 60); }

// ---------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------
export interface RunDonePayload {
  fn: string; outcome: "ok" | "failed"; duration_ms: number; items: number; status: number | null;
  error_code: string | null; error_text: string | null; workspace_id: string | null; calls: HealthCall[];
}

async function writeRunDone(payload: RunDonePayload): Promise<void> {
  if (OFF || !SUPABASE_URL || !SERVICE_KEY) return;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/outreach_ops_run_done`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, prefer: "return=minimal" },
      body: JSON.stringify({ payload }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); console.log(JSON.stringify({ at: new Date().toISOString(), fn: "health", warn: "run_done failed", status: r.status, detail: t.slice(0, 200) })); }
    else await r.body?.cancel();
  } catch (e) {
    console.log(JSON.stringify({ at: new Date().toISOString(), fn: "health", warn: "run_done failed", error: String((e as any)?.message ?? e).slice(0, 200) }));
  }
}

/** A 5xx answer's `code` / `error`, read from a clone so the real response is untouched. */
async function readFailure(res: Response): Promise<{ code: string | null; text: string | null }> {
  try {
    const t = await res.clone().text();
    try { const j = JSON.parse(t); return { code: typeof j?.code === "string" ? j.code.slice(0, 60) : null, text: scrubErrorText(j?.error ?? j?.message ?? t) }; } catch { return { code: null, text: scrubErrorText(t) }; }
  } catch { return { code: null, text: null }; }
}

/**
 * Wrap a function's handler. Every function is wrapped (serve() in ./outreach/supabase.ts does it; the Hono functions do it
 * by hand) and the build check (scripts/check-health-coverage.mjs) refuses a function that isn't. OPTIONS preflights are
 * passed through unmeasured. A thrown error is re-thrown after it is recorded, so the caller's own error mapping still runs.
 */
export function withHealth(name: string, handler: (req: Request) => Promise<Response> | Response): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return await handler(req);
    const s: RunStore = { fn: name, calls: [], items: 0, workspaceId: null, errorCode: null };
    const t0 = Date.now();
    const run = async (): Promise<Response> => {
      let res: Response;
      try {
        res = await handler(req);
      } catch (e) {
        const payload: RunDonePayload = { fn: name, outcome: "failed", duration_ms: Date.now() - t0, items: s.items, status: null, error_code: errorCodeOf(e) ?? "thrown", error_text: scrubErrorText(e), workspace_id: s.workspaceId, calls: s.calls.concat(orphans.splice(0)) };
        await writeRunDone(payload);
        throw e;
      }
      const failed = res.status >= 500;
      const fail = failed ? await readFailure(res) : { code: null, text: null };
      const payload: RunDonePayload = { fn: name, outcome: failed ? "failed" : "ok", duration_ms: Date.now() - t0, items: s.items, status: res.status, error_code: failed ? (s.errorCode ?? fail.code ?? `http_${res.status}`) : null, error_text: failed ? fail.text : null, workspace_id: s.workspaceId, calls: s.calls.concat(orphans.splice(0)) };
      // Don't hold the response for the write where the runtime can finish it after the answer is sent.
      const w = writeRunDone(payload);
      const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil;
      if (typeof waitUntil === "function") { try { waitUntil(w); } catch { await w; } } else await w;
      return res;
    };
    return als ? als.run(s, run) : run();
  };
}
