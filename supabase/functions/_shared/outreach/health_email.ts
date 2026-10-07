// The Health emails (health-page-PRD.md §9): the daily one with the verdict in its subject, the urgent one when a
// check turns red, and the recovery note. Plain text and simple HTML, readable on a phone, no customer message text
// and no lead names (D7): everything here comes from check summaries, counts and workspace names.
import { WEB_ORIGIN } from "./supabase.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const n = (v: unknown, unit?: string | null) => v == null ? "—" : `${typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("en-US") : v) : v}${unit === "%" ? "%" : ""}`;
const dateLabel = (iso: string, tz: string) => { try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(new Date(iso)); } catch { return iso.slice(0, 10); } };
const timeLabel = (iso: string | null | undefined, tz: string) => { if (!iso) return ""; try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); } catch { return iso; } };
export const healthUrl = (key?: string | null, tab?: string) => `${WEB_ORIGIN}/outreach/settings/admin/health${tab ? `?tab=${tab}` : key ? `?check=${encodeURIComponent(key)}` : ""}`;

const STYLE = `font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111;max-width:640px;margin:0 auto;padding:16px`;
const H = (t: string) => `<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#666;margin:18px 0 6px">${esc(t)}</div>`;
const dot = (s: string) => s === "act" ? "🔴" : s === "watch" ? "🟠" : s === "unknown" ? "⚪" : "🟢";
const MAX = 5;
function limited<T>(items: T[], render: (x: T) => string, plain = false): string {
  const shown = items.slice(0, MAX).map(render);
  if (items.length > MAX) shown.push(plain ? `and ${items.length - MAX} more` : `<div style="color:#666">and ${items.length - MAX} more</div>`);
  return shown.join(plain ? "\n" : "");
}

interface Item { key: string; name: string; summary: string | null; value: number | null; unit: string | null; act_at: number | null; watch_at: number | null }
const limitText = (i: Item) => i.act_at != null ? ` (act at ${n(i.act_at, i.unit)})` : i.watch_at != null ? ` (watch at ${n(i.watch_at, i.unit)})` : "";

export interface DailyPayload {
  date: string; time_zone: string; to: string[];
  counts: { act: number; watch: number; ok: number; unknown: number; total: number };
  act: Item[]; watch: Item[]; unknown: string[]; snoozed: Array<{ name: string; until: string; reason: string }>;
  upgrade: { answer: string; text: string } | null;
  yesterday: Array<{ label: string; y?: number | null; a?: number | null; unit?: string; text?: string }>;
  usage: Array<{ key: string; label: string; used: number | null; limit: number | null; unit: string; pct: number | null; reached_on: string | null; month_estimate: number | null }>;
  ai_spend: { spend_usd: number | null; budget_usd: number | null; pct: number | null } | null;
  stuck: Array<{ workspace: string; workspace_id: string; count: number; signals: Array<{ code: string; detail: Record<string, unknown> }> }>;
  new_since: string[]; fixed_since: string[]; manual_age_days: number | null; remind_recheck: boolean; remind_manual: boolean;
}

const SIGNAL_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  S1: () => "signed up, no sender connected", S2: (d) => `started connecting a sender ${d.attempts ?? "several"} times`, S3: () => "sequence created, not started",
  S4: () => "sequence started, nothing sent", S5: () => "opened “Why isn't it sending” again and again", S6: () => "hit the same error repeatedly", S7: () => "the same form keeps rejecting",
  S8: () => "an import failed or brought in no leads", S9: () => "sender disconnected, no reconnect", S10: () => "clicked the same control over and over",
};
export const signalText = (code: string, d: Record<string, unknown> = {}) => (SIGNAL_TEXT[code] ?? (() => code))(d);

const bytes = (v: number | null) => v == null ? "—" : v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(1)} GB` : v >= 1024 ** 2 ? `${Math.round(v / 1024 ** 2)} MB` : `${Math.round(v / 1024)} KB`;
const usageVal = (u: DailyPayload["usage"][number]) => u.unit === "bytes" ? bytes(u.used) : u.used == null ? "—" : u.used >= 1e6 ? `${(u.used / 1e6).toFixed(1)} M` : n(u.used);
const usageLim = (u: DailyPayload["usage"][number]) => u.unit === "bytes" ? bytes(u.limit) : u.limit == null ? "—" : u.limit >= 1e6 ? `${(u.limit / 1e6).toFixed(0)} M` : n(u.limit);

export function renderDaily(p: DailyPayload): { subject: string; html: string; text: string } {
  const day = dateLabel(p.date, p.time_zone);
  const verdict = p.counts.act > 0 ? `ACT NOW · ${(p.act[0]?.name ?? "a check is red").toLowerCase()}` : p.counts.watch > 0 ? `${p.counts.watch} to watch` : "all fine";
  const subject = `Health · ${verdict} · ${day}`;
  const headline = `${p.counts.act} needs action · ${p.counts.watch} to watch · ${p.counts.ok} fine · ${p.counts.unknown} couldn't check`;
  const item = (s: string) => (i: Item) => `<div style="margin:4px 0">${dot(s)} <b>${esc(i.name)}</b> — ${esc(i.summary ?? "")}${esc(limitText(i))} <a href="${healthUrl(i.key)}">See the steps</a></div>`;
  const itemT = (s: string) => (i: Item) => `${dot(s)} ${i.name} — ${i.summary ?? ""}${limitText(i)}  ${healthUrl(i.key)}`;
  const yRows = p.yesterday.map((r) => `<tr><td style="padding:2px 8px 2px 0">${esc(r.label)}</td><td style="text-align:right;padding:2px 8px">${r.text != null ? esc(r.text) : esc(n(r.y, r.unit))}</td><td style="text-align:right;color:#666;padding:2px 0 2px 8px">${r.text != null ? "" : esc(n(r.a, r.unit))}</td></tr>`).join("");
  const yText = p.yesterday.map((r) => `${r.label.padEnd(32)} ${(r.text ?? n(r.y, r.unit)).toString().padStart(10)} ${r.text != null ? "" : n(r.a, r.unit).toString().padStart(12)}`).join("\n");
  const uRows = p.usage.map((u) => `<tr><td style="padding:2px 8px 2px 0">${esc(u.label)}</td><td style="padding:2px 8px">${esc(usageVal(u))} of ${esc(usageLim(u))}</td><td style="text-align:right;padding:2px 8px">${u.pct == null ? "—" : `${u.pct}%`}</td><td style="color:#666;padding:2px 0 2px 8px">${u.reached_on ? `reaches the limit around ${esc(dateLabel(u.reached_on, p.time_zone))}` : u.month_estimate != null ? `on track for ${esc(n(Math.round(u.month_estimate)))}` : ""}</td></tr>`).join("");
  const uText = p.usage.map((u) => `${u.label.padEnd(26)} ${usageVal(u)} of ${usageLim(u)}  ${u.pct == null ? "" : `${u.pct}%`}  ${u.reached_on ? `limit around ${dateLabel(u.reached_on, p.time_zone)}` : u.month_estimate != null ? `on track for ${n(Math.round(u.month_estimate))}` : ""}`).join("\n");
  const spend = p.ai_spend?.budget_usd != null ? `<tr><td style="padding:2px 8px 2px 0">AI spend</td><td style="padding:2px 8px">$${p.ai_spend.spend_usd ?? 0} of $${p.ai_spend.budget_usd}</td><td style="text-align:right;padding:2px 8px">${p.ai_spend.pct ?? 0}%</td><td></td></tr>` : "";
  const stuck = (s: DailyPayload["stuck"][number]) => `<div style="margin:4px 0"><b>${esc(s.workspace)}</b> — ${esc(s.signals.slice(0, 2).map((x) => signalText(x.code, x.detail)).join("; "))} <a href="${WEB_ORIGIN}/outreach/settings/admin?workspace=${s.workspace_id}">Open</a></div>`;
  const stuckT = (s: DailyPayload["stuck"][number]) => `${s.workspace} — ${s.signals.slice(0, 2).map((x) => signalText(x.code, x.detail)).join("; ")}  ${WEB_ORIGIN}/outreach/settings/admin?workspace=${s.workspace_id}`;
  const ranLine = `${p.counts.total - p.counts.unknown} of ${p.counts.total} checks ran.${p.unknown.length ? ` Couldn't check: ${p.unknown.join(", ")}.` : ""} Snoozed: ${p.snoozed.length ? p.snoozed.map((s) => `${s.name} (${s.reason})`).join(", ") : "none"}.`;
  const reminders = [
    p.remind_manual ? `Egress and Realtime numbers are ${p.manual_age_days == null ? "not entered yet" : `${p.manual_age_days} days old`}. Update them.` : "",
    p.remind_recheck ? "It has been a month since the Supabase limits and prices were rechecked. Recheck them on the Usage tab." : "",
  ].filter(Boolean);

  const html = `<div style="${STYLE}">
<div style="font-size:16px;font-weight:600">${esc(headline)}</div>
${p.act.length ? H("Needs action") + limited(p.act, item("act")) : ""}
${p.watch.length ? H("To watch") + limited(p.watch, item("watch")) : ""}
${H("Do I need to upgrade?")}<div>${esc(p.upgrade?.text ?? "Not worked out yet.")} <a href="${healthUrl(null, "usage")}">Why</a></div>
${H("Yesterday")}<table style="border-collapse:collapse"><tr><th></th><th style="text-align:right;font-weight:normal;color:#666;padding:2px 8px">Yesterday</th><th style="text-align:right;font-weight:normal;color:#666;padding:2px 0 2px 8px">7-day average</th></tr>${yRows}</table>
${H("Usage this month")}<table style="border-collapse:collapse">${uRows}${spend}</table>
${p.stuck.length ? H(`Stuck users (${p.stuck.length})`) + limited(p.stuck, stuck) : ""}
${p.new_since.length ? `<div style="margin-top:14px"><b>NEW SINCE YESTERDAY:</b> ${esc(p.new_since.join(", "))}</div>` : ""}
${p.fixed_since.length ? `<div><b>FIXED SINCE YESTERDAY:</b> ${esc(p.fixed_since.join(", "))}</div>` : ""}
${reminders.map((r) => `<div style="margin-top:10px;color:#8a5a00">${esc(r)} <a href="${healthUrl(null, "usage")}">Usage tab</a></div>`).join("")}
<div style="margin-top:16px;color:#666;font-size:12px">${esc(ranLine)} <a href="${healthUrl()}">Open Health</a></div>
</div>`;
  const text = [headline, "",
    p.act.length ? `NEEDS ACTION\n${limited(p.act, itemT("act"), true)}\n` : "",
    p.watch.length ? `TO WATCH\n${limited(p.watch, itemT("watch"), true)}\n` : "",
    `DO I NEED TO UPGRADE?\n${p.upgrade?.text ?? "Not worked out yet."}  ${healthUrl(null, "usage")}\n`,
    `YESTERDAY${" ".repeat(26)}Yesterday  7-day average\n${yText}\n`,
    `USAGE THIS MONTH\n${uText}${p.ai_spend?.budget_usd != null ? `\nAI spend                   $${p.ai_spend.spend_usd ?? 0} of $${p.ai_spend.budget_usd}  ${p.ai_spend.pct ?? 0}%` : ""}\n`,
    p.stuck.length ? `STUCK USERS (${p.stuck.length})\n${limited(p.stuck, stuckT, true)}\n` : "",
    p.new_since.length ? `NEW SINCE YESTERDAY: ${p.new_since.join(", ")}` : "", p.fixed_since.length ? `FIXED SINCE YESTERDAY: ${p.fixed_since.join(", ")}` : "",
    ...reminders, "", ranLine, healthUrl()].filter((l) => l !== "").join("\n");
  return { subject, html, text };
}

export interface AlertCheck extends Item { since: string | null; evidence: Record<string, unknown> | null; status: string }
export interface AlertsPayload {
  due: AlertCheck[]; recovered: AlertCheck[]; time_zone: string;
  ai_outage: { failed_replies: Array<{ workspace: string; count: number }>; fallback_lines: Array<{ workspace: string; count: number }> };
}

/** The first five rows of each evidence list, as "a: 1, b: 2" lines. Keys that are not lists are shown as one line. */
function evidenceLines(ev: Record<string, unknown> | null): string[] {
  if (!ev) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(ev)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") {
      const rows = (v as Array<Record<string, unknown>>).slice(0, MAX).map((r) => Object.entries(r).filter(([kk]) => !/_id$/.test(kk) && kk !== "query").map(([kk, vv]) => `${kk} ${typeof vv === "object" ? JSON.stringify(vv) : String(vv ?? "")}`).join(", "));
      if (rows.length) out.push(`${k.replace(/_/g, " ")}: ${rows.join(" · ")}${v.length > MAX ? ` · and ${v.length - MAX} more` : ""}`);
    } else if (v != null && typeof v !== "object" && !/_id$/.test(k) && k !== "live_query") out.push(`${k.replace(/_/g, " ")}: ${String(v)}`);
  }
  return out.slice(0, 8);
}

export function renderUrgent(p: AlertsPayload): { subject: string; html: string; text: string } {
  const first = p.due[0];
  const subject = `ACT NOW · ${first.name.toLowerCase()}${first.value != null ? ` · ${n(first.value, first.unit)}` : ""}${p.due.length > 1 ? ` · and ${p.due.length - 1} more` : ""}`;
  const aiHit = p.due.some((d) => d.key === "api-1.ai");
  const block = (d: AlertCheck) => `<div style="margin:12px 0;padding:10px 12px;border-left:3px solid #d33;background:#fff5f5"><b>🔴 ${esc(d.name)}</b> — ${esc(d.summary ?? "")}${esc(limitText(d))}<div style="color:#666;font-size:12px">Red since ${esc(timeLabel(d.since, p.time_zone))}</div>${evidenceLines(d.evidence).map((l) => `<div style="font-size:12px;margin-top:4px">• ${esc(l)}</div>`).join("")}<div style="margin-top:6px"><a href="${healthUrl(d.key)}">See the steps</a></div></div>`;
  const blockT = (d: AlertCheck) => [`🔴 ${d.name} — ${d.summary ?? ""}${limitText(d)}`, `Red since ${timeLabel(d.since, p.time_zone)}`, ...evidenceLines(d.evidence).map((l) => `• ${l}`), healthUrl(d.key)].join("\n");
  const ai = aiHit ? `${H("What the AI outage affected (last hour)")}<div>AI replies that failed: ${p.ai_outage.failed_replies.length ? esc(p.ai_outage.failed_replies.map((x) => `${x.workspace} ${x.count}`).join(", ")) : "none"}</div><div>Lines that used their fallback: ${p.ai_outage.fallback_lines.length ? esc(p.ai_outage.fallback_lines.map((x) => `${x.workspace} ${x.count}`).join(", ")) : "none"}</div>` : "";
  const aiT = aiHit ? `\nWHAT THE AI OUTAGE AFFECTED (LAST HOUR)\nAI replies that failed: ${p.ai_outage.failed_replies.length ? p.ai_outage.failed_replies.map((x) => `${x.workspace} ${x.count}`).join(", ") : "none"}\nLines that used their fallback: ${p.ai_outage.fallback_lines.length ? p.ai_outage.fallback_lines.map((x) => `${x.workspace} ${x.count}`).join(", ") : "none"}` : "";
  const html = `<div style="${STYLE}"><div style="font-size:16px;font-weight:600">${p.due.length === 1 ? "A check turned red" : `${p.due.length} checks turned red`}</div>${p.due.map(block).join("")}${ai}<div style="margin-top:16px;color:#666;font-size:12px">You get this once, then again after 4 hours if it is still red, and once when it recovers. Snoozing the check on the Health page silences it. <a href="${healthUrl()}">Open Health</a></div></div>`;
  const text = [p.due.length === 1 ? "A check turned red" : `${p.due.length} checks turned red`, "", ...p.due.map(blockT).flatMap((b) => [b, ""]), aiT, "You get this once, then again after 4 hours if it is still red, and once when it recovers. Snoozing the check on the Health page silences it.", healthUrl()].join("\n");
  return { subject, html, text };
}

export function renderRecovered(items: AlertCheck[], tz: string): { subject: string; html: string; text: string } {
  const subject = `Recovered · ${items.map((i) => i.name.toLowerCase()).slice(0, 3).join(", ")}${items.length > 3 ? ` and ${items.length - 3} more` : ""}`;
  const html = `<div style="${STYLE}"><div style="font-size:16px;font-weight:600">Back to green</div>${items.map((i) => `<div style="margin:6px 0">🟢 <b>${esc(i.name)}</b> — ${esc(i.summary ?? "")} <span style="color:#666;font-size:12px">${esc(timeLabel(i.since, tz))}</span></div>`).join("")}<div style="margin-top:12px"><a href="${healthUrl()}">Open Health</a></div></div>`;
  const text = ["Back to green", ...items.map((i) => `🟢 ${i.name} — ${i.summary ?? ""} (${timeLabel(i.since, tz)})`), "", healthUrl()].join("\n");
  return { subject, html, text };
}

export function renderStale(stale: boolean, lastRunAt: string | null, tz: string): { subject: string; html: string; text: string } {
  const subject = stale ? "ACT NOW · the health checks have stopped" : "Recovered · the health checks are running again";
  const body = stale
    ? `ops.health_run() last ran ${lastRunAt ? timeLabel(lastRunAt, tz) : "never"}. The numbers on the Health page are old. See guide G16: the scheduler may have stopped, or a check's SQL has an error.`
    : `ops.health_run() ran at ${timeLabel(lastRunAt, tz)}.`;
  return { subject, html: `<div style="${STYLE}"><div style="font-size:16px;font-weight:600">${esc(subject)}</div><div style="margin-top:8px">${esc(body)}</div><div style="margin-top:12px"><a href="${healthUrl("sys-1")}">Open Health</a></div></div>`, text: `${subject}\n\n${body}\n${healthUrl("sys-1")}` };
}
