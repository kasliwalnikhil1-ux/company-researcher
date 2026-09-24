// Inbound Unipile event processing (F2 handlers).
import { admin, log, rpc, emitEvent, audit, randInt } from "./supabase.ts";
import { unipile, unipileConfigured, UnipileError, distanceToRelation, invitationPending, hostedBrowserOptions } from "./unipile.ts";
import { notifySender } from "./notify.ts";
import { healthForSender } from "./health.ts";
import { fillChatPicture } from "./avatars.ts";

type Sender = Record<string, any>;

export function deriveSource(p: any): { source: string; event_type: string | null; account_id: string | null } {
  if (p?.AccountStatus) return { source: "account_status", event_type: String(p.AccountStatus.message ?? "").toUpperCase(), account_id: p.AccountStatus.account_id ?? null };
  if (p?.event === "new_relation") return { source: "users", event_type: "new_relation", account_id: p.account_id ?? null };
  if (p?.tracking_id && p?.event && String(p.event).startsWith("mail_") && (p.event === "mail_opened" || p.event === "mail_link_clicked")) return { source: "mail_tracking", event_type: p.event, account_id: p.account_id ?? null };
  if (p?.email_id) return { source: "mail", event_type: p.event ?? "mail_received", account_id: p.account_id ?? null };
  if (p?.message_id || p?.chat_id) return { source: "messaging", event_type: p.event ?? "message_received", account_id: p.account_id ?? null };
  if (p?.event_id || String(p?.event ?? "").startsWith("calendar_")) return { source: "calendar", event_type: p.event ?? null, account_id: p.account_id ?? null };
  if (p?.status && p?.account_id && p?.name) return { source: "hosted_notify", event_type: String(p.status).toUpperCase(), account_id: p.account_id };
  return { source: "unknown", event_type: p?.event ?? null, account_id: p?.account_id ?? null };
}

async function senderByAccount(accountId: string | null): Promise<Sender | null> {
  if (!accountId) return null;
  const { data } = await admin.from("outreach_senders").select("*").eq("unipile_account_id", accountId).maybeSingle();
  return data ?? null;
}

// ---------------------------------------------------------------------------
// account_status
// ---------------------------------------------------------------------------
export async function syncOwnProfile(sender: Sender): Promise<Sender> {
  if (!sender.unipile_account_id || !unipileConfigured()) return sender;
  const patch: Record<string, unknown> = {};
  try {
    if (sender.provider === "LINKEDIN") {
      const me = await unipile.users.me(sender.unipile_account_id);
      patch.public_identifier = me.public_identifier ?? sender.public_identifier;
      patch.provider_user_id = me.provider_id ?? sender.provider_user_id;
      patch.display_name = sender.display_name ?? [me.first_name, me.last_name].filter(Boolean).join(" ") ?? sender.display_name;
      if (!sender.display_name || sender.display_name === "LinkedIn sender") patch.display_name = [me.first_name, me.last_name].filter(Boolean).join(" ") || sender.display_name;
      patch.picture_url = typeof me.profile_picture_url === "string" ? me.profile_picture_url : sender.picture_url;
      patch.is_premium = !!me.premium;
      patch.has_sales_nav = !!me.sales_navigator;
      patch.has_recruiter = !!me.recruiter;
      if (!sender.owner_email && me.email) patch.owner_email = me.email;
      // connections_count comes from the full profile
      try {
        const ident = me.public_identifier ?? me.provider_id;
        if (ident) {
          const prof = await unipile.users.profile(sender.unipile_account_id, ident, { linkedin_sections: "*_preview" });
          if (typeof prof.connections_count === "number") patch.connections_count = prof.connections_count;
          if (!patch.picture_url && prof.profile_picture_url) patch.picture_url = prof.profile_picture_url;
        }
      } catch (e) { log({ fn: "syncOwnProfile", warn: "profile fetch failed", error: String(e) }); }
    } else {
      const me = await unipile.users.me(sender.unipile_account_id);
      patch.public_identifier = me.email ?? sender.public_identifier;
      patch.display_name = sender.display_name ?? me.display_name ?? me.email ?? sender.display_name;
      if (!sender.owner_email && me.email) patch.owner_email = me.email;
    }
    // account connection method (cookies vs credentials) from Unipile
    try {
      const acc = await unipile.accounts.get(sender.unipile_account_id);
      const method = acc?.connection_params?.im?.connection_method;
      // "browser" (extension sign-in) is chosen at connect time and is not reported here; keep it.
      if (sender.auth_method !== "browser") {
        if (method === "cookies") patch.auth_method = "cookie";
        else if (method === "credentials") patch.auth_method = "credentials";
      }
      const proxyHost = acc?.connection_params?.im?.proxy?.host;
      if (proxyHost && !sender.proxy_country) patch.proxy_ip_hint = null;
    } catch { /* ignore */ }
  } catch (e) {
    log({ fn: "syncOwnProfile", error: String(e), sender_id: sender.id });
  }
  if (Object.keys(patch).length) {
    const { data } = await admin.from("outreach_senders").update(patch).eq("id", sender.id).select("*").single();
    return data ?? { ...sender, ...patch };
  }
  return sender;
}

/** Onboarding gate (§13.4): thin/unknown accounts locked at level 0 for 28 days; free accounts capped at level 1. */
export async function applyOnboardingGate(sender: Sender): Promise<void> {
  const conns = sender.connections_count;
  const patch: Record<string, unknown> = {};
  if (sender.provider === "LINKEDIN" && (conns == null || conns < 150) && !sender.warmup_locked_until) {
    const until = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
    patch.warmup_level = 0;
    patch.warmup_locked_until = until;
    await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "warmup", data: { reason: "thin_account", connections_count: conns, locked_until: until } });
  }
  if (sender.provider === "LINKEDIN" && !sender.is_premium && sender.warmup_level > 1) patch.warmup_level = 1;
  if (Object.keys(patch).length) await admin.from("outreach_senders").update(patch).eq("id", sender.id);
}

export async function handleAccountStatus(payload: any): Promise<void> {
  const st = payload.AccountStatus ?? payload;
  const accountId = st.account_id;
  const message = String(st.message ?? "").toUpperCase();
  let sender = await senderByAccount(accountId);
  if (!sender) { log({ fn: "account_status", warn: "unknown account", accountId, message }); return; }
  await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "unipile", data: { message, product: st.product ?? null } });

  switch (message) {
    case "CREATION_SUCCESS": {
      sender = await syncOwnProfile(sender);
      await applyOnboardingGate(sender);
      await admin.from("outreach_senders").update({ status: sender.status === "disabled" ? "disabled" : "connecting", connected_at: sender.connected_at ?? new Date().toISOString() }).eq("id", sender.id);
      break;
    }
    case "OK": {
      const wasCred = sender.status === "credentials" || sender.status === "error";
      await admin.from("outreach_senders").update({ status: sender.status === "paused" || sender.status === "disabled" ? sender.status : "ok", status_reason: null, last_ok_at: new Date().toISOString() }).eq("id", sender.id);
      if (!sender.provider_user_id || !sender.public_identifier) await syncOwnProfile(sender);
      if (wasCred) await healthForSender(sender.id, "reconnect");
      break;
    }
    case "RECONNECTED": {
      await admin.from("outreach_senders").update({ status: sender.status === "disabled" ? "disabled" : "ok", status_reason: null, last_ok_at: new Date().toISOString(), reconnect_attempts: 0 }).eq("id", sender.id);
      await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "reconnect", data: { result: "reconnected" } });
      break;
    }
    case "SYNC_SUCCESS": {
      await admin.from("outreach_senders").update({ last_synced_at: new Date().toISOString() }).eq("id", sender.id);
      if (!st.product || String(st.product).toLowerCase() === "classic") await backfillChats(sender, 3);
      break;
    }
    case "CREDENTIALS": {
      await admin.from("outreach_senders").update({ status: sender.status === "disabled" ? "disabled" : "credentials", status_reason: "CREDENTIALS", last_disconnect_at: new Date().toISOString(), reconnect_attempts: 0 }).eq("id", sender.id);
      await healthForSender(sender.id, "disconnect");
      if (sender.auth_method !== "cookie") {
        const link = await reconnectLink(sender).catch(() => null);
        await notifySender(sender.id, "reconnect_needed", { link });
        await admin.from("outreach_senders").update({ reconnect_notified_at: new Date().toISOString() }).eq("id", sender.id);
      }
      break;
    }
    case "ERROR":
    case "STOPPED": {
      const errs = (sender.consecutive_errors ?? 0) + 1;
      await admin.from("outreach_senders").update({ status: sender.status === "disabled" ? "disabled" : "error", status_reason: message, consecutive_errors: errs }).eq("id", sender.id);
      if (errs >= 2) await notifySender(sender.id, "sender_error", { reason: message });
      break;
    }
    case "CONNECTING": break;
    case "DELETED": {
      await admin.from("outreach_senders").update({ status: "disabled", status_reason: "DELETED", deleted_at: sender.deleted_at ?? null }).eq("id", sender.id);
      break;
    }
    case "PERMISSIONS": {
      await admin.from("outreach_senders").update({ status_reason: "PERMISSIONS" }).eq("id", sender.id);
      break;
    }
    case "CREATION_FAIL": {
      await admin.from("outreach_senders").update({ status: "error", status_reason: "CREATION_FAIL" }).eq("id", sender.id);
      break;
    }
    default:
      log({ fn: "account_status", warn: "unhandled", message });
  }
}

/** True when the sender's account id is still known to the configured DSN. */
async function accountExistsOnDsn(accountId: string): Promise<boolean> {
  try { await unipile.accounts.get(accountId); return true; }
  catch (e) {
    if (e instanceof UnipileError && (e.status === 404 || e.status === 401 || e.status === 403)) return false;
    throw e;
  }
}

/**
 * Hosted-auth link for an existing sender. Normally a `reconnect` link for its account; when the account is no
 * longer on the configured DSN (account deleted, or the platform moved to a new Unipile account) it falls back
 * to a `create` link bound to the same sender row via `name`, so the hosted-auth notify re-binds the new
 * account id and the sender keeps its chats, lead state and enrollments.
 */
export async function reconnectLink(sender: Sender): Promise<string | null> {
  const { FUNCTIONS_BASE, WEB_ORIGIN } = await import("./supabase.ts");
  const common = {
    expiresOn: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    notify_url: `${FUNCTIONS_BASE}outreach-sender-notify?sid=${sender.id}`,
    name: sender.id,
    success_redirect_url: `${WEB_ORIGIN}/outreach/senders/${sender.id}?connected=1`,
    failure_redirect_url: `${WEB_ORIGIN}/outreach/senders/${sender.id}?connected=0`,
    // Senders connected through the browser extension reconnect the same way (no password prompt).
    ...(sender.auth_method === "browser" ? hostedBrowserOptions() : {}),
  };
  const stillThere = sender.unipile_account_id ? await accountExistsOnDsn(sender.unipile_account_id) : false;
  if (stillThere) {
    const r = await unipile.hosted.link({ type: "reconnect", reconnect_account: sender.unipile_account_id, ...common });
    return r.url;
  }
  const providers = sender.provider === "LINKEDIN" ? ["LINKEDIN"] : sender.provider === "GMAIL" ? ["GOOGLE"] : sender.provider === "OUTLOOK" ? ["OUTLOOK"] : ["MAIL"];
  const { data: ws } = await admin.from("outreach_workspaces").select("settings").eq("id", sender.workspace_id).maybeSingle();
  const recruiter = !!(ws?.settings?.recruiter_enabled) && !!sender.has_recruiter;
  await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "reconnect", data: { method: "fresh_bind", reason: sender.unipile_account_id ? "account_not_on_dsn" : "no_account", previous_account_id: sender.unipile_account_id } });
  const r = await unipile.hosted.link({
    type: "create", providers, ...common,
    disabled_features: sender.provider === "LINKEDIN" && !recruiter ? ["linkedin_recruiter"] : undefined,
  });
  return r.url;
}

/** Hosted-auth notify_url payload: {status, account_id, name} */
export async function handleHostedNotify(payload: any): Promise<void> {
  const senderId = payload.name;
  const accountId = payload.account_id;
  if (!senderId || !accountId) return;
  const { data: s } = await admin.from("outreach_senders").select("*").eq("id", senderId).maybeSingle();
  if (!s) return;
  const status = String(payload.status ?? "").toUpperCase();
  const patch: Record<string, unknown> = { unipile_account_id: accountId };
  if (status === "RECONNECTED") { patch.status = "ok"; patch.status_reason = null; patch.reconnect_attempts = 0; }
  const { error } = await admin.from("outreach_senders").update(patch).eq("id", senderId);
  if (error) {
    // account_id already bound to another sender row (e.g. duplicate connect) → disable this row
    log({ fn: "hosted_notify", error: error.message });
    return;
  }
  await audit(s.workspace_id, "sender.hosted_auth", "sender", senderId, { status, account_id: accountId });
  if (status === "CREATION_SUCCESS") {
    const fresh = await syncOwnProfile({ ...s, unipile_account_id: accountId });
    await applyOnboardingGate(fresh);
    // if the webhook OK never arrives (platform webhook missing), poll account once
    try {
      const acc = await unipile.accounts.get(accountId);
      const st = String(acc?.sources?.[0]?.status ?? "").toUpperCase();
      if (st === "OK") await admin.from("outreach_senders").update({ status: "ok", status_reason: null, last_ok_at: new Date().toISOString() }).eq("id", senderId);
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------
async function matchLead(workspaceId: string, providerId: string | null, publicIdentifier: string | null, name: string | null, createIfMissing: boolean, profileUrl?: string | null): Promise<{ id: string; created: boolean } | null> {
  if (providerId) {
    const { data } = await admin.from("outreach_leads").select("id").eq("workspace_id", workspaceId).eq("provider_id", providerId).maybeSingle();
    if (data) return { id: data.id, created: false };
  }
  if (publicIdentifier) {
    const { data } = await admin.from("outreach_leads").select("id").eq("workspace_id", workspaceId).ilike("public_identifier", publicIdentifier).maybeSingle();
    if (data) {
      if (providerId) await admin.from("outreach_leads").update({ provider_id: providerId }).eq("id", data.id);
      return { id: data.id, created: false };
    }
  }
  if (!createIfMissing || (!providerId && !publicIdentifier)) return null;
  const parts = (name ?? "").trim().split(/\s+/);
  const row = await rpc<{ id: string; created: boolean }[]>("upsert_lead", {
    p_ws: workspaceId,
    p_lead: { public_identifier: publicIdentifier, provider_id: providerId, full_name: name, first_name: parts[0] ?? null, last_name: parts.slice(1).join(" ") || null, profile_url: profileUrl ?? null },
    p_source: "inbound",
  });
  const r = Array.isArray(row) ? row[0] : (row as any);
  return r ? { id: r.id, created: !!r.created } : null;
}

function pubIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

export async function handleMessaging(payload: any): Promise<void> {
  const sender = await senderByAccount(payload.account_id);
  if (!sender) { log({ fn: "messaging", warn: "unknown account", account: payload.account_id }); return; }
  const event = payload.event ?? "message_received";
  const unipileChatId = payload.chat_id;
  const unipileMessageId = payload.message_id;
  if (!unipileChatId) return;

  if (event === "message_edited" || event === "message_deleted") {
    if (unipileMessageId) await admin.from("outreach_messages").update(event === "message_deleted" ? { deleted_at: new Date().toISOString() } : { text: payload.message ?? undefined, edited_at: new Date().toISOString() }).eq("unipile_message_id", unipileMessageId);
    return;
  }
  if (event !== "message_received") return;

  const ownId = payload.account_info?.user_id ?? sender.provider_user_id;
  const isOut = !!ownId && payload.sender?.attendee_provider_id === ownId;
  const attendee = isOut ? (payload.attendees ?? []).find((a: any) => a.attendee_provider_id !== ownId) ?? payload.attendees?.[0] : payload.sender;
  const attendeeProviderId = attendee?.attendee_provider_id ?? null;
  const attendeePub = pubIdFromUrl(attendee?.attendee_profile_url);
  const { data: ws } = await admin.from("outreach_workspaces").select("settings").eq("id", sender.workspace_id).single();
  const createLeads = (ws?.settings?.create_leads_from_inbound ?? true) !== false;

  // chat upsert
  let { data: chat } = await admin.from("outreach_chats").select("*").eq("sender_id", sender.id).eq("unipile_chat_id", unipileChatId).maybeSingle();
  let lead = chat?.lead_id ? { id: chat.lead_id, created: false } : await matchLead(sender.workspace_id, attendeeProviderId, attendeePub, attendee?.attendee_name ?? null, createLeads, attendee?.attendee_profile_url);
  if (!chat) {
    const { data: c } = await admin.from("outreach_chats").upsert({
      workspace_id: sender.workspace_id, client_id: sender.client_id, sender_id: sender.id, lead_id: lead?.id ?? null, unipile_chat_id: unipileChatId,
      provider: sender.provider, attendee_provider_id: attendeeProviderId, attendee_public_identifier: attendeePub, attendee_name: attendee?.attendee_name ?? null,
      attendee_picture_url: attendee?.attendee_picture_url ?? null,
    }, { onConflict: "sender_id,unipile_chat_id" }).select("*").single();
    chat = c;
  } else if (!chat.lead_id && lead) {
    await admin.from("outreach_chats").update({ lead_id: lead.id }).eq("id", chat.id);
    chat.lead_id = lead.id;
  }
  if (!chat) return;
  if (chat.provider === "LINKEDIN" && chat.attendee_picture_url == null) {
    try { await fillChatPicture({ ...chat, lead_id: chat.lead_id ?? lead?.id ?? null }); } catch (e) { log({ fn: "messaging", avatar_warn: String(e) }); }
  }

  // first message in chat? (before insert)
  const { count: existing } = await admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("chat_id", chat.id);
  const sentAt = payload.timestamp ? new Date(payload.timestamp).toISOString() : new Date().toISOString();
  const attachments = (payload.attachments ?? []).map((a: any) => ({ id: a.id, type: a.type, mimetype: a.mimetype, name: a.file_name ?? a.name ?? null, size: a.file_size ?? null, unipile_message_id: unipileMessageId }));

  // dedupe by unipile message id (also catches our own sends already recorded by send-reply / tick)
  if (unipileMessageId) {
    const { data: dup } = await admin.from("outreach_messages").select("id").eq("unipile_message_id", unipileMessageId).maybeSingle();
    if (dup) { await admin.from("outreach_messages").update({ attachments }).eq("id", dup.id); return; }
  }
  const isInviteNote = isOut && (existing ?? 0) === 0;
  const { data: msg, error: mErr } = await admin.from("outreach_messages").insert({
    workspace_id: sender.workspace_id, chat_id: chat.id, unipile_message_id: unipileMessageId ?? null, direction: isOut ? "out" : "in",
    text: payload.message ?? null, attachments, sent_at: sentAt, is_invite_note: false,
  }).select("id").single();
  if (mErr) { if (!String(mErr.message).includes("duplicate")) log({ fn: "messaging", error: mErr.message }); return; }

  if (lead) {
    await admin.from("outreach_lead_sender_state").upsert({ lead_id: lead.id, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
    if (!isOut) {
      await admin.from("outreach_lead_sender_state").update({ replied: true, last_inbound_at: sentAt, unipile_chat_id: unipileChatId, updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
      await admin.from("outreach_ai_classify_queue").insert({ message_id: msg.id });
    } else {
      await admin.from("outreach_lead_sender_state").update({ last_outbound_at: sentAt, unipile_chat_id: unipileChatId, updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
      // acceptance via note path: our first message in a new chat while an invite is pending → accepted
      if (isInviteNote) {
        const { data: lss } = await admin.from("outreach_lead_sender_state").select("relation, invite_had_note").eq("lead_id", lead.id).eq("sender_id", sender.id).maybeSingle();
        if (lss?.relation === "pending_out") {
          await admin.from("outreach_messages").update({ is_invite_note: true }).eq("id", msg.id);
          await admin.from("outreach_lead_sender_state").update({ relation: "first", invite_accepted_at: sentAt, invite_detected_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
        }
      }
    }
  }
  await emitEvent(sender.workspace_id, isOut ? "message.sent" : "message.received", { id: msg.id, chat_id: chat.id, lead_id: lead?.id ?? null, sender_id: sender.id, text: (payload.message ?? "").slice(0, 500), direction: isOut ? "out" : "in" });
}

// ---------------------------------------------------------------------------
// users (new_relation)
// ---------------------------------------------------------------------------
export async function handleNewRelation(payload: any): Promise<void> {
  const sender = await senderByAccount(payload.account_id);
  if (!sender) return;
  const lead = await matchLead(sender.workspace_id, payload.user_provider_id ?? null, payload.user_public_identifier ?? null, payload.user_full_name ?? null, false, payload.user_profile_url);
  if (!lead) return;
  const now = new Date().toISOString();
  await admin.from("outreach_lead_sender_state").upsert({ lead_id: lead.id, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
  const { data: lss } = await admin.from("outreach_lead_sender_state").select("relation, invite_accepted_at").eq("lead_id", lead.id).eq("sender_id", sender.id).single();
  if (lss?.relation !== "first") {
    await admin.from("outreach_lead_sender_state").update({ relation: "first", invite_accepted_at: lss?.invite_accepted_at ?? now, invite_detected_at: now, updated_at: now }).eq("lead_id", lead.id).eq("sender_id", sender.id);
  }
  if (payload.user_picture_url) await admin.from("outreach_leads").update({ picture_url: payload.user_picture_url, provider_id: payload.user_provider_id ?? undefined }).eq("id", lead.id).is("picture_url", null);
}

// ---------------------------------------------------------------------------
// mail (new_email) + tracking
// ---------------------------------------------------------------------------
export async function handleMail(payload: any): Promise<void> {
  const sender = await senderByAccount(payload.account_id);
  if (!sender) return;
  const event = payload.event ?? "mail_received";
  if (event === "mail_moved") return;
  const isOut = event === "mail_sent";
  const from = payload.from_attendee?.identifier ? String(payload.from_attendee.identifier).toLowerCase() : null;
  const to = (payload.to_attendees ?? []).map((a: any) => String(a.identifier ?? "").toLowerCase()).filter(Boolean);
  const counterpart = isOut ? to[0] : from;
  const counterpartName = isOut ? payload.to_attendees?.[0]?.display_name : payload.from_attendee?.display_name;
  if (!counterpart) return;
  // lead by email
  let leadId: string | null = null;
  const { data: l } = await admin.from("outreach_leads").select("id").eq("workspace_id", sender.workspace_id).or(`email_work.eq.${counterpart},email_personal.eq.${counterpart}`).maybeSingle();
  if (l) leadId = l.id;
  else {
    const { data: ws } = await admin.from("outreach_workspaces").select("settings").eq("id", sender.workspace_id).single();
    if ((ws?.settings?.create_leads_from_inbound ?? true) !== false && !isOut) {
      const r = await rpc<any>("upsert_lead", { p_ws: sender.workspace_id, p_lead: { email_work: counterpart, full_name: counterpartName ?? null }, p_source: "inbound_email" });
      leadId = (Array.isArray(r) ? r[0] : r)?.id ?? null;
    }
  }
  const threadId = payload.thread_id ?? payload.in_reply_to?.id ?? payload.email_id;
  let { data: chat } = await admin.from("outreach_chats").select("*").eq("sender_id", sender.id).eq("unipile_chat_id", threadId).maybeSingle();
  if (!chat) {
    const { data: c } = await admin.from("outreach_chats").upsert({
      workspace_id: sender.workspace_id, client_id: sender.client_id, sender_id: sender.id, lead_id: leadId, unipile_chat_id: threadId, provider: sender.provider,
      attendee_provider_id: counterpart, attendee_name: counterpartName ?? counterpart, subject: payload.subject ?? null,
    }, { onConflict: "sender_id,unipile_chat_id" }).select("*").single();
    chat = c;
  }
  if (!chat) return;
  const { data: dup } = await admin.from("outreach_messages").select("id").eq("unipile_message_id", payload.email_id).maybeSingle();
  if (dup) return;
  const sentAt = payload.date ? new Date(payload.date).toISOString() : new Date().toISOString();
  const bounced = !isOut && /mailer-daemon|postmaster|delivery (status )?notification|undeliverable|delivery failure/i.test(`${from} ${payload.subject ?? ""}`);
  const { data: msg } = await admin.from("outreach_messages").insert({
    workspace_id: sender.workspace_id, chat_id: chat.id, unipile_message_id: payload.email_id, direction: isOut ? "out" : "in",
    text: payload.body_plain || (payload.body ? String(payload.body).replace(/<[^>]+>/g, " ").trim() : null), html: payload.body ?? null,
    attachments: (payload.attachments ?? []).map((a: any) => ({ id: a.id, name: a.name, size: a.size, type: a.mime ?? a.type, unipile_message_id: payload.email_id, email: true })),
    sent_at: sentAt,
  }).select("id").single();
  if (leadId) {
    await admin.from("outreach_lead_sender_state").upsert({ lead_id: leadId, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
    if (bounced) {
      await admin.from("outreach_lead_sender_state").update({ email_bounced: true, updated_at: new Date().toISOString() }).eq("lead_id", leadId).eq("sender_id", sender.id);
      await emitEvent(sender.workspace_id, "email.bounced", { lead_id: leadId, sender_id: sender.id });
    } else if (!isOut) {
      await admin.from("outreach_lead_sender_state").update({ replied: true, last_inbound_at: sentAt, updated_at: new Date().toISOString() }).eq("lead_id", leadId).eq("sender_id", sender.id);
      if (msg) await admin.from("outreach_ai_classify_queue").insert({ message_id: msg.id });
    } else {
      await admin.from("outreach_lead_sender_state").update({ last_outbound_at: sentAt, updated_at: new Date().toISOString() }).eq("lead_id", leadId).eq("sender_id", sender.id);
    }
  }
  await emitEvent(sender.workspace_id, isOut ? "email.sent" : "message.received", { id: msg?.id, chat_id: chat.id, lead_id: leadId, sender_id: sender.id, subject: payload.subject ?? null });
}

export async function handleMailTracking(payload: any): Promise<void> {
  const sender = await senderByAccount(payload.account_id);
  if (!sender) return;
  const isClick = payload.event === "mail_link_clicked";
  const { data: msg } = await admin.from("outreach_messages").select("id, opens, clicks, chat_id").eq("unipile_message_id", payload.email_id).maybeSingle();
  if (msg) {
    await admin.from("outreach_messages").update(isClick ? { clicks: (msg.clicks ?? 0) + 1 } : { opens: (msg.opens ?? 0) + 1 }).eq("id", msg.id);
    const { data: chat } = await admin.from("outreach_chats").select("lead_id").eq("id", msg.chat_id).maybeSingle();
    await emitEvent(sender.workspace_id, isClick ? "email.clicked" : "email.opened", { message_id: msg.id, lead_id: chat?.lead_id ?? null, url: payload.url ?? null, sender_id: sender.id });
  }
}

// ---------------------------------------------------------------------------
// Backfill chats/messages after SYNC_SUCCESS (paged, bounded)
// ---------------------------------------------------------------------------
export async function backfillChats(sender: Sender, maxPages = 3): Promise<number> {
  if (!sender.unipile_account_id || !unipileConfigured() || sender.provider !== "LINKEDIN") return 0;
  let cursor: string | undefined;
  let pages = 0, inserted = 0;
  const ownId = sender.provider_user_id;
  do {
    const res = await unipile.chats.list(sender.unipile_account_id, { cursor, limit: 50 });
    for (const c of res.items ?? []) {
      const attendeeId = c.attendee_provider_id ?? null;
      if (!attendeeId) continue;
      const lead = await matchLead(sender.workspace_id, attendeeId, null, c.name ?? null, false);
      const { data: chat } = await admin.from("outreach_chats").upsert({
        workspace_id: sender.workspace_id, client_id: sender.client_id, sender_id: sender.id, lead_id: lead?.id ?? null, unipile_chat_id: c.id, provider: sender.provider,
        attendee_provider_id: attendeeId, attendee_name: c.name ?? null, subject: c.subject ?? null, unread_count: c.unread_count ?? 0, unread: (c.unread_count ?? 0) > 0,
      }, { onConflict: "sender_id,unipile_chat_id" }).select("id, lead_id").single();
      if (!chat) continue;
      try {
        const ms = await unipile.chats.messages(c.id, { limit: 30 });
        for (const m of (ms.items ?? []).reverse()) {
          const isOut = m.is_sender === 1 || m.is_sender === true || (ownId && m.sender_id === ownId);
          const { error } = await admin.from("outreach_messages").insert({
            workspace_id: sender.workspace_id, chat_id: chat.id, unipile_message_id: m.id, direction: isOut ? "out" : "in", text: m.text ?? null,
            attachments: (m.attachments ?? []).map((a: any) => ({ id: a.id, type: a.type, mimetype: a.mimetype, name: a.file_name ?? null, unipile_message_id: m.id })),
            sent_at: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString(),
          });
          if (!error) inserted++;
        }
        if (chat.lead_id) {
          const last = ms.items?.[0];
          if (last) {
            const lastIn = (ms.items ?? []).find((m: any) => !(m.is_sender === 1 || m.is_sender === true || (ownId && m.sender_id === ownId)));
            await admin.from("outreach_lead_sender_state").upsert({ lead_id: chat.lead_id, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
            await admin.from("outreach_lead_sender_state").update({ unipile_chat_id: c.id, relation: "first", ...(lastIn ? { last_inbound_at: new Date(lastIn.timestamp).toISOString() } : {}) }).eq("lead_id", chat.lead_id).eq("sender_id", sender.id);
          }
        }
      } catch (e) { log({ fn: "backfill", warn: String(e) }); }
    }
    cursor = res.cursor ?? undefined;
    pages++;
  } while (cursor && pages < maxPages);
  try { await resolveChatNames(sender, 40); } catch (e) { log({ fn: "backfill", warn: `resolveChatNames: ${e}` }); }
  return inserted;
}

/**
 * LinkedIn 1:1 chats come back from /chats without a name. Fill attendee_name / public identifier / picture from
 * the chat's attendee list (a Unipile-side read, no LinkedIn action), newest chats first, bounded per call.
 */
export async function resolveChatNames(sender: Sender, max = 40): Promise<{ checked: number; named: number; linked: number }> {
  if (!sender.unipile_account_id || !unipileConfigured() || sender.provider !== "LINKEDIN") return { checked: 0, named: 0, linked: 0 };
  const { data: chats } = await admin.from("outreach_chats").select("id, unipile_chat_id, attendee_provider_id, lead_id").eq("sender_id", sender.id).is("attendee_name", null).not("unipile_chat_id", "is", null).order("last_message_at", { ascending: false, nullsFirst: false }).limit(max);
  let named = 0, linked = 0;
  for (const c of chats ?? []) {
    try {
      const res = await unipile.chats.attendees(c.unipile_chat_id);
      const items = res.items ?? [];
      const a = items.find((x: any) => x.provider_id === c.attendee_provider_id) ?? items.find((x: any) => !(x.is_self === 1 || x.is_self === true) && x.provider_id !== sender.provider_user_id);
      const name = a?.name ?? a?.display_name ?? null;
      if (!name) continue;
      const pub = pubIdFromUrl(a?.profile_url ?? a?.public_profile_url ?? null) ?? a?.public_identifier ?? null;
      const patch: Record<string, unknown> = { attendee_name: name };
      if (pub) patch.attendee_public_identifier = pub;
      if (a?.picture_url) patch.attendee_picture_url = a.picture_url;
      if (!c.lead_id) { const lead = await matchLead(sender.workspace_id, c.attendee_provider_id, pub, name, false, a?.profile_url ?? undefined); if (lead?.id) { patch.lead_id = lead.id; linked++; } }
      const { error } = await admin.from("outreach_chats").update(patch).eq("id", c.id);
      if (!error) named++;
    } catch (e) { log({ fn: "resolveChatNames", chat: c.id, warn: String(e) }); }
  }
  return { checked: chats?.length ?? 0, named, linked };
}

export const _internal = { matchLead, pubIdFromUrl, randInt };
