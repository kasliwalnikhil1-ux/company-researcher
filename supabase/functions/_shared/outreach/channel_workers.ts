// Instagram / WhatsApp background workers (CHANNELS-BUILD-CONTRACT §4), run by outreach-worker-channels:
//   runFollowersPoll    IG: 1–3 polls a day per sender of its OWN followers list (one metered call, covers every pending lead),
//                       diffed against leads in `wait_follow_back` → lss.relation = 'first' (outreach_trg_relation advances +2 h)
//   runIdentifierCheck  WA: "is this number on WhatsApp?" for leads about to get a new chat; never spends a new_chat
//   runBlockDetect      IG/WA: block signals inferred from failed sends after a one-way chat → outreach_record_block
//   runTranscribe       voice notes → transcript (transcribe.ts)
//   runWaGovernor       WA: outreach_wa_governor per sender (also called nightly by worker-health)
// Every provider call reserves a budget first (reserve → call → consume, release on failure).
import { admin, log, rpc, emitEvent, localParts, rand, randInt } from "./supabase.ts";
import { unipile, unipileConfigured, UnipileError } from "./unipile.ts";
import { isNotOnWhatsApp, phoneDigits, instagramHandle } from "./channels.ts";
import { transcribeVoiceNote } from "./transcribe.ts";

type Row = Record<string, any>;

const LIVE = ["active", "waiting_connection", "waiting_delay", "waiting_task"];

// ---------------------------------------------------------------------------
// Instagram followers poll (wait_follow_back detection)
// ---------------------------------------------------------------------------
const FOLLOWERS_PAGE = 25;      // the provider's maximum per page
const FOLLOWERS_MAX_PAGES = 4;  // newest first; a poll stops after a page whose ids are all known

/** The Instagram identities of this sender's leads that wait for a follow back, keyed by provider id and by handle. */
async function pendingFollowBacks(sender: Row): Promise<{ byId: Map<string, string>; byHandle: Map<string, string> }> {
  const byId = new Map<string, string>(), byHandle = new Map<string, string>();
  // an Instagram enrollment in waiting_connection can only be on a wait_follow_back step (there are no invitations on Instagram)
  const { data: enr } = await admin.from("outreach_enrollments").select("lead_id").eq("sender_id", sender.id).eq("status", "waiting_connection").limit(1000);
  const leadIds = [...new Set((enr ?? []).map((e) => e.lead_id).filter(Boolean))];
  if (!leadIds.length) return { byId, byHandle };
  for (let i = 0; i < leadIds.length; i += 200) {
    const { data: ids } = await admin.from("outreach_lead_identities").select("lead_id, identifier, provider_id").eq("workspace_id", sender.workspace_id).eq("provider", "INSTAGRAM").in("lead_id", leadIds.slice(i, i + 200));
    for (const r of ids ?? []) {
      if (r.provider_id) byId.set(String(r.provider_id), r.lead_id);
      const h = instagramHandle(r.identifier);
      if (h) byHandle.set(h, r.lead_id);
    }
  }
  return { byId, byHandle };
}

async function markFollowedBack(sender: Row, leadId: string, follower: Row): Promise<boolean> {
  const { data: lss } = await admin.from("outreach_lead_sender_state").select("relation, invite_accepted_at").eq("lead_id", leadId).eq("sender_id", sender.id).maybeSingle();
  if (lss?.relation === "first" || lss?.relation === "blocked" || lss?.relation === "invalid") return false;
  const now = new Date().toISOString();
  await admin.from("outreach_lead_sender_state").upsert({ lead_id: leadId, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
  await admin.from("outreach_lead_sender_state").update({ relation: "first", invite_accepted_at: lss?.invite_accepted_at ?? now, invite_detected_at: now, updated_at: now }).eq("lead_id", leadId).eq("sender_id", sender.id);
  // the identity now has the user id; the profile picture fills an empty lead picture
  if (follower.id) await admin.from("outreach_lead_identities").update({ provider_id: String(follower.id), verified: true }).eq("workspace_id", sender.workspace_id).eq("provider", "INSTAGRAM").eq("lead_id", leadId).is("provider_id", null);
  if (follower.profile_picture_url) await admin.from("outreach_leads").update({ picture_url: follower.profile_picture_url }).eq("id", leadId).is("picture_url", null);
  await emitEvent(sender.workspace_id, "lead.followed_back", { lead_id: leadId, sender_id: sender.id, username: follower.username ?? null });
  return true;
}

export async function runFollowersPoll(): Promise<Row> {
  if (!unipileConfigured()) return { polled: 0, skipped: "connector_not_configured" };
  const { data: senders } = await admin.from("outreach_senders").select("*").eq("status", "ok").is("deleted_at", null).eq("provider", "INSTAGRAM");
  let polled = 0, matched = 0, planned = 0;
  for (const s of senders ?? []) {
    if (s.paused_until && new Date(s.paused_until).getTime() > Date.now()) continue;
    const pending = await pendingFollowBacks(s);
    if (!pending.byId.size && !pending.byHandle.size) continue;
    const lp = localParts(s.timezone ?? "UTC");
    const day = lp.date;
    let { data: plan } = await admin.from("outreach_followers_poll_plan").select("*").eq("sender_id", s.id).eq("day", day).maybeSingle();
    if (!plan) {
      // 1–3 polls a day at random offsets inside the working windows, never more than today's followers_poll allowance
      const windows = await rpc<Row[]>("schedule_windows", { p_sender: s.id, p_day: day });
      if (!windows?.length) continue;
      const budgets = await rpc<Row[]>("plan_budgets", { p_sender: s.id, p_day: day }).catch(() => [] as Row[]);
      const cap = Number(budgets.find((b) => b.action_type === "followers_poll")?.cap ?? 1);
      const n = Math.max(1, Math.min(3, cap, randInt(1, 3)));
      const times: string[] = [];
      for (let i = 0; i < n; i++) {
        const w = windows[randInt(0, windows.length - 1)];
        const st = new Date(w.start_at).getTime() + 15 * 60_000, en = new Date(w.end_at).getTime() - 15 * 60_000;
        if (en > st) times.push(new Date(st + rand(0, en - st)).toISOString());
      }
      times.sort();
      const { data: p, error } = await admin.from("outreach_followers_poll_plan").insert({ sender_id: s.id, day, times }).select("*").single();
      if (error) { log({ fn: "followers-poll", sender_id: s.id, warn: `plan insert: ${error.message}` }); continue; }
      plan = p; planned++;
    }
    if (!plan) continue;
    const due = (plan.times ?? []).filter((t: string) => new Date(t).getTime() <= Date.now()).length;
    if (due <= (plan.done ?? 0)) continue;
    const dayStr = await rpc<string>("sender_local_date", { p_sender: s.id, p_at: new Date().toISOString() });
    const ok = await rpc<boolean>("reserve_budget", { p_sender: s.id, p_day: dayStr, p_type: "followers_poll" }).catch(() => false);
    if (!ok) { log({ fn: "followers-poll", sender_id: s.id, skipped: "no_budget" }); continue; }
    let hits = 0, pages = 0, seen = 0;
    try {
      let cursor: string | undefined;
      do {
        const res = await unipile.users.followers(s.unipile_account_id, { cursor, limit: FOLLOWERS_PAGE });
        pages++;
        const items: Row[] = res.items ?? [];
        if (!items.length) break;
        seen += items.length;
        const ids = items.map((f) => String(f.id ?? f.provider_id ?? "")).filter(Boolean);
        const { data: known } = ids.length ? await admin.from("outreach_sender_followers").select("provider_id").eq("sender_id", s.id).in("provider_id", ids) : { data: [] as Row[] };
        const knownIds = new Set((known ?? []).map((k) => String(k.provider_id)));
        const now = new Date().toISOString();
        const rows = items.filter((f) => f.id ?? f.provider_id).map((f) => ({ sender_id: s.id, provider_id: String(f.id ?? f.provider_id), username: instagramHandle(f.username) ?? (String(f.username ?? "").toLowerCase() || null), first_seen_at: now, last_seen_at: now }));
        if (rows.length) {
          // first_seen_at stays as it was for a known follower; last_seen_at moves
          const fresh = rows.filter((r) => !knownIds.has(r.provider_id));
          if (fresh.length) await admin.from("outreach_sender_followers").upsert(fresh, { onConflict: "sender_id,provider_id", ignoreDuplicates: true });
          if (knownIds.size) await admin.from("outreach_sender_followers").update({ last_seen_at: now }).eq("sender_id", s.id).in("provider_id", [...knownIds]);
        }
        for (const f of items) {
          const id = String(f.id ?? f.provider_id ?? "");
          const handle = instagramHandle(f.username);
          const leadId = (id && pending.byId.get(id)) || (handle && pending.byHandle.get(handle)) || null;
          if (leadId && await markFollowedBack(s, leadId, f)) hits++;
        }
        // newest first: once a whole page is already known, older pages are too
        if (ids.length && ids.every((id) => knownIds.has(id))) break;
        cursor = res.cursor ?? undefined;
      } while (cursor && pages < FOLLOWERS_MAX_PAGES);
      await rpc("consume_budget", { p_sender: s.id, p_day: dayStr, p_type: "followers_poll" }).catch((e) => log({ fn: "followers-poll", warn: `consume: ${String(e)}` }));
      polled++; matched += hits;
    } catch (e) {
      await rpc("release_budget", { p_sender: s.id, p_day: dayStr, p_type: "followers_poll" }).catch(() => null);
      log({ fn: "followers-poll", sender_id: s.id, error: e instanceof UnipileError ? `${e.status}:${e.code} ${e.message}` : String(e) });
    }
    await admin.from("outreach_followers_poll_plan").update({ done: (plan.done ?? 0) + 1 }).eq("sender_id", s.id).eq("day", day);
    log({ fn: "followers-poll", sender_id: s.id, pages, seen, followed_back: hits });
  }
  return { polled, matched, planned };
}

// ---------------------------------------------------------------------------
// WhatsApp identifier check ("is this number on WhatsApp?")
// ---------------------------------------------------------------------------
const CHECK_MAX_PER_SENDER = 20;

/** Leads of this WhatsApp sender whose number has never been checked and that are about to be contacted. */
async function leadsToCheck(sender: Row, limit: number): Promise<Row[]> {
  const ids = new Set<string>();
  const { data: queued } = await admin.from("outreach_actions").select("lead_id").eq("sender_id", sender.id).eq("action_type", "new_chat").in("status", ["queued", "reserved"]).not("lead_id", "is", null).limit(500);
  for (const a of queued ?? []) if (a.lead_id) ids.add(a.lead_id);
  const { data: enrolled } = await admin.from("outreach_enrollments").select("lead_id").eq("sender_id", sender.id).in("status", LIVE).limit(500);
  for (const e of enrolled ?? []) if (e.lead_id) ids.add(e.lead_id);
  if (!ids.size) return [];
  const out: Row[] = [];
  const all = [...ids];
  for (let i = 0; i < all.length && out.length < limit; i += 200) {
    const { data } = await admin.from("outreach_lead_identities").select("id, lead_id, identifier, provider_id").eq("workspace_id", sender.workspace_id).eq("provider", "WHATSAPP").eq("verified", true).is("is_valid", null).in("lead_id", all.slice(i, i + 200)).limit(limit - out.length);
    for (const r of data ?? []) out.push(r);
  }
  return out;
}

/** Check one identity. Returns 'valid' | 'invalid' | 'error'; the budget is consumed when the provider answered either way. */
async function checkIdentity(sender: Row, ident: Row, day: string): Promise<"valid" | "invalid" | "error" | "no_budget"> {
  const digits = phoneDigits(ident.identifier);
  if (!digits) { await rpc("identity_set_check", { p_id: ident.id, p_valid: false, p_provider_id: null }).catch(() => null); return "invalid"; }
  const ok = await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: "identifier_check" }).catch(() => false);
  if (!ok) return "no_budget";
  try {
    const prof = await unipile.users.profile(sender.unipile_account_id, digits);
    await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "identifier_check" }).catch(() => null);
    const pid = prof?.id ? String(prof.id) : prof?.provider_id ? String(prof.provider_id) : null;
    await rpc("identity_set_check", { p_id: ident.id, p_valid: true, p_provider_id: pid });
    const patch: Record<string, unknown> = {};
    if (prof?.name) patch.full_name = String(prof.name);
    if (prof?.profile_picture_url) patch.picture_url = prof.profile_picture_url;
    if (Object.keys(patch).length) {
      const { data: lead } = await admin.from("outreach_leads").select("full_name, picture_url").eq("id", ident.lead_id).maybeSingle();
      const p2: Record<string, unknown> = {};
      if (patch.full_name && !lead?.full_name) p2.full_name = patch.full_name;
      if (patch.picture_url && !lead?.picture_url) p2.picture_url = patch.picture_url;
      if (Object.keys(p2).length) await admin.from("outreach_leads").update(p2).eq("id", ident.lead_id);
    }
    return "valid";
  } catch (e) {
    if (isNotOnWhatsApp(e)) {
      await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "identifier_check" }).catch(() => null);   // the provider answered
      await rpc("identity_set_check", { p_id: ident.id, p_valid: false, p_provider_id: null }).catch(() => null);
      await admin.from("outreach_lead_sender_state").upsert({ lead_id: ident.lead_id, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
      await admin.from("outreach_lead_sender_state").update({ relation: "invalid", updated_at: new Date().toISOString() }).eq("lead_id", ident.lead_id).eq("sender_id", sender.id);
      await emitEvent(sender.workspace_id, "lead.identifier_invalid", { lead_id: ident.lead_id, sender_id: sender.id, provider: "WHATSAPP", code: e instanceof UnipileError ? e.code : String(e) });
      return "invalid";
    }
    await rpc("release_budget", { p_sender: sender.id, p_day: day, p_type: "identifier_check" }).catch(() => null);
    log({ fn: "identifier-check", sender_id: sender.id, lead_id: ident.lead_id, error: e instanceof UnipileError ? `${e.status}:${e.code} ${e.message}` : String(e) });
    return "error";
  }
}

/** WhatsApp senders (or one sender): validate up to 20 unchecked numbers each. */
export async function runIdentifierCheck(senderId?: string): Promise<Row> {
  if (!unipileConfigured()) return { checked: 0, valid: 0, invalid: 0, skipped: "connector_not_configured" };
  const q = admin.from("outreach_senders").select("*").eq("provider", "WHATSAPP").is("deleted_at", null);
  const { data: senders } = senderId ? await q.eq("id", senderId) : await q.eq("status", "ok");
  let checked = 0, valid = 0, invalid = 0, errors = 0, noBudget = 0;
  for (const s of senders ?? []) {
    if (!s.unipile_account_id || (s.status !== "ok" && !senderId)) continue;
    const day = await rpc<string>("sender_local_date", { p_sender: s.id, p_at: new Date().toISOString() });
    const idents = await leadsToCheck(s, CHECK_MAX_PER_SENDER);
    for (const ident of idents) {
      const r = await checkIdentity(s, ident, day);
      if (r === "no_budget") { noBudget++; break; }
      if (r === "error") { errors++; if (errors >= 3) break; continue; }
      checked++;
      if (r === "valid") valid++; else invalid++;
    }
  }
  return { checked, valid, invalid, errors, no_budget: noBudget };
}

// ---------------------------------------------------------------------------
// Block detection (inferred from failed sends after one-way chats)
// ---------------------------------------------------------------------------
async function blockAlreadyRecorded(senderId: string, leadId: string, sinceDays = 30): Promise<boolean> {
  const { data } = await admin.from("outreach_sender_events").select("id").eq("sender_id", senderId).eq("kind", "block").contains("data", { lead_id: leadId }).gte("at", new Date(Date.now() - sinceDays * 86400_000).toISOString()).limit(1).maybeSingle();
  return !!data;
}

export async function runBlockDetect(): Promise<Row> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: senders } = await admin.from("outreach_senders").select("id, workspace_id, provider").in("provider", ["INSTAGRAM", "WHATSAPP"]).is("deleted_at", null);
  const senderIds = (senders ?? []).map((s) => s.id);
  if (!senderIds.length) return { recorded: 0, scanned: 0 };
  let recorded = 0, scanned = 0;
  // failed sends on Instagram / WhatsApp senders in the last 30 days, newest first
  const { data: failed } = await admin.from("outreach_actions").select("id, sender_id, lead_id, action_type, error_code, executed_at").in("sender_id", senderIds).in("action_type", ["new_chat", "message", "reply"]).eq("status", "failed").not("lead_id", "is", null).gte("executed_at", since).order("executed_at", { ascending: false }).limit(300);
  for (const a of failed ?? []) {
    scanned++;
    const code = String(a.error_code ?? "");
    const explicitBlock = /blocked_recipient/i.test(code);
    let oneWay = false;
    if (!explicitBlock) {
      // one-way chat: our new_chat went out ≥ 7 days ago, nobody ever answered, and this later message failed
      if (a.action_type === "reply") continue;
      const { data: first } = await admin.from("outreach_actions").select("executed_at").eq("sender_id", a.sender_id).eq("lead_id", a.lead_id).eq("action_type", "new_chat").eq("status", "sent").lte("executed_at", new Date(Date.now() - 7 * 86400_000).toISOString()).order("executed_at", { ascending: true }).limit(1).maybeSingle();
      if (!first?.executed_at || new Date(first.executed_at).getTime() >= new Date(a.executed_at).getTime()) continue;
      const { data: chats } = await admin.from("outreach_chats").select("id").eq("sender_id", a.sender_id).eq("lead_id", a.lead_id);
      const chatIds = (chats ?? []).map((c) => c.id);
      if (chatIds.length) {
        const { count } = await admin.from("outreach_messages").select("id", { count: "exact", head: true }).in("chat_id", chatIds).eq("direction", "in");
        if ((count ?? 0) > 0) continue;
      }
      // a failure that is plainly not the recipient's doing (our session, the network, a cap) is not a block
      if (/^(0|401|403|429|5\d\d):|network|not_configured|tick_timeout|E_BUDGET|E_CAP/i.test(code)) continue;
      oneWay = true;
    }
    if (await blockAlreadyRecorded(a.sender_id, a.lead_id)) continue;
    try {
      await rpc("record_block", { p_sender: a.sender_id, p_lead: a.lead_id, p_code: explicitBlock ? code.slice(0, 120) : `one_way_failed_send:${code.slice(0, 80)}`, p_action: a.id });
      recorded++;
      const s = (senders ?? []).find((x) => x.id === a.sender_id);
      if (s) await emitEvent(s.workspace_id, "sender.block_detected", { sender_id: a.sender_id, lead_id: a.lead_id, action_id: a.id, code, inferred: oneWay });
    } catch (e) { log({ fn: "block-detect", action_id: a.id, warn: `record_block: ${String((e as any)?.message ?? e)}` }); }
  }
  return { recorded, scanned };
}

// ---------------------------------------------------------------------------
// Voice-note transcription queue
// ---------------------------------------------------------------------------
export async function runTranscribe(limit = 10): Promise<Row> {
  const { data: q, error } = await admin.from("outreach_transcribe_queue").select("*").lt("attempts", 3).or(`locked_at.is.null,locked_at.lt.${new Date(Date.now() - 5 * 60_000).toISOString()}`).order("created_at").limit(limit);
  if (error) return { done: 0, failed: 0, errors: [`queue read: ${error.message}`] };
  let done = 0, failed = 0, retried = 0;
  const started = Date.now();
  for (const item of q ?? []) {
    if (Date.now() - started > 45_000) break;
    await admin.from("outreach_transcribe_queue").update({ locked_at: new Date().toISOString(), attempts: (item.attempts ?? 0) + 1 }).eq("message_id", item.message_id);
    try {
      const r = await transcribeVoiceNote(item.message_id);
      if (r.status === "retry") {
        retried++;
        if ((item.attempts ?? 0) + 1 >= 3) { await admin.from("outreach_messages").update({ transcript_status: "failed" }).eq("id", item.message_id); await admin.from("outreach_transcribe_queue").delete().eq("message_id", item.message_id); failed++; }
        continue;
      }
      if (r.status === "done") done++; else failed++;
      await admin.from("outreach_transcribe_queue").delete().eq("message_id", item.message_id);
    } catch (e) {
      failed++;
      log({ fn: "transcribe", message_id: item.message_id, error: String((e as any)?.message ?? e) });
      if ((item.attempts ?? 0) + 1 >= 3) { await admin.from("outreach_messages").update({ transcript_status: "failed" }).eq("id", item.message_id); await admin.from("outreach_transcribe_queue").delete().eq("message_id", item.message_id); }
    }
  }
  return { done, failed, retried };
}

// ---------------------------------------------------------------------------
// WhatsApp governor (PRD §7.4): promotion / demotion per sender, in the database
// ---------------------------------------------------------------------------
export async function runWaGovernor(): Promise<Row> {
  const { data: senders } = await admin.from("outreach_senders").select("id, workspace_id, warmup_level").eq("provider", "WHATSAPP").is("deleted_at", null).neq("status", "disabled");
  const results: Row[] = [];
  let changed = 0;
  for (const s of senders ?? []) {
    try {
      const g = await rpc<Row>("wa_governor", { p_sender: s.id });
      results.push({ sender_id: s.id, ...(g ?? {}) });
      if (g && g.level_before != null && g.level_after != null && g.level_before !== g.level_after) { changed++; await emitEvent(s.workspace_id, "sender.warmup", { id: s.id, ...g }); }
    } catch (e) { results.push({ sender_id: s.id, error: String((e as any)?.message ?? e).slice(0, 200) }); }
  }
  return { senders: (senders ?? []).length, changed, results };
}
