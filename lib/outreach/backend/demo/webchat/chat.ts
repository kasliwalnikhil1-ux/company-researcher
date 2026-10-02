/**
 * Website conversations as the database keeps them (049 / 051): the visitor, conversation and message projections the
 * widget reads, and the writes behind a visitor message, a handoff, auto-assignment and a bot line. Rows land in
 * outreach_chats / outreach_messages on the website's WEBCHAT sender, so they show in the inbox like any other thread.
 */
import type { Ctx } from '../ctx';
import type { DemoStore, Row } from '../store';
import { T, agentName, availability, onlineUserIds, settingsOf } from './core';

const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function visitorJson(v: Row): Row {
  return { id: v.id, identifier: v.identifier ?? null, identity_verified: !!v.identity_verified, name: v.name ?? null, email: v.email ?? null, phone: v.phone ?? null, avatar_url: v.avatar_url ?? null,
    custom_attributes: v.custom_attributes ?? {}, consent: v.consent ?? null, locale: v.locale ?? null, token_version: v.token_version ?? 1, first_seen_at: v.first_seen_at ?? v.created_at };
}

export function conversationJson(store: DemoStore, c: Row): Row {
  const unread = store.t('outreach_messages').filter((m) => m.chat_id === c.id && m.direction === 'out' && !m.read_by_visitor_at && (m.sender_type === 'agent' || m.sender_type === 'bot') && !m.deleted_at).length;
  return {
    id: c.id, status: c.status ?? 'open', created_at: c.created_at, last_message_at: c.last_message_at ?? null, last_message_preview: c.last_message_preview ?? null, last_direction: c.last_direction ?? null,
    stream_key: c.stream_key ?? null, resolved_at: c.resolved_at ?? null, csat: c.csat ?? null, ai_handled: !!c.ai_handled, handed_off_at: c.handed_off_at ?? null, source: c.source ?? null,
    labels: c.labels ?? [], custom_attributes: c.custom_attributes ?? {}, unread,
    assignee: c.assigned_to ? { name: agentName(store, c.workspace_id, c.assigned_to) } : null,
    agent_typing: !!c.agent_typing_at && Date.parse(c.agent_typing_at) > Date.now() - 8000,
  };
}

/** 049 outreach_webchat__message_json: what the widget may see of a message. */
export function messageJson(m: Row): Row {
  const attrs: Row = { ...(m.content_attributes ?? {}) };
  delete attrs.sender_avatar; delete attrs.internal;
  const staff = m.sender_type === 'agent' || m.sender_type === 'bot';
  return {
    id: m.id, conversation_id: m.chat_id, echo_id: m.echo_id ?? null, sender_type: m.sender_type ?? (m.direction === 'in' ? 'visitor' : 'agent'),
    sender_name: staff ? m.sender_name ?? null : null, sender_avatar: staff ? m.content_attributes?.sender_avatar ?? null : null, content_type: m.content_type ?? 'text',
    text: m.deleted_at ? null : m.text ?? null,
    attachments: m.deleted_at ? [] : (m.attachments ?? []).map((a: Row) => ({ id: a.id, name: a.name, type: a.type, size: a.size })),
    content_attributes: attrs, sent_at: m.sent_at, delivered_at: m.delivered_at ?? m.created_at, read_by_agent_at: m.read_by_agent_at ?? null, read_by_visitor_at: m.read_by_visitor_at ?? null,
    deleted: !!m.deleted_at, source: m.source ?? null, unsupported: !!m.unsupported,
  };
}

/** Inserts a message in the production shape and keeps the chat's preview / unread state as the rollup trigger does. */
export function addMessage(store: DemoStore, chat: Row, m: { direction: 'in' | 'out'; text?: string | null; content_type?: string; content_attributes?: Row; sender_type: 'visitor' | 'agent' | 'bot' | 'system'; sender_name?: string | null; source?: string; origin?: string; echo_id?: string | null; attachments?: Row[]; sent_by?: string | null; at?: number }): Row {
  const at = m.at ?? Date.now();
  const ctype = m.content_type ?? 'text';
  const row = store.insert('outreach_messages', {
    workspace_id: chat.workspace_id, chat_id: chat.id, unipile_message_id: null, direction: m.direction, text: m.text ?? null, html: null, attachments: m.attachments ?? [], sent_at: iso(at),
    is_invite_note: false, reactions: [], read_at: null, transcript: null, transcript_status: null, intent: null, intent_confidence: null, summary: null, classified_at: null, opens: 0, clicks: 0,
    edited_at: null, deleted_at: null, action_id: null, replied_to_action_id: null, is_first_reply: false, sent_by: m.sent_by ?? null,
    origin: m.origin ?? (m.direction === 'in' ? 'prospect' : m.sender_type === 'agent' ? 'inbox_user' : m.sender_type === 'system' ? 'inbox_user' : 'ai_autopilot'),
    ai_flags: [], classification: null, content_type: ctype, content_attributes: m.content_attributes ?? {}, sender_type: m.sender_type, sender_name: m.sender_name ?? null,
    sender_identifier: null, read_by_visitor_at: null, read_by_agent_at: null, delivered_at: iso(at), echo_id: m.echo_id ?? null, source: m.source ?? (m.direction === 'in' ? 'widget' : m.sender_type),
    unsupported: false, created_at: iso(at),
  })[0];
  if (ctype !== 'event' && ctype !== 'form_response' && (m.text || (m.attachments ?? []).length)) {
    const preview = String(m.text ?? (m.attachments?.[0]?.name ?? 'Attachment')).replace(/\s+/g, ' ').slice(0, 140);
    const isIn = m.direction === 'in';
    store.update('outreach_chats', chat.id, (c) => ({ last_message_at: iso(at), last_message_preview: preview, last_direction: m.direction, unread: isIn ? true : c.unread, unread_count: isIn ? (c.unread_count ?? 0) + 1 : c.unread_count, archived: isIn ? false : c.archived }));
  }
  if (m.direction === 'out' && m.sender_type === 'agent') {
    store.update('outreach_chats', chat.id, (c) => ({ first_response_at: c.first_response_at ?? iso(at) }));
  }
  return row;
}

export function botLine(store: DemoStore, chat: Row, text: string | null, ctype = 'text', attrs: Row = {}): Row {
  const inbox = store.get(T.inboxes, chat.webchat_inbox_id);
  const st = inbox ? settingsOf(inbox) : {};
  return addMessage(store, chat, { direction: 'out', text, content_type: ctype, content_attributes: attrs, sender_type: 'bot', sender_name: st.appearance?.brand_name ?? inbox?.name ?? 'Chat', source: 'bot' });
}

export function systemEvent(store: DemoStore, chat: Row, attrs: Row): Row {
  return addMessage(store, chat, { direction: 'out', text: null, content_type: 'event', content_attributes: attrs, sender_type: 'system', source: 'system', origin: 'inbox_user' });
}

/** 051 outreach_webchat__auto_assign: round-robin over online members with auto-assign and capacity. */
export function autoAssign(ctx: Ctx, chatId: string): string | null {
  const s = ctx.store, c = s.get('outreach_chats', chatId);
  if (!c?.webchat_inbox_id || c.assigned_to) return c?.assigned_to ?? null;
  const inbox = s.get(T.inboxes, c.webchat_inbox_id);
  if (!inbox) return null;
  const st = settingsOf(inbox);
  if (st.assignment?.auto === false) return null;
  const cap = Math.max(1, Number(st.assignment?.capacity ?? 10));
  const online = new Set(onlineUserIds(ctx, inbox));
  const pick = s.t(T.members).filter((m) => m.inbox_id === inbox.id && m.auto_assign !== false && online.has(m.user_id))
    .filter((m) => s.t('outreach_chats').filter((x) => x.webchat_inbox_id === inbox.id && x.assigned_to === m.user_id && (x.status === 'open' || x.status === 'pending')).length < cap)
    .sort((a, b) => String(a.last_assigned_at ?? '').localeCompare(String(b.last_assigned_at ?? '')))[0];
  if (!pick) return null;
  s.update('outreach_chats', c.id, { assigned_to: pick.user_id });
  s.update(T.members, (m) => m === pick, { last_assigned_at: iso() });
  systemEvent(s, c, { kind: 'assigned', agent: agentName(s, c.workspace_id, pick.user_id) });
  return pick.user_id;
}

/** 051 outreach_webchat_v_handoff: idempotent. */
export function handoff(ctx: Ctx, chatId: string, reason: string): Row {
  const s = ctx.store, c = s.get('outreach_chats', chatId);
  if (!c) return { already: true, assigned: false };
  if (c.handed_off_at) return { already: true, assigned: !!c.assigned_to };
  const inbox = s.get(T.inboxes, c.webchat_inbox_id)!;
  const st = settingsOf(inbox), av = availability(ctx, inbox);
  const v = s.get(T.visitors, c.visitor_id);
  s.update('outreach_chats', c.id, { handed_off_at: iso(), handoff_reason: reason.slice(0, 60), ai_handled: false, status: 'open', unread: true });
  const assigned = autoAssign(ctx, c.id);
  const msg = av.online ? st.messages?.handoff_message : st.messages?.handoff_offline_message;
  const form = !av.online && !v?.email;
  botLine(s, c, msg ?? null, form ? 'form' : 'text', form ? { handoff: true, form: 'email', prompt: msg } : { handoff: true });
  if (c.visitor_id) s.insert(T.events, { visitor_id: c.visitor_id, chat_id: c.id, name: 'handoff', props: { reason, online: av.online }, at: iso() });
  return { already: false, assigned: !!assigned, online: av.online };
}

/** A new website conversation (051 outreach_webchat_v_conversation_start, with 063's stored mode). */
export function startConversation(ctx: Ctx, inbox: Row, visitor: Row, form: Row | null, source: string, page: Row | null): Row {
  const s = ctx.store, st = settingsOf(inbox);
  if (st.features?.single_conversation) {
    const ex = s.t('outreach_chats').filter((c) => c.visitor_id === visitor.id && c.provider === 'WEBCHAT' && c.status !== 'resolved').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (ex) return { conversation: conversationJson(s, ex), existing: true };
  }
  let v = visitor;
  if (form) {
    const em = String(form.email ?? '').trim().toLowerCase();
    const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) ? em : null;
    v = s.update(T.visitors, v.id, (x) => ({ name: String(form.name ?? '').slice(0, 120) || x.name, email: ok ?? x.email, phone: String(form.phone ?? '').slice(0, 40) || x.phone, custom_attributes: { ...(x.custom_attributes ?? {}), ...(form.custom ?? {}) },
      consent: form.consent?.accepted ? { marketing: true, text_version: form.consent.text_version ?? st.pre_chat?.consent?.text_version, at: iso() } : x.consent }))[0];
    linkLead(s, v);
    v = s.get(T.visitors, v.id)!;
  }
  const av = availability(ctx, inbox);
  let mode = inbox.ai_enabled ? String(st.ai?.mode ?? 'off') : 'off';
  if (mode === 'offline_only') mode = av.online ? 'off' : 'first';
  const id = s.uid();
  const chat = s.insert('outreach_chats', {
    id, workspace_id: inbox.workspace_id, client_id: inbox.client_id ?? null, sender_id: inbox.sender_id, lead_id: v.lead_id ?? null, unipile_chat_id: `webchat:${id}`, provider: 'WEBCHAT',
    attendee_provider_id: v.id, attendee_public_identifier: null, attendee_name: v.name ?? 'Visitor', attendee_picture_url: v.avatar_url ?? null, subject: page?.title ? String(page.title).slice(0, 200) : null,
    last_message_at: null, last_message_preview: null, last_direction: null, unread: false, unread_count: 0, assigned_to: null, intent: 'unclassified', archived: false, is_request: false, last_note_at: null,
    labels: [], custom_attributes: {}, autopilot_state: 'active', conversation_stage: null, conversation_exchanges: 0, ai_replies_count: 0, ai_run_id: null, ai_run_status: null, ai_run_decision: null,
    reply_sequence_id: null, ai_handed_off_at: null, webchat_inbox_id: inbox.id, visitor_id: v.id, status: 'open', snoozed_until: null, priority: null, csat: null, ai_handled: mode === 'first',
    handed_off_at: null, handoff_reason: null, first_response_at: null, resolved_at: null, resolved_by: null, source: source || 'launcher', stream_key: s.uid().replace(/-/g, ''), visitor_last_seen_at: iso(),
    visitor_typing_at: null, visitor_typing_text: null, agent_typing_at: null, agent_typing_by: null, continuity_stopped: false, ai_mode: mode, voice_calls: 0,
  })[0];
  if (form) {
    addMessage(s, chat, { direction: 'in', text: null, content_type: 'form_response', content_attributes: { form: 'pre_chat', values: JSON.parse(JSON.stringify({ name: form.name, email: v.email, phone: form.phone, custom: form.custom })) }, sender_type: 'visitor', source: 'widget' });
  }
  if (page?.campaign_message) {
    botLine(s, chat, String(page.campaign_message).slice(0, 1000), 'text', { campaign_id: page.campaign_id ?? null });
    if (page.campaign_id) s.update(T.campaigns, (x) => x.id === page.campaign_id && x.inbox_id === inbox.id, (x) => ({ started: (x.started ?? 0) + 1 }));
  } else if (st.messages?.greeting_enabled !== false && String(st.messages?.greeting ?? '').trim()) {
    botLine(s, chat, String(st.messages.greeting), 'text', { greeting: true });
  }
  if (page) s.insert(T.events, { visitor_id: v.id, chat_id: chat.id, name: 'conversation_started', props: { url: page.url ?? null, source }, at: iso() });
  return { conversation: conversationJson(s, s.get('outreach_chats', chat.id)!), existing: false, visitor: visitorJson(v) };
}

/** 051 outreach_webchat__link_lead: a visitor whose email or phone matches a lead of the workspace is linked to it. */
export function linkLead(store: DemoStore, v: Row): string | null {
  if (v.lead_id) return v.lead_id;
  const email = String(v.email ?? '').toLowerCase();
  const lead = store.t('outreach_leads').find((l) => l.workspace_id === v.workspace_id && ((email && (String(l.email_work ?? '').toLowerCase() === email || String(l.email_personal ?? '').toLowerCase() === email)) || (v.phone && l.phone === v.phone)));
  if (!lead) return null;
  store.update(T.visitors, v.id, { lead_id: lead.id });
  store.update('outreach_chats', (c) => c.visitor_id === v.id && !c.lead_id, { lead_id: lead.id });
  return lead.id;
}

export function isBlocked(store: DemoStore, inbox: Row, v: Row): boolean {
  return !!v.blocked_at || store.t(T.blocks).some((b) => b.inbox_id === inbox.id && ((b.kind === 'visitor' && b.value === v.id) || (b.kind === 'ip_hash' && b.value === v.ip_hash) || (b.kind === 'country' && v.country && String(b.value).toUpperCase() === String(v.country).toUpperCase())));
}

/** CSAT prompt on resolve (051 __post_csat), once per conversation. */
export function postCsat(store: DemoStore, chatId: string): void {
  const c = store.get('outreach_chats', chatId);
  if (!c) return;
  const inbox = store.get(T.inboxes, c.webchat_inbox_id);
  if (!inbox) return;
  const st = settingsOf(inbox);
  if (st.csat?.enabled === false || c.csat) return;
  const msgs = store.t('outreach_messages').filter((m) => m.chat_id === c.id);
  if (msgs.some((m) => m.content_type === 'csat') || !msgs.some((m) => m.direction === 'in' && m.sender_type === 'visitor')) return;
  botLine(store, c, st.messages?.end_message ?? null, 'csat', { scale: st.csat?.scale ?? 'emoji', ask_comment: st.csat?.ask_comment !== false });
}
