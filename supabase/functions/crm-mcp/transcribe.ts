// crm-mcp/transcribe.ts — transcribe a call recording on the server (Deepgram nova-3, speaker-diarized) and save it
// against its meeting. For every client that cannot run the get-transcript skill + save_transcript.py locally:
// ChatGPT, web chats without a sandbox, and the /crm app's own upload button.
//
// It builds the same payload save_transcript.py posts — consecutive utterances of one voice merged into turns of at
// most 900 characters, each carrying the transcriber's word timings ("w": one [start, end] per whitespace token) — so
// a transcript made here reads, searches and plays exactly like one made by the skill. It is saved through
// crm_save_transcript as the calling member (RLS applies); speaker roles start as unknown and are named afterwards
// (set_transcript_speakers), because only a reader of the conversation can tell the prospect from us.
//
// Deepgram fetches the media itself from a URL (a presigned GET for stored audio / a temporary upload, or a direct link
// the user gave), so no audio passes through this function.
import { type Ctx, McpError, rpc, log } from "./ctx.ts";
import { GET_EXPIRES_S, deleteObject, headObject, signedUrl } from "./storage.ts";

type Row = Record<string, any>;

const DEEPGRAM_KEY = Deno.env.get("DEEPGRAM_API") ?? Deno.env.get("DEEPGRAM_API_KEY") ?? "";   // the project secret is DEEPGRAM_API
const MODEL = "nova-3";
const MAX_TURN_CHARS = 900;       // same as save_transcript.py
const LOW_CONFIDENCE = 0.6;       // same as get-transcript's low_confidence_words

export const transcriptionConfigured = () => !!DEEPGRAM_KEY;

export interface TranscribeOptions {
  keyterms?: string[];
  speakers?: number;
  language?: string;
}

export interface MediaSource {
  url: string;
  /** What to record as the transcript's source (file name or the link the user gave — never a presigned URL). */
  label: string;
  /** A temporary upload to delete once transcribed. */
  tempKey?: string;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Share links that are not the file itself → their direct-download form, where one exists. */
export function directLink(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new McpError("E_PAYLOAD_INVALID", "url is not a valid link", "Pass a direct link to the audio or video file, or upload it with recording_upload_link."); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new McpError("E_PAYLOAD_INVALID", "url must be http(s)");
  const host = u.hostname.replace(/^www\./, "");
  if (host === "drive.google.com") {
    const id = /\/file\/d\/([^/]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get("id");
    if (id) return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
  }
  if (host === "dropbox.com" || host.endsWith(".dropbox.com")) { u.searchParams.set("dl", "1"); return u.toString(); }
  if (/(^|\.)(loom\.com|zoom\.us|meet\.google\.com|youtube\.com|youtu\.be|vimeo\.com)$/.test(host)) {
    throw new McpError("E_PAYLOAD_INVALID", `${host} links are web pages, not the recording file, so the server cannot fetch them.`,
      "Call recording_upload_link and ask the user to download the recording from that service and drop it on the meeting in the app.");
  }
  return u.toString();
}

/** The meeting's stored call audio, as a URL Deepgram can fetch. */
export async function storedRecording(ctx: Ctx, meetingId: string): Promise<MediaSource> {
  let rec: Row;
  try { rec = await rpc<Row>(ctx, "get_recording", { p_meeting_id: meetingId }); }
  catch (e) {
    if (/E_NOT_FOUND/.test(String((e as Error).message))) {
      throw new McpError("E_NOT_FOUND", "This meeting has no stored recording.", "Pass url (a direct link to the file) or file, or call recording_upload_link and ask the user to upload it in the app.");
    }
    throw e;
  }
  return { url: await signedUrl("GET", rec.storage_key, GET_EXPIRES_S), label: rec.original_name ?? "call audio stored in the CRM" };
}

/** A temporary upload of this meeting (crm/tmp/<meeting>/…), deleted after transcription. */
export async function tempUpload(meetingId: string, key: string, filename?: string): Promise<MediaSource> {
  if (!key.startsWith(`crm/tmp/${meetingId}/`) || key.includes("..")) throw new McpError("E_PAYLOAD_INVALID", "key does not belong to this meeting");
  if (!(await headObject(key))) throw new McpError("E_PAYLOAD_INVALID", "The upload did not arrive in storage — PUT the file to put_url first.");
  return { url: await signedUrl("GET", key, GET_EXPIRES_S), label: filename ?? "uploaded recording", tempKey: key };
}

// ---------------------------------------------------------------------------
// Deepgram
// ---------------------------------------------------------------------------

const keyterms = (terms: string[] | undefined) => {
  const seen = new Set<string>(), out: string[] = [];
  for (const t of terms ?? []) {
    const v = (t ?? "").trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase()); out.push(v.replace(/ /g, "+"));   // Keyterm Prompting binds a multi-word phrase with '+'
    if (out.length >= 100) break;
  }
  return out;
};

async function listen(url: string, o: TranscribeOptions): Promise<{ resp: Row; params: URLSearchParams }> {
  const core: [string, string][] = [["model", MODEL], ["smart_format", "true"], ["punctuate", "true"], ["paragraphs", "true"], ["utterances", "true"], ["diarize", "true"]];
  core.push(o.language ? ["language", o.language] : ["detect_language", "true"]);
  const extra: [string, string][] = [["utt_split", "0.8"], ...keyterms(o.keyterms).map((k): [string, string] => ["keyterm", k])];
  if (o.speakers) extra.push(["diarize_speaker_count", String(o.speakers)]);
  const intel: [string, string][] = (o.language ?? "en").startsWith("en") ? [["summarize", "v2"], ["topics", "true"]] : [];   // English-only features

  // degrade rather than fail, like get-transcript: full → without intelligence → core
  const ladders = [[...core, ...extra, ...intel], [...core, ...extra], core].filter((l, i, all) => i === 0 || l.length !== all[i - 1].length);
  let last = "";
  for (const attempt of ladders) {
    const params = new URLSearchParams(attempt);
    const r = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST", headers: { Authorization: `Token ${DEEPGRAM_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url }), signal: AbortSignal.timeout(280_000),
    });
    if (r.ok) return { resp: await r.json(), params };
    const body = await r.text();
    last = `${r.status} ${body.slice(0, 300)}`;
    // the media could not be fetched or decoded, or the key is bad — a smaller option set will not help
    if (/REMOTE_CONTENT|Could not determine|unsupported|corrupt|no audio/i.test(body) || r.status === 401 || r.status === 402 || r.status === 403) break;
  }
  if (/REMOTE_CONTENT/i.test(last)) throw new McpError("E_PAYLOAD_INVALID", `The transcriber could not download the recording (${last.slice(0, 160)}).`, "The link must be a direct, public download of the file. Otherwise call recording_upload_link and have the user upload it in the app.");
  if (/Could not determine|unsupported|corrupt|no audio/i.test(last)) throw new McpError("E_PAYLOAD_INVALID", `That file has no audio the transcriber can read (${last.slice(0, 160)}).`, "Ask the user for the audio or video file of the call itself.");
  throw new McpError("E_TRANSCRIPTION_FAILED", `Deepgram refused the request: ${last}`, "Tell the user the transcription service failed; do not guess what was said.");
}

// ---------------------------------------------------------------------------
// Response → save_transcript payload (a port of save_transcript.py)
// ---------------------------------------------------------------------------

interface Word { text: string; start: number; end: number }
interface Turn { speaker: number | null; start: number | null; end: number | null; text: string; _words: Word[]; w?: [number, number][] }

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const norm = (t: string | undefined) => (t ?? "").replace(/[\W_]+/gu, "").toLowerCase();

function mergeTurns(resp: Row): Turn[] {
  const turns: Turn[] = [];
  for (const u of (resp.results?.utterances ?? []) as Row[]) {
    const text = String(u.transcript ?? "").trim();
    if (!text) continue;
    const words: Word[] = ((u.words ?? []) as Row[]).map((w) => ({ text: w.punctuated_word ?? w.word, start: w.start, end: w.end }));
    const last = turns[turns.length - 1];
    const speaker = typeof u.speaker === "number" ? u.speaker : null;
    if (last && last.speaker === speaker && last.text.length + text.length + 1 <= MAX_TURN_CHARS) {
      last.text += " " + text; last.end = num(u.end) ?? last.end; last._words.push(...words);
    } else {
      turns.push({ speaker, start: num(u.start), end: num(u.end), text, _words: words });
    }
  }
  return turns;
}

/** One [start, end] per whitespace token of the turn's text — the app highlights and seeks by word. */
function wordTimes(t: Turn): [number, number][] | undefined {
  const words = t._words.filter((w) => typeof w.start === "number");
  const tokens = t.text.split(/\s+/).filter(Boolean);
  if (!words.length || !tokens.length) return undefined;
  const pair = (w: Word): [number, number] => [num(w.start)!, num(typeof w.end === "number" ? w.end : w.start)!];
  if (words.length === tokens.length && tokens.filter((tok, i) => norm(tok) === norm(words[i].text)).length >= 0.9 * tokens.length) return words.map(pair);
  const out: ([number, number] | null)[] = tokens.map(() => null);
  let j = 0;
  tokens.forEach((tok, i) => {
    const key = norm(tok);
    for (let k = j; k < Math.min(j + 6, words.length); k++) {
      const wk = norm(words[k].text);
      if (key && wk && (key === wk || key.startsWith(wk) || wk.startsWith(key))) { out[i] = pair(words[k]); j = k + 1; break; }
    }
  });
  const known = out.flatMap((x, i) => (x ? [i] : []));
  if (!known.length) return undefined;
  const start = t.start ?? 0, end = t.end ?? start;
  return out.map((x, i) => {
    if (x) return x;
    const before = known.filter((k) => k < i).pop(), after = known.find((k) => k > i);
    const a = before !== undefined ? out[before]![1] : start;
    const b = after !== undefined ? out[after]![0] : Math.max(end, a);
    const lo = before ?? -1, hi = after ?? tokens.length;
    const v = num(a + ((b - a) * (i - lo)) / (hi - lo))!;
    return [v, v];
  });
}

function buildPayload(resp: Row, params: URLSearchParams, label: string): Row {
  const turns = mergeTurns(resp);
  if (!turns.length) throw new McpError("E_PAYLOAD_INVALID", "The recording has no speech the transcriber could hear.", "Check it is the right file; a silent or music-only file cannot be captured.");
  for (const t of turns) { const w = wordTimes(t); if (w) t.w = w; }

  const ch0 = resp.results?.channels?.[0] ?? {};
  const words: Row[] = (ch0.alternatives?.[0]?.words ?? []) as Row[];
  const confs = words.map((w) => w.confidence).filter((c) => typeof c === "number") as number[];
  const stats = new Map<number, { words: number; seconds: number }>();
  for (const w of words) {
    if (typeof w.speaker !== "number") continue;
    const s = stats.get(w.speaker) ?? { words: 0, seconds: 0 };
    s.words += 1; if (typeof w.start === "number" && typeof w.end === "number") s.seconds += Math.max(0, w.end - w.start);
    stats.set(w.speaker, s);
  }
  const total = [...stats.values()].reduce((a, s) => a + s.words, 0) || 1;
  const speakers = [...stats.entries()].sort((a, b) => a[0] - b[0]).map(([i, s]) => ({
    speaker: i, label: `Speaker ${i + 1}`, role: "unknown", words: s.words, share_of_words: Math.round((s.words / total) * 1000) / 1000, speaking_seconds: num(s.seconds),
  }));
  const topics = new Map<string, number>();
  for (const seg of (resp.results?.topics?.segments ?? []) as Row[]) for (const t of (seg.topics ?? []) as Row[]) topics.set(t.topic, Math.max(topics.get(t.topic) ?? 0, t.confidence_score ?? 0));

  const payload: Row = {
    turns: turns.map(({ _words, ...t }) => t), speakers,
    summary: resp.results?.summary?.short,
    topics: [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k),
    language: ch0.detected_language ?? params.get("language") ?? undefined,
    duration_seconds: num(resp.metadata?.duration), word_count: words.length,
    avg_confidence: confs.length ? Math.round((confs.reduce((a, c) => a + c, 0) / confs.length) * 10000) / 10000 : undefined,
    low_confidence: words.filter((w) => typeof w.confidence === "number" && w.confidence < LOW_CONFIDENCE).sort((a, b) => a.confidence - b.confidence).slice(0, 50)
      .map((w) => ({ word: w.punctuated_word ?? w.word, start: num(w.start), confidence: Math.round(w.confidence * 1000) / 1000 })),
    source: label.slice(0, 500), engine: "deepgram", model: resp.metadata?.model_info ? (Object.values(resp.metadata.model_info)[0] as Row)?.name ?? MODEL : MODEL,
  };
  for (const k of Object.keys(payload)) if (payload[k] == null || (Array.isArray(payload[k]) && !payload[k].length)) delete payload[k];
  return payload;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Names the transcriber should not mangle: the company, the contact and the studio. */
async function meetingKeyterms(ctx: Ctx, meetingId: string): Promise<string[]> {
  try {
    const { data } = await ctx.user.from("crm_meetings").select("crm_contacts(name), crm_deals(crm_companies(name))").eq("id", meetingId).maybeSingle();
    const d = (data ?? {}) as Row;
    return [d.crm_deals?.crm_companies?.name, d.crm_contacts?.name, ctx.crm.settings?.studio_name].filter((x) => typeof x === "string" && x.trim()) as string[];
  } catch { return []; }
}

export async function transcribeToMeeting(ctx: Ctx, meetingId: string, src: MediaSource, o: TranscribeOptions): Promise<Row> {
  if (!transcriptionConfigured()) throw new McpError("E_TRANSCRIPTION_NOT_CONFIGURED", "Server-side transcription is not switched on (no Deepgram key in the function secrets).", "Tell the user; an admin sets the DEEPGRAM_API function secret on the Supabase project. Where local scripts run, the get-transcript skill still works.");
  const t0 = Date.now();
  try {
    const terms = [...(o.keyterms ?? []), ...(await meetingKeyterms(ctx, meetingId))];
    const { resp, params } = await listen(src.url, { ...o, keyterms: terms });
    const payload = buildPayload(resp, params, src.label);
    const saved = await rpc<Row>(ctx, "save_transcript", { p_meeting_id: meetingId, p: payload });
    log({ fn: "crm-mcp", route: "transcribe", meeting: meetingId, turns: saved.turn_count, seconds: payload.duration_seconds, ms: Date.now() - t0 });
    return { saved, payload };
  } finally {
    if (src.tempKey) await deleteObject(src.tempKey);   // a video uploaded only to be transcribed is never kept
  }
}
