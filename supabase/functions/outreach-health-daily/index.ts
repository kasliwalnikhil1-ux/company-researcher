// F49 health-daily (health-page-PRD.md §7.3, §9.1, §11): hourly from pg_cron at :30; acts once a day at the hour set in
// Health settings (first value 09:00 Asia/Kolkata). `{"mode":"now"}` runs it at once (a second email that day).
//   1. advisors → db-9 (Supabase marks the endpoints experimental: no answer = grey, with the link)
//   2. outreach_ops_daily(): yesterday's snapshot, the upgrade answer, the stuck users, the email payload
//   3. the daily email, sent every day including when everything is fine (D8)
import { serve, admin, json, log, requireCron, readJson, localParts, SUPABASE_URL } from "../_shared/outreach/supabase.ts";
import { sendEmail } from "../_shared/outreach/notify.ts";
import { renderDaily, type DailyPayload } from "../_shared/outreach/health_email.ts";
import { reportItems } from "../_shared/health.ts";

const REF = (() => { try { return new URL(SUPABASE_URL).hostname.split(".")[0]; } catch { return ""; } })();
const MGMT_TOKEN = Deno.env.get("OUTREACH_MGMT_TOKEN") ?? "";

async function rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}
const record = (key: string, value: number | null, summary: string, evidence: unknown, status: string | null = null, error: string | null = null) =>
  rpc("outreach_ops_health_record", { p_key: key, p_value: value, p_summary: summary, p_evidence: evidence, p_status: status, p_error: error });

interface Lint { name: string; title: string; level: "ERROR" | "WARN" | "INFO"; detail?: string; categories?: string[]; remediation?: string }

async function advisors(): Promise<string> {
  if (!MGMT_TOKEN || !REF) { await record("db-9", null, "Couldn't check", null, "unknown", "OUTREACH_MGMT_TOKEN is not set (a Management API token with advisors_read)"); return "no token"; }
  const get = async (kind: "performance" | "security"): Promise<Lint[]> => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/advisors/${kind}`, { headers: { authorization: `Bearer ${MGMT_TOKEN}` }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`${kind} advisor answered ${r.status}`);
    const j = await r.json();
    return Array.isArray(j?.lints) ? j.lints : Array.isArray(j) ? j : [];
  };
  try {
    const [perf, sec] = await Promise.all([get("performance"), get("security")]);
    const group = (ls: Lint[]) => {
      const m = new Map<string, { name: string; title: string; level: string; count: number; examples: string[] }>();
      for (const l of ls) { const k = `${l.level}:${l.name}`; const g = m.get(k) ?? { name: l.name, title: l.title, level: l.level, count: 0, examples: [] }; g.count++; if (g.examples.length < 3 && l.detail) g.examples.push(String(l.detail).replace(/\\`/g, "`").slice(0, 160)); m.set(k, g); }
      return [...m.values()].sort((a, b) => ({ ERROR: 0, WARN: 1, INFO: 2 }[a.level as "ERROR"] ?? 3) - ({ ERROR: 0, WARN: 1, INFO: 2 }[b.level as "ERROR"] ?? 3) || b.count - a.count);
    };
    const secErr = sec.filter((l) => l.level === "ERROR").length, perfWarn = perf.filter((l) => l.level === "WARN").length, secWarn = sec.filter((l) => l.level === "WARN").length;
    const st = secErr > 0 ? "act" : perfWarn > 0 ? "watch" : "ok";
    await record("db-9", secErr + perfWarn, secErr > 0 ? `${secErr} security ${secErr === 1 ? "finding" : "findings"} at ERROR, ${perfWarn} performance at WARN.` : perfWarn > 0 ? `${perfWarn} performance ${perfWarn === 1 ? "finding" : "findings"} at WARN (${group(perf).find((g) => g.level === "WARN")?.title ?? ""}); ${secWarn} security at WARN, none at ERROR.` : "No security finding at ERROR and no performance finding at WARN.",
      { security: group(sec), performance: group(perf), counts: { security_error: secErr, security_warn: secWarn, performance_warn: perfWarn, performance_info: perf.filter((l) => l.level === "INFO").length } }, st);
    return `ok (${secErr} error, ${perfWarn} warn)`;
  } catch (e) {
    const why = String((e as any)?.message ?? e);
    await record("db-9", null, "Supabase didn't answer.", null, "unknown", why.slice(0, 300));
    return `error: ${why.slice(0, 120)}`;
  }
}

serve("outreach-health-daily", async (req) => {
  requireCron(req);
  const body = await readJson<{ mode?: string }>(req);
  const cfg = (await rpc<Record<string, any> | null>("outreach_ops_settings")) ?? {};
  const tz = String(cfg.time_zone ?? "Asia/Kolkata");
  const now = localParts(tz);
  const force = body.mode === "now";
  const due = force || (now.hour === Number(cfg.email_hour ?? 9) && cfg.last_daily_email_on !== now.date);
  if (!due) return json({ ok: true, skipped: "not the hour", local: now.iso, email_hour: cfg.email_hour, last: cfg.last_daily_email_on });

  const result: Record<string, unknown> = {};
  try { result.advisors = await advisors(); } catch (e) { result.advisors = `error: ${String((e as any)?.message ?? e).slice(0, 200)}`; }
  const to: string[] = Array.isArray(cfg.email_to) ? cfg.email_to : [];
  const payload = await rpc<DailyPayload>("outreach_ops_daily", { p_send: to.length > 0 });
  if (!to.length) {
    log({ fn: "health-daily", warn: "no recipients in Health settings; the daily email was not sent" });
    result.email = "no recipients";
  } else {
    const m = renderDaily(payload);
    let sent = 0;
    for (const addr of to) { if (await sendEmail(addr, m.subject, m.html, m.text)) sent++; }
    result.email = `${sent} of ${to.length} sent`; result.subject = m.subject;
    if (!sent) log({ fn: "health-daily", error: "the daily email could not be sent", to: to.length });
  }
  await rpc("outreach_ops_kv_set", { p_key: "daily_run", p_value: { ...result, at: new Date().toISOString(), forced: force } }).catch(() => {});
  reportItems(1);
  log({ fn: "health-daily", ...result });
  return json({ ok: true, ...result });
});
