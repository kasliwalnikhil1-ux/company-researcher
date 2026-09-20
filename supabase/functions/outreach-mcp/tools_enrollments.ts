// outreach-mcp/tools_enrollments.ts — enrol preview → commit (two gates), enrollment reads and control,
// held leads, failed-lead recovery (PRD §5.4; product plan items 1, 8, 17, 19).
//
// The enrolment plan is ONE database function (outreach__enroll_plan) behind both
// outreach_enroll_preview and outreach_enroll_leads, so the preview the human approves and
// the commit cannot disagree. Eligibility, blacklists, the replied-in-90-days guard and sender
// assignment are decided there, never in this file.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { admin } from "../_shared/outreach/supabase.ts";
import { type Ctx, tool, z, wsParam, resolveWs, requireRole, urpc, unwrap, McpError, gate, randomToken, isoNow, decodeCursor, encodeCursor } from "./ctx.ts";
import { leadFilterShape, searchLeads, leadsByIds } from "./tools_leads.ts";
import { loadSequence } from "./tools_sequences.ts";

type Row = Record<string, any>;
const LIVE = ["active", "waiting_connection", "waiting_delay", "waiting_task", "paused"];

const EXCLUDED_MEANING: Record<string, string> = {
  not_in_workspace: "not a lead of this workspace (or not visible to you)",
  replied_recently: "replied to someone in this workspace in the last 90 days (include_replied:true enrols them anyway)",
  already_enrolled: "already live with every available sender of the pool",
  no_fresh_sender: "assignment rule 'fresh_sender': every pool sender already contacted this lead",
};
const RULE_EFFECT_MEANING: Record<string, string> = {
  moved_to_fresh_sender: "moved to a sender that never contacted them (fresh_sender rule)",
  kept_with_previous_sender: "kept with the sender who last spoke to them (same_sender rule)",
  contacted_before_by_this_sender: "were contacted before by the sender they are assigned to",
};
const explainReason = (k: string) => EXCLUDED_MEANING[k] ?? (k.startsWith("suppressed:") ? `blacklisted (${k.slice(11).replace(/_/g, " ")}): workspace, client or sequence scope` : undefined);

/** Old previews stored {senderName: count}; new ones store {include_replied, senders:[{name,leads}], …}. */
function storedSplit(assignment: Row | null | undefined): string {
  if (Array.isArray(assignment?.senders)) return assignment!.senders.map((s: Row) => `${s.name}: ${s.leads}`).join(", ");
  return Object.entries(assignment ?? {}).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k}: ${v}`).join(", ");
}

export function registerEnrollments(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "enroll_preview", title: "Preview enrollment (mandatory before commit)", cls: "read", minRole: "member",
    description: "Dry-run an enrollment with the platform's own plan (the commit runs the same plan, so they cannot disagree): eligible vs excluded with reasons (not_in_workspace, suppressed:<scope>_blacklist:<kind> / do_not_contact / unsubscribed, replied_recently, already_enrolled, no_fresh_sender), `replied_recently` = the leads who answered anyone in the last 90 days with names and dates (excluded unless include_replied:true: ask the human before including them), the per-sender split under the sequence's assignment rule (round_robin | least_loaded | fixed | fresh_sender | same_sender) with `rule_effects` = how many leads the rule moved or flagged, the projected days and warnings. Returns a preview_token (15 min) that enroll_commit requires. Pick leads by ids (≤1000) or by the same filters as leads_search (≤1000).",
    input: { sequence_id: z.string(), lead_ids: z.array(z.string()).max(1000).optional(), filters: z.object(leadFilterShape).optional(), sender_id: z.string().optional().describe("Force one pool sender instead of the sequence's assignment rule"), max_leads: z.number().int().min(1).max(1000).optional().describe("Cap when using filters (default 200)"), include_replied: z.boolean().optional().describe("Default false: leads who replied in the last 90 days are left out. true only after the human looked at replied_recently and said yes.") },
  }, async (a) => {
    const seq = await loadSequence(ctx, a.sequence_id, "id, name, workspace_id, status");
    const ws = resolveWs(ctx, seq.workspace_id); requireRole(ws, "member");
    if (!a.lead_ids?.length && !a.filters) throw new McpError("E_PAYLOAD_INVALID", "lead_ids or filters required");
    const ids: string[] = a.lead_ids?.length ? [...new Set(a.lead_ids)] : (await searchLeads(ctx, ws, a.filters ?? {}, a.max_leads ?? 200, 0)).rows.map((l) => l.id);
    if (!ids.length) return { sequence: seq.name, requested: 0, eligible: 0, next: "No lead matches the filters. Nothing to enrol." };

    const includeReplied = a.include_replied === true;
    const r = await urpc<Row>(ctx, "enroll_preview", { p_sequence: seq.id, p_lead_ids: ids, p_sender: a.sender_id ?? null, p_include_replied: includeReplied });
    const eligibleIds: string[] = r.eligible_ids ?? [];
    const sample = eligibleIds.length ? await leadsByIds(ctx, ws.id, eligibleIds.slice(0, 5), "id, full_name, company") : [];

    const token = randomToken();
    if (eligibleIds.length) {
      const ins = await admin.from("outreach_agent_previews").insert({
        token, user_id: ctx.userId, workspace_id: ws.id, sequence_id: seq.id, lead_ids: eligibleIds, sender_id: a.sender_id ?? null,
        // the table has no include_replied column: the flag travels in the assignment jsonb and is read back by enroll_commit
        assignment: { include_replied: includeReplied, rule: r.assignment_rule, senders: r.assignment ?? [], rule_effects: r.rule_effects ?? {}, requested: r.requested },
        excluded: r.excluded ?? {}, expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
      if (ins.error) throw new Error(ins.error.message);
    }
    const replied: Row[] = r.replied_recently ?? [];
    return {
      sequence: seq.name, sequence_status: r.sequence_status, requested: r.requested, eligible: r.eligible,
      excluded: Object.fromEntries(Object.entries(r.excluded ?? {}).map(([k, v]: [string, any]) => [k, { ...v, meaning: explainReason(k) }])),
      replied_recently: replied.length ? { included: includeReplied, count: r.excluded?.replied_recently?.count ?? replied.length, leads: replied.map((l) => ({ id: l.id, name: l.name, company: l.company, last_replied_at: l.last_replied_at, channel: l.channel })), note: includeReplied ? undefined : "These people answered someone in this workspace in the last 90 days, so they are left out. Show the names and dates; run the preview again with include_replied:true only if the human wants them enrolled anyway." } : undefined,
      assignment_rule: r.assignment_rule, assignment: r.assignment,
      rule_effects: Object.keys(r.rule_effects ?? {}).length ? Object.fromEntries(Object.entries(r.rule_effects).map(([k, v]) => [k, { leads: v, meaning: RULE_EFFECT_MEANING[k] }])) : undefined,
      projection: r.projection, warnings: r.warnings,
      sample_eligible: sample.map((l) => ({ id: l.id, name: l.full_name, company: l.company })),
      preview_token: eligibleIds.length ? token : undefined, expires_in_seconds: eligibleIds.length ? 900 : undefined,
      next: eligibleIds.length ? "Show the counts, the exclusions and any replied_recently names to the human. On approval call enroll_commit(preview_token): it asks for one confirmation." : "Nothing to enrol.",
    };
  });

  tool(server, ctx, {
    name: "enroll_commit", title: "Commit enrollment (confirmation required)", cls: "gated", minRole: "member",
    description: "Enrol the exact eligible lead set of a preview_token. Two gates: the preview token (bound to the lead set and to the include_replied choice of that preview, 15 min) and a confirmation token (first call returns the effect summary). The database runs the same plan again at commit, so a lead that replied, got blacklisted or was enrolled elsewhere in the meantime is skipped, and reports enrolled, skipped_active, skipped_suppressed, skipped_replied, skipped_other and waiting (leads parked until their profile is enriched or their AI line is approved). Idempotent per preview token.",
    input: { preview_token: z.string(), priority: z.number().int().min(1).max(1000).optional().describe("Lower = sooner in the planner (default 100)"), wait_for_enrichment: z.boolean().optional().describe("Hold each lead until its profile is enriched (default: the sequence setting)"), confirmation_token: z.string().optional() },
  }, async (a) => {
    const { data: p } = await admin.from("outreach_agent_previews").select("*").eq("token", a.preview_token).maybeSingle();
    if (!p || p.user_id !== ctx.userId) throw new McpError("E_PREVIEW_EXPIRED", "unknown preview token");
    if (p.committed_at) throw new McpError("E_PREVIEW_EXPIRED", "this preview was already committed", "Run enroll_preview again for a new batch.");
    if (new Date(p.expires_at).getTime() < Date.now()) throw new McpError("E_PREVIEW_EXPIRED", "preview expired (15 min)");
    const seq = await loadSequence(ctx, p.sequence_id, "id, name, status, workspace_id, settings");
    const n = (p.lead_ids as string[]).length;
    const includeReplied = p.assignment?.include_replied === true;
    const effects = Object.entries((p.assignment?.rule_effects ?? {}) as Record<string, number>).map(([k, v]) => `${v} ${RULE_EFFECT_MEANING[k] ?? k}`).join("; ");
    const summary = `Enrol ${n} lead(s) into "${seq.name}" (${seq.status}). Sender split${p.assignment?.rule ? ` (${p.assignment.rule})` : ""}: ${storedSplit(p.assignment) || "decided by the platform"}.${effects ? ` Assignment notes: ${effects}.` : ""} ${includeReplied ? "Leads who replied in the last 90 days ARE included, as chosen in the preview." : "Leads who replied in the last 90 days are left out."} ${seq.status === "active" ? "First actions go out at the next planner run inside each sender's working hours, metered by daily allowances." : "The sequence is not active; leads wait until it is activated."}${a.wait_for_enrichment ? " Each lead waits for its profile to be enriched first (starts anyway after 72 hours)." : ""} Excluded in preview: ${Object.entries(p.excluded ?? {}).map(([k, v]: [string, any]) => `${k} ${v.count}`).join(", ") || "none"}.`;
    const g = await gate(ctx, "enroll_commit", a as Record<string, unknown>, summary, seq.workspace_id);
    if (!g.proceed) return g.result;
    const res = await urpc<Row[]>(ctx, "enroll_leads", { p_sequence: seq.id, p_lead_ids: p.lead_ids, p_sender: p.sender_id ?? null, p_priority: a.priority ?? 100, p_include_replied: includeReplied, p_rule: null, p_wait_enrichment: a.wait_for_enrichment ?? null });
    const r = Array.isArray(res) ? res[0] : res;
    await admin.from("outreach_agent_previews").update({ committed_at: isoNow() }).eq("token", a.preview_token);
    return {
      enrolled: r?.enrolled ?? 0, skipped_active: r?.skipped_active ?? 0, skipped_suppressed: r?.skipped_suppressed ?? 0, skipped_replied: r?.skipped_replied ?? 0, skipped_other: r?.skipped_other ?? 0, waiting: r?.waiting ?? 0,
      waiting_note: r?.waiting ? "`waiting` leads are enrolled but parked: their profile is being enriched, or their AI-written line waits for a person (ai_review_list). They start on their own afterwards." : undefined,
      skipped_replied_note: r?.skipped_replied ? "These leads replied between the preview and now. The reply stop is lead-wide, so they were left out." : undefined,
      sequence_id: seq.id, sequence_status: seq.status, next: seq.status === "active" ? "Use why_not_sending(sequence_id) if nothing goes out within one working window." : "Activate with sequence_activate when ready.",
    };
  });

  tool(server, ctx, {
    name: "enrollments_list", title: "List enrollments", cls: "read", minRole: "client_viewer",
    description: "Enrollments filtered by sequence / sender / lead / status (≤100 per page). Status values: active, waiting_connection, waiting_delay, waiting_task, paused, completed, exited_replied, exited_manual, exited_suppressed, exited_sender_disabled, failed, cancelled. `held` marks leads that replied and wait for a resume-or-exit decision; `waiting_for` says what a waiting_task lead waits on (enrichment, ai_review, ai_route or a task); `pinned_version` marks leads that stay on an older published version.",
    input: { sequence_id: z.string().optional(), sender_id: z.string().optional(), lead_id: z.string().optional(), status: z.array(z.string()).optional(), live_only: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() },
  }, async (a) => {
    if (!a.sequence_id && !a.sender_id && !a.lead_id) throw new McpError("E_PAYLOAD_INVALID", "sequence_id, sender_id or lead_id required");
    const limit = a.limit ?? 50, offset = decodeCursor(a.cursor);
    let q = ctx.user.from("outreach_enrollments").select("id, sequence_id, sender_id, lead_id, status, current_node_id, wait_until, wait_reason, held_at, hold_reason, pinned_version, exit_reason, created_at, completed_at, outreach_leads(full_name, company), outreach_senders(display_name), outreach_sequences(name)", { count: "exact" }).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    if (a.sequence_id) q = q.eq("sequence_id", a.sequence_id);
    if (a.sender_id) q = q.eq("sender_id", a.sender_id);
    if (a.lead_id) q = q.eq("lead_id", a.lead_id);
    if (a.status?.length) q = q.in("status", a.status); else if (a.live_only) q = q.in("status", LIVE);
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { total: count, next_cursor: offset + (data?.length ?? 0) < (count ?? 0) ? encodeCursor(offset + (data?.length ?? 0)) : undefined, enrollments: (data ?? []).map((e: Row) => ({ id: e.id, lead_id: e.lead_id, lead: e.outreach_leads?.full_name, company: e.outreach_leads?.company, sender: e.outreach_senders?.display_name, sequence: a.sequence_id ? undefined : e.outreach_sequences?.name, status: e.status, held: e.held_at ? (e.hold_reason ?? true) : undefined, waiting_for: e.wait_reason, pinned_version: e.pinned_version, node: e.current_node_id, wait_until: e.wait_until, exit_reason: e.exit_reason, created: e.created_at?.slice(0, 10) })) };
  });

  tool(server, ctx, {
    name: "enrollment_get", title: "Get enrollment", cls: "read", minRole: "client_viewer",
    description: "One enrollment: current step (from the version this lead runs on: pinned leads stay on their old version), wait_until, what it waits for, whether it is held after a reply, the next scheduled actions and the executed action history.",
    input: { enrollment_id: z.string() },
  }, async (a) => {
    const e = unwrap<Row | null>(await ctx.user.from("outreach_enrollments").select("*, outreach_leads(full_name, company, public_identifier), outreach_senders(display_name, status, timezone), outreach_sequences(name, status, head_version)").eq("id", a.enrollment_id).maybeSingle());
    if (!e) throw new McpError("E_NOT_FOUND", "enrollment not found");
    const [{ data: next }, { data: hist }, graph] = await Promise.all([
      ctx.user.from("outreach_actions").select("id, action_type, node_id, variant_id, scheduled_for, status, decision").eq("enrollment_id", e.id).in("status", ["queued", "reserved"]).order("scheduled_for", { ascending: true }).limit(3),
      ctx.user.from("outreach_actions").select("id, action_type, node_id, variant_id, status, executed_at, error_code, decision").eq("enrollment_id", e.id).not("executed_at", "is", null).order("executed_at", { ascending: false }).limit(20),
      urpc<Row>(ctx, "enrollment_graph", { p_enrollment: e.id }).catch((): Row => ({})),
    ]);
    const node = graph?.nodes?.[e.current_node_id];
    return {
      id: e.id, status: e.status, sequence: e.outreach_sequences?.name, sequence_status: e.outreach_sequences?.status, sequence_id: e.sequence_id,
      version: e.pinned_version ?? e.outreach_sequences?.head_version, pinned_version: e.pinned_version, enrolled_on_version: e.sequence_version,
      lead: { id: e.lead_id, name: e.outreach_leads?.full_name, company: e.outreach_leads?.company, li: e.outreach_leads?.public_identifier }, sender: { id: e.sender_id, name: e.outreach_senders?.display_name, status: e.outreach_senders?.status },
      current_node: node ? { id: e.current_node_id, type: node.type, label: node.label, entered_at: e.node_entered_at } : { id: e.current_node_id, entered_at: e.node_entered_at },
      wait_until: e.wait_until, waiting_for: e.wait_reason,
      held: e.held_at ? { since: e.held_at, reason: e.hold_reason, note: "The lead replied and the sequence is set to hold for review. enrollment_resume continues from this step; enrollment_exit ends it as replied. Held leads stop counting toward sender load after 14 days and the hold ends by itself after the sequence's hold_max_days." } : undefined,
      exit_reason: e.exit_reason, restart_count: e.restart_count || undefined, rotation_count: e.rotation_count || undefined,
      next_actions: next ?? [], history: hist ?? [], created_at: e.created_at, completed_at: e.completed_at,
      next: e.status === "failed" ? "Failed is not a dead end: enrollment_recover with retry, skip or exit." : undefined,
    };
  });

  tool(server, ctx, {
    name: "enrollment_hold_list", title: "Held leads (replied, waiting for a decision)", cls: "read", minRole: "client_viewer",
    description: "Leads that replied in a sequence whose on_reply setting is 'hold' (hold for review): they are paused, nothing is sent, and a reply_hold task waits for a person. Each row has the lead, sender, step, when it was held, the chat to read and the task id. The human decides per lead: enrollment_resume (continue from the held step) or enrollment_exit (end as replied). Sequences with the default on_reply 'exit' never hold: the lead leaves cleanly, the intent is tagged and a follow-up task is created. Out-of-office replies resume on their own after the return date.",
    input: { ...wsParam, sequence_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async (a) => {
    let q = ctx.user.from("outreach_enrollments").select("id, workspace_id, sequence_id, sender_id, lead_id, current_node_id, held_at, hold_reason, outreach_leads(full_name, company, last_replied_at, last_replied_channel), outreach_senders(display_name), outreach_sequences(name, settings)").not("held_at", "is", null).eq("status", "paused").order("held_at", { ascending: true }).limit(a.limit ?? 50);
    if (a.sequence_id) q = q.eq("sequence_id", a.sequence_id); else q = q.eq("workspace_id", resolveWs(ctx, a.workspace_id).id);
    const rows = unwrap<Row[]>(await q);
    const ids = rows.map((r) => r.id);
    const [{ data: tasks }, { data: chats }] = await Promise.all([
      ids.length ? ctx.user.from("outreach_tasks").select("id, enrollment_id, chat_id").in("enrollment_id", ids).eq("kind", "reply_hold").is("completed_at", null) : Promise.resolve({ data: [] as Row[] }),
      ids.length ? ctx.user.from("outreach_chats").select("id, lead_id, sender_id, intent, last_message_at").in("lead_id", rows.map((r) => r.lead_id)).order("last_message_at", { ascending: false }) : Promise.resolve({ data: [] as Row[] }),
    ]);
    const taskBy = new Map((tasks ?? []).map((t: Row) => [t.enrollment_id, t]));
    const chatBy = new Map<string, Row>();
    for (const c of chats ?? []) if (!chatBy.has(c.lead_id)) chatBy.set(c.lead_id, c);
    return {
      count: rows.length,
      held: rows.map((r) => ({ enrollment_id: r.id, lead_id: r.lead_id, lead: r.outreach_leads?.full_name, company: r.outreach_leads?.company, sequence_id: r.sequence_id, sequence: r.outreach_sequences?.name, sender: r.outreach_senders?.display_name, step: r.current_node_id, held_at: r.held_at, reason: r.hold_reason, replied_at: r.outreach_leads?.last_replied_at, replied_on: r.outreach_leads?.last_replied_channel, hold_max_days: r.outreach_sequences?.settings?.hold_max_days ?? 30, chat_id: taskBy.get(r.id)?.chat_id ?? chatBy.get(r.lead_id)?.id, intent: chatBy.get(r.lead_id)?.intent, task_id: taskBy.get(r.id)?.id })),
      next: rows.length ? "Read what each lead wrote (inbox_thread with chat_id), show the human, then enrollment_resume or enrollment_exit per their decision. Do not decide for them." : "No held leads.",
    };
  });

  for (const op of ["pause", "resume"] as const) {
    tool(server, ctx, {
      name: `enrollment_${op}`, title: `${op[0].toUpperCase()}${op.slice(1)} enrollments`, cls: "write", minRole: "member",
      description: op === "pause"
        ? "Pause up to 100 live enrollments (they keep their position; queued actions are held)."
        : "Resume up to 100 paused enrollments at their previous status. For a HELD lead (it replied and the sequence holds for review) resuming is a human decision: it clears the hold, closes the reply_hold task, treats everything the lead wrote so far as handled and continues from the held step, so the next automated message goes out although they replied. The result lists which of the resumed leads were held.",
      input: { enrollment_ids: z.array(z.string()).min(1).max(100), reason: z.string().optional() },
    }, async (a) => {
      const { data: before } = await ctx.user.from("outreach_enrollments").select("id, held_at, hold_reason, outreach_leads(full_name)").in("id", a.enrollment_ids);
      const held = (before ?? []).filter((r: Row) => r.held_at);
      const results: Row[] = [];
      for (const id of a.enrollment_ids) { try { await urpc(ctx, `${op}_enrollment`, { p_id: id }); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) }); } }
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      return {
        [op === "pause" ? "paused" : "resumed"]: okIds.size, failed: results.filter((r) => !r.ok),
        holds_released: op === "resume" && held.length ? { count: held.filter((h: Row) => okIds.has(h.id)).length, leads: held.filter((h: Row) => okIds.has(h.id)).map((h: Row) => h.outreach_leads?.full_name), effect: "The hold is cleared and the reply_hold task closed; these leads continue from the step they were held at." } : undefined,
      };
    });
  }

  tool(server, ctx, {
    name: "enrollment_exit", title: "Exit enrollments (confirmation required)", cls: "gated", minRole: "member",
    description: "DESTRUCTIVE. Exit up to 100 enrollments (queued actions cancelled; lead, timeline and chat are kept). A held lead (it replied, the sequence holds for review) exits as exited_replied and its reply_hold task closes; everything else exits as exited_manual. Two-step confirmation.",
    input: { enrollment_ids: z.array(z.string()).min(1).max(100), reason: z.string().min(2), confirmation_token: z.string().optional() },
    annotations: { destructiveHint: true },
  }, async (a) => {
    const { data: rows } = await ctx.user.from("outreach_enrollments").select("id, status, held_at, hold_reason, workspace_id, outreach_sequences(name)").in("id", a.enrollment_ids);
    const live = (rows ?? []).filter((r: Row) => LIVE.includes(r.status));
    const held = live.filter((r: Row) => r.held_at);
    const g = await gate(ctx, "enrollment_exit", a as Record<string, unknown>, `Exit ${live.length} live enrollment(s) (of ${a.enrollment_ids.length} given) across ${[...new Set(live.map((r: Row) => r.outreach_sequences?.name))].join(", ") || "-"}. Reason: ${a.reason}. ${held.length ? `${held.length} of them are held after a reply: they end as "replied" and their review task closes. ` : ""}Their queued actions are cancelled; the leads keep their history and chat and can be enrolled again later through enroll_preview.`, rows?.[0]?.workspace_id ?? null);
    if (!g.proceed) return g.result;
    const results: Row[] = [];
    for (const r of live) { try { await urpc(ctx, "exit_enrollment", { p_id: r.id, p_reason: r.held_at ? "replied" : `agent:${a.reason}`.slice(0, 80) }); results.push({ id: r.id, ok: true }); } catch (e) { results.push({ id: r.id, ok: false, error: e instanceof Error ? e.message : String(e) }); } }
    return { exited: results.filter((r) => r.ok).length, of_which_held: held.length || undefined, not_live: a.enrollment_ids.length - live.length, failed: results.filter((r) => !r.ok) };
  });

  // ---------------------------------------------------------------- item 8: failed leads are never a dead end
  tool(server, ctx, {
    name: "enrollments_failed", title: "Failed leads of a sequence", cls: "read", minRole: "client_viewer",
    description: "Failed leads of one sequence, grouped by plain-language reason (by_reason: step, reason, error_code, leads, recoverable, oldest), plus a page of the leads themselves (enrollment_id, lead, sender, step, reason, at, recoverable). kind:'skipped' lists skipped steps instead (information only). recoverable:false means the lead is blacklisted or the profile is invalid: retry will be refused. Failures caused by a disconnected sender re-queue on their own when the sender reconnects. Next step: enrollment_recover.",
    input: { sequence_id: z.string(), node_id: z.string().optional().describe("Only this step"), kind: z.enum(["failed", "skipped"]).optional(), limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() },
  }, async (a) => {
    const limit = a.limit ?? 50, offset = decodeCursor(a.cursor), kind = a.kind ?? "failed";
    const [summary, leads] = await Promise.all([
      kind === "failed" ? urpc<Row[]>(ctx, "failed_summary", { p_sequence: a.sequence_id }) : Promise.resolve([] as Row[]),
      urpc<Row[]>(ctx, "failed_leads", { p_sequence: a.sequence_id, p_node_id: a.node_id ?? null, p_kind: kind, p_limit: limit, p_offset: offset }),
    ]);
    const rows = leads ?? [];
    return {
      kind, by_reason: kind === "failed" ? (summary ?? []).filter((s) => !a.node_id || s.node_id === a.node_id) : undefined,
      leads: rows.map((l) => ({ enrollment_id: l.enrollment_id, lead_id: l.lead_id, lead: l.lead_name, company: l.company, sender: l.sender_name, step: l.node_id, reason: l.reason, error_code: l.error_code, at: l.at, recoverable: kind === "failed" ? l.recoverable : undefined })),
      next_cursor: rows.length === limit ? encodeCursor(offset + rows.length) : undefined,
      next: kind === "failed" && rows.length ? "Show the reasons to the human, then enrollment_recover(enrollment_ids, action): retry (same step again), skip (move past the step) or exit. There is no restart-from-top on purpose." : undefined,
    };
  });

  tool(server, ctx, {
    name: "enrollment_recover", title: "Recover failed leads (confirmation required)", cls: "gated", minRole: "member",
    description: "Act on up to 500 FAILED enrollments at once: retry = re-queue the same step under a new key through the normal daily budget (nothing already sent is sent again); skip = move the lead past the failed step to the next one; exit = end the enrollment (history kept). There is deliberately NO restart-from-top: it would re-send every message the lead already received. To run a lead through a sequence again, enrol it again with enroll_preview, which shows the already-contacted warnings. Two-step confirmation. The result lists refused ids with the reason (not_failed, lead_suppressed, profile_invalid, already_enrolled_again, sender_gone).",
    input: { enrollment_ids: z.array(z.string()).min(1).max(500), action: z.enum(["retry", "skip", "exit"]), confirmation_token: z.string().optional() },
  }, async (a) => {
    const { data: rows } = await ctx.user.from("outreach_enrollments").select("id, status, workspace_id, current_node_id, outreach_sequences(name)").in("id", a.enrollment_ids.slice(0, 500));
    const failed = (rows ?? []).filter((r: Row) => r.status === "failed");
    if (!failed.length) throw new McpError("E_PAYLOAD_INVALID", "none of these enrollments is in status failed", "Use enrollments_failed(sequence_id) to get the failed enrollment ids.");
    const names = [...new Set(failed.map((r: Row) => r.outreach_sequences?.name))].join(", ");
    const what = a.action === "retry"
      ? "re-queues the same step under a new key through the normal daily budget; nothing already sent is sent again. Blacklisted leads and invalid profiles are refused."
      : a.action === "skip" ? "moves each lead past its failed step to the next step of the sequence; the failed step is not sent."
      : "ends these enrollments for good; leads, timelines and chats are kept.";
    const g = await gate(ctx, "enrollment_recover", a as Record<string, unknown>, `${a.action.toUpperCase()} ${failed.length} failed lead(s) in ${names || "the sequence"} (${a.enrollment_ids.length - failed.length} of the given ids are not failed and are ignored). This ${what} There is no restart from the top.`, failed[0].workspace_id);
    if (!g.proceed) return g.result;
    const r = await urpc<Row>(ctx, "enrollment_recover", { p_enrollment_ids: a.enrollment_ids, p_action: a.action });
    return { ...r, next: a.action === "retry" ? "Retried steps wait for the sender's allowance and working hours like any other step; why_not_sending(enrollment_id) explains a single lead." : undefined };
  });
}
