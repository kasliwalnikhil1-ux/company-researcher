// Action execution for worker-tick: the only path to Unipile writes (plus send-reply / imports / reconnect / sender-*).
import { admin, log, rpc, emitEvent, randInt, sha256Hex } from "./supabase.ts";
import { unipile, UnipileError, distanceToRelation, invitationPending } from "./unipile.ts";
import { handleUnipileError, isRejectCode, type Decision } from "./errors.ts";
import { renderTemplate } from "./render.ts";
import { recordReject } from "./health.ts";
import { notifySender } from "./notify.ts";
import { reconnectLink } from "./inbound.ts";

type Row = Record<string, any>;

export type ExecResult = { ok: true; response: unknown; branch?: string | null } | { ok: false; decision: Decision; code: string; retryAt?: Date; branch?: string | null };

const LIMITS = { invite_note: 300, invite_note_free: 200, message: 8000, comment: 1250, inmail_subject: 200, inmail_body: 1900 };

export async function loadContext(action: Row) {
  const [{ data: sender }, { data: lead }, { data: enrollment }] = await Promise.all([
    admin.from("outreach_senders").select("*").eq("id", action.sender_id).single(),
    action.lead_id ? admin.from("outreach_leads").select("*").eq("id", action.lead_id).maybeSingle() : Promise.resolve({ data: null } as any),
    action.enrollment_id ? admin.from("outreach_enrollments").select("*").eq("id", action.enrollment_id).maybeSingle() : Promise.resolve({ data: null } as any),
  ]);
  let sequence: Row | null = null, node: Row | null = null, lss: Row | null = null;
  if (enrollment) {
    const { data: seq } = await admin.from("outreach_sequences").select("*").eq("id", enrollment.sequence_id).single();
    sequence = seq;
    node = seq?.graph?.nodes?.[action.node_id] ?? null;
    if (action.payload?.subtask && node?.config?.subtasks?.[action.payload.subtask_index]) node = { ...node, type: action.payload.subtask_type ?? node.config.subtasks[action.payload.subtask_index].type, config: { ...node.config.subtasks[action.payload.subtask_index] } };
  }
  if (lead && sender) {
    const { data: st } = await admin.from("outreach_lead_sender_state").select("*").eq("lead_id", lead.id).eq("sender_id", sender.id).maybeSingle();
    lss = st;
    if (!lss && action.lead_id) {
      await admin.from("outreach_lead_sender_state").upsert({ lead_id: lead.id, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
      lss = { lead_id: lead.id, sender_id: sender.id, relation: "none", replied: false };
    }
  }
  return { sender, lead, enrollment, sequence, node, lss };
}

function ctxFor(lead: Row | null, sender: Row) {
  const senderCtx = { ...sender, first_name: (sender.display_name ?? "").split(" ")[0], full_name: sender.display_name };
  return { lead: lead ?? {}, sender: senderCtx };
}

async function updateLeadFromProfile(lead: Row, prof: Row): Promise<Row> {
  const current = (prof.work_experience ?? []).find((w: Row) => w.current) ?? prof.work_experience?.[0];
  const patch: Record<string, unknown> = {
    provider_id: prof.provider_id ?? lead.provider_id,
    public_identifier: lead.public_identifier ?? (prof.public_identifier ? String(prof.public_identifier).toLowerCase() : null),
    first_name: prof.first_name ?? lead.first_name,
    last_name: prof.last_name ?? lead.last_name,
    full_name: [prof.first_name, prof.last_name].filter(Boolean).join(" ") || lead.full_name,
    headline: prof.headline ?? lead.headline,
    location: prof.location ?? lead.location,
    picture_url: prof.profile_picture_url ?? lead.picture_url,
    is_open_profile: typeof prof.is_open_profile === "boolean" ? prof.is_open_profile : lead.is_open_profile,
    company: current?.company ?? lead.company,
    company_id: current?.company_id ?? lead.company_id,
    title: current?.position ?? lead.title,
    profile_url: prof.public_profile_url ?? lead.profile_url,
    last_profile_fetch_at: new Date().toISOString(),
  };
  if (prof.contact_info?.emails?.length && !lead.email_work) patch.email_work = String(prof.contact_info.emails[0]).toLowerCase();
  const { data } = await admin.from("outreach_leads").update(patch).eq("id", lead.id).select("*").single();
  return data ?? { ...lead, ...patch };
}

async function syncRelationFromProfile(lead: Row, sender: Row, prof: Row, lss: Row | null): Promise<string> {
  const rel = distanceToRelation(prof.network_distance);
  const pending = invitationPending(prof);
  let relation = lss?.relation ?? "none";
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (rel === "first") { relation = "first"; patch.relation = "first"; if (!lss?.invite_accepted_at) patch.invite_accepted_at = new Date().toISOString(); patch.invite_detected_at = lss?.invite_detected_at ?? new Date().toISOString(); }
  else if (pending) { relation = "pending_out"; patch.relation = "pending_out"; }
  else if (relation === "first" && rel === "none") { /* keep: profile may be throttled */ }
  else if (relation !== "invalid" && relation !== "blocked" && rel === "none" && relation !== "pending_out") { patch.relation = "none"; relation = "none"; }
  if (Object.keys(patch).length > 1) await admin.from("outreach_lead_sender_state").update(patch).eq("lead_id", lead.id).eq("sender_id", sender.id);
  return relation;
}

async function fetchProfile(sender: Row, lead: Row, opts: { notify?: boolean; sections?: string } = {}): Promise<Row> {
  const ident = lead.provider_id ?? lead.public_identifier;
  if (!ident) throw new UnipileError(422, "errors/invalid_recipient", "lead has no LinkedIn identifier", null);
  return unipile.users.profile(sender.unipile_account_id, ident, { notify: opts.notify ?? false, linkedin_sections: opts.sections ?? "*_preview" });
}

async function ensureChatRow(sender: Row, lead: Row | null, unipileChatId: string, subject?: string | null): Promise<Row> {
  const { data } = await admin.from("outreach_chats").upsert({
    workspace_id: sender.workspace_id, client_id: sender.client_id, sender_id: sender.id, lead_id: lead?.id ?? null, unipile_chat_id: unipileChatId, provider: sender.provider,
    attendee_provider_id: lead?.provider_id ?? lead?.email_work ?? null, attendee_public_identifier: lead?.public_identifier ?? null, attendee_name: lead?.full_name ?? null, attendee_picture_url: lead?.picture_url ?? null, subject: subject ?? null,
  }, { onConflict: "sender_id,unipile_chat_id" }).select("*").single();
  return data!;
}

async function recordOutbound(sender: Row, lead: Row | null, chat: Row, text: string | null, html: string | null, unipileMessageId: string | null, actionId: string, isInviteNote = false, attachments: unknown[] = []) {
  const { data: msg } = await admin.from("outreach_messages").upsert({
    workspace_id: sender.workspace_id, chat_id: chat.id, unipile_message_id: unipileMessageId, direction: "out", text, html, attachments, sent_at: new Date().toISOString(), action_id: actionId, is_invite_note: isInviteNote,
  }, { onConflict: "unipile_message_id", ignoreDuplicates: false }).select("id").maybeSingle();
  if (lead) await admin.from("outreach_lead_sender_state").update({ last_outbound_at: new Date().toISOString(), unipile_chat_id: chat.unipile_chat_id, updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
  return msg;
}

async function latestPost(sender: Row, lead: Row, maxAgeDays: number): Promise<Row | null> {
  const ident = lead.provider_id;
  if (!ident) return null;
  const res = await unipile.users.posts(sender.unipile_account_id, ident, 5);
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const posts = (res.items ?? []).filter((p: Row) => !p.is_repost);
  for (const p of posts) {
    const d = p.parsed_datetime ?? p.date;
    const t = d ? Date.parse(d) : NaN;
    if (isNaN(t) || t >= cutoff) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
export async function executeAction(action: Row): Promise<ExecResult> {
  const { sender, lead, enrollment, sequence, node, lss } = await loadContext(action);
  if (!sender || !sender.unipile_account_id) return { ok: false, decision: { kind: "sender_credentials", reason: "no_account" }, code: "E_SENDER_NOT_OK" };
  const type: string = action.action_type;
  const cfg: Row = { ...(node?.config ?? {}), ...(action.payload ?? {}) };
  const hasBranch = (b: string) => !!node?.branches && node.branches[b] != null;
  const baseCtx = { actionType: type, attempt: action.attempt ?? 1, senderTimezone: sender.timezone ?? "UTC", hasBranch };

  // ---- pre-checks (PRD F3 step 2)
  if (lead?.do_not_contact || lead?.unsubscribed) return { ok: false, decision: { kind: "fail_enrollment", reason: "lead_suppressed" }, code: "E_LEAD_SUPPRESSED" };
  if (enrollment) {
    const live = ["active", "waiting_connection", "waiting_delay", "waiting_task"];
    if (!live.includes(enrollment.status)) return { ok: false, decision: { kind: "fail_enrollment", reason: "enrollment_not_live" }, code: "E_ENROLLMENT_NOT_LIVE" };
    if (sequence?.status !== "active") return { ok: false, decision: { kind: "retry", at: new Date(Date.now() + 6 * 3600_000), reason: "sequence_not_active" }, code: "E_SEQUENCE_PAUSED" };
    if (lss?.replied && !cfg.send_always && !action.payload?.prefetch && ["message", "inmail", "email", "invite"].includes(type)) return { ok: false, decision: { kind: "fail_enrollment", reason: "replied" }, code: "E_REPLIED" };
  }
  if (type === "invite") {
    const used = await rpc<number>("weekly_invites_used", { p_sender: sender.id, p_day: new Date().toISOString().slice(0, 10) });
    const { data: ceil } = await admin.from("outreach_platform_ceilings").select("per_week").eq("action_type", "invite").single();
    if (used > (ceil?.per_week ?? 150)) return { ok: false, decision: { kind: "retry", at: new Date(Date.now() + 24 * 3600_000), reason: "weekly_cap" }, code: "E_CAP_HIT_WEEKLY" };
    if (lss?.relation === "first") return { ok: false, decision: hasBranch("connected") ? { kind: "branch", name: "connected", reason: "already_connected" } : { kind: "skip_node", reason: "already_connected" }, code: "already_connected" };
    if (lss?.relation === "pending_out") return { ok: false, decision: { kind: "skip_node", reason: "invitation_pending" }, code: "invitation_pending" };
    if (lss?.relation === "invalid" || lss?.relation === "blocked") return { ok: false, decision: { kind: "fail_enrollment", reason: `relation_${lss.relation}` }, code: "E_RELATION_INVALID" };
  }
  if (type === "message" && lss?.relation !== "first" && !cfg.send_always) {
    // verify with a live profile fetch (may have been accepted without note / stale state); uses profile_view budget when available
    let relation = lss?.relation ?? "none";
    if (lead && (lead.provider_id || lead.public_identifier)) {
      try {
        const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
        const reserved = await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => false);
        const prof = await fetchProfile(sender, lead);
        await updateLeadFromProfile(lead, prof);
        relation = await syncRelationFromProfile(lead, sender, prof, lss);
        if (reserved) await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "profile_view" }).catch(() => null);
      } catch (e) { log({ fn: "execute", warn: "relation verify failed", error: String(e) }); }
    }
    if (relation !== "first") return { ok: false, decision: hasBranch("not_connected") ? { kind: "branch", name: "not_connected", reason: "not_connected" } : { kind: "skip_node", reason: "not_connected" }, code: "E_RELATION_REQUIRED" };
  }

  const ctx = ctxFor(lead, sender);
  try {
    switch (type) {
      case "profile_view": {
        if (!lead) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        const prof = await fetchProfile(sender, lead, { notify: cfg.notify !== false, sections: cfg.sections ?? "*_preview" });
        const updated = await updateLeadFromProfile(lead, prof);
        const relation = await syncRelationFromProfile(updated, sender, prof, lss);
        return { ok: true, response: { provider_id: prof.provider_id, network_distance: prof.network_distance, relation, is_open_profile: prof.is_open_profile, connections_count: prof.connections_count } };
      }
      case "invite": {
        if (!lead) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        let l = lead;
        if (!l.provider_id) { const prof = await fetchProfile(sender, l); l = await updateLeadFromProfile(l, prof); const rel = await syncRelationFromProfile(l, sender, prof, lss); if (rel === "first") return { ok: false, decision: hasBranch("connected") ? { kind: "branch", name: "connected", reason: "already_connected" } : { kind: "skip_node", reason: "already_connected" }, code: "already_connected" }; if (rel === "pending_out") return { ok: false, decision: { kind: "skip_node", reason: "invitation_pending" }, code: "invitation_pending" }; }
        let note = renderTemplate(cfg.text ?? cfg.note ?? "", ctx).trim();
        const limit = sender.is_premium ? LIMITS.invite_note : LIMITS.invite_note_free;
        if (!sender.is_premium && !cfg.require_note_for_free && note.length > LIMITS.invite_note_free) note = "";
        if (note.length > limit) note = note.slice(0, limit);
        const res = await unipile.users.invite({ account_id: sender.unipile_account_id, provider_id: l.provider_id, message: note || undefined });
        const now = new Date().toISOString();
        await admin.from("outreach_lead_sender_state").update({ relation: "pending_out", invitation_id: res.invitation_id ?? null, invite_sent_at: now, invite_had_note: !!note, invite_withdrawn_at: null, updated_at: now }).eq("lead_id", l.id).eq("sender_id", sender.id);
        await emitEvent(sender.workspace_id, "invite.sent", { lead_id: l.id, sender_id: sender.id, invitation_id: res.invitation_id ?? null, note: !!note });
        return { ok: true, response: { invitation_id: res.invitation_id, usage: res.usage ?? null, note_length: note.length } };
      }
      case "withdraw": {
        if (!lead || !lss?.invitation_id) return { ok: false, decision: { kind: "skip_node", reason: "no_invitation" }, code: "no_invitation" };
        await unipile.users.cancelInvite(sender.unipile_account_id, lss.invitation_id);
        const now = new Date().toISOString();
        await admin.from("outreach_lead_sender_state").update({ relation: "none", invite_withdrawn_at: now, invitation_id: null, updated_at: now }).eq("lead_id", lead.id).eq("sender_id", sender.id);
        await emitEvent(sender.workspace_id, "invite.withdrawn", { lead_id: lead.id, sender_id: sender.id });
        return { ok: true, response: { withdrawn: true } };
      }
      case "message":
      case "inmail":
      case "reply": {
        if (!lead) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        const text = renderTemplate(cfg.text ?? "", ctx).trim().slice(0, type === "inmail" ? LIMITS.inmail_body : LIMITS.message);
        if (!text) return { ok: false, decision: { kind: "fail_enrollment", reason: "empty_text" }, code: "E_PAYLOAD_INVALID" };
        let chatId = lss?.unipile_chat_id ?? null;
        let messageId: string | null = null;
        let subject: string | null = null;
        if (type === "inmail") {
          if (cfg.open_profile_only && lead.is_open_profile === false) return { ok: false, decision: hasBranch("no_credit") ? { kind: "branch", name: "no_credit", reason: "not_open_profile" } : { kind: "skip_node", reason: "not_open_profile" }, code: "not_open_profile" };
          subject = renderTemplate(cfg.subject ?? "", ctx).slice(0, LIMITS.inmail_subject);
          const r = await unipile.chats.start({ account_id: sender.unipile_account_id, attendees_ids: [lead.provider_id], text, subject: subject || undefined, linkedin: { api: cfg.api ?? "classic", inmail: true } });
          chatId = r.chat_id ?? chatId; messageId = r.message_id ?? null;
        } else if (chatId) {
          const r = await unipile.chats.send(chatId, { account_id: sender.unipile_account_id, text });
          messageId = r.message_id ?? null;
        } else {
          const r = await unipile.chats.start({ account_id: sender.unipile_account_id, attendees_ids: [lead.provider_id], text, linkedin: { api: "classic" } });
          chatId = r.chat_id ?? null; messageId = r.message_id ?? null;
        }
        if (chatId) {
          const chat = await ensureChatRow(sender, lead, chatId, subject);
          await recordOutbound(sender, lead, chat, text, null, messageId, action.id);
          await emitEvent(sender.workspace_id, "message.sent", { lead_id: lead.id, sender_id: sender.id, chat_id: chat.id, type });
        }
        return { ok: true, response: { chat_id: chatId, message_id: messageId } };
      }
      case "like": {
        if (!lead) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        let l = lead;
        if (!l.provider_id) { const prof = await fetchProfile(sender, l); l = await updateLeadFromProfile(l, prof); }
        const post = await latestPost(sender, l, cfg.max_age_days ?? 90);
        if (!post) return { ok: false, decision: { kind: "skip_node", reason: "no_recent_post" }, code: "no_recent_post" };
        await unipile.posts.react({ account_id: sender.unipile_account_id, post_id: post.social_id ?? post.id, reaction_type: cfg.reaction ?? "like" });
        return { ok: true, response: { post_id: post.social_id ?? post.id, share_url: post.share_url ?? null } };
      }
      case "comment": {
        if (!lead) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        let l = lead;
        if (!l.provider_id) { const prof = await fetchProfile(sender, l); l = await updateLeadFromProfile(l, prof); }
        const post = await latestPost(sender, l, cfg.max_age_days ?? 90);
        if (!post) return { ok: false, decision: { kind: "skip_node", reason: "no_recent_post" }, code: "no_recent_post" };
        const text = renderTemplate(cfg.text ?? "", { ...ctx, lead: { ...ctx.lead, post: post.text } }).trim().slice(0, LIMITS.comment);
        if (!text) return { ok: false, decision: { kind: "skip_node", reason: "empty_text" }, code: "E_PAYLOAD_INVALID" };
        const r = await unipile.posts.comment(post.social_id ?? post.id, { account_id: sender.unipile_account_id, text });
        return { ok: true, response: { post_id: post.social_id ?? post.id, comment_id: r.comment_id ?? null } };
      }
      case "endorse": {
        if (!lead) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        const prof = await fetchProfile(sender, lead, { sections: "skills" });
        const l = await updateLeadFromProfile(lead, prof);
        const skills = (prof.skills ?? []).filter((s: Row) => s.endorsement_id != null && !s.endorsed).slice(0, Math.max(1, Math.min(5, cfg.count ?? 1)));
        if (!skills.length) return { ok: false, decision: { kind: "skip_node", reason: "no_skills" }, code: "no_skills" };
        const done: string[] = [];
        for (const s of skills) { await unipile.linkedin.endorse({ account_id: sender.unipile_account_id, profile_id: l.provider_id, skill_endorsement_id: Number(s.endorsement_id) }); done.push(s.name); }
        return { ok: true, response: { endorsed: done } };
      }
      case "email": {
        if (!lead) throw new UnipileError(422, "errors/invalid_recipient", "no lead", null);
        const pref = cfg.to ?? "any";
        const to = pref === "work" ? lead.email_work : pref === "personal" ? lead.email_personal : (lead.email_work ?? lead.email_personal);
        if (!to) return { ok: false, decision: hasBranch("no_email") ? { kind: "branch", name: "no_email", reason: "no_email" } : { kind: "skip_node", reason: "no_email" }, code: "E_NO_EMAIL" };
        if (lss?.email_bounced) return { ok: false, decision: hasBranch("bounced") ? { kind: "branch", name: "bounced", reason: "bounced" } : { kind: "skip_node", reason: "bounced" }, code: "email_bounced" };
        const subject = renderTemplate(cfg.subject ?? "", ctx).trim();
        const html = renderTemplate(cfg.html ?? cfg.text ?? "", ctx);
        let replyTo: string | undefined;
        if ((cfg.thread ?? "continue") === "continue") {
          const { data: prev } = await admin.from("outreach_messages").select("unipile_message_id, outreach_chats!inner(sender_id, lead_id)").eq("direction", "out").eq("outreach_chats.sender_id", sender.id).eq("outreach_chats.lead_id", lead.id).not("unipile_message_id", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle();
          replyTo = (prev as any)?.unipile_message_id ?? undefined;
        }
        const r = await unipile.mails.send({ account_id: sender.unipile_account_id, to: [{ identifier: to, display_name: lead.full_name ?? undefined }], subject: subject || undefined, body: html, reply_to: replyTo, tracking_options: cfg.track === false ? undefined : { opens: true, links: true, label: action.id } });
        const threadKey = replyTo ? (lss?.unipile_chat_id ?? r.provider_id ?? r.tracking_id) : (r.provider_id ?? r.tracking_id);
        const chat = await ensureChatRow(sender, lead, threadKey, subject);
        await recordOutbound(sender, lead, chat, html.replace(/<[^>]+>/g, " ").trim(), html, r.provider_id ?? r.tracking_id, action.id);
        await emitEvent(sender.workspace_id, "email.sent", { lead_id: lead.id, sender_id: sender.id, tracking_id: r.tracking_id });
        return { ok: true, response: { tracking_id: r.tracking_id, provider_id: r.provider_id, to } };
      }
      case "call_api": {
        const url = renderTemplate(cfg.url ?? "", ctx);
        if (!url) return { ok: false, decision: hasBranch("error") ? { kind: "branch", name: "error", reason: "no_url" } : { kind: "skip_node", reason: "no_url" }, code: "E_PAYLOAD_INVALID" };
        const u = new URL(url);
        for (const [k, v] of Object.entries(cfg.query ?? {})) { const val = renderTemplate(String(v), ctx); if (!(cfg.remove_empty && !val)) u.searchParams.set(k, val); }
        const headers: Record<string, string> = { "content-type": "application/json" };
        for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = renderTemplate(String(v), ctx);
        let body: string | undefined;
        if ((cfg.method ?? "POST") !== "GET") {
          body = cfg.body ? renderTemplate(String(cfg.body), ctx) : JSON.stringify({ lead, sender: { id: sender.id, display_name: sender.display_name }, enrollment_id: enrollment?.id ?? null, sequence_id: sequence?.id ?? null });
        }
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
        try {
          const res = await fetch(u.toString(), { method: cfg.method ?? "POST", headers, body, signal: ctrl.signal });
          const txt = await res.text();
          if (!res.ok) return { ok: false, decision: hasBranch("error") ? { kind: "branch", name: "error", reason: `http_${res.status}` } : { kind: "skip_node", reason: `http_${res.status}` }, code: `http_${res.status}` };
          return { ok: true, response: { status: res.status, body: txt.slice(0, 2000) } };
        } finally { clearTimeout(t); }
      }
      default:
        return { ok: false, decision: { kind: "skip_node", reason: `unsupported_${type}` }, code: "E_UNSUPPORTED" };
    }
  } catch (e) {
    const decision = handleUnipileError(e, baseCtx);
    const code = e instanceof UnipileError ? `${e.status}:${e.code}` : String((e as any)?.message ?? e).slice(0, 120);
    if (isRejectCode(e)) {
      const paused = await recordReject(sender.id);
      if (paused) return { ok: false, decision: { kind: "sender_pause", hours: 24, reason: "reject_burst" }, code };
    }
    if (e instanceof UnipileError && e.code === "checkpoint_error") await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "checkpoint", data: { code } });
    if (decision.kind === "sender_credentials") {
      await admin.from("outreach_senders").update({ status: "credentials", status_reason: code, last_disconnect_at: new Date().toISOString() }).eq("id", sender.id).eq("status", "ok");
      if (sender.auth_method !== "cookie") { const link = await reconnectLink(sender).catch(() => null); await notifySender(sender.id, "reconnect_needed", { link }); }
    }
    if (decision.kind === "branch" && decision.name === "connected" && lead) {
      await admin.from("outreach_lead_sender_state").update({ relation: "first", invite_accepted_at: lss?.invite_accepted_at ?? new Date().toISOString(), updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
    }
    if (e instanceof UnipileError && e.code === "already_invited_recently" && lead) {
      await admin.from("outreach_lead_sender_state").update({ relation: "pending_out", updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
    }
    return { ok: false, decision, code };
  }
}

/** Persist the outcome through the ledger functions. */
export async function settle(action: Row, result: ExecResult): Promise<void> {
  if (result.ok) {
    await rpc("complete_action", { p_id: action.id, p_response: result.response ?? null, p_branch: result.branch ?? null });
    return;
  }
  const d = result.decision;
  const args: Record<string, unknown> = { p_id: action.id, p_code: result.code, p_decision: d.kind, p_retry_at: null, p_branch: null };
  if (d.kind === "retry") args.p_retry_at = d.at.toISOString();
  if (d.kind === "sender_cap_hit") args.p_retry_at = d.until.toISOString();
  if (d.kind === "sender_pause") args.p_retry_at = new Date(Date.now() + d.hours * 3600_000).toISOString();
  if (d.kind === "branch") args.p_branch = d.name;
  await rpc("fail_action", args);
}

export const _test = { sha256Hex, randInt };
