// Voice-note transcription (Instagram / WhatsApp inbox, PRD §10). A queued message's audio attachment is downloaded through
// the connector, sent to Gemini generateContent as inline audio, and the transcript is stored on the message. An inbound
// message is then (re)queued for intent classification, whose input is `text || transcript`.
// Model: OUTREACH_AI_MODEL → GEMINI_MODEL_ID → gemini-3-flash-preview; key: GEMINI_API_KEY (the platform key only: audio never goes to a workspace's own provider).
import { admin, log, sha256Hex } from "./supabase.ts";
import { unipile, unipileConfigured, UnipileError } from "./unipile.ts";
import { PLATFORM_MODEL } from "./llm.ts";

type Row = Record<string, any>;

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
const MAX_BYTES = 15 * 1024 * 1024;
export const TRANSCRIBE_PROMPT = "Transcribe this voice note verbatim in its original language. Return only the transcript.";

export type TranscribeOutcome = { status: "done"; transcript: string } | { status: "failed"; reason: string } | { status: "retry"; reason: string };

export function transcribeConfigured(): boolean { return !!GEMINI_KEY; }

function base64Of(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

const MIME_BY_EXT: Record<string, string> = { m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", webm: "audio/webm", wav: "audio/wav", aac: "audio/aac", flac: "audio/flac", amr: "audio/amr" };

function audioMime(attachment: Row, response: Response): string {
  const fromHeader = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (fromHeader.startsWith("audio/")) return fromHeader;
  const declared = String(attachment.mimetype ?? attachment.mime ?? "").toLowerCase();
  if (declared.startsWith("audio/")) return declared;
  const ext = /\.([a-z0-9]{2,5})$/i.exec(String(attachment.name ?? ""))?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || "audio/ogg";
}

/** One Gemini call with inline audio. Returns the transcript text and token counts. */
async function geminiTranscribe(mime: string, data: string): Promise<{ text: string; tokensIn: number | null; tokensOut: number | null }> {
  const model = PLATFORM_MODEL;
  const body = {
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data } }, { text: TRANSCRIBE_PROMPT }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 4096, ...(/gemini-3/i.test(model) ? { thinkingConfig: { thinkingLevel: "LOW" } } : /gemini-2\.5/i.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
  };
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const r = await fetch(GEMINI_URL.replace("{model}", encodeURIComponent(model)), { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
      if ((r.status === 429 || r.status >= 500) && attempt < 2) { lastErr = new Error(`Gemini ${r.status}`); await new Promise((x) => setTimeout(x, 1500 * (attempt + 1))); continue; }
      const txt = await r.text();
      if (!r.ok) throw new Error(`Gemini API returned ${r.status}: ${txt.slice(0, 300)}`);
      const j = JSON.parse(txt);
      const candidate = j.candidates?.[0];
      if (!candidate) throw new Error(`No candidates in Gemini response${j.promptFeedback?.blockReason ? ` (${j.promptFeedback.blockReason})` : ""}`);
      const parts: Array<{ text?: string; thought?: boolean }> = candidate.content?.parts ?? [];
      let text = "";
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i].text && !parts[i].thought) { text = parts[i].text!; break; }
      if (!text) text = parts[0]?.text ?? "";
      const u = j.usageMetadata ?? {};
      return { text: text.trim(), tokensIn: u.promptTokenCount ?? null, tokensOut: u.candidatesTokenCount ?? null };
    } catch (e) {
      lastErr = e;
      if (attempt >= 2 || (e instanceof Error && /returned 4\d\d/.test(e.message) && !/returned 429/.test(e.message))) throw e;
      await new Promise((x) => setTimeout(x, 1500 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("Gemini request failed");
}

/**
 * Transcribe the voice note on one message. Stores transcript / transcript_status on outreach_messages, logs the call
 * in outreach_ai_calls (purpose 'transcribe') and re-queues an inbound message for classification.
 */
export async function transcribeVoiceNote(messageId: string): Promise<TranscribeOutcome> {
  const { data: msg } = await admin.from("outreach_messages").select("id, workspace_id, chat_id, direction, unipile_message_id, attachments, transcript, transcript_status").eq("id", messageId).maybeSingle();
  if (!msg) return { status: "failed", reason: "message_missing" };
  const atts: Row[] = Array.isArray(msg.attachments) ? msg.attachments : [];
  const note = atts.find((a) => a?.voice_note === true) ?? atts.find((a) => String(a?.type ?? "").toLowerCase() === "audio" || String(a?.mimetype ?? "").toLowerCase().startsWith("audio/"));
  const fail = async (reason: string): Promise<TranscribeOutcome> => {
    await admin.from("outreach_messages").update({ transcript_status: "failed" }).eq("id", msg.id);
    log({ fn: "transcribe", message_id: msg.id, failed: reason });
    return { status: "failed", reason };
  };
  if (!note?.id || !msg.unipile_message_id) return fail("no_audio_attachment");
  if (!GEMINI_KEY) return fail("no_gemini_key");
  if (!unipileConfigured()) return { status: "retry", reason: "connector_not_configured" };

  const t0 = Date.now();
  let bytes: Uint8Array;
  let mime: string;
  try {
    const res = await unipile.messages.attachment(msg.unipile_message_id, String(note.id));
    if (!res.ok) {
      if (res.status === 404 || res.status === 410) return fail(`attachment_${res.status}`);
      return { status: "retry", reason: `attachment_${res.status}` };
    }
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) { try { await res.body?.cancel(); } catch { /* ignore */ } return fail("too_large"); }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) return fail("too_large");
    if (!buf.byteLength) return fail("empty_audio");
    bytes = buf;
    mime = audioMime(note, res);
  } catch (e) {
    if (e instanceof UnipileError && (e.status === 404 || e.status === 410 || e.status === 422)) return fail(`attachment_${e.code}`);
    return { status: "retry", reason: String((e as any)?.message ?? e).slice(0, 200) };
  }

  let transcript: string, tokensIn: number | null = null, tokensOut: number | null = null;
  try {
    const r = await geminiTranscribe(mime, base64Of(bytes));
    transcript = r.text; tokensIn = r.tokensIn; tokensOut = r.tokensOut;
  } catch (e) {
    const m = String((e as any)?.message ?? e);
    log({ fn: "transcribe", message_id: msg.id, error: m.slice(0, 300) });
    if (/returned 4\d\d/.test(m) && !/returned 429/.test(m)) return fail("model_rejected");
    return { status: "retry", reason: m.slice(0, 200) };
  }
  if (!transcript) return fail("empty_transcript");
  transcript = transcript.slice(0, 20000);
  await admin.from("outreach_messages").update({ transcript, transcript_status: "done" }).eq("id", msg.id);
  try {
    const [ph, rh] = await Promise.all([sha256Hex(`${TRANSCRIBE_PROMPT}\n[audio ${mime} ${bytes.byteLength} bytes]`), sha256Hex(transcript)]);
    await admin.from("outreach_ai_calls").insert({ workspace_id: msg.workspace_id, purpose: "transcribe", model: PLATFORM_MODEL, prompt_sha256: ph, response_sha256: rh, tokens_in: tokensIn, tokens_out: tokensOut, latency_ms: Date.now() - t0 });
  } catch (e) { log({ fn: "transcribe", warn: `ai_calls insert failed: ${String(e)}` }); }
  if (msg.direction === "in") {
    // the classifier reads text || transcript: queue it now that the transcript exists
    const { error } = await admin.from("outreach_ai_classify_queue").insert({ message_id: msg.id });
    if (error && !String(error.message).includes("duplicate")) log({ fn: "transcribe", warn: `classify queue: ${error.message}` });
  }
  log({ fn: "transcribe", message_id: msg.id, chars: transcript.length, mime, bytes: bytes.byteLength, latency_ms: Date.now() - t0 });
  return { status: "done", transcript };
}
