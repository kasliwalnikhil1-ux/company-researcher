// Sender management actions (manager+): set_cookie (pasted li_at), resync, reconnect_link (credentials mode), checkpoint (OTP), refresh_profile, recompute_health, plan_now,
// and the channel actions attest_account_age {months} (WhatsApp), resume_after_warning (Instagram provider warning), check_identifiers (WhatsApp numbers).
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, audit, rateLimit } from "../_shared/outreach/supabase.ts";
import { encrypt } from "../_shared/outreach/crypto.ts";
import { unipile, unipileConfigured } from "../_shared/outreach/unipile.ts";
import { reconnectLink, syncOwnProfile, applyOnboardingGate, backfillChats, resolveChatNames } from "../_shared/outreach/inbound.ts";
import { healthForSender } from "../_shared/outreach/health.ts";
import { planSender } from "../_shared/outreach/planner.ts";
import { reconnectSender } from "../_shared/outreach/workers.ts";
import { runIdentifierCheck } from "../_shared/outreach/channel_workers.ts";

/** A manager RPC called with the user's own JWT so the function sees auth.uid() (attestation / resume are audited as that person). */
async function userRpc<T = unknown>(user: { client: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> } }, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await user.client.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

serve("sender-manage", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ sender_id: string; action: string; code?: string; li_at?: string; li_a?: string; user_agent?: string; months?: number }>(req);
  const { data: s } = await admin.from("outreach_senders").select("*").eq("id", body.sender_id ?? "").maybeSingle();
  if (!s) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, s.workspace_id);
  requireRole(m, "manager");
  switch (body.action) {
    case "reconnect_link": {
      if (!unipileConfigured()) throw new HttpError(503, "E_NOT_CONFIGURED", "Account connection is not configured on this deployment");
      const link = await reconnectLink(s);
      await audit(s.workspace_id, "sender.reconnect_link", "sender", s.id, null, "user");
      return json({ link });
    }
    case "reconnect_cookie": {
      const r = await reconnectSender(s);
      return json(r);
    }
    case "set_cookie": {
      // Manual alternative to the extension: a pasted li_at (e.g. copied with a cookie editor or DevTools).
      if (s.provider !== "LINKEDIN") throw new HttpError(400, "E_PAYLOAD_INVALID", "session cookies apply to LinkedIn senders only");
      const { data: ws } = await admin.from("outreach_workspaces").select("settings").eq("id", s.workspace_id).single();
      if (ws?.settings?.cookie_mode_opt_in === false) throw new HttpError(403, "E_FORBIDDEN", "Cookie mode is switched off for this workspace");
      await rateLimit(`cookie-paste:${s.id}`, 5, 600);
      const clean = (v?: string) => (v ?? "").trim().replace(/^li_(at|a)\s*=\s*/i, "").replace(/^"|"$/g, "").replace(/;.*$/, "").trim();
      const li_at = clean(body.li_at), li_a = clean(body.li_a), ua = (body.user_agent ?? "").trim();
      if (!/^[^\s;",]{60,}$/.test(li_at)) throw new HttpError(400, "E_PAYLOAD_INVALID", "That does not look like a LinkedIn li_at cookie value");
      if (li_a && !/^[^\s;",]{20,}$/.test(li_a)) throw new HttpError(400, "E_PAYLOAD_INVALID", "That does not look like a LinkedIn li_a cookie value");
      if (ua.length < 20) throw new HttpError(400, "E_PAYLOAD_INVALID", "user_agent required");
      await admin.from("outreach_sender_secrets").upsert({ sender_id: s.id, li_at_enc: await encrypt(li_at), li_a_enc: li_a ? await encrypt(li_a) : null, cookie_captured_at: new Date().toISOString(), cookie_ip: null, cookie_user_agent: ua, updated_at: new Date().toISOString() });
      await admin.from("outreach_secret_access_log").insert({ sender_id: s.id, fn: "cookie-paste:write" });
      const patch: Record<string, unknown> = { user_agent: ua };
      if (s.auth_method === "credentials") patch.auth_method = "cookie";
      await admin.from("outreach_senders").update(patch).eq("id", s.id);
      await audit(s.workspace_id, "sender.cookie_pasted", "sender", s.id, null, "user");
      let reconnect: unknown = null;
      if (s.status === "credentials" && s.unipile_account_id) reconnect = await reconnectSender({ ...s, ...patch });
      return json({ ok: true, reconnect });
    }
    case "resync": {
      if (!s.unipile_account_id) throw new HttpError(400, "E_SENDER_NOT_OK");
      await unipile.accounts.resync(s.unipile_account_id);
      await audit(s.workspace_id, "sender.resync", "sender", s.id, null, "user");
      return json({ ok: true });
    }
    case "checkpoint": {
      if (!s.unipile_account_id || !body.code) throw new HttpError(400, "E_PAYLOAD_INVALID", "code required");
      const r = await unipile.accounts.solveCheckpoint({ provider: "LINKEDIN", account_id: s.unipile_account_id, code: body.code });
      await admin.from("outreach_sender_events").insert({ sender_id: s.id, kind: "checkpoint", data: { solved: true } });
      return json({ ok: true, result: r });
    }
    case "refresh_profile": {
      const fresh = await syncOwnProfile(s);
      await applyOnboardingGate(fresh);
      return json({ ok: true, sender: fresh });
    }
    case "backfill_inbox": {
      const n = await backfillChats(s, 5);
      return json({ ok: true, inserted: n });
    }
    case "resolve_chat_names": {
      return json({ ok: true, ...(await resolveChatNames(s, 100)) });
    }
    case "recompute_health": {
      const h = await healthForSender(s.id, "nightly");
      return json({ ok: true, ...h });
    }
    case "plan_now": {
      const r = await planSender(s, "topup");
      return json({ ok: true, ...r });
    }
    case "account_status": {
      if (!s.unipile_account_id) return json({ status: null });
      const acc = await unipile.accounts.get(s.unipile_account_id);
      return json({ status: acc?.sources?.map((x: any) => x.status) ?? null, connection_method: acc?.connection_params?.im?.connection_method ?? null });
    }
    case "attest_account_age": {
      // WhatsApp: the manager attests the number's age (≥ 6 months of real use). The RPC validates, stores and audits as auth.uid().
      if (s.provider !== "WHATSAPP") throw new HttpError(400, "E_PAYLOAD_INVALID", "account age attestation applies to WhatsApp numbers only");
      const months = Number(body.months);
      if (!Number.isFinite(months) || months < 0) throw new HttpError(400, "E_PAYLOAD_INVALID", "months required");
      await userRpc(user, "outreach_sender_attest_account_age", { p_sender: s.id, p_months: Math.floor(months) });
      const { data: fresh } = await admin.from("outreach_senders").select("*").eq("id", s.id).single();
      return json({ ok: true, sender: fresh });
    }
    case "resume_after_warning": {
      // Instagram provider warning: the manager confirmed "resume anyway"; the RPC clears the pause and audits as auth.uid()
      await userRpc(user, "outreach_sender_resume_after_warning", { p_sender: s.id });
      const { data: fresh } = await admin.from("outreach_senders").select("*").eq("id", s.id).single();
      return json({ ok: true, sender: fresh });
    }
    case "check_identifiers": {
      if (s.provider !== "WHATSAPP") throw new HttpError(400, "E_PAYLOAD_INVALID", "identifier checks apply to WhatsApp numbers only");
      if (!unipileConfigured() || !s.unipile_account_id) throw new HttpError(409, "E_SENDER_NOT_OK", "this number is not connected");
      await rateLimit(`check-identifiers:${s.id}`, 6, 600);
      const r = await runIdentifierCheck(s.id);
      await audit(s.workspace_id, "sender.check_identifiers", "sender", s.id, r, "user");
      return json({ ok: true, ...r });
    }
    default:
      throw new HttpError(400, "E_PAYLOAD_INVALID", `unknown action ${body.action}`);
  }
});
