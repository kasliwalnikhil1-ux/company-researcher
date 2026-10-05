'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Download, Eye, FileArchive, FileImage, FileSpreadsheet, FileText, FileVideo, File as FileIcon, Languages, Loader2, MoreHorizontal, MousePointerClick, Paperclip, Reply, ReplyAll, Sparkles, Ban } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Chat, Message, Sender } from '@/lib/outreach/types';
import type { ThreadAttributionRow } from '@/lib/outreach/intel';
import { parseError } from '@/lib/outreach/api';
import { useComposeAssist } from '@/lib/outreach/aiReplies';
import { Avatar } from '@/components/outreach/ui';
import { fixMojibake } from '@/lib/outreach/channels';
import { fmtBytes, sanitizeHtml, triggerDownload, useAttachmentUrl, type MessageAttachment } from '../hooks';
import { Attribution, Translation } from '../MessageBubble';
import AiOriginBadge, { hasOriginBadge, isAiOrigin } from '../ai/AiOriginBadge';
import { baseSubject, senderEmail, mailDate, mailHeaderOf, mailShortDate, personLabel, splitQuotedHtml, splitQuotedText, type MailHeader, type MailPerson } from './look';

type Item = { kind: 'message'; m: Message } | { kind: 'note'; key: string; node: React.ReactNode };

export interface EmailThreadProps {
  chat: Chat;
  sender: Sender | null;
  items: Item[];
  now: number;
  attribution?: Record<string, ThreadAttributionRow>;
  canReply: boolean;
  /** Reply (to the contact) or Reply all (Cc: everyone else on that mail). */
  onReply: (cc: string[]) => void;
  highlightId: string | null;
}

/** Every address on a mail except ours and the contact's: the Cc of a "Reply all". */
function replyAllCc(h: MailHeader, myEmail: string | null, contact: string | null): string[] {
  const all = [h.from, ...h.reply_to, ...h.to, ...h.cc].filter((p): p is MailPerson => !!p).map((p) => p.email.toLowerCase());
  return [...new Set(all)].filter((e) => e !== myEmail && e !== contact);
}

/**
 * An email conversation the way a mail client shows it: the subject on top, one card per mail, older mails folded to a
 * line (sender, snippet, date), the newest open. A run of folded mails becomes "N older messages".
 */
export default function EmailThread({ chat, sender, items, now, attribution, canReply, onReply, highlightId }: EmailThreadProps) {
  const messages = useMemo(() => items.flatMap((it) => (it.kind === 'message' ? [it.m] : [])), [items]);
  const lastId = messages[messages.length - 1]?.id ?? null;
  const myEmail = senderEmail(sender);
  const contact = chat.attendee_provider_id?.toLowerCase() ?? null;
  const [open, setOpen] = useState<Set<string>>(() => new Set(lastId ? [lastId] : []));
  const [showOlder, setShowOlder] = useState(false);
  // a new mail arriving opens itself (like the newest mail in a client), and so does a mail jumped to
  const [opened, setOpened] = useState<{ last: string | null; hl: string | null }>({ last: lastId, hl: null });
  if (opened.last !== lastId || opened.hl !== highlightId) {
    setOpened({ last: lastId, hl: highlightId });
    const add = [lastId, highlightId].filter((x): x is string => !!x && !open.has(x));
    if (add.length) setOpen(new Set([...open, ...add]));
  }
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const subject = chat.subject || mailHeaderOf(messages[0] ?? ({} as Message), chat, sender).subject || '(no subject)';
  // fold the middle: first mail, "N older messages", then the last two (Gmail does the same past 4 folded mails)
  const msgIdx = items.map((it, i) => (it.kind === 'message' ? i : -1)).filter((i) => i >= 0);
  const foldFrom = msgIdx[1], foldTo = msgIdx[msgIdx.length - 3];
  const foldable = !showOlder && msgIdx.length > 5 && items.slice(foldFrom, foldTo + 1).every((it) => it.kind !== 'message' || !open.has(it.m.id));
  const hiddenCount = foldable ? items.slice(foldFrom, foldTo + 1).filter((it) => it.kind === 'message').length : 0;
  const lastHeader = useMemo(() => {
    const lastIn = [...messages].reverse().find((m) => !m.deleted_at) ?? null;
    return lastIn ? mailHeaderOf(lastIn, chat, sender) : null;
  }, [messages, chat, sender]);
  const allCc = lastHeader ? replyAllCc(lastHeader, myEmail, contact) : [];

  return (
    <div className="max-w-4xl mx-auto bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 pt-4 pb-3 flex items-start gap-3 border-b border-gray-100">
        <h3 className="text-[19px] leading-snug font-normal text-gray-900 min-w-0 flex-1 break-words">{subject}</h3>
        <span className="flex-shrink-0 mt-1 text-[11px] text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">{messages.length} {messages.length === 1 ? 'message' : 'messages'}</span>
      </div>
      <div className="divide-y divide-gray-100">
        {items.map((it, i) => {
          if (foldable && i >= foldFrom && i <= foldTo) {
            if (i !== foldFrom) return null;
            return (
              <div key="older" className="relative h-10">
                <div className="absolute inset-x-0 top-1/2 border-t border-gray-200" />
                <div className="absolute inset-x-0 top-[calc(50%+4px)] border-t border-gray-200" />
                <button type="button" onClick={() => setShowOlder(true)} className="absolute left-5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm" title={`Show ${hiddenCount} older messages`} aria-label={`Show ${hiddenCount} older messages`}>{hiddenCount}</button>
              </div>
            );
          }
          if (it.kind === 'note') return <div key={it.key} className="px-5 py-3 bg-amber-50/30">{it.node}</div>;
          return (
            <MailCard key={it.m.id} m={it.m} chat={chat} sender={sender} myEmail={myEmail} contact={contact} now={now} threadSubject={subject}
              open={open.has(it.m.id)} onToggle={() => toggle(it.m.id)} attribution={attribution?.[it.m.id]} canReply={canReply} onReply={onReply} highlight={highlightId === it.m.id} />
          );
        })}
      </div>
      {canReply && messages.length > 0 && (
        <div className="px-5 py-4 flex flex-wrap gap-2 border-t border-gray-100" style={{ paddingLeft: 68 }}>
          <button type="button" onClick={() => onReply([])} className="inline-flex items-center gap-2 rounded-full border border-gray-300 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-50 hover:shadow-sm"><Reply className="w-4 h-4" /> Reply</button>
          {allCc.length > 0 && <button type="button" onClick={() => onReply(allCc)} className="inline-flex items-center gap-2 rounded-full border border-gray-300 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-50 hover:shadow-sm" title={`Also to ${allCc.join(', ')}`}><ReplyAll className="w-4 h-4" /> Reply all</button>}
        </div>
      )}
    </div>
  );
}

function PeopleList({ list, myEmail }: { list: MailPerson[]; myEmail: string | null }) {
  return (
    <>
      {list.map((p, i) => (
        <span key={p.email} className="break-all">
          {p.name && p.email !== myEmail ? <><span className="text-gray-900">{p.name}</span> <span className="text-gray-500">&lt;{p.email}&gt;</span></> : <span className="text-gray-900">{p.email}</span>}
          {i < list.length - 1 ? ', ' : ''}
        </span>
      ))}
    </>
  );
}

interface MailCardProps {
  m: Message; chat: Chat; sender: Sender | null; myEmail: string | null; contact: string | null; now: number; threadSubject: string;
  open: boolean; onToggle: () => void; attribution?: ThreadAttributionRow; canReply: boolean; onReply: (cc: string[]) => void; highlight: boolean;
}

function MailCard({ m, chat, sender, myEmail, contact, now, threadSubject, open, onToggle, attribution, canReply, onReply, highlight }: MailCardProps) {
  const h = useMemo(() => mailHeaderOf(m, chat, sender), [m, chat, sender]);
  const mine = m.direction === 'out';
  const pending = m.id.startsWith('temp-');
  const deleted = !!m.deleted_at;
  const [details, setDetails] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);
  const [menu, setMenu] = useState(false);
  const safe = useMemo(() => (m.html ? sanitizeHtml(m.html) : ''), [m.html]);
  const html = useMemo(() => (safe ? splitQuotedHtml(safe) : null), [safe]);
  const plain = useMemo(() => (!safe ? splitQuotedText(fixMojibake(m.text) ?? '') : null), [safe, m.text]);
  const snippet = useMemo(() => {
    const src = plain ? plain.main : (html ? htmlText(html.main) : (m.text ?? ''));
    return String(src).replace(/\s+/g, ' ').trim().slice(0, 180);
  }, [plain, html, m.text]);
  const atts = (m.attachments ?? []) as MessageAttachment[];
  const fromLabel = mine ? (h.from?.name || sender?.display_name || 'me') : (h.from?.name || h.from?.email || chat.attendee_name || 'Unknown sender');
  const avatar = mine ? sender?.picture_url : (chat.attendee_picture_url || (chat as Chat & { outreach_leads?: { picture_url?: string | null } | null }).outreach_leads?.picture_url);
  const toSummary = [...h.to, ...h.cc].map((p) => personLabel(p, myEmail)).join(', ') || 'undisclosed recipients';
  const subjectDiffers = !!h.subject && baseSubject(h.subject) !== baseSubject(threadSubject);
  const cc = replyAllCc(h, myEmail, contact);
  // AI replies v2: translate a received mail (one AI action, cached on the message)
  const translate = useComposeAssist();
  const [translation, setTranslation] = useState<{ text: string; language: string | null } | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const translatable = canReply && !mine && !deleted && !pending && !!m.text && !translation && !m.translation?.text;
  const doTranslate = () => {
    setMenu(false);
    setTranslateError(null);
    translate.mutate({ chatId: m.chat_id, kind: 'translate_in', messageId: m.id }, {
      onSuccess: (r) => setTranslation({ text: r.text, language: r.language }),
      onError: (e) => setTranslateError(parseError(e).message),
    });
  };
  const originBadge = mine && !pending && hasOriginBadge(m.origin);

  if (!open) {
    return (
      <button id={`msg-${m.id}`} type="button" onClick={onToggle} className={cn('w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-gray-50 transition-colors', highlight && 'bg-amber-50')}>
        <Avatar src={avatar} name={fromLabel} size={8} />
        <span className="w-40 flex-shrink-0 truncate text-sm font-semibold text-gray-900">{fromLabel}{mine && <span className="font-normal text-gray-500"> (you)</span>}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-gray-500">{deleted ? 'This message was deleted' : snippet || (atts.length ? `${atts.length} attachment${atts.length === 1 ? '' : 's'}` : '(no text)')}</span>
        {atts.length > 0 && <Paperclip className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" aria-label="Has attachments" />}
        <span className="flex-shrink-0 text-xs text-gray-500 whitespace-nowrap" title={new Date(m.sent_at).toLocaleString()}>{pending ? 'Sending…' : mailShortDate(m.sent_at, now)}</span>
      </button>
    );
  }

  return (
    <article id={`msg-${m.id}`} className={cn('px-5 pt-4 pb-5 transition-colors', highlight && 'bg-amber-50/60', pending && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <button type="button" onClick={onToggle} className="flex-shrink-0 rounded-full" aria-label="Collapse message"><Avatar src={avatar} name={fromLabel} size={10} /></button>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 flex items-baseline gap-1.5 cursor-pointer leading-6" onClick={onToggle} title={h.from?.email ? `${h.from?.name || fromLabel} <${h.from.email}>` : undefined}>
              <span className="truncate flex-shrink-0 max-w-full text-sm font-semibold text-gray-900">{h.from?.name || fromLabel}</span>
              {h.from?.email && <span className="min-w-0 truncate text-xs text-gray-500">&lt;{h.from.email}&gt;</span>}
            </div>
            <div className="flex items-center gap-0.5 flex-shrink-0 text-xs text-gray-500">
              {atts.length > 0 && <Paperclip className="w-3.5 h-3.5 mr-1 text-gray-400" aria-label="Has attachments" />}
              <span className="hidden lg:inline whitespace-nowrap" title={new Date(m.sent_at).toLocaleString()}>{pending ? 'Sending…' : mailDate(m.sent_at, now)}</span>
              <span className="lg:hidden whitespace-nowrap" title={new Date(m.sent_at).toLocaleString()}>{pending ? 'Sending…' : mailShortDate(m.sent_at, now)}</span>
              {canReply && !pending && <button type="button" onClick={() => onReply([])} className="ml-1 p-1.5 rounded-full hover:bg-gray-100 text-gray-600" title="Reply" aria-label="Reply"><Reply className="w-4 h-4" /></button>}
              {(translatable || (canReply && cc.length > 0)) && !pending && (
                <div className="relative">
                  <button type="button" onClick={() => setMenu((v) => !v)} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-600" title="More" aria-label="More actions"><MoreHorizontal className="w-4 h-4" /></button>
                  {menu && (
                    <>
                      <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
                      <div className="absolute right-0 z-30 mt-1 min-w-[180px] bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm" role="menu">
                        {canReply && cc.length > 0 && <button type="button" role="menuitem" onClick={() => { setMenu(false); onReply(cc); }} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-gray-700"><ReplyAll className="w-4 h-4 text-gray-400" /> Reply all</button>}
                        {translatable && <button type="button" role="menuitem" onClick={doTranslate} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-gray-700"><Languages className="w-4 h-4 text-gray-400" /> Translate (1 AI action)</button>}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          <button type="button" onClick={() => setDetails((v) => !v)} className="inline-flex items-center gap-0.5 text-xs text-gray-500 hover:text-gray-800 max-w-full" aria-expanded={details}>
            <span className="truncate">to {toSummary}</span><ChevronDown className={cn('w-3.5 h-3.5 flex-shrink-0 transition-transform', details && 'rotate-180')} />
          </button>
          {details && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs rounded-lg border border-gray-200 bg-white shadow-sm px-3 py-2.5 max-w-xl">
              <dt className="text-right text-gray-500">from:</dt><dd><PeopleList list={h.from ? [h.from] : []} myEmail={null} /></dd>
              {h.reply_to.length > 0 && <><dt className="text-right text-gray-500">reply-to:</dt><dd><PeopleList list={h.reply_to} myEmail={null} /></dd></>}
              <dt className="text-right text-gray-500">to:</dt><dd><PeopleList list={h.to} myEmail={null} /></dd>
              {h.cc.length > 0 && <><dt className="text-right text-gray-500">cc:</dt><dd><PeopleList list={h.cc} myEmail={null} /></dd></>}
              {h.bcc.length > 0 && <><dt className="text-right text-gray-500">bcc:</dt><dd><PeopleList list={h.bcc} myEmail={null} /></dd></>}
              <dt className="text-right text-gray-500">date:</dt><dd className="text-gray-900">{new Date(m.sent_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
              <dt className="text-right text-gray-500">subject:</dt><dd className="text-gray-900 break-words">{h.subject ?? '(no subject)'}</dd>
              {mine && sender?.display_name && <><dt className="text-right text-gray-500">mailbox:</dt><dd className="text-gray-900">{sender.display_name}</dd></>}
            </dl>
          )}
          {mine && (m.opens > 0 || m.clicks > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {m.opens > 0 && <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700" title="Times the mail was opened"><Eye className="w-3 h-3" /> Opened {m.opens === 1 ? 'once' : `${m.opens} times`}</span>}
              {m.clicks > 0 && <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700" title="Link clicks"><MousePointerClick className="w-3 h-3" /> {m.clicks} click{m.clicks === 1 ? '' : 's'}</span>}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 sm:pl-[52px] min-w-0">
        {subjectDiffers && <div className="text-sm font-medium text-gray-900 mb-2">{h.subject}</div>}
        {deleted ? (
          <span className="inline-flex items-center gap-1.5 italic text-sm text-gray-500"><Ban className="w-3.5 h-3.5" /> This message was deleted</span>
        ) : html ? (
          <>
            <div className="mail-body text-sm text-gray-900 leading-relaxed break-words [overflow-wrap:anywhere] overflow-x-auto [transform:translateZ(0)] [&_a]:text-sky-700 [&_a]:underline [&_p]:my-2 [&_img]:max-w-full [&_img]:h-auto [&_table]:max-w-full [&_blockquote]:border-l-2 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3 [&_blockquote]:text-gray-600" dangerouslySetInnerHTML={{ __html: html.main }} />
            {html.quoted && <QuotedToggle open={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />}
            {html.quoted && showQuoted && <div className="mt-2 text-sm text-gray-600 break-words overflow-x-auto [transform:translateZ(0)] [&_a]:text-sky-700 [&_a]:underline [&_img]:max-w-full [&_blockquote]:border-l-2 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3" dangerouslySetInnerHTML={{ __html: html.quoted }} />}
          </>
        ) : (
          <>
            <div className="text-sm text-gray-900 whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed"><Linkified text={plain?.main ?? ''} /></div>
            {plain?.quoted && <QuotedToggle open={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />}
            {plain?.quoted && showQuoted && <div className="mt-2 text-sm text-gray-600 whitespace-pre-wrap break-words border-l-2 border-gray-300 pl-3">{plain.quoted}</div>}
          </>
        )}
        {!deleted && atts.length > 0 && (
          <div className="mt-4 pt-3 border-t border-gray-100">
            <div className="text-xs text-gray-600 mb-2">{atts.length} attachment{atts.length === 1 ? '' : 's'}</div>
            <div className="flex flex-wrap gap-3">{atts.map((a, i) => <MailAttachment key={a.id ?? `a${i}`} messageId={m.id} att={a} />)}</div>
          </div>
        )}
        {!mine && !deleted && <Translation m={m} local={translation} dark={false} />}
        {translate.isPending && <div className="mt-2 text-[11px] text-gray-500 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Translating…</div>}
        {translateError && <div className="text-[11px] text-red-600 mt-1">{translateError}</div>}
        {!mine && m.summary && (
          <div className="flex items-start gap-1 text-xs text-gray-500 mt-3">
            <Sparkles className="w-3 h-3 mt-0.5 text-fuchsia-500 flex-shrink-0" /><span className="italic">{m.summary}</span>
          </div>
        )}
        {attribution && !pending && !(originBadge && (isAiOrigin(m.origin) || attribution.kind === 'manual')) && <div className="mt-2"><Attribution a={attribution} mine={mine} /></div>}
        {originBadge && <div className="mt-2"><AiOriginBadge origin={m.origin!} runId={m.ai_reply_run_id} sentByName={attribution?.sent_by_name} /></div>}
      </div>
    </article>
  );
}

/** Text of an HTML fragment (for the folded row's snippet). */
function htmlText(html: string): string {
  if (typeof window === 'undefined') return '';
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
}

function QuotedToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} className={cn('mt-2 inline-flex items-center justify-center w-8 h-4 rounded-sm text-gray-600 hover:bg-gray-300', open ? 'bg-gray-300' : 'bg-gray-200')} title={open ? 'Hide trimmed content' : 'Show trimmed content'} aria-label={open ? 'Hide trimmed content' : 'Show trimmed content'} aria-expanded={open}>
      <MoreHorizontal className="w-4 h-4" />
    </button>
  );
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;
function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="text-sky-700 underline break-all">{p}</a> : p))}</>;
}

function fileLook(name: string, type: string): { Icon: typeof FileIcon; tone: string; ext: string } {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const t = type.toLowerCase();
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) return { Icon: FileImage, tone: 'bg-rose-500', ext };
  if (t.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(ext)) return { Icon: FileVideo, tone: 'bg-violet-500', ext };
  if (ext === 'pdf' || t === 'application/pdf') return { Icon: FileText, tone: 'bg-red-600', ext: 'pdf' };
  if (['xls', 'xlsx', 'csv', 'numbers'].includes(ext) || t.includes('spreadsheet')) return { Icon: FileSpreadsheet, tone: 'bg-emerald-600', ext };
  if (['doc', 'docx', 'rtf', 'txt', 'pages', 'md'].includes(ext) || t.includes('word')) return { Icon: FileText, tone: 'bg-blue-600', ext };
  if (['ppt', 'pptx', 'key'].includes(ext) || t.includes('presentation')) return { Icon: FileText, tone: 'bg-orange-500', ext };
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return { Icon: FileArchive, tone: 'bg-gray-600', ext };
  return { Icon: FileIcon, tone: 'bg-gray-500', ext };
}

/** An attachment tile: a picture's thumbnail (loaded through the attachment proxy) or a file-type tile; a click downloads. */
function MailAttachment({ messageId, att }: { messageId: string; att: MessageAttachment }) {
  const name = att.name ?? 'attachment';
  const type = String(att.mimetype ?? att.type ?? '');
  const look = fileLook(name, type);
  const isImage = look.Icon === FileImage && !!att.id && !att.unavailable;
  const { url, loading, error, load } = useAttachmentUrl(messageId, att.id ?? '');
  useEffect(() => { if (isImage && !url && !loading && !error) void load(); }, [isImage, url, loading, error, load]);
  const unavailable = !att.id || att.unavailable;
  const download = async () => {
    if (unavailable) return;
    const u = url ?? (await load());
    if (u) triggerDownload(u, name);
  };
  return (
    <button type="button" onClick={download} disabled={unavailable || loading} title={unavailable ? `${name} is no longer available` : error ?? `Download ${name}`}
      className={cn('group/att relative w-44 rounded-lg border bg-white overflow-hidden text-left transition-shadow', error ? 'border-red-300' : 'border-gray-200 hover:shadow-md', unavailable && 'opacity-60 cursor-default')}>
      <div className="h-24 bg-gray-100 flex items-center justify-center overflow-hidden">
        {isImage && url ? <img src={url} alt={name} className="w-full h-full object-cover" />
          : isImage && loading ? <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
            : <span className={cn('w-10 h-12 rounded-md text-white flex flex-col items-center justify-center text-[9px] font-bold uppercase shadow-sm', look.tone)}><look.Icon className="w-4 h-4 mb-0.5" />{look.ext.slice(0, 4)}</span>}
      </div>
      <div className="px-2.5 py-1.5 flex items-center gap-2 border-t border-gray-100">
        <span className={cn('w-4 h-4 rounded-sm flex items-center justify-center text-white flex-shrink-0', look.tone)}><look.Icon className="w-2.5 h-2.5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-gray-800 truncate">{name}</span>
          <span className="block text-[10px] text-gray-500">{unavailable ? 'Not available' : att.size ? fmtBytes(att.size) : look.ext.toUpperCase() || 'File'}</span>
        </span>
        {!unavailable && (loading ? <Loader2 className="w-3.5 h-3.5 text-gray-400 animate-spin" /> : <Download className="w-3.5 h-3.5 text-gray-400 opacity-0 group-hover/att:opacity-100" />)}
      </div>
    </button>
  );
}
