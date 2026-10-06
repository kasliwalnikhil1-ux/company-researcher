/**
 * Demo handlers: Inbox: Replies / Sent (075), intents, AI stop/resume, private notes, mentions, notifications, website-chat agent actions and visitors.
 * Owns: chat_ai_resume, chat_ai_stop, hub_webchat_send_products, inbox_counts, inbox_sent_list, mentions_list, mentions_mark_all_read, note_create, note_delete, note_mark_read, note_revisions, note_update, notes_badge, notes_for_lead, notes_list, notes_search, notification_prefs_get, notification_prefs_set, notifications_list, notifications_mark_read, set_intent, thread_attribution, webchat_agent_ai, webchat_agent_read, webchat_agent_send, webchat_agent_typing, webchat_ai_turns_list, webchat_canned_list, webchat_presence, webchat_visitor, webchat_visitor_export, webchat_visitor_link_lead, webchat_visitor_update
 */
import { demoError, inWs, type Ctx, type RpcArea, type RpcHandler } from '../ctx';
import { registerInboxViews } from '../inbox/direction';
import { inboxCounts, inboxSentList, stepNumbers } from '../inbox/sent';
import {
  MENTIONS, NOTES, NOTIFICATIONS, PREFS, REVISIONS, authorLabel, canReadNote, catalogueProducts, insertNote, memberOf, noteJson, notePlain, notifyMentions,
  parseMentions, productCard, productItem, userLabel,
} from '../inbox/shared';
import { agentSend, webchatChat } from '../inbox/webchat';
import { tableHooks } from '../query';
import { faceFor } from '../seed/faces';
import type { DemoStore, Row } from '../store';
import { aiRpc } from './ai';

const INTENTS = ['interested', 'question', 'not_now', 'not_interested', 'ooo', 'wrong_person', 'unclear', 'unclassified'];
const ACTIVE_RUNS = ['debouncing', 'drafting', 'draft_ready', 'scheduled'];

function chatOr404(ctx: Ctx, id: unknown): Row {
  const c = ctx.store.get('outreach_chats', id as string);
  if (!c || c.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
  return c;
}
function noteOr404(ctx: Ctx, id: unknown, live = true): Row {
  const n = ctx.store.get(NOTES, id as string);
  if (!n || n.workspace_id !== ctx.ws || n.purged_at || (live && n.deleted_at)) demoError('E_NOT_FOUND');
  const chat = ctx.store.get('outreach_chats', n.chat_id);
  if (!chat || !canReadNote(ctx.store, ctx.userId, chat, n.visibility)) demoError('E_NOT_FOUND');
  return n;
}
const role = (ctx: Ctx) => String(memberOf(ctx.store, ctx.ws, ctx.userId)?.role ?? 'member');
const visibleNote = (ctx: Ctx, n: Row) => { const c = ctx.store.get('outreach_chats', n.chat_id); return !!c && canReadNote(ctx.store, ctx.userId, c, n.visibility); };

// ------------------------------------------------------------------------------------------------ AI state
/** The chat's AI state: the AI area's builder when it is there, else a plain one from the chat row. */
function chatAiState(ctx: Ctx, chatId: string): unknown {
  const h = (aiRpc as Record<string, RpcHandler | undefined>).ai_reply_chat_state;
  if (h) return h({ p_chat: chatId }, ctx);
  const c = ctx.store.get('outreach_chats', chatId)!;
  const seq = c.reply_sequence_id ? ctx.store.get('outreach_sequences', c.reply_sequence_id) : undefined;
  const handed = c.ai_handed_off_at ? { at: c.ai_handed_off_at, reason: c.ai_handoff_reason ?? 'manual', rule: c.ai_handoff_rule ?? null, run_id: c.ai_handoff_run_id ?? null } : null;
  const mode = handed || !seq ? 'off' : 'draft';
  return {
    chat_id: c.id, mode, requested_mode: seq ? 'draft' : 'off', reason_code: handed ? 'handed_off' : seq ? null : 'no_sequence',
    reason: handed ? 'A teammate stopped the AI in this conversation.' : seq ? 'The AI drafts replies for you to review.' : 'This conversation is not part of a sequence.',
    source: seq ? 'sequence' : 'none', source_label: seq?.name ?? null, can_autopilot: false, sequence_id: seq?.id ?? null, sequence_name: seq?.name ?? null,
    sequence_status: seq?.status ?? null, handed_off: handed, session: { kind: 'normal', started_at: c.created_at ?? null, count: 1 },
    autopilot_state: c.autopilot_state ?? 'active', paused_reason: c.autopilot_paused_reason ?? null, warmup_remaining: null, fallback: seq ? null : 'workspace_default',
    master_prompt: null, stage: null, stages: [], exchanges: c.conversation_exchanges ?? 0, ai_replies_count: c.ai_replies_count ?? 0, max_ai_replies: 6,
    lead_notes_summary: null, run: null, last_run: null,
  };
}

// ------------------------------------------------------------------------------------------------ thread attribution
const initcap = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ------------------------------------------------------------------------------------------------ web chat visitor
function inboxOf(store: DemoStore, id: string | null | undefined): Row | undefined { return store.get('outreach_webchat_inboxes', id); }
function visitorOr404(ctx: Ctx, id: unknown): Row {
  const v = ctx.store.get('outreach_webchat_visitors', id as string);
  if (!v || v.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
  return v;
}
function visitorJson(ctx: Ctx, v: Row): Row {
  const s = ctx.store;
  const i = inboxOf(s, v.inbox_id);
  const { ip_hash: _ip, ...rest } = v;   // eslint-disable-line @typescript-eslint/no-unused-vars
  const lead = v.lead_id ? s.get('outreach_leads', v.lead_id) : undefined;
  const sender = (id: string) => s.get('outreach_senders', id);
  const chats = s.t('outreach_chats').filter((c) => c.visitor_id === v.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return {
    ...rest,
    inbox: { id: v.inbox_id, name: i?.name ?? 'Website' },
    blocked: !!v.blocked_at || s.t('outreach_webchat_blocks').some((b) => b.inbox_id === v.inbox_id && b.kind === 'visitor' && b.value === v.id),
    pages: s.t('outreach_webchat_page_views').filter((p) => p.visitor_id === v.id).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20).map((p) => ({ url: p.url, title: p.title ?? null, at: p.at })),
    events: s.t('outreach_webchat_events').filter((e) => e.visitor_id === v.id).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30).map((e) => ({ name: e.name, props: e.props ?? {}, at: e.at, chat_id: e.chat_id ?? null })),
    conversations: chats.map((c) => ({ id: c.id, status: c.status ?? 'open', created_at: c.created_at, last_message_at: c.last_message_at, preview: c.last_message_preview, csat: c.csat ?? null })),
    conversation_count: chats.length,
    lead: lead ? {
      id: lead.id, full_name: lead.full_name, company: lead.company, title: lead.title, email_work: lead.email_work, last_replied_at: lead.last_replied_at,
      last_replied_channel: lead.last_replied_channel, picture_url: lead.picture_url,
      enrollments: s.t('outreach_enrollments').filter((e) => e.lead_id === lead.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 10)
        .map((e) => ({ id: e.id, status: e.status, sequence: s.get('outreach_sequences', e.sequence_id)?.name ?? 'Sequence', sender: sender(e.sender_id)?.display_name ?? null, provider: sender(e.sender_id)?.provider ?? 'LINKEDIN' })),
      relations: s.t('outreach_lead_sender_state').filter((r) => r.lead_id === lead.id && sender(r.sender_id) && sender(r.sender_id)!.provider !== 'WEBCHAT')
        .map((r) => ({ sender: sender(r.sender_id)?.display_name ?? null, provider: sender(r.sender_id)?.provider, relation: r.relation, last_inbound_at: r.last_inbound_at, last_outbound_at: r.last_outbound_at })),
    } : null,
    lead_candidates: !v.lead_id && v.email
      ? s.t('outreach_leads').filter((l) => l.workspace_id === v.workspace_id && (String(l.email_work ?? '').toLowerCase() === String(v.email).toLowerCase() || String(l.email_personal ?? '').toLowerCase() === String(v.email).toLowerCase()))
        .slice(0, 5).map((l) => ({ id: l.id, full_name: l.full_name, company: l.company, email_work: l.email_work }))
      : [],
  };
}

/** A new lead from a visitor's details (outreach_upsert_lead, source webchat): every lead column, the unknown ones null. */
function leadFromVisitor(ctx: Ctx, v: Row): Row {
  const s = ctx.store;
  const email = v.email ? String(v.email).toLowerCase() : null;
  const existing = email ? s.t('outreach_leads').find((l) => l.workspace_id === ctx.ws && String(l.email_work ?? '').toLowerCase() === email) : undefined;
  if (existing) return existing;
  const i = inboxOf(s, v.inbox_id);
  const template = s.t('outreach_leads')[0] ?? {};
  const blank: Row = Object.fromEntries(Object.keys(template).filter((k) => k !== 'id').map((k) => [k, null]));
  const name = String(v.name ?? '').trim() || (email ? email.split('@')[0] : 'Website visitor');
  const [first, ...rest] = name.split(/\s+/);
  const newStage = s.t('outreach_stages').find((x) => x.workspace_id === ctx.ws && x.kind === 'new');
  const now = ctx.now();
  const lead = s.insert('outreach_leads', {
    ...blank, workspace_id: ctx.ws, client_id: i?.client_id ?? null, first_name: first, last_name: rest.join(' ') || null, full_name: name, company: v.company ?? null,
    email_work: email, phone: v.phone ?? null, custom: {}, stage_id: newStage?.id ?? null, do_not_contact: false, unsubscribed: false, is_open_profile: false,
    picture_url: v.avatar_url ?? (v.name ? faceFor(first, name) : null), source: 'webchat', enrich_status: 'none', email_status: email ? 'unverified' : null, headline: v.company ? `at ${v.company}` : null, created_at: now, updated_at: now,
  })[0];
  if (email) s.insert('outreach_lead_identities', { workspace_id: ctx.ws, lead_id: lead.id, provider: 'GMAIL', identifier: email, provider_id: null, verified: false, source: 'webchat', is_valid: null, last_checked_at: null, created_at: now });
  return lead;
}

function prefsOf(ctx: Ctx): Row {
  const out: Row = {};
  for (const p of ctx.store.t(PREFS)) if (p.workspace_id === ctx.ws && p.user_id === ctx.userId) out[p.kind] = { push: p.push, email: p.email, email_delay_min: p.email_delay_min };
  return out;
}

// ------------------------------------------------------------------------------------------------ handlers
export const inboxRpc = {
  chat_ai_resume: (a, ctx) => {
    const c = chatOr404(ctx, a.p_chat);
    const s = ctx.store;
    s.update('outreach_chats', c.id, { ai_handed_off_at: null, ai_handoff_reason: null, ai_handoff_rule: null, ai_handoff_run_id: null, autopilot_state: 'active', autopilot_paused_until: null, autopilot_paused_reason: null, stage_stale: true });
    s.update('outreach_tasks', (t) => t.chat_id === c.id && t.kind === 'ai_handoff' && !t.completed_at, (t) => ({ completed_at: ctx.now(), result: { ...(t.result ?? {}), completed_reason: 'ai_resumed', at: ctx.now() } }));
    return chatAiState(ctx, c.id);
  },

  chat_ai_stop: (a, ctx) => {
    const c = chatOr404(ctx, a.p_chat);
    const s = ctx.store;
    if (!c.ai_handed_off_at) {
      s.update('outreach_chats', c.id, (x) => ({ ai_handed_off_at: ctx.now(), ai_handoff_reason: 'manual', ai_handoff_rule: null, ai_run_status: ['escalated', 'no_reply', 'failed', 'expired'].includes(x.ai_run_status) ? null : x.ai_run_status }));
      s.update('outreach_ai_reply_runs', (r) => r.chat_id === c.id && ACTIVE_RUNS.includes(r.status), { status: 'cancelled', cancel_reason: 'handed_off' });
    }
    return chatAiState(ctx, c.id);
  },

  hub_webchat_send_products: (a, ctx) => {
    const c = webchatChat(ctx, a.p_chat);
    const ids: string[] = (Array.isArray(a.p_product_ids) ? a.p_product_ids : []).map(String);
    if (ids.length < 1 || ids.length > 6) demoError('E_PAYLOAD_INVALID', 'pick 1 to 6 products');
    const text = typeof a.p_text === 'string' ? a.p_text : '';
    if (a.p_suggestion) {
      const g = ctx.store.get('outreach_webchat_ai_suggestions', a.p_suggestion);
      if (!g || g.chat_id !== c.id) demoError('E_NOT_FOUND', 'suggestion');
      if (!text.trim()) demoError('E_PAYLOAD_INVALID', 'text');
      const snap: Row[] = Array.isArray(g.products) ? g.products : [];
      const cards = ids.map((id) => snap.find((x) => String(x?.id).toLowerCase() === id.toLowerCase())).filter(Boolean) as Row[];
      if (!cards.length) demoError('E_PAYLOAD_INVALID', 'those products are not part of the suggestion');
      return agentSend(ctx, c, { text, contentType: 'text', attrs: { products: cards, internal: { suggestion_id: g.id } } });
    }
    const all = catalogueProducts(ctx.store, ctx.ws);
    let picked = ids.map((id) => all.find((p) => String(p.row.id).toLowerCase() === id.toLowerCase())).filter(Boolean) as Array<{ row: Row; provider: string | null }>;
    // ids from a catalogue the demo no longer has: show the first products instead of failing the demo
    if (!picked.length) picked = all.slice(0, Math.min(ids.length, 3));
    if (!picked.length) demoError('E_NOT_FOUND', 'products');
    return agentSend(ctx, c, { text, contentType: 'cards', attrs: { items: picked.map((p) => productItem(p.row)), products: picked.map((p) => productCard(p.row, p.provider)) } });
  },

  // ---------------------------------------------------------------------------------------------- Replies / Sent (075)
  inbox_sent_list: (a, ctx) => inboxSentList(a, ctx),
  inbox_counts: (a, ctx) => inboxCounts(a, ctx),

  // ---------------------------------------------------------------------------------------------- mentions / notifications
  mentions_list: (a, ctx) => {
    const s = ctx.store;
    const unreadOnly = !!a.p_unread_only;
    const limit = Math.max(1, Math.min(Number(a.p_limit ?? 100), 500));
    const rows = s.t(MENTIONS).filter((m) => m.workspace_id === ctx.ws && m.user_id === ctx.userId && (!unreadOnly || !m.read_at));
    const best = new Map<string, Row>();
    for (const m of rows) {
      const n = s.get(NOTES, m.note_id);
      if (!n || n.deleted_at || !visibleNote(ctx, n)) continue;
      const cur = best.get(m.chat_id);
      const better = !cur || (!m.read_at && cur.read_at) || ((!m.read_at) === (!cur.read_at) && String(m.created_at) > String(cur.created_at));
      if (better) best.set(m.chat_id, m);
    }
    const out = [...best.values()].map((m) => {
      const n = s.get(NOTES, m.note_id)!;
      const c = s.get('outreach_chats', m.chat_id)!;
      const l = c.lead_id ? s.get('outreach_leads', c.lead_id) : undefined;
      return {
        chat_id: m.chat_id, note_id: m.note_id, created_at: m.created_at, read_at: m.read_at ?? null,
        unread_count: s.t(MENTIONS).filter((x) => x.chat_id === m.chat_id && x.user_id === ctx.userId && !x.read_at && !s.get(NOTES, x.note_id)?.deleted_at).length,
        author: authorLabel(s, n.workspace_id, n.author_id, n.author_type), snippet: notePlain(n.body).replace(/\s+/g, ' ').slice(0, 160),
        chat: { id: c.id, provider: c.provider, attendee_name: c.attendee_name, picture_url: c.attendee_picture_url, subject: c.subject, lead_name: l?.full_name ?? null, company: l?.company ?? null, lead_picture_url: l?.picture_url ?? null, last_message_at: c.last_message_at, sender_name: s.get('outreach_senders', c.sender_id)?.display_name ?? null },
      };
    });
    out.sort((x, y) => Number(!y.read_at) - Number(!x.read_at) || String(y.created_at).localeCompare(String(x.created_at)));
    return out.slice(0, limit);
  },

  mentions_mark_all_read: (_a, ctx) => {
    const now = ctx.now();
    const m = ctx.store.update(MENTIONS, (x) => x.workspace_id === ctx.ws && x.user_id === ctx.userId && !x.read_at, { read_at: now });
    const n = ctx.store.update(NOTIFICATIONS, (x) => x.workspace_id === ctx.ws && x.user_id === ctx.userId && !x.read_at, { read_at: now });
    return { mentions: m.length, notifications: n.length };
  },

  notifications_list: (a, ctx) => {
    const s = ctx.store;
    const limit = Math.max(1, Math.min(Number(a.p_limit ?? 30), 200));
    return s.t(NOTIFICATIONS).filter((x) => x.workspace_id === ctx.ws && x.user_id === ctx.userId)
      .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, limit)
      .map((x) => {
        const n = x.note_id ? s.get(NOTES, x.note_id) : undefined;
        return { id: x.id, kind: x.kind, chat_id: x.chat_id ?? null, note_id: x.note_id ?? null, title: x.title, body: x.body ?? null, read_at: x.read_at ?? null, created_at: x.created_at, access: x.note_id ? !!n && !n.deleted_at && visibleNote(ctx, n) : true };
      });
  },

  notifications_mark_read: (a, ctx) => {
    const ids = new Set((Array.isArray(a.p_ids) ? a.p_ids : []).map(String));
    const now = ctx.now();
    const rows = ctx.store.update(NOTIFICATIONS, (x) => ids.has(x.id) && x.user_id === ctx.userId && !x.read_at, { read_at: now });
    const notes = new Set(ctx.store.t(NOTIFICATIONS).filter((x) => ids.has(x.id) && x.note_id).map((x) => x.note_id));
    ctx.store.update(MENTIONS, (m) => notes.has(m.note_id) && m.user_id === ctx.userId && !m.read_at, { read_at: now });
    return rows.length;
  },

  notes_badge: (_a, ctx) => {
    const s = ctx.store;
    return {
      unread_mentions: s.t(MENTIONS).filter((m) => m.workspace_id === ctx.ws && m.user_id === ctx.userId && !m.read_at && s.get(NOTES, m.note_id) && !s.get(NOTES, m.note_id)!.deleted_at).length,
      unread_notifications: s.t(NOTIFICATIONS).filter((x) => x.workspace_id === ctx.ws && x.user_id === ctx.userId && !x.read_at).length,
    };
  },

  notification_prefs_get: (_a, ctx) => prefsOf(ctx),

  notification_prefs_set: (a, ctx) => {
    if (!['note_mention', 'ai_handoff', 'assigned'].includes(a.p_kind)) demoError('E_PAYLOAD_INVALID', 'kind');
    const delay = Number(a.p_email_delay_min ?? 10);
    if (![10, 30, 60].includes(delay)) demoError('E_PAYLOAD_INVALID', 'email_delay_min');
    ctx.store.upsert(PREFS, { user_id: ctx.userId, workspace_id: ctx.ws, kind: a.p_kind, push: a.p_push ?? true, email: a.p_email ?? true, email_delay_min: delay, updated_at: ctx.now() }, ['user_id', 'workspace_id', 'kind']);
    return prefsOf(ctx);
  },

  // ---------------------------------------------------------------------------------------------- notes
  note_create: (a, ctx) => {
    const c = chatOr404(ctx, a.p_chat);
    const authorType = String(a.p_author_type ?? 'user');
    if (!['user', 'agent'].includes(authorType)) demoError('E_PAYLOAD_INVALID', 'author_type');
    let vis = String(a.p_visibility || 'team');
    if (!['team', 'team_and_client'].includes(vis)) demoError('E_PAYLOAD_INVALID', 'visibility');
    if (role(ctx) === 'client_viewer') vis = 'team_and_client';
    const att: Row[] = Array.isArray(a.p_attachments) ? a.p_attachments : [];
    if (att.length > 10) demoError('E_PAYLOAD_INVALID', 'up to 10 attachments per note');
    const prefix = `${c.workspace_id}/${c.id}/`;
    const clean = att.map((x) => {
      const p = String(x?.path ?? '');
      if (!p.startsWith(prefix) || p.includes('..')) demoError('E_PAYLOAD_INVALID', 'attachment path does not belong to this conversation');
      if (Number(x.size ?? 0) > 26_214_400) demoError('E_PAYLOAD_INVALID', 'attachment larger than 25 MB');
      const o: Row = { path: p, name: String(x.name ?? p.split('/')[3] ?? 'file').slice(0, 200) };
      for (const k of ['size', 'mime', 'width', 'height']) if (x[k] != null) o[k] = x[k];
      return o;
    });
    let body = String(a.p_body ?? '').trim();
    if (!body && clean.length) body = clean.map((x) => x.name).join(', ');
    if (!body) demoError('E_PAYLOAD_INVALID', 'the note is empty');
    if (body.length > 10_000) demoError('E_NOTE_BODY_TOO_LONG');
    const { note, dropped } = insertNote(ctx.store, c, { author_id: ctx.userId, author_type: authorType, body, visibility: vis, attachments: clean });
    return { ...noteJson(ctx.store, note), dropped_mentions: dropped };
  },

  note_update: (a, ctx) => {
    const s = ctx.store;
    const n = noteOr404(ctx, a.p_note);
    const c = s.get('outreach_chats', n.chat_id)!;
    const r = role(ctx);
    const isAuthor = n.author_id === ctx.userId && ['user', 'agent'].includes(n.author_type);
    const vis = String(a.p_visibility || n.visibility);
    if (!['team', 'team_and_client'].includes(vis)) demoError('E_PAYLOAD_INVALID', 'visibility');
    let changedVis = false, changedBody = false;
    if (vis !== n.visibility) {
      if (!(isAuthor || r === 'owner' || r === 'manager')) demoError('E_FORBIDDEN', 'only the author or a manager can change who sees a note');
      if (r === 'client_viewer' && vis === 'team') demoError('E_FORBIDDEN', 'a client viewer cannot hide a note from the client');
      changedVis = true;
    }
    let body = n.body as string;
    if (a.p_body != null) {
      if (!isAuthor) demoError('E_FORBIDDEN', 'only the author can edit a note');
      body = String(a.p_body).trim();
      if (!body) demoError('E_PAYLOAD_INVALID', 'the note is empty');
      if (body.length > 10_000) demoError('E_NOTE_BODY_TOO_LONG');
      changedBody = body !== n.body;
    }
    if (!changedBody && !changedVis) return { ...noteJson(s, n), dropped_mentions: [] };
    if (changedBody) {
      const rev = s.t(REVISIONS).filter((x) => x.note_id === n.id).reduce((m, x) => Math.max(m, x.revision), 0) + 1;
      s.insert(REVISIONS, { note_id: n.id, revision: rev, body: n.body, edited_by: ctx.userId, edited_at: ctx.now() }, { noId: true });
    }
    const { kept, dropped } = parseMentions(s, c, vis, body, n.author_id);
    const before: string[] = n.mentions ?? [];
    const added = kept.filter((u) => !before.includes(u));
    const removed = before.filter((u) => !kept.includes(u));
    const updated = s.update(NOTES, n.id, { body, visibility: vis, mentions: kept, edited_at: changedBody ? ctx.now() : n.edited_at })[0];
    if (removed.length) s.remove(MENTIONS, (m) => m.note_id === n.id && removed.includes(m.user_id));
    notifyMentions(s, updated, added);
    return { ...noteJson(s, updated), dropped_mentions: dropped };
  },

  note_delete: (a, ctx) => {
    const s = ctx.store;
    const n = noteOr404(ctx, a.p_note);
    const r = role(ctx);
    if (!(n.author_id === ctx.userId || r === 'owner' || r === 'manager')) demoError('E_FORBIDDEN', 'only the author or a manager can delete a note');
    const now = ctx.now();
    const updated = s.update(NOTES, n.id, { deleted_at: now, deleted_by: ctx.userId })[0];
    s.remove(MENTIONS, (m) => m.note_id === n.id);
    s.update(NOTIFICATIONS, (x) => x.note_id === n.id && !x.read_at, { read_at: now });
    return noteJson(s, updated);
  },

  note_mark_read: (a, ctx) => {
    const now = ctx.now();
    const m = ctx.store.update(MENTIONS, (x) => x.note_id === a.p_note && x.user_id === ctx.userId && !x.read_at, { read_at: now });
    const n = ctx.store.update(NOTIFICATIONS, (x) => x.note_id === a.p_note && x.user_id === ctx.userId && !x.read_at, { read_at: now });
    return { mentions: m.length, notifications: n.length };
  },

  note_revisions: (a, ctx) => {
    const n = noteOr404(ctx, a.p_note, false);
    const r = role(ctx);
    if (!(n.author_id === ctx.userId || r === 'owner' || r === 'manager')) demoError('E_FORBIDDEN');
    return ctx.store.t(REVISIONS).filter((x) => x.note_id === n.id).sort((x, y) => x.revision - y.revision)
      .map((x) => ({ revision: x.revision, body: x.body, edited_at: x.edited_at, edited_by: userLabel(ctx.store, n.workspace_id, x.edited_by) ?? 'former member' }));
  },

  notes_list: (a, ctx) => {
    const c = chatOr404(ctx, a.p_chat);
    return ctx.store.t(NOTES).filter((n) => n.chat_id === c.id && !n.purged_at && canReadNote(ctx.store, ctx.userId, c, n.visibility))
      .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at))).map((n) => noteJson(ctx.store, n));
  },

  notes_for_lead: (a, ctx) => {
    const s = ctx.store;
    const l = s.get('outreach_leads', a.p_lead);
    if (!l || l.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
    const limit = Math.max(1, Math.min(Number(a.p_limit ?? 50), 200));
    return s.t(NOTES).filter((n) => n.lead_id === l.id && !n.deleted_at && visibleNote(ctx, n))
      .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, limit)
      .map((n) => {
        const c = s.get('outreach_chats', n.chat_id)!;
        return { ...noteJson(s, n), chat: { id: c.id, provider: c.provider, attendee_name: c.attendee_name, sender_name: s.get('outreach_senders', c.sender_id)?.display_name ?? null } };
      });
  },

  notes_search: (a, ctx) => {
    const s = ctx.store;
    const q = String(a.p_q ?? '').trim();
    if (q.length < 2) return [];
    const limit = Math.max(1, Math.min(Number(a.p_limit ?? 20), 50));
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: Array<{ n: Row; score: number }> = [];
    for (const n of s.t(NOTES)) {
      if (n.workspace_id !== ctx.ws || n.deleted_at || !visibleNote(ctx, n)) continue;
      const text = notePlain(n.body).toLowerCase();
      const score = text.includes(q.toLowerCase()) ? 10 : words.filter((w) => text.includes(w)).length;
      if (score > 0 && (score === 10 || score === words.length)) hits.push({ n, score });
    }
    hits.sort((x, y) => y.score - x.score || String(y.n.created_at).localeCompare(String(x.n.created_at)));
    return hits.slice(0, limit).map(({ n }) => {
      const c = s.get('outreach_chats', n.chat_id)!;
      const l = c.lead_id ? s.get('outreach_leads', c.lead_id) : undefined;
      const plain = notePlain(n.body).replace(/\s+/g, ' ');
      const at = Math.max(0, plain.toLowerCase().indexOf(words[0]));
      const from = Math.max(0, at - 60);
      let snippet = (from > 0 ? '…' : '') + plain.slice(from, from + 200);
      for (const w of words) snippet = snippet.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '**$1**');
      return {
        note_id: n.id, chat_id: n.chat_id, created_at: n.created_at, author: authorLabel(s, n.workspace_id, n.author_id, n.author_type), snippet: snippet.slice(0, 240),
        chat: { id: c.id, provider: c.provider, attendee_name: c.attendee_name, picture_url: c.attendee_picture_url, lead_name: l?.full_name ?? null, company: l?.company ?? null },
      };
    });
  },

  // ---------------------------------------------------------------------------------------------- intent / attribution
  set_intent: (a, ctx) => {
    const s = ctx.store;
    const c = chatOr404(ctx, a.p_chat);
    const intent = String(a.p_intent ?? '');
    if (!INTENTS.includes(intent)) demoError('E_PAYLOAD_INVALID', 'intent');
    const last = s.t('outreach_messages').filter((m) => m.chat_id === c.id && m.direction === 'in').sort((x, y) => String(y.sent_at).localeCompare(String(x.sent_at)))[0];
    s.update('outreach_chats', c.id, { intent });
    if (last) s.update('outreach_messages', last.id, (m) => ({ intent, classified_at: ctx.now(), classification: { ...(m.classification ?? {}), intent } }));
    // outreach_apply_reply_intent: an interested reply moves the lead forward (never back)
    if (c.lead_id && intent === 'interested') {
      const lead = s.get('outreach_leads', c.lead_id);
      const order = ['new', 'contacted', 'connected', 'replied', 'interested', 'meeting', 'won', 'lost'];
      const cur = lead ? s.get('outreach_stages', lead.stage_id) : undefined;
      const target = s.t('outreach_stages').find((x) => x.workspace_id === ctx.ws && x.kind === 'interested');
      if (lead && target && order.indexOf(cur?.kind ?? 'new') < order.indexOf('interested')) s.update('outreach_leads', lead.id, { stage_id: target.id });
    }
    return null;
  },

  thread_attribution: (a, ctx) => {
    const s = ctx.store;
    const c = chatOr404(ctx, a.p_chat);
    const msgs = s.t('outreach_messages').filter((m) => m.chat_id === c.id).sort((x, y) => String(x.sent_at).localeCompare(String(y.sent_at)));
    const wanted = new Set(msgs.flatMap((m) => [m.action_id, m.replied_to_action_id]).filter(Boolean));
    const actions = new Map(s.t('outreach_actions').filter((x) => wanted.has(x.id)).map((x) => [x.id, x]));
    const steps = new Map<string, Record<string, number>>();
    return msgs.map((m) => {
      const act = actions.get(m.action_id ?? m.replied_to_action_id);
      const e = act?.enrollment_id ? s.get('outreach_enrollments', act.enrollment_id) : undefined;
      const q = e ? s.get('outreach_sequences', e.sequence_id) : undefined;
      let graph: Row | null = q?.graph ?? null;
      if (e?.pinned_version && q) graph = s.t('outreach_sequence_versions').find((v) => v.sequence_id === q.id && v.version === e.pinned_version)?.graph ?? graph;
      const key = `${q?.id}|${e?.pinned_version ?? ''}`;
      if (graph && !steps.has(key)) steps.set(key, stepNumbers(graph));
      const node = act?.node_id && graph ? graph.nodes?.[act.node_id] : undefined;
      const manualOut = m.direction === 'out' && (!m.action_id || act?.action_type === 'reply');
      const variant = node && act?.variant_id ? (node.config?.variants ?? []).find((v: Row) => v.id === act.variant_id) : undefined;
      return {
        message_id: m.id,
        kind: m.direction === 'in' ? 'inbound' : m.action_id && act && act.action_type !== 'reply' ? 'automated' : 'manual',
        sequence_id: q?.id ?? null, sequence_name: q?.name ?? null, node_id: act?.node_id ?? null,
        step_number: act?.node_id && graph ? (steps.get(key)?.[act.node_id] ?? null) : null,
        step_label: act ? (node?.label ?? initcap(String(node?.type ?? act.action_type))) : null,
        node_type: act ? (node?.type ?? act.action_type) : null, variant_id: act?.variant_id ?? null, variant_label: variant?.label ?? null,
        sender_name: s.get('outreach_senders', act?.sender_id ?? c.sender_id)?.display_name ?? null,
        sent_by_name: manualOut ? userLabel(s, c.workspace_id, m.sent_by) : null,
        replying_to_message_id: m.direction === 'in' && m.replied_to_action_id
          ? (msgs.filter((o) => o.action_id === m.replied_to_action_id).sort((x, y) => String(y.sent_at).localeCompare(String(x.sent_at)))[0]?.id ?? null) : null,
      };
    });
  },

  // ---------------------------------------------------------------------------------------------- web chat: agent side
  webchat_agent_ai: (a, ctx) => {
    const s = ctx.store;
    const c = webchatChat(ctx, a.p_chat);
    const on = !!a.p_on;
    if (on) s.update('outreach_chats', c.id, (x) => ({ handed_off_at: null, handoff_reason: null, ai_handled: true, ai_mode: x.ai_mode && x.ai_mode !== 'off' ? x.ai_mode : 'first' }));
    else s.update('outreach_chats', c.id, (x) => ({ handed_off_at: x.handed_off_at ?? ctx.now(), handoff_reason: x.handoff_reason ?? 'manual', ai_handled: false }));
    s.insert('outreach_messages', {
      workspace_id: c.workspace_id, chat_id: c.id, unipile_message_id: null, direction: 'out', text: null, html: null, attachments: [], sent_at: ctx.now(), is_invite_note: false,
      reactions: [], read_at: null, transcript: null, transcript_status: null, intent: null, intent_confidence: null, summary: null, classified_at: null, opens: 0, clicks: 0,
      edited_at: null, deleted_at: null, action_id: null, replied_to_action_id: null, is_first_reply: false, sent_by: ctx.userId, origin: 'inbox_user', ai_flags: [], classification: null,
      content_type: 'event', content_attributes: { kind: on ? 'ai_resumed' : 'ai_stopped', by: userLabel(s, ctx.ws, ctx.userId) ?? 'Agent' }, sender_type: 'system', sender_name: null, source: 'system',
      read_by_agent_at: null, read_by_visitor_at: null, echo_id: null,
    });
    const after = s.get('outreach_chats', c.id)!;
    return { ai_handled: after.ai_handled, handed_off_at: after.handed_off_at ?? null };
  },

  webchat_agent_read: (a, ctx) => {
    const c = webchatChat(ctx, a.p_chat);
    const now = ctx.now();
    ctx.store.update('outreach_messages', (m) => m.chat_id === c.id && m.direction === 'in' && !m.read_by_agent_at, { read_by_agent_at: now });
    if (c.unread || c.unread_count) ctx.store.update('outreach_chats', c.id, { unread: false, unread_count: 0 });
    return null;
  },

  webchat_agent_send: (a, ctx) => {
    const c = webchatChat(ctx, a.p_chat);
    return agentSend(ctx, c, { text: a.p_text ?? '', contentType: a.p_content_type ?? 'text', attrs: a.p_attrs ?? {}, attachments: Array.isArray(a.p_attachments) ? a.p_attachments : [] });
  },

  webchat_agent_typing: (a, ctx) => {
    const c = webchatChat(ctx, a.p_chat);
    // silent: the widget's typing dots are a broadcast, not a change any inbox screen re-reads
    ctx.store.update('outreach_chats', c.id, { agent_typing_at: a.p_on ? ctx.now() : null, agent_typing_by: a.p_on ? ctx.userId : null }, { silent: true });
    return null;
  },

  webchat_ai_turns_list: (a, ctx) => {
    const i = inboxOf(ctx.store, a.p_inbox);
    if (!i || i.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
    const limit = Math.max(1, Math.min(Number(a.p_limit ?? 50), 500));
    return ctx.store.t('outreach_webchat_ai_turns').filter((t) => t.inbox_id === i.id).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, limit);
  },

  webchat_canned_list: (_a, ctx) =>
    inWs(ctx, 'outreach_webchat_canned_responses', (r) => !r.owner_id || r.owner_id === ctx.userId).sort((x, y) => String(x.short_code).localeCompare(String(y.short_code))),

  webchat_presence: (a, ctx) => {
    const state = String(a.p_state ?? 'online');
    if (!['online', 'busy', 'offline'].includes(state)) demoError('E_PAYLOAD_INVALID');
    const now = ctx.now();
    ctx.store.upsert('outreach_webchat_agent_presence', { workspace_id: ctx.ws, user_id: ctx.userId, state, last_seen_at: now }, ['workspace_id', 'user_id']);
    return { state, at: now };
  },

  webchat_visitor: (a, ctx) => visitorJson(ctx, visitorOr404(ctx, a.p_id)),

  webchat_visitor_update: (a, ctx) => {
    const s = ctx.store;
    const v = visitorOr404(ctx, a.p_id);
    const p: Row = a.p_patch ?? {};
    const patch: Row = {};
    if ('email' in p) {
      const em = String(p.email ?? '').trim().toLowerCase() || null;
      if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) demoError('E_PAYLOAD_INVALID', 'email');
      patch.email = em; patch.email_invalid = false;
    }
    if ('name' in p) patch.name = String(p.name ?? '').trim().slice(0, 120) || null;
    if ('phone' in p) patch.phone = String(p.phone ?? '').trim().slice(0, 40) || null;
    if ('company' in p) patch.company = String(p.company ?? '').trim().slice(0, 120) || null;
    if ('custom_attributes' in p) patch.custom_attributes = p.custom_attributes ?? {};
    const u = s.update('outreach_webchat_visitors', v.id, patch)[0];
    s.update('outreach_chats', (c) => c.visitor_id === v.id, { attendee_name: u.name ?? 'Visitor' });
    return visitorJson(ctx, u);
  },

  webchat_visitor_link_lead: (a, ctx) => {
    const s = ctx.store;
    const v = visitorOr404(ctx, a.p_id);
    let leadId: string;
    if (a.p_lead) {
      const l = s.get('outreach_leads', a.p_lead);
      if (!l || l.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
      leadId = l.id;
    } else {
      if (!v.email && !v.phone) demoError('E_PAYLOAD_INVALID', 'the visitor has no email or phone');
      leadId = leadFromVisitor(ctx, v).id;
    }
    const u = s.update('outreach_webchat_visitors', v.id, { lead_id: leadId })[0];
    s.update('outreach_chats', (c) => c.visitor_id === v.id, { lead_id: leadId });
    return visitorJson(ctx, u);
  },

  webchat_visitor_export: (a, ctx) => {
    const s = ctx.store;
    const v = visitorOr404(ctx, a.p_id);
    const { ip_hash: _ip, ...visitor } = v;   // eslint-disable-line @typescript-eslint/no-unused-vars
    return {
      visitor,
      page_views: s.t('outreach_webchat_page_views').filter((p) => p.visitor_id === v.id).sort((x, y) => String(x.at).localeCompare(String(y.at))),
      events: s.t('outreach_webchat_events').filter((e) => e.visitor_id === v.id).sort((x, y) => String(x.at).localeCompare(String(y.at))),
      conversations: s.t('outreach_chats').filter((c) => c.visitor_id === v.id).map((c) => ({
        id: c.id, status: c.status ?? 'open', created_at: c.created_at, csat: c.csat ?? null,
        messages: s.t('outreach_messages').filter((m) => m.chat_id === c.id && !m.deleted_at).sort((x, y) => String(x.sent_at).localeCompare(String(y.sent_at)))
          .map((m) => ({ sender_type: m.sender_type ?? null, sender_name: m.sender_name ?? null, text: m.text, sent_at: m.sent_at, content_type: m.content_type ?? 'text' })),
      })),
    };
  },
} satisfies RpcArea;

/** Table hooks (insert defaults, side effects) for this area's tables. Called once at boot. */
export function registerInbox(): void {
  // a snoozed conversation opens again when its time comes (the real worker does this every minute)
  const prev = tableHooks.outreach_chats ?? {};
  tableHooks.outreach_chats = {
    ...prev,
    beforeRead: (store) => {
      prev.beforeRead?.(store);
      const now = Date.now();
      for (const c of store.t('outreach_chats')) {
        if (c.status === 'snoozed' && c.snoozed_until && Date.parse(c.snoozed_until) <= now) store.update('outreach_chats', (r) => r === c, { status: 'open', snoozed_until: null });
      }
    },
  };
  // Replies / Sent columns (first_inbound_at, waiting_on, replied_at …), recomputed after the wake-up above
  registerInboxViews();
}
