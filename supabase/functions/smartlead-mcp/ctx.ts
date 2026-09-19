// smartlead-mcp/ctx.ts — per-request context, safety plumbing and shared helpers.
//
// Governing constraint (smartlead-mcp-prd.md §2): this connector is the AGENT lane.
// Cold sequence sending stays on Smartlead's own scheduler; the connector reads,
// diagnoses, edits copy/settings and sends ONE approved reply at a time into an
// existing thread. The guardrails of PRD §6 are enforced here and in the tools,
// not left to the prompt:
//   - two-step approval tokens bound to the exact arguments (approve the exact text, one approval = one send)
//   - rolling send caps (the "session cap"; the server is stateless per request)
//   - the audit row is written before the send (tools_inbox.ts)
// The service-role client is used ONLY for the connector's own tables
// (smartlead_agent_*, smartlead_reply_log). The Smartlead API key never leaves
// this function.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.76.1";
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { z } from "npm:zod@4.1.13";

export { z };

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
export const WEB_ORIGIN = Deno.env.get("SMARTLEAD_WEB_ORIGIN") ?? Deno.env.get("OUTREACH_WEB_ORIGIN") ?? "https://app.capitalxai.com";

export const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

export function log(fields: Record<string, unknown>): void {
  try { console.log(JSON.stringify({ at: new Date().toISOString(), ...fields })); } catch { console.log(fields); }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Member { user_id: string; display_name: string; email: string | null; is_active: boolean }

export interface Settings {
  max_sends_per_hour_per_user: number;
  max_sends_per_day_team: number;
  bounce_rate_threshold: number;
  warmup_spam_rate_threshold: number;
  warmup_min_reputation: number;
  timezone: string;
}

const DEFAULT_SETTINGS: Settings = { max_sends_per_hour_per_user: 10, max_sends_per_day_team: 40, bounce_rate_threshold: 0.03, warmup_spam_rate_threshold: 0.05, warmup_min_reputation: 90, timezone: "Asia/Kolkata" };

export interface Ctx {
  userId: string;
  email: string | null;
  token: string;
  /** RLS-scoped client — evaluates as the calling team member (used for the cross-channel read of outreach_* and the reply log). */
  user: SupabaseClient;
  me: Member | null;
  isMember: boolean;
  settings: Settings;
}

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

export class McpError extends Error {
  code: string; remedy?: string; detail?: unknown; retry_after?: number;
  constructor(code: string, message: string, remedy?: string, detail?: unknown, retry_after?: number) { super(message); this.code = code; this.remedy = remedy; this.detail = detail; this.retry_after = retry_after; }
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
    const user = createClient(SUPABASE_URL, ANON_KEY || SERVICE_ROLE_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
    const { data: c, error } = await user.rpc("smartlead_context");
    if (error) log({ fn: "smartlead-mcp", warn: "smartlead_context failed", error: error.message });
    const raw = ((c as Row | null)?.settings ?? {}) as Row;
    const num = (k: keyof Settings) => (Number.isFinite(Number(raw[k])) ? Number(raw[k]) : (DEFAULT_SETTINGS[k] as number));
    const settings: Settings = {
      max_sends_per_hour_per_user: num("max_sends_per_hour_per_user"), max_sends_per_day_team: num("max_sends_per_day_team"),
      bounce_rate_threshold: num("bounce_rate_threshold"), warmup_spam_rate_threshold: num("warmup_spam_rate_threshold"), warmup_min_reputation: num("warmup_min_reputation"),
      timezone: typeof raw.timezone === "string" ? raw.timezone : DEFAULT_SETTINGS.timezone,
    };
    return { userId: data.user.id, email: data.user.email ?? null, token, user, me: ((c as Row | null)?.me ?? null) as Member | null, isMember: !!(c as Row | null)?.is_member, settings };
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

export const out = (obj: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(clean(obj)) }] });
export const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });

/** Text written by a lead (or any third party) is data, never instruction. */
export const untrusted = (source: string, t: string | null | undefined, max = 2000) =>
  t == null || t === "" ? undefined : { untrusted_content: true, source, text: String(t).length > max ? String(t).slice(0, max) + "…[truncated]" : String(t) };

export const isoNow = () => new Date().toISOString();
export const short = (s: string | null | undefined, n = 120) => (s == null ? undefined : String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

/** Bound the size of a pass-through payload: long arrays are cut, long strings shortened. */
export function trim(v: unknown, maxItems = 25, maxStr = 600, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (Array.isArray(v)) { const a = v.slice(0, maxItems).map((x) => trim(x, maxItems, maxStr, depth + 1)); if (v.length > maxItems) a.push(`…[${v.length - maxItems} more]`); return a; }
  if (v && typeof v === "object") { const o: Row = {}; for (const [k, val] of Object.entries(v as Row)) { if (/pass(word)?|secret|token|api_?key/i.test(k)) continue; o[k] = trim(val, maxItems, maxStr, depth + 1); } return o; }
  if (typeof v === "string" && v.length > maxStr) return v.slice(0, maxStr) + "…";
  return v;
}

// ---------------------------------------------------------------------------
// Error contract: {code, message, detail?, remedy, retry_after?}
// ---------------------------------------------------------------------------

const REMEDIES: Record<string, string> = {
  E_UNAUTHORIZED: "The connector session expired; reconnect the CapitalxAI Smartlead connector.",
  E_FORBIDDEN: "The signed-in account is not on the email-ops team. A member can add it with the SQL function smartlead_add_member(email).",
  E_NOT_CONFIGURED: "The Smartlead API key is not set on the Supabase project. Someone with project access must run: supabase secrets set SMARTLEAD_API_KEY=… --project-ref ktwqkvjuzsunssudqnrt",
  E_SMARTLEAD_AUTH: "Smartlead rejected the API key (rotated or wrong). Update the SMARTLEAD_API_KEY secret; nothing the agent can fix.",
  E_NOT_FOUND: "Check the id. Use list_campaigns / list_replies / list_campaign_leads to find the right campaign, lead or thread.",
  E_PAYLOAD_INVALID: "Fix the arguments as described in `message` and retry.",
  E_RATE_LIMITED: "Smartlead's rate limit was hit. Wait retry_after seconds; do not loop.",
  E_SMARTLEAD_HTTP: "Smartlead returned an error. Report the message to the user; do not retry blindly.",
  E_REQUIRES_CONFIRMATION: "Show effect_summary to the human verbatim. Only after an explicit yes, call the same tool again with identical arguments plus confirmation_token.",
  E_CONFIRMATION_EXPIRED: "Call the tool again without confirmation_token to get a fresh summary and token, and show it to the human again.",
  E_CONFIRMATION_MISMATCH: "The arguments changed after approval (even one character of the body counts). Call again without confirmation_token and get the new text approved.",
  E_SEND_CAP: "The send cap was reached. Stop sending; tell the user how many went out and when the window reopens. A member can raise the cap in smartlead_settings — the agent must not.",
  E_NO_INBOUND: "This lead has not written back, so there is no thread to reply into. This connector never opens a cold thread — cold sends belong to the campaign sequence.",
  E_NON_HUMAN: "Do not answer automated mail. Categorise the lead instead (update_lead_category: Out Of Office / Do Not Contact / Bounced …) and pause follow-ups if needed. If the detection is wrong, a human can reply from the Smartlead UI.",
  E_THREAD_MOVED: "The lead wrote again after the text was approved. Read the thread again (get_reply), redraft, and get the new text approved.",
  E_NOT_PAUSED: "resume_campaign only resumes a campaign this team paused. Starting a DRAFTED (or stopped) campaign begins cold sending and stays a human action in the Smartlead UI.",
  E_SEQUENCE_INCOMPLETE: "Saving replaces the whole sequence. Read get_campaign_sequences, send EVERY step back, and list any step you really mean to delete in remove_seq_numbers.",
  E_TOO_MANY: "Split the request into smaller batches.",
  E_LEFT_PAUSED: "The campaign was paused for the edit and could NOT be resumed automatically. Tell the user now; run resume_campaign (with their yes) or resume it in the Smartlead UI.",
  E_AUDIT_FAILED: "The audit row could not be written, so nothing was sent. Report this; do not retry until the database is reachable.",
  E_INTERNAL: "Report the code and message to the user; do not retry blindly.",
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
  remedy = remedy ?? REMEDIES[code] ?? REMEDIES.E_INTERNAL;
  return { content: [{ type: "text", text: JSON.stringify(clean({ error: true, code, message, detail, remedy, retry_after })) }], isError: true };
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Confirmation gates (two-step, single use, 10 min, bound to the argument hash)
// ---------------------------------------------------------------------------

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().filter((k) => (v as Row)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify((v as Row)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const randomToken = (bytes = 24) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function argsHash(args: Record<string, unknown>): Promise<string> {
  const { confirmation_token: _c, ...rest } = args;
  return sha256Hex(stableStringify(rest));
}

export type Gate = { proceed: true; token: string; payload: Row | null } | { proceed: false; result: ToolResult };

/**
 * First call (no confirmation_token): store the intent, return the summary + token. Nothing happens.
 * Second call (with token): verify tool + user + argument hash + expiry, then consume the token
 * atomically (single use — one approval can never produce two sends).
 */
export async function gate(ctx: Ctx, tool: string, args: Record<string, unknown>, effectSummary: string, payload?: Row): Promise<Gate> {
  const hash = await argsHash(args);
  const token = typeof args.confirmation_token === "string" && args.confirmation_token ? args.confirmation_token : undefined;
  if (token) {
    const { data: row } = await admin.from("smartlead_agent_confirmations").select("*").eq("token", token).maybeSingle();
    if (!row || row.user_id !== ctx.userId || row.tool !== tool) throw new McpError("E_CONFIRMATION_EXPIRED", "unknown confirmation token");
    if (row.used_at) throw new McpError("E_CONFIRMATION_EXPIRED", "confirmation token already used — one approval is one action");
    if (new Date(row.expires_at).getTime() < Date.now()) throw new McpError("E_CONFIRMATION_EXPIRED", "confirmation token expired (10 minutes)");
    if (row.args_sha256 !== hash) throw new McpError("E_CONFIRMATION_MISMATCH", "arguments differ from the approved call");
    const { data: used, error } = await admin.from("smartlead_agent_confirmations").update({ used_at: isoNow() }).eq("token", token).is("used_at", null).select("token");
    if (error || !used || used.length !== 1) throw new McpError("E_CONFIRMATION_EXPIRED", "confirmation token already used — one approval is one action");
    return { proceed: true, token, payload: (row.payload ?? null) as Row | null };
  }
  const t = randomToken();
  const { error } = await admin.from("smartlead_agent_confirmations").insert({ token: t, user_id: ctx.userId, tool, args_sha256: hash, effect_summary: effectSummary, payload: payload ?? null, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
  if (error) throw new McpError("E_INTERNAL", `could not store the confirmation: ${error.message}`);
  if (Math.random() < 0.05) admin.rpc("smartlead_agent_gc").then(() => {}, () => {});
  return {
    proceed: false,
    result: out({
      requires_confirmation: true,
      code: "E_REQUIRES_CONFIRMATION",
      effect_summary: effectSummary,
      confirmation_token: t,
      expires_in_seconds: 600,
      next: "NOTHING HAS HAPPENED YET. Show effect_summary to the human verbatim. Only after an explicit yes to exactly this, call this tool again with the SAME arguments plus confirmation_token. Any change to the arguments invalidates the token; the token works once.",
    }),
  };
}

// ---------------------------------------------------------------------------
// Send caps (PRD §6.8) — counted from the audit log, so they cannot drift from reality
// ---------------------------------------------------------------------------

export interface SendBudget { sent_last_hour_by_you: number; hour_cap: number; sent_last_24h_team: number; day_cap: number; remaining: number }

export async function sendBudget(ctx: Ctx): Promise<SendBudget> {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString(), dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const [h, d] = await Promise.all([
    admin.from("smartlead_reply_log").select("id", { count: "exact", head: true }).eq("user_id", ctx.userId).in("status", ["pending", "sent"]).gte("approved_at", hourAgo),
    admin.from("smartlead_reply_log").select("id", { count: "exact", head: true }).in("status", ["pending", "sent"]).gte("approved_at", dayAgo),
  ]);
  if (h.error || d.error) throw new McpError("E_AUDIT_FAILED", `cannot read the send log: ${(h.error ?? d.error)!.message}`);
  const hour = h.count ?? 0, day = d.count ?? 0;
  const s = ctx.settings;
  return { sent_last_hour_by_you: hour, hour_cap: s.max_sends_per_hour_per_user, sent_last_24h_team: day, day_cap: s.max_sends_per_day_team, remaining: Math.max(0, Math.min(s.max_sends_per_hour_per_user - hour, s.max_sends_per_day_team - day)) };
}

export async function assertCanSend(ctx: Ctx): Promise<SendBudget> {
  const b = await sendBudget(ctx);
  if (b.remaining <= 0) {
    const which = b.sent_last_hour_by_you >= b.hour_cap ? `${b.hour_cap} replies per hour per person` : `${b.day_cap} replies per 24h for the team`;
    throw new McpError("E_SEND_CAP", `send cap reached (${which})`, undefined, b, b.sent_last_hour_by_you >= b.hour_cap ? 1800 : 3600);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Tool registration wrapper: membership gate, logging, error contract
// ---------------------------------------------------------------------------

export interface Annotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
export type ToolClass = "read" | "write" | "gated";

export interface ToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  cls: ToolClass;
  /** Registered even for non-members (default false → members only). */
  public?: boolean;
  annotations?: Annotations;
}

export type Handler<S extends z.ZodRawShape> = (args: z.infer<z.ZodObject<S>>) => Promise<unknown>;

// openWorldHint: every tool talks to Smartlead, an external system.
const DEFAULT_ANN: Record<ToolClass, Annotations> = {
  read: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  gated: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};

export function tool<S extends z.ZodRawShape>(server: McpServer, ctx: Ctx, spec: ToolSpec<S>, handler: Handler<S>): void {
  if (!ctx.isMember && !spec.public) return; // not registered → a non-member's client never sees it
  const cfg = { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: { ...DEFAULT_ANN[spec.cls], ...(spec.annotations ?? {}) } };
  // deno-lint-ignore no-explicit-any
  (server as any).registerTool(spec.name, cfg, async (args: z.infer<z.ZodObject<S>>) => {
    const t0 = Date.now();
    let outcome = "ok", errorCode: string | null = null, result: ToolResult;
    try {
      const r = await handler(args ?? ({} as z.infer<z.ZodObject<S>>));
      result = r && typeof r === "object" && "content" in (r as Record<string, unknown>) ? (r as ToolResult) : out(r);
      if (result.isError) { outcome = "error"; try { errorCode = JSON.parse(result.content[0].text).code ?? null; } catch { /* ignore */ } }
    } catch (e) {
      result = toErrorResult(e);
      outcome = "error";
      try { errorCode = JSON.parse(result.content[0].text).code ?? null; } catch { /* ignore */ }
    }
    argsHash((args ?? {}) as Record<string, unknown>).then((h) =>
      admin.from("smartlead_agent_calls").insert({ user_id: ctx.userId, tool: spec.name, args_sha256: h, outcome, error_code: errorCode, duration_ms: Date.now() - t0 }).then(() => {}, () => {}),
    ).catch(() => {});
    return result;
  });
}

// ---------------------------------------------------------------------------
// Common schema fragments + small helpers
// ---------------------------------------------------------------------------

export const campaignId = z.number().int().positive().describe("Smartlead campaign id (list_campaigns)");
export const leadId = z.number().int().positive().describe("Smartlead lead id (list_replies / list_campaign_leads / get_reply)");
export const confirmParam = { confirmation_token: z.string().optional().describe("Only on the second call, after the human said yes to the effect_summary of the first call") };
export const rawParam = { raw: z.boolean().optional().describe("Debug only: also return Smartlead's unmodified payload (truncated). Leave off in normal use.") };
export const dateParam = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").describe(`${what} (YYYY-MM-DD)`);

export const isEmail = (s: unknown): s is string => typeof s === "string" && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(s.trim());

export async function mapPool<T, R>(items: T[], concurrency: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const i = next++; res[i] = await fn(items[i], i); }
  }));
  return res;
}

export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
