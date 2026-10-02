// outreach-voice-tools — the tools the website's voice agent calls during a call (web-chat-voice-elevenlabs-PRD.md §5.3).
// PUBLIC (deployed --no-verify-jwt): the voice provider calls it, and every request is authenticated here:
//   1. Authorization: Bearer <the agent's own secret>   a provider workspace secret; we keep only its hash, per website
//   2. X-GX-Session: <session token>                    signed by us at /voice/start, passed as the dynamic variable
//                                                       `secret__session` (never shown to the model, redacted in transcripts)
//   3. the call is still live, and has made at most 30 tool calls                (outreach_webchat_v_voice_tool)
// A wrong secret, a changed or expired session → 401 with no body detail. More than 30 calls → 429.
//
// Nothing is copied to the provider: the answers come from OUR knowledge sources, Q&A and product catalogue, so an edit
// in the app applies to the next question.
//
//   POST /knowledge   {query}                         → {found, passages: [{title, text}], note?}
//   POST /products    {query, max_price?, min_price?} → {found, products: "P1 Name — price; …", note}   (+ product cards in the chat)
//   POST /contact     {name?, phone?}                 → {result}
//   POST /email-form  {reason?}                       → {result}                                         (+ the email form in the chat)
import { HttpError, json, log, readJson, rpc, serve } from "../_shared/outreach/supabase.ts";
import { verifyToolRequest, type ToolCtx } from "../_shared/outreach/voice.ts";
import { cardOf, extractPriceFilter, fmtMoney, type ProductRow, type Retrieved } from "../_shared/outreach/webchat.ts";

const FN = "outreach-voice-tools";
const TOOLS: Record<string, string> = { "/knowledge": "search_knowledge", "/products": "find_products", "/contact": "save_contact", "/email-form": "show_email_form" };

const text = (v: unknown, max: number): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").replace(/\s+/g, " ").trim().slice(0, max);
const price = (v: unknown): number | null => { const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };
/** A passage as it is read to the model: one line, no markdown, no link. */
const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/[*_`#>|]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
const STOP = new Set("the and for you your our are with what when where which who how does can will would could should have has had from this that there their them about into than then also just want need know tell please any some more much many very".split(" "));
/**
 * Is this passage about the question at all? The search is forgiving by design (it also matches on letter patterns),
 * so a question about something the website never mentions still returns its nearest text. A passage counts when it
 * shares a meaningful word with the question (by its stem), or scored clearly above the noise.
 */
function relevant(query: string, k: Retrieved): boolean {
  if ((k.score ?? 0) >= 0.3) return true;
  const hay = `${k.heading ?? ""} ${k.text}`.toLowerCase();
  const keys = [...words(query)].filter((w) => w.length > 3 && !STOP.has(w));
  if (!keys.length) return (k.score ?? 0) >= 0.12;
  return keys.some((w) => hay.includes(w.length > 5 ? w.slice(0, w.length - 2) : w));
}

async function knowledge(c: ToolCtx, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = text(b.query, 300);
  if (q.length < 2) return { found: 0, passages: [], note: "Ask the visitor what they would like to know." };
  const [chunks, qa] = await Promise.all([
    c.knowledge_source_ids?.length ? rpc<Retrieved[]>("knowledge_search", { p_ws: c.workspace_id, p_sources: c.knowledge_source_ids, p_query: q, p_limit: 5 }).catch((e) => { log({ fn: FN, warn: `knowledge_search: ${String(e?.message ?? e).slice(0, 200)}` }); return []; }) : Promise.resolve([]),
    // the team's own answers that match the question (the first 30 are in the prompt already; a larger set is searched here)
    rpc<Array<{ question: string; answer: string }>>("knowledge_qa_for", { p_ws: c.workspace_id, p_kind: "website", p_target: c.inbox_id, p_question: q }).catch(() => []),
  ]);
  const qw = words(q);
  const answers = (Array.isArray(qa) ? qa : []).map((p) => ({ p, n: [...words(p.question)].filter((w) => qw.has(w)).length })).filter((x) => x.n >= 2 || (qw.size <= 2 && x.n >= 1)).sort((a, b) => b.n - a.n).slice(0, 2);
  // up to 5 short passages, 1,500 characters together: enough to answer in a sentence or two, quick to read
  const passages: Array<{ title: string; text: string }> = [];
  let room = 1500;
  for (const a of answers) { const t = plain(`${a.p.question} ${a.p.answer}`).slice(0, Math.min(400, room)); if (t.length > 20) { passages.push({ title: "Team answer", text: t }); room -= t.length; } }
  for (const k of (Array.isArray(chunks) ? chunks : []).filter((x) => relevant(q, x))) {
    if (passages.length >= 5 || room < 80) break;
    const t = plain(`${k.heading ? k.heading + ": " : ""}${k.text}`).slice(0, Math.min(420, room));
    if (t.length > 20) { passages.push({ title: text(k.title, 80), text: t }); room -= t.length; }
  }
  const s = await rpc<{ empty_searches: number; offer_team: boolean }>("webchat_v_voice_search_done", { p_call: c.call_id, p_query: q, p_found: passages.length });
  if (passages.length) return { found: passages.length, passages };
  return { found: 0, passages: [], note: s?.offer_team
    ? "Nothing was found again. Tell the visitor you are not sure, and offer to pass them to the team. If they accept, call switch_to_chat with handoff=true and reason low_confidence."
    : "Nothing was found. Do not guess. Say you are not sure about that, and offer the team." };
}

async function products(c: ToolCtx, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const pc = c.products;
  if (!pc?.sources?.length) return { found: 0, products: "", note: "This website has no product catalogue. Use search_knowledge instead." };
  const raw = text(b.query, 300);
  // the budget: what the model passed, else what is still in the words ("a choker under 1 lakh")
  const pf = extractPriceFilter(raw, pc.currency);
  const max = price(b.max_price) ?? pf.max ?? null, min = price(b.min_price) ?? pf.min ?? null;
  const filters: Record<string, unknown> = { include_oos: !!pc.include_oos };
  if (max != null) filters.max_price = max;
  if (min != null) filters.min_price = min;
  const rows = (await rpc<ProductRow[]>("product_search", { p_ws: c.workspace_id, p_sources: pc.sources, p_query: (pf.rest || raw).slice(0, 300), p_filters: filters, p_current: null, p_limit: 6 })) ?? [];
  const list = (Array.isArray(rows) ? rows : []).slice(0, 6);
  if (!list.length) return { found: 0, products: "", note: "No product matches. Say so, and ask one question to narrow it down (budget, occasion, size)." };
  const cards = list.map(cardOf);
  // the same cards the text assistant shows, in the same conversation; the widget gets them over its realtime channel
  if (c.chat_id && !c.test) {
    await rpc("webchat_v_bot_message", { p_chat: c.chat_id, p_text: null, p_content_type: "cards", p_attrs: { products: cards, voice: { call_id: c.call_id } } })
      .catch((e) => log({ fn: FN, warn: `cards: ${String(e?.message ?? e).slice(0, 200)}` }));
  }
  const line = list.map((p, i) => `P${i + 1} ${p.title}${pc.show_prices !== false && p.price != null ? ` — ${fmtMoney(p.price, p.currency)}` : ""}${p.available === false ? " (out of stock)" : ""}`).join("; ");
  return { found: list.length, products: line, note: "The cards are on the visitor's screen. Mention at most 3 by name in one sentence. Do not read prices unless asked.", ...(c.test ? { cards } : {}) };
}

async function contact(c: ToolCtx, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = text(b.name, 120), phone = text(b.phone, 40);
  if (!name && !phone) return { result: "Nothing to save. Ask for the name or the phone number first." };
  const r = await rpc<{ saved: string[]; had_name?: boolean; had_phone?: boolean }>("webchat_v_voice_contact", { p_call: c.call_id, p_name: name || null, p_phone: phone || null });
  const saved = Array.isArray(r?.saved) ? r.saved : [];
  if (phone && !saved.includes("phone") && !r?.had_phone) return { result: "That phone number does not look complete. Ask the visitor to say it again with the country code." };
  return { result: saved.length ? `Saved the visitor's ${saved.join(" and ")}.` : "We already have those details. Carry on." };
}

async function emailForm(c: ToolCtx): Promise<Record<string, unknown>> {
  if (!c.chat_id || c.test) return { result: "The form is on screen. Ask the visitor to type their email address there." };
  const s = await rpc<{ has_email: boolean; open_form: boolean }>("webchat_v_voice_email_state", { p_call: c.call_id });
  if (s?.has_email) return { result: "We already have the visitor's email address. No form is needed." };
  if (!s?.open_form) {
    const prompt = c.prompt || "What's your email?";
    await rpc("webchat_v_bot_message", { p_chat: c.chat_id, p_text: prompt, p_content_type: "form", p_attrs: { form: "email", prompt, voice: { call_id: c.call_id } } });
  }
  return { result: "The form is on screen. Ask the visitor to type their email address there." };
}

serve(FN, async (req) => {
  const path = new URL(req.url).pathname.replace(/^.*\/outreach-voice-tools/, "").replace(/\/+$/, "") || "/";
  const tool = TOOLS[path];
  if (req.method !== "POST" || !tool) throw new HttpError(404, "E_NOT_FOUND", "");
  const started = Date.now();
  const body = await readJson<Record<string, unknown>>(req);
  const ctx = await verifyToolRequest(req, tool);
  let out: Record<string, unknown>;
  try {
    out = tool === "search_knowledge" ? await knowledge(ctx, body) : tool === "find_products" ? await products(ctx, body) : tool === "save_contact" ? await contact(ctx, body) : await emailForm(ctx);
  } catch (e) {
    // the agent hears one plain sentence instead of an error it would read out
    log({ fn: FN, tool, error: String((e as any)?.message ?? e).slice(0, 300), call: ctx.call_id });
    out = { found: 0, result: "That did not work just now. Say you could not look it up, and offer the team." };
  }
  log({ fn: FN, tool, call: ctx.call_id, ms: Date.now() - started, found: out.found ?? null });
  return json({ ...out, ms: Date.now() - started });
});
