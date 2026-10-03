/**
 * Demo edge functions: send-reply, edit-message, note-attachment, attachment-proxy, ai-draft.
 * Nothing leaves the browser: a reply is a row in the thread (and maybe an answer from the fictional prospect a little later).
 */
import { draftReply, personalLine } from '../ai';
import { demoError, type Ctx, type FnArea } from '../ctx';
import { NOTES, canReadNote, memberOf, sampleFile } from '../inbox/shared';
import { agentSend } from '../inbox/webchat';
import { engineFor } from '../sim/engine';
import { readStored, storedUrl } from '../storage';
import type { Row } from '../store';

const EDIT_WINDOW_MS: Record<string, number> = { LINKEDIN: 60 * 60_000, WHATSAPP: 15 * 60_000 };
const DELETE_WINDOW_MS: Record<string, number> = { LINKEDIN: 60 * 60_000, WHATSAPP: 2 * 24 * 60 * 60_000 };
const REACT_PROVIDERS = ['WHATSAPP', 'INSTAGRAM', 'LINKEDIN'];
const MAIL = new Set(['GMAIL', 'OUTLOOK', 'IMAP']);
const LIMIT: Record<string, number> = { INSTAGRAM: 1000, WHATSAPP: 4096 };
const CHANNEL: Record<string, string> = { INSTAGRAM: 'Instagram', WHATSAPP: 'WhatsApp' };
const ACTIVE_RUNS = ['debouncing', 'drafting', 'draft_ready', 'scheduled'];
const ATTACHMENTS = 'outreach-attachments';

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
/** = cleanAddresses in reply.ts: Cc / Bcc trimmed, lowercased, valid, unique, at most 20. */
function cleanAddresses(list: unknown): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(list) ? list : []) {
    const e = String(v ?? '').trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) demoError('E_PAYLOAD_INVALID', `"${e.slice(0, 80)}" is not an email address`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > 20) demoError('E_PAYLOAD_INVALID', 'up to 20 Cc / Bcc addresses');
  return out;
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function replier(ctx: Ctx, chat: Row): void {
  const m = memberOf(ctx.store, ctx.ws, ctx.userId);
  if (!m) demoError('E_FORBIDDEN');
  if (!m.can_reply) demoError('E_FORBIDDEN', 'replies are disabled for your account');
  if (m.role !== 'owner' && m.role !== 'manager' && chat.client_id && !(m.client_ids ?? []).includes(chat.client_id)) demoError('E_FORBIDDEN');
}

/** Files the composer uploaded to the demo bucket, described the way the thread renders them. */
function storedAttachments(ctx: Ctx, chat: Row, paths: unknown, prefix: string): Row[] {
  const out: Row[] = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    const path = String(p);
    if (!path.startsWith(prefix) || /(^|\/)chat-notes(\/|$)/i.test(path) || path.includes('..')) continue;
    const blob = readStored(ATTACHMENTS, path);
    const name = (path.split('/').pop() ?? 'attachment').replace(/^\d+-/, '');
    out.push({ id: path, storage: true, name, type: blob?.type || null, mimetype: blob?.type || null, size: blob?.size ?? null });
  }
  void chat; void ctx;
  return out;
}

/** Edit distance ratio (0 = same text, 1 = all different): how much of an AI draft the teammate rewrote. */
function editRatio(a: string, b: string): number {
  if (a === b) return 0;
  const x = a.slice(0, 600), y = b.slice(0, 600);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length] / Math.max(x.length, y.length, 1);
}

function draftText(ctx: Ctx, task: Row, kind: string): string {
  const s = ctx.store;
  const lead = task.lead_id ? s.get('outreach_leads', task.lead_id) : undefined;
  const first = String(lead?.first_name ?? 'there');
  const line = lead ? personalLine(s, lead.id).text : 'I came across your profile';
  if (kind === 'invite_note') return `Hi ${first}, ${line.charAt(0).toLowerCase()}${line.slice(1)}. I work with teams like ${lead?.company ?? 'yours'} on outbound. Would be great to connect.`.slice(0, 300);
  if (kind === 'comment') return `Really useful perspective, ${first}. The part about doing fewer things well matches what we see with teams like ${lead?.company ?? 'yours'}.`;
  const chat = task.chat_id ? s.get('outreach_chats', task.chat_id)
    : s.t('outreach_chats').find((c) => c.lead_id === task.lead_id && c.sender_id === task.sender_id && c.last_direction === 'in');
  if (chat) return draftReply(s, chat);
  return `Hi ${first}, ${line.charAt(0).toLowerCase()}${line.slice(1)}. We help teams like ${lead?.company ?? 'yours'} book more first meetings without adding headcount. Open to a quick chat next week?`;
}

export const inboxFn = {
  'send-reply': (req, ctx) => {
    const s = ctx.store;
    const b = req.body;
    const typed = String(b.text ?? '').trim();
    const paths: unknown[] = Array.isArray(b.attachments) ? b.attachments : [];
    if (!b.chat_id || (!typed && !b.booking && !paths.length)) demoError('E_PAYLOAD_INVALID', 'chat_id and text (or an attachment) required');
    const chat = s.get('outreach_chats', b.chat_id);
    if (!chat || chat.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
    replier(ctx, chat);
    const sender = s.get('outreach_senders', chat.sender_id);
    if (sender?.provider === 'WEBCHAT' || chat.provider === 'WEBCHAT') {
      const stored = storedAttachments(ctx, chat, paths, `${chat.workspace_id}/${chat.id}/`);
      const message = agentSend(ctx, chat, { text: typed, contentType: stored.length ? 'attachment' : 'text', attrs: b.suggestion_id ? { internal: { suggestion_id: b.suggestion_id } } : {}, attachments: stored });
      return { ok: true, message };
    }
    if (!sender || sender.status !== 'ok' || sender.deleted_at) demoError('E_SENDER_NOT_OK', 'sender is not connected');
    let text = typed;
    if (b.booking) {
      if (!sender.booking_link) demoError('E_NO_BOOKING_LINK', `${sender.display_name ?? 'This sender'} has no booking link yet. Add one on the sender page.`);
      const link = String(sender.booking_link);
      const url = chat.lead_id ? `${link}${link.includes('?') ? '&' : '?'}lead=${chat.lead_id}` : link;
      text = `${text || 'Here is my calendar, pick any time that suits you:'}\n\n${url}`;
    }
    const limit = LIMIT[sender.provider];
    if (limit && text.length > limit) demoError('E_PAYLOAD_INVALID', `${CHANNEL[sender.provider]} messages can be up to ${limit} characters (this one is ${text.length})`);
    // an AI send in flight or already done wins (outreach_ai_reply_before_human_send)
    const runs = s.t('outreach_ai_reply_runs').filter((r) => r.chat_id === chat.id);
    if (runs.some((r) => r.status === 'sending')) demoError('E_AI_SENDING', 'The AI is sending its reply in this chat right now. Check the thread before sending yours.');
    if (b.ai_run_id && runs.some((r) => r.id === b.ai_run_id && r.status === 'sent' && r.sent_origin === 'ai_autopilot')) demoError('E_AI_ALREADY_SENT', 'The AI already sent its version of this reply. Check the thread before sending again.');

    const mailCc = MAIL.has(sender.provider) ? cleanAddresses(b.cc) : [], mailBcc = MAIL.has(sender.provider) ? cleanAddresses(b.bcc) : [];
    let quoted: Row | null = null;
    if (b.quote_message_id && !MAIL.has(sender.provider)) {
      const q = s.get('outreach_messages', b.quote_message_id);
      if (!q || q.chat_id !== chat.id || !q.unipile_message_id) demoError('E_PAYLOAD_INVALID', 'that message cannot be replied to');
      const att = Array.isArray(q.attachments) ? q.attachments[0] : undefined;
      quoted = { unipile_message_id: q.unipile_message_id, text: q.text ? String(q.text).slice(0, 500) : null, sender_name: q.direction === 'out' ? 'You' : (q.sender_name ?? chat.attendee_name ?? null), attachment_type: att?.type ?? null };
    }
    const stored = storedAttachments(ctx, chat, paths, `${chat.workspace_id}/`);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const action = s.insert('outreach_actions', {
      workspace_id: chat.workspace_id, enrollment_id: null, import_job_id: null, lead_id: chat.lead_id ?? null, node_id: null, variant_id: null, sender_id: sender.id,
      action_type: 'reply', scheduled_for: nowIso, status: 'sent', reserved_at: nowIso, executed_at: nowIso, attempt: 1, decision: null, error_code: null,
      payload: { text, by: ctx.userId, ...(b.booking ? { booking: true } : {}), ...(b.ai_run_id ? { ai_run_id: b.ai_run_id } : {}) }, response: { ok: true },
    })[0];
    const isMail = MAIL.has(sender.provider);
    const html = isMail ? escHtml(text).replace(/\n/g, '<br/>') : null;
    const engine = engineFor(s);
    const msg = engine.appendMessage(chat, { direction: 'out', text, html, at: now, origin: 'inbox_user', sent_by: ctx.userId, attachments: stored, action_id: action.id });
    s.update('outreach_actions', action.id, { response: { message_id: msg.unipile_message_id } });
    if (quoted) s.update('outreach_messages', msg.id, { quoted });
    if (isMail) {
      // the mail header reply.ts records for a sent reply
      const to = String(chat.attendee_provider_id ?? '').toLowerCase();
      const subject = b.subject ? String(b.subject) : (chat.subject ? (/^re:/i.test(chat.subject) ? chat.subject : `Re: ${chat.subject}`) : null);
      s.update('outreach_messages', msg.id, { content_attributes: { email: {
        from: (sender.public_identifier ?? sender.owner_email) ? { name: sender.display_name ?? null, email: String(sender.public_identifier ?? sender.owner_email).toLowerCase() } : null,
        to: to ? [{ name: chat.attendee_name ?? null, email: to }] : [],
        cc: mailCc.filter((e) => e !== to).map((email) => ({ name: null, email })), bcc: mailBcc.filter((e) => e !== to).map((email) => ({ name: null, email })), reply_to: [], subject,
      } } });
    }
    s.update('outreach_chats', chat.id, (c) => ({
      unread: false, unread_count: 0, archived: false,
      ...(sender.provider === 'INSTAGRAM' && c.is_request ? { is_request: false } : {}),
      ...(isMail && b.subject && !c.subject ? { subject: String(b.subject) } : {}),
    }));
    if (chat.lead_id) s.update('outreach_lead_sender_state', (r) => r.lead_id === chat.lead_id && r.sender_id === sender.id, { last_outbound_at: nowIso, unipile_chat_id: chat.unipile_chat_id });

    // AI replies: a draft sent as is (or lightly edited) counts as the AI's; every other pending run stops (human takeover)
    let used = false;
    if (b.ai_run_id) {
      const run = runs.find((r) => r.id === b.ai_run_id && ['draft_ready', 'scheduled', 'escalated'].includes(r.status) && r.draft_text);
      const ratio = run ? editRatio(String(run.draft_text), text) : 1;
      if (run && ratio <= 0.5) {
        used = true;
        const origin = ratio <= 0.0001 ? 'ai_draft_sent' : 'ai_edited';
        s.update('outreach_ai_reply_runs', run.id, { status: 'sent', sent_origin: origin, sent_message_id: msg.id, final_text: text, edit_distance: ratio, dispatched_by: ctx.userId });
        s.update('outreach_messages', msg.id, { origin, ai_reply_run_id: run.id });
        s.update('outreach_chats', chat.id, (c) => ({ ai_replies_count: (c.ai_replies_count ?? 0) + 1, conversation_stage: run.stage_after ?? c.conversation_stage ?? null }));
      }
    }
    s.update('outreach_ai_reply_runs', (r) => r.chat_id === chat.id && ACTIVE_RUNS.includes(r.status) && (!used || r.id !== b.ai_run_id), { status: 'cancelled', cancel_reason: 'human_takeover' });

    ctx.ui.simulated();
    // some prospects write back within a couple of clock steps (PRD §4.4)
    engine.scheduleProspectAnswer(s.get('outreach_chats', chat.id)!);
    return { ok: true, message: s.get('outreach_messages', msg.id) };
  },

  'edit-message': (req, ctx) => {
    const s = ctx.store;
    const b = req.body;
    if (b.action === 'read' || b.action === 'unread') {
      const chat = s.get('outreach_chats', b.chat_id);
      if (!chat || chat.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
      const sender = s.get('outreach_senders', chat.sender_id);
      if (sender?.provider !== 'WHATSAPP' || sender.status !== 'ok') return { ok: true, synced: false };
      if (b.action === 'read') s.update('outreach_messages', (m) => m.chat_id === chat.id && m.direction === 'in' && !m.read_at, { read_at: ctx.now() }, { silent: true });
      return { ok: true, synced: true };
    }
    const msg = s.get('outreach_messages', b.message_id);
    if (!msg || msg.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
    const chat = s.get('outreach_chats', msg.chat_id);
    if (!chat) demoError('E_NOT_FOUND');
    replier(ctx, chat);
    if (!msg.unipile_message_id) demoError('E_PAYLOAD_INVALID', 'this message is not known to the connected account yet');
    const sender = s.get('outreach_senders', chat.sender_id);
    if (sender?.status !== 'ok') demoError('E_SENDER_NOT_OK', 'sender is not connected');
    const provider = String(sender.provider);
    const age = Date.now() - Date.parse(msg.sent_at);
    if (b.action === 'edit' || b.action === 'delete') {
      if (msg.direction !== 'out') demoError('E_PAYLOAD_INVALID', 'only sent messages can be edited or deleted');
      const window = (b.action === 'edit' ? EDIT_WINDOW_MS : DELETE_WINDOW_MS)[provider];
      if (!window) demoError('E_PAYLOAD_INVALID', 'only LinkedIn and WhatsApp messages can be edited or deleted');
      if (age > window) demoError('E_WINDOW_CLOSED', `this message can no longer be ${b.action === 'edit' ? 'edited' : 'deleted'}`);
      if (b.action === 'edit') {
        const text = String(b.text ?? '').trim();
        if (!text) demoError('E_PAYLOAD_INVALID', 'text required');
        s.update('outreach_messages', msg.id, { text, edited_at: ctx.now() });
        if (chat.last_message_at === msg.sent_at) s.update('outreach_chats', chat.id, { last_message_preview: text.replace(/\s+/g, ' ').slice(0, 140) });
      } else {
        s.update('outreach_messages', msg.id, { deleted_at: ctx.now() });
      }
    } else if (b.action === 'react') {
      const emoji = String(b.emoji ?? '').trim();
      if (!emoji || emoji.length > 16) demoError('E_PAYLOAD_INVALID', 'emoji required');
      if (!REACT_PROVIDERS.includes(provider)) demoError('E_PAYLOAD_INVALID', 'reactions are not available on this channel');
      const reactions = (Array.isArray(msg.reactions) ? msg.reactions : []).filter((r: Row) => !(r?.mine === true || r?.by === 'us'));
      reactions.push({ emoji, by: 'You', by_id: sender.provider_user_id ?? null, mine: true, at: ctx.now() });
      s.update('outreach_messages', msg.id, { reactions });
    } else if (b.action === 'forward') {
      if (provider !== 'WHATSAPP') demoError('E_PAYLOAD_INVALID', 'forwarding is available on WhatsApp only');
      const target = s.get('outreach_chats', b.to_chat_id);
      if (!target || target.sender_id !== chat.sender_id || !target.unipile_chat_id) demoError('E_PAYLOAD_INVALID', 'forward to a chat of the same WhatsApp number');
      const m2 = engineFor(s).appendMessage(target, { direction: 'out', text: msg.text ?? 'Forwarded message', at: Date.now(), origin: 'inbox_user', sent_by: ctx.userId, attachments: msg.attachments ?? [] });
      s.update('outreach_messages', m2.id, { is_forwarded: true });
    } else demoError('E_PAYLOAD_INVALID', 'action must be edit, delete, react, forward, read or unread');
    ctx.ui.simulated();
    return { ok: true };
  },

  'note-attachment': (req, ctx) => {
    const s = ctx.store;
    const b = req.body;
    if (b.action === 'upload_url') {
      if (!b.chat_id) demoError('E_PAYLOAD_INVALID', 'chat_id required');
      const size = Number(b.size ?? 0);
      if (!Number.isFinite(size) || size <= 0 || size > 25 * 1024 * 1024) demoError('E_PAYLOAD_INVALID', 'files up to 25 MB');
      const chat = s.get('outreach_chats', b.chat_id);
      if (!chat || chat.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
      const name = String(b.name ?? 'file').replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._ -]+/g, '_').trim().slice(0, 120) || 'file';
      return { ok: true, path: `${chat.workspace_id}/${chat.id}/${s.uid()}/${name}`, token: 'demo', name, max_bytes: 25 * 1024 * 1024 };
    }
    if (b.action === 'read_url') {
      if (!b.note_id || !b.path) demoError('E_PAYLOAD_INVALID', 'note_id and path required');
      const note = s.get(NOTES, b.note_id);
      const chat = note ? s.get('outreach_chats', note.chat_id) : undefined;
      if (!note || note.deleted_at || !chat || !canReadNote(s, ctx.userId, chat, note.visibility)) demoError('E_NOT_FOUND');
      const att = (note.attachments ?? []).find((a: Row) => a?.path === b.path);
      if (!att) demoError('E_NOT_FOUND', 'attachment not on note');
      // uploaded in this session: the stored copy; a seeded note: a small sample file
      const url = storedUrl('outreach-chat-notes', att.path) ?? URL.createObjectURL(sampleFile(att.name ?? 'file', att.mime));
      return { ok: true, url, expires_in: 600 };
    }
    demoError('E_PAYLOAD_INVALID', 'action must be upload_url or read_url');
  },

  'attachment-proxy': (req, ctx) => {
    const s = ctx.store;
    const messageId = req.query.get('message_id') ?? String(req.body.message_id ?? '');
    const attachmentId = req.query.get('attachment_id') ?? String(req.body.attachment_id ?? '');
    const msg = s.get('outreach_messages', messageId);
    if (!msg || msg.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
    const att = (msg.attachments ?? []).find((a: Row) => a?.id === attachmentId);
    if (!att) demoError('E_NOT_FOUND', 'attachment not on message');
    const blob = (att.storage ? readStored(ATTACHMENTS, att.id) : null) ?? sampleFile(String(att.name ?? (att.voice_note ? 'voice-note.wav' : 'attachment')), att.voice_note ? 'audio/wav' : (att.mimetype ?? att.type));
    return new Response(blob, { status: 200, headers: { 'content-type': blob.type || 'application/octet-stream', 'content-disposition': `inline; filename="${String(att.name ?? 'attachment').replace(/"/g, '')}"` } });
  },

  'ai-draft': (req, ctx) => {
    const s = ctx.store;
    const b = req.body;
    if (b.task_id) {
      const t = s.get('outreach_tasks', b.task_id);
      if (!t || t.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
      if (t.completed_at) return { ok: true, text: null };
      const node = t.enrollment_id && t.node_id ? (() => {
        const e = s.get('outreach_enrollments', t.enrollment_id);
        const q = e ? s.get('outreach_sequences', e.sequence_id) : undefined;
        return q?.graph?.nodes?.[t.node_id] as Row | undefined;
      })() : undefined;
      const kind = String(node?.config?.kind ?? (node?.type === 'send_invite' ? 'invite_note' : node?.type === 'comment_latest_post' ? 'comment' : t.draft_kind ?? 'message'));
      const text = draftText(ctx, t, kind);
      s.update('outreach_tasks', t.id, { ai_draft: text, draft_kind: kind });
      return { ok: true, text };
    }
    if (!b.lead_id || !b.sender_id) demoError('E_PAYLOAD_INVALID', 'task_id or lead_id+sender_id required');
    const lead = s.get('outreach_leads', b.lead_id);
    if (!lead || lead.workspace_id !== ctx.ws) demoError('E_NOT_FOUND');
    const kind = String(b.kind ?? 'message');
    const task = s.insert('outreach_tasks', {
      workspace_id: lead.workspace_id, client_id: lead.client_id ?? null, kind: 'review_ai_draft', lead_id: lead.id, sender_id: b.sender_id, enrollment_id: b.enrollment_id ?? null,
      node_id: b.node_id ?? null, chat_id: null, title: `Review AI ${kind.replace('_', ' ')} for ${lead.full_name ?? 'lead'}`, body: b.brief ?? null, draft_kind: kind, ai_draft: null,
      assigned_to: ctx.userId, due_at: new Date(Date.now() + 86_400_000).toISOString(), completed_at: null, result: null, source: 'user',
    })[0];
    const text = draftText(ctx, task, kind);
    s.update('outreach_tasks', task.id, { ai_draft: text });
    return { ok: true, task_id: task.id, text };
  },
} satisfies FnArea;
