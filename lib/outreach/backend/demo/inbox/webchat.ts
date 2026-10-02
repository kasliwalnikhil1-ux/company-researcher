/** The website-chat side of the inbox: the agent's reply (outreach_webchat_agent_send) shared by the RPC and send-reply. */
import { demoError, type Ctx } from '../ctx';
import type { Row } from '../store';
import { addMessage, memberOf } from './shared';

/** A WEBCHAT conversation of the demo workspace, or E_NOT_FOUND. */
export function webchatChat(ctx: Ctx, id: unknown): Row {
  const c = ctx.store.get('outreach_chats', id as string);
  if (!c || c.workspace_id !== ctx.ws || c.provider !== 'WEBCHAT') demoError('E_NOT_FOUND');
  return c;
}

/** outreach_webchat__agent_name */
export function agentName(ctx: Ctx, userId: string | null | undefined): string {
  const m = memberOf(ctx.store, ctx.ws, userId);
  return String(m?.display_name || String(m?.email ?? '').split('@')[0] || 'Agent');
}

const CTYPES = ['text', 'attachment', 'cards', 'quick_replies', 'form'];

/** The agent's answer in a website chat: canned shortcuts and {{variables}} expanded, the thread read, the chat reopened. */
export function agentSend(ctx: Ctx, chat: Row, o: { text: string; contentType?: string; attrs?: Row; attachments?: Row[]; actor?: string }): Row {
  const s = ctx.store;
  const actor = o.actor ?? ctx.userId;
  const m = memberOf(s, ctx.ws, actor);
  if (!m?.can_reply) demoError('E_FORBIDDEN', 'replies are off for your account');
  let ctype = o.contentType || 'text';
  if (!CTYPES.includes(ctype)) demoError('E_PAYLOAD_INVALID', 'content_type');
  const who = agentName(ctx, actor);
  let text = String(o.text ?? '');
  const sc = /^\/([A-Za-z0-9_-]+)\s*/.exec(text)?.[1];
  if (sc) {
    const canned = s.t('outreach_webchat_canned_responses')
      .filter((r) => r.workspace_id === ctx.ws && String(r.short_code).toLowerCase() === sc.toLowerCase() && (!r.owner_id || r.owner_id === actor))
      .sort((a, b) => (a.owner_id ? 0 : 1) - (b.owner_id ? 0 : 1))[0];
    if (canned) { const rest = text.replace(/^\/[A-Za-z0-9_-]+\s*/, '').trim(); text = String(canned.content) + (rest ? ` ${rest}` : ''); }
  }
  const contact = String(chat.attendee_name || 'there');
  text = text.split('{{contact.name}}').join(contact).split('{{agent.name}}').join(who).split('{{contact.first_name}}').join(contact.split(' ')[0]).slice(0, 20_000);
  const attachments = o.attachments ?? [];
  if (ctype === 'text' && !text.trim() && !attachments.length) demoError('E_PAYLOAD_INVALID', 'text');
  if (attachments.length) {
    ctype = 'attachment';
    for (const a of attachments) if (!String(a?.id ?? '').startsWith(`${chat.workspace_id}/${chat.id}/`)) demoError('E_PAYLOAD_INVALID', 'attachment path');
  }
  const attrs = o.attrs ?? {};
  const cards = Array.isArray(attrs.products) ? attrs.products.length : 0;
  const now = Date.now();
  const msg = addMessage(s, chat, {
    direction: 'out', text: text || null, at: now, origin: 'inbox_user', sent_by: actor, attachments, content_type: ctype, content_attributes: attrs,
    sender_type: 'agent', sender_name: who, source: 'agent', preview: text || (cards ? `${cards} product${cards === 1 ? '' : 's'}` : attachments.length ? 'Attachment' : ''),
  });
  const nowIso = new Date(now).toISOString();
  s.update('outreach_chats', chat.id, (c) => ({
    unread: false, unread_count: 0, archived: false, agent_typing_at: null,
    status: c.status === 'resolved' || c.status === 'snoozed' ? 'open' : (c.status ?? 'open'), resolved_at: c.status === 'resolved' ? null : (c.resolved_at ?? null),
    snoozed_until: c.status === 'snoozed' ? null : (c.snoozed_until ?? null),
    assigned_to: c.assigned_to ?? actor, first_response_at: c.first_response_at ?? nowIso,
  }));
  s.update('outreach_messages', (x) => x.chat_id === chat.id && x.direction === 'in' && !x.read_by_agent_at, { read_by_agent_at: nowIso });
  const sug = (attrs.internal as Row | undefined)?.suggestion_id;
  if (sug) s.update('outreach_webchat_ai_suggestions', (g) => g.id === sug && g.chat_id === chat.id, { status: 'used', used_message_id: msg.id, resolved_by: actor });
  ctx.ui.simulated();
  return msg;
}
