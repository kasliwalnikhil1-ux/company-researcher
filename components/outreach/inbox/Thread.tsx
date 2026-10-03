'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Archive, ArchiveRestore, MailOpen, ChevronDown, PanelRight, ExternalLink, Check, CheckSquare, Tag as TagIcon, Layers, Repeat, NotebookPen, Eye, EyeOff, MoreHorizontal } from 'lucide-react';
import NoteBubble from './notes/NoteBubble';
import { isNoteModeShortcut, readComposerMode, readShowNotes, writeComposerMode, writeShowNotes, type ChatNote, type NoteAttachment, type NoteVisibility } from '@/lib/outreach/notes';
import Link from '@/lib/outreach/nav';
import { cn } from '@/lib/utils';
import { channelLabel, chatTitle, isMailProvider } from '@/lib/outreach/channels';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { ConsentChip } from './ConsentChip';
import type { Chat, Intent, Lead, Member, Message, Sender } from '@/lib/outreach/types';
import { Avatar, IntentBadge, Spinner, ErrorBox, EmptyState, StatusPill } from '@/components/outreach/ui';
import MessageBubble from './MessageBubble';
import Compose from './Compose';
import { INTENTS, INTENT_LABELS, useNow, inEditWindowNow, useNarrowerThan } from './hooks';
import { useThreadAttribution } from '@/lib/outreach/intel';
import { callFn, parseError } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import ForwardDialog from './ForwardDialog';
import AssigneeSelect from './AssigneeSelect';
import AiModeChip from './ai/AiModeChip';
import WebchatThreadBar from './webchat/WebchatThreadBar';
import EmailThread from './channels/EmailThread';
import { clockTime, linkedinChatMeta, msgTypeOf, threadLook } from './channels/look';
import type { ProfileFacts } from '@/lib/outreach/intel';

const DEGREE: Record<string, string> = { FIRST_DEGREE: '1st', SECOND_DEGREE: '2nd', THIRD_DEGREE: '3rd' };
const LINKEDIN_INBOX: Record<string, string> = { sales_navigator: 'Sales Navigator', recruiter: 'Recruiter', organization: 'Company page' };

/** `notes` opens the lead panel on its AI lead-notes tab (AI replies v2). */
export type ConvertKind = 'task' | 'tag' | 'stage' | 'reenrol' | 'notes';
export type ChatDetail = Chat & { outreach_leads: Lead | null; outreach_senders: Sender | null };

export interface ThreadProps {
  chat: ChatDetail;
  messages: Message[] | undefined;
  messagesLoading: boolean;
  messagesError: string | null;
  members: Member[] | undefined;
  workspaceId: string;
  canWrite: boolean;
  canReply: boolean;
  suspended: boolean;
  onBack: () => void;
  onTogglePanel: () => void;
  onSetIntent: (intent: Intent) => Promise<void>;
  onAssign: (userId: string | null) => Promise<void>;
  onArchive: (archived: boolean) => Promise<void>;
  onMarkUnread: () => Promise<void>;
  onConvert: (kind: ConvertKind) => void;
  onEditMessage: (id: string, text: string) => Promise<void>;
  onDeleteMessage: (id: string) => Promise<void>;
  onError: (msg: string) => void;
  /** Success toasts (consent recorded / revoked). Optional so older callers keep working. */
  onNotice?: (msg: string) => void;
  /** Private notes (private-notes-PRD §5): interleaved with the messages by time; the composer's second mode. */
  notes: ChatNote[] | undefined;
  currentUserId: string | null;
  isManager: boolean;
  isClientViewer: boolean;
  /** `?note=<id>` deep link: scroll to this note and flash it */
  highlightNoteId: string | null;
  onAddNote: (body: string, visibility: NoteVisibility, attachments: NoteAttachment[]) => Promise<void>;
  onUpdateNote: (noteId: string, patch: { body?: string; visibility?: NoteVisibility }) => Promise<void>;
  onDeleteNote: (noteId: string) => Promise<void>;
  onMakeTaskFromNote: (note: ChatNote) => void;
  /** a note that mentions the signed-in user scrolled into view: marks the mention read */
  onNoteSeen: (noteId: string) => void;
}

function Menu({ button, children, align = 'right', disabled, className }: { button: (open: boolean) => React.ReactNode; children: (close: () => void) => React.ReactNode; align?: 'left' | 'right'; disabled?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <div onClick={() => { if (!disabled) setOpen((o) => !o); }}>{button(open)}</div>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className={cn('absolute z-30 mt-1 min-w-[180px] bg-white border border-gray-200 rounded-lg shadow-lg py-1', align === 'right' ? 'right-0' : 'left-0', className)} role="menu">{children(() => setOpen(false))}</div>
        </>
      )}
    </div>
  );
}

/** The "more" menu's intent row: one line ("Intent · Unclassified ›") that opens the choices in place. */
function IntentPicker({ intent, itemClass, onPick }: { intent: Intent | null; itemClass: string; onPick: (i: Intent) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" role="menuitem" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={itemClass}>
        <Layers className="w-4 h-4 text-gray-400 flex-shrink-0" /><span className="flex-1">Intent</span>
        <span className="text-xs text-gray-500">{intent ? INTENT_LABELS[intent] : 'None'}</span><ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && INTENTS.map((i) => (
        <button key={i} type="button" role="menuitemradio" aria-checked={i === intent} onClick={() => onPick(i)} className={cn(itemClass, 'pl-9 text-[13px]', i === intent && 'text-indigo-700')}>
          <span className="flex-1">{INTENT_LABELS[i]}</span>{i === intent && <Check className="w-3.5 h-3.5" />}
        </button>
      ))}
    </>
  );
}

const CONVERT_ITEMS = [['task', 'Task', CheckSquare], ['tag', 'Tag', TagIcon], ['stage', 'Stage change', Layers], ['reenrol', 'Re-enrol in sequence', Repeat]] as const;

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Today';
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
}

export default function Thread(p: ThreadProps) {
  const { chat, messages, members } = p;
  const lead = chat.outreach_leads;
  const sender = chat.outreach_senders;
  const name = chatTitle(chat);
  const rootRef = useRef<HTMLDivElement>(null);
  // a squeezed thread column (laptop width, or the list / panel dragged wide): controls drop their labels so the
  // header and composer stay one or two short rows and the messages keep the height
  const narrow = useNarrowerThan(rootRef, 640);
  // in between (a laptop with the lead panel open): labels go first, the controls stay
  const cramped = useNarrowerThan(rootRef, 820);
  // the composer's toolbar: every button keeps its label from 820 px, the AI and booking buttons theirs down to 520 px
  const composerCompact = useNarrowerThan(rootRef, 520);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastCountRef = useRef(0);

  // Tick only while some outbound LinkedIn message is inside its 60-minute edit window.
  // Tick only while some outbound LinkedIn / WhatsApp message is inside its edit window (60 / 15 minutes).
  const hasEditable = useMemo(() => (chat.provider === 'LINKEDIN' || chat.provider === 'WHATSAPP') && !!messages?.some((m) => m.direction === 'out' && !m.deleted_at && inEditWindowNow(m.sent_at)), [messages, chat.provider]);
  const qc = useQueryClient();
  const look = threadLook(chat.provider);
  const wa = look === 'whatsapp';
  const isGroup = /@g\.us$/i.test(chat.attendee_provider_id ?? '');
  // reply / forward targets belong to one chat: switching chats drops them without an effect
  const [replyState, setReplyState] = useState<{ chatId: string; m: Message } | null>(null);
  const [forwardState, setForwardState] = useState<{ chatId: string; m: Message } | null>(null);
  const replyTo = replyState?.chatId === chat.id ? replyState.m : null;
  const forwarding = forwardState?.chatId === chat.id ? forwardState.m : null;
  const setReplyTo = useCallback((m: Message | null) => setReplyState(m ? { chatId: chat.id, m } : null), [chat.id]);
  const setForwarding = useCallback((m: Message | null) => setForwardState(m ? { chatId: chat.id, m } : null), [chat.id]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // email "Reply" / "Reply all": the composer opens on Reply with these Cc addresses (n changes on every click)
  const [mailReply, setMailReply] = useState<{ chatId: string; cc: string[]; n: number } | null>(null);
  // quoted messages resolve against the loaded thread by the connector's message id
  const byUnipileId = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages ?? []) if (m.unipile_message_id) map.set(m.unipile_message_id, m);
    return map;
  }, [messages]);
  const jumpTo = useCallback((id: string) => {
    document.getElementById(`msg-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightId(id);
    window.setTimeout(() => setHighlightId((h) => (h === id ? null : h)), 1600);
  }, []);
  const react = useCallback(async (m: Message, emoji: string) => {
    const key = qk.messages(chat.id);
    qc.setQueryData<Message[]>(key, (old) => (old ?? []).map((x) => x.id === m.id ? { ...x, reactions: [...(x.reactions ?? []).filter((r) => !(r.mine || r.by === 'us')), { emoji, by: 'You', mine: true, at: new Date().toISOString() }] } : x));
    try { await callFn('edit-message', { message_id: m.id, action: 'react', emoji }); }
    catch (e) { p.onError(parseError(e).message); }
    finally { qc.invalidateQueries({ queryKey: key }); }
  }, [chat.id, qc, p]);
  const forward = useCallback(async (m: Message, toChatId: string) => {
    try {
      await callFn('edit-message', { message_id: m.id, action: 'forward', to_chat_id: toChatId });
      p.onNotice?.('Message forwarded');
      qc.invalidateQueries({ queryKey: ['outreach', p.workspaceId, 'chats'] });
    } catch (e) { p.onError(parseError(e).message); throw e; }
  }, [qc, p]);
  const now = useNow(15_000, hasEditable);

  // ---------------------------------------------------------------- private notes: composer mode, Show notes, deep link, seen
  const [composerMode, setComposerModeState] = useState<'reply' | 'note'>(() => (typeof window === 'undefined' ? 'reply' : readComposerMode()));
  const setComposerMode = useCallback((m: 'reply' | 'note') => { setComposerModeState(m); writeComposerMode(m); }, []);
  const [showNotes, setShowNotesState] = useState<boolean>(() => (typeof window === 'undefined' ? true : readShowNotes()));
  const setShowNotes = useCallback((v: boolean) => { setShowNotesState(v); writeShowNotes(v); }, []);
  useEffect(() => {
    // Alt+P / ⌥P toggles Reply ↔ Private note anywhere in the thread (physical key, so it works on every layout)
    const onKey = (e: KeyboardEvent) => { if (isNoteModeShortcut(e)) { e.preventDefault(); setComposerMode(composerMode === 'note' ? 'reply' : 'note'); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [composerMode, setComposerMode]);
  const notes = p.notes;
  const [flashNoteId, setFlashNoteId] = useState<string | null>(null);
  const jumpedRef = useRef<string | null>(null);
  useEffect(() => {
    // ?note=<id>: once the notes are loaded, scroll to it and flash it for a moment (a deleted note shows its placeholder)
    const id = p.highlightNoteId;
    if (!id || !notes || jumpedRef.current === id) return;
    if (!notes.some((n) => n.id === id)) return;
    jumpedRef.current = id;
    const t = window.setTimeout(() => {
      if (!showNotes) setShowNotes(true);
      document.getElementById(`note-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFlashNoteId(id);
      window.setTimeout(() => setFlashNoteId((h) => (h === id ? null : h)), 2200);
    }, 60);
    return () => window.clearTimeout(t);
  }, [p.highlightNoteId, notes, showNotes, setShowNotes]);
  useEffect(() => { jumpedRef.current = null; }, [chat.id]);
  // a note that mentions me, unread, visible for a second → mark the mention read (PRD §6.1)
  const unreadMentionIds = useMemo(() => (notes ?? []).filter((n) => !n.deleted_at && n.mentions.some((m) => m.user_id === p.currentUserId && !m.read_at)).map((n) => n.id), [notes, p.currentUserId]);
  useEffect(() => {
    if (!unreadMentionIds.length || !showNotes) return;
    const timers = new Map<string, number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).id.replace(/^note-/, '');
        if (e.isIntersecting) { if (!timers.has(id)) timers.set(id, window.setTimeout(() => { timers.delete(id); p.onNoteSeen(id); }, 1000)); }
        else { const t = timers.get(id); if (t) { window.clearTimeout(t); timers.delete(id); } }
      }
    }, { root: scrollRef.current, threshold: 0.5 });
    for (const id of unreadMentionIds) { const el = document.getElementById(`note-${id}`); if (el) io.observe(el); }
    return () => { io.disconnect(); for (const t of timers.values()) window.clearTimeout(t); };
  }, [unreadMentionIds, showNotes, p.onNoteSeen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !messages) return;
    const total = messages.length + (showNotes ? (notes?.length ?? 0) : 0);
    const grew = total !== lastCountRef.current;
    lastCountRef.current = total;
    if (grew && !p.highlightNoteId) el.scrollTop = el.scrollHeight;
  }, [messages, notes, showNotes, p.highlightNoteId]);
  useEffect(() => { lastCountRef.current = 0; }, [chat.id]);

  const senderOk = sender?.status === 'ok';
  const disabledReason = p.suspended
    ? 'This workspace is suspended. Replies are disabled until billing is resolved.'
    : !p.canReply
      ? 'You do not have reply permission in this workspace. Ask an owner to enable "can reply" for your membership.'
      : !sender
        ? 'The sender for this conversation is no longer available.'
        : !senderOk
          ? `Sender ${sender.display_name ?? ''} is ${sender.status}${sender.status_reason ? ` (${sender.status_reason})` : ''}. Replies are disabled until it is connected again.`
          : null;
  const canEditMessages = !disabledReason;

  type TimelineItem = { kind: 'message'; at: string; m: Message } | { kind: 'note'; at: string; n: ChatNote };
  const grouped = useMemo(() => {
    // messages and (when shown) private notes, interleaved by time (PRD §5)
    const items: TimelineItem[] = (messages ?? []).map((m) => ({ kind: 'message' as const, at: m.sent_at, m }));
    if (showNotes) for (const n of notes ?? []) items.push({ kind: 'note', at: n.created_at, n });
    items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const out: Array<{ day: string; items: TimelineItem[] }> = [];
    for (const it of items) {
      const day = dayLabel(it.at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(it); else out.push({ day, items: [it] });
    }
    return out;
  }, [messages, notes, showNotes]);
  const noteCount = (notes ?? []).filter((n) => !n.deleted_at).length;

  // Instagram / LinkedIn: runs of messages from the same side are drawn together (corners, one avatar, one author header)
  const runGap = look === 'linkedin' ? 10 * 60_000 : 60 * 60_000;
  // system lines (calls, "accepted your InMail") never join a run, so the next message keeps its author header
  const systemLine = (m: Message) => m.event_type != null || (!m.text?.trim() && !m.attachments?.length && /^INMAIL_(ACCEPT|DECLINE)$/.test(msgTypeOf(m) ?? ''));
  const sameRun = (a: TimelineItem | undefined, b: TimelineItem | undefined) => !!a && !!b && a.kind === 'message' && b.kind === 'message'
    && !systemLine(a.m) && !systemLine(b.m) && a.m.direction === b.m.direction && (a.m.sender_name ?? '') === (b.m.sender_name ?? '')
    && Math.abs(Date.parse(b.at) - Date.parse(a.at)) < runGap;
  // the newest message of ours the contact has seen (LinkedIn: their picture under it, Instagram: "Seen")
  const seenId = useMemo(() => {
    if (look !== 'linkedin' && look !== 'instagram') return null;
    const list = messages ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.direction === 'out' && !m.deleted_at && m.event_type == null && m.read_at) return m.id;
    }
    return null;
  }, [messages, look]);
  const contactAvatar = chat.attendee_picture_url || lead?.picture_url || null;
  const multiParty = isGroup || !!chat.is_group;
  const authorOf = (m: Message) => m.direction === 'out'
    ? { name: sender?.display_name ?? 'You', avatar: sender?.picture_url ?? null }
    : { name: (multiParty ? m.sender_name : null) ?? name, avatar: multiParty ? null : contactAvatar };

  const renderNote = (n: ChatNote) => (
    <NoteBubble
      note={n} chat={chat} workspaceId={p.workspaceId} members={members} currentUserId={p.currentUserId}
      isManager={p.isManager} isClientViewer={p.isClientViewer} canImprove={chat.provider === 'LINKEDIN' && !disabledReason}
      highlight={flashNoteId === n.id} onUpdate={p.onUpdateNote} onDelete={p.onDeleteNote} onMakeTask={p.onMakeTaskFromNote}
      onError={p.onError} onNotice={(msg) => p.onNotice?.(msg)}
    />
  );

  // LinkedIn: connection degree, Premium / Open Profile, and the InMail / Sales Navigator kind of this conversation
  const facts = chat.provider === 'LINKEDIN' ? ((lead as (Lead & { linkedin?: ProfileFacts | null }) | null)?.linkedin ?? null) : null;
  const liChat = chat.provider === 'LINKEDIN' ? linkedinChatMeta(chat) : null;
  const degree = facts?.network_distance ? DEGREE[facts.network_distance] ?? null : null;
  const liChips = [
    liChat?.content_type === 'inmail' ? 'InMail' : liChat?.content_type === 'sponsored' ? 'Sponsored' : liChat?.content_type === 'linkedin_offer' ? 'Job offer' : null,
    liChat?.inbox ? LINKEDIN_INBOX[liChat.inbox] : null,
    facts?.is_open_profile ? 'Open Profile' : null,
  ].filter(Boolean) as string[];

  // Email threads lead with the subject; social threads with who the person is.
  const who = [lead?.headline, lead?.company].filter(Boolean).join(' · ');
  const subtitle = isMailProvider(chat.provider) ? (chat.subject || who) : isGroup ? 'WhatsApp group' : (who || (chat.subject !== name ? chat.subject : null));
  // Skip opaque provider ids (LinkedIn member URNs like "ACoAAA…"); only human-readable handles help here.
  const rawHandle = chat.attendee_public_identifier;
  const handle = rawHandle && rawHandle !== name && !/^ACo[A-Za-z0-9_-]{20,}$/i.test(rawHandle) ? rawHandle : null;
  const secondary = isMailProvider(chat.provider) && chat.subject ? (who || handle) : handle;

  // Item 4: one attribution call per thread, fetched again when a message arrives that it does not know yet.
  const lastStoredId = useMemo(() => { const real = (messages ?? []).filter((m) => !m.id.startsWith('temp-')); return real.length ? real[real.length - 1].id : null; }, [messages]);
  const attributionQ = useThreadAttribution(chat.id, lastStoredId);

  // one meta line under the name: who / subject first, then the channel and the handle (the provider logo is on the avatar)
  const handleText = secondary ? (chat.provider === 'INSTAGRAM' && !secondary.startsWith('@') ? `@${secondary}` : secondary) : null;
  const metaLine = [subtitle, channelLabel(chat.provider), handleText].filter(Boolean).join(' · ');
  const webchat = chat.provider === 'WEBCHAT';

  // Triage controls: one short row under the name — the AI, (web chat: status) / (others: intent), and the assignee.
  // Everything else lives in the "more" menu so the messages keep the height.
  const [webchatDetails, setWebchatDetails] = useState(false);   // web chat: the priority + labels editor row
  const intentMenu = (
    <Menu disabled={!p.canWrite} button={() => (
      <button type="button" className="inline-flex items-center gap-1 rounded-md hover:bg-gray-100 px-1 py-0.5 disabled:cursor-default disabled:hover:bg-transparent" title={p.canWrite ? 'Override intent' : 'AI intent'} aria-label="Override intent" disabled={!p.canWrite}>
        <IntentBadge intent={chat.intent} /><ChevronDown className="w-3 h-3 text-gray-400" />
      </button>
    )}>
      {(close) => INTENTS.map((i) => (
        <button key={i} type="button" role="menuitem" onClick={async () => { close(); await p.onSetIntent(i); }} className={cn('w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 flex items-center justify-between', i === chat.intent && 'bg-indigo-50 text-indigo-700')}>
          {INTENT_LABELS[i]}<IntentBadge intent={i} />
        </button>
      ))}
    </Menu>
  );
  const moreMenu = (
    <Menu className="w-60 max-h-[70vh] overflow-y-auto" button={(open) => (
      <button type="button" className={cn('relative p-1.5 rounded-md hover:bg-gray-100 text-gray-500', open && 'bg-gray-100')} title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded={open}>
        <MoreHorizontal className="w-4 h-4" />
        {!showNotes && noteCount > 0 && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden />}
      </button>
    )}>
      {(close) => {
        const item = 'w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 flex items-center gap-2 text-gray-700 disabled:opacity-40 disabled:hover:bg-transparent';
        const section = 'px-3 pt-2 pb-0.5 mt-1 border-t border-gray-100 text-[11px] text-gray-500';
        const icon = 'w-4 h-4 text-gray-400 flex-shrink-0';
        return (
          <>
            <button type="button" role="menuitem" onClick={() => { close(); setShowNotes(!showNotes); }} className={item}>
              {showNotes ? <EyeOff className={icon} /> : <Eye className={icon} />}
              <span className="flex-1">{showNotes ? 'Hide private notes' : 'Show private notes'}</span>
              {noteCount > 0 && <span className="text-[11px] px-1.5 rounded-full bg-amber-100 text-amber-800 tabular-nums">{noteCount > 99 ? '99+' : noteCount}</span>}
            </button>
            <button type="button" role="menuitem" disabled={!p.canWrite} onClick={() => { close(); void p.onMarkUnread(); }} className={item}><MailOpen className={icon} /><span className="flex-1">Mark as unread</span><kbd className="text-[10px] text-gray-400">U</kbd></button>
            <button type="button" role="menuitem" disabled={!p.canWrite} onClick={() => { close(); void p.onArchive(!chat.archived); }} className={item}>{chat.archived ? <ArchiveRestore className={icon} /> : <Archive className={icon} />}<span className="flex-1">{chat.archived ? 'Unarchive' : 'Archive'}</span><kbd className="text-[10px] text-gray-400">E</kbd></button>
            {lead && !webchat && <button type="button" role="menuitem" onClick={() => { close(); p.onConvert('notes'); }} className={item} title="Key facts the AI picked up from this person's messages (budget, timeline, objections…)"><NotebookPen className={icon} />Lead notes</button>}
            {webchat && <button type="button" role="menuitem" onClick={() => { close(); setWebchatDetails(true); }} className={item}><TagIcon className={icon} />Priority &amp; labels…</button>}
            {webchat && p.canWrite && <IntentPicker intent={chat.intent} itemClass={item} onPick={async (i) => { close(); await p.onSetIntent(i); }} />}
            {p.canWrite && (
              <>
                <div className={section}>Convert to</div>
                {CONVERT_ITEMS.map(([k, label, Icon]) => <button key={k} type="button" role="menuitem" onClick={() => { close(); p.onConvert(k); }} className={item}><Icon className={icon} />{label}</button>)}
              </>
            )}
            {sender && (
              <div className="mt-1 border-t border-gray-100 px-3 py-2 flex items-center gap-2 text-xs text-gray-500 min-w-0">
                <Avatar src={sender.picture_url} name={sender.display_name} size={5} />
                <span className="truncate">Sending as <span className="font-medium text-gray-700">{sender.display_name ?? sender.public_identifier}</span></span>
              </div>
            )}
          </>
        );
      }}
    </Menu>
  );

  return (
    <div ref={rootRef} className="flex flex-col h-full min-h-0 bg-gray-50">
      {/* Header: who it is + one short row of controls; the rest is in the "more" menu */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <div className="px-3 md:px-5 pt-2 pb-1.5 flex items-center gap-2.5 md:gap-3">
          <button type="button" onClick={p.onBack} className="md:hidden -ml-1 p-1.5 rounded-md hover:bg-gray-100 text-gray-600" aria-label="Back to conversations"><ArrowLeft className="w-4 h-4" /></button>
          <div className="relative flex-shrink-0">
            <Avatar src={chat.attendee_picture_url || lead?.picture_url} name={name} size={10} />
            <span className="absolute -bottom-0.5 -right-0.5 rounded-[4px] bg-white p-px ring-1 ring-white" title={channelLabel(chat.provider)}><ProviderLogo provider={chat.provider} className="w-3.5 h-3.5 rounded-[3px]" /></span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-base font-semibold text-gray-900 truncate leading-tight" title={name}>{name}</h2>
              {degree && <span className="flex-shrink-0 text-sm text-gray-500" title="Connection degree">· {degree}</span>}
              {facts?.is_premium && <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-[3px] bg-gradient-to-br from-[#e7a33e] to-[#c37d16] text-white text-[9px] font-bold" title="LinkedIn Premium">in</span>}
              {lead && <Link href={`/outreach/leads/${lead.id}`} className="flex-shrink-0 text-gray-400 hover:text-indigo-600" title="Open lead"><ExternalLink className="w-3.5 h-3.5" /></Link>}
              {chat.is_request && <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800" title="Instagram message request: not accepted yet, so it may not have been seen">Message request</span>}
              {chat.archived && <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">Archived</span>}
              {!showNotes && noteCount > 0 && <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800" title="Private notes are hidden: show them from the … menu">Notes hidden</span>}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-gray-500 mt-0.5 min-w-0">
              <span className="truncate" title={metaLine}>{metaLine}</span>
              {liChips.map((c) => <span key={c} className={cn('flex-shrink-0 text-[10px] font-semibold px-1.5 py-px rounded', c === 'InMail' ? 'bg-[#f3e9d2] text-[#915907]' : 'bg-[#0a66c2]/10 text-[#0a66c2]')}>{c}</span>)}
            </div>
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {moreMenu}
            <button type="button" onClick={p.onTogglePanel} className="min-[1440px]:hidden p-1.5 rounded-md hover:bg-gray-100 text-gray-500" title="Lead details" aria-label="Toggle lead panel"><PanelRight className="w-4 h-4" /></button>
          </div>
        </div>

        {webchat ? (
          // Web chat: AI · status … assignee (web-chat-PRD.md §8); priority, labels and intent are in the "more" menu
          <WebchatThreadBar chat={chat} messages={messages} members={members} workspaceId={p.workspaceId} canWrite={p.canWrite && !p.isClientViewer} onError={p.onError} onNotice={p.onNotice}
            narrow={narrow} detailsOpen={webchatDetails} onDetailsOpen={setWebchatDetails} />
        ) : (
          <div className="px-3 md:px-5 pb-2 flex items-center gap-1.5 min-w-0">
            <AiModeChip chatId={chat.id} onError={p.onError} onNotice={p.onNotice} density={narrow ? 'narrow' : 'cramped'} />
            {chat.provider === 'WHATSAPP' && !isGroup && <ConsentChip leadId={chat.lead_id} ws={p.workspaceId} canWrite={p.canWrite} toast={(m, t) => (t === 'error' ? p.onError(m) : p.onNotice?.(m))} />}
            {sender && sender.status !== 'ok' && <StatusPill status={sender.status} reason={sender.status_reason} />}
            <span className="flex-1" />
            {intentMenu}
            <AssigneeSelect value={chat.assigned_to} members={members} disabled={!p.canWrite} onChange={p.onAssign} />
          </div>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} data-tour="inbox-thread" className={cn('flex-1 min-h-0 overflow-y-auto px-3 md:px-5 py-3',
        wa ? 'space-y-1.5 bg-[#efeae2] bg-[radial-gradient(rgba(0,0,0,0.035)_1px,transparent_1px)] [background-size:14px_14px]'
          : look === 'instagram' ? 'bg-white' : look === 'linkedin' ? 'bg-white md:px-6' : look === 'email' ? 'bg-gray-100/70 md:px-6' : 'space-y-3')}>
        {p.messagesError && <ErrorBox message={p.messagesError} />}
        {!p.messagesError && p.messagesLoading && !messages && <Spinner />}
        {messages && messages.length === 0 && <EmptyState title="No messages yet" description="Messages in this conversation will appear here." />}
        {look === 'email' && messages && messages.length > 0 ? (
          <EmailThread
            chat={chat} sender={sender} now={now} attribution={attributionQ.data} canReply={!disabledReason} highlightId={highlightId}
            onReply={(cc) => { setComposerMode('reply'); setMailReply({ chatId: chat.id, cc, n: Date.now() }); }}
            items={grouped.flatMap((g) => g.items).map((it) => it.kind === 'note'
              ? { kind: 'note' as const, key: `note-${it.n.id}`, node: renderNote(it.n) }
              : { kind: 'message' as const, m: it.m })}
          />
        ) : grouped.map((g) => (
          <div key={g.day} className={wa ? 'space-y-1.5' : look === 'instagram' || look === 'linkedin' ? '' : 'space-y-3'}>
            {wa
              ? <div className="flex justify-center py-1"><span className="text-[11px] text-gray-600 bg-white/90 rounded-md px-2.5 py-1 shadow-sm">{g.day}</span></div>
              : look === 'instagram'
                ? <div className="text-center text-[11px] font-medium text-gray-500 pt-4 pb-2">{g.day} {clockTime(g.items[0].at)}</div>
                : <div className={cn('flex items-center gap-3 text-[11px] text-gray-400 uppercase tracking-wide', look === 'linkedin' && 'py-2 font-medium text-gray-500')}><span className="flex-1 h-px bg-gray-200" />{g.day}<span className="flex-1 h-px bg-gray-200" /></div>}
            {g.items.map((it, k) => {
              if (it.kind === 'note') return <div key={`note-${it.n.id}`} className={look === 'instagram' || look === 'linkedin' ? 'py-1.5' : undefined}>{renderNote(it.n)}</div>;
              const prev = g.items[k - 1], next = g.items[k + 1];
              const start = !sameRun(prev, it), end = !sameRun(it, next);
              // Instagram: a time line after an hour of silence
              const gapLine = look === 'instagram' && prev && Date.parse(it.at) - Date.parse(prev.at) >= 60 * 60_000;
              const bubble = (
                <MessageBubble
                  m={it.m} attribution={attributionQ.data?.[it.m.id]} provider={chat.provider} now={now} canEdit={canEditMessages} onEdit={p.onEditMessage} onDelete={p.onDeleteMessage}
                  isGroup={isGroup} contactName={isGroup ? undefined : name} highlight={highlightId === it.m.id}
                  quotedLocal={it.m.quoted?.unipile_message_id ? byUnipileId.get(it.m.quoted.unipile_message_id) ?? null : null}
                  onReply={setReplyTo} onReact={react} onForward={setForwarding} onJumpTo={jumpTo}
                  look={look} groupStart={start || !!gapLine} groupEnd={end} author={authorOf(it.m)}
                  seen={seenId === it.m.id ? { name, avatar: contactAvatar, at: it.m.read_at } : null}
                />
              );
              if (look !== 'instagram') return <div key={it.m.id}>{bubble}</div>;
              return (
                <div key={it.m.id} className={cn(start && k > 0 ? 'pt-2.5' : 'pt-0.5')}>
                  {gapLine && <div className="text-center text-[11px] font-medium text-gray-500 pt-2 pb-2.5">{clockTime(it.at)}</div>}
                  {bubble}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <Compose key={chat.id} chat={chat} sender={sender} workspaceId={p.workspaceId} disabledReason={disabledReason} onError={p.onError}
        replyTo={replyTo} replyToName={replyTo ? (replyTo.direction === 'out' ? 'You' : (replyTo.sender_name || name)) : undefined} onCancelReply={() => setReplyTo(null)}
        mailReply={mailReply?.chatId === chat.id ? mailReply : null}
        mode={composerMode} onModeChange={setComposerMode} members={members} currentUserId={p.currentUserId} isClientViewer={p.isClientViewer} onAddNote={p.onAddNote} compact={composerCompact} wide={!cramped} />
      <ForwardDialog chat={chat} message={forwarding} onClose={() => setForwarding(null)} onForward={forward} />
    </div>
  );
}
