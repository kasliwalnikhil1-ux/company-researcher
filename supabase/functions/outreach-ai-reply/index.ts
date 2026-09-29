// AI replies — HTTP surface (ai-auto-reply-PRD.md §4, §7.2, §13.2; docs/outreach/AI-REPLIES-CONTRACT.md §4).
//
// Signed-in actions (user JWT):
//   send_now            {run_id}                                   member: send a scheduled AI reply now (the §7.3 recheck still runs)
//   simulate            {workspace_id, thread, ...}                manager: full pipeline on a simulated thread; never sends, never writes runs
//   regression_run      {workspace_id, master_prompt_id? | scope}  manager: re-run the saved scenarios
//   master_prompt_save  {workspace_id, scope, ...}                 manager: save a version; substantive changes re-request owner consent
//   consent_request     {workspace_id, sender_id, master_prompt_id}  manager: signed link to the sender's owner (or immediate when you own it)
// Public actions (no login; the token is the credential; rate-limited per IP):
//   consent_view / consent_accept {token}   consent_revoke_view / consent_revoke {token}
// Deployed with --no-verify-jwt (public actions + CORS preflight); auth is checked here per action.
import { json, serve, requireUser, readJson, HttpError, rateLimit } from "../_shared/outreach/supabase.ts";
import { sendNow, simulate, regressionRun, masterPromptSave, consentRequest, consentView, consentAccept, consentRevokeView, consentRevoke } from "../_shared/outreach/ai_reply.ts";

type Row = Record<string, any>;
const PUBLIC = new Set(["consent_view", "consent_accept", "consent_revoke_view", "consent_revoke"]);

function evidence(req: Request): Row {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  return { ip, user_agent: (req.headers.get("user-agent") ?? "").slice(0, 300), at: new Date().toISOString() };
}

serve("ai-reply", async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "E_METHOD", "POST only");
  const body = await readJson<Row>(req);
  const action = String(body.action ?? "");
  if (PUBLIC.has(action)) {
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    await rateLimit(`ip:${ip}:ai-consent`, 30, 600);
    const token = String(body.token ?? "");
    if (!/^[a-f0-9]{48}$/.test(token)) throw new HttpError(404, "E_NOT_FOUND", "this link is not valid");
    switch (action) {
      case "consent_view": return json(await consentView(token));
      case "consent_accept": return json(await consentAccept(token, evidence(req)));
      case "consent_revoke_view": return json(await consentRevokeView(token));
      case "consent_revoke": return json(await consentRevoke(token, evidence(req)));
    }
  }
  const user = await requireUser(req);
  switch (action) {
    case "send_now": {
      await rateLimit(`user:${user.id}:ai-send-now`, 30, 60);
      if (!body.run_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "run_id required");
      return json({ ok: true, ...(await sendNow(user, String(body.run_id))) });
    }
    case "simulate": {
      await rateLimit(`user:${user.id}:ai-simulate`, 30, 60);
      return json(await simulate(user, body as any));
    }
    case "regression_run": {
      await rateLimit(`user:${user.id}:ai-regression`, 6, 600);
      return json(await regressionRun(user, body as any));
    }
    case "master_prompt_save": {
      await rateLimit(`user:${user.id}:ai-prompt-save`, 20, 600);
      return json(await masterPromptSave(user, body));
    }
    case "consent_request": {
      await rateLimit(`user:${user.id}:ai-consent-request`, 20, 600);
      const r = await consentRequest(user, { workspace_id: String(body.workspace_id ?? ""), sender_id: String(body.sender_id ?? ""), master_prompt_id: String(body.master_prompt_id ?? "") });
      return json(r);
    }
    default:
      throw new HttpError(400, "E_PAYLOAD_INVALID", `unknown action ${action}`);
  }
});
