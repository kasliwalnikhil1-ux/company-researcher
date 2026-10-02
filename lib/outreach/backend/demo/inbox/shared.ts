/**
 * Inbox helpers shared by the inbox handlers and the inbox seed: members and their access, private-note JSON (the
 * shape of outreach__note_json), mention parsing and notifications (046), a message writer that fills every column the
 * thread reads (incl. the web-chat ones), sample attachment bytes, and product cards.
 */
import type { DemoStore, Row } from '../store';

export const NOTES = 'outreach_chat_notes';
export const REVISIONS = 'outreach_chat_note_revisions';
export const MENTIONS = 'outreach_chat_note_mentions';
export const NOTIFICATIONS = 'outreach_notifications';
export const PREFS = 'outreach_notification_prefs';

const iso = (ms: number) => new Date(ms).toISOString();

// --------------------------------------------------------------------------------------------- members
export function memberOf(store: DemoStore, ws: string, userId: string | null | undefined): Row | undefined {
  if (!userId) return undefined;
  return store.t('outreach_members').find((m) => m.workspace_id === ws && m.user_id === userId);
}
export function userLabel(store: DemoStore, ws: string, userId: string | null | undefined): string | null {
  const m = memberOf(store, ws, userId);
  return m ? String(m.display_name || m.email || '') || null : null;
}
export function authorLabel(store: DemoStore, ws: string, authorId: string | null | undefined, type: string): string {
  if (type === 'ai') return 'AI';
  if (type === 'system') return 'System';
  if (type === 'agent') return `Claude (via ${userLabel(store, ws, authorId) ?? 'a former member'})`;
  return userLabel(store, ws, authorId) ?? 'Former member';
}
/** outreach__user_can_read_chat_note: role + client scope; client viewers only for notes shared with the client. */
export function canReadNote(store: DemoStore, userId: string, chat: Row, visibility: string): boolean {
  const m = memberOf(store, chat.workspace_id, userId);
  if (!m) return false;
  if (m.role === 'client_viewer' && visibility !== 'team_and_client') return false;
  if (m.role === 'owner' || m.role === 'manager') return true;
  if (!chat.client_id) return true;
  return Array.isArray(m.client_ids) && m.client_ids.includes(chat.client_id);
}

// --------------------------------------------------------------------------------------------- notes
const TOKEN_RE = /@\[([^\]]{1,80})\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;
export const notePlain = (body: string | null | undefined) => String(body ?? '').replace(TOKEN_RE, '@$1');
export const mentionToken = (name: string, userId: string) => `@[${name.replace(/[[\]]/g, '')}](user:${userId})`;

/** Mention tokens kept (readable by the person, not the author, ≤ 20) and dropped with the reason. */
export function parseMentions(store: DemoStore, chat: Row, visibility: string, body: string, author: string | null): { kept: string[]; dropped: Row[] } {
  const kept: string[] = [];
  const dropped: Row[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(TOKEN_RE)) {
    const name = m[1], uid = m[2];
    if (seen.has(uid)) continue;
    seen.add(uid);
    if (author && uid === author) dropped.push({ user_id: uid, name, reason: 'self' });
    else if (!memberOf(store, chat.workspace_id, uid)) dropped.push({ user_id: uid, name, reason: 'not_member' });
    else if (!canReadNote(store, uid, chat, visibility)) dropped.push({ user_id: uid, name, reason: 'no_access' });
    else if (kept.length >= 20) dropped.push({ user_id: uid, name, reason: 'cap' });
    else kept.push(uid);
  }
  return { kept, dropped };
}

/** "Priya Nair (Razorpay)" for notification titles. */
export function chatTitle(store: DemoStore, chat: Row): string {
  const lead = chat.lead_id ? store.get('outreach_leads', chat.lead_id) : undefined;
  const name = (lead?.full_name || chat.attendee_name || chat.subject || 'a conversation') as string;
  return lead?.company ? `${name} (${lead.company})` : name;
}

/** = outreach__note_json */
export function noteJson(store: DemoStore, n: Row): Row {
  const ws = n.workspace_id;
  const chat = store.get('outreach_chats', n.chat_id) ?? { workspace_id: ws, client_id: n.client_id };
  const deleted = !!n.deleted_at;
  return {
    id: n.id, chat_id: n.chat_id, lead_id: n.lead_id ?? null, client_id: n.client_id ?? null, workspace_id: ws,
    author: {
      id: n.author_id ?? null, type: n.author_type, name: authorLabel(store, ws, n.author_id, n.author_type),
      former: (n.author_type === 'user' || n.author_type === 'agent') && (!n.author_id || userLabel(store, ws, n.author_id) == null),
    },
    body: deleted ? null : n.body,
    visibility: n.visibility,
    mentions: (n.mentions ?? []).map((u: string) => {
      const mm = store.t(MENTIONS).find((x) => x.note_id === n.id && x.user_id === u);
      return { user_id: u, name: userLabel(store, ws, u) ?? 'former member', read_at: mm?.read_at ?? null, access: canReadNote(store, u, chat, n.visibility) };
    }),
    attachments: deleted ? [] : (n.attachments ?? []),
    exclude_from_ai: String(n.body ?? '').startsWith('#no-ai'),
    edited_at: n.edited_at ?? null,
    revisions: store.t(REVISIONS).filter((r) => r.note_id === n.id).length,
    deleted_at: n.deleted_at ?? null,
    deleted_by: deleted ? (userLabel(store, ws, n.deleted_by) ?? (n.deleted_by ? 'a former member' : 'System')) : null,
    created_at: n.created_at,
  };
}

/** Mention rows + one notification per mentioned person (outreach__note_notify_mentions). */
export function notifyMentions(store: DemoStore, n: Row, users: string[], at?: string, readAt: string | null = null): number {
  if (!users.length) return 0;
  const chat = store.get('outreach_chats', n.chat_id);
  const who = authorLabel(store, n.workspace_id, n.author_id, n.author_type);
  const title = `${who} mentioned you in ${chat ? chatTitle(store, chat) : 'a conversation'}`;
  const snippet = notePlain(n.body).replace(/\s+/g, ' ').slice(0, 140);
  const when = at ?? store.nowIso();
  for (const u of users) {
    if (!store.t(MENTIONS).some((x) => x.note_id === n.id && x.user_id === u)) {
      store.insert(MENTIONS, { note_id: n.id, user_id: u, workspace_id: n.workspace_id, chat_id: n.chat_id, created_at: when, read_at: readAt, emailed_at: null }, { noId: true });
    }
    store.insert(NOTIFICATIONS, { workspace_id: n.workspace_id, user_id: u, kind: 'note_mention', chat_id: n.chat_id, note_id: n.id, actor_id: n.author_id ?? null, title, body: snippet, read_at: readAt, created_at: when });
  }
  return users.length;
}

/** Writes a note row (create path shared by the RPC and the seed). */
export function insertNote(store: DemoStore, chat: Row, o: { author_id: string | null; author_type: string; body: string; visibility?: string; attachments?: Row[]; at?: string; mentionsReadAt?: string | null }): { note: Row; dropped: Row[] } {
  const vis = o.visibility ?? 'team';
  const { kept, dropped } = parseMentions(store, chat, vis, o.body, o.author_type === 'user' || o.author_type === 'agent' ? o.author_id : null);
  const at = o.at ?? store.nowIso();
  const note = store.insert(NOTES, {
    workspace_id: chat.workspace_id, chat_id: chat.id, lead_id: chat.lead_id ?? null, client_id: chat.client_id ?? null, author_id: o.author_id, author_type: o.author_type,
    body: o.body, visibility: vis, mentions: kept, attachments: o.attachments ?? [], edited_at: null, deleted_at: null, deleted_by: null, purged_at: null, created_at: at,
  })[0];
  notifyMentions(store, note, kept, at, o.mentionsReadAt ?? null);
  if (!chat.last_note_at || Date.parse(chat.last_note_at) < Date.parse(at)) store.update('outreach_chats', chat.id, { last_note_at: at });
  return { note, dropped };
}

// --------------------------------------------------------------------------------------------- messages
export type MessageInput = {
  direction: 'in' | 'out'; text: string | null; at: number; origin?: string; sent_by?: string | null; attachments?: Row[]; intent?: string | null; summary?: string | null;
  content_type?: string; content_attributes?: Row; sender_type?: string | null; sender_name?: string | null; source?: string | null; read_at?: string | null;
  reactions?: Row[]; transcript?: string | null; transcript_status?: string | null; quoted?: Row | null; opens?: number; html?: string | null;
  read_by_agent_at?: string | null; read_by_visitor_at?: string | null; replied_to_action_id?: string | null; action_id?: string | null; preview?: string | null;
  /** keep the chat's unread state as it is (seed: a conversation that was already read). */
  read?: boolean;
};

/** A message with every column the thread renders; updates the conversation's preview / unread like the webhook does. */
export function addMessage(store: DemoStore, chat: Row, m: MessageInput): Row {
  const isIn = m.direction === 'in';
  const first = isIn && !store.t('outreach_messages').some((x) => x.chat_id === chat.id && x.direction === 'in');
  const event = m.content_type === 'event';
  const msg = store.insert('outreach_messages', {
    workspace_id: chat.workspace_id, chat_id: chat.id, unipile_message_id: chat.provider === 'WEBCHAT' ? null : `demo-msg-${store.uid().slice(0, 8)}`, direction: m.direction,
    text: m.text, html: m.html ?? null, attachments: m.attachments ?? [], sent_at: iso(m.at), is_invite_note: false, reactions: m.reactions ?? [], read_at: m.read_at ?? null,
    transcript: m.transcript ?? null, transcript_status: m.transcript_status ?? null, intent: m.intent ?? null, intent_confidence: m.intent ? 0.9 : null, summary: m.summary ?? null,
    classified_at: m.intent ? iso(m.at + 60_000) : null, opens: m.opens ?? 0, clicks: 0, edited_at: null, deleted_at: null, action_id: m.action_id ?? null,
    replied_to_action_id: m.replied_to_action_id ?? null, is_first_reply: first, sent_by: m.sent_by ?? null,
    origin: m.origin ?? (isIn ? 'prospect' : 'inbox_user'), ai_flags: [], classification: m.intent ? { intent: m.intent, summary: m.summary ?? null } : null,
    content_type: m.content_type ?? 'text', content_attributes: m.content_attributes ?? {}, sender_type: m.sender_type ?? null, sender_name: m.sender_name ?? null,
    source: m.source ?? null, read_by_agent_at: m.read_by_agent_at ?? null, read_by_visitor_at: m.read_by_visitor_at ?? null, echo_id: null, quoted: m.quoted ?? null,
    created_at: iso(m.at),
  })[0];
  if (!event) {
    const preview = (m.preview ?? m.text ?? (m.attachments?.length ? 'Attachment' : '')).replace(/\s+/g, ' ').slice(0, 140);
    store.update('outreach_chats', chat.id, (c) => ({
      last_message_at: iso(m.at), last_message_preview: preview, last_direction: m.direction,
      unread: isIn && !m.read ? true : (isIn ? c.unread : (m.origin === 'inbox_user' ? false : c.unread)),
      unread_count: isIn && !m.read ? (c.unread_count ?? 0) + 1 : (isIn ? c.unread_count : (m.origin === 'inbox_user' ? 0 : c.unread_count)),
      intent: m.intent ?? c.intent, archived: isIn ? false : c.archived,
      conversation_exchanges: (c.conversation_exchanges ?? 0) + (isIn ? 1 : 0),
    }));
  }
  return msg;
}

// --------------------------------------------------------------------------------------------- sample attachment bytes
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** A small picture (SVG) with the file's name, standing in for an image the fictional prospect sent. */
export function sampleImage(name: string): Blob {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e0e7ff"/><stop offset="1" stop-color="#c7d2fe"/></linearGradient></defs><rect width="480" height="320" rx="16" fill="url(#g)"/><circle cx="380" cy="90" r="38" fill="#a5b4fc"/><path d="M40 270 L170 140 L260 230 L320 180 L440 270 Z" fill="#818cf8"/><text x="40" y="60" font-family="sans-serif" font-size="20" fill="#3730a3">${esc(name)}</text><text x="40" y="88" font-family="sans-serif" font-size="13" fill="#4f46e5">Sample image in the product tour</text></svg>`;
  return new Blob([svg], { type: 'image/svg+xml' });
}

/** About a second of silence (8 kHz, 8-bit WAV), so a voice note's player works. */
export function sampleAudio(seconds = 1): Blob {
  const n = Math.max(1, Math.round(8000 * seconds));
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return new Blob([buf], { type: 'audio/wav' });
}

export function sampleFile(name: string, mime?: string | null): Blob {
  const m = String(mime ?? '');
  if (m.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return sampleImage(name);
  if (m.startsWith('audio/') || /\.(m4a|mp3|ogg|wav|opus)$/i.test(name)) return sampleAudio(2);
  return new Blob([`${name}\n\nThis is a sample file in the product tour. The prospect and the file are fictional.\n`], { type: 'text/plain' });
}

// --------------------------------------------------------------------------------------------- product cards
/** A catalogue for when the AI area's seed has no products: fictional, fixed ids. */
export const FALLBACK_PRODUCTS: Row[] = [
  { id: '00000000-0000-4000-8000-9d0000000001', title: 'Starter outreach plan', price: 49, currency: 'USD', url: 'https://example.com/plans/starter', image_url: null, available: true },
  { id: '00000000-0000-4000-8000-9d0000000002', title: 'Growth plan (3 LinkedIn accounts)', price: 149, compare_at_price: 179, currency: 'USD', url: 'https://example.com/plans/growth', image_url: null, available: true },
  { id: '00000000-0000-4000-8000-9d0000000003', title: 'Agency plan (10 accounts)', price: 449, currency: 'USD', url: 'https://example.com/plans/agency', image_url: null, available: true },
  { id: '00000000-0000-4000-8000-9d0000000004', title: 'Done-for-you campaign setup', price: 299, currency: 'USD', url: 'https://example.com/services/setup', image_url: null, available: true },
];

/** = outreach_product__card */
export function productCard(p: Row, provider?: string | null): Row {
  const card: Row = { id: p.id, title: p.title, url: p.url, available: p.available !== false };
  if (p.price != null) card.price = Number(p.price);
  if (p.compare_at_price != null && p.price != null && Number(p.compare_at_price) > Number(p.price)) card.compare_at = Number(p.compare_at_price);
  if (p.currency) card.currency = p.currency;
  if (p.image_url) card.image = p.image_url;
  if (provider === 'shopify' && p.available !== false && Array.isArray(p.variants)) {
    const v = p.variants.find((x: Row) => x?.id && x.available !== false);
    if (v) card.variant_id = String(v.id);
  }
  return card;
}
/** The legacy `items` shape older widgets draw (title, price line, picture, a View link). */
export function productItem(p: Row): Row {
  const it: Row = { title: p.title, actions: [{ type: 'link', text: 'View', uri: p.url }] };
  if (p.price != null) it.description = `${p.currency ?? ''} ${Number(p.price).toFixed(2)}`.trim();
  if (p.image_url) it.media_url = p.image_url;
  return it;
}
/** Live catalogue products of the workspace (seeded by the AI area), falling back on the fixed list. */
export function catalogueProducts(store: DemoStore, ws: string): Array<{ row: Row; provider: string | null }> {
  const sources = new Map(store.t('outreach_knowledge_sources').map((s) => [s.id, s]));
  const live = store.t('outreach_products').filter((p) => p.workspace_id === ws && !p.deleted_at && !p.ai_hidden);
  if (live.length) return live.map((row) => ({ row, provider: (sources.get(row.source_id)?.catalogue?.provider ?? null) as string | null }));
  return FALLBACK_PRODUCTS.map((row) => ({ row, provider: null }));
}
