// outreach-api/dispatch.ts — request context, the one database door, input parsing and the error contract.
//
// Governing rule (PLAN-BUILD-CONTRACT "One RPC, three surfaces"): every API operation runs the SAME
// outreach_* SQL function the web app and the connector use, through outreach_api_dispatch. That function
// executes as the member who created the key, narrowed to the key's role and client scope. Nothing in this
// edge function reads or writes platform tables for a response, and no number or rule is recomputed here.

import type { Context, Hono } from "npm:hono@4.9.7";
import { z } from "npm:zod@4.1.13";
import { HttpError, rpc } from "../_shared/outreach/supabase.ts";

export { z, HttpError };

export type Role = "owner" | "manager" | "member" | "client_viewer";

/** What outreach_api_authenticate returns for a valid key. */
export interface KeyCtx {
  key_id: string;
  workspace_id: string;
  user_id: string;
  role: Role;
  client_ids: string[];
  plan: string;
  name: string;
}

export interface ApiCtx { requestId: string; key: KeyCtx }

export type Env = { Variables: { ctx: ApiCtx; body: unknown; rateHeaders: Record<string, string> } };
export type App = Hono<Env>;
export type C = Context<Env>;

// ---------------------------------------------------------------------------
// The one database door
// ---------------------------------------------------------------------------

/**
 * Run a whitelisted outreach_<fn> as the key's member. Arguments are passed by name (always the full `p_…`
 * name here, although the dispatcher also accepts the short form). `undefined` values are dropped so the SQL
 * default applies; `null` is sent as SQL NULL.
 */
export async function call<T = unknown>(ctx: ApiCtx, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (v !== undefined) clean[k] = v;
  try {
    return await rpc<T>("api_dispatch", { p_key_id: ctx.key.key_id, p_fn: fn, p_args: clean });
  } catch (e) {
    throw toHttpError(e);
  }
}

/** Set-returning RPCs come back as an array; functions that return one row use this. */
export function firstRow<T = Record<string, unknown>>(rows: unknown): T | null {
  return Array.isArray(rows) ? ((rows[0] as T) ?? null) : ((rows as T) ?? null);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const STATUS: Record<string, number> = {
  E_UNAUTHORIZED: 401,
  E_PLAN_SUSPENDED: 402,
  E_FORBIDDEN: 403,
  E_NOT_FOUND: 404,
  E_ENROLLMENT_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_IDEMPOTENCY_MISMATCH: 409,
  E_IN_PROGRESS: 409,
  E_TOO_MANY: 422,
  E_PAYLOAD_INVALID: 422,
  E_GRAPH_INVALID: 422,
  E_RATE_LIMITED: 429,
  E_NOT_IMPLEMENTED: 501,
};

const DEFAULT_MESSAGE: Record<string, string> = {
  E_FORBIDDEN: "This key is not allowed to do that.",
  E_NOT_FOUND: "Not found, or not visible to this key.",
  E_ENROLLMENT_NOT_FOUND: "Enrollment not found.",
  E_PLAN_SUSPENDED: "The workspace is suspended. Fix billing in the app, then retry.",
  E_POOL_EMPTY: "The sequence has no senders in its pool.",
  E_INFLIGHT: "Leads are still in this sequence. Pause or archive it first.",
};

/** Turn anything thrown (Postgres `E_CODE: message`, HttpError, unknown) into an HttpError with the right status. */
export function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const msg = String((e as { message?: unknown })?.message ?? e).trim();
  const m = /^(E_[A-Z_]+)(?::\s*(.*))?$/s.exec(msg);
  if (m) return new HttpError(STATUS[m[1]] ?? 400, m[1], m[2] || DEFAULT_MESSAGE[m[1]] || m[1]);
  // A value that could not be cast (bad uuid / date / enum) is the caller's mistake, not ours.
  if (/invalid input (syntax|value) for/i.test(msg)) return new HttpError(422, "E_PAYLOAD_INVALID", "One of the values has the wrong format (check ids, dates and enum values).");
  const internal = new HttpError(500, "E_INTERNAL", "Something went wrong on our side. Retry, and quote the request_id if it keeps happening.");
  (internal as HttpError & { cause?: unknown }).cause = msg;   // logged, never returned
  return internal;
}

export function errorBody(err: HttpError, requestId: string): Record<string, unknown> {
  return { error: { code: err.code, message: err.message, request_id: requestId, ...(err.details !== undefined ? { details: err.details } : {}) } };
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const text = r.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HttpError(422, "E_PAYLOAD_INVALID", text);
  }
  return r.data;
}

export const id = z.guid();
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
export const bool = z.enum(["true", "false"]).transform((v) => v === "true");
export const paging = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) };

export function pathId(c: C, name = "id"): string {
  return parse(id, c.req.param(name));
}

/** Body of a write. Parsed once by the idempotency middleware in index.ts. */
export function body(c: C): unknown {
  return c.get("body") ?? {};
}

export function ctxOf(c: C): ApiCtx {
  return c.get("ctx");
}

/** `{ data }` envelope for single resources and plain lists. Paginated RPCs already return `{data,total,limit,offset,has_more}`. */
export function ok(c: C, data: unknown, status: 200 | 201 | 202 = 200, extra: Record<string, unknown> = {}): Response {
  return c.json({ data, ...extra }, status);
}

/** Paginated RPCs already return `{data,total,limit,offset,has_more}`; pass that through untouched. */
export function page(c: C, result: unknown): Response {
  return c.json((result ?? {}) as Record<string, never>);
}

/** Drop undefined / empty-string query filters so the SQL side sees only what was asked for. */
export function filters(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== "") out[k] = v;
  return out;
}

/** A key limited to some clients may only name those clients. Returns the client id to use. */
export function scopedClient(ctx: ApiCtx, clientId: string | undefined | null): string | undefined {
  const scope = ctx.key.client_ids ?? [];
  if (clientId && scope.length && !scope.includes(clientId)) throw new HttpError(403, "E_FORBIDDEN", "This key is limited to other clients.");
  return clientId ?? undefined;
}
