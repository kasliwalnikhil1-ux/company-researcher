'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Paperclip, Loader2, Pencil, Trash2, Sparkles, Eye, MousePointerClick, Clock, Download, GitBranch, CornerDownRight, User, Mic, CheckCheck, Check, ExternalLink, Smile, Reply, Copy, Forward, Ban, Phone, PhoneMissed, Video, Users, Contact, Plus, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Message, Provider } from '@/lib/outreach/types';
import type { ThreadAttributionRow } from '@/lib/outreach/intel';
import { Badge, Button, fmtDate } from '@/components/outreach/ui';
import { editWindowRemainingMs, fmtRemaining, fmtBytes, sanitizeHtml, triggerDownload, useAttachmentUrl, type MessageAttachment } from './hooks';
import { channelLabel, fixMojibake, isMailProvider } from '@/lib/outreach/channels';

export function isVoiceNote(att: MessageAttachment): boolean {
  const mime = att.mimetype ?? att.type ?? '';
  return !!att.voice_note || mime.startsWith('audio/');
}

/** Image / video / sticker / GIF shown inline (WhatsApp and Instagram send these as `img` / `video`, sent files carry a mimetype). */
function mediaKind(att: MessageAttachment): 'image' | 'video' | null {
  if (att.unavailable || !att.id) return null;
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

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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

function RichText({ text, format, dark }: { text: string; format: boolean; dark: boolean }): React.ReactNode {
  const out: React.ReactNode[] = [];
  let last = 0, k = 0;
  for (const mt of text.matchAll(RICH_RE)) {
    const [whole, mono, url, bold2, bold, italic, strike, code] = mt;
    const at = mt.index ?? 0;
    if (!format && !url) continue;
    if (at > last) out.push(text.slice(last, at));
    const key = k++;
    if (url) out.push(<a key={key} href={url} target="_blank" rel="noopener noreferrer" className={cn('underline break-all', dark ? 'text-white' : 'text-sky-700 hover:text-sky-800')}>{url}</a>);
    else if (mono) out.push(<code key={key} className="font-mono text-[13px]">{mono.slice(3, -3)}</code>);
    else if (code) out.push(<code key={key} className={cn('font-mono text-[13px] rounded px-1', dark ? 'bg-white/15' : 'bg-black/[0.06]')}>{code.slice(1, -1)}</code>);
    else if (bold2) out.push(<strong key={key}><RichText text={bold2.slice(2, -2)} format={format} dark={dark} /></strong>);
    else if (bold) out.push(<strong key={key}><RichText text={bold.slice(1, -1)} format={format} dark={dark} /></strong>);
    else if (italic) out.push(<em key={key}><RichText text={italic.slice(1, -1)} format={format} dark={dark} /></em>);
    else if (strike) out.push(<s key={key}><RichText text={strike.slice(1, -1)} format={format} dark={dark} /></s>);
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
function Media({ messageId, att, kind }: { messageId: string; att: MessageAttachment; kind: 'image' | 'video' }) {
  const { url, loading, error, load } = useAttachmentUrl(messageId, att.id ?? '');
  useEffect(() => { if (att.id && !url && !loading && !error) void load(); }, [att.id, url, loading, error, load]);
  const name = att.name ?? (kind === 'image' ? 'Photo' : 'Video');
  if (error) return <div className="text-[11px] text-red-600 px-1">Could not load {kind === 'image' ? 'photo' : 'video'}: {error}</div>;
  if (!url) return <div className={cn('flex items-center justify-center rounded-md bg-black/5 text-gray-400', att.sticker ? 'w-28 h-28' : 'w-60 h-40')}><Loader2 className="w-5 h-5 animate-spin" /></div>;
  if (kind === 'video') {
    return att.gif
      ? <video src={url} autoPlay loop muted playsInline className="max-h-72 max-w-full rounded-md" aria-label="GIF" />
      : <video src={url} controls preload="metadata" className="max-h-72 max-w-full rounded-md bg-black" aria-label={name} />;
  }
  return (
    <button type="button" onClick={() => window.open(url, '_blank', 'noopener')} className="block" title="Open full size">
      <img src={url} alt={name} className={cn('rounded-md object-contain', att.sticker ? 'w-32 h-32' : 'max-h-72 max-w-full')} />
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
function SharedPost({ link, dark }: { link: NonNullable<MessageAttachment['link']>; dark: boolean }) {
  const isReel = /\/reel\//.test(link.url);
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

function AttachmentChip({ messageId, att, dark }: { messageId: string; att: MessageAttachment; dark: boolean }) {
  if (att.link?.url) return <SharedPost link={att.link} dark={dark} />;
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
}

function stepHref(a: ThreadAttributionRow): string {
  return `/outreach/sequences/${a.sequence_id}${a.node_id ? `?node=${encodeURIComponent(a.node_id)}` : ''}`;
}

function stepName(a: ThreadAttributionRow): string {
  const n = a.step_number != null ? `Step ${a.step_number}` : 'Step';
  return a.step_label ? `${n}: ${a.step_label}` : n;
}

function Attribution({ a, mine }: { a: ThreadAttributionRow; mine: boolean }) {
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

function Ticks({ m, pending }: { m: Message; pending: boolean }) {
  if (pending) return <Clock className="w-3 h-3" aria-label="Sending" />;
  if (m.read_at) return <CheckCheck className="w-3.5 h-3.5 text-sky-500" aria-label={`Read ${fmtDate(m.read_at)}`} />;
  if (m.delivered_at) return <CheckCheck className="w-3.5 h-3.5" aria-label="Delivered" />;
  return <Check className="w-3.5 h-3.5" aria-label="Sent" />;
}

export default function MessageBubble({ m, provider, now, canEdit, onEdit, onDelete, attribution, isGroup, quotedLocal, contactName, highlight, onReply, onReact, onForward, onJumpTo }: MessageBubbleProps) {
  const mine = m.direction === 'out';
  const deleted = !!m.deleted_at;
  const pending = m.id.startsWith('temp-');
  const wa = provider === 'WHATSAPP';
  const dark = mine && !wa;   // white text on the indigo bubble (every channel except WhatsApp)
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
  const isEmail = isMailProvider(provider);
  const safeHtml = useMemo(() => (isEmail && m.html && !m.text ? sanitizeHtml(m.html) : ''), [isEmail, m.html, m.text]);
  const atts = useMemo(() => (m.attachments ?? []) as MessageAttachment[], [m.attachments]);
  const voiceNotes = useMemo(() => atts.filter((a) => isVoiceNote(a)), [atts]);
  const media = useMemo(() => atts.filter((a) => !isVoiceNote(a) && mediaKind(a)), [atts]);
  const otherAttachments = useMemo(() => atts.filter((a) => !isVoiceNote(a) && !mediaKind(a)), [atts]);
  const onlySticker = media.length === 1 && !!media[0].sticker && !m.text && !m.quoted;
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

  const showAuthor = isGroup && !mine && (m.sender_name || m.sender_identifier);
  const hideDeletedText = deleted && provider !== 'LINKEDIN';
  const actionBtn = 'p-1 rounded-full text-gray-500 hover:text-gray-800 hover:bg-white shadow-sm bg-white/80 border border-gray-200';
  const hasActions = !editing && (reactable || replyable || forwardable || editable || deletable || (!!m.text && !deleted));

  const toolbar = hasActions ? (
    <div className={cn('relative flex items-center gap-0.5 self-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity', picker && 'opacity-100')}>
      {reactable && (
        <div className="relative" ref={pickerRef}>
          <button type="button" className={actionBtn} onClick={() => setPicker((v) => !v)} title="React" aria-label="React" disabled={busy === 'react'}>{busy === 'react' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Smile className="w-3.5 h-3.5" />}</button>
          {picker && (
            <div className={cn('absolute z-20 bottom-full mb-1 flex items-center gap-0.5 rounded-full bg-white shadow-lg border border-gray-200 px-1.5 py-1', mine ? 'right-0' : 'left-0')} role="menu">
              {QUICK_REACTIONS.map((e) => <button key={e} type="button" role="menuitem" onClick={() => react(e)} className="text-lg leading-none px-1 py-0.5 rounded-full hover:bg-gray-100 hover:scale-125 transition-transform" aria-label={`React ${e}`}>{e}</button>)}
              <button type="button" role="menuitem" onClick={() => { const e = window.prompt('React with any emoji'); if (e?.trim()) void react(e.trim()); }} className="p-1 rounded-full hover:bg-gray-100 text-gray-500" aria-label="Other emoji"><Plus className="w-4 h-4" /></button>
            </div>
          )}
        </div>
      )}
      {replyable && <button type="button" className={actionBtn} onClick={() => onReply!(m)} title="Reply" aria-label="Reply"><Reply className="w-3.5 h-3.5" /></button>}
      {forwardable && <button type="button" className={actionBtn} onClick={() => onForward!(m)} title="Forward" aria-label="Forward"><Forward className="w-3.5 h-3.5" /></button>}
      {!!m.text && !deleted && <button type="button" className={actionBtn} onClick={copy} title={copied ? 'Copied' : 'Copy text'} aria-label="Copy text">{copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}</button>}
      {editable && <button type="button" className={actionBtn} onClick={() => { setDraft(m.text ?? ''); setEditing(true); }} title={`Edit (${fmtRemaining(editRemaining)})`} aria-label="Edit message"><Pencil className="w-3.5 h-3.5" /></button>}
      {deletable && <button type="button" className={cn(actionBtn, 'hover:text-red-600')} onClick={() => setConfirmDelete(true)} title="Delete for everyone" aria-label="Delete message"><Trash2 className="w-3.5 h-3.5" /></button>}
    </div>
  ) : null;

  const bubbleCls = onlySticker
    ? 'bg-transparent'
    : wa
      ? cn('rounded-lg px-2 pt-1.5 pb-1 shadow-[0_1px_0.5px_rgba(0,0,0,0.13)] text-gray-900', mine ? 'bg-[#d9fdd3] rounded-tr-none' : 'bg-white rounded-tl-none')
      : cn('rounded-2xl px-3.5 py-2 shadow-sm', mine ? 'bg-indigo-600 text-white rounded-br-md' : 'bg-white border border-gray-200 text-gray-900 rounded-bl-md');

  return (
    <div id={`msg-${m.id}`} className={cn('flex flex-col max-w-[85%] md:max-w-[70%]', mine ? 'ml-auto items-end' : 'mr-auto items-start')}>
      <div className={cn('group flex items-end gap-1.5 max-w-full', mine && 'flex-row-reverse')}>
        <div className={cn('relative max-w-full min-w-0 text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] transition-shadow', bubbleCls, deleted && 'opacity-80', pending && 'opacity-60', highlight && 'ring-2 ring-amber-400 ring-offset-2')}>
          {showAuthor && (
            <div className="flex items-baseline gap-2 mb-0.5 min-w-0">
              <span className={cn('text-xs font-semibold truncate', authorColor(m.sender_identifier ?? m.sender_name))}>{m.sender_name ?? m.sender_identifier}</span>
              {m.sender_name && m.sender_identifier && <span className="text-[11px] text-gray-400 truncate">{m.sender_identifier}</span>}
            </div>
          )}
          {m.is_forwarded && !deleted && <div className={cn('flex items-center gap-1 text-[11px] italic mb-0.5', dark ? 'text-white/75' : 'text-gray-500')}><Forward className="w-3 h-3" /> Forwarded</div>}
          {m.is_invite_note && <div className="mb-1"><Badge tone={mine ? 'indigo' : 'blue'} className={dark ? 'bg-white/20 text-white' : ''}>Invitation note</Badge></div>}
          {!hideDeletedText && <QuoteBlock m={m} quotedLocal={quotedLocal} contactName={contactName} dark={dark} onJumpTo={onJumpTo} />}
          {!hideDeletedText && media.length > 0 && (
            <div className={cn('flex flex-col gap-1', (m.text || voiceNotes.length || otherAttachments.length) ? 'mb-1' : '')}>
              {media.map((a, i) => <Media key={a.id ?? `m${i}`} messageId={m.id} att={a} kind={mediaKind(a)!} />)}
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
          ) : (
            <span className={cn(deleted && 'line-through')}>{m.text ? <RichText text={fixMojibake(m.text) ?? ''} format={wa} dark={dark} /> : atts.length ? '' : m.unsupported
              ? <span className={cn('inline-flex items-center gap-1.5 italic', dark ? 'text-white/80' : 'text-gray-500')}><Info className="w-3.5 h-3.5 shrink-0" /> This message can&apos;t be shown here. Open {channelLabel(provider)} to see it.</span>
              : <em className="opacity-70">(empty message)</em>}</span>
          )}
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
            <div className="flex flex-wrap gap-1.5 mt-2">
              {otherAttachments.map((a, i) => <AttachmentChip key={a.id ?? `a${i}`} messageId={m.id} att={a} dark={dark} />)}
            </div>
          )}
          {wa && !editing && (
            // WhatsApp keeps the time (and our ticks) inside the bubble, bottom right
            <span className={cn('float-right ml-3 mt-1 -mb-0.5 inline-flex items-center gap-1 text-[11px] leading-4 select-none', onlySticker ? 'bg-black/40 text-white rounded px-1' : 'text-gray-500')} title={new Date(m.sent_at).toLocaleString()}>
              {m.edited_at && !deleted && <span>Edited</span>}
              {pending ? 'Sending…' : clockTime(m.sent_at)}
              {mine && !deleted && <Ticks m={m} pending={pending} />}
            </span>
          )}
        </div>
        {toolbar}
      </div>
      {reactionGroups.length > 0 && (
        <div className={cn('flex flex-wrap gap-1 -mt-1.5 relative z-[1]', mine ? 'justify-end mr-2' : 'ml-2')} aria-label="Reactions">
          {reactionGroups.map((g) => (
            <button key={g.emoji} type="button" disabled={!reactable || g.mine} onClick={() => react(g.emoji)} className={cn('inline-flex items-center gap-0.5 rounded-full bg-white border shadow-sm px-1.5 py-px text-xs disabled:cursor-default', g.mine ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 hover:bg-gray-50')} title={g.names.join(', ')}>
              {g.emoji}{g.names.length > 1 && <span className="text-[10px] text-gray-500">{g.names.length}</span>}
            </button>
          ))}
        </div>
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
      {attribution && !pending && <Attribution a={attribution} mine={mine} />}
      {!wa && (
        <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-400 flex-wrap">
          <span title={new Date(m.sent_at).toLocaleString()}>{pending ? 'Sending…' : fmtDate(m.sent_at)}</span>
          {m.edited_at && !deleted && <span>· edited</span>}
          {deleted && <span>· deleted</span>}
          {mine && m.read_at && !pending && <span className="inline-flex items-center gap-0.5 text-sky-600" title={`Seen ${fmtDate(m.read_at)}`}><CheckCheck className="w-3 h-3" /> Seen</span>}
          {editable && <span className="inline-flex items-center gap-0.5 text-amber-600" title="Edit/delete window"><Clock className="w-3 h-3" />{fmtRemaining(editRemaining)}</span>}
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
