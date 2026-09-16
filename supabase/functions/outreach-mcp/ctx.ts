// outreach-mcp/ctx.ts — per-request context, safety plumbing and shared helpers.
//
// Governing constraint (outreach-mcp-PRD §1.1): the MCP server is a client of the
// platform. Data reads go through an RLS-scoped supabase client bound to the
// caller's JWT; writes go through the same `outreach_*` RPCs and `outreach-*`
// edge functions the web app uses. The service-role client is used ONLY for the
// MCP's own state tables (outreach_agent_*) and the rate-limit counter.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.76.1";
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { z } from "npm:zod@4.1.13";
import { admin, ANON_KEY, SUPABASE_URL, FUNCTIONS_BASE, sha256Hex, log } from "../_shared/outreach/supabase.ts";

export { z };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Role = "owner" | "manager" | "member" | "client_viewer";
const ROLE_ORDER: Role[] = ["client_viewer", "member", "manager", "owner"];
export const roleAtLeast = (have: Role, min: Role) => ROLE_ORDER.indexOf(have) >= ROLE_ORDER.indexOf(min);

export interface Membership {
  id: string; name: string; slug: string; plan: string; role: Role;
  client_ids: string[]; can_reply: boolean; settings: Record<string, unknown>;
}

export interface Ctx {
  userId: string;
  email: string | null;
  token: string;
  /** RLS-scoped client — evaluates as the calling member. */
  user: SupabaseClient;
  memberships: Membership[];
  maxRole: Role;
}

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; _meta?: Record<string, unknown> };
export type QuotaClass = "read" | "write" | "bulk" | "gated";

export class McpError extends Error {
  code: string; remedy?: string; detail?: unknown; retry_after?: number;
  constructor(code: string, message: string, remedy?: string, detail?: unknown, retry_after?: number) {
    super(message); this.code = code; this.remedy = remedy; this.detail = detail; this.retry_after = retry_after;
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function buildCtx(authHeader: string | undefined): Promise<Ctx | null> {
  const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const { data } = await admin.auth.getUser(token);
    if (!data?.user?.id) return null;
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
    const { data: ws } = await user.rpc("outreach_my_workspaces");
    const memberships = ((ws ?? []) as Membership[]).map((m) => ({ ...m, client_ids: m.client_ids ?? [] }));
    let maxRole: Role = "client_viewer";
    for (const m of memberships) if (roleAtLeast(m.role, maxRole)) maxRole = m.role;
    return { userId: data.user.id, email: data.user.email ?? null, token, user, memberships, maxRole };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Output shaping (token economy): drop nulls / empty, compact JSON
// ---------------------------------------------------------------------------

export function clean<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clean).filter((x) => x !== undefined) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null || val === undefined) continue;
      if (Array.isArray(val) && val.length === 0) continue;
      const c = clean(val);
      if (c !== undefined) o[k] = c;
    }
    return o as T;
  }
  return v;
}

export const out = (obj: unknown, meta?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(clean(obj)) }],
  ...(meta ? { _meta: meta } : {}),
});

export const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });

/** Third-party text (lead profiles, message bodies) is data, never instruction. */
export const untrusted = (source: string, t: string | null | undefined, max = 2000) =>
  t == null || t === "" ? undefined : { untrusted_content: true, source, text: String(t).slice(0, max) };

export const isoNow = () => new Date().toISOString();
export const short = (s: string | null | undefined, n = 120) => (s == null ? undefined : String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

// ---------------------------------------------------------------------------
// Error contract: {code, message, detail?, remedy, retry_after?}
// ---------------------------------------------------------------------------

const REMEDIES: Record<string, string> = {
  E_FORBIDDEN: "Your role in this workspace does not allow this. Ask an owner/manager, or use a read tool instead.",
  E_PLAN_SUSPENDED: "The workspace is suspended (billing). Only reads work until billing is fixed in the app.",
  E_NOT_FOUND: "Check the id; it may belong to a workspace you are not a member of.",
  E_PAYLOAD_INVALID: "Fix the arguments as described in `message` and retry.",
  E_BUDGET_EXHAUSTED: "Do not escalate volume. Wait for the next planner run, or add another healthy sender to the pool.",
  E_OUT_OF_SCHEDULE: "Sends resume in the sender's next schedule window; nothing to fix.",
  E_SENDER_NOT_OK: "The sender must be reconnected by a human in the app (Senders → Reconnect).",
  E_LEAD_SUPPRESSED: "Suppressed leads cannot be contacted. Do not work around suppression.",
  E_POOL_EMPTY: "Add at least one connected sender to the sequence pool (sequence_update with pool).",
  E_SENDER_NOT_IN_POOL: "Pick a sender that is in the sequence pool, or omit sender_id.",
  E_GRAPH_INVALID: "Run sequence_validate, fix the listed nodes, then retry.",
  E_INFLIGHT: "The sequence has live enrollments; pause or exit them first.",
  E_CAP_HIT_WEEKLY: "Weekly invite ceiling reached; invites resume next week automatically.",
  E_CAP_ABOVE_CEILING: "Caps cannot exceed the platform ceiling; caps are set by managers in the app.",
  E_DUPLICATE_ENROLLMENT: "The lead is already live with that sender; use enrollments_list to find it.",
  E_TOO_MANY: "Split the request into smaller batches.",
  E_RATE_LIMITED: "Slow down and retry after a short wait.",
  E_AGENT_QUOTA: "Per-user agent quota reached for this class of tool; retry after retry_after seconds.",
  E_REQUIRES_CONFIRMATION: "Show effect_summary to the human. On an explicit yes, call the same tool with identical arguments plus confirmation_token.",
  E_CONFIRMATION_EXPIRED: "Call the tool again without confirmation_token to get a fresh summary and token.",
  E_CONFIRMATION_MISMATCH: "Arguments changed since the token was issued. Call again without confirmation_token.",
  E_PREVIEW_EXPIRED: "Run enroll_preview again and commit within 15 minutes.",
  E_AMBIGUOUS_TARGET: "Pass workspace_id explicitly (see the workspaces list in the detail).",
  E_DRAFT_STALE: "The prospect wrote again after this draft. Read inbox_thread and draft a new reply.",
  E_DRAFT_EXPIRED: "Drafts live 30 minutes; call draft_reply again.",
  E_DRAFT_ALREADY_SENT: "This draft was already sent; nothing to do.",
  E_NO_IDENTIFIER: "Each lead needs a LinkedIn public_identifier/URL or an email.",
  E_AI_UNAVAILABLE: "AI drafting is not configured (GEMINI_API_KEY); write the reply yourself and pass it as text.",
};

export function toErrorResult(e: unknown): ToolResult {
  let code = "E_INTERNAL", message = e instanceof Error ? e.message : String(e), remedy: string | undefined, detail: unknown, retry_after: number | undefined;
  if (e instanceof McpError) { code = e.code; remedy = e.remedy; detail = e.detail; retry_after = e.retry_after; }
  else {
    const m = /^(E_[A-Z_]+)(?::\s*([\s\S]*))?$/.exec(message.trim());
    if (m) { code = m[1]; message = m[2] || m[1]; }
    else if (/permission denied|row-level security/i.test(message)) code = "E_FORBIDDEN";
    else if (/JWT|invalid session|token/i.test(message) && /expired|invalid/i.test(message)) code = "E_UNAUTHORIZED";
  }
  if (code === "E_GRAPH_INVALID" && !detail) { try { detail = JSON.parse(message); message = "sequence graph is invalid"; } catch { /* keep */ } }
  remedy = remedy ?? REMEDIES[code] ?? "Report the code and message to the user; do not retry blindly.";
  return { content: [{ type: "text", text: JSON.stringify(clean({ error: true, code, message, detail, remedy, retry_after })) }], isError: true };
}

/** Unwrap a supabase {data,error} response, throwing platform error codes. */
export function unwrap<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

// ---------------------------------------------------------------------------
// Quotas (per user, per class) — outreach_rate_limit is the fixed-window counter
// ---------------------------------------------------------------------------

const QUOTA: Record<QuotaClass, { limit: number; window: number }> = {
  read: { limit: 600, window: 3600 },
  write: { limit: 120, window: 3600 },
  bulk: { limit: 60, window: 3600 },
  gated: { limit: 20, window: 3600 },
};

export async function quota(ctx: Ctx, cls: QuotaClass): Promise<void> {
  const q = QUOTA[cls];
  const { data, error } = await admin.rpc("outreach_rate_limit", { p_key: `agent:${ctx.userId}:${cls}`, p_limit: q.limit, p_window_secs: q.window });
  if (error) { log({ fn: "mcp", warn: "rate_limit failed", error: error.message }); return; }
  if (data === false) throw new McpError("E_AGENT_QUOTA", `agent quota exceeded for ${cls} tools (${q.limit}/${q.window / 60} min)`, undefined, undefined, 300);
}

/** Named daily counters (e.g. 300 sent messages/day per user). */
export async function dailyQuota(ctx: Ctx, name: string, limit: number): Promise<void> {
  const { data } = await admin.rpc("outreach_rate_limit", { p_key: `agent:${ctx.userId}:${name}:day`, p_limit: limit, p_window_secs: 86400 });
  if (data === false) throw new McpError("E_AGENT_QUOTA", `daily agent limit reached for ${name} (${limit}/day)`, undefined, undefined, 3600);
}

// ---------------------------------------------------------------------------
// Confirmation gates (two-step, single use, 10 min, bound to the argument hash)
// ---------------------------------------------------------------------------

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export const randomToken = (bytes = 24) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function argsHash(args: Record<string, unknown>): Promise<string> {
  const { confirmation_token: _c, ...rest } = args;
  return sha256Hex(stableStringify(rest));
}

export type Gate = { proceed: true } | { proceed: false; result: ToolResult };

/**
 * First call (no confirmation_token): store the intent and return a summary + token.
 * Second call (with token): verify tool, hash, expiry, single use → proceed.
 */
export async function gate(ctx: Ctx, tool: string, args: Record<string, unknown>, effectSummary: string, workspaceId: string | null, payload?: unknown): Promise<Gate> {
  const hash = await argsHash(args);
  const token = typeof args.confirmation_token === "string" ? args.confirmation_token : undefined;
  if (token) {
    const { data: row } = await admin.from("outreach_agent_confirmations").select("*").eq("token", token).maybeSingle();
    if (!row || row.user_id !== ctx.userId || row.tool !== tool) throw new McpError("E_CONFIRMATION_EXPIRED", "unknown confirmation token");
    if (row.used_at) throw new McpError("E_CONFIRMATION_EXPIRED", "confirmation token already used");
    if (new Date(row.expires_at).getTime() < Date.now()) throw new McpError("E_CONFIRMATION_EXPIRED", "confirmation token expired");
    if (row.args_sha256 !== hash) throw new McpError("E_CONFIRMATION_MISMATCH", "arguments differ from the confirmed call");
    await admin.from("outreach_agent_confirmations").update({ used_at: isoNow() }).eq("token", token);
    return { proceed: true };
  }
  const t = randomToken();
  await admin.from("outreach_agent_confirmations").insert({ token: t, user_id: ctx.userId, workspace_id: workspaceId, tool, args_sha256: hash, effect_summary: effectSummary, payload: payload ?? null, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
  if (Math.random() < 0.05) admin.rpc("outreach_agent_gc").then(() => {}, () => {});
  return {
    proceed: false,
    result: out({
      requires_confirmation: true,
      code: "E_REQUIRES_CONFIRMATION",
      effect_summary: effectSummary,
      confirmation_token: t,
      expires_in_seconds: 600,
      next: "Show effect_summary to the human verbatim. Only after an explicit yes, call this tool again with the SAME arguments plus confirmation_token. Any argument change invalidates the token.",
    }),
  };
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

export function resolveWs(ctx: Ctx, workspaceId?: string | null): Membership {
  if (workspaceId) {
    const m = ctx.memberships.find((w) => w.id === workspaceId || w.slug === workspaceId);
    if (!m) throw new McpError("E_FORBIDDEN", `you are not a member of workspace ${workspaceId}`);
    return m;
  }
  if (ctx.memberships.length === 1) return ctx.memberships[0];
  if (ctx.memberships.length === 0) throw new McpError("E_NOT_FOUND", "you have no outreach workspace yet — open /outreach in the app once to create one");
  throw new McpError("E_AMBIGUOUS_TARGET", "you belong to several workspaces; pass workspace_id", undefined, ctx.memberships.map((m) => ({ id: m.id, name: m.name, role: m.role })));
}

export function requireRole(m: Membership, min: Role): void {
  if (m.plan === "suspended" && min !== "client_viewer") throw new McpError("E_PLAN_SUSPENDED", "workspace suspended");
  if (!roleAtLeast(m.role, min)) throw new McpError("E_FORBIDDEN", `${min} role required in workspace "${m.name}" (you are ${m.role})`);
}

export function clientVisible(m: Membership, clientId: string | null | undefined): boolean {
  if (m.role === "owner" || m.role === "manager") return true;
  if (!clientId) return true;
  return m.client_ids.includes(clientId);
}

// ---------------------------------------------------------------------------
// Platform calls
// ---------------------------------------------------------------------------

/** Call an outreach_* SQL function as the user (RLS + outreach_require apply). */
export async function urpc<T = unknown>(ctx: Ctx, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await ctx.user.rpc(`outreach_${name}`, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Call an outreach-* edge function with the user's JWT (same as the web app's callFn). */
export async function callFn<T = Record<string, unknown>>(ctx: Ctx, name: string, body: Record<string, unknown>, method = "POST"): Promise<T> {
  const res = await fetch(`${FUNCTIONS_BASE}outreach-${name}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${ctx.token}`, apikey: ANON_KEY },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let data: Record<string, unknown> = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw }; }
  if (!res.ok) {
    const code = typeof data.code === "string" ? data.code : `E_HTTP_${res.status}`;
    throw new McpError(code, String(data.error ?? data.message ?? `request failed (${res.status})`), undefined, data.details);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Periods (reports)
// ---------------------------------------------------------------------------

export const periodSchema = z.union([
  z.enum(["7d", "14d", "30d", "90d"]),
  z.object({ from: z.string().describe("ISO date/time"), to: z.string().optional().describe("ISO date/time, defaults to now") }),
]).optional().describe("7d | 14d | 30d | 90d (default 7d) or {from, to}");

export function period(p: unknown): { from: string; to: string; label: string } {
  const to = new Date();
  if (p && typeof p === "object") {
    const o = p as { from: string; to?: string };
    const f = new Date(o.from), t = o.to ? new Date(o.to) : to;
    if (isNaN(f.getTime()) || isNaN(t.getTime())) throw new McpError("E_PAYLOAD_INVALID", "period.from/to must be ISO dates");
    return { from: f.toISOString(), to: t.toISOString(), label: `${f.toISOString().slice(0, 10)}..${t.toISOString().slice(0, 10)}` };
  }
  const days = Number(String(p ?? "7d").replace("d", "")) || 7;
  return { from: new Date(to.getTime() - days * 86400_000).toISOString(), to: to.toISOString(), label: `last ${days} days` };
}

// ---------------------------------------------------------------------------
// Pagination cursors (opaque offset)
// ---------------------------------------------------------------------------

export function decodeCursor(c?: string | null): number {
  if (!c) return 0;
  try { const n = Number(atob(c)); return Number.isFinite(n) && n >= 0 ? n : 0; } catch { return 0; }
}
export const encodeCursor = (n: number) => btoa(String(n));

export function chunk<T>(arr: T[], size: number): T[][] {
  const res: T[][] = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

export async function mapPool<T, R>(items: T[], concurrency: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const i = next++; res[i] = await fn(items[i], i); }
  }));
  return res;
}

// ---------------------------------------------------------------------------
// Tool registration wrapper: role gating, quota, logging, error contract
// ---------------------------------------------------------------------------

export interface Annotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }

export interface ToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  cls: QuotaClass;
  minRole: Role;
  annotations?: Annotations;
}

export type Handler<S extends z.ZodRawShape> = (args: z.infer<z.ZodObject<S>>) => Promise<unknown>;

const DEFAULT_ANN: Record<QuotaClass, Annotations> = {
  read: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  bulk: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  gated: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

export function tool<S extends z.ZodRawShape>(server: McpServer, ctx: Ctx, spec: ToolSpec<S>, handler: Handler<S>): void {
  if (!roleAtLeast(ctx.maxRole, spec.minRole)) return; // not registered → the client never sees it
  const cfg = {
    title: spec.title,
    description: spec.description,
    inputSchema: spec.input,
    annotations: { ...DEFAULT_ANN[spec.cls], ...(spec.annotations ?? {}) },
  };
  // deno-lint-ignore no-explicit-any
  (server as any).registerTool(spec.name, cfg, async (args: z.infer<z.ZodObject<S>>) => {
    const t0 = Date.now();
    let outcome = "ok", errorCode: string | null = null, result: ToolResult;
    try {
      await quota(ctx, spec.cls);
      const r = await handler(args ?? ({} as z.infer<z.ZodObject<S>>));
      result = r && typeof r === "object" && "content" in (r as Record<string, unknown>) ? (r as ToolResult) : out(r);
      if (result.isError) { outcome = "error"; try { errorCode = JSON.parse(result.content[0].text).code ?? null; } catch { /* ignore */ } }
    } catch (e) {
      result = toErrorResult(e);
      outcome = "error";
      try { errorCode = JSON.parse(result.content[0].text).code ?? null; } catch { /* ignore */ }
    }
    const ws = typeof (args as Record<string, unknown>)?.workspace_id === "string" ? String((args as Record<string, unknown>).workspace_id) : null;
    argsHash((args ?? {}) as Record<string, unknown>).then((h) =>
      admin.from("outreach_agent_calls").insert({ user_id: ctx.userId, workspace_id: ws, tool: spec.name, args_sha256: h, outcome, error_code: errorCode, duration_ms: Date.now() - t0 }).then(() => {}, () => {}),
    ).catch(() => {});
    return result;
  });
}

// Common schema fragments
export const wsParam = { workspace_id: z.string().optional().describe("Workspace id (or slug). Omit when you belong to exactly one workspace.") };
export const idsParam = (what: string, max = 1000) => z.array(z.string()).min(1).max(max).describe(`${what} ids (≤${max}).`);
