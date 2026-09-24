// Sender management actions (manager+): resync, reconnect_link (credentials mode), checkpoint (OTP), refresh_profile, recompute_health, plan_now.
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, audit } from "../_shared/outreach/supabase.ts";
import { unipile, unipileConfigured } from "../_shared/outreach/unipile.ts";
import { reconnectLink, syncOwnProfile, applyOnboardingGate, backfillChats, resolveChatNames } from "../_shared/outreach/inbound.ts";
import { healthForSender } from "../_shared/outreach/health.ts";
import { planSender } from "../_shared/outreach/planner.ts";
import { reconnectSender } from "../_shared/outreach/workers.ts";

serve("sender-manage", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ sender_id: string; action: string; code?: string }>(req);
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
    default:
      throw new HttpError(400, "E_PAYLOAD_INVALID", `unknown action ${body.action}`);
  }
});
