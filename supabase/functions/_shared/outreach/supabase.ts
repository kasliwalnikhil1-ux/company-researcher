// Shared runtime helpers for outreach-* edge functions (Deno).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.76.1";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
export const CRON_SECRET = Deno.env.get("OUTREACH_CRON_SECRET") ?? "";
export const WEB_ORIGIN = Deno.env.get("OUTREACH_WEB_ORIGIN") ?? "https://app.capitalxai.com";
export const FUNCTIONS_BASE = (Deno.env.get("OUTREACH_FUNCTIONS_BASE_URL") ?? `${SUPABASE_URL}/functions/v1/`).replace(/\/?$/, "/");

export const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info, x-cron-secret, unipile-auth",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
};

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS, ...headers } });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message, code: e.code, details: e.details }, e.status);
  const msg = (e as any)?.message ?? String(e);
  const m = /^(E_[A-Z_]+)(?::\s*(.*))?$/s.exec(msg.trim());
  if (m) return json({ error: m[2] || m[1], code: m[1] }, m[1] === "E_FORBIDDEN" ? 403 : m[1] === "E_NOT_FOUND" ? 404 : 400);
  console.error("unhandled", e);
  return json({ error: msg, code: "E_INTERNAL" }, 500);
}

/** Wrap a handler with CORS preflight + error mapping + JSON logging. */
export function serve(fn: string, handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    const t0 = Date.now();
    try {
      const res = await handler(req);
      log({ fn, outcome: "ok", status: res.status, duration_ms: Date.now() - t0 });
      return res;
    } catch (e) {
      log({ fn, outcome: "error", error: (e as any)?.message ?? String(e), duration_ms: Date.now() - t0 });
      return errorResponse(e);
    }
  });
}

export function log(fields: Record<string, unknown>): void {
  try { console.log(JSON.stringify({ at: new Date().toISOString(), ...fields })); } catch { console.log(fields); }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < ab.length; i++) out |= ab[i] ^ bb[i];
  return out === 0;
}

/** Cron / internal auth: x-cron-secret header or service-role bearer. */
export function requireCron(req: Request): void {
  const secret = req.headers.get("x-cron-secret") ?? "";
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if ((CRON_SECRET && timingSafeEqual(secret, CRON_SECRET)) || (bearer && timingSafeEqual(bearer, SERVICE_ROLE_KEY))) return;
  throw new HttpError(401, "E_FORBIDDEN", "cron secret required");
}

export interface AuthedUser { id: string; email: string | null; token: string; client: SupabaseClient }

/** User auth: validate JWT, return user + RLS-scoped client. */
export async function requireUser(req: Request): Promise<AuthedUser> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) throw new HttpError(401, "E_FORBIDDEN", "missing bearer token");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "E_FORBIDDEN", "invalid session");
  const client = createClient(SUPABASE_URL, ANON_KEY || SERVICE_ROLE_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  return { id: data.user.id, email: data.user.email ?? null, token, client };
}

export type Role = "owner" | "manager" | "member" | "client_viewer";

export interface Membership { workspace_id: string; role: Role; client_ids: string[]; can_reply: boolean; plan: string }

export async function membership(userId: string, workspaceId: string): Promise<Membership> {
  const { data, error } = await admin.from("outreach_members").select("workspace_id, role, client_ids, can_reply, outreach_workspaces!inner(plan)").eq("user_id", userId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw new HttpError(500, "E_INTERNAL", error.message);
  if (!data) throw new HttpError(403, "E_FORBIDDEN", "not a member of this workspace");
  const plan = (data as any).outreach_workspaces?.plan ?? "trial";
  return { workspace_id: data.workspace_id, role: data.role, client_ids: data.client_ids ?? [], can_reply: data.can_reply, plan };
}

export function requireRole(m: Membership, min: "owner" | "manager" | "member" | "client_viewer"): void {
  const order: Role[] = ["client_viewer", "member", "manager", "owner"];
  if (m.plan === "suspended" && min !== "client_viewer") throw new HttpError(403, "E_PLAN_SUSPENDED", "workspace suspended");
  if (order.indexOf(m.role) < order.indexOf(min)) throw new HttpError(403, "E_FORBIDDEN", `${min} role required`);
}

export function clientVisible(m: Membership, clientId: string | null): boolean {
  if (m.role === "owner" || m.role === "manager") return true;
  if (!clientId) return true;
  return m.client_ids.includes(clientId);
}

/** Call an outreach_* SQL function as service role, throwing on error. */
export async function rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(`outreach_${name}`, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export async function rateLimit(key: string, limit: number, windowSecs: number): Promise<void> {
  const ok = await rpc<boolean>("rate_limit", { p_key: key, p_limit: limit, p_window_secs: windowSecs });
  if (!ok) throw new HttpError(429, "E_RATE_LIMITED", "too many requests");
}

export async function readJson<T = any>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { return {} as T; }
}

export async function emitEvent(workspaceId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  try { await rpc("emit_event", { p_ws: workspaceId, p_event: event, p_payload: payload }); } catch (e) { log({ fn: "emitEvent", error: String(e) }); }
}

export async function audit(workspaceId: string | null, action: string, entity: string, entityId: string | null, diff: unknown = null, actorType = "system"): Promise<void> {
  try { await admin.from("outreach_audit_log").insert({ workspace_id: workspaceId, actor: null, actor_type: actorType, action, entity, entity_id: entityId, diff }); } catch { /* ignore */ }
}

export async function flag(key: string, fallback: unknown = null): Promise<unknown> {
  const { data } = await admin.from("outreach_flags").select("value").eq("key", key).maybeSingle();
  return data?.value ?? fallback;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const rand = (min: number, max: number) => min + Math.random() * (max - min);
export const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Local date (YYYY-MM-DD) and hour for a timezone. */
export function localParts(tz: string, at: Date = new Date()): { date: string; hour: number; minute: number; weekday: string; iso: string } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, hour: Number(parts.hour), minute: Number(parts.minute), weekday: String(parts.weekday).toLowerCase().slice(0, 3), iso: `${date}T${parts.hour}:${parts.minute}` };
}

/** Convert a local wall-clock time in tz to a UTC Date (iterative offset correction). */
export function zonedToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 3; i++) {
    const lp = localParts(tz, new Date(guess));
    const [ly, lm, ld] = lp.date.split("-").map(Number);
    const local = Date.UTC(ly, lm - 1, ld, lp.hour, lp.minute, 0);
    const want = Date.UTC(y, m - 1, d, hh, mm, 0);
    const diff = want - local;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
