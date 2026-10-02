// outreach-elevenlabs-webhook — the voice provider's post-call webhook (web-chat-voice-elevenlabs-PRD.md §7.2).
// PUBLIC (deployed --no-verify-jwt). Every request is verified here before anything is read from it:
//   ElevenLabs-Signature: t=<unix>,v0=<hex>   HMAC-SHA256 of "<t>.<raw body>" with the webhook's secret, 30 minutes of tolerance.
//   The secret is the platform's (OUTREACH_ELEVENLABS_WEBHOOK_SECRET, printed once by scripts/outreach-elevenlabs-setup.mjs)
//   or, for a call on a workspace's own voice account, the secret of the webhook we created in that account.
// A bad signature → 401. An unknown conversation → 200 and dropped (the provider must not retry it for ever).
//
// post_call_transcription → outreach_webchat_v_voice_finalize: the signed transcript replaces the live copy in one
// transaction, the call row gets its duration, cost, summary and collected details. A second delivery is a no-op.
// The worker fetches the same data for a call whose webhook never arrived (outreach-webchat-worker, mode "voice").
import { admin, HttpError, json, log, serve } from "../_shared/outreach/supabase.ts";
import { decrypt } from "../_shared/outreach/crypto.ts";
import { verifyElSignature } from "../_shared/outreach/elevenlabs.ts";
import { finalizeCall } from "../_shared/outreach/voice.ts";

const FN = "outreach-elevenlabs-webhook";
const PLATFORM_SECRET = Deno.env.get("OUTREACH_ELEVENLABS_WEBHOOK_SECRET") ?? "";
const MAX_BYTES = 8 * 1024 * 1024;

/** The secret of the webhook in a workspace's own voice account, when this conversation is one of its calls. */
async function workspaceSecret(conversationId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(conversationId)) return null;
  const { data: call } = await admin.from("outreach_webchat_voice_calls").select("workspace_id, account").eq("el_conversation_id", conversationId).maybeSingle();
  if (!call || call.account !== "own") return null;
  const { data: sec } = await admin.from("outreach_workspace_secrets").select("elevenlabs_webhook_secret_enc").eq("workspace_id", call.workspace_id).maybeSingle();
  if (!sec?.elevenlabs_webhook_secret_enc) return null;
  try { return await decrypt(sec.elevenlabs_webhook_secret_enc); } catch { return null; }
}

serve(FN, async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "E_PAYLOAD_INVALID", "POST only");
  const raw = await req.text();
  if (raw.length > MAX_BYTES) throw new HttpError(413, "E_TOO_LARGE", "");
  const sig = req.headers.get("elevenlabs-signature");
  // read the conversation id only to pick the secret: nothing is trusted or stored before the signature checks out
  let evt: any = null;
  try { evt = JSON.parse(raw); } catch { /* answered below, after the signature */ }
  const conversationId = String(evt?.data?.conversation_id ?? "");
  let ok = !!PLATFORM_SECRET && await verifyElSignature(raw, sig, PLATFORM_SECRET);
  if (!ok && conversationId) { const own = await workspaceSecret(conversationId); ok = !!own && await verifyElSignature(raw, sig, own); }
  if (!ok) { log({ fn: FN, warn: "signature rejected", has_header: !!sig }); throw new HttpError(401, "E_FORBIDDEN", ""); }
  if (!evt || typeof evt !== "object") throw new HttpError(400, "E_PAYLOAD_INVALID", "not JSON");

  const type = String(evt.type ?? "");
  if (type !== "post_call_transcription") return json({ ok: true, ignored: type || "unknown" });   // audio and call-failure events are not used
  if (!conversationId) return json({ ok: true, ignored: "no conversation id" });
  const r = await finalizeCall(conversationId, evt.data);
  if (!r?.ok) { log({ fn: FN, warn: "unknown conversation", conversation: conversationId, agent: evt.data?.agent_id ?? null }); return json({ ok: true, ignored: "unknown conversation" }); }
  log({ fn: FN, call: r.call_id, duplicate: !!r.duplicate, test: !!r.test, turns: r.turns ?? null });
  return json({ ok: true, duplicate: !!r.duplicate });
});
