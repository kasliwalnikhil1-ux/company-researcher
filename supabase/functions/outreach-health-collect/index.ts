// F48 health-collect (health-page-PRD.md §5, §9.2, §11): every 5 minutes from pg_cron, or `{"mode":"now"}` from "Check now".
//   1. the Supabase metrics endpoint → db-6 (CPU), db-7 (memory), db-8 (disk activity); keeps the last hour of samples and
//      a per-day tally for the upgrade answer (§7.3)
//   2. the Management API logs → fn-4 (functions stopped by Supabase: 546 / 504 / 503), app-2 (API gateway 5xx)
//   3. the urgent email: red immediate / urgent checks, recoveries, and the "checks have stopped" case (sys-1)
// Every result goes through outreach_ops_health_record, the same two-in-a-row rules as the SQL checks. A source that
// does not answer makes its checks grey, never green (D2).
import { serve, admin, json, log, requireCron, readJson, SUPABASE_URL, SERVICE_ROLE_KEY } from "../_shared/outreach/supabase.ts";
import { sendEmail } from "../_shared/outreach/notify.ts";
import { renderUrgent, renderRecovered, renderStale, type AlertsPayload, type AlertCheck } from "../_shared/outreach/health_email.ts";
import { reportItems } from "../_shared/health.ts";

const REF = (() => { try { return new URL(SUPABASE_URL).hostname.split(".")[0]; } catch { return ""; } })();
/** The metrics endpoint takes HTTP Basic `service_role:<secret key>`; the runtime's service key works, an explicit one wins. */
const METRICS_KEY = Deno.env.get("OUTREACH_METRICS_KEY") ?? SERVICE_ROLE_KEY;
/** A Management API token with analytics_logs_read (and advisors_read for health-daily). Without it the log checks are grey. */
const MGMT_TOKEN = Deno.env.get("OUTREACH_MGMT_TOKEN") ?? "";

async function rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}
const record = (key: string, value: number | null, summary: string, evidence: unknown, status: string | null = null, error: string | null = null) =>
  rpc("outreach_ops_health_record", { p_key: key, p_value: value, p_summary: summary, p_evidence: evidence, p_status: status, p_error: error });
const unknown = (key: string, why: string) => record(key, null, "Couldn't check", null, "unknown", why.slice(0, 300));

// ---------------------------------------------------------------------------------------------------------------
// 1. Metrics (Prometheus text). Counters need a previous sample: the first run only stores one.
// ---------------------------------------------------------------------------------------------------------------
interface Sample { at: number; cpu_idle: number; cpu_total: number; cpu_iowait: number; mem_total: number; mem_avail: number; swap_total: number; swap_free: number; reads: number; writes: number; io_time: number; fs_size: number; fs_avail: number }
interface Point { at: string; cpu: number; iowait: number; mem: number; swap: number; iops: number | null; iops_pct: number | null; util: number | null }

function parseMetrics(text: string): Sample {
  const s: Sample = { at: Date.now(), cpu_idle: 0, cpu_total: 0, cpu_iowait: 0, mem_total: 0, mem_avail: 0, swap_total: 0, swap_free: 0, reads: 0, writes: 0, io_time: 0, fs_size: 0, fs_avail: 0 };
  // the data disk is the device mounted at /data; fall back to the busiest device
  let dataDev = "";
  const disks: Record<string, { reads: number; writes: number; io_time: number }> = {};
  for (const line of text.split("\n")) {
    if (!line || line[0] === "#") continue;
    const sp = line.lastIndexOf(" ");
    const head = line.slice(0, sp), val = Number(line.slice(sp + 1));
    if (!Number.isFinite(val)) continue;
    const br = head.indexOf("{");
    const name = br < 0 ? head : head.slice(0, br);
    const labels = br < 0 ? "" : head.slice(br + 1, -1);
    const label = (k: string) => { const m = labels.match(new RegExp(`(?:^|,)${k}="([^"]*)"`)); return m ? m[1] : ""; };
    switch (name) {
      case "node_cpu_seconds_total": { const mode = label("mode"); s.cpu_total += val; if (mode === "idle") s.cpu_idle += val; if (mode === "iowait") s.cpu_iowait += val; break; }
      case "node_memory_MemTotal_bytes": s.mem_total = val; break;
      case "node_memory_MemAvailable_bytes": s.mem_avail = val; break;
      case "node_memory_SwapTotal_bytes": s.swap_total = val; break;
      case "node_memory_SwapFree_bytes": s.swap_free = val; break;
      case "node_filesystem_size_bytes": if (label("mountpoint") === "/data") { s.fs_size = val; dataDev = label("device").replace(/^\/dev\//, "").replace(/p?\d+$/, (m) => m.startsWith("p") ? "" : m); } break;
      case "node_filesystem_avail_bytes": if (label("mountpoint") === "/data") s.fs_avail = val; break;
      case "node_disk_reads_completed_total": case "node_disk_writes_completed_total": case "node_disk_io_time_seconds_total": {
        const d = label("device"); disks[d] ??= { reads: 0, writes: 0, io_time: 0 };
        if (name === "node_disk_reads_completed_total") disks[d].reads = val; else if (name === "node_disk_writes_completed_total") disks[d].writes = val; else disks[d].io_time = val;
        break;
      }
    }
  }
  const pick = disks[dataDev] ?? Object.values(disks).sort((a, b) => (b.reads + b.writes) - (a.reads + a.writes))[0];
  if (pick) { s.reads = pick.reads; s.writes = pick.writes; s.io_time = pick.io_time; }
  return s;
}

async function collectMetrics(cfg: Record<string, any>): Promise<string> {
  if (!REF || !METRICS_KEY) { for (const k of ["db-6", "db-7", "db-8"]) await unknown(k, "no project ref or metrics key"); return "no key"; }
  let text: string;
  try {
    const r = await fetch(`${SUPABASE_URL}/customer/v1/privileged/metrics`, { headers: { authorization: `Basic ${btoa(`service_role:${METRICS_KEY}`)}` }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`metrics endpoint answered ${r.status}`);
    text = await r.text();
  } catch (e) {
    const why = String((e as any)?.message ?? e);
    for (const k of ["db-6", "db-7", "db-8"]) await unknown(k, `Supabase metrics endpoint: ${why}`);
    return `metrics: ${why}`;
  }
  const cur = parseMetrics(text);
  const prev = await rpc<Sample | null>("outreach_ops_kv_get", { p_key: "metrics_prev" });
  await rpc("outreach_ops_kv_set", { p_key: "metrics_prev", p_value: cur });
  const history: Point[] = (await rpc<Point[] | null>("outreach_ops_kv_get", { p_key: "metrics_history" })) ?? [];
  const iopsLimit = Number(cfg.disk_iops ?? 3000) || 3000;

  const mem = cur.mem_total > 0 ? Math.round((1 - cur.mem_avail / cur.mem_total) * 1000) / 10 : 0;
  const swap = cur.swap_total > 0 ? Math.round(((cur.swap_total - cur.swap_free) / cur.swap_total) * 1000) / 10 : 0;
  const dt = prev ? (cur.at - prev.at) / 1000 : 0;
  const usable = prev && dt >= 60 && dt <= 1800 && cur.cpu_total >= prev.cpu_total;
  const cpu = usable ? Math.round((1 - (cur.cpu_idle - prev!.cpu_idle) / Math.max(1e-6, cur.cpu_total - prev!.cpu_total)) * 1000) / 10 : null;
  const iowait = usable ? Math.round(((cur.cpu_iowait - prev!.cpu_iowait) / Math.max(1e-6, cur.cpu_total - prev!.cpu_total)) * 1000) / 10 : null;
  const iops = usable ? Math.round(((cur.reads - prev!.reads) + (cur.writes - prev!.writes)) / dt) : null;
  const iopsPct = iops == null ? null : Math.round((iops / iopsLimit) * 1000) / 10;
  const util = usable ? Math.min(100, Math.round(((cur.io_time - prev!.io_time) / dt) * 1000) / 10) : null;
  const point: Point = { at: new Date(cur.at).toISOString(), cpu: cpu ?? 0, iowait: iowait ?? 0, mem, swap, iops, iops_pct: iopsPct, util };
  if (usable) history.push(point);
  while (history.length > 13) history.shift();
  await rpc("outreach_ops_kv_set", { p_key: "metrics_history", p_value: history });

  const last3 = history.slice(-3);
  const hour = history.slice(-12);
  const avg = (xs: number[]) => xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
  const ev = { samples: history, interval_s: Math.round(dt), compute_size: cfg.compute_size, mem_total_bytes: cur.mem_total, swap_total_bytes: cur.swap_total, iops_limit: iopsLimit, data_disk: { size_bytes: cur.fs_size, avail_bytes: cur.fs_avail } };

  // db-6 CPU: over 70% for an hour → watch; over 90% for 15 min → act
  if (cpu == null) await record("db-6", null, "Couldn't check", ev, "unknown", prev ? "two samples needed; the counters reset or the interval was odd" : "first sample taken; the next run has a rate");
  else {
    const st = last3.length >= 3 && last3.every((p) => p.cpu >= 90) ? "act" : hour.length >= 6 && (avg(hour.map((p) => p.cpu)) ?? 0) >= 70 ? "watch" : "ok";
    await record("db-6", cpu, `CPU at ${cpu}% (${iowait}% of it waiting on the disk); ${avg(hour.map((p) => p.cpu)) ?? cpu}% on average over the last ${hour.length * 5} minutes.`, ev, st);
  }
  // db-7 memory: over 80% → watch; over 90% or swap in use → act (swap counts once it holds more than 5% of its size for 15 min)
  {
    const swapUse = last3.length >= 3 ? last3.every((p) => p.swap >= 5) : swap >= 5;
    const st = mem >= Number(cfg.mem_act ?? 90) || swapUse ? "act" : mem >= Number(cfg.mem_watch ?? 80) ? "watch" : "ok";
    await record("db-7", mem, `${mem}% of memory in use; swap ${swap > 0 ? `${swap}% used` : "not used"}.${swapUse ? " Supabase: sustained swap means memory pressure and slows the database a lot." : ""}`, ev, st);
  }
  // db-8 disk activity: 70% of the compute size's IOPS for 15 min → watch; 90% → act
  if (iopsPct == null) await record("db-8", null, "Couldn't check", ev, "unknown", "two samples needed");
  else {
    const st = last3.length >= 3 && last3.every((p) => (p.iops_pct ?? 0) >= 90) ? "act" : last3.length >= 3 && last3.every((p) => (p.iops_pct ?? 0) >= 70) ? "watch" : "ok";
    await record("db-8", iopsPct, `${iops} IOPS, ${iopsPct}% of the ${iopsLimit} the disk allows; the disk was busy ${util}% of the time.`, ev, st);
  }
  // the per-day tally the upgrade answer reads (§7.3): samples with CPU > 80, memory > 85 or swap, connections ≥ 80
  const days: Record<string, { cpu_over_80: number; mem_over_85: number; conn_over_80: number }> = (await rpc("outreach_ops_kv_get", { p_key: "metrics_days" })) ?? {};
  const today = new Date().toISOString().slice(0, 10);
  const d = (days[today] ??= { cpu_over_80: 0, mem_over_85: 0, conn_over_80: 0 });
  if ((cpu ?? 0) > 80) d.cpu_over_80++;
  if (mem > 85 || swap >= 5) d.mem_over_85++;
  const conn = await rpc<{ value: number | null } | null>("outreach_ops_state", { p_key: "db-2" });
  if ((conn?.value ?? 0) >= 80) d.conn_over_80++;
  for (const k of Object.keys(days)) if (k < new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10)) delete days[k];
  await rpc("outreach_ops_kv_set", { p_key: "metrics_days", p_value: days });
  return "ok";
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Logs (Management API, ClickHouse SQL over the unified `logs` table; status code is the second field of the message)
// ---------------------------------------------------------------------------------------------------------------
async function logsQuery(sql: string, minutes: number): Promise<any[]> {
  const end = new Date(), start = new Date(end.getTime() - minutes * 60_000);
  const u = new URL(`https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs`);
  u.searchParams.set("sql", sql); u.searchParams.set("iso_timestamp_start", start.toISOString()); u.searchParams.set("iso_timestamp_end", end.toISOString());
  const r = await fetch(u, { headers: { authorization: `Bearer ${MGMT_TOKEN}` }, signal: AbortSignal.timeout(25_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(`logs API ${r.status}: ${String(j?.error ?? j?.message ?? "").slice(0, 200)}`);
  return Array.isArray(j?.result) ? j.result : [];
}
const fnOf = (url: string) => (url.match(/\/functions\/v1\/([a-z0-9_-]+)/i)?.[1] ?? url.split("?")[0].slice(-60));
const pathOf = (url: string) => { try { const u = new URL(url); return u.pathname.slice(0, 120); } catch { return url.split("?")[0].slice(0, 120); } };

async function collectLogs(): Promise<string> {
  if (!MGMT_TOKEN || !REF) { for (const k of ["fn-4", "app-2"]) await unknown(k, "OUTREACH_MGMT_TOKEN is not set (a Management API token with analytics_logs_read)"); return "no token"; }
  const out: string[] = [];
  // fn-4: functions stopped by Supabase in the last hour
  try {
    const rows = await logsQuery(`select splitByString(' | ', event_message)[2] as status, splitByString(' | ', event_message)[3] as url, count() as n from logs where source = 'function_edge_logs' and splitByString(' | ', event_message)[2] in ('546', '504', '503') group by status, url order by n desc limit 30`, 60);
    const total = rows.reduce((a, r) => a + Number(r.n ?? 0), 0);
    const byFn: Record<string, Record<string, number>> = {};
    for (const r of rows) { const f = fnOf(String(r.url ?? "")); (byFn[f] ??= {})[String(r.status)] = (byFn[f][String(r.status)] ?? 0) + Number(r.n ?? 0); }
    const list = Object.entries(byFn).map(([fn, codes]) => ({ fn, ...codes, total: Object.values(codes).reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total);
    const worst = list[0];
    await record("fn-4", total, total === 0 ? "Supabase stopped no function in the last hour." : `Supabase stopped ${total} ${total === 1 ? "run" : "runs"} in the last hour${worst ? `; most on ${worst.fn} (${Object.entries(byFn[worst.fn]).map(([c, n]) => `${n} × ${c}`).join(", ")})` : ""}.`, { rows: list, codes: { 546: "memory or CPU limit", 504: "no answer in time", 503: "could not start" } });
    out.push("fn-4 ok");
  } catch (e) { await unknown("fn-4", String((e as any)?.message ?? e)); out.push(`fn-4: ${String((e as any)?.message ?? e).slice(0, 80)}`); }
  // app-2: gateway 5xx, 15 min against the 15 min before
  try {
    const q = (m: number) => logsQuery(`select splitByString(' | ', event_message)[2] as status, count() as n from logs where source = 'edge_logs' group by status`, m);
    const [cur30, cur15] = await Promise.all([q(30), q(15)]);
    const sum = (rows: any[], f: (s: string) => boolean) => rows.filter((r) => f(String(r.status))).reduce((a, r) => a + Number(r.n ?? 0), 0);
    const total15 = sum(cur15, () => true), bad15 = sum(cur15, (s) => s >= "500" && s < "600" && s.length === 3);
    const bad30 = sum(cur30, (s) => s >= "500" && s < "600" && s.length === 3), prev15 = Math.max(0, bad30 - bad15);
    const pct = total15 ? Math.round((bad15 / total15) * 1000) / 10 : 0;
    const st = bad15 >= 20 && pct >= 1 && bad15 >= 2 * Math.max(1, prev15) ? "act" : bad15 >= 5 && pct >= 1 ? "watch" : "ok";
    let top: any[] = [];
    if (bad15 > 0) {
      try { top = (await logsQuery(`select splitByString(' | ', event_message)[2] as status, splitByString(' | ', event_message)[3] as url, count() as n from logs where source = 'edge_logs' and splitByString(' | ', event_message)[2] >= '500' and splitByString(' | ', event_message)[2] < '600' group by status, url order by n desc limit 10`, 15)).map((r) => ({ status: r.status, path: pathOf(String(r.url ?? "")), n: r.n })); } catch { /* evidence only */ }
    }
    await record("app-2", bad15, bad15 === 0 ? `${total15.toLocaleString()} requests in the last 15 minutes, none failed with a 5xx.` : `${bad15} of ${total15.toLocaleString()} requests (${pct}%) failed with a 5xx in the last 15 minutes; ${prev15} in the 15 minutes before.`, { requests_15m: total15, failed_15m: bad15, failed_prev_15m: prev15, rows: top }, st);
    out.push("app-2 ok");
  } catch (e) { await unknown("app-2", String((e as any)?.message ?? e)); out.push(`app-2: ${String((e as any)?.message ?? e).slice(0, 80)}`); }
  return out.join("; ");
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Urgent emails
// ---------------------------------------------------------------------------------------------------------------
async function sendAll(to: string[], m: { subject: string; html: string; text: string }): Promise<number> {
  let sent = 0;
  for (const addr of to) { if (await sendEmail(addr, m.subject, m.html, m.text)) sent++; }
  return sent;
}

async function alerts(): Promise<string> {
  const a = await rpc<AlertsPayload & { enabled: boolean; to: string[]; stale: boolean; last_run_at: string | null; sys1_alerted_at: string | null }>("outreach_ops_alerts");
  const to = Array.isArray(a.to) ? a.to : [];
  const out: string[] = [];
  if (!a.enabled || !to.length) {
    // nothing is sent, but the state still moves so a later switch-on does not replay old alerts
    if (a.due.length) await rpc("outreach_ops_alerts_mark", { p_keys: a.due.map((d) => d.key), p_status: "act" });
    if (a.recovered.length) await rpc("outreach_ops_alerts_mark", { p_keys: a.recovered.map((d) => d.key), p_status: null });
    return a.enabled ? "no recipients" : "off";
  }
  if (a.due.length) {
    const n = await sendAll(to, renderUrgent(a));
    await rpc("outreach_ops_alerts_mark", { p_keys: a.due.map((d: AlertCheck) => d.key), p_status: "act" });
    out.push(`urgent ${a.due.length} checks → ${n} emails`);
  }
  if (a.recovered.length) {
    const n = await sendAll(to, renderRecovered(a.recovered, a.time_zone));
    await rpc("outreach_ops_alerts_mark", { p_keys: a.recovered.map((d: AlertCheck) => d.key), p_status: null });
    out.push(`recovered ${a.recovered.length} → ${n} emails`);
  }
  // sys-1: the checks themselves have stopped (or started again)
  const alertedAt = a.sys1_alerted_at ? new Date(a.sys1_alerted_at).getTime() : 0;
  if (a.stale && (!alertedAt || Date.now() - alertedAt > 4 * 3600_000)) {
    const n = await sendAll(to, renderStale(true, a.last_run_at, a.time_zone));
    await rpc("outreach_ops_kv_set", { p_key: "sys1_alert", p_value: { at: new Date().toISOString() } });
    out.push(`sys-1 stale → ${n} emails`);
  } else if (!a.stale && alertedAt) {
    const n = await sendAll(to, renderStale(false, a.last_run_at, a.time_zone));
    await rpc("outreach_ops_kv_set", { p_key: "sys1_alert", p_value: null });
    out.push(`sys-1 recovered → ${n} emails`);
  }
  return out.join("; ") || "nothing due";
}

serve("outreach-health-collect", async (req) => {
  requireCron(req);
  const body = await readJson<{ mode?: string }>(req);
  const cfg = (await rpc<Record<string, any> | null>("outreach_ops_settings")) ?? {};
  const result: Record<string, string> = {};
  try { result.metrics = await collectMetrics(cfg); } catch (e) { result.metrics = `error: ${String((e as any)?.message ?? e).slice(0, 200)}`; }
  try { result.logs = await collectLogs(); } catch (e) { result.logs = `error: ${String((e as any)?.message ?? e).slice(0, 200)}`; }
  try { result.alerts = await alerts(); } catch (e) { result.alerts = `error: ${String((e as any)?.message ?? e).slice(0, 200)}`; }
  await rpc("outreach_ops_kv_set", { p_key: "collect", p_value: { ...result, mode: body.mode ?? "cron", at: new Date().toISOString() } }).catch(() => {});
  reportItems(3);
  log({ fn: "health-collect", ...result });
  return json({ ok: true, ...result });
});
