// Pure error-mapping table: UnipileError + context → Decision (PRD §9.2 / FR-AC-07).
import { UnipileError } from "./unipile.ts";
import { localParts, zonedToUtc, addDays, rand } from "./supabase.ts";

export type Decision =
  | { kind: "retry"; at: Date; reason: string }
  | { kind: "skip_node"; reason: string }
  | { kind: "fail_enrollment"; reason: string }
  | { kind: "mark_lead_invalid"; reason: string }
  | { kind: "sender_cap_hit"; type: "invite"; until: Date; reason: string }
  | { kind: "sender_pause"; hours: number; reason: string }
  | { kind: "sender_credentials"; reason: string }
  | { kind: "branch"; name: string; reason: string }
  // clean exits, not failures: fail_action maps them to exited_replied / exited_suppressed and records no sender reject
  | { kind: "replied"; reason: string }
  | { kind: "suppressed"; reason: string };

export interface ErrorCtx {
  actionType: string;
  attempt: number;
  senderTimezone: string;
  hasBranch: (name: string) => boolean;
}

function nextMondayLocal(tz: string): Date {
  const lp = localParts(tz);
  const dow = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(lp.weekday);
  const daysUntil = ((8 - dow) % 7) || 7;
  return zonedToUtc(addDays(lp.date, daysUntil), "00:05", tz);
}

export function handleUnipileError(err: unknown, ctx: ErrorCtx): Decision {
  const e = err instanceof UnipileError ? err : new UnipileError(0, "errors/network", String((err as any)?.message ?? err), null, true);
  const code = e.code;
  const reason = `${e.status || "net"}:${code}`;

  if (e.network || e.status === 0) {
    if (ctx.attempt >= 3) return { kind: "fail_enrollment", reason: "network_timeout_max" };
    return { kind: "retry", at: new Date(Date.now() + 10 * 60_000), reason };
  }

  if (e.status === 422) {
    switch (code) {
      case "cannot_resend_yet":
      case "connection_limit_reached":
      case "limit_exceeded":
        if (ctx.actionType === "invite") return { kind: "sender_cap_hit", type: "invite", until: nextMondayLocal(ctx.senderTimezone), reason };
        return { kind: "retry", at: new Date(Date.now() + rand(6, 12) * 3_600_000), reason };
      case "cannot_resend_within_24hrs":
      case "already_invited_recently":
        return { kind: "skip_node", reason };
      case "already_connected":
        return ctx.hasBranch("connected") ? { kind: "branch", name: "connected", reason } : { kind: "skip_node", reason };
      case "insufficient_credits":
      case "not_allowed_inmail":
      case "payment_error":
        return ctx.hasBranch("no_credit") ? { kind: "branch", name: "no_credit", reason } : { kind: "skip_node", reason };
      case "no_connection_with_recipient":
        return ctx.hasBranch("not_connected") ? { kind: "branch", name: "not_connected", reason } : { kind: "skip_node", reason };
      case "invalid_recipient":
      case "user_unreachable":
      case "blocked_recipient":
      case "cannot_invite_attendee":
      case "invalid_account":
        return { kind: "mark_lead_invalid", reason };
      case "action_already_performed":
      case "comments_disabled":
      case "invalid_post":
        return { kind: "skip_node", reason };
      case "recipient_rejected":
      case "sender_rejected":
        return ctx.hasBranch("bounced") ? { kind: "branch", name: "bounced", reason } : { kind: "skip_node", reason };
      case "provider_unreachable":
      case "realtime_client_not_initialized":
        return { kind: "retry", at: new Date(Date.now() + rand(15, 45) * 60_000), reason };
      default:
        return { kind: "skip_node", reason };
    }
  }
  if (e.status === 404) {
    if (ctx.actionType === "profile_view" || ctx.actionType === "invite" || ctx.actionType === "message" || ctx.actionType === "inmail") return { kind: "mark_lead_invalid", reason };
    return { kind: "skip_node", reason };
  }
  if (e.status === 429) return { kind: "retry", at: new Date(Date.now() + rand(30, 90) * 60_000), reason };
  if (e.status >= 500) return { kind: "retry", at: new Date(Date.now() + rand(15, 45) * 60_000), reason };
  if (e.status === 401) return { kind: "sender_credentials", reason };
  if (e.status === 403) {
    if (code === "account_restricted" || code === "session_mismatch" || code === "account_mismatch") return { kind: "sender_pause", hours: 24, reason };
    if (code === "feature_not_subscribed" || code === "subscription_required" || code === "insufficient_permissions" || code === "resource_access_restricted") {
      if (ctx.actionType === "inmail" && ctx.hasBranch("no_credit")) return { kind: "branch", name: "no_credit", reason };
      return { kind: "skip_node", reason };
    }
    return { kind: "sender_pause", hours: 24, reason };
  }
  if (e.status === 400) return { kind: "fail_enrollment", reason: `payload_invalid:${code}` };
  if (e.status === 407 || e.status === 502) return { kind: "retry", at: new Date(Date.now() + rand(15, 45) * 60_000), reason: `proxy:${code}` };
  return { kind: "retry", at: new Date(Date.now() + 30 * 60_000), reason };
}

/** Whether the decision should count as a rejection for rejects_1h / pause rule (429/500 family). */
export function isRejectCode(err: unknown): boolean {
  if (!(err instanceof UnipileError)) return false;
  return err.status === 429 || (err.status >= 500 && err.status < 600);
}
