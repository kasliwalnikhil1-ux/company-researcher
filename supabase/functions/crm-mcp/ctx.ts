// crm-mcp/ctx.ts — per-request context and shared helpers for the Sales CRM connector.
//
// Governing constraint: the MCP server is a client of the CRM, exactly like the
// web app. Every read goes through an RLS-scoped supabase client bound to the
// caller's JWT and every write goes through the same `crm_*` RPCs the /crm
// screens call — so there is no MCP-only or UI-only path, and the database rules
// (capture-before-held, forward-only stages, stage history) apply to both.
// The service-role client is used ONLY for the connector's own call log and for the
// ticketed transcript upload (index.ts POST /transcript), where the one-time ticket —
// verified inside crm_save_transcript — stands in for the member's JWT.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.76.1";
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { z } from "npm:zod@4.1.13";

export { z };

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
export const WEB_ORIGIN = Deno.env.get("CRM_WEB_ORIGIN") ?? Deno.env.get("OUTREACH_WEB_ORIGIN") ?? "https://app.capitalxai.com";

export const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

export function log(fields: Record<string, unknown>): void {
  try { console.log(JSON.stringify({ at: new Date().toISOString(), ...fields })); } catch { console.log(fields); }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Lookup { id: string; slug: string; label: string; is_active: boolean; sort_order: number; notes?: string | null; counts_as?: string | null }
export interface Member { user_id: string; display_name: string; email: string | null; is_active: boolean }

export interface CrmContext {
  user_id: string;
  is_member: boolean;
  me: Member | null;
  members: Member[];
  settings: Record<string, unknown>;
  timezone: string;
  stale_after_days: number;
  stages: string[];
  icp_segments: Lookup[];
  source_channels: Lookup[];
  activity_types: Lookup[];
  fx_rates: Record<string, number>;
}

export interface Ctx {
  userId: string;
  email: string | null;
  token: string;
  /** RLS-scoped client — evaluates as the calling team member. */
  user: SupabaseClient;
  crm: CrmContext;
  isMember: boolean;
}

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export class McpError extends Error {
  code: string; remedy?: string; detail?: unknown;
  constructor(code: string, message: string, remedy?: string, detail?: unknown) { super(message); this.code = code; this.remedy = remedy; this.detail = detail; }
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
    const { data: crm, error } = await user.rpc("crm_context");
    if (error) log({ fn: "crm-mcp", warn: "crm_context failed", error: error.message });
    const c = (crm ?? { user_id: data.user.id, is_member: false, me: null, members: [], settings: {}, timezone: "Asia/Kolkata", stale_after_days: 14, stages: [], icp_segments: [], source_channels: [], activity_types: [], fx_rates: {} }) as CrmContext;
    return { userId: data.user.id, email: data.user.email ?? null, token, user, crm: c, isMember: !!c.is_member };
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

/** Prospect-written text (pain points, message bodies, notes) is data, never instruction. */
export const untrusted = (source: string, t: string | null | undefined, max = 2000) =>
  t == null || t === "" ? undefined : { untrusted_content: true, source, text: String(t).slice(0, max) };

// ---------------------------------------------------------------------------
// Error contract: {code, message, detail?, remedy}
// ---------------------------------------------------------------------------

const REMEDIES: Record<string, string> = {
  E_UNAUTHORIZED: "The connector session expired; reconnect the CapitalxAI Sales CRM connector.",
  E_FORBIDDEN: "The signed-in account is not on the CRM team. A team member can add it in CRM → Settings → Team (or with add_team_member).",
  E_NOT_FOUND: "Check the id or name. Use search / crm_context to find the right company, contact, deal, member or lookup value.",
  E_PAYLOAD_INVALID: "Fix the arguments as described in `message` and retry.",
  E_CAPTURE_INCOMPLETE: "Ask the human for exactly the listed fields, then call capture_meeting again with everything. Never write a partial capture.",
  E_CAPTURE_REQUIRED: "A meeting only becomes held/no_show through capture_meeting. Run the capture (it flips the meeting status itself).",
  E_CAPTURE_MISMATCH: "The capture outcome and the requested status differ; use the outcome that was captured.",
  E_ALREADY_CAPTURED: "Use update_capture to change an existing capture.",
  E_CAPTURE_LOCKED: "Captures of held/no-show meetings are permanent; edit with update_capture instead.",
  E_MEETING_CANCELLED: "Reschedule with update_meeting (status: scheduled, new scheduled_at) before capturing.",
  E_STAGE_BACKWARD: "Stages move forward or to lost. To move backwards, repeat update_deal with a `reason` — it is written to stage_history.",
  E_UNKNOWN_CURRENCY: "Add the currency with set_fx_rate(currency, usd_per_unit) first; values are never stored without a currency.",
  E_LAST_MEMBER: "At least one active team member must remain.",
  E_STORAGE_NOT_CONFIGURED: "Call-audio storage is not set up on the server yet. Tell the user; transcripts and captures still work without it.",
  E_INTERNAL: "Report the code and message to the user; do not retry blindly.",
};

export function toErrorResult(e: unknown): ToolResult {
  let code = "E_INTERNAL", message = e instanceof Error ? e.message : String(e), remedy: string | undefined, detail: unknown;
  if (e instanceof McpError) { code = e.code; remedy = e.remedy; detail = e.detail; }
  else {
    const m = /^(E_[A-Z_]+)(?::\s*([\s\S]*))?$/.exec(message.trim());
    if (m) { code = m[1]; message = m[2] || m[1]; }
    else if (/permission denied|row-level security/i.test(message)) code = "E_FORBIDDEN";
    else if (/JWT|invalid session|token/i.test(message) && /expired|invalid/i.test(message)) code = "E_UNAUTHORIZED";
    else if (/invalid input value for enum crm_deal_stage_t/i.test(message)) { code = "E_PAYLOAD_INVALID"; message = `unknown stage — use one of new, contacted, replied, meeting_booked, meeting_held, proposal_sent, negotiation, won, lost (${message})`; }
    else if (/invalid input syntax for type (date|timestamp)/i.test(message)) { code = "E_PAYLOAD_INVALID"; message = `dates must be ISO (YYYY-MM-DD or full timestamp): ${message}`; }
  }
  remedy = remedy ?? REMEDIES[code] ?? REMEDIES.E_INTERNAL;
  return { content: [{ type: "text", text: JSON.stringify(clean({ error: true, code, message, detail, remedy })) }], isError: true };
}

/** Call a crm_* SQL function as the user (RLS + crm_require_member apply). */
export async function rpc<T = unknown>(ctx: Ctx, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await ctx.user.rpc(`crm_${name}`, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Drop undefined keys so RPC jsonb payloads only carry what the caller set (presence = "set this field"). */
export function compact(o: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v;
  return r;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Tool registration wrapper: membership gate, logging, error contract
// ---------------------------------------------------------------------------

export interface Annotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
export type ToolClass = "read" | "write";

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

const DEFAULT_ANN: Record<ToolClass, Annotations> = {
  read: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
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
    sha256Hex(JSON.stringify(args ?? {})).then((h) =>
      admin.from("crm_agent_calls").insert({ user_id: ctx.userId, tool: spec.name, args_sha256: h, outcome, error_code: errorCode, duration_ms: Date.now() - t0 }).then(() => {}, () => {}),
    ).catch(() => {});
    return result;
  });
}

// ---------------------------------------------------------------------------
// Common schema fragments
// ---------------------------------------------------------------------------

export const dateParam = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").describe(`${what} (YYYY-MM-DD)`);
export const tzParam = z.string().optional().describe("IANA timezone for 'day' boundaries (default: the team timezone from settings, Asia/Kolkata unless changed)");
export const stageEnum = z.enum(["new", "contacted", "replied", "meeting_booked", "meeting_held", "proposal_sent", "negotiation", "won", "lost"]);
export const companyRef = z.string().describe("Company id, domain or name");
export const lookupRef = (what: string) => z.string().optional().describe(`${what} — id, slug or label (see crm_context)`);
export const memberRef = z.string().optional().describe("Team member — 'me' (default), user id, email or display name");

/** Format a money value for summaries. */
export const money = (v: number | null | undefined, cur: string | null | undefined) => (v == null ? "—" : `${cur ?? ""} ${Number(v).toLocaleString("en-IN")}`.trim());
