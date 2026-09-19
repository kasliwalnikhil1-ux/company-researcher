// smartlead-mcp/tools_mailboxes.ts — mailbox health (the highest-value reads): accounts, warmup, deliverability, placement tests.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, type Row, tool, z, McpError, rawParam, dateParam, mapPool, trim, pct, ymd } from "./ctx.ts";
import { sl, body, rowsOf, pick, mailboxBrief, fetchAllMailboxes } from "./smartlead.ts";

type Brief = ReturnType<typeof mailboxBrief>;

function problemsOf(m: Brief, ctx: Ctx): string[] {
  const p: string[] = [];
  if (m.smtp_ok === false) p.push(`SMTP failing${m.smtp_error ? `: ${String(m.smtp_error).slice(0, 120)}` : ""}`);
  if (m.imap_ok === false) p.push(`IMAP failing${m.imap_error ? `: ${String(m.imap_error).slice(0, 120)}` : ""} (replies will not be captured)`);
  const w = m.warmup as Row;
  if (w?.status && !/^ACTIVE$/i.test(String(w.status))) p.push(`warmup ${String(w.status).toLowerCase()}`);
  if (w?.blocked_reason) p.push(`warmup blocked: ${String(w.blocked_reason).slice(0, 120)}`);
  const rep = parseFloat(String(w?.reputation ?? ""));
  if (Number.isFinite(rep) && rep < ctx.settings.warmup_min_reputation) p.push(`warmup reputation ${rep}% < ${ctx.settings.warmup_min_reputation}%`);
  if (typeof w?.spam_rate_pct === "number" && w.spam_rate_pct / 100 > ctx.settings.warmup_spam_rate_threshold) p.push(`warmup spam rate ${w.spam_rate_pct}%`);
  if (m.daily_limit != null && m.sent_today != null && Number(m.sent_today) >= Number(m.daily_limit)) p.push("daily limit reached today");
  return p;
}

/** Per-mailbox sends/bounces over a window, keyed by lower-cased address. */
async function healthWindow(from: string, to: string): Promise<{ map: Map<string, Row>; raw: unknown }> {
  const r = await sl("GET", "/analytics/mailbox/name-wise-health-metrics", { query: { start_date: from, end_date: to, full_data: "true" } });
  const b = body(r);
  const rows = Array.isArray(b) ? b : rowsOf(b, "email_health_metrics", "health_metrics", "mailboxes");
  const map = new Map<string, Row>();
  for (const x of rows as Row[]) {
    const email = String(pick(x, "email_account", "from_email", "email", "name") ?? "").toLowerCase();
    if (!email) continue;
    const sent = Number(pick(x, "sent", "sent_count", "total_sent") ?? 0), bounced = Number(pick(x, "bounced", "bounce_count", "total_bounced") ?? 0);
    map.set(email, { sent, bounced, opened: Number(pick(x, "opened", "open_count") ?? 0), replied: Number(pick(x, "replied", "reply_count") ?? 0), unsubscribed: Number(pick(x, "unsubscribed", "unsubscribed_count") ?? 0), bounce_rate_pct: pct(bounced, sent), reply_rate_pct: pct(Number(pick(x, "replied", "reply_count") ?? 0), sent) });
  }
  return { map, raw: r };
}

export function registerMailboxes(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "list_email_accounts", title: "List mailboxes", cls: "read",
    description: "Every connected sending mailbox: address, provider, daily limit and sends today, SMTP/IMAP connection state, campaigns attached, tags, warmup status and reputation — plus `problems` per mailbox (connection failing, warmup paused/blocked, reputation under the threshold, daily limit hit). Credentials are never returned. Start a burn check here. problems_only:true returns just the mailboxes that need attention.",
    input: { problems_only: z.boolean().optional(), search: z.string().optional().describe("Substring of the address, domain or tag"), ...rawParam },
  }, async (a) => {
    const rows = await fetchAllMailboxes();
    let list = rows.map(mailboxBrief).map((m) => ({ ...m, problems: problemsOf(m, ctx) }));
    const total = list.length, withProblems = list.filter((m) => m.problems.length).length;
    if (a.search) { const s = a.search.toLowerCase(); list = list.filter((m) => String(m.email ?? "").toLowerCase().includes(s) || (m.tags ?? []).some((t: string) => t.toLowerCase().includes(s))); }
    if (a.problems_only) list = list.filter((m) => m.problems.length);
    const domains = new Map<string, number>();
    for (const m of list) { const d = String(m.email ?? "").split("@")[1] ?? "?"; domains.set(d, (domains.get(d) ?? 0) + 1); }
    return {
      total, with_problems: withProblems, shown: list.length, capacity_per_day: list.reduce((s, m) => s + (Number(m.daily_limit) || 0), 0), sent_today: list.reduce((s, m) => s + (Number(m.sent_today) || 0), 0),
      domains: Object.fromEntries([...domains.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30)),
      mailboxes: list.slice(0, 200),
      raw: a.raw ? trim(rows.slice(0, 2)) : undefined,
    };
  });

  tool(server, ctx, {
    name: "get_warmup_status", title: "Warmup status", cls: "read",
    description: "Warmup state for mailboxes: status, reputation, warmup mails sent vs landed in spam, and the last 7 days day by day (from Smartlead's warmup stats). Pass email_account_ids (≤25) or leave empty for the mailboxes that look unhealthy or are still warming (≤25). `still_warming` = warmup active and fewer than 14 days / low volume of history — do not recommend adding those to a live rotation.",
    input: { email_account_ids: z.array(z.number().int().positive()).max(25).optional(), ...rawParam },
  }, async (a) => {
    const all = (await fetchAllMailboxes()).map(mailboxBrief);
    let targets = a.email_account_ids?.length ? all.filter((m) => a.email_account_ids!.includes(Number(m.id))) : all.filter((m) => problemsOf(m, ctx).length > 0 || Number((m.warmup as Row)?.total_sent ?? 0) < 200);
    if (a.email_account_ids?.length && targets.length === 0) throw new McpError("E_NOT_FOUND", "none of those mailbox ids exist (see list_email_accounts)");
    const omitted = Math.max(0, targets.length - 25);
    targets = targets.slice(0, 25);
    let rawSample: unknown;
    const res = await mapPool(targets, 4, async (m) => {
      try {
        const r = await sl("GET", `/email-accounts/${m.id}/warmup-stats`);
        rawSample ??= r;
        const b = body(r) as Row;
        const days = rowsOf(b, "stats_by_date", "daily_stats", "stats").map((d) => ({ date: pick(d, "date", "day"), sent: Number(pick(d, "sent_count", "sent") ?? 0), spam: Number(pick(d, "spam_count", "spam") ?? 0), replied: pick(d, "reply_count", "replied") }));
        const sent7 = Number(pick(b, "sent_count", "total_sent") ?? days.reduce((s, d) => s + d.sent, 0)), spam7 = Number(pick(b, "spam_count") ?? days.reduce((s, d) => s + d.spam, 0));
        return { id: m.id, email: m.email, warmup: m.warmup, last_7d: { sent: sent7, spam: spam7, spam_rate_pct: pct(spam7, sent7), inbox: pick(b, "inbox_count"), reputation: pick(b, "reputation_score", "warmup_reputation") }, days, still_warming: /^ACTIVE$/i.test(String((m.warmup as Row)?.status)) && Number((m.warmup as Row)?.total_sent ?? 0) < 200 ? true : undefined, problems: problemsOf(m, ctx) };
      } catch (e) {
        return { id: m.id, email: m.email, warmup: m.warmup, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return { count: res.length, omitted: omitted || undefined, thresholds: { warmup_min_reputation: ctx.settings.warmup_min_reputation, warmup_spam_rate: ctx.settings.warmup_spam_rate_threshold }, mailboxes: res, raw: a.raw ? trim(rawSample) : undefined };
  });

  tool(server, ctx, {
    name: "get_account_deliverability", title: "Mailbox deliverability (burn check)", cls: "read",
    description: "Per-mailbox campaign sending over a window (default last 7 days): sent, bounced, bounce rate, reply rate, sends today vs daily limit, warmup spam rate — compared with the team thresholds, and with the previous window of the same length so you can see what MOVED. Every mailbox gets a verdict: `pull` (over the bounce threshold or connection failing — take it out of rotation today), `reduce` (trending up / warmup slipping), `warming` (not ready for rotation), `ok`. Recommendations only: apply them with update_campaign_settings (remove_email_account_ids) or pause_campaign after the human confirms.",
    input: { from: dateParam("Window start").optional(), to: dateParam("Window end (default today)").optional(), only_flagged: z.boolean().optional(), ...rawParam },
  }, async (a) => {
    const to = a.to ? new Date(a.to) : new Date();
    const from = a.from ? new Date(a.from) : new Date(to.getTime() - 6 * 86400_000);
    if (from > to) throw new McpError("E_PAYLOAD_INVALID", "from must be on or before to");
    const span = Math.round((to.getTime() - from.getTime()) / 86400_000) + 1;
    const prevTo = new Date(from.getTime() - 86400_000), prevFrom = new Date(prevTo.getTime() - (span - 1) * 86400_000);
    const [boxes, cur, prev] = await Promise.all([
      fetchAllMailboxes(),
      healthWindow(ymd(from), ymd(to)),
      healthWindow(ymd(prevFrom), ymd(prevTo)).catch(() => ({ map: new Map<string, Row>(), raw: null })),
    ]);
    const thr = ctx.settings.bounce_rate_threshold * 100;
    const list = boxes.map(mailboxBrief).map((m) => {
      const key = String(m.email ?? "").toLowerCase();
      const c = cur.map.get(key), p = prev.map.get(key);
      const problems = problemsOf(m, ctx);
      const br = c?.bounce_rate_pct as number | null | undefined, pbr = p?.bounce_rate_pct as number | null | undefined;
      const enough = (c?.sent ?? 0) >= 20;
      let verdict: "pull" | "reduce" | "warming" | "ok" = "ok"; const why: string[] = [];
      if (m.smtp_ok === false || m.imap_ok === false) { verdict = "pull"; why.push("connection failing"); }
      if (enough && br != null && br > thr) { verdict = "pull"; why.push(`bounce rate ${br}% > ${thr}% on ${c!.sent} sends`); }
      if (verdict === "ok" && enough && br != null && br > thr * 0.66) { verdict = "reduce"; why.push(`bounce rate ${br}% approaching ${thr}%`); }
      if (verdict === "ok" && br != null && pbr != null && enough && br - pbr >= 1 && br > thr * 0.5) { verdict = "reduce"; why.push(`bounce rate moved ${pbr}% → ${br}%`); }
      if (verdict === "ok" && problems.some((x) => /warmup (reputation|spam|blocked|paused|inactive)/i.test(x))) { verdict = "reduce"; why.push(...problems.filter((x) => /warmup/i.test(x))); }
      if (verdict === "ok" && /^ACTIVE$/i.test(String((m.warmup as Row)?.status)) && Number((m.warmup as Row)?.total_sent ?? 0) < 200) { verdict = "warming"; why.push("still building warmup history"); }
      return { id: m.id, email: m.email, verdict, why, window: c ?? { sent: 0 }, previous_window: p ? { sent: p.sent, bounce_rate_pct: p.bounce_rate_pct } : undefined, sent_today: m.sent_today, daily_limit: m.daily_limit, campaigns: m.campaigns, warmup_status: (m.warmup as Row)?.status, warmup_reputation: (m.warmup as Row)?.reputation, warmup_spam_rate_pct: (m.warmup as Row)?.spam_rate_pct };
    });
    const order = { pull: 0, reduce: 1, warming: 2, ok: 3 } as const;
    list.sort((x, y) => order[x.verdict] - order[y.verdict] || Number(y.window?.bounce_rate_pct ?? 0) - Number(x.window?.bounce_rate_pct ?? 0));
    const shown = a.only_flagged ? list.filter((m) => m.verdict !== "ok") : list;
    const counts = { pull: 0, reduce: 0, warming: 0, ok: 0 }; for (const m of list) counts[m.verdict]++;
    return {
      window: `${ymd(from)}..${ymd(to)}`, compared_with: `${ymd(prevFrom)}..${ymd(prevTo)}`, bounce_threshold_pct: thr, counts,
      summary: counts.pull + counts.reduce === 0 ? `All ${list.length} mailboxes inside the ${thr}% bounce threshold.` : list.filter((m) => m.verdict === "pull" || m.verdict === "reduce").slice(0, 15).map((m) => `${m.verdict.toUpperCase()} ${m.email}: ${m.why.join("; ")}`).join("\n"),
      note: cur.map.size === 0 ? "Smartlead returned no per-mailbox health rows for this window (no sends, or the analytics endpoint is not on this plan). Verdicts then rest on connection + warmup only." : undefined,
      mailboxes: shown.slice(0, 200),
      raw: a.raw ? trim(cur.raw) : undefined,
    };
  });

  tool(server, ctx, {
    name: "smart_delivery_test_results", title: "Inbox placement test results", cls: "read",
    description: "Smart Delivery (inbox placement) tests. Without spam_test_id: the latest tests (id, name, type, status, schedule). With spam_test_id: the outcome — placement per provider (inbox / promotions / spam) and per sender mailbox. Read-only: this connector never creates a test (they consume credits).",
    input: { spam_test_id: z.union([z.number(), z.string()]).optional(), test_type: z.enum(["manual", "auto"]).optional().describe("List filter (default both)"), limit: z.number().int().min(1).max(25).optional(), ...rawParam },
  }, async (a) => {
    if (a.spam_test_id === undefined) {
      const lim = a.limit ?? 10;
      const kinds = a.test_type ? [a.test_type] : ["manual", "auto"];
      const lists = await Promise.all(kinds.map((k) => sl("POST", "/spam-test/report", { base: "delivery", body: { testType: k, limit: lim, offset: 0 } }).then((r) => ({ k, r })).catch((e) => ({ k, r: null, error: e instanceof Error ? e.message : String(e) }))));
      const tests = lists.flatMap((x) => rowsOf(x.r, "tests", "spam_tests").map((t) => ({ spam_test_id: pick(t, "spam_test_id", "id"), name: pick(t, "test_name", "name"), type: pick(t, "test_type", "type") ?? x.k, status: pick(t, "status"), started: pick(t, "schedule_start_time", "created_at"), ends: pick(t, "test_end_date"), every_days: pick(t, "every_days"), run_no: pick(t, "current_test_run_no"), inbox_pct: pick(t, "inbox_percentage", "inbox_rate"), spam_pct: pick(t, "spam_percentage", "spam_rate") })));
      const errors = lists.filter((x) => "error" in x).map((x) => `${x.k}: ${(x as Row).error}`);
      return { count: tests.length, tests: tests.slice(0, lim * 2), errors: errors.length ? errors : undefined, note: tests.length === 0 ? "No placement tests found (or Smart Delivery is not enabled on this Smartlead plan)." : undefined, raw: a.raw ? trim(lists.map((x) => x.r)) : undefined };
    }
    const id = encodeURIComponent(String(a.spam_test_id));
    const safe = <T>(p: Promise<T>) => p.catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    const [details, providers, senders] = await Promise.all([
      safe(sl("GET", `/spam-test/${id}`, { base: "delivery" })),
      safe(sl("POST", `/spam-test/report/${id}/providerwise`, { base: "delivery", body: {} })),
      safe(sl("GET", `/spam-test/report/${id}/sender-account-wise`, { base: "delivery" })),
    ]);
    if ((details as Row)?.error && (providers as Row)?.error && (senders as Row)?.error) throw new McpError("E_NOT_FOUND", `no placement test ${a.spam_test_id}: ${(details as Row).error}`);
    return { spam_test_id: a.spam_test_id, test: trim(body(details), 10, 300), by_provider: trim(body(providers), 30, 200), by_sender: trim(body(senders), 60, 200) };
  });
}
