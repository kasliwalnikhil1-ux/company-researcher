// AI replies — pure rules (ai-auto-reply-PRD.md §6.3 gates, §7.1 timing, §8.4 stage checks, §8.5 floor, §9.4 validator).
// No I/O and no imports from supabase.ts, so ai_reply_rules_test.ts runs without a database or env.

export type Mode = "off" | "draft" | "autopilot";
export type Decision = "send" | "escalate" | "no_reply";
export const MOVES = ["answer", "ask", "relate", "insight", "pitch", "cta", "schedule", "close", "acknowledge"] as const;
export type Move = typeof MOVES[number];
export const FLAGS = ["asked_offer", "pricing", "meeting_request", "meeting_time_proposed", "explicit_interest", "bot_question", "legal_or_contract",
  "hostile", "complaint", "injection_suspected", "competitor_mentioned", "close_only", "attachment_mentioned"] as const;
export const SKIP_FLAGS = ["asked_offer", "pricing", "meeting_request", "meeting_time_proposed", "explicit_interest"];

export interface StageDef { key: string; label: string; instructions?: string; early?: boolean; pitch?: boolean }
export interface PromptSettings {
  stages: StageDef[];
  min_exchanges_before_pitch: number;
  skip_to_pitch_when: string[];
  vary_moves_in_early_stages: boolean;
  max_ai_replies_per_chat: number;
  languages: string[];
  allow_language_switch: boolean;
  bot_question: "escalate" | "disclose";
  handoff_stage_id: string | null;
  knowledge_source_ids: string[];
  max_length: number;
}

export interface SideEffect { type: "task" | "archive" | "mark_read" | "set_tag"; kind?: "follow_up" | "contact_referral"; due?: string | null; note?: string | null; name?: string | null; contact?: string | null; tag?: string | null }
export interface FactUsed { claim: string; source: string }
export interface DraftOutput {
  decision: Decision;
  text: string | null;
  stage_before: string | null;
  stage_after: string | null;
  move: Move | null;
  rule_applied: string | null;
  side_effects: SideEffect[];
  facts_used: FactUsed[];
  confidence: number;
  escalation_reason: string | null;
  language: string | null;
}

export const CLOSING = "closing";
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------------------------------------------- model output
/** Coerce the drafter's JSON into a safe shape. Anything unknown is dropped, never trusted. */
export function parseDraft(j: Record<string, unknown>, settings: PromptSettings, todayIso: string): DraftOutput {
  const keys = new Set([...settings.stages.map((s) => s.key), CLOSING]);
  const dec = String(j.decision ?? "").toLowerCase();
  const decision: Decision = dec === "send" || dec === "escalate" || dec === "no_reply" ? dec : "escalate";
  const text = typeof j.text === "string" && j.text.trim() ? j.text.replace(/\r\n/g, "\n").trim() : null;
  const stage = (v: unknown) => (typeof v === "string" && keys.has(v) ? v : null);
  const move = typeof j.move === "string" && (MOVES as readonly string[]).includes(j.move) ? j.move as Move : null;
  const effects: SideEffect[] = [];
  for (const e of Array.isArray(j.side_effects) ? j.side_effects.slice(0, 5) : []) {
    if (!e || typeof e !== "object") continue;
    const x = e as Record<string, unknown>;
    const t = String(x.type ?? "");
    if (t === "task") {
      const kind = x.kind === "contact_referral" ? "contact_referral" : "follow_up";
      const due = typeof x.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.due) && x.due >= todayIso ? x.due : null;
      effects.push({ type: "task", kind, due, note: str(x.note, 300), name: str(x.name, 120), contact: str(x.contact, 200) });
    } else if (t === "archive" || t === "mark_read") effects.push({ type: t });
    else if (t === "set_tag" && str(x.tag, 40)) effects.push({ type: "set_tag", tag: str(x.tag, 40) });
  }
  const facts: FactUsed[] = (Array.isArray(j.facts_used) ? j.facts_used : []).slice(0, 12)
    .map((f) => (f && typeof f === "object" ? { claim: str((f as any).claim, 200) ?? "", source: str((f as any).source, 80) ?? "" } : null))
    .filter((f): f is FactUsed => !!f && !!f.claim);
  return {
    decision, text: decision === "send" ? text : text,   // escalations may carry a draft for the person
    stage_before: stage(j.stage_before), stage_after: stage(j.stage_after), move,
    rule_applied: str(j.rule_applied, 120), side_effects: effects, facts_used: facts,
    confidence: clamp(Number(j.confidence) || 0, 0, 1), escalation_reason: str(j.escalation_reason, 200),
    language: typeof j.language === "string" && /^[a-z]{2,3}$/i.test(j.language) ? j.language.toLowerCase() : null,
  };
}
function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

// ---------------------------------------------------------------------------------------------------- extraction
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|co|ai|in|net|org|app|me|dev|xyz|us|uk|de|so|ly|to|gg|link|page)(?:\/[^\s<>"')\]]*)?/gi;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;
const MONEY_RE = /(?:[$€£₹¥]|\b(?:usd|eur|gbp|inr|rs\.?|aed|sgd|aud|cad)\s?)\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|mn|bn|lakh|lakhs|lac|l|cr|crore|crores|million|thousand)?\b|\b\d[\d,]*(?:\.\d+)?\s?(?:k|m|lakh|lakhs|cr|crore)?\s?(?:usd|eur|gbp|inr|rupees|dollars|euros)\b/gi;
const PCT_RE = /\b\d+(?:\.\d+)?\s?(?:%|percent\b)/gi;
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DATE_RE = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b|\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b|\\b\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}\\b`, "gi");

export function normUrl(u: string): { host: string; path: string } | null {
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = (url.pathname + url.search).replace(/\/+$/, "").toLowerCase();
    return { host, path };
  } catch { return null; }
}
export const extractUrls = (t: string) => [...new Set((t.replace(EMAIL_RE, " ").match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))];
export const extractEmails = (t: string) => [...new Set((t.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
export const digits = (s: string) => s.replace(/\D/g, "");
export function extractPhones(t: string): string[] {
  const noUrls = t.replace(EMAIL_RE, " ").replace(URL_RE, " ").replace(DATE_RE, " ").replace(MONEY_RE, " ").replace(PCT_RE, " ");
  return [...new Set((noUrls.match(PHONE_RE) ?? []).map(digits).filter((d) => d.length >= 7 && d.length <= 15))];
}
/** A money / percentage figure reduced to one number ("₹50,000" and "₹50k" → "50000", "12.5%" → "12.5%"). */
export function figureKey(s: string): string {
  const low = s.toLowerCase().replace(/,/g, "");
  const num = low.match(/\d+(?:\.\d+)?/);
  if (!num) return low;
  const after = low.slice((num.index ?? 0) + num[0].length).trim();
  const mult = /^(k|thousand)\b/.test(after) ? 1e3 : /^(m|mn|million)\b/.test(after) ? 1e6 : /^(bn|billion)\b/.test(after) ? 1e9
    : /^(lakh|lakhs|lac|l)\b/.test(after) ? 1e5 : /^(cr|crore|crores)\b/.test(after) ? 1e7 : 1;
  const n = Math.round(Number(num[0]) * mult * 100) / 100;
  return /%|percent/.test(low) ? `${n}%` : `${n}`;
}
export const extractMoney = (t: string) => [...new Set((t.match(MONEY_RE) ?? []).map(figureKey))];
export const extractPercents = (t: string) => [...new Set((t.match(PCT_RE) ?? []).map(figureKey))];
export function dateKey(s: string): string {
  const x = s.toLowerCase().replace(/(st|nd|rd|th)\b/g, "").replace(/\s+of\s+/, " ").replace(/\s+/g, " ").trim();
  const iso = x.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${Number(iso[3])}-${Number(iso[2])}`;
  const mon = x.match(new RegExp(`(${MONTHS})`));
  const day = x.match(/\d{1,2}/);
  if (mon && day) return `${Number(day[0])}-${monthIndex(mon[1])}`;
  const dm = x.match(/^(\d{1,2})[/.](\d{1,2})/);
  return dm ? `${Number(dm[1])}-${Number(dm[2])}` : x;
}
function monthIndex(m: string): number { return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m.slice(0, 3)) + 1; }
export const extractDates = (t: string) => [...new Set((t.match(DATE_RE) ?? []).map(dateKey))];

/** Everything a person would call "a fact that can be wrong": used by the validator and by the facts-changed check. */
export function factsOf(t: string): { urls: string[]; emails: string[]; phones: string[]; money: string[]; percents: string[]; dates: string[] } {
  return { urls: extractUrls(t).map((u) => { const n = normUrl(u); return n ? `${n.host}${n.path}` : u.toLowerCase(); }), emails: extractEmails(t), phones: extractPhones(t), money: extractMoney(t), percents: extractPercents(t), dates: extractDates(t) };
}

/** A price, date, link, email or phone was added or removed between the draft and what was sent (§16.2 "wrong facts"). */
export function factsChanged(draft: string, sent: string): boolean {
  const a = factsOf(draft), b = factsOf(sent);
  const same = (x: string[], y: string[]) => x.length === y.length && [...x].sort().join("|") === [...y].sort().join("|");
  return !(same(a.urls, b.urls) && same(a.emails, b.emails) && same(a.phones, b.phones) && same(a.money, b.money) && same(a.percents, b.percents) && same(a.dates, b.dates));
}

// ---------------------------------------------------------------------------------------------------- distances
/** Normalised Levenshtein distance (0 = identical, 1 = nothing in common), whitespace-insensitive. */
export function editDistance(a: string, b: string): number {
  const x = a.replace(/\s+/g, " ").trim(), y = b.replace(/\s+/g, " ").trim();
  if (x === y) return 0;
  if (!x.length || !y.length) return 1;
  const n = x.length, m = y.length;
  let prev = new Array(m + 1).fill(0).map((_, i) => i), cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let k = 1; k <= m; k++) cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (x.charCodeAt(i - 1) === y.charCodeAt(k - 1) ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return Math.round((prev[m] / Math.max(n, m)) * 1000) / 1000;
}

/** Character-trigram Dice similarity on normalised text (0..1). */
export function similarity(a: string, b: string): number {
  const norm = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim()} `;
  const grams = (s: string) => { const g = new Map<string, number>(); for (let i = 0; i < s.length - 2; i++) { const t = s.slice(i, i + 3); g.set(t, (g.get(t) ?? 0) + 1); } return g; };
  const ga = grams(norm(a)), gb = grams(norm(b));
  let inter = 0, na = 0, nb = 0;
  for (const v of ga.values()) na += v;
  for (const v of gb.values()) nb += v;
  for (const [k, v] of ga) inter += Math.min(v, gb.get(k) ?? 0);
  return na + nb === 0 ? 0 : (2 * inter) / (na + nb);
}

// ---------------------------------------------------------------------------------------------------- validator (§9.4 + §8.4)
export interface ValidateCtx {
  settings: PromptSettings;
  editorMode: "guided" | "raw";
  /** master prompt text (compiled) + retrieved knowledge: the only allowed source of links, contacts, prices */
  allowedText: string;
  /** what the prospect wrote in this burst: dates they proposed may be echoed */
  prospectText: string;
  prospectLanguage: string | null;
  exchanges: number;
  flags: string[];
  prevMove: string | null;
  ourEarlierTexts: string[];
  stageBefore: string | null;
}
export interface Failure { rule: string; detail: string; stage?: boolean }

const PLACEHOLDER_RE = /\{\{|\}\}|<[^<>\n]{2,60}>|\bTODO\b|\[(?:name|company|link|date|time|your [a-z ]+)\]/i;
const AI_DENIAL_RE = /\b(?:i'?m|i am)\s+(?:a\s+)?(?:real|actual|genuine)\s+(?:person|human)\b|\bnot\s+(?:a\s+)?(?:bot|robot|chatbot|machine)\b|\bnot\s+(?:an?\s+)?(?:ai|automated|automation)\b|\b(?:i'?m|i am)\s+(?:definitely\s+|totally\s+|100%\s+)?(?:human|a person)\b|\bno,?\s+(?:i'?m|i am)\s+not\s+(?:a\s+)?(?:bot|ai)\b|\b(?:this is|it'?s)\s+(?:really\s+)?me\b,?\s+not\s+(?:a\s+)?(?:bot|ai)/i;

export function stageIndex(settings: PromptSettings, key: string | null): number {
  if (!key) return -1;
  if (key === CLOSING) return settings.stages.length;
  return settings.stages.findIndex((s) => s.key === key);
}
function pitchIndex(settings: PromptSettings): number {
  const i = settings.stages.findIndex((s) => s.pitch);
  return i >= 0 ? i : settings.stages.findIndex((s) => s.key === "pitch");
}

export function countQuestions(text: string): number {
  const unquoted = text.replace(/"[^"]*"|“[^”]*”|«[^»]*»/g, " ");
  return (unquoted.match(/\?/g) ?? []).length;
}

export function validateDraft(d: DraftOutput, c: ValidateCtx): { ok: boolean; failures: Failure[]; stageViolation: boolean } {
  const failures: Failure[] = [];
  if (d.decision !== "send") return { ok: true, failures, stageViolation: false };
  const text = d.text ?? "";
  const max = clamp(Number(c.settings.max_length) || 600, 100, 1000);
  if (text.length < 1 || text.length > max) failures.push({ rule: "length", detail: `${text.length} characters (1–${max} allowed)` });

  const allowed = c.allowedText;
  const allowedUrls = extractUrls(allowed).map(normUrl).filter((u): u is { host: string; path: string } => !!u);
  for (const u of extractUrls(text)) {
    const n = normUrl(u);
    const ok = !!n && allowedUrls.some((a) => a.host === n.host && (a.path === "" ? true : n.path === a.path || n.path.startsWith(a.path + "/") || n.path.startsWith(a.path + "?") || n.path === a.path));
    if (!ok) failures.push({ rule: "url", detail: `link not in the master prompt: ${u}` });
  }
  const allowedEmails = new Set(extractEmails(allowed));
  for (const e of extractEmails(text)) if (!allowedEmails.has(e)) failures.push({ rule: "email", detail: `email not in the master prompt: ${e}` });
  const allowedPhones = new Set(extractPhones(allowed));
  for (const p of extractPhones(text)) if (![...allowedPhones].some((a) => a.endsWith(p) || p.endsWith(a))) failures.push({ rule: "phone", detail: `phone number not in the master prompt: ${p}` });
  const allowedMoney = new Set([...extractMoney(allowed), ...extractPercents(allowed)]);
  for (const f of [...extractMoney(text), ...extractPercents(text)]) if (!allowedMoney.has(f)) failures.push({ rule: "figure", detail: `price or percentage not in the master prompt: ${f}` });
  const allowedDates = new Set([...extractDates(allowed), ...extractDates(c.prospectText)]);
  for (const f of extractDates(text)) if (!allowedDates.has(f)) failures.push({ rule: "date", detail: `date not in the master prompt or their message: ${f}` });
  if (PLACEHOLDER_RE.test(text)) failures.push({ rule: "placeholder", detail: "leftover template text ({{ }}, <…>, TODO)" });
  if (AI_DENIAL_RE.test(text)) failures.push({ rule: "ai_denial", detail: "the draft denies being AI" });
  if (c.prospectLanguage && d.language && d.language !== c.prospectLanguage && !c.settings.allow_language_switch) {
    failures.push({ rule: "language", detail: `draft in ${d.language}, they wrote in ${c.prospectLanguage}` });
  }

  let stageViolation = false;
  if (c.editorMode === "guided") {
    const skip = c.flags.some((f) => c.settings.skip_to_pitch_when.includes(f));
    const hasLink = extractUrls(text).length > 0;
    const hasPrice = extractMoney(text).length > 0;
    if ((d.move === "pitch" || d.move === "cta" || hasLink || hasPrice) && c.exchanges < c.settings.min_exchanges_before_pitch && !skip) {
      failures.push({ rule: "early_pitch", detail: `pitch, link or price after ${c.exchanges} exchange(s); ${c.settings.min_exchanges_before_pitch} needed unless they ask`, stage: true });
    }
    const before = c.settings.stages[stageIndex(c.settings, d.stage_before ?? c.stageBefore)];
    const early = !!before?.early || (!before && stageIndex(c.settings, c.stageBefore) <= 0);
    if (early && c.settings.vary_moves_in_early_stages && c.prevMove && d.move && d.move === c.prevMove) {
      failures.push({ rule: "vary_moves", detail: `same move as the previous AI reply (${d.move})`, stage: true });
    }
    const dup = c.ourEarlierTexts.find((t) => similarity(t, text) > 0.8);
    if (dup) failures.push({ rule: "near_duplicate", detail: "almost the same as one of our earlier messages", stage: true });
    if (early && countQuestions(text) > 1) failures.push({ rule: "one_question", detail: `${countQuestions(text)} questions in an early-stage reply (1 allowed)`, stage: true });
    const pi = pitchIndex(c.settings);
    const cur = stageIndex(c.settings, c.stageBefore);
    const after = stageIndex(c.settings, d.stage_after);
    if (pi >= 0 && cur >= pi && after >= 0 && after < pi && d.stage_after !== CLOSING && d.move !== "close") {
      failures.push({ rule: "stage_backwards", detail: `went back to ${d.stage_after} after reaching the pitch`, stage: true });
    }
    stageViolation = failures.some((f) => f.stage);
  }
  return { ok: failures.length === 0, failures, stageViolation };
}

// ---------------------------------------------------------------------------------------------------- floor (§8.5)
export interface BurstMsg { text: string | null; transcript?: string | null; attachments?: unknown[]; unsupported?: boolean; deleted?: boolean; classification?: Record<string, any> | null; flags?: string[]; reactions?: unknown[] }

export const BOT_TEXT_RE = /\b(this is an automated (message|reply|response)|do not reply to this (message|email)|i am an? (ai|virtual) assistant|auto-?generated (message|reply))\b/i;

/** Hard reasons that decide before (or instead of) the model. */
export function floorPrecheck(burst: BurstMsg[], settings: PromptSettings): { decision: Decision | null; reasons: string[]; optOut: boolean; flags: string[] } {
  const flags = [...new Set(burst.flatMap((m) => [...(m.flags ?? []), ...((m.classification?.flags as string[] | undefined) ?? [])]))];
  const optOut = burst.some((m) => m.classification?.do_not_contact === true);
  if (optOut) return { decision: "no_reply", reasons: ["opt_out"], optOut: true, flags };
  const reasons: string[] = [];
  const unreadable = burst.some((m) => (Array.isArray(m.attachments) && m.attachments.length > 0) || m.unsupported || (!String(m.text ?? "").trim() && !String(m.transcript ?? "").trim()));
  if (unreadable) reasons.push("attachment");
  if (flags.includes("injection_suspected")) reasons.push("injection_suspected");
  if (flags.includes("bot_question") && settings.bot_question === "escalate") reasons.push("bot_question");
  return { decision: reasons.length ? "escalate" : null, reasons, optOut: false, flags };
}

// ---------------------------------------------------------------------------------------------------- gates (§6.3)
export interface GateInput {
  mode: Mode;
  provider: string;
  isGroup: boolean;
  contactedFirst: boolean;
  suppression: string | null;
  doNotContact: boolean;
  archived: boolean;
  autopilotPaused: boolean;
  senderStatus: string;
  newestInboundAt: string | null;
  staleAfterH: number;
  language: string | null;
  languages: string[];
  aiRepliesCount: number;
  maxAiRepliesPerChat: number;
  aiSendsToday: number;
  maxAiSendsPerDay: number;
  poolOk: boolean;
  leadStagePosition: number | null;
  handoffStagePosition: number | null;
  leadTags: string[];
  leadCountry: string | null;
  disclosure: string | null;
  blockedCountries: string[];
  now: Date;
}
export interface GateResult { skip: string | null; maxMode: Mode; escalate: string[]; failures: string[]; detail: Array<{ gate: string; ok: boolean; detail?: string }> }

const ORDER: Mode[] = ["off", "draft", "autopilot"];
export const minMode = (a: Mode, b: Mode): Mode => ORDER[Math.min(ORDER.indexOf(a), ORDER.indexOf(b))];

export function evaluateGates(g: GateInput): GateResult {
  const detail: GateResult["detail"] = [];
  const failures: string[] = [];
  const escalate: string[] = [];
  let maxMode: Mode = "autopilot";
  let skip: string | null = null;
  const note = (gate: string, ok: boolean, d?: string) => { detail.push({ gate, ok, detail: d }); if (!ok) failures.push(gate); };

  note("G1", g.mode !== "off", g.mode === "off" ? "mode is off" : undefined);
  if (g.mode === "off") skip = "G1";
  if (!skip && g.isGroup) { note("G2", false, "group chat"); skip = "G2"; } else note("G2", true);
  if (!skip && !g.contactedFirst) { note("G3", false, "they wrote first"); skip = "G3"; } else note("G3", true);
  if (!skip && (g.suppression || g.doNotContact)) { note("G4", false, g.suppression ?? "do_not_contact"); skip = "G4"; } else note("G4", true);
  if (skip) return { skip, maxMode: "off", escalate, failures, detail };

  if (g.archived || g.autopilotPaused) { note("G5", false, g.archived ? "archived" : "autopilot paused"); maxMode = minMode(maxMode, "draft"); } else note("G5", true);
  if (g.senderStatus !== "ok") { note("G6", false, `sender ${g.senderStatus}`); maxMode = minMode(maxMode, "draft"); } else note("G6", true);
  const ageH = g.newestInboundAt ? (g.now.getTime() - new Date(g.newestInboundAt).getTime()) / 3600_000 : 0;
  if (ageH >= g.staleAfterH) { note("G7", false, `newest message is ${Math.floor(ageH)} h old`); maxMode = minMode(maxMode, "draft"); } else note("G7", true);
  if (g.language && g.languages.length && !g.languages.includes(g.language)) { note("G9", false, `language ${g.language}`); escalate.push("language"); } else note("G9", true);
  if (g.aiRepliesCount >= g.maxAiRepliesPerChat) { note("G10", false, `${g.aiRepliesCount} AI replies already`); escalate.push("turn_limit"); } else note("G10", true);
  if (g.aiSendsToday >= g.maxAiSendsPerDay) { note("G11", false, `${g.aiSendsToday} AI sends today`); maxMode = minMode(maxMode, "draft"); } else note("G11", true);
  if (!g.poolOk) { note("G12", false, "monthly AI allowance used up"); return { skip: "G12", maxMode: "off", escalate, failures, detail }; } else note("G12", true);
  const tags = g.leadTags.map((t) => t.toLowerCase());
  if (tags.includes("vip") || tags.includes("manual_only") || tags.includes("manual-only")) { note("G13", false, "tagged vip / manual only"); escalate.push("vip"); }
  else if (g.handoffStagePosition != null && g.leadStagePosition != null && g.leadStagePosition >= g.handoffStagePosition) { note("G13", false, "at or past the hand-off stage"); escalate.push("stage"); }
  else note("G13", true);
  // G14: the EU/EEA rule applies while no disclosure line is set; an unknown country counts as not allowed
  if (!g.disclosure && g.blockedCountries.length) {
    const blocked = !g.leadCountry || g.blockedCountries.includes(g.leadCountry);
    if (blocked) { note("G14", false, g.leadCountry ? `lead in ${g.leadCountry}` : "lead country unknown"); maxMode = minMode(maxMode, "draft"); } else note("G14", true);
  } else note("G14", true);
  return { skip: null, maxMode: minMode(g.mode, maxMode), escalate, failures, detail };
}

// ---------------------------------------------------------------------------------------------------- final decision
export function strictest(input: {
  floor: { decision: Decision | null; reasons: string[] };
  gateEscalations: string[];
  draft: DraftOutput;
  validator: { ok: boolean; failures: Failure[] } | null;
  verifier: { supported: boolean; follows_rule: boolean; answers_their_questions: boolean } | null;
  minConfidence?: number;
}): { decision: Decision; reasons: string[] } {
  const reasons: string[] = [];
  if (input.floor.decision === "no_reply") return { decision: "no_reply", reasons: input.floor.reasons };
  if (input.floor.decision === "escalate") reasons.push(...input.floor.reasons);
  reasons.push(...input.gateEscalations);
  let decision = input.draft.decision;
  if (decision === "escalate") reasons.push(input.draft.escalation_reason ? "master_prompt" : "master_prompt");
  if (decision === "send") {
    if (!input.draft.text) reasons.push("model_error");
    if (input.validator && !input.validator.ok) reasons.push(input.validator.failures.some((f) => f.stage) ? "stage_rule" : "validator");
    if (input.verifier && !(input.verifier.supported && input.verifier.follows_rule && input.verifier.answers_their_questions)) reasons.push("verifier");
    if (input.draft.confidence < (input.minConfidence ?? 0.75)) reasons.push("low_confidence");
  }
  if (reasons.length) decision = "escalate";
  // no_reply from the prompt stays no_reply unless the floor / gates say a person must look
  if (input.draft.decision === "no_reply" && !input.floor.decision && input.gateEscalations.length === 0) return { decision: "no_reply", reasons: [] };
  return { decision, reasons: [...new Set(reasons)] };
}

// ---------------------------------------------------------------------------------------------------- countries (G14)
const COUNTRY_NAMES: Record<string, string> = {
  austria: "AT", österreich: "AT", belgium: "BE", belgië: "BE", belgique: "BE", bulgaria: "BG", croatia: "HR", hrvatska: "HR", cyprus: "CY",
  "czech republic": "CZ", czechia: "CZ", denmark: "DK", danmark: "DK", estonia: "EE", finland: "FI", suomi: "FI", france: "FR", germany: "DE",
  deutschland: "DE", greece: "GR", hungary: "HU", ireland: "IE", italy: "IT", italia: "IT", latvia: "LV", lithuania: "LT", luxembourg: "LU", malta: "MT",
  netherlands: "NL", "the netherlands": "NL", nederland: "NL", holland: "NL", poland: "PL", polska: "PL", portugal: "PT", romania: "RO", slovakia: "SK",
  slovenia: "SI", spain: "ES", españa: "ES", sweden: "SE", sverige: "SE", iceland: "IS", liechtenstein: "LI", norway: "NO", norge: "NO",
  "united kingdom": "GB", uk: "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB", "great britain": "GB", switzerland: "CH",
  "united states": "US", "united states of america": "US", usa: "US", "u.s.": "US", canada: "CA", mexico: "MX", brazil: "BR", argentina: "AR", chile: "CL",
  colombia: "CO", peru: "PE", india: "IN", pakistan: "PK", bangladesh: "BD", "sri lanka": "LK", nepal: "NP", china: "CN", "hong kong": "HK", taiwan: "TW",
  japan: "JP", "south korea": "KR", korea: "KR", singapore: "SG", malaysia: "MY", indonesia: "ID", philippines: "PH", vietnam: "VN", thailand: "TH",
  australia: "AU", "new zealand": "NZ", "united arab emirates": "AE", uae: "AE", "saudi arabia": "SA", qatar: "QA", kuwait: "KW", bahrain: "BH", oman: "OM",
  israel: "IL", turkey: "TR", türkiye: "TR", egypt: "EG", nigeria: "NG", kenya: "KE", "south africa": "ZA", ghana: "GH", morocco: "MA", ukraine: "UA",
  russia: "RU", serbia: "RS", "bosnia and herzegovina": "BA", albania: "AL", "north macedonia": "MK", montenegro: "ME", moldova: "MD", armenia: "AM",
};
const US_STATES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)\b/i;
const CITY_COUNTRY: Array<[RegExp, string]> = [
  [/\b(san francisco|bay area|silicon valley|los angeles|seattle|boston|chicago|austin|miami|nyc|new york city|denver|atlanta|dallas|houston)\b/i, "US"],
  [/\b(london|manchester|birmingham|edinburgh|glasgow|bristol|leeds)\b/i, "GB"],
  [/\b(bengaluru|bangalore|mumbai|delhi|new delhi|gurugram|gurgaon|noida|hyderabad|chennai|pune|kolkata|ahmedabad|jaipur)\b/i, "IN"],
  [/\b(berlin|munich|münchen|hamburg|frankfurt|cologne|köln|stuttgart|düsseldorf)\b/i, "DE"],
  [/\b(paris|lyon|marseille|toulouse)\b/i, "FR"], [/\b(amsterdam|rotterdam|utrecht|the hague|eindhoven)\b/i, "NL"],
  [/\b(madrid|barcelona|valencia)\b/i, "ES"], [/\b(milan|milano|rome|roma|turin)\b/i, "IT"], [/\b(stockholm|gothenburg)\b/i, "SE"],
  [/\b(copenhagen)\b/i, "DK"], [/\b(dublin)\b/i, "IE"], [/\b(lisbon|porto)\b/i, "PT"], [/\b(warsaw|kraków|krakow)\b/i, "PL"],
  [/\b(vienna|wien)\b/i, "AT"], [/\b(brussels|antwerp)\b/i, "BE"], [/\b(helsinki)\b/i, "FI"], [/\b(oslo)\b/i, "NO"], [/\b(zurich|zürich|geneva)\b/i, "CH"],
  [/\b(toronto|vancouver|montreal)\b/i, "CA"], [/\b(sydney|melbourne|brisbane)\b/i, "AU"], [/\b(dubai|abu dhabi)\b/i, "AE"], [/\b(tel aviv)\b/i, "IL"],
  [/\b(singapore)\b/i, "SG"], [/\b(tokyo|osaka)\b/i, "JP"], [/\b(são paulo|sao paulo|rio de janeiro)\b/i, "BR"],
];

/** ISO-2 country from a free-text LinkedIn location ("Berlin, Germany", "Greater Bengaluru Area", "Austin, Texas"), else null. */
export function parseCountry(location: string | null | undefined): string | null {
  const loc = String(location ?? "").trim();
  if (!loc) return null;
  const parts = loc.split(/[,·|]/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].replace(/^(greater|metropolitan)\s+/, "").replace(/\s+(area|region|metropolitan area|metro area)$/, "");
    if (COUNTRY_NAMES[p]) return COUNTRY_NAMES[p];
  }
  const lower = loc.toLowerCase();
  for (const [name, code] of Object.entries(COUNTRY_NAMES)) if (name.length > 3 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)) return code;
  if (US_STATES.test(loc)) return "US";
  for (const [re, code] of CITY_COUNTRY) if (re.test(loc)) return code;
  return null;
}

// ---------------------------------------------------------------------------------------------------- timing (§7.1)
export type Schedule = Record<string, Array<[string, string]>>;
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function localParts(tz: string, at: Date): { date: string; hour: number; minute: number; weekday: string } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: String(p.weekday).toLowerCase().slice(0, 3) };
}
function zonedToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const want = Date.UTC(y, m - 1, d, hh, mm, 0);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const lp = localParts(tz, new Date(guess));
    const [ly, lm, ld] = lp.date.split("-").map(Number);
    const diff = want - Date.UTC(ly, lm - 1, ld, lp.hour, lp.minute, 0);
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekdayOf(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** The working windows that contain or follow `t`, as UTC intervals, for the next 8 days. */
export function windows(schedule: Schedule, tz: string, t: Date): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  const today = localParts(tz, t).date;
  for (let i = -1; i <= 8; i++) {
    const day = addDays(today, i);
    for (const w of schedule?.[weekdayOf(day)] ?? []) {
      if (!Array.isArray(w) || w.length < 2) continue;
      const start = zonedToUtc(day, w[0], tz), end = zonedToUtc(day, w[1], tz);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
export function windowAt(schedule: Schedule, tz: string, t: Date): { start: Date; end: Date } | null {
  return windows(schedule, tz, t).find((w) => w.start <= t && t < w.end) ?? null;
}
export function nextWindowStart(schedule: Schedule, tz: string, t: Date): Date | null {
  return windows(schedule, tz, t).find((w) => w.start > t)?.start ?? null;
}

/** log-uniform between lo and hi seconds: more short waits than long ones */
export function logUniform(lo: number, hi: number, rand: () => number = Math.random): number {
  const a = Math.log(Math.max(1, lo)), b = Math.log(Math.max(lo + 1, hi));
  return Math.exp(a + (b - a) * rand());
}

export function computeSendAt(o: { now: Date; delayMinS: number; delayMaxS: number; draftLength: number; live: boolean; schedule: Schedule; tz: string; rand?: () => number }): Date {
  const rand = o.rand ?? Math.random;
  const [lo, hi] = o.live ? [60, 240] : [o.delayMinS, o.delayMaxS];
  const typing = clamp(o.draftLength / 8, 0, 120);
  let t = new Date(o.now.getTime() + (logUniform(lo, hi, rand) + typing) * 1000);
  const w = windowAt(o.schedule, o.tz, t);
  if (!w || (w.end.getTime() - t.getTime()) < 10 * 60_000) {
    const from = w ? w.end : t;
    const next = nextWindowStart(o.schedule, o.tz, from);
    if (next) t = new Date(next.getTime() + (15 + rand() * 60) * 60_000);   // not on the dot of 09:00
    else t = new Date(o.now.getTime() + 24 * 3600_000);
  }
  return t;
}
