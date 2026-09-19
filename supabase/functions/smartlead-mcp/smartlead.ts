// smartlead-mcp/smartlead.ts — the ONLY place that talks to Smartlead.
//
// REST client (server.smartlead.ai + smartdelivery.smartlead.ai), plus normalisers
// that turn Smartlead payloads into the compact shapes the tools return.
//
// Smartlead's responses are not consistent between endpoints (bare arrays, {ok,data},
// {success,data}; snake_case in one place, nested objects in another), so every
// normaliser reads a field from several candidate locations instead of trusting
// one shape. Tools expose `raw: true` to look at the unmodified payload when a
// mapping needs fixing.
//
// The API key is a query parameter, so URLs must never reach logs or error text.

import { McpError, type Row, untrusted } from "./ctx.ts";

const API_BASE = "https://server.smartlead.ai/api/v1";
const DELIVERY_BASE = "https://smartdelivery.smartlead.ai/api/v1";
const apiKey = () => (Deno.env.get("SMARTLEAD_API_KEY") ?? "").trim();
export const isConfigured = () => apiKey().length > 0;

type Query = Record<string, string | number | boolean | undefined | null>;
interface CallOpts { query?: Query; body?: unknown; base?: "api" | "delivery"; timeoutMs?: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redact = (s: string) => { const k = apiKey(); return k ? s.split(k).join("***") : s; };

export async function sl<T = Row>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: CallOpts = {}): Promise<T> {
  const key = apiKey();
  if (!key) throw new McpError("E_NOT_CONFIGURED", "SMARTLEAD_API_KEY is not set on the Supabase project");
  const url = new URL((opts.base === "delivery" ? DELIVERY_BASE : API_BASE) + path);
  url.searchParams.set("api_key", key);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));

  let lastStatus = 0, lastText = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      // A network error on a write is NOT retried: the request may have reached Smartlead.
      if (method !== "GET" || attempt === 2) throw new McpError("E_SMARTLEAD_HTTP", `network error calling Smartlead ${method} ${path}: ${redact(e instanceof Error ? e.message : String(e))}`, method === "GET" ? undefined : "The request may or may not have been processed. Check the state in Smartlead (read tool) before trying again.");
      await sleep(600 * (attempt + 1));
      continue;
    }
    lastStatus = res.status;
    lastText = await res.text();
    if (res.status === 429 && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
    if (res.status >= 500 && method === "GET" && attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
    break;
  }

  let data: unknown = null;
  try { data = lastText ? JSON.parse(lastText) : null; } catch { data = lastText; }
  if (lastStatus >= 200 && lastStatus < 300) return data as T;

  const msg = redact(typeof data === "string" ? data.slice(0, 400) : String((data as Row)?.message ?? (data as Row)?.error ?? JSON.stringify(data ?? "").slice(0, 400)));
  if (lastStatus === 401 || lastStatus === 403) throw new McpError("E_SMARTLEAD_AUTH", `Smartlead ${lastStatus}: ${msg}`);
  if (lastStatus === 404) throw new McpError("E_NOT_FOUND", `Smartlead 404 on ${method} ${path}: ${msg}`);
  if (lastStatus === 429) throw new McpError("E_RATE_LIMITED", "Smartlead rate limit", undefined, undefined, 60);
  if (lastStatus === 400 || lastStatus === 422) throw new McpError("E_PAYLOAD_INVALID", `Smartlead rejected the request (${lastStatus}) on ${method} ${path}: ${msg}`);
  throw new McpError("E_SMARTLEAD_HTTP", `Smartlead ${lastStatus} on ${method} ${path}: ${msg}`);
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

/** First non-empty value among dotted paths. */
export function pick(o: unknown, ...paths: string[]): any { 
  for (const p of paths) {
    let v: any = o; 
    for (const k of p.split(".")) { if (v == null) break; v = v[k]; }
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** Unwrap {ok|success, data} envelopes; leave bare payloads alone. */
export function body(r: unknown): any { 
  if (r && typeof r === "object" && !Array.isArray(r) && "data" in (r as Row) && ("ok" in (r as Row) || "success" in (r as Row) || Object.keys(r as Row).length <= 3)) return (r as Row).data;
  return r;
}

/** Find the row array in a list response. */
export function rowsOf(r: unknown, ...keys: string[]): Row[] {
  const b = body(r);
  if (Array.isArray(b)) return b as Row[];
  for (const k of [...keys, "data", "messages", "results", "items", "rows"]) { const v = (b as Row)?.[k] ?? (r as Row)?.[k]; if (Array.isArray(v)) return v as Row[]; }
  return [];
}

export const totalOf = (r: unknown): number | undefined => {
  const v = pick(r, "total_count", "totalCount", "total", "total_leads", "total_stats", "data.total_count", "data.total", "count");
  return Number.isFinite(Number(v)) ? Number(v) : undefined;
};

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return String(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Transport formatting only: Smartlead's email_body is HTML, so a plain-text body gets its line breaks as <br>. Words are never touched. */
export function toEmailHtml(bodyText: string): string {
  if (/<\/?(p|br|div|a|b|i|strong|em|ul|ol|li|span|table|h[1-6])\b[^>]*>/i.test(bodyText)) return bodyText;
  return escapeHtml(bodyText).replace(/\r\n/g, "\n").replace(/\n/g, "<br>");
}

/** Strip the quoted previous mail from a reply so triage reads what the lead actually wrote. */
export function stripQuoted(t: string): string {
  const cut = [/\nOn .{5,120} wrote:\s*\n/i, /\n-{2,}\s*Original Message\s*-{2,}/i, /\nFrom: .+\nSent: /i, /\n_{8,}\n/, /\n>+ ?.*(\n>+ ?.*){2,}/];
  let end = t.length;
  for (const re of cut) { const m = re.exec(t); if (m && m.index > 20 && m.index < end) end = m.index; }
  return t.slice(0, end).trim();
}

// ---------------------------------------------------------------------------
// Non-human detection (PRD §6.6): OOO, bounces, auto-responders, unsubscribes
// ---------------------------------------------------------------------------

export type AutoKind = "bounce" | "out_of_office" | "auto_responder" | "unsubscribe";

export function detectAuto(m: { from?: string; subject?: string; text?: string }): { kind: AutoKind; why: string } | null {
  const from = (m.from ?? "").toLowerCase(), subj = (m.subject ?? "").toLowerCase(), t = stripQuoted(m.text ?? "").toLowerCase().slice(0, 1500);
  if (/mailer-daemon|postmaster@|mail delivery (sub)?system|no-?reply@.*(bounce|delivery)/.test(from) || /undeliverable|delivery status notification|delivery (has )?failed|returned mail|failure notice|mail delivery failed/.test(subj) || /address (couldn't be|could not be|not) found|recipient address rejected|550[ -]5\.\d\.\d|user unknown|mailbox (unavailable|not found|full)/.test(t))
    return { kind: "bounce", why: "looks like a delivery failure notice" };
  if (/out of (the )?office|automatic reply|auto(matic)?[- ]?reply|autoreply|on (annual |parental |maternity |sick )?leave|away from (the |my )?(office|desk)/.test(subj) || /\b(i am|i'm|i will be|i'll be) (currently )?(out of (the )?office|on (annual |parental |maternity |sick )?leave|away|travell?ing)\b|\blimited access to (my )?e?mail\b|\bwill (respond|reply|get back) (to you )?(when|upon|on) (i|my) return/.test(t))
    return { kind: "out_of_office", why: "looks like an out-of-office auto reply" };
  if (/\b(unsubscribe( me)?|remove me|take me off|opt(ing)? (me )?out|stop (emailing|contacting|mailing|sending|writing)|do not (contact|email)|don'?t (contact|email) me|no more e?mails)\b/.test(t) && t.length < 600)
    return { kind: "unsubscribe", why: "the lead asked not to be contacted" };
  if (/^(auto|automated)[ :-]|ticket (#|number|id)|\[ticket|case (#|number)|thank you for (contacting|reaching out to|your (e?mail|message)).{0,80}(support|team|we will|we'll)/.test(subj + " " + t.slice(0, 300)) || /this is an automated (message|response|reply)|do not reply to this e?mail|this mailbox is (not|un)monitored/.test(t))
    return { kind: "auto_responder", why: "looks like an automated acknowledgement" };
  return null;
}

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

export interface ThreadMsg { stats_id?: string; direction: "inbound" | "outbound"; message_id?: string; time?: string; subject?: string; from?: string; to?: string; seq_number?: number; html?: string; text: string }

export function normaliseHistory(r: unknown): { messages: ThreadMsg[]; from?: string; to?: string } {
  const list = rowsOf(r, "history", "email_history", "message_history");
  const messages = list.map((m): ThreadMsg => {
    const type = String(pick(m, "type", "direction", "email_type") ?? "").toUpperCase();
    const html = pick(m, "email_body", "body", "html_body", "message");
    return {
      stats_id: pick(m, "stats_id", "email_stats_id") != null ? String(pick(m, "stats_id", "email_stats_id")) : undefined,
      direction: /REPLY|INBOUND|RECEIVED/.test(type) ? "inbound" : "outbound",
      message_id: pick(m, "message_id", "messageId"),
      time: pick(m, "time", "received_at", "sent_at", "sent_time", "reply_time", "created_at"),
      subject: pick(m, "subject", "email_subject"),
      from: pick(m, "from", "from_email", "sent_from"),
      to: pick(m, "to", "to_email", "sent_to"),
      seq_number: pick(m, "email_seq_number", "seq_number") != null ? Number(pick(m, "email_seq_number", "seq_number")) : undefined,
      html: typeof html === "string" ? html : undefined,
      text: htmlToText(typeof html === "string" ? html : ""),
    };
  });
  messages.sort((a, b) => new Date(a.time ?? 0).getTime() - new Date(b.time ?? 0).getTime());
  return { messages, from: pick(r, "from", "data.from"), to: pick(r, "to", "data.to") };
}

/** One master-inbox row → compact thread brief. */
export function threadBrief(row: Row, categories: Map<number, string>) {
  const catId = pick(row, "lead_category_id", "category.id", "category_id");
  const hist = normaliseHistory({ history: pick(row, "email_history", "message_history", "history") ?? [] }).messages;
  const lastIn = [...hist].reverse().find((m) => m.direction === "inbound");
  const lastBody = lastIn?.text ?? htmlToText(pick(row, "last_message.body", "last_reply_body", "reply_body"));
  const auto = lastBody ? detectAuto({ from: lastIn?.from ?? pick(row, "last_message.sent_from"), subject: lastIn?.subject ?? pick(row, "last_message.subject"), text: lastBody }) : null;
  return {
    lead_map_id: pick(row, "email_lead_map_id", "campaign_lead_map_id", "lead_map_id", "id"),
    lead_id: pick(row, "email_lead_id", "lead_id", "lead.id"),
    lead_email: pick(row, "lead_email", "lead.email", "email"),
    lead_name: [pick(row, "lead_first_name", "lead.first_name", "first_name"), pick(row, "lead_last_name", "lead.last_name", "last_name")].filter(Boolean).join(" ") || undefined,
    company: pick(row, "lead.company", "lead.company_name", "company_name", "lead_company_name"),
    campaign_id: pick(row, "email_campaign_id", "campaign_id", "campaign.id"),
    campaign: pick(row, "email_campaign_name", "campaign_name", "campaign.name"),
    mailbox_id: pick(row, "email_account_id", "email_account.id"),
    mailbox: pick(row, "email_account.email", "email_account_email", "from_email"),
    category_id: catId,
    category: catId != null ? categories.get(Number(catId)) ?? pick(row, "category.name", "lead_category_name") : "uncategorised",
    lead_status: pick(row, "lead_status", "email_status", "status"),
    last_reply_at: pick(row, "last_reply_time", "last_message.received_at", "reply_time") ?? lastIn?.time,
    last_sent_at: pick(row, "last_sent_time", "sent_time"),
    unread: pick(row, "has_new_unread_email") ?? (pick(row, "is_read") === false ? true : undefined),
    subject: lastIn?.subject ?? pick(row, "last_message.subject", "subject"),
    automated: auto ? auto.kind : undefined,
    they_wrote: untrusted("lead_email_reply", stripQuoted(lastBody ?? ""), 500),
  };
}

export function campaignBrief(c: Row) {
  const cron = pick(c, "scheduler_cron_value") ?? {};
  return {
    id: c.id, name: c.name, status: c.status, created_at: c.created_at, updated_at: c.updated_at, parent_campaign_id: c.parent_campaign_id,
    schedule: pick(cron, "tz", "timezone") ? { timezone: pick(cron, "tz", "timezone"), days_of_the_week: pick(cron, "days", "days_of_the_week"), start_hour: pick(cron, "startHour", "start_hour"), end_hour: pick(cron, "endHour", "end_hour") } : undefined,
    min_time_btw_emails: pick(c, "min_time_btwn_emails", "min_time_btw_emails"),
    max_new_leads_per_day: pick(c, "max_leads_per_day", "max_new_leads_per_day"),
  };
}

/** Whitelist — Smartlead returns SMTP/IMAP credentials on this endpoint; they must never reach the model. */
export function mailboxBrief(a: Row) {
  const w = (a.warmup_details ?? {}) as Row;
  const sent = Number(pick(w, "total_sent_count") ?? 0), spam = Number(pick(w, "total_spam_count") ?? 0);
  return {
    id: a.id, email: pick(a, "from_email", "email", "username"), from_name: a.from_name, type: a.type,
    daily_limit: pick(a, "message_per_day", "max_email_per_day"), sent_today: pick(a, "daily_sent_count"),
    min_wait_mins: a.minTimeToWaitInMins,
    smtp_ok: a.is_smtp_success, imap_ok: a.is_imap_success, smtp_error: a.smtp_failure_error || undefined, imap_error: a.imap_failure_error || undefined,
    campaigns: a.campaign_count, tags: Array.isArray(a.tags) ? a.tags.map((t: Row) => t.tag_name ?? t.name).filter(Boolean) : undefined,
    has_signature: a.signature ? true : false, custom_tracking_domain: a.custom_tracking_domain || undefined,
    warmup: a.warmup_details ? { status: pick(w, "status"), reputation: pick(w, "warmup_reputation", "reputation"), total_sent: sent || undefined, total_spam: spam || undefined, spam_rate_pct: sent > 0 ? Math.round((spam / sent) * 1000) / 10 : undefined, daily_cap: pick(w, "max_email_per_day", "total_warmup_per_day"), reply_rate: pick(w, "reply_rate"), blocked_reason: pick(w, "blocked_reason", "is_warmup_blocked") || undefined } : { status: "NOT_CONFIGURED" },
  };
}

// ---------------------------------------------------------------------------
// Small cached lookups (per request)
// ---------------------------------------------------------------------------

export async function fetchCategories(): Promise<Array<{ id: number; name: string; sentiment?: string }>> {
  const r = await sl("GET", "/leads/fetch-categories");
  return rowsOf(r).map((c) => ({ id: Number(c.id), name: String(c.name), sentiment: c.sentiment_type ?? undefined }));
}

export async function categoryMap(): Promise<Map<number, string>> {
  try { return new Map((await fetchCategories()).map((c) => [c.id, c.name])); } catch { return new Map(); }
}

export async function fetchCampaign(id: number): Promise<Row> {
  const c = body(await sl("GET", `/campaigns/${id}`));
  if (!c || typeof c !== "object" || Array.isArray(c) || !("id" in c || "name" in c)) throw new McpError("E_NOT_FOUND", `campaign ${id} not found`);
  return c as Row;
}

/** ACTIVE (Smartlead also says START for the action) = cold mail is going out. */
export const isLive = (status: unknown) => /^(ACTIVE|START|STARTED|RUNNING)$/i.test(String(status ?? ""));
export const isSafeToEdit = (status: unknown) => /^(DRAFTED|DRAFT|PAUSED|STOPPED|COMPLETED|ARCHIVED)$/i.test(String(status ?? ""));

export async function fetchAllMailboxes(maxPages = 5): Promise<Row[]> {
  const all: Row[] = [];
  for (let p = 0; p < maxPages; p++) {
    const page = rowsOf(await sl("GET", "/email-accounts/", { query: { offset: p * 100, limit: 100 } }));
    all.push(...page);
    if (page.length < 100) break;
  }
  return all;
}
