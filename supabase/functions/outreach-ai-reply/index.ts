// AI replies — HTTP surface (docs/outreach/AI-REPLIES-V2-CONTRACT.md §6).
//
// Signed-in actions (user JWT):
//   draft_now           {chat_id, guidance?, variants?, regenerate?}    member + can_reply: Draft with AI (F38); never sends
//   take_manual         {run_id}                                        member: cancel a scheduled auto send before editing its draft
//   compose_assist      {chat_id, kind, text? | message_id?, language?}    member + can_reply: kind = improve / translate_out / translate_in (F40)
//   send_now            {run_id}                                        member: send a scheduled AI reply now (the recheck still runs)
//   simulate            {workspace_id, sequence_id? | draft_prompt, thread, ...}  manager: full pipeline on a simulated thread; never sends
//   regression_run      {workspace_id, sequence_id? | master_prompt_id?}  manager: re-run the saved test conversations
//   master_prompt_save  {sequence_id, editor_mode, ...}                 manager: save a version of the sequence's prompt
//   ai_replies_set      {sequence_id, patch, note?}                     manager: sequence settings; Auto asks the pool's owners for consent
//   consent_request     {workspace_id, sender_id}                       manager: consent link to the sender's owner (immediate when you own it)
// Public actions (no login; the token is the credential; rate-limited per IP):
//   consent_view / consent_accept {token}   consent_revoke_view / consent_revoke {token}
// Deployed with --no-verify-jwt (public actions + CORS preflight); auth is checked here per action.
import { json, serve, requireUser, readJson, HttpError, rateLimit } from "../_shared/outreach/supabase.ts";
import {
  sendNow, simulate, regressionRun, masterPromptSave, aiRepliesSet, consentRequest, consentView, consentAccept, consentRevokeView, consentRevoke,
  draftNow, takeManual, composeAssist,
} from "../_shared/outreach/ai_reply.ts";

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
    case "draft_now": {
      await rateLimit(`user:${user.id}:ai-draft-now`, 60, 3600);
      return json(await draftNow(user, { chat_id: String(body.chat_id ?? ""), guidance: body.guidance ?? null, variants: Number(body.variants ?? 1), regenerate: !!body.regenerate, via: body.via === "mcp" ? "mcp" : "inbox" }));
    }
    case "take_manual": {
      if (!body.run_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "run_id required");
      return json(await takeManual(user, String(body.run_id)));
    }
    case "compose_assist": {
      await rateLimit(`user:${user.id}:ai-compose`, 60, 3600);
      return json(await composeAssist(user, { chat_id: String(body.chat_id ?? ""), action: body.kind, text: body.text, message_id: body.message_id, language: body.language ?? null }));
    }
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
    case "ai_replies_set": {
      await rateLimit(`user:${user.id}:ai-replies-set`, 30, 600);
      return json(await aiRepliesSet(user, { sequence_id: String(body.sequence_id ?? ""), patch: body.patch ?? {}, note: body.note ?? null }));
    }
    case "consent_request": {
      await rateLimit(`user:${user.id}:ai-consent-request`, 20, 600);
      return json(await consentRequest(user, { workspace_id: String(body.workspace_id ?? ""), sender_id: String(body.sender_id ?? "") }));
    }
    default:
      throw new HttpError(400, "E_PAYLOAD_INVALID", `unknown action ${action}`);
  }
});
