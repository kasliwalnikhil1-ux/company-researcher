// Planner (F4): builds budgets and jittered action slots for a sender-local day.
import { admin, log, rpc, localParts, zonedToUtc, addDays, rand, randInt } from "./supabase.ts";
import { renderTemplate } from "./render.ts";

type Row = Record<string, any>;

interface Window { start: number; end: number } // epoch ms

const MIN_GAP_GLOBAL = 20_000;
const PEAKS = [{ m: 10.5 * 60, sd: 75 }, { m: 15 * 60, sd: 80 }];
const TROUGH = [12.5 * 60, 13.5 * 60];

function gaussian(mean: number, sd: number): number {
  const u = 1 - Math.random(), v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function windowsFor(day: string, tz: string, schedule: Row, fromMs: number | null): Window[] {
  const wd = localParts(tz, zonedToUtc(day, "12:00", tz)).weekday;
  const out: Window[] = [];
  for (const [s, e] of (schedule?.[wd] ?? []) as [string, string][]) {
    let start = zonedToUtc(day, s, tz).getTime() + rand(0, 5) * 60_000;
    let end = zonedToUtc(day, e, tz).getTime() - rand(0, 5) * 60_000;
    if (fromMs && start < fromMs) start = fromMs;
    if (end > start + 60_000) out.push({ start, end });
  }
  return out;
}

function localMinutesOf(ms: number, tz: string): number { const lp = localParts(tz, new Date(ms)); return lp.hour * 60 + lp.minute; }

/** Sample a slot (epoch ms) inside windows following a bimodal day shape. */
function sampleSlot(day: string, tz: string, windows: Window[]): number | null {
  if (!windows.length) return null;
  for (let i = 0; i < 40; i++) {
    const peak = PEAKS[Math.random() < 0.55 ? 0 : 1];
    const mins = gaussian(peak.m, peak.sd);
    if (mins < 0 || mins >= 1440) continue;
    if (mins >= TROUGH[0] && mins <= TROUGH[1] && Math.random() < 0.8) continue;
    const hh = String(Math.floor(mins / 60)).padStart(2, "0"), mm = String(Math.floor(mins % 60)).padStart(2, "0");
    const t = zonedToUtc(day, hh + ":" + mm, tz).getTime() + randInt(1, 59) * 1000;
    if (windows.some((w) => t >= w.start && t <= w.end)) return t;
  }
  // fallback: uniform in a random window
  const w = windows[randInt(0, windows.length - 1)];
  let t = w.start + rand(0, w.end - w.start);
  const secs = new Date(t).getUTCSeconds(); const min = new Date(t).getUTCMinutes();
  if (secs === 0 && (min === 0 || min === 30)) t += randInt(1, 59) * 1000;
  return Math.floor(t);
}

function fits(t: number, taken: number[], sameType: number[], gapType: number): boolean {
  for (const x of taken) if (Math.abs(x - t) < MIN_GAP_GLOBAL) return false;
  for (const x of sameType) if (Math.abs(x - t) < gapType) return false;
  return true;
}

export interface PlanResult { sender_id: string; day: string; kind: string; planned: number; unplanned: number; skipped?: string }

/** Plan one sender for a day. kind='nightly' (tomorrow) or 'topup' (rest of today). */
export async function planSender(sender: Row, kind: "nightly" | "topup"): Promise<PlanResult> {
  const tz = sender.timezone ?? "UTC";
  const nowLp = localParts(tz);
  const day = kind === "nightly" ? addDays(nowLp.date, 1) : nowLp.date;
  const fromMs = kind === "topup" ? Date.now() + 5 * 60_000 : null;

  if (kind === "nightly") {
    const { data: existing } = await admin.from("outreach_plans").select("sender_id").eq("sender_id", sender.id).eq("day", day).eq("kind", "nightly").maybeSingle();
    if (existing) return { sender_id: sender.id, day, kind, planned: 0, unplanned: 0, skipped: "already_planned" };
  }
  const budgets = await rpc<Row[]>("plan_budgets", { p_sender: sender.id, p_day: day });
  const windows = windowsFor(day, tz, sender.schedule, fromMs);
  if (!windows.length) {
    await admin.from("outreach_plans").upsert({ sender_id: sender.id, day, kind, actions: 0 }, { onConflict: "sender_id,day,kind" });
    return { sender_id: sender.id, day, kind, planned: 0, unplanned: 0, skipped: "no_window" };
  }
  const dayStart = Math.min(...windows.map((w) => w.start)), dayEnd = Math.max(...windows.map((w) => w.end));

  // capacity per type = cap - used - reserved - already queued for this day
  const { data: queued } = await admin.from("outreach_actions").select("action_type, scheduled_for").eq("sender_id", sender.id).in("status", ["queued", "reserved"]).gte("scheduled_for", new Date(dayStart - 3600_000).toISOString()).lte("scheduled_for", new Date(dayEnd + 3600_000).toISOString());
  const taken: number[] = (queued ?? []).map((q) => new Date(q.scheduled_for).getTime());
  const byType: Record<string, number[]> = {};
  for (const q of queued ?? []) (byType[q.action_type] ??= []).push(new Date(q.scheduled_for).getTime());
  const capacity: Record<string, number> = {};
  for (const b of budgets) capacity[b.action_type] = Math.max(0, b.cap - b.used - b.reserved - (byType[b.action_type]?.length ?? 0));
  const gapFor: Record<string, number> = {};
  const gap = (t: string) => (gapFor[t] ??= randInt(90, 400) * 1000);

  const demand = await rpc<Row[]>("planner_demand", { p_sender: sender.id, p_until: new Date(dayEnd).toISOString() });
  const senderCtx = { ...sender, first_name: (sender.display_name ?? "").split(" ")[0], full_name: sender.display_name };
  let planned = 0, unplanned = 0;
  const throttled = new Map<string, string>();
  const leadCache = new Map<string, Row>();
  const mailboxCache = new Map<string, Row | null>();

  for (const d of demand) {
    const type: string = d.action_type;
    let targetSender = sender;
    let capKey = type;
    // email nodes execute from a mailbox sender in the pool (or configured mailbox)
    if (type === "email") {
      const mbId = d.node?.config?.mailbox_sender_id ?? null;
      const key = mbId ?? `pool:${d.sequence_id}`;
      if (!mailboxCache.has(key)) {
        let mb: Row | null = null;
        if (mbId) { const { data } = await admin.from("outreach_senders").select("*").eq("id", mbId).eq("status", "ok").maybeSingle(); mb = data; }
        else {
          const { data: seq } = await admin.from("outreach_sequences").select("sender_pool").eq("id", d.sequence_id).single();
          const { data } = await admin.from("outreach_senders").select("*").in("id", seq?.sender_pool ?? []).neq("provider", "LINKEDIN").eq("status", "ok").limit(1).maybeSingle();
          mb = data;
        }
        mailboxCache.set(key, mb);
      }
      const mb = mailboxCache.get(key);
      if (!mb) { unplanned++; throttled.set(d.sequence_id, "No connected mailbox in the pool for email steps"); continue; }
      targetSender = mb;
      if (!(`mb:${mb.id}` in capacity)) {
        const mbBudgets = await rpc<Row[]>("plan_budgets", { p_sender: mb.id, p_day: day });
        const e = mbBudgets.find((b) => b.action_type === "email");
        const { count } = await admin.from("outreach_actions").select("id", { count: "exact", head: true }).eq("sender_id", mb.id).eq("action_type", "email").in("status", ["queued", "reserved"]).gte("scheduled_for", new Date(dayStart).toISOString()).lte("scheduled_for", new Date(dayEnd).toISOString());
        capacity[`mb:${mb.id}`] = Math.max(0, (e?.cap ?? 0) - (e?.used ?? 0) - (e?.reserved ?? 0) - (count ?? 0));
      }
      capKey = `mb:${mb.id}`;
    }
    if ((capacity[capKey] ?? 0) <= 0) { unplanned++; throttled.set(d.sequence_id, `Daily ${type} cap reached on ${sender.display_name ?? "sender"}`); continue; }
    if (d.needs_profile && (capacity["profile_view"] ?? 0) <= 0) { unplanned++; throttled.set(d.sequence_id, `Daily profile_view cap reached on ${sender.display_name ?? "sender"}`); continue; }

    const earliest = Math.max(new Date(d.earliest).getTime(), fromMs ?? 0);
    // find slot
    let slot: number | null = null;
    for (let i = 0; i < 25; i++) {
      const t = sampleSlot(day, tz, windows);
      if (t == null) break;
      if (t < earliest) continue;
      if (d.needs_profile && t - dayStart < 5 * 60_000) continue;
      if (!fits(t, taken, byType[type] ?? [], gap(type))) continue;
      slot = t; break;
    }
    if (slot == null) { unplanned++; continue; }
    let prefetchSlot: number | null = null;
    if (d.needs_profile) {
      for (let i = 0; i < 15; i++) {
        const t = slot - randInt(5, 40) * 60_000;
        if (!windows.some((w) => t >= w.start && t <= w.end)) continue;
        if (fromMs && t < fromMs) continue;
        if (!fits(t, taken, byType["profile_view"] ?? [], gap("profile_view"))) continue;
        prefetchSlot = t; break;
      }
      if (prefetchSlot == null) { unplanned++; continue; }
    }

    // render payload at plan time (re-rendered at execute time)
    let lead = leadCache.get(d.lead_id);
    if (!lead) { const { data } = await admin.from("outreach_leads").select("*").eq("id", d.lead_id).single(); lead = data ?? {}; leadCache.set(d.lead_id, lead!); }
    const cfg = d.node?.config ?? {};
    const payload: Row = { ...cfg };
    if (typeof cfg.text === "string") payload.text = renderTemplate(cfg.text, { lead: lead!, sender: senderCtx });
    if (typeof cfg.note === "string") payload.text = renderTemplate(cfg.note, { lead: lead!, sender: senderCtx });
    if (typeof cfg.subject === "string") payload.subject = renderTemplate(cfg.subject, { lead: lead!, sender: senderCtx });
    if (typeof cfg.html === "string") payload.html = renderTemplate(cfg.html, { lead: lead!, sender: senderCtx });
    if (d.subtask) { payload.subtask = true; payload.subtask_index = d.node?.subtask_index ?? 0; payload.subtask_type = d.node?.type; delete payload.subtasks; }

    // AI-drafted copy → approval task instead of auto-send (FR-AI-02)
    if (cfg.ai?.brief && !d.subtask && ["invite", "message", "comment"].includes(type)) {
      const { data: existingTask } = await admin.from("outreach_tasks").select("id").eq("enrollment_id", d.enrollment_id).eq("node_id", d.node_id).is("completed_at", null).maybeSingle();
      if (!existingTask) {
        await admin.from("outreach_tasks").insert({
          workspace_id: sender.workspace_id, kind: "review_ai_draft", lead_id: d.lead_id, sender_id: sender.id, enrollment_id: d.enrollment_id, node_id: d.node_id,
          title: `Review AI ${type === "invite" ? "invite note" : type} for ${lead?.full_name ?? "lead"}`, body: cfg.ai.brief, draft_kind: type === "invite" ? "invite_note" : type, due_at: new Date(slot).toISOString(),
        });
        await admin.from("outreach_enrollments").update({ status: "waiting_task" }).eq("id", d.enrollment_id).eq("status", "active");
      }
      continue;
    }

    if (prefetchSlot != null) {
      await rpc("queue_action", { p_enrollment: d.enrollment_id, p_node_id: d.node_id, p_type: "profile_view", p_scheduled_for: new Date(prefetchSlot).toISOString(), p_payload: { prefetch: true, notify: false } });
      taken.push(prefetchSlot); (byType["profile_view"] ??= []).push(prefetchSlot); capacity["profile_view"]--;
    }
    if (type === "email") {
      // action lives on the mailbox sender: insert directly with the mailbox as sender
      const key = await sha(`${d.enrollment_id}|${d.node_id}|email|${Date.now()}|${Math.random()}`);
      const { data: enr } = await admin.from("outreach_enrollments").select("workspace_id, lead_id").eq("id", d.enrollment_id).single();
      await admin.from("outreach_actions").insert({ workspace_id: enr!.workspace_id, enrollment_id: d.enrollment_id, sender_id: targetSender.id, lead_id: enr!.lead_id, node_id: d.node_id, action_type: "email", scheduled_for: new Date(slot).toISOString(), idempotency_key: key, payload: { ...payload, via_mailbox: targetSender.id } });
    } else {
      await rpc("queue_action", { p_enrollment: d.enrollment_id, p_node_id: d.node_id, p_type: type, p_scheduled_for: new Date(slot).toISOString(), p_payload: payload });
    }
    taken.push(slot); (byType[type] ??= []).push(slot); capacity[capKey]--;
    planned++;
  }

  // throttle badges
  for (const [seqId, reason] of throttled) await admin.from("outreach_sequences").update({ throttled_reason: reason }).eq("id", seqId);
  const touched = new Set(demand.map((d) => d.sequence_id));
  for (const seqId of touched) if (!throttled.has(seqId)) await admin.from("outreach_sequences").update({ throttled_reason: null }).eq("id", seqId).not("throttled_reason", "is", null);
  await admin.from("outreach_plans").upsert({ sender_id: sender.id, day, kind, actions: planned }, { onConflict: "sender_id,day,kind" });
  log({ fn: "planner", sender_id: sender.id, day, kind, planned, unplanned, demand: demand.length });
  return { sender_id: sender.id, day, kind, planned, unplanned };
}

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Select senders to plan for this run. */
export async function selectSenders(kind: "nightly" | "topup"): Promise<Row[]> {
  const { data } = await admin.from("outreach_senders").select("*").eq("status", "ok").is("deleted_at", null).eq("provider", "LINKEDIN");
  const out: Row[] = [];
  for (const s of data ?? []) {
    const lp = localParts(s.timezone ?? "UTC");
    if (kind === "nightly" && lp.hour !== 0) continue;
    if (kind === "topup") {
      if (s.paused_until && new Date(s.paused_until).getTime() > Date.now()) continue;
      const inSched = await rpc<boolean>("in_schedule", { p_sender: s.id, p_at: new Date().toISOString() });
      if (!inSched) continue;
    }
    out.push(s);
  }
  return out;
}
