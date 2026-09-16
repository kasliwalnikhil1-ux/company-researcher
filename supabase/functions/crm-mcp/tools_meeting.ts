// crm-mcp/tools_meeting.ts — in the meeting: commitments and commitment vs actual.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, rpc, dateParam, memberRef, McpError } from "./ctx.ts";

type Row = Record<string, any>;

const TARGET_KEYS = ["dials", "connects", "linkedin_connects", "linkedin_messages", "emails", "touches", "meetings_booked", "proposals_sent", "closes"] as const;

export function registerMeeting(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "log_commitment", title: "Log a commitment", cls: "write",
    description: `Record what a team member committed to for a day (default today, default owner = the connected user). targets is an object of numbers keyed by ${TARGET_KEYS.join(", ")} — use those keys so commitment_vs_actual can compare. Re-logging the same owner+day merges the targets. Idempotent.`,
    input: {
      owner: memberRef,
      date: dateParam("Commitment day (default today)").optional(),
      targets: z.record(z.string(), z.number().int().min(0)).describe(`e.g. {"dials": 30, "linkedin_connects": 20, "meetings_booked": 2}`),
      notes: z.string().max(500).optional(),
    },
    annotations: { idempotentHint: true },
  }, async (a) => {
    const unknown = Object.keys(a.targets).filter((k) => !(TARGET_KEYS as readonly string[]).includes(k));
    const r = await rpc<Row>(ctx, "log_commitment", { p_owner: a.owner ?? null, p_date: a.date ?? null, p_targets: a.targets, p_notes: a.notes ?? null });
    return { ...r, warning: unknown.length ? `keys not measured automatically (will show as committed only): ${unknown.join(", ")}` : undefined };
  });

  tool(server, ctx, {
    name: "log_commitments_bulk", title: "Log commitments for several people", cls: "write",
    description: "Record today's (or a given day's) commitments for several team members in one call — the usual end-of-standup write. Each row: owner + targets (+notes).",
    input: {
      date: dateParam("Commitment day (default today)").optional(),
      rows: z.array(z.object({ owner: z.string().describe("'me', user id, email or display name"), targets: z.record(z.string(), z.number().int().min(0)), notes: z.string().max(500).optional() })).min(1).max(20),
    },
  }, async (a) => {
    const results: Row[] = [];
    for (const row of a.rows) {
      try {
        const r = await rpc<Row>(ctx, "log_commitment", { p_owner: row.owner, p_date: a.date ?? null, p_targets: row.targets, p_notes: row.notes ?? null });
        results.push({ owner: r.owner, date: r.commit_date, targets: r.targets, ok: true });
      } catch (e) {
        results.push({ owner: row.owner, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { count: results.length, saved: results.filter((r) => r.ok).length, rows: results };
  });

  tool(server, ctx, {
    name: "commitment_vs_actual", title: "Commitment vs actual", cls: "read",
    description: "What each person committed against what the activity log shows, per day in a date range (owner filter optional). Actuals: dials, connects, linkedin_connects, linkedin_messages, emails, touches, meetings_booked, proposals_sent, closes. Includes repeat_misses — people who missed on ≥2 days in the range.",
    input: { from: dateParam("Range start"), to: dateParam("Range end (default today)").optional(), owner: memberRef },
  }, async (a) => {
    if (a.to && a.to < a.from) throw new McpError("E_PAYLOAD_INVALID", "to must be on or after from");
    const r = await rpc<Row>(ctx, "commitment_vs_actual", { p_from: a.from, p_to: a.to ?? null, p_owner: a.owner ?? null });
    const rows = (r.rows ?? []) as Row[];
    return { ...r, summary: rows.length === 0 ? "No commitments logged in this range." : rows.map((x) => `${x.date} ${x.owner}: ${x.all_met ? "met all" : `missed ${x.metrics_missed}/${x.metrics_committed}`} — ${Object.entries(x.committed ?? {}).map(([k, v]) => `${k} ${x.actual?.[k] ?? "?"}/${v}`).join(", ")}`).join("\n") };
  });
}
