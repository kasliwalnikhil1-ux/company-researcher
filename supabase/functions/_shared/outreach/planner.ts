// Planner (F4): builds budgets and jittered action slots for a sender-local day.
// The payload it queues carries the UNRENDERED template + variant_id; execute.ts renders at send time.
import { admin, log, rpc, localParts, zonedToUtc, addDays, rand, randInt } from "./supabase.ts";
import { capabilitiesFor, CHANNEL_PROVIDERS, isDailyScoped, isHourlyMetered, minGapRange, type ChannelCapabilities } from "./channels.ts";

type Row = Record<string, any>;

interface Window { start: number; end: number } // epoch ms

const MIN_GAP_GLOBAL = 20_000;
const HOUR = 3600_000;
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

function fits(t: number, taken: number[], sameType: number[], gapType: number, gapGlobal = MIN_GAP_GLOBAL): boolean {
  for (const x of taken) if (Math.abs(x - t) < gapGlobal) return false;
  for (const x of sameType) if (Math.abs(x - t) < gapType) return false;
  return true;
}

// ---- per-hour bucketing (Instagram: at most `cap` metered actions per UTC hour, the same hour the SQL ledger reserves in)
const hourStartOf = (t: number): number => Math.floor(t / HOUR) * HOUR;

/** The UTC hours that overlap the working windows (and are not already over). */
function hoursFor(windows: Window[], notBefore: number | null): number[] {
  const out = new Set<number>();
  for (const w of windows) {
    for (let h = hourStartOf(w.start); h < w.end; h += HOUR) {
      if (notBefore && h + HOUR <= notBefore) continue;
      out.add(h);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * A slot for an hourly-capped provider: the hour with the most room left (ties at random, so demand spreads across the
 * day instead of filling the morning), a random minute inside the part of that hour that lies in a window, seconds never :00.
 */
function sampleHourlySlot(hours: number[], windows: Window[], counts: Map<number, number>, cap: number, earliest: number): number | null {
  const open = hours.filter((h) => (counts.get(h) ?? 0) < cap && h + HOUR > earliest);
  if (!open.length) return null;
  const least = Math.min(...open.map((h) => counts.get(h) ?? 0));
  const pool = open.filter((h) => (counts.get(h) ?? 0) === least);
  const h = pool[randInt(0, pool.length - 1)];
  const spans = windows.map((w) => ({ start: Math.max(w.start, h, earliest), end: Math.min(w.end, h + HOUR) })).filter((s) => s.end - s.start > 60_000);
  if (!spans.length) return null;
  const s = spans[randInt(0, spans.length - 1)];
  const t = Math.floor(s.start + rand(0, s.end - s.start));
  return hourStartOf(t) + Math.floor((t - hourStartOf(t)) / 60_000) * 60_000 + randInt(1, 59) * 1000;
}

export interface PlanResult { sender_id: string; day: string; kind: string; planned: number; unplanned: number; skipped?: string }

/** A mailbox is a sender row of its own: its timezone, its `schedule` (= the email schedule, item 20), its email budget. */
interface MailboxPlan { row: Row; tz: string; day: string; windows: Window[]; taken: number[]; emails: number[]; capacity: number }

/** Plan one sender for a day. kind='nightly' (tomorrow) or 'topup' (rest of today). */
export async function planSender(sender: Row, kind: "nightly" | "topup"): Promise<PlanResult> {
  const tz = sender.timezone ?? "UTC";
  const nowLp = localParts(tz);
  const day = kind === "nightly" ? addDays(nowLp.date, 1) : nowLp.date;
  const fromMs = kind === "topup" ? Date.now() + 5 * 60_000 : null;

  // post-connect quiet period (WhatsApp: 24 h after every connect / reconnect): no outbound is planned while it runs
  if (sender.outreach_allowed_from && new Date(sender.outreach_allowed_from).getTime() > Date.now()) {
    log({ fn: "planner", sender_id: sender.id, day, kind, skipped: "quiet_period", until: sender.outreach_allowed_from });
    return { sender_id: sender.id, day, kind, planned: 0, unplanned: 0, skipped: "quiet_period" };
  }
  if (kind === "nightly") {
    const { data: existing } = await admin.from("outreach_plans").select("sender_id").eq("sender_id", sender.id).eq("day", day).eq("kind", "nightly").maybeSingle();
    if (existing) return { sender_id: sender.id, day, kind, planned: 0, unplanned: 0, skipped: "already_planned" };
  }
  const provider: string = String(sender.provider ?? "LINKEDIN").toUpperCase();
  const caps: ChannelCapabilities = await capabilitiesFor(provider);
  const hourly = caps.ledger.hourly;
  const budgets = await rpc<Row[]>("plan_budgets", { p_sender: sender.id, p_day: day });
  // LinkedIn windows. With none, email steps can still be planned: they follow the MAILBOX's schedule, not this sender's.
  const windows = windowsFor(day, tz, sender.schedule, fromMs);
  const hasWindow = windows.length > 0;
  const endOfDay = zonedToUtc(day, "23:59", tz).getTime();
  const dayStart = hasWindow ? Math.min(...windows.map((w) => w.start)) : zonedToUtc(day, "00:00", tz).getTime();
  const dayEnd = hasWindow ? Math.max(...windows.map((w) => w.end)) : dayStart;
  const horizon = Math.max(dayEnd, endOfDay);

  // capacity per type = cap - used - reserved - already queued for this day
  const { data: queued } = await admin.from("outreach_actions").select("action_type, scheduled_for").eq("sender_id", sender.id).in("status", ["queued", "reserved"]).gte("scheduled_for", new Date(dayStart - 3600_000).toISOString()).lte("scheduled_for", new Date(horizon + 3600_000).toISOString());
  const taken: number[] = (queued ?? []).map((q) => new Date(q.scheduled_for).getTime());
  const byType: Record<string, number[]> = {};
  for (const q of queued ?? []) (byType[q.action_type] ??= []).push(new Date(q.scheduled_for).getTime());
  const capacity: Record<string, number> = {};
  for (const b of budgets) if (b.action_type) capacity[b.action_type] = Math.max(0, b.cap - b.used - b.reserved - (byType[b.action_type]?.length ?? 0));
  // the descriptor's gap: LinkedIn [90, 400] s as before; Instagram [60, 240]; WhatsApp at least [20, 90] (the claim enforces the 10–20 s floor)
  const [gapLo, gapHi] = minGapRange(caps);
  const gapFor: Record<string, number> = {};
  const gap = (t: string) => (gapFor[t] ??= randInt(gapLo, gapHi) * 1000);
  const gapGlobal = provider === "LINKEDIN" ? MIN_GAP_GLOBAL : Math.max(MIN_GAP_GLOBAL, gapLo * 1000);
  // daily `all_metered` scope (Instagram): the day total no per-type cap may sum past. plan_budgets returns it as a scoped row.
  const dayScope = caps.ledger.daily_scope ? budgets.find((b) => (b.scope ?? b.action_type) === caps.ledger.daily_scope!.scope && (b.window ?? "day") === "day") ?? null : null;
  let totalRoom = dayScope ? Math.max(0, Number(dayScope.cap ?? 0) - Number(dayScope.used ?? 0) - Number(dayScope.reserved ?? 0) - (queued ?? []).filter((q) => isDailyScoped(caps, q.action_type)).length) : Infinity;
  // hourly scope (Instagram: 10 metered actions per hour): what is already queued in each UTC hour counts
  const hourCounts = new Map<number, number>();
  if (hourly) for (const q of queued ?? []) if (isHourlyMetered(caps, q.action_type)) { const h = hourStartOf(new Date(q.scheduled_for).getTime()); hourCounts.set(h, (hourCounts.get(h) ?? 0) + 1); }
  const hours = hourly ? hoursFor(windows, fromMs) : [];
  const hourRoom = (t: number, type: string): boolean => !hourly || !isHourlyMetered(caps, type) || (hourCounts.get(hourStartOf(t)) ?? 0) < hourly.cap;
  const takeSlot = (t: number, type: string): void => {
    if (hourly && isHourlyMetered(caps, type)) { const h = hourStartOf(t); hourCounts.set(h, (hourCounts.get(h) ?? 0) + 1); }
    if (dayScope && isDailyScoped(caps, type)) totalRoom--;
  };

  // planner_demand (011) returns node.config already variant-resolved, plus variant_id and needs_posts
  const demand = await rpc<Row[]>("planner_demand", { p_sender: sender.id, p_until: new Date(horizon).toISOString() });
  let planned = 0, unplanned = 0;
  const throttled = new Map<string, string>();
  const leadNames = new Map<string, string>();
  const mailboxes = new Map<string, MailboxPlan | null>();
  const who = sender.display_name ?? "sender";

  async function mailboxPlan(id: string): Promise<MailboxPlan | null> {
    if (mailboxes.has(id)) return mailboxes.get(id)!;
    const { data: mb } = await admin.from("outreach_senders").select("*").eq("id", id).eq("status", "ok").is("deleted_at", null).maybeSingle();
    if (!mb) { mailboxes.set(id, null); return null; }
    const mtz: string = mb.timezone ?? tz;
    const mday = kind === "nightly" ? addDays(localParts(mtz).date, 1) : localParts(mtz).date;
    const mwin = windowsFor(mday, mtz, mb.schedule, fromMs);
    const mbBudgets = await rpc<Row[]>("plan_budgets", { p_sender: mb.id, p_day: mday });
    const e = mbBudgets.find((b) => b.action_type === "email");
    const lo = zonedToUtc(mday, "00:00", mtz).getTime(), hi = zonedToUtc(mday, "23:59", mtz).getTime() + 60_000;
    const { data: q } = await admin.from("outreach_actions").select("action_type, scheduled_for").eq("sender_id", mb.id).in("status", ["queued", "reserved"]).gte("scheduled_for", new Date(lo).toISOString()).lte("scheduled_for", new Date(hi).toISOString());
    const times = (q ?? []).map((x) => new Date(x.scheduled_for).getTime());
    const emails = (q ?? []).filter((x) => x.action_type === "email").map((x) => new Date(x.scheduled_for).getTime());
    const plan: MailboxPlan = { row: mb, tz: mtz, day: mday, windows: mwin, taken: times, emails, capacity: Math.max(0, (e?.cap ?? 0) - (e?.used ?? 0) - (e?.reserved ?? 0) - emails.length) };
    mailboxes.set(id, plan);
    return plan;
  }

  for (const d of demand) {
    const type: string = d.action_type;   // may be `new_chat` (no chat exists yet) or `message` (into an existing chat): the SQL decides
    const nodeType: string = d.node?.type ?? "";
    const cfg: Row = d.node?.config ?? {};
    const earliest = Math.max(new Date(d.earliest).getTime(), fromMs ?? 0);
    const readsPostsItself = type === "like" || type === "comment";   // these list posts at execution, behind the same post_fetch budget
    // posts exist on LinkedIn and Instagram only; WhatsApp never prefetches them
    const needsPosts = !!d.needs_posts && provider !== "WHATSAPP";

    // ---- email steps: mailbox rotation (sticky per contact) and the mailbox's own schedule / timezone
    let mbox: MailboxPlan | null = null;
    if (type === "email") {
      const mbId = await rpc<string | null>("pick_mailbox", { p_enrollment: d.enrollment_id, p_node: d.node });
      mbox = mbId ? await mailboxPlan(mbId) : null;
      if (!mbox) { unplanned++; throttled.set(d.sequence_id, "No connected mailbox for the email step. Connect one or check the step's mailbox pool"); continue; }
      if (!mbox.windows.length) { unplanned++; continue; }          // that mailbox does not send on this day: not a throttle
      if (mbox.capacity <= 0) { unplanned++; throttled.set(d.sequence_id, `Daily email cap reached on ${mbox.row.display_name ?? "mailbox"}`); continue; }
    } else {
      if (!hasWindow) continue;                                     // no working window today
      if (earliest > dayEnd) continue;                              // due after today's last window: the next plan takes it
      if ((capacity[type] ?? 0) <= 0) { unplanned++; throttled.set(d.sequence_id, `Daily ${type} cap reached on ${who}`); continue; }
      // Instagram: the day's action total and the working hours with room left
      const needed = 1 + (d.needs_profile ? 1 : 0) + (needsPosts && !readsPostsItself ? 1 : 0);
      if (dayScope && isDailyScoped(caps, type) && totalRoom < needed) { unplanned++; throttled.set(d.sequence_id, `Daily action total reached on ${who}`); continue; }
      if (hourly && isHourlyMetered(caps, type) && !hours.some((h) => (hourCounts.get(h) ?? 0) < hourly.cap && h + HOUR > earliest)) { unplanned++; throttled.set(d.sequence_id, `Hourly cap (${hourly.cap} actions an hour) reached on ${who} for today's working hours`); continue; }
    }
    if (d.needs_profile && (!hasWindow || (capacity["profile_view"] ?? 0) <= 0)) { unplanned++; throttled.set(d.sequence_id, `Daily profile_view cap reached on ${who}`); continue; }
    // posts are fetched only when something will use them, and every fetch is budgeted (plan checklist + item 13)
    if (needsPosts && (capacity["post_fetch"] ?? 0) <= 0) { unplanned++; throttled.set(d.sequence_id, `Daily post_fetch cap reached on ${who}`); continue; }

    // ---- slot for the step itself
    const slotDay = mbox ? mbox.day : day, slotTz = mbox ? mbox.tz : tz, slotWindows = mbox ? mbox.windows : windows;
    const slotTaken = mbox ? mbox.taken : taken, slotSame = mbox ? mbox.emails : (byType[type] ?? []);
    const slotGapGlobal = mbox ? MIN_GAP_GLOBAL : gapGlobal;
    const bucketed = !mbox && !!hourly && isHourlyMetered(caps, type);
    let slot: number | null = null;
    for (let i = 0; i < 25; i++) {
      const t = bucketed ? sampleHourlySlot(hours, slotWindows, hourCounts, hourly!.cap, earliest) : sampleSlot(slotDay, slotTz, slotWindows);
      if (t == null) break;
      if (t < earliest) continue;
      if (d.needs_profile && t - dayStart < 5 * 60_000) continue;
      if (!fits(t, slotTaken, slotSame, gap(type), slotGapGlobal)) continue;
      slot = t; break;
    }
    if (slot == null) { unplanned++; continue; }
    const stepSlot: number = slot;

    // ---- a profile / posts read 5–40 minutes before the step, inside the sender's windows (and, on Instagram, in an hour with room)
    const before = (sameType: string): number | null => {
      for (let i = 0; i < 15; i++) {
        const t = stepSlot - randInt(5, 40) * 60_000;
        if (!windows.some((w) => t >= w.start && t <= w.end)) continue;
        if (fromMs && t < fromMs) continue;
        if (!hourRoom(t, sameType)) continue;
        if (!fits(t, taken, byType[sameType] ?? [], gap(sameType), gapGlobal)) continue;
        return t;
      }
      return null;
    };
    let prefetchSlot: number | null = null;
    if (d.needs_profile) {
      prefetchSlot = before("profile_view");
      if (prefetchSlot == null) { unplanned++; continue; }
    }
    // Text that uses the lead's posts ({{enrich.recent_post}}, an AI line that needs posts) but has no profile prefetch due:
    // a posts-only read (action type post_fetch, own budget, no profile view spent). Skipped when posts were read in the last 3 days.
    let postsSlot: number | null = null;
    if (needsPosts && prefetchSlot == null && !readsPostsItself && hasWindow) {
      const { data: prof } = await admin.from("outreach_lead_profiles").select("posts_fetched_at").eq("lead_id", d.lead_id).maybeSingle();
      const fresh = !!prof?.posts_fetched_at && Date.now() - new Date(prof.posts_fetched_at).getTime() < 3 * 86400_000;
      if (!fresh) postsSlot = before("post_fetch");                // no slot → the step goes without posts and the template fallback covers it
    }

    // ---- payload: the UNRENDERED template (+ variant_id). Rendering happens at send time with outreach_render_context.
    const payload: Row = { ...cfg };
    delete payload.variants;
    if (typeof cfg.note === "string") payload.text = cfg.note;
    if (d.variant_id) payload.variant_id = d.variant_id;
    if (nodeType === "send_voice_note") payload.voice = true;
    if (nodeType === "refresh_profile") { payload.refresh = true; payload.notify = false; }
    if (d.subtask) { payload.subtask = true; payload.subtask_index = d.node?.subtask_index ?? 0; payload.subtask_type = d.node?.type; delete payload.subtasks; }

    // AI-drafted copy → approval task instead of auto-send (FR-AI-02)
    if (cfg.ai?.brief && !d.subtask && ["invite", "message", "new_chat", "comment"].includes(type)) {
      const { data: existingTask } = await admin.from("outreach_tasks").select("id").eq("enrollment_id", d.enrollment_id).eq("node_id", d.node_id).is("completed_at", null).maybeSingle();
      if (!existingTask) {
        if (!leadNames.has(d.lead_id)) { const { data } = await admin.from("outreach_leads").select("full_name").eq("id", d.lead_id).maybeSingle(); leadNames.set(d.lead_id, data?.full_name ?? "lead"); }
        await admin.from("outreach_tasks").insert({
          workspace_id: sender.workspace_id, kind: "review_ai_draft", lead_id: d.lead_id, sender_id: sender.id, enrollment_id: d.enrollment_id, node_id: d.node_id,
          title: `Review AI ${type === "invite" ? "invite note" : type === "new_chat" ? "message" : type} for ${leadNames.get(d.lead_id)}`, body: cfg.ai.brief, draft_kind: type === "invite" ? "invite_note" : type === "new_chat" ? "message" : type, due_at: new Date(stepSlot).toISOString(),
        });
        await admin.from("outreach_enrollments").update({ status: "waiting_task" }).eq("id", d.enrollment_id).eq("status", "active");
      }
      continue;
    }

    if (prefetchSlot != null) {
      // notify:false → never shows up as a profile visit. needs_posts → the executor lists posts right after the profile (post_fetch budget).
      await rpc("queue_action", { p_enrollment: d.enrollment_id, p_node_id: d.node_id, p_type: "profile_view", p_scheduled_for: new Date(prefetchSlot).toISOString(), p_payload: { prefetch: true, notify: false, ...(needsPosts ? { needs_posts: true } : {}) } });
      taken.push(prefetchSlot); (byType["profile_view"] ??= []).push(prefetchSlot); capacity["profile_view"]--; takeSlot(prefetchSlot, "profile_view");
    }
    if (postsSlot != null) {
      await rpc("queue_action", { p_enrollment: d.enrollment_id, p_node_id: d.node_id, p_type: "post_fetch", p_scheduled_for: new Date(postsSlot).toISOString(), p_payload: { prefetch: true } });
      taken.push(postsSlot); (byType["post_fetch"] ??= []).push(postsSlot); takeSlot(postsSlot, "post_fetch");
    }
    if (needsPosts && (prefetchSlot != null || postsSlot != null || readsPostsItself)) capacity["post_fetch"]--;

    if (mbox) {
      // the action lives on the mailbox sender: insert directly (queue_action would use the enrollment's LinkedIn sender)
      const key = await sha(`${d.enrollment_id}|${d.node_id}|email|${Date.now()}|${Math.random()}`);
      const { data: enr } = await admin.from("outreach_enrollments").select("workspace_id, lead_id").eq("id", d.enrollment_id).single();
      await admin.from("outreach_actions").insert({ workspace_id: enr!.workspace_id, enrollment_id: d.enrollment_id, sender_id: mbox.row.id, lead_id: enr!.lead_id, node_id: d.node_id, action_type: "email", scheduled_for: new Date(stepSlot).toISOString(), idempotency_key: key, payload: { ...payload, via_mailbox: mbox.row.id }, variant_id: d.variant_id ?? null });
      mbox.taken.push(stepSlot); mbox.emails.push(stepSlot); mbox.capacity--;
    } else {
      await rpc("queue_action", { p_enrollment: d.enrollment_id, p_node_id: d.node_id, p_type: type, p_scheduled_for: new Date(stepSlot).toISOString(), p_payload: payload });
      taken.push(stepSlot); (byType[type] ??= []).push(stepSlot); capacity[type]--; takeSlot(stepSlot, type);
    }
    planned++;
  }

  // throttle badges
  for (const [seqId, reason] of throttled) await admin.from("outreach_sequences").update({ throttled_reason: reason }).eq("id", seqId);
  const touched = new Set(demand.map((d) => d.sequence_id));
  for (const seqId of touched) if (!throttled.has(seqId)) await admin.from("outreach_sequences").update({ throttled_reason: null }).eq("id", seqId).not("throttled_reason", "is", null);
  await admin.from("outreach_plans").upsert({ sender_id: sender.id, day, kind, actions: planned }, { onConflict: "sender_id,day,kind" });
  log({ fn: "planner", sender_id: sender.id, provider, day, kind, planned, unplanned, demand: demand.length, no_window: !hasWindow, ...(hourly ? { hourly_cap: hourly.cap, hours: hours.length } : {}) });
  return { sender_id: sender.id, day, kind, planned, unplanned, ...(hasWindow || planned > 0 ? {} : { skipped: "no_window" }) };
}

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Select senders to plan for this run: every chat provider (LinkedIn, Instagram, WhatsApp). Mailboxes are planned through mailbox rotation. */
export async function selectSenders(kind: "nightly" | "topup"): Promise<Row[]> {
  const { data } = await admin.from("outreach_senders").select("*").eq("status", "ok").is("deleted_at", null).in("provider", CHANNEL_PROVIDERS);
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
