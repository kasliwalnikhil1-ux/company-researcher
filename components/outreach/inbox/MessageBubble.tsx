'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { Paperclip, Loader2, Pencil, Trash2, Sparkles, Eye, MousePointerClick, Clock, Download, GitBranch, CornerDownRight, User, Mic, CheckCheck, Check, ExternalLink, Smile, Reply, Copy, Forward, Ban, Phone, PhoneMissed, Video, Users, Contact, Plus, Info, Languages, UserPlus, Mail, Timer, Linkedin, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Message, Provider } from '@/lib/outreach/types';
import type { ThreadAttributionRow } from '@/lib/outreach/intel';
import { parseError } from '@/lib/outreach/api';
import { useComposeAssist } from '@/lib/outreach/aiReplies';
import { Avatar, Badge, Button, fmtDate } from '@/components/outreach/ui';
import { editWindowRemainingMs, fmtRemaining, fmtBytes, sanitizeHtml, triggerDownload, useAttachmentUrl, type MessageAttachment } from './hooks';
import { channelLabel, fixMojibake, isMailProvider } from '@/lib/outreach/channels';
import AiOriginBadge, { hasOriginBadge, isAiOrigin } from './ai/AiOriginBadge';
import { languageName } from './ai/useAiInbox';
import ProductCards, { cardsOf } from '@/components/outreach/products/ProductCards';
import VoiceCallCard from './webchat/VoiceCallCard';
import { isCallCard } from '@/lib/outreach/voice';
import { clockTime, isEmojiOnly, msgSubjectOf, msgTypeOf, threadLook, type ThreadLook } from './channels/look';

export function isVoiceNote(att: MessageAttachment): boolean {
  const mime = att.mimetype ?? att.type ?? '';
  return !!att.voice_note || mime.startsWith('audio/');
}

/** Image / video / sticker / GIF shown inline (WhatsApp and Instagram send these as `img` / `video`, sent files carry a mimetype). */
function mediaKind(att: MessageAttachment): 'image' | 'video' | null {
  if (att.unavailable || !att.id || att.type === 'video_meeting' || att.type === 'linkedin_post') return null;
  const t = String(att.type ?? '').toLowerCase();
  const mime = String(att.mimetype ?? '').toLowerCase();
  if (t === 'img' || t === 'image' || t.startsWith('image/') || mime.startsWith('image/')) return 'image';
  if (t === 'video' || t.startsWith('video/') || mime.startsWith('video/')) return 'video';
  return null;
}

/** Edit / delete windows per channel (the connector rejects edits after these). */
const EDIT_WINDOW_MS: Partial<Record<Provider, number>> = { LINKEDIN: 60 * 60_000, WHATSAPP: 15 * 60_000 };
const DELETE_WINDOW_MS: Partial<Record<Provider, number>> = { LINKEDIN: 60 * 60_000, WHATSAPP: 2 * 24 * 60 * 60_000 };
const REACT_CHANNELS: Provider[] = ['WHATSAPP', 'INSTAGRAM', 'LINKEDIN'];
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** Connector system-event codes → what WhatsApp shows in the thread. */
const EVENT_LABELS: Record<number, string> = {
  3: 'Group created', 4: 'Group name changed', 5: 'Participant added', 6: 'Participant removed', 7: 'Participant left',
  8: 'Missed voice call', 9: 'Missed video call', 10: 'Incoming call', 11: 'Outgoing call', 12: 'Call ended', 13: 'Call answered',
};

/** A stable colour per group member, like WhatsApp's author names. */
const AUTHOR_COLORS = ['text-emerald-700', 'text-sky-700', 'text-violet-700', 'text-rose-700', 'text-amber-700', 'text-teal-700', 'text-fuchsia-700', 'text-indigo-700'];
export function authorColor(key: string | null | undefined): string {
  let h = 0;
  for (const ch of key ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length];
}

function fmtDuration(s: number | null | undefined): string | null {
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60); const r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** What a quoted message without text shows ("📷 Photo"). */
function attachmentLabel(type: string | null | undefined): string {
  const t = String(type ?? '').toLowerCase();
  if (t === 'img' || t.startsWith('image')) return '📷 Photo';
  if (t === 'video' || t.startsWith('video')) return '🎥 Video';
  if (t === 'audio' || t.startsWith('audio')) return '🎤 Voice message';
  if (t === 'contact_card') return '👤 Contact';
  return t ? '📎 File' : '';
}

// WhatsApp formatting (*bold* — also **bold**, _italic_, ~strike~, ```mono```, `code`) and clickable links. Markers only
// count at word edges, so snake_case names and 2*3*4 stay as typed.
const RICH_RE = /(```[\s\S]+?```)|(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])|(?<![\w*])(\*\*[^*\n]+?\*\*)(?![\w*])|(?<![\w*])(\*[^*\s](?:[^*\n]*?[^*\s])?\*)(?![\w*])|(?<![\w_])(_[^_\s](?:[^_\n]*?[^_\s])?_)(?![\w_])|(?<![\w~])(~[^~\s](?:[^~\n]*?[^~\s])?~)(?![\w~])|(`[^`\n]+`)/g;

function RichText({ text, format, dark, linkClass }: { text: string; format: boolean; dark: boolean; linkClass?: string }): React.ReactNode {
  const out: React.ReactNode[] = [];
  let last = 0, k = 0;
  for (const mt of text.matchAll(RICH_RE)) {
    const [whole, mono, url, bold2, bold, italic, strike, code] = mt;
    const at = mt.index ?? 0;
    if (!format && !url) continue;
    if (at > last) out.push(text.slice(last, at));
    const key = k++;
    if (url) out.push(<a key={key} href={url} target="_blank" rel="noopener noreferrer" className={cn('break-all', linkClass ?? cn('underline', dark ? 'text-white' : 'text-sky-700 hover:text-sky-800'))}>{url}</a>);
    else if (mono) out.push(<code key={key} className="font-mono text-[13px]">{mono.slice(3, -3)}</code>);
    else if (code) out.push(<code key={key} className={cn('font-mono text-[13px] rounded px-1', dark ? 'bg-white/15' : 'bg-black/[0.06]')}>{code.slice(1, -1)}</code>);
    else if (bold2) out.push(<strong key={key}><RichText text={bold2.slice(2, -2)} format={format} dark={dark} linkClass={linkClass} /></strong>);
    else if (bold) out.push(<strong key={key}><RichText text={bold.slice(1, -1)} format={format} dark={dark} linkClass={linkClass} /></strong>);
    else if (italic) out.push(<em key={key}><RichText text={italic.slice(1, -1)} format={format} dark={dark} linkClass={linkClass} /></em>);
    else if (strike) out.push(<s key={key}><RichText text={strike.slice(1, -1)} format={format} dark={dark} linkClass={linkClass} /></s>);
    else out.push(whole);
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Voice note (WhatsApp / Instagram): inline player fed by the attachment proxy, loaded on mount. */
function VoiceNote({ messageId, att, dark }: { messageId: string; att: MessageAttachment; dark: boolean }) {
  const { url, loading, error: loadError, load } = useAttachmentUrl(messageId, att.id ?? '');
  const error = att.id ? loadError : 'This voice note can no longer be played.';
  useEffect(() => { if (att.id && !url && !loading && !loadError) void load(); }, [att.id, url, loading, loadError, load]);
  const dur = fmtDuration(att.duration_s);
  return (
    <div className={cn('rounded-lg px-2 py-1.5 min-w-[220px] max-w-full', dark ? 'bg-white/15' : 'bg-black/[0.04]')}>
      <div className={cn('flex items-center gap-1.5 text-[11px] mb-1', dark ? 'text-white/80' : 'text-gray-500')}><Mic className="w-3 h-3" /> Voice note{dur ? ` · ${dur}` : ''}</div>
      {url ? <audio controls preload="metadata" src={url} className="w-full h-8" aria-label="Voice note" />
        : error ? <div className="text-[11px] text-red-600">{error}</div>
          : <div className={cn('inline-flex items-center gap-1 text-[11px]', dark ? 'text-white/80' : 'text-gray-500')}><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>}
    </div>
  );
}

/** Photo / video / sticker / GIF, loaded on mount through the attachment proxy. A click opens the full file. */
export function Media({ messageId, att, kind, variant }: { messageId: string; att: MessageAttachment; kind: 'image' | 'video'; /** story: a portrait story tile; bare: media drawn without a bubble (Instagram) */ variant?: 'story' | 'bare' }) {
  const { url, loading, error, load } = useAttachmentUrl(messageId, att.id ?? '');
  useEffect(() => { if (att.id && !url && !loading && !error) void load(); }, [att.id, url, loading, error, load]);
  const name = att.name ?? (kind === 'image' ? 'Photo' : 'Video');
  if (error) return <div className="text-[11px] text-red-600 px-1">Could not load {kind === 'image' ? 'photo' : 'video'}: {error}</div>;
  const story = variant === 'story';
  const radius = story ? 'rounded-xl' : variant === 'bare' ? 'rounded-2xl' : 'rounded-md';
  if (!url) return <div className={cn('flex items-center justify-center bg-black/5 text-gray-400', radius, story ? 'w-28 h-48' : att.sticker ? 'w-28 h-28' : 'w-60 h-40')}><Loader2 className="w-5 h-5 animate-spin" /></div>;
  if (kind === 'video') {
    return att.gif
      ? <video src={url} autoPlay loop muted playsInline className={cn('max-h-72 max-w-full', radius)} aria-label="GIF" />
      : story
        ? <video src={url} muted playsInline preload="metadata" onClick={(e) => { const v = e.currentTarget; if (v.paused) void v.play(); else v.pause(); }} className={cn('w-28 h-48 object-cover bg-black cursor-pointer', radius)} aria-label={name} />
        : <video src={url} controls preload="metadata" className={cn('max-h-72 max-w-full bg-black', radius)} aria-label={name} />;
  }
  return (
    <button type="button" onClick={() => window.open(url, '_blank', 'noopener')} className="block" title="Open full size">
      <img src={url} alt={name} className={cn(radius, story ? 'w-28 h-48 object-cover' : att.sticker ? 'w-32 h-32 object-contain' : 'max-h-72 max-w-full object-contain')} />
    </button>
  );
}

function ContactCard({ contact }: { contact: NonNullable<MessageAttachment['contact']> }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-black/[0.04] px-2.5 py-2 min-w-[200px]">
      <span className="w-8 h-8 rounded-full bg-gray-300 text-white flex items-center justify-center flex-shrink-0"><Contact className="w-4 h-4" /></span>
      <span className="min-w-0 text-sm">
        <span className="block font-medium truncate">{contact.name ?? 'Contact'}</span>
        {(contact.phones ?? []).map((p) => <span key={p} className="block text-xs text-gray-500">{p}</span>)}
      </span>
    </div>
  );
}

/** A shared Instagram post or reel: a link to it on Instagram (the file itself is only a preview image). */
function SharedPost({ link, dark, messageId, att }: { link: NonNullable<MessageAttachment['link']>; dark: boolean; messageId: string; att: MessageAttachment }) {
  const isReel = /\/reel\//.test(link.url);
  if (/linkedin\.com\//i.test(link.url)) return <LinkedInPostCard url={link.url} />;
  const preview = mediaKind(att);
  if (preview) {
    // Instagram's own share card: who posted it, the picture, the caption
    return (
      <div className="w-[240px] rounded-2xl border border-gray-200 bg-white overflow-hidden text-gray-900 text-left">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="w-6 h-6 rounded-full bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600 p-[1.5px]"><span className="block w-full h-full rounded-full bg-white" /></span>
          <span className="text-xs font-semibold truncate">{link.author ? link.author : (isReel ? 'Reel' : 'Post')}</span>
        </div>
        <div className="relative bg-gray-100 [&_img]:rounded-none [&_img]:w-full [&_img]:max-h-80 [&_img]:object-cover"><Media messageId={messageId} att={att} kind={preview} />{isReel && <Play className="absolute top-2 right-2 w-4 h-4 text-white drop-shadow" fill="currentColor" />}</div>
        {link.text && <p className="px-3 pt-2 text-xs line-clamp-2"><span className="font-semibold">{link.author ?? ''}</span> {fixMojibake(link.text)}</p>}
        <a href={link.url} target="_blank" rel="noopener noreferrer" className="block px-3 py-2 text-xs font-semibold text-[#0095f6] hover:text-[#00376b]">View {isReel ? 'reel' : 'post'}</a>
      </div>
    );
  }
  return (
    <a href={link.url} target="_blank" rel="noopener noreferrer" className={cn('flex items-start gap-2 rounded-lg px-2.5 py-2 max-w-[280px] text-xs no-underline', dark ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-gray-50 border border-gray-200 text-gray-700 hover:bg-gray-100')}>
      <ExternalLink className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block font-medium">Shared {isReel ? 'reel' : 'post'}{link.author ? ` from @${link.author}` : ''}</span>
        {link.text && <span className={cn('block line-clamp-2', dark ? 'text-white/80' : 'text-gray-500')}>{fixMojibake(link.text)}</span>}
        <span className={cn('block', dark ? 'text-white/70' : 'text-gray-400')}>Open on Instagram</span>
      </span>
    </a>
  );
}

/** A LinkedIn post shared in the conversation. */
function LinkedInPostCard({ url }: { url: string | null }) {
  const body = (
    <>
      <span className="w-9 h-9 rounded-md bg-[#0a66c2] text-white flex items-center justify-center flex-shrink-0"><Linkedin className="w-5 h-5" /></span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-gray-900">LinkedIn post</span>
        <span className="block text-xs text-gray-500">{url ? 'View the post on LinkedIn' : 'Open LinkedIn to see the post'}</span>
      </span>
    </>
  );
  const cls = 'flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-3 py-2.5 w-[280px] max-w-full no-underline text-left';
  return url ? <a href={url} target="_blank" rel="noopener noreferrer" className={cn(cls, 'hover:bg-gray-50')}>{body}</a> : <div className={cls}>{body}</div>;
}

/** A LinkedIn video meeting invite: when, and a join button while it is open. */
function MeetingCard({ meeting }: { meeting: NonNullable<MessageAttachment['meeting']> }) {
  const [openedAt] = useState(() => Date.now());
  const start = meeting.starts_at ? new Date(meeting.starts_at) : null;
  const end = meeting.expires_at ? new Date(meeting.expires_at) : null;
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const when = start && !Number.isNaN(start.getTime())
    ? `${start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${t(start)}${end && !Number.isNaN(end.getTime()) ? ` – ${t(end)}` : ''}`
    : meeting.time_range ?? 'Time not shared';
  const over = end ? end.getTime() < openedAt : false;
  return (
    <div className="rounded-lg border border-gray-200 bg-white w-[280px] max-w-full overflow-hidden text-left">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="w-9 h-9 rounded-md bg-[#0a66c2]/10 text-[#0a66c2] flex items-center justify-center flex-shrink-0"><Video className="w-5 h-5" /></span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-gray-900">Video meeting</span>
          <span className="block text-xs text-gray-500">{when}</span>
        </span>
      </div>
      {meeting.url && !over
        ? <a href={meeting.url} target="_blank" rel="noopener noreferrer" className="block text-center text-sm font-semibold text-[#0a66c2] border-t border-gray-200 py-1.5 hover:bg-[#0a66c2]/5">Join meeting</a>
        : <div className="text-center text-xs text-gray-500 border-t border-gray-200 py-1.5">{over ? 'This meeting has ended' : 'Join from LinkedIn'}</div>}
    </div>
  );
}

function AttachmentChip({ messageId, att, dark }: { messageId: string; att: MessageAttachment; dark: boolean }) {
  if (att.meeting || att.type === 'video_meeting') return <MeetingCard meeting={att.meeting ?? {}} />;
  if (att.type === 'linkedin_post' && !att.link?.url) return <LinkedInPostCard url={null} />;
  if (att.link?.url) return <SharedPost link={att.link} dark={dark} messageId={messageId} att={att} />;
  if (att.contact) return <ContactCard contact={att.contact} />;
  if (!att.id || att.unavailable) {
    // stored before attachment ids were read, or no longer served by the provider: say so instead of failing
    return <span className={cn('inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border', dark ? 'bg-white/15 border-white/30 text-white/80' : 'bg-white border-gray-200 text-gray-500')}><Paperclip className="w-3 h-3" /> {att.name ?? 'Attachment'} (not available)</span>;
  }
  return <DownloadChip messageId={messageId} att={att} attachmentId={att.id} dark={dark} />;
}

function DownloadChip({ messageId, att, attachmentId, dark }: { messageId: string; att: MessageAttachment; attachmentId: string; dark: boolean }) {
  const { url, loading, error, load } = useAttachmentUrl(messageId, attachmentId);
  const name = att.name ?? attachmentId.split('/').pop() ?? 'attachment';
  const onClick = async () => {
    const u = url ?? (await load());
    if (u) triggerDownload(u, name);
  };
  return (
    <div className="max-w-full">
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        title={error ?? `Download ${name}`}
        className={cn('inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border max-w-full', dark ? 'bg-white/15 border-white/30 text-white hover:bg-white/25' : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50', error && 'border-red-300')}
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : url ? <Download className="w-3 h-3" /> : <Paperclip className="w-3 h-3" />}
        <span className="truncate max-w-[180px]">{name}</span>
        {att.size ? <span className={dark ? 'text-white/70' : 'text-gray-400'}>{fmtBytes(att.size)}</span> : null}
      </button>
      {error && <div className="text-[11px] text-red-600 mt-0.5">{error}</div>}
    </div>
  );
}

export interface MessageBubbleProps {
  m: Message;
  provider: Provider;
  now: number;
  /** Item 4: which sequence, step and sender produced this message (from outreach_thread_attribution). */
  attribution?: ThreadAttributionRow;
  canEdit: boolean;          // permission-level gate (canReply, sender ok, etc.)
  onEdit: (id: string, text: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** WhatsApp group: every inbound bubble names its author. */
  isGroup?: boolean;
  /** The message this one quotes, when it is in the loaded thread (jump target + author). */
  quotedLocal?: Message | null;
  /** Name shown for the other side of a 1:1 chat when a quote has no author name. */
  contactName?: string;
  highlight?: boolean;
  onReply?: (m: Message) => void;
  onReact?: (m: Message, emoji: string) => Promise<void>;
  onForward?: (m: Message) => void;
  onJumpTo?: (messageId: string) => void;
  /** How the thread is drawn (defaults to the channel's look). */
  look?: ThreadLook;
  /** First / last message of a run by the same side (Instagram corners and avatar, LinkedIn author header). */
  groupStart?: boolean;
  groupEnd?: boolean;
  /** Who wrote it, for the LinkedIn row header and the Instagram avatar. */
  author?: { name: string; avatar?: string | null };
  /** The last message the contact has seen: LinkedIn shows their small picture under it, Instagram says "Seen". */
  seen?: { name: string; avatar?: string | null; at: string | null } | null;
}

function stepHref(a: ThreadAttributionRow): string {
  return `/outreach/sequences/${a.sequence_id}${a.node_id ? `?node=${encodeURIComponent(a.node_id)}` : ''}`;
}

function stepName(a: ThreadAttributionRow): string {
  const n = a.step_number != null ? `Step ${a.step_number}` : 'Step';
  return a.step_label ? `${n}: ${a.step_label}` : n;
}

export function Attribution({ a, mine }: { a: ThreadAttributionRow; mine: boolean }) {
  const cls = 'flex items-center gap-1 mt-1 text-[11px] text-gray-500 max-w-full flex-wrap';
  if (a.kind === 'automated') {
    return (
      <div className={cls}>
        <GitBranch className="w-3 h-3 text-indigo-400 flex-shrink-0" aria-hidden />
        {a.sequence_id
          ? <Link href={stepHref(a)} className="hover:text-indigo-600 hover:underline">{a.sequence_name ?? 'Sequence'} · {stepName(a)}</Link>
          : <span>Automated · {stepName(a)}</span>}
        {a.variant_label || a.variant_id ? <span className="px-1.5 py-px rounded bg-purple-50 text-purple-700">{a.variant_label ?? `Variant ${a.variant_id}`}</span> : null}
        {a.sender_name && <span>· via {a.sender_name}</span>}
      </div>
    );
  }
  if (a.kind === 'manual' && mine) {
    return <div className={cls}><User className="w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden /><span>{a.sent_by_name ? `Sent by ${a.sent_by_name}` : 'Sent by hand'}</span></div>;
  }
  if (a.kind === 'inbound' && a.sequence_id && (a.replying_to_message_id || a.node_id)) {
    return (
      <div className={cls}>
        <CornerDownRight className="w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden />
        <Link href={stepHref(a)} className="hover:text-indigo-600 hover:underline" title={[a.sequence_name, a.step_label].filter(Boolean).join(' · ') || undefined}>Replying to {a.step_number != null ? `Step ${a.step_number}` : (a.step_label ?? 'a sequence step')}</Link>
      </div>
    );
  }
  return null;
}

/** System event (call, group change): a centred pill, like WhatsApp. */
function EventPill({ m }: { m: Message }) {
  const code = m.event_type ?? 0;
  const label = fixMojibake(m.text)?.trim() || EVENT_LABELS[code] || 'Event';
  const Icon = code === 8 ? PhoneMissed : code === 9 ? Video : code >= 10 ? Phone : Users;
  return (
    <div className="flex justify-center" id={`msg-${m.id}`}>
      <span className={cn('inline-flex items-center gap-1.5 text-xs rounded-lg px-3 py-1 shadow-sm', code === 8 || code === 9 ? 'bg-red-50 text-red-700' : 'bg-white/90 text-gray-600')} title={new Date(m.sent_at).toLocaleString()}>
        <Icon className="w-3.5 h-3.5" /> {label}{m.sender_name && code >= 3 && code <= 7 ? ` · ${m.sender_name}` : ''} · {clockTime(m.sent_at)}
      </span>
    </div>
  );
}

/** Reply preview inside the bubble; a click jumps to the quoted message when it is loaded. */
function QuoteBlock({ m, quotedLocal, contactName, dark, onJumpTo }: { m: Message; quotedLocal?: Message | null; contactName?: string; dark: boolean; onJumpTo?: (id: string) => void }) {
  const q = m.quoted;
  if (!q) return null;
  const author = quotedLocal
    ? (quotedLocal.direction === 'out' ? 'You' : (quotedLocal.sender_name || contactName || 'Them'))
    : (q.sender_name || contactName || 'Message');
  const firstAtt = quotedLocal?.attachments?.[0];
  const text = fixMojibake(quotedLocal?.text ?? q.text)?.trim() || attachmentLabel(firstAtt?.type ?? q.attachment_type) || 'Message';
  const jump = quotedLocal && onJumpTo ? () => onJumpTo(quotedLocal.id) : undefined;
  return (
    <button type="button" onClick={jump} disabled={!jump} className={cn('block w-full text-left rounded-md border-l-4 px-2 py-1 mb-1 min-w-[160px] disabled:cursor-default', dark ? 'bg-white/15 border-white/60' : 'bg-black/[0.05] border-emerald-500', jump && 'hover:bg-black/[0.08]')}>
      <span className={cn('block text-xs font-semibold truncate', dark ? 'text-white' : author === 'You' ? 'text-emerald-700' : authorColor(quotedLocal?.sender_identifier ?? q.sender_id ?? author))}>{author}</span>
      <span className={cn('block text-xs line-clamp-2 whitespace-pre-wrap', dark ? 'text-white/80' : 'text-gray-600')}>{text}</span>
    </button>
  );
}

/**
 * AI replies v2: the translation of a received message (compose_assist translate_in, cached on `messages.translation`).
 * Shown under the bubble; "Show original" collapses it (the original text always stays in the bubble).
 */
export function Translation({ m, local, dark }: { m: Message; local: { text: string; language: string | null } | null; dark: boolean }) {
  const t = local ?? (m.translation?.text ? { text: m.translation.text, language: m.translation.lang } : null);
  const [hidden, setHidden] = useState(false);
  if (!t) return null;
  return (
    <div className={cn('mt-1.5 border-l-2 pl-2', dark ? 'border-white/40' : 'border-sky-300')}>
      <div className={cn('flex items-center gap-2 text-[11px]', dark ? 'text-white/75' : 'text-gray-500')}>
        <span className="inline-flex items-center gap-1"><Languages className="w-3 h-3" /> {hidden ? 'Translation hidden' : `Translated to ${languageName(t.language)}`}</span>
        <button type="button" onClick={() => setHidden((h) => !h)} className="hover:underline">{hidden ? 'Show translation' : 'Show original'}</button>
      </div>
      {!hidden && <div className={cn('text-sm whitespace-pre-wrap break-words mt-0.5', dark ? 'text-white' : 'text-gray-800')}>{t.text}</div>}
    </div>
  );
}

function Ticks({ m, pending }: { m: Message; pending: boolean }) {
  if (pending) return <Clock className="w-3 h-3" aria-label="Sending" />;
  if (m.read_at) return <CheckCheck className="w-3.5 h-3.5 text-sky-500" aria-label={`Read ${fmtDate(m.read_at)}`} />;
  if (m.delivered_at) return <CheckCheck className="w-3.5 h-3.5" aria-label="Delivered" />;
  return <Check className="w-3.5 h-3.5" aria-label="Sent" />;
}

/** Instagram story labels, from the side that sent the message. */
function storyLabel(type: string | null, mine: boolean): string | null {
  if (type === 'STORY_REPLY') return mine ? 'You replied to their story' : 'Replied to your story';
  if (type === 'STORY_MENTION') return mine ? 'You mentioned them in your story' : 'Mentioned you in their story';
  return null;
}

/** LinkedIn InMail answers that come without text: a system line, like LinkedIn shows them. */
const INMAIL_EVENTS: Record<string, { mine: string; theirs: string }> = {
  INMAIL_ACCEPT: { mine: 'You accepted the InMail', theirs: 'accepted your InMail' },
  INMAIL_DECLINE: { mine: 'You declined the InMail', theirs: 'declined your InMail' },
};

export default function MessageBubble({ m, provider, now, canEdit, onEdit, onDelete, attribution, isGroup, quotedLocal, contactName, highlight, onReply, onReact, onForward, onJumpTo, look: lookProp, groupStart = true, groupEnd = true, author, seen }: MessageBubbleProps) {
  const mine = m.direction === 'out';
  const deleted = !!m.deleted_at;
  const pending = m.id.startsWith('temp-');
  const look = lookProp ?? threadLook(provider);
  const wa = look === 'whatsapp';
  const ig = look === 'instagram';
  const li = look === 'linkedin';
  const dark = mine && (look === 'chat' || ig);   // white text on the indigo (chat) or blue (Instagram) bubble
  const msgType = msgTypeOf(m);
  const subject = li ? msgSubjectOf(m) : null;
  const story = ig ? storyLabel(msgType, mine) : null;
  const editWindow = EDIT_WINDOW_MS[provider];
  const deleteWindow = DELETE_WINDOW_MS[provider];
  const age = now - new Date(m.sent_at).getTime();
  const editRemaining = mine && editWindow && !deleted && !pending && m.unipile_message_id ? (provider === 'LINKEDIN' ? editWindowRemainingMs(m.sent_at, now) : editWindow - age) : -1;
  const editable = canEdit && editRemaining > 0 && !!m.text;
  const deletable = canEdit && mine && !!deleteWindow && !deleted && !pending && !!m.unipile_message_id && age < deleteWindow;
  const replyable = canEdit && wa && !deleted && !pending && !!m.unipile_message_id && !!onReply;
  const reactable = canEdit && REACT_CHANNELS.includes(provider) && !deleted && !pending && !!m.unipile_message_id && !!onReact;
  const forwardable = canEdit && wa && !deleted && !pending && !!m.unipile_message_id && !!onForward;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text ?? '');
  const [busy, setBusy] = useState<'edit' | 'delete' | 'react' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [picker, setPicker] = useState(false);
  const [copied, setCopied] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  // AI replies v2: Translate a received message (cached on the message afterwards)
  const translate = useComposeAssist();
  const [translation, setTranslation] = useState<{ text: string; language: string | null } | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const translatable = canEdit && !mine && !deleted && !pending && !!(m.text || m.transcript) && !translation && !m.translation?.text;
  const isEmail = isMailProvider(provider);
  const safeHtml = useMemo(() => (isEmail && m.html && !m.text ? sanitizeHtml(m.html) : ''), [isEmail, m.html, m.text]);
  const atts = useMemo(() => (m.attachments ?? []) as MessageAttachment[], [m.attachments]);
  // product cards are only ever drawn on what the assistant or an agent sent, never on a visitor's message
  const products = useMemo(() => (m.direction === 'out' ? cardsOf(m.content_attributes) : []), [m.direction, m.content_attributes]);
  const voiceNotes = useMemo(() => atts.filter((a) => isVoiceNote(a)), [atts]);
  // shared posts carry a preview picture: they get their own card, not a bare photo
  const media = useMemo(() => atts.filter((a) => !isVoiceNote(a) && mediaKind(a) && !a.link?.url), [atts]);
  const otherAttachments = useMemo(() => atts.filter((a) => !isVoiceNote(a) && (!mediaKind(a) || !!a.link?.url)), [atts]);
  const onlySticker = media.length === 1 && !!media[0].sticker && !m.text && !m.quoted;
  // Instagram draws a story (reply / mention) as a portrait tile above the bubble, and a lone photo without a bubble
  const storyMedia = story ? media : [];
  const bubbleMedia = story ? [] : media;
  const onlyMedia = ig && bubbleMedia.length > 0 && !m.text && !m.quoted && !otherAttachments.length && !voiceNotes.length;
  const bigEmoji = (wa || ig) && !deleted && !editing && !m.quoted && !atts.length && isEmojiOnly(m.text);
  const bare = onlySticker || onlyMedia || bigEmoji || (!!story && !m.text && !otherAttachments.length && !voiceNotes.length);
  const reactionGroups = useMemo(() => {
    const reactions = Array.isArray(m.reactions) ? m.reactions.filter((r) => r && typeof r.emoji === 'string' && r.emoji) : [];
    const g = new Map<string, { emoji: string; names: string[]; mine: boolean }>();
    for (const r of reactions) {
      const e = g.get(r.emoji) ?? { emoji: r.emoji, names: [], mine: false };
      e.names.push(r.mine ? 'You' : (r.by && r.by !== 'them' ? r.by : 'Them'));
      e.mine = e.mine || !!r.mine || r.by === 'us';
      g.set(r.emoji, e);
    }
    return [...g.values()];
  }, [m.reactions]);
  const transcriptPending = voiceNotes.length > 0 && m.transcript_status === 'pending';
  const transcriptFailed = voiceNotes.length > 0 && m.transcript_status === 'failed';

  useEffect(() => {
    if (!picker) return;
    const close = (e: MouseEvent) => { if (!pickerRef.current?.contains(e.target as Node)) setPicker(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [picker]);

  if (m.event_type != null) return <EventPill m={m} />;
  // a voice call with the website agent (069): its card, where the call started
  if (m.content_type === 'event' && isCallCard(m.content_attributes)) return <VoiceCallCard a={m.content_attributes} id={m.id} />;
  // LinkedIn: "accepted / declined your InMail" without text is a system line
  if (li && msgType && INMAIL_EVENTS[msgType] && !m.text?.trim() && !atts.length) {
    const ev = INMAIL_EVENTS[msgType];
    return (
      <div className="flex justify-center py-1" id={`msg-${m.id}`}>
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500" title={new Date(m.sent_at).toLocaleString()}><Mail className="w-3.5 h-3.5" /> {mine ? ev.mine : `${author?.name ?? contactName ?? 'They'} ${ev.theirs}`} · {clockTime(m.sent_at)}</span>
      </div>
    );
  }

  const save = async () => {
    if (!draft.trim() || draft === m.text) { setEditing(false); return; }
    setBusy('edit');
    try { await onEdit(m.id, draft.trim()); setEditing(false); } finally { setBusy(null); }
  };
  const remove = async () => {
    setBusy('delete');
    try { await onDelete(m.id); setConfirmDelete(false); } finally { setBusy(null); }
  };
  const react = async (emoji: string) => {
    if (!onReact) return;
    setPicker(false);
    setBusy('react');
    try { await onReact(m, emoji); } finally { setBusy(null); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(fixMojibake(m.text) ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard blocked */ }
  };
  const doTranslate = () => {
    setTranslateError(null);
    translate.mutate({ chatId: m.chat_id, kind: 'translate_in', messageId: m.id }, {
      onSuccess: (r) => setTranslation({ text: r.text, language: r.language }),
      onError: (e) => setTranslateError(parseError(e).message),
    });
  };

  const showAuthor = isGroup && !mine && (m.sender_name || m.sender_identifier) && !li;
  const hideDeletedText = deleted && provider !== 'LINKEDIN';
  const actionBtn = 'p-1 rounded-full text-gray-500 hover:text-gray-800 hover:bg-white shadow-sm bg-white/80 border border-gray-200';
  const originBadge = mine && !pending && hasOriginBadge(m.origin);
  const hasActions = !editing && (reactable || replyable || forwardable || editable || deletable || translatable || (!!m.text && !deleted));
  const fullTime = new Date(m.sent_at).toLocaleString();

  const toolbar = hasActions ? (
    <div className={cn('relative flex items-center gap-0.5 self-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity', picker && 'opacity-100')}>
      {reactable && (
        <div className="relative" ref={pickerRef}>
          <button type="button" className={actionBtn} onClick={() => setPicker((v) => !v)} title="React" aria-label="React" disabled={busy === 'react'}>{busy === 'react' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Smile className="w-3.5 h-3.5" />}</button>
          {picker && (
            <div className={cn('absolute z-20 bottom-full mb-1 flex items-center gap-0.5 rounded-full bg-white shadow-lg border border-gray-200 px-1.5 py-1', mine && !li ? 'right-0' : li ? 'right-0' : 'left-0')} role="menu">
              {QUICK_REACTIONS.map((e) => <button key={e} type="button" role="menuitem" onClick={() => react(e)} className="text-lg leading-none px-1 py-0.5 rounded-full hover:bg-gray-100 hover:scale-125 transition-transform" aria-label={`React ${e}`}>{e}</button>)}
              <button type="button" role="menuitem" onClick={() => { const e = window.prompt('React with any emoji'); if (e?.trim()) void react(e.trim()); }} className="p-1 rounded-full hover:bg-gray-100 text-gray-500" aria-label="Other emoji"><Plus className="w-4 h-4" /></button>
            </div>
          )}
        </div>
      )}
      {replyable && <button type="button" className={actionBtn} onClick={() => onReply!(m)} title="Reply" aria-label="Reply"><Reply className="w-3.5 h-3.5" /></button>}
      {forwardable && <button type="button" className={actionBtn} onClick={() => onForward!(m)} title="Forward" aria-label="Forward"><Forward className="w-3.5 h-3.5" /></button>}
      {!!m.text && !deleted && <button type="button" className={actionBtn} onClick={copy} title={copied ? 'Copied' : 'Copy text'} aria-label="Copy text">{copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}</button>}
      {translatable && <button type="button" className={actionBtn} onClick={doTranslate} disabled={translate.isPending} title="Translate this message (1 AI action)" aria-label="Translate message">{translate.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Languages className="w-3.5 h-3.5" />}</button>}
      {editable && <button type="button" className={actionBtn} onClick={() => { setDraft(m.text ?? ''); setEditing(true); }} title={`Edit (${fmtRemaining(editRemaining)})`} aria-label="Edit message"><Pencil className="w-3.5 h-3.5" /></button>}
      {deletable && <button type="button" className={cn(actionBtn, 'hover:text-red-600')} onClick={() => setConfirmDelete(true)} title="Delete for everyone" aria-label="Delete message"><Trash2 className="w-3.5 h-3.5" /></button>}
    </div>
  ) : null;

  // ------------------------------------------------------------------ what the message says (shared by every look)
  const linkTone = li ? 'text-[#0a66c2] hover:underline' : undefined;
  const content = (
    <>
      {showAuthor && (
        <div className="flex items-baseline gap-2 mb-0.5 min-w-0">
          <span className={cn('text-xs font-semibold truncate', authorColor(m.sender_identifier ?? m.sender_name))}>{m.sender_name ?? m.sender_identifier}</span>
          {m.sender_name && m.sender_identifier && <span className="text-[11px] text-gray-400 truncate">{m.sender_identifier}</span>}
        </div>
      )}
      {m.is_forwarded && !deleted && <div className={cn('flex items-center gap-1 text-[11px] italic mb-0.5', dark ? 'text-white/75' : 'text-gray-500')}><Forward className="w-3 h-3" /> Forwarded</div>}
      {m.is_invite_note && (li
        ? <div className="flex items-center gap-1 text-xs text-gray-500 mb-0.5"><UserPlus className="w-3.5 h-3.5" /> Sent with the connection request</div>
        : <div className="mb-1"><Badge tone={mine ? 'indigo' : 'blue'} className={dark ? 'bg-white/20 text-white' : ''}>Invitation note</Badge></div>)}
      {subject && !deleted && <div className="font-semibold text-gray-900 mb-1">{subject}</div>}
      {m.content_attributes?.view_once && !deleted && <div className={cn('inline-flex items-center gap-1 text-xs mb-1', dark ? 'text-white/80' : 'text-gray-500')}><Timer className="w-3.5 h-3.5" /> View once{!media.length ? `: open ${channelLabel(provider)} to see it` : ''}</div>}
      {!hideDeletedText && <QuoteBlock m={m} quotedLocal={quotedLocal} contactName={contactName} dark={dark} onJumpTo={onJumpTo} />}
      {!hideDeletedText && bubbleMedia.length > 0 && (
        <div className={cn('flex flex-col gap-1', (m.text || voiceNotes.length || otherAttachments.length) ? 'mb-1' : '')}>
          {bubbleMedia.map((a, i) => <Media key={a.id ?? `m${i}`} messageId={m.id} att={a} kind={mediaKind(a)!} variant={onlyMedia ? 'bare' : undefined} />)}
        </div>
      )}
      {hideDeletedText ? (
        <span className="inline-flex items-center gap-1 italic text-gray-500" title={m.text ? `Deleted: ${fixMojibake(m.text)}` : undefined}><Ban className="w-3.5 h-3.5" /> {mine ? 'You deleted this message' : 'This message was deleted'}</span>
      ) : isEmail && m.html && !m.text ? (
        <div className="max-w-none [&_a]:underline [&_p]:my-1 [&_img]:max-w-full overflow-x-auto" dangerouslySetInnerHTML={{ __html: safeHtml }} />
      ) : editing ? (
        <div className="min-w-[240px]">
          <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(10, Math.max(2, draft.split('\n').length))} className="w-full text-sm text-gray-900 rounded-md border border-gray-300 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-400" aria-label="Edit message" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }} />
          <div className="flex justify-end gap-1.5 mt-1">
            <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setDraft(m.text ?? ''); }}>Cancel</Button>
            <Button size="sm" variant="secondary" loading={busy === 'edit'} onClick={save}>Save</Button>
          </div>
        </div>
      ) : bigEmoji ? (
        <span className="text-4xl leading-tight">{m.text?.trim()}</span>
      ) : (
        <span className={cn(deleted && 'line-through')}>{m.text ? <RichText text={fixMojibake(m.text) ?? ''} format={wa} dark={dark} linkClass={linkTone} /> : atts.length || products.length ? '' : m.unsupported
          ? <span className={cn('inline-flex items-center gap-1.5 italic', dark ? 'text-white/80' : 'text-gray-500')}><Info className="w-3.5 h-3.5 shrink-0" /> This message can&apos;t be shown here. Open {channelLabel(provider)} to see it.</span>
          : story ? '' : <em className="opacity-70">(empty message)</em>}</span>
      )}
      {/* web chat: the product cards the assistant recommended or an agent sent, as the visitor sees them */}
      {!hideDeletedText && products.length > 0 && <ProductCards cards={products} className={m.text ? 'mt-2' : ''} />}
      {!hideDeletedText && voiceNotes.length > 0 && (
        <div className={cn('space-y-1.5', m.text ? 'mt-2' : '')}>
          {voiceNotes.map((a, i) => <VoiceNote key={a.id ?? `v${i}`} messageId={m.id} att={a} dark={dark} />)}
          {m.transcript
            ? <div className={cn('text-xs italic border-l-2 pl-2', dark ? 'text-white/85 border-white/40' : 'text-gray-600 border-gray-300')}>{m.transcript}</div>
            : transcriptPending ? <div className={cn('text-[11px] inline-flex items-center gap-1', dark ? 'text-white/70' : 'text-gray-400')}><Loader2 className="w-3 h-3 animate-spin" /> Transcribing…</div>
              : transcriptFailed ? <div className={cn('text-[11px]', dark ? 'text-white/70' : 'text-gray-400')}>Could not transcribe this voice note.</div> : null}
        </div>
      )}
      {!hideDeletedText && otherAttachments.length > 0 && (
        <div className={cn('flex flex-wrap gap-1.5', (m.text || bubbleMedia.length) && 'mt-2')}>
          {otherAttachments.map((a, i) => <AttachmentChip key={a.id ?? `a${i}`} messageId={m.id} att={a} dark={dark} />)}
        </div>
      )}
      {!mine && !deleted && <Translation m={m} local={translation} dark={dark} />}
      {translateError && <div className="text-[11px] text-red-600 mt-1">{translateError}</div>}
    </>
  );

  // ------------------------------------------------------------------ under the message (shared)
  const reactions = reactionGroups.length > 0 && (
    <div className={cn('flex flex-wrap gap-1 relative z-[1]', li ? 'mt-1' : '-mt-1.5', !li && (mine ? 'justify-end mr-2' : ig ? 'ml-11' : 'ml-2'))} aria-label="Reactions">
      {reactionGroups.map((g) => (
        <button key={g.emoji} type="button" disabled={!reactable || g.mine} onClick={() => react(g.emoji)} className={cn('inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-xs disabled:cursor-default', ig ? 'bg-gray-100 border-white border-2 py-0' : 'bg-white shadow-sm', !ig && (g.mine ? (li ? 'border-[#0a66c2]/40 bg-[#0a66c2]/5' : 'border-emerald-300 bg-emerald-50') : 'border-gray-200 hover:bg-gray-50'))} title={g.names.join(', ')}>
          {g.emoji}{g.names.length > 1 && <span className="text-[10px] text-gray-500">{g.names.length}</span>}
        </button>
      ))}
    </div>
  );
  const extras = (
    <>
      {/* a turn of a voice call: spoken, and "live transcript" until the provider's signed copy replaces it */}
      {m.content_attributes?.voice && m.content_type === 'text' && (
        <div className={cn('flex items-center gap-1 text-[10px] text-gray-400 mt-0.5', mine ? 'justify-end mr-1' : 'ml-1')}><Mic className="w-2.5 h-2.5" />{m.content_attributes.voice.live ? 'Spoken · live transcript' : 'Spoken'}</div>
      )}
      {confirmDelete && (
        <div className="flex items-center gap-2 mt-1 text-[11px]">
          <span className="text-red-600">Delete for everyone?</span>
          <button type="button" onClick={remove} disabled={busy === 'delete'} className="text-red-600 font-medium hover:underline">{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>
          <button type="button" onClick={() => setConfirmDelete(false)} className="text-gray-500 hover:underline">Cancel</button>
        </div>
      )}
      {!mine && m.summary && (
        <div className="flex items-start gap-1 text-xs text-gray-500 mt-1 max-w-full">
          <Sparkles className="w-3 h-3 mt-0.5 text-fuchsia-500 flex-shrink-0" />
          <span className="italic">{m.summary}</span>
        </div>
      )}
      {/* AI replies: the origin badge replaces the "Sent by" line (it names the teammate itself) */}
      {attribution && !pending && !(originBadge && (isAiOrigin(m.origin) || attribution.kind === 'manual')) && <Attribution a={attribution} mine={mine && !li} />}
      {originBadge && <AiOriginBadge origin={m.origin!} runId={m.ai_reply_run_id} sentByName={attribution?.sent_by_name} />}
    </>
  );
  const editClock = editable && <span className="inline-flex items-center gap-0.5 text-amber-600" title="Edit/delete window"><Clock className="w-3 h-3" />{fmtRemaining(editRemaining)}</span>;

  // ------------------------------------------------------------------ LinkedIn: author rows, no bubbles
  if (li) {
    const inmail = msgType === 'INMAIL' || msgType === 'INMAIL_REPLY';
    return (
      <div id={`msg-${m.id}`} className={cn('group relative flex gap-3 rounded-lg px-2 -mx-2 hover:bg-gray-50/80 transition-colors', groupStart ? 'pt-2.5 pb-0.5' : 'py-0.5', highlight && 'ring-2 ring-amber-400 bg-amber-50/60')}>
        <div className="w-10 flex-shrink-0">
          {groupStart
            ? <Avatar src={author?.avatar} name={author?.name ?? (mine ? 'You' : contactName)} size={10} />
            : <span className="block text-right text-[10px] leading-5 text-gray-400 opacity-0 group-hover:opacity-100 tabular-nums" title={fullTime}>{clockTime(m.sent_at)}</span>}
        </div>
        <div className="min-w-0 flex-1">
          {groupStart && (
            <div className="flex items-baseline gap-1.5 flex-wrap min-w-0">
              <span className="text-sm font-semibold text-gray-900 truncate">{author?.name ?? (mine ? 'You' : (m.sender_name ?? contactName ?? 'LinkedIn member'))}</span>
              <span className="text-xs text-gray-500 tabular-nums" title={fullTime}>· {pending ? 'Sending…' : clockTime(m.sent_at)}</span>
              {inmail && <span className="self-center text-[10px] font-semibold px-1.5 py-px rounded bg-[#f3e9d2] text-[#915907]">InMail</span>}
              {msgType === 'INVITATION' && <span className="self-center text-[10px] font-semibold px-1.5 py-px rounded bg-[#0a66c2]/10 text-[#0a66c2]">Invitation</span>}
            </div>
          )}
          <div className={cn('text-sm text-gray-900 leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]', deleted && 'opacity-70', pending && 'opacity-60')}>{content}</div>
          {reactions}
          {extras}
          {(m.edited_at || editable || deleted) && (
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-gray-400">
              {m.edited_at && !deleted && <span>Edited</span>}
              {deleted && <span>Deleted</span>}
              {editClock}
            </div>
          )}
          {seen && (
            <div className="flex justify-end items-center gap-1 mt-1" title={`Seen by ${seen.name}${seen.at ? ` · ${fmtDate(seen.at)}` : ''}`}>
              <Avatar src={seen.avatar} name={seen.name} size={4} />
            </div>
          )}
        </div>
        {toolbar && <div className="absolute right-2 -top-2.5 z-10">{toolbar}</div>}
      </div>
    );
  }

  // ------------------------------------------------------------------ bubbles: WhatsApp, Instagram, plain chat
  const bubbleCls = bare
    ? 'bg-transparent'
    : wa
      ? cn('rounded-lg px-2 pt-1.5 pb-1 shadow-[0_1px_0.5px_rgba(0,0,0,0.13)] text-gray-900', mine ? 'bg-[#d9fdd3] rounded-tr-none' : 'bg-white rounded-tl-none')
      : ig
        ? cn('rounded-[22px] px-3.5 py-2 text-[15px] leading-snug', mine
          ? cn('bg-[#3797f0] text-white', !groupStart && 'rounded-tr-md', !groupEnd && 'rounded-br-md')
          : cn('bg-[#efefef] text-gray-900', !groupStart && 'rounded-tl-md', !groupEnd && 'rounded-bl-md'))
        : cn('rounded-2xl px-3.5 py-2 shadow-sm', mine ? 'bg-indigo-600 text-white rounded-br-md' : 'bg-white border border-gray-200 text-gray-900 rounded-bl-md');

  return (
    <div id={`msg-${m.id}`} className={cn('flex flex-col max-w-[85%]', ig ? 'md:max-w-[62%]' : 'md:max-w-[70%]', mine ? 'ml-auto items-end' : 'mr-auto items-start')}>
      {story && <div className={cn('text-[11px] text-gray-500 mb-1', !mine && 'ml-9')}>{story}</div>}
      {storyMedia.length > 0 && (
        <div className={cn('flex gap-1 mb-1', mine ? 'pr-2 border-r-[3px]' : 'ml-9 pl-2 border-l-[3px]', 'border-gray-200')}>
          {storyMedia.map((a, i) => <Media key={a.id ?? `s${i}`} messageId={m.id} att={a} kind={mediaKind(a)!} variant="story" />)}
        </div>
      )}
      <div className={cn('group flex items-end gap-1.5 max-w-full', mine && 'flex-row-reverse')}>
        {ig && !mine && <div className="w-7 flex-shrink-0 self-end">{groupEnd && <Avatar src={author?.avatar} name={author?.name ?? contactName} size={7} />}</div>}
        <div
          className={cn('relative max-w-full min-w-0 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] transition-shadow', bubbleCls, deleted && 'opacity-80', pending && 'opacity-60', highlight && 'ring-2 ring-amber-400 ring-offset-2')}
          title={ig ? fullTime : undefined}
          onDoubleClick={ig && reactable ? () => { void react('❤️'); } : undefined}
        >
          {content}
          {wa && !editing && (
            // WhatsApp keeps the time (and our ticks) inside the bubble, bottom right
            <span className={cn('float-right ml-3 mt-1 -mb-0.5 inline-flex items-center gap-1 text-[11px] leading-4 select-none', bare ? 'bg-black/40 text-white rounded px-1' : 'text-gray-500')} title={fullTime}>
              {m.edited_at && !deleted && <span>Edited</span>}
              {pending ? 'Sending…' : clockTime(m.sent_at)}
              {mine && !deleted && <Ticks m={m} pending={pending} />}
            </span>
          )}
        </div>
        {toolbar}
      </div>
      {reactions}
      <div className={cn(ig && !mine && 'ml-9')}>{extras}</div>
      {ig && (pending || (m.edited_at && !deleted) || editable || seen) && (
        <div className={cn('flex items-center gap-2 mt-0.5 text-[11px] text-gray-500', mine ? 'mr-1' : 'ml-10')}>
          {pending && <span>Sending…</span>}
          {m.edited_at && !deleted && <span>Edited</span>}
          {editClock}
          {seen && <span title={seen.at ? `Seen ${fmtDate(seen.at)}` : undefined}>Seen</span>}
        </div>
      )}
      {!wa && !ig && (
        <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-400 flex-wrap">
          <span title={fullTime}>{pending ? 'Sending…' : fmtDate(m.sent_at)}</span>
          {m.edited_at && !deleted && <span>· edited</span>}
          {deleted && <span>· deleted</span>}
          {mine && m.read_at && !pending && <span className="inline-flex items-center gap-0.5 text-sky-600" title={`Seen ${fmtDate(m.read_at)}`}><CheckCheck className="w-3 h-3" /> Seen</span>}
          {editClock}
          {isEmail && mine && (m.opens > 0 || m.clicks > 0) && (
            <>
              <span className="inline-flex items-center gap-0.5" title="Opens"><Eye className="w-3 h-3" />{m.opens}</span>
              <span className="inline-flex items-center gap-0.5" title="Link clicks"><MousePointerClick className="w-3 h-3" />{m.clicks}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
