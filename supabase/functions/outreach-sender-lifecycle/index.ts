// F13 — Sender lifecycle (sender-lifecycle-PRD.md §7.1): pause → disable → remove → erase, one function.
//   POST {sender_id, action: 'preview'|'pause'|'resume'|'disable'|'enable'|'remove'|'erase_schedule'|'erase_cancel'|'set_holder'|'send_signin_link'|'holder', reason?, resume_at?, preview_action?, holder?}
//   set_holder {holder: {mine:true} | {user_id} | {email}}  Whose account → Change: a member only (103); links cancelled, grants revoked
//   send_signin_link                           re-sends the holder's sign-in email and resets its reminder count (§5.8.3)
// Roles: manager+ for everything except erase_* (workspace owner). The database functions (migration 096) do the row
// changes as the signed-in user (auth.uid() lands in the events and the audit log); the connector delete, the owner
// email and the account poll after an enable are done here with the service role.
//   remove        → sender_remove_begin, connector DELETE, sender_remove_finish. When the connector does not confirm the
//                   answer is 202 {state:'removal_pending'}: the sender stays disabled and the deletion queue retries.
//   erase_schedule→ the sender is removed first (same as above), then erase_scheduled_at = now() + 24 h.
//   disable       → returns `exited` [{sequence_id, name, lead_ids}] so the app can offer "re-enrol with other senders"
//                   through the normal enrol preview (p_assignment = 'fresh_sender').
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, audit } from "../_shared/outreach/supabase.ts";
import { removeSender, notifyHolderChanged, notifyEraseScheduled } from "../_shared/outreach/lifecycle.ts";
import { resendSignIn } from "../_shared/outreach/alerts.ts";
import { unipile, unipileConfigured } from "../_shared/outreach/unipile.ts";

type Row = Record<string, any>;
const ACTIONS = ["preview", "pause", "resume", "disable", "enable", "remove", "erase_schedule", "erase_cancel", "set_holder", "send_signin_link", "holder"] as const;
type Action = (typeof ACTIONS)[number];

/** A lifecycle RPC called with the user's own JWT, so auth.uid() is the person acting. */
async function userRpc<T = unknown>(user: { client: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> } }, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await user.client.rpc(fn, args);
  if (error) {
    const m = /^(E_[A-Z_]+):?\s*(.*)$/s.exec(error.message.trim());
    if (m) throw new HttpError(m[1] === "E_FORBIDDEN" ? 403 : m[1] === "E_NOT_FOUND" ? 404 : m[1] === "E_ACCOUNT_LIMIT" ? 402 : 409, m[1], m[2] || undefined);
    throw new Error(error.message);
  }
  return data as T;
}

async function fresh(id: string): Promise<Row | null> {
  const { data } = await admin.from("outreach_senders").select("*").eq("id", id).maybeSingle();
  return data ?? null;
}

serve("sender-lifecycle", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ sender_id: string; action: Action; reason?: string | null; resume_at?: string | null; preview_action?: string; holder?: Row }>(req);
  if (!ACTIONS.includes(body.action)) throw new HttpError(400, "E_PAYLOAD_INVALID", `unknown action ${body.action}`);
  const s = await fresh(body.sender_id ?? "");
  if (!s || s.deleted_at) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, s.workspace_id);
  requireRole(m, body.action.startsWith("erase_") ? "owner" : body.action === "preview" || body.action === "holder" || body.action === "set_holder" ? "member" : "manager");
  if (s.provider === "WEBCHAT" && body.action !== "preview") throw new HttpError(400, "E_PAYLOAD_INVALID", "A website inbox is managed from its Website agents page.");

  switch (body.action) {
    case "preview": {
      const act = body.preview_action && ["pause", "resume", "disable", "enable", "remove", "erase"].includes(body.preview_action) ? body.preview_action : "disable";
      return json(await userRpc<Row>(user, "outreach_sender_lifecycle_preview", { p_sender: s.id, p_action: act }));
    }
    case "pause": {
      const at = body.resume_at ? new Date(body.resume_at) : null;
      if (at && Number.isNaN(at.getTime())) throw new HttpError(400, "E_PAYLOAD_INVALID", "resume_at must be a date");
      const r = await userRpc<Row>(user, "outreach_sender_pause", { p_sender: s.id, p_resume_at: at ? at.toISOString() : null });
      return json({ ok: true, ...r, sender: await fresh(s.id) });
    }
    case "resume": {
      const r = await userRpc<Row>(user, "outreach_sender_resume", { p_sender: s.id });
      return json({ ok: true, ...r, sender: await fresh(s.id) });
    }
    case "disable": {
      const r = await userRpc<Row>(user, "outreach_sender_disable", { p_sender: s.id, p_reason: body.reason ?? null });
      return json({ ok: true, ...r, sender: await fresh(s.id) });
    }
    case "enable": {
      const r = await userRpc<Row>(user, "outreach_sender_enable", { p_sender: s.id });
      let state = String(r?.state ?? "ok");
      // the connector may have lost the session while the sender was disabled: read its state once and show the truth
      if (state === "ok" && s.unipile_account_id && unipileConfigured()) {
        try {
          const acc = await unipile.accounts.get(s.unipile_account_id);
          const st = String(acc?.sources?.[0]?.status ?? "OK").toUpperCase();
          if (st !== "OK" && st !== "CONNECTING") {
            await admin.from("outreach_senders").update({ status: st === "CREDENTIALS" ? "credentials" : "error", status_reason: st }).eq("id", s.id);
            state = st === "CREDENTIALS" ? "credentials" : "error";
          }
        } catch { /* the webhook corrects it */ }
      }
      return json({ ok: true, state, sender: await fresh(s.id) });
    }
    case "remove": {
      const r = await removeSender(s.id, "app", { reason: body.reason ?? null, by: user.id });
      if (r.state === "pending") {
        await audit(s.workspace_id, "sender.remove_pending", "sender", s.id, { by: user.id, error: r.error ?? null }, "user");
        return json({ ok: true, state: "removal_pending", error: r.error ?? null, sender: await fresh(s.id) }, 202);
      }
      return json({ ok: true, state: r.state, account_deleted: r.account_deleted, sender: await fresh(s.id) });
    }
    case "erase_schedule": {
      let pending = false;
      if (s.status !== "removed") {
        const r = await removeSender(s.id, "app", { reason: "erase", by: user.id });
        pending = r.state === "pending";
      }
      const r = await userRpc<Row>(user, "outreach_sender_erase_schedule", { p_sender: s.id });
      if (r?.erase_scheduled_at) await notifyEraseScheduled(s.id, String(r.erase_scheduled_at)).catch(() => null);
      return json({ ok: true, ...r, removal_pending: pending, sender: await fresh(s.id) }, pending ? 202 : 200);
    }
    case "erase_cancel": {
      const r = await userRpc<Row>(user, "outreach_sender_erase_cancel", { p_sender: s.id });
      return json({ ok: true, ...r, sender: await fresh(s.id) });
    }
    case "holder": return json(await userRpc<Row>(user, "outreach_sender_holder_view", { p_sender: s.id }));
    case "set_holder": {
      const h = body.holder && typeof body.holder === "object" ? body.holder : null;
      if (!h || (!h.mine && !h.user_id && !h.email)) throw new HttpError(400, "E_PAYLOAD_INVALID", "holder must be {mine: true}, {user_id} or {email}");
      // the database enforces who may change it (manager+, or the member who holds it) and that Mine is only for yourself
      const r = await userRpc<Row>(user, "outreach_sender_set_holder", { p_sender: s.id, p_holder: h.mine ? { mine: true } : h.user_id ? { user_id: String(h.user_id) } : { email: String(h.email) } });
      if (r?.changed) await notifyHolderChanged(s.id, r, user.id).catch((e) => audit(s.workspace_id, "notify.sender_holder_changed_failed", "sender", s.id, { error: String(e) }, "system"));
      return json({ ok: true, ...r, view: await userRpc<Row>(user, "outreach_sender_holder_view", { p_sender: s.id }) });
    }
    case "send_signin_link": {
      if (!["credentials", "error"].includes(String(s.status))) throw new HttpError(409, "E_SENDER_NOT_OK", "This sender is not signed out");
      const r = await resendSignIn(s.id);
      await audit(s.workspace_id, "sender.signin_link_resent", "sender", s.id, { to: r.to, by: user.id }, "user");
      return json({ ok: true, ...r, sender: await fresh(s.id) });
    }
  }
  throw new HttpError(400, "E_PAYLOAD_INVALID", `unknown action ${body.action}`);
});
