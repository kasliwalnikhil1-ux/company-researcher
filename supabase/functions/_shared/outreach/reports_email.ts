// HTML builders for the scheduled emails (weekly sender report, digest, client report).
// Every number printed here comes from a report RPC (outreach_report_*, outreach_sender_insights, outreach_dashboard):
// nothing is counted or re-computed in TypeScript apart from the "vs previous period" difference of two RPC numbers.
// The builders return the BODY only; notify.ts wraps it in the branded layout.
import { esc, accentOf, button, type Branding } from "./notify.ts";

type Row = Record<string, any>;

const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const fmt = (v: unknown): string => n(v).toLocaleString("en-US");
const pct = (v: unknown): string => (v === null || v === undefined || v === "" ? "–" : `${n(v)}%`);

function delta(cur: unknown, prev: unknown, isRate = false): string {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return "";
  const d = Math.round((n(cur) - n(prev)) * 10) / 10;
  if (d === 0) return `<span style="color:#888">no change</span>`;
  const colour = d > 0 ? "#15803d" : "#b91c1c";
  return `<span style="color:${colour}">${d > 0 ? "+" : ""}${isRate ? `${d} pts` : d.toLocaleString("en-US")}</span>`;
}

const TD = "padding:7px 10px;border-bottom:1px solid #eee;font-size:13px";
const TH = "padding:7px 10px;border-bottom:2px solid #ddd;font-size:12px;color:#666;text-align:left;font-weight:600";

interface MetricRow { label: string; key: string; rate?: boolean }

const TEAM_METRICS: MetricRow[] = [
  { label: "Leads enrolled", key: "enrolled" },
  { label: "Invitations sent", key: "invites" },
  { label: "Invitations accepted", key: "accepted" },
  { label: "Acceptance rate", key: "acceptance_rate", rate: true },
  { label: "LinkedIn messages", key: "messages" },
  { label: "InMails", key: "inmails" },
  { label: "Emails", key: "emails" },
  { label: "Replies", key: "replies" },
  { label: "Reply rate", key: "reply_rate", rate: true },
  { label: "Interested", key: "interested" },
  { label: "Meetings", key: "meetings" },
  { label: "Won", key: "won" },
];
const CLIENT_METRICS: MetricRow[] = TEAM_METRICS.filter((m) => !["enrolled", "inmails"].includes(m.key));
const SENDER_METRICS: MetricRow[] = [
  ...TEAM_METRICS.filter((m) => !["enrolled", "won"].includes(m.key)),
  { label: "Profile views", key: "profile_views" },
  { label: "Failed actions", key: "failed" },
  { label: "LinkedIn limit hits", key: "limit_hits" },
];

function metricsTable(metrics: MetricRow[], totals: Row, previous?: Row | null, headers: [string, string] = ["This period", "Change"]): string {
  const rows = metrics
    .filter((m) => m.rate || n(totals?.[m.key]) > 0 || n(previous?.[m.key]) > 0 || ["invites", "replies", "messages"].includes(m.key))
    .map((m) => `<tr><td style="${TD}">${esc(m.label)}</td><td style="${TD};text-align:right;font-weight:600">${m.rate ? pct(totals?.[m.key]) : fmt(totals?.[m.key])}</td>${previous ? `<td style="${TD};text-align:right">${delta(totals?.[m.key], previous?.[m.key], m.rate)}</td>` : ""}</tr>`).join("");
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:8px 0 16px"><tr><th style="${TH}">Metric</th><th style="${TH};text-align:right">${esc(headers[0])}</th>${previous ? `<th style="${TH};text-align:right">${esc(headers[1])}</th>` : ""}</tr>${rows}</table>`;
}

function periodLine(period: Row | undefined | null): string {
  if (!period?.from) return "";
  return `<p style="color:#666;font-size:13px;margin:0 0 12px">${esc(period.from)} to ${esc(period.to)}${period.timezone ? ` (${esc(period.timezone)})` : ""}${period.previous_from ? `, compared with ${esc(period.previous_from)} to ${esc(period.previous_to)}` : ""}</p>`;
}

const SEVERITY: Record<string, { label: string; colour: string }> = {
  high: { label: "Fix now", colour: "#b91c1c" }, medium: { label: "Worth a look", colour: "#b45309" }, low: { label: "Tip", colour: "#1d4ed8" }, ok: { label: "All good", colour: "#15803d" },
};

function recommendations(recs: Row[]): string {
  if (!recs?.length) return "";
  return `<ul style="padding:0;margin:8px 0 16px;list-style:none">${recs.map((r) => {
    const s = SEVERITY[String(r.severity)] ?? SEVERITY.low;
    return `<li style="margin:0 0 8px;padding:9px 12px;background:#f8f8f9;border-left:3px solid ${s.colour};border-radius:4px;font-size:13px"><b style="color:${s.colour}">${s.label}.</b> ${esc(r.text)}</li>`;
  }).join("")}</ul>`;
}

// ---------------------------------------------------------------------------
// Weekly sender report
// ---------------------------------------------------------------------------
export interface SenderSection { report: Row; insights: Row | null; aiSummary?: string | null; url: string }

/** One sender: numbers table (report_sender) + rule-based recommendations (sender_insights). The AI paragraph is optional. */
export function senderSectionHtml(s: SenderSection, branding: Branding = {}): string {
  const sd = s.report?.sender ?? {};
  const warm = s.insights?.warmup;
  const last30 = s.insights?.last_30_days;
  const facts = [
    `Status: <b>${esc(sd.status ?? "unknown")}</b>`, `Health: <b>${esc(sd.health ?? "–")}</b>`, `Warm-up level: <b>${esc(sd.level ?? "–")}</b>`,
    last30?.headroom_pct !== null && last30?.headroom_pct !== undefined ? `Unused invitation allowance (30 days): <b>${pct(last30.headroom_pct)}</b>` : "",
    last30?.network_growth !== null && last30?.network_growth !== undefined ? `Network growth (30 days): <b>${fmt(last30.network_growth)}</b>` : "",
  ].filter(Boolean).join(" · ");
  const failures = Object.entries((s.report?.failures_by_reason ?? {}) as Record<string, number>).sort((a, b) => n(b[1]) - n(a[1])).slice(0, 5);
  return `<div style="margin:0 0 28px">
  <h3 style="font-size:16px;margin:0 0 4px;color:${accentOf(branding)}">${esc(sd.name ?? "Sender")}</h3>
  <p style="font-size:13px;color:#444;margin:0 0 8px">${facts}</p>
  ${s.aiSummary ? `<p style="font-size:13px;margin:0 0 8px;padding:10px 12px;background:#f6f6f7;border-radius:6px"><span style="color:#666">Summary (written by AI from the numbers below):</span><br/>${esc(s.aiSummary).replace(/\n+/g, "<br/>")}</p>` : ""}
  ${metricsTable(SENDER_METRICS, s.report?.totals ?? {}, null, ["Last 7 days", ""])}
  ${failures.length ? `<p style="font-size:13px;margin:0 0 4px"><b>Why actions failed</b></p><ul style="font-size:13px;margin:0 0 12px;padding-left:18px">${failures.map(([reason, c]) => `<li>${esc(reason)}: ${fmt(c)}</li>`).join("")}</ul>` : ""}
  ${recommendations(s.insights?.recommendations ?? [])}
  ${warm?.unlocks ? `<p style="font-size:13px;color:#444;margin:0 0 10px"><b>Warm-up.</b> ${esc(warm.unlocks)}</p>` : ""}
  <p style="margin:0"><a href="${esc(s.url)}" style="color:${accentOf(branding)};font-size:13px">Open ${esc(sd.name ?? "sender")}</a></p>
</div>`;
}

export function senderReportHtml(sections: SenderSection[], period: Row | null, branding: Branding = {}): string {
  const summary = sections.length > 1
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:8px 0 24px"><tr><th style="${TH}">Sender</th><th style="${TH};text-align:right">Health</th><th style="${TH};text-align:right">Invites</th><th style="${TH};text-align:right">Accepted</th><th style="${TH};text-align:right">Replies</th><th style="${TH};text-align:right">Reply rate</th></tr>${sections.map((s) => {
      const t = s.report?.totals ?? {};
      return `<tr><td style="${TD}">${esc(s.report?.sender?.name ?? "Sender")}</td><td style="${TD};text-align:right">${esc(s.report?.sender?.health ?? "–")}</td><td style="${TD};text-align:right">${fmt(t.invites)}</td><td style="${TD};text-align:right">${fmt(t.accepted)}</td><td style="${TD};text-align:right">${fmt(t.replies)}</td><td style="${TD};text-align:right">${pct(t.reply_rate)}</td></tr>`;
    }).join("")}</table>` : "";
  return `${periodLine(period)}${summary}${sections.map((s) => senderSectionHtml(s, branding)).join("")}`;
}

// ---------------------------------------------------------------------------
// Weekly / monthly digest for owners and managers
// ---------------------------------------------------------------------------
export interface DigestInput { overview: Row; sequences: Row[]; attention: Row[]; origin: string; cadence: "weekly" | "monthly" }

const ATTENTION_LABEL: Record<string, string> = {
  sequence_stalled: "Sequence stopped sending", sender_running_dry: "Sender running out of leads", import_failed: "Import failed",
  held_leads: "Replies held for review", failed_leads: "Failed leads", sender: "Sender", sequence: "Sequence slowed down", ai_review: "AI lines to review",
};

function attentionLink(a: Row, origin: string): string {
  const k = String(a.kind);
  if (k === "sequence_stalled" || k === "sequence" || k === "held_leads" || k === "failed_leads") return `${origin}/outreach/sequences/${a.id}`;
  if (k === "sender_running_dry" || k === "sender") return `${origin}/outreach/senders/${a.id}`;
  if (k === "import_failed") return `${origin}/outreach/leads/import`;
  if (k === "ai_review") return `${origin}/outreach/ai-review`;
  return `${origin}/outreach`;
}

export function digestHtml(d: DigestInput, branding: Branding = {}): string {
  const top = (d.sequences ?? []).filter((q) => n(q.totals?.touches) > 0 || n(q.totals?.replies) > 0 || n(q.live) > 0).slice(0, 5);
  const seqTable = top.length
    ? `<h3 style="font-size:15px;margin:20px 0 4px">Top sequences</h3><table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin:8px 0 16px"><tr><th style="${TH}">Sequence</th><th style="${TH};text-align:right">Live leads</th><th style="${TH};text-align:right">Replies</th><th style="${TH};text-align:right">Reply rate</th><th style="${TH};text-align:right">Interested</th></tr>${top.map((q) =>
      `<tr><td style="${TD}"><a href="${esc(`${d.origin}/outreach/sequences/${q.sequence_id}`)}" style="color:#111">${esc(q.name)}</a>${q.stalled ? ` <span style="color:#b91c1c;font-size:12px">stopped</span>` : ""}</td><td style="${TD};text-align:right">${fmt(q.live)}</td><td style="${TD};text-align:right">${fmt(q.totals?.replies)}</td><td style="${TD};text-align:right">${pct(q.totals?.reply_rate)}</td><td style="${TD};text-align:right">${fmt(q.totals?.interested)}</td></tr>`).join("")}</table>`
    : "";
  const att = (d.attention ?? []).slice(0, 15);
  const attention = att.length
    ? `<h3 style="font-size:15px;margin:20px 0 4px">Needs attention</h3><ul style="font-size:13px;margin:8px 0 16px;padding-left:18px">${att.map((a) => `<li style="margin-bottom:5px"><b>${esc(ATTENTION_LABEL[String(a.kind)] ?? "Attention")}:</b> <a href="${esc(attentionLink(a, d.origin))}" style="color:#111">${esc(a.label ?? "")}</a>. ${esc(a.reason ?? "")}</li>`).join("")}${(d.attention ?? []).length > att.length ? `<li>and ${(d.attention ?? []).length - att.length} more on the dashboard</li>` : ""}</ul>`
    : `<p style="font-size:13px;color:#15803d;margin:16px 0">Nothing needs attention: no stopped sequences, no held or failed leads.</p>`;
  return `${periodLine(d.overview?.period)}
  ${metricsTable(TEAM_METRICS, d.overview?.totals ?? {}, d.overview?.previous ?? null, [d.cadence === "monthly" ? "This month" : "Last 7 days", "vs previous"])}
  ${attention}${seqTable}
  <p style="margin-top:18px">${button(`${d.origin}/outreach/reports`, "Open reports", branding)}</p>
  <p style="font-size:12px;color:#777">These are the same numbers the dashboard, the reports page, the connector and the API show. You can switch this email off in Reports.</p>`;
}

// ---------------------------------------------------------------------------
// Client report (white-label level 3). Goes to people outside the agency: no platform name, no internal links except the portal.
// ---------------------------------------------------------------------------
export interface ClientReportInput { report: Row; cadence: "weekly" | "monthly"; portalUrl: string }

export function clientReportHtml(c: ClientReportInput, branding: Branding = {}): string {
  const t = c.report?.totals ?? {};
  const headline = [
    n(t.replies) > 0 ? `<b>${fmt(t.replies)}</b> ${n(t.replies) === 1 ? "reply" : "replies"}` : "", n(t.interested) > 0 ? `<b>${fmt(t.interested)}</b> interested` : "",
    n(t.meetings) > 0 ? `<b>${fmt(t.meetings)}</b> ${n(t.meetings) === 1 ? "meeting" : "meetings"}` : "",
  ].filter(Boolean).join(", ");
  const senders = (c.report?.senders ?? []) as Row[];
  return `${periodLine(c.report?.period)}
  <p style="margin:0 0 12px">${headline ? `This ${c.cadence === "monthly" ? "month" : "week"}: ${headline}.` : `Here are the numbers for this ${c.cadence === "monthly" ? "month" : "week"}.`}</p>
  ${metricsTable(CLIENT_METRICS, t, c.report?.previous ?? null, [c.cadence === "monthly" ? "This month" : "This week", "vs previous"])}
  <p style="font-size:13px;color:#444;margin:0 0 6px">Leads in your workspace: <b>${fmt(c.report?.leads)}</b> · In a sequence right now: <b>${fmt(c.report?.live_enrollments)}</b>${senders.length ? ` · Profiles working for you: <b>${senders.length}</b>` : ""}</p>
  <p style="margin-top:18px">${button(c.portalUrl, "View the full report", branding)}</p>`;
}
