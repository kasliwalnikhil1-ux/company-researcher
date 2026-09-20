/// <reference lib="deno.ns" />
// scripts/outreach-parity-test.ts — "one source of numbers" parity test (product plan item 2, done-when).
//
// Fails (exit 1) if any number differs between the three places a user can read it:
//   A. the dashboard RPC      outreach_dashboard(p_ws).last_7_days
//   B. the report RPC         outreach_report_overview(p_ws, null, from, to).totals     (same 7 days)
//   C. the Claude connector   MCP tools `report_overview` and `dashboard` over HTTP, same JWT
//
// Checks, every numeric key of the totals object (nested `intents` included):
//   1. dashboard.last_7_days            == report_overview.totals          (RPC vs RPC)
//   2. MCP report_overview.totals       == report_overview.totals          (connector vs RPC)
//   3. MCP report_overview.previous     == report_overview.previous
//   4. MCP dashboard.last_7_days/.today == dashboard RPC last_7_days/.today
//
// Usage (from the repo root; reads .env.local):
//   ./scripts/outreach-parity-test.sh                 # all checks
//   ./scripts/outreach-parity-test.sh --rpc-only      # check 1 only (no connector call)
//   ./scripts/outreach-parity-test.sh --workspace <id|slug>
//   deno run --allow-net --allow-read --allow-env scripts/outreach-parity-test.ts [flags]
//
// Needs in .env.local (or the environment): NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
// OUTREACH_TEST_EMAIL, OUTREACH_TEST_PASSWORD. Optional: OUTREACH_MCP_URL to point at another connector.
//
// The range is "today and the 6 days before it" in the workspace timezone (settings.timezone), which is
// exactly what the dashboard uses. The data is live, so an action executed between two calls can show up
// as a one-off difference: the script re-runs a failing check once before it reports it.
//
// NOTE: check 2–4 only pass once the connector in supabase/functions/outreach-mcp is DEPLOYED. The old
// connector computed its own figures and returns a different shape; the script then prints what is missing.

type Json = Record<string, any>;

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try { text = Deno.readTextFileSync(path); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = loadEnv(new URL("../.env.local", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const env = (k: string) => Deno.env.get(k) ?? fileEnv[k] ?? "";
const SUPABASE_URL = (env("NEXT_PUBLIC_SUPABASE_URL") || env("SUPABASE_URL")).replace(/\/+$/, "");
const ANON = env("NEXT_PUBLIC_SUPABASE_ANON_KEY") || env("SUPABASE_ANON_KEY");
const EMAIL = env("OUTREACH_TEST_EMAIL"), PASSWORD = env("OUTREACH_TEST_PASSWORD");
const MCP_URL = env("OUTREACH_MCP_URL") || `${SUPABASE_URL}/functions/v1/outreach-mcp/mcp`;
const args = [...Deno.args];
const RPC_ONLY = args.includes("--rpc-only");
const WS_ARG = args.includes("--workspace") ? args[args.indexOf("--workspace") + 1] : env("OUTREACH_TEST_WORKSPACE");

if (!SUPABASE_URL || !ANON || !EMAIL || !PASSWORD) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / OUTREACH_TEST_EMAIL / OUTREACH_TEST_PASSWORD (.env.local).");
  Deno.exit(2);
}

async function signIn(): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`sign-in failed (${r.status}): ${j.error_description ?? j.msg ?? JSON.stringify(j)}`);
  return j.access_token as string;
}

async function rpc<T = Json>(jwt: string, fn: string, body: Json): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn} → ${r.status}: ${t.slice(0, 400)}`);
  return JSON.parse(t) as T;
}

let rpcId = 0;
/** JSON-RPC tools/call against the Streamable HTTP endpoint (the reply is JSON or a one-event SSE stream). */
async function mcpTool(jwt: string, name: string, toolArgs: Json): Promise<Json> {
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, apikey: ANON, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: toolArgs } }),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`MCP ${name} → HTTP ${r.status}: ${raw.slice(0, 300)}`);
  let msg: Json | null = null;
  if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of raw.split(/\r?\n/)) if (line.startsWith("data:")) { try { const j = JSON.parse(line.slice(5).trim()); if (j.id !== undefined) msg = j; } catch { /* keep looking */ } }
  } else msg = JSON.parse(raw);
  if (!msg) throw new Error(`MCP ${name}: no JSON-RPC message in the response`);
  if (msg.error) throw new Error(`MCP ${name} → JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
  const text = msg.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`MCP ${name}: empty tool result`);
  const body = JSON.parse(text);
  if (msg.result?.isError || body?.error === true) throw new Error(`MCP ${name} → tool error ${body.code}: ${body.message}`);
  return body;
}

function todayIn(tz: string): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
function shift(d: string, days: number): string { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10); }

/** Flatten every numeric (or null-rate) leaf: {"replies": 3, "intents.interested": 1, …}. */
function numericLeaves(o: unknown, prefix = "", out: Record<string, number | null> = {}): Record<string, number | null> {
  if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o as Json)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number" || v === null) out[key] = v as number | null;
    else if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) out[key] = Number(v);
    else if (v && typeof v === "object") numericLeaves(v, key, out);
  }
  return out;
}

interface Diff { key: string; a: unknown; b: unknown }
/**
 * Compare every numeric key of `reference` with `other`. The connector drops null values from its output
 * (token economy), so a key missing on the `other` side equals null; a key missing while the reference
 * holds a NUMBER is a difference.
 */
function compare(reference: unknown, other: unknown): { keys: number; diffs: Diff[] } {
  const A = numericLeaves(reference), B = numericLeaves(other);
  const diffs: Diff[] = [];
  for (const [k, va] of Object.entries(A)) {
    const vb = k in B ? B[k] : null;
    if (va !== vb) diffs.push({ key: k, a: va, b: k in B ? vb : "(missing)" });
  }
  return { keys: Object.keys(A).length, diffs };
}

let failures = 0;
async function check(title: string, left: string, right: string, run: () => Promise<{ ref: unknown; other: unknown }>): Promise<void> {
  const once = async () => { const x = await run(); return compare(x.ref, x.other); };
  let res = await once();
  if (res.diffs.length) { await new Promise((r) => setTimeout(r, 1500)); res = await once(); } // live data: one retry
  if (!res.diffs.length) { console.log(`PASS  ${title}: ${res.keys} numeric keys identical`); return; }
  failures++;
  console.log(`FAIL  ${title}: ${res.diffs.length} of ${res.keys} numeric keys differ`);
  console.log(`      ${"key".padEnd(28)} ${left.padEnd(24)} ${right}`);
  for (const d of res.diffs) console.log(`      ${d.key.padEnd(28)} ${String(d.a).padEnd(24)} ${String(d.b)}`);
}

// ---------------------------------------------------------------------------------------------------
const jwt = await signIn();
const workspaces = await rpc<Json[]>(jwt, "outreach_my_workspaces", {});
const ws = WS_ARG ? workspaces.find((w) => w.id === WS_ARG || w.slug === WS_ARG) : workspaces[0];
if (!ws) { console.error(`No workspace${WS_ARG ? ` "${WS_ARG}"` : ""} for ${EMAIL}. Available: ${workspaces.map((w) => `${w.slug} (${w.id})`).join(", ") || "none"}`); Deno.exit(2); }
const tz = typeof ws.settings?.timezone === "string" ? ws.settings.timezone : "UTC";
const to = todayIn(tz), from = shift(to, -6);
console.log(`Outreach parity test · workspace "${ws.name}" (${ws.id}) · role ${ws.role} · ${from} to ${to} (${tz})`);
console.log(`Supabase ${SUPABASE_URL}${RPC_ONLY ? "" : `\nConnector ${MCP_URL}`}\n`);

const getRpc = async () => {
  const [dash, over] = await Promise.all([rpc(jwt, "outreach_dashboard", { p_ws: ws.id }), rpc(jwt, "outreach_report_overview", { p_ws: ws.id, p_client: null, p_from: from, p_to: to, p_filters: {} })]);
  return { dash, over };
};

const first = await getRpc();
const t = first.over.totals ?? {};
console.log(`RPC totals: invites ${t.invites}, accepted ${t.accepted} (${t.acceptance_rate ?? "n/a"}%), touches ${t.touches}, replies ${t.replies} (${t.reply_rate ?? "n/a"}%), interested ${t.interested}, meetings ${t.meetings}, failed ${t.failed}, skipped ${t.skipped}`);
console.log(`RPC period: ${JSON.stringify(first.over.period)}\n`);
if (!first.dash.last_7_days) { failures++; console.log("FAIL  outreach_dashboard has no `last_7_days` (migration 013 not applied?)"); }

await check("1. dashboard.last_7_days vs report_overview.totals (RPC vs RPC)", "dashboard", "report_overview", async () => { const x = await getRpc(); return { ref: x.over.totals, other: x.dash.last_7_days }; });

if (!RPC_ONLY) {
  const wsArg = workspaces.length > 1 ? { workspace_id: ws.id } : {};
  try {
    const probe = await mcpTool(jwt, "report_overview", { ...wsArg, period: { from, to } });
    if (!probe.totals) {
      failures++;
      console.log("FAIL  2. connector report_overview: the result has no `totals` object.");
      console.log(`      The deployed connector is the OLD version (its own calculation). Keys it returned: ${Object.keys(probe).join(", ")}`);
      console.log("      Deploy supabase/functions/outreach-mcp (./scripts/outreach-deploy-functions.sh mcp) and run this test again.");
      const old = numericLeaves({ invites: probe.actions_sent?.invite, accepted: probe.accepted, replies: probe.replies, interested: probe.interested, acceptance_rate: probe.rates?.acceptance_pct, reply_rate: probe.rates?.reply_pct });
      console.log(`      ${"key".padEnd(28)} ${"report_overview RPC".padEnd(24)} old connector`);
      for (const [k, v] of Object.entries(old)) console.log(`      ${k.padEnd(28)} ${String(t[k]).padEnd(24)} ${String(v)}${t[k] === v ? "" : "   <- differs"}`);
    } else {
      await check("2. connector report_overview.totals vs report_overview RPC", "RPC", "connector", async () => { const [x, m] = await Promise.all([getRpc(), mcpTool(jwt, "report_overview", { ...wsArg, period: { from, to } })]); return { ref: x.over.totals, other: m.totals }; });
      await check("3. connector report_overview.previous vs report_overview RPC", "RPC", "connector", async () => { const [x, m] = await Promise.all([getRpc(), mcpTool(jwt, "report_overview", { ...wsArg, period: { from, to } })]); return { ref: x.over.previous, other: m.previous }; });
      const same = probe.period?.from === from && probe.period?.to === to;
      if (!same) { failures++; console.log(`FAIL  connector period ${JSON.stringify(probe.period)} is not ${from}..${to}`); } else console.log(`PASS  connector period is ${from}..${to} (${probe.period?.timezone})`);
    }
    const mdash = await mcpTool(jwt, "dashboard", wsArg);
    if (!mdash.last_7_days) { failures++; console.log("FAIL  4. connector dashboard has no `last_7_days` (old connector or old dashboard RPC)."); }
    else {
      await check("4a. connector dashboard.last_7_days vs dashboard RPC", "RPC", "connector", async () => { const [x, m] = await Promise.all([getRpc(), mcpTool(jwt, "dashboard", wsArg)]); return { ref: x.dash.last_7_days, other: m.last_7_days }; });
      await check("4b. connector dashboard.today vs dashboard RPC", "RPC", "connector", async () => { const [x, m] = await Promise.all([getRpc(), mcpTool(jwt, "dashboard", wsArg)]); return { ref: x.dash.today, other: m.today }; });
      await check("4c. connector dashboard counters vs dashboard RPC", "RPC", "connector", async () => {
        const [x, m] = await Promise.all([getRpc(), mcpTool(jwt, "dashboard", wsArg)]);
        const pick = (d: Json) => Object.fromEntries(["replies_awaiting", "unread", "tasks_open", "drafts_awaiting", "ai_lines_awaiting", "enrollments_live", "sent_today", "queued_today", "leads_total"].map((k) => [k, d[k] ?? 0]));
        return { ref: pick(x.dash), other: pick(m) };
      });
    }
  } catch (e) {
    failures++;
    console.log(`FAIL  connector call failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed: dashboard, reports and connector show the same numbers.");
Deno.exit(failures ? 1 : 0);
