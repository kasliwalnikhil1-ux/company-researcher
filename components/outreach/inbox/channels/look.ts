/**
 * How a conversation is drawn, per channel: WhatsApp (green bubbles on the doodle wall), Instagram (blue / grey round
 * bubbles), LinkedIn (author rows, no bubbles), email (stacked mail cards) and the plain chat look (web chat).
 * Channel extras the webhook keeps on `content_attributes`: `msg_type` / `subject` / `view_once` on messages, `email`
 * (from / to / cc / bcc / reply-to / subject) on mail, `linkedin` (InMail / Sales Navigator …) on the chat's `custom_attributes`.
 */
import type { Chat, Message, Provider, Sender } from '@/lib/outreach/types';
import { isMailProvider } from '@/lib/outreach/channels';

export type ThreadLook = 'whatsapp' | 'instagram' | 'linkedin' | 'email' | 'chat';

export function threadLook(provider: Provider | string | null | undefined): ThreadLook {
  if (provider === 'WHATSAPP') return 'whatsapp';
  if (provider === 'INSTAGRAM') return 'instagram';
  if (provider === 'LINKEDIN') return 'linkedin';
  if (isMailProvider(provider)) return 'email';
  return 'chat';
}

/** The connector's message type when it is not a plain message: INMAIL, INVITATION, STORY_REPLY, STORY_MENTION … */
export function msgTypeOf(m: Pick<Message, 'content_attributes'>): string | null {
  const t = m.content_attributes?.msg_type;
  return typeof t === 'string' && t ? t.toUpperCase() : null;
}

/** An InMail's subject (LinkedIn). */
export function msgSubjectOf(m: Pick<Message, 'content_attributes'>): string | null {
  const s = m.content_attributes?.subject;
  return typeof s === 'string' && s.trim() ? s.trim() : null;
}

export type LinkedinChatMeta = { content_type: 'inmail' | 'sponsored' | 'linkedin_offer' | null; inbox: 'sales_navigator' | 'recruiter' | 'organization' | null };
export function linkedinChatMeta(chat: Pick<Chat, 'custom_attributes'>): LinkedinChatMeta | null {
  const li = (chat.custom_attributes as { linkedin?: LinkedinChatMeta } | undefined)?.linkedin;
  return li && typeof li === 'object' ? li : null;
}

// ------------------------------------------------------------------------------------------------ email
/** The mailbox address of an email sender (its public identifier once synced, else the owner's address). */
export function senderEmail(sender: Pick<Sender, 'public_identifier' | 'owner_email'> | null | undefined): string | null {
  const v = sender?.public_identifier?.includes('@') ? sender.public_identifier : sender?.owner_email;
  return v ? v.trim().toLowerCase() : null;
}

export type MailPerson = { name: string | null; email: string };
export type MailHeader = { from: MailPerson | null; to: MailPerson[]; cc: MailPerson[]; bcc: MailPerson[]; reply_to: MailPerson[]; subject: string | null };

const people = (v: unknown): MailPerson[] => (Array.isArray(v) ? v : [])
  .filter((p): p is MailPerson => !!p && typeof p === 'object' && typeof (p as MailPerson).email === 'string' && !!(p as MailPerson).email);

/**
 * The mail header of one message. Mail stored before the webhook kept the header (and sequence sends) has none:
 * it is rebuilt from the thread — our mailbox on one side, the contact's address on the other.
 */
export function mailHeaderOf(m: Message, chat: Pick<Chat, 'attendee_name' | 'attendee_provider_id' | 'subject'>, sender: Pick<Sender, 'display_name' | 'public_identifier' | 'owner_email'> | null): MailHeader {
  const e = m.content_attributes?.email as Partial<MailHeader> | undefined;
  const own = senderEmail(sender);
  const me: MailPerson | null = own ? { name: sender?.display_name ?? null, email: own } : null;
  const them: MailPerson | null = chat.attendee_provider_id && chat.attendee_provider_id.includes('@') ? { name: chat.attendee_name ?? null, email: chat.attendee_provider_id.toLowerCase() } : null;
  const from = e?.from && typeof e.from.email === 'string' ? e.from : (m.direction === 'out' ? me : them);
  const to = people(e?.to);
  return {
    from,
    to: to.length ? to : [m.direction === 'out' ? them : me].filter((p): p is MailPerson => !!p),
    cc: people(e?.cc), bcc: people(e?.bcc), reply_to: people(e?.reply_to),
    subject: (typeof e?.subject === 'string' && e.subject) || chat.subject || null,
  };
}

export function personLabel(p: MailPerson | null | undefined, myEmail?: string | null): string {
  if (!p) return 'Unknown sender';
  if (myEmail && p.email === myEmail.toLowerCase()) return 'me';
  return p.name?.trim() || p.email;
}

/** "Re: Re: Fwd: Pricing" → "Pricing", for comparing a message's subject with the thread's. */
export function baseSubject(s: string | null | undefined): string {
  return String(s ?? '').replace(/^\s*((re|fwd?|aw|sv|tr)\s*:\s*)+/i, '').trim().toLowerCase();
}

/**
 * A plain-text mail split into what was written and the quoted history below it ("On … wrote:", "-----Original
 * Message-----", Outlook's "From: … Sent: …" block, or a trailing run of "> " lines).
 */
export function splitQuotedText(text: string): { main: string; quoted: string | null } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    const two = `${l} ${(lines[i + 1] ?? '').trim()}`;
    const header = /^(on\s.+wrote:|le\s.+a écrit\s?:|am\s.+schrieb.*:|el\s.+escribió:|-{2,}\s*original message\s*-{2,}|_{8,})$/i.test(l)
      || /^on\s.+wrote:$/i.test(two)
      || (/^from:\s.+/i.test(l) && /^(sent|date|to):/i.test((lines[i + 1] ?? '').trim()));
    const quoteRun = l.startsWith('>') && lines.slice(i).every((x) => !x.trim() || x.trim().startsWith('>'));
    if (header || quoteRun) {
      const main = lines.slice(0, i).join('\n').trimEnd();
      if (main.trim()) return { main, quoted: lines.slice(i).join('\n').trim() };
    }
  }
  return { main: text, quoted: null };
}

const QUOTE_SELECTORS = ['.gmail_quote', 'blockquote[type="cite"]', '#divRplyFwdMsg', '#appendonsend', '.yahoo_quoted', '[id^="mail-editor-reference-message"]', '.moz-cite-prefix'];

/** Sanitised HTML split into the new part and the quoted history (Gmail, Apple Mail, Outlook, Yahoo, Thunderbird markers). */
export function splitQuotedHtml(safeHtml: string): { main: string; quoted: string | null } {
  if (typeof window === 'undefined' || !safeHtml) return { main: safeHtml, quoted: null };
  const doc = new DOMParser().parseFromString(`<body>${safeHtml}</body>`, 'text/html');
  let q: Element | null = null;
  for (const sel of QUOTE_SELECTORS) {
    const hit = doc.body.querySelector(sel);
    if (hit && (!q || (hit.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING))) q = hit;
  }
  if (!q) return { main: safeHtml, quoted: null };
  // Outlook puts an <hr> or a border div right before its "From:" block: take it along
  const prev = q.previousElementSibling;
  const start = prev && (prev.tagName === 'HR' || (prev.tagName === 'DIV' && !prev.textContent?.trim())) ? prev : q;
  const range = doc.createRange();
  range.setStartBefore(start);
  range.setEndAfter(doc.body.lastChild!);
  const frag = range.extractContents();
  const holder = doc.createElement('div');
  holder.appendChild(frag);
  if (!doc.body.textContent?.trim() && !doc.body.querySelector('img')) return { main: safeHtml, quoted: null };
  return { main: doc.body.innerHTML, quoted: holder.innerHTML };
}

// ------------------------------------------------------------------------------------------------ chat bits
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:️|‍|\p{Emoji_Modifier}|\p{Extended_Pictographic})*|\p{Regional_Indicator}{2}|\s)+$/u;

/** One to three emoji and nothing else: WhatsApp and Instagram draw these large, without a bubble. */
export function isEmojiOnly(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim();
  if (!t || t.length > 24 || !EMOJI_ONLY.test(t)) return false;
  const n = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t.replace(/\s+/g, ''))].length;
  return n >= 1 && n <= 3;
}

/** "10:42" in the viewer's locale. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Gmail's date on an open mail: "Oct 2, 2026, 10:42 AM (2 days ago)". */
export function mailDate(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const abs = d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', hour: 'numeric', minute: '2-digit' });
  const mins = Math.round((now - d.getTime()) / 60_000);
  const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 24 * 60 ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? '' : 's'} ago` : mins < 30 * 24 * 60 ? `${Math.round(mins / 1440)} day${Math.round(mins / 1440) === 1 ? '' : 's'} ago` : null;
  return rel ? `${abs} (${rel})` : abs;
}

/** Gmail's short date in a collapsed row: the time today, "Oct 2" this year, "2/10/25" before. */
export function mailShortDate(iso: string, now = Date.now()): string {
  const d = new Date(iso), n = new Date(now);
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === n.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'numeric', day: 'numeric' });
}
