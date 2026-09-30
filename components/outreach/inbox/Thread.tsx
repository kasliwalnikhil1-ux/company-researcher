'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Archive, ArchiveRestore, MailOpen, ChevronDown, PanelRight, ExternalLink, Wand2, CheckSquare, Tag as TagIcon, Layers, Repeat, NotebookPen } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { channelLabel, chatTitle, isMailProvider } from '@/lib/outreach/channels';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { ConsentChip } from './ConsentChip';
import type { Chat, Intent, Lead, Member, Message, Sender } from '@/lib/outreach/types';
import { Avatar, IntentBadge, Spinner, ErrorBox, EmptyState, StatusPill } from '@/components/outreach/ui';
import MessageBubble from './MessageBubble';
import Compose from './Compose';
import { INTENTS, INTENT_LABELS, memberLabel, useNow, inEditWindowNow } from './hooks';
import { useThreadAttribution } from '@/lib/outreach/intel';
import { callFn, parseError } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import ForwardDialog from './ForwardDialog';
import AiModeChip from './ai/AiModeChip';

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
}

function Menu({ button, children, align = 'right', disabled }: { button: (open: boolean) => React.ReactNode; children: (close: () => void) => React.ReactNode; align?: 'left' | 'right'; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <div onClick={() => { if (!disabled) setOpen((o) => !o); }}>{button(open)}</div>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className={cn('absolute z-30 mt-1 min-w-[180px] bg-white border border-gray-200 rounded-lg shadow-lg py-1', align === 'right' ? 'right-0' : 'left-0')} role="menu">{children(() => setOpen(false))}</div>
        </>
      )}
    </div>
  );
}

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastCountRef = useRef(0);

  // Tick only while some outbound LinkedIn message is inside its 60-minute edit window.
  // Tick only while some outbound LinkedIn / WhatsApp message is inside its edit window (60 / 15 minutes).
  const hasEditable = useMemo(() => (chat.provider === 'LINKEDIN' || chat.provider === 'WHATSAPP') && !!messages?.some((m) => m.direction === 'out' && !m.deleted_at && inEditWindowNow(m.sent_at)), [messages, chat.provider]);
  const qc = useQueryClient();
  const wa = chat.provider === 'WHATSAPP';
  const isGroup = /@g\.us$/i.test(chat.attendee_provider_id ?? '');
  // reply / forward targets belong to one chat: switching chats drops them without an effect
  const [replyState, setReplyState] = useState<{ chatId: string; m: Message } | null>(null);
  const [forwardState, setForwardState] = useState<{ chatId: string; m: Message } | null>(null);
  const replyTo = replyState?.chatId === chat.id ? replyState.m : null;
  const forwarding = forwardState?.chatId === chat.id ? forwardState.m : null;
  const setReplyTo = useCallback((m: Message | null) => setReplyState(m ? { chatId: chat.id, m } : null), [chat.id]);
  const setForwarding = useCallback((m: Message | null) => setForwardState(m ? { chatId: chat.id, m } : null), [chat.id]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !messages) return;
    const grew = messages.length !== lastCountRef.current;
    lastCountRef.current = messages.length;
    if (grew) el.scrollTop = el.scrollHeight;
  }, [messages]);
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

  const grouped = useMemo(() => {
    const out: Array<{ day: string; items: Message[] }> = [];
    for (const m of messages ?? []) {
      const day = dayLabel(m.sent_at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(m); else out.push({ day, items: [m] });
    }
    return out;
  }, [messages]);

  const assignee = members?.find((m) => m.user_id === chat.assigned_to);

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

  return (
    <div className="flex flex-col h-full min-h-0 bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        {/* Identity: who this conversation is with */}
        <div className="px-4 md:px-5 pt-3.5 pb-3 flex items-start gap-3">
          <button type="button" onClick={p.onBack} className="md:hidden -ml-1 mt-2 p-1.5 rounded-md hover:bg-gray-100 text-gray-600" aria-label="Back to conversations"><ArrowLeft className="w-4 h-4" /></button>
          <div className="relative flex-shrink-0">
            <Avatar src={chat.attendee_picture_url || lead?.picture_url} name={name} size={12} />
            <span className="absolute -bottom-0.5 -right-0.5 rounded-[4px] bg-white p-px ring-1 ring-white" title={channelLabel(chat.provider)}><ProviderLogo provider={chat.provider} className="w-4 h-4 rounded-[3px]" /></span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-lg font-semibold text-gray-900 truncate leading-tight" title={name}>{name}</h2>
              {lead && <Link href={`/outreach/leads/${lead.id}`} className="flex-shrink-0 text-gray-400 hover:text-indigo-600" title="Open lead"><ExternalLink className="w-4 h-4" /></Link>}
              {chat.is_request && <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800" title="Instagram message request: not accepted yet, so it may not have been seen">Message request</span>}
              {chat.archived && <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">Archived</span>}
            </div>
            {subtitle && <p className="text-sm text-gray-600 truncate mt-0.5" title={subtitle}>{subtitle}</p>}
            <div className="flex items-center gap-1.5 text-xs text-gray-400 mt-0.5 min-w-0">
              <span className="flex-shrink-0">{channelLabel(chat.provider)}</span>
              {secondary && <><span aria-hidden>·</span><span className="truncate" title={secondary}>{secondary}</span></>}
            </div>
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button type="button" onClick={p.onMarkUnread} disabled={!p.canWrite} className="p-2 rounded-md hover:bg-gray-100 text-gray-500 disabled:opacity-40" title="Mark as unread (u)" aria-label="Mark as unread"><MailOpen className="w-4 h-4" /></button>
            <button type="button" onClick={() => p.onArchive(!chat.archived)} disabled={!p.canWrite} className="p-2 rounded-md hover:bg-gray-100 text-gray-500 disabled:opacity-40" title={chat.archived ? 'Unarchive (e)' : 'Archive (e)'} aria-label={chat.archived ? 'Unarchive' : 'Archive'}>{chat.archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}</button>
            <button type="button" onClick={p.onTogglePanel} className="xl:hidden p-2 rounded-md hover:bg-gray-100 text-gray-500" title="Lead details" aria-label="Toggle lead panel"><PanelRight className="w-4 h-4" /></button>
          </div>
        </div>

        {/* Toolbar: triage controls */}
        <div className="px-4 md:px-5 py-2 border-t border-gray-100 bg-gray-50/60 flex items-center gap-2 flex-wrap">
          {sender && (
            <span className="inline-flex items-center gap-1.5 text-xs text-gray-600 pl-1 pr-2 py-1 rounded-full bg-white border border-gray-200 min-w-0" title="Sender">
              <Avatar src={sender.picture_url} name={sender.display_name} size={4} />
              <span className="text-gray-400">via</span>
              <span className="truncate max-w-[140px] font-medium text-gray-700">{sender.display_name ?? sender.public_identifier}</span>
              {sender.status !== 'ok' && <StatusPill status={sender.status} reason={sender.status_reason} />}
            </span>
          )}
          {chat.provider === 'WHATSAPP' && !isGroup && <ConsentChip leadId={chat.lead_id} ws={p.workspaceId} canWrite={p.canWrite} toast={(m, t) => (t === 'error' ? p.onError(m) : p.onNotice?.(m))} />}
          <AiModeChip chatId={chat.id} onError={p.onError} onNotice={p.onNotice} />
          {lead && (
            <button type="button" onClick={() => p.onConvert('notes')} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50" title="Key facts the AI picked up from this person's messages (budget, timeline, objections…)">
              <NotebookPen className="w-3.5 h-3.5 text-gray-400" /> Lead notes
            </button>
          )}
          <span className="flex-1" />
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
          <select value={chat.assigned_to ?? ''} onChange={(e) => p.onAssign(e.target.value || null)} disabled={!p.canWrite} title="Assign conversation" aria-label="Assign conversation" className="text-xs rounded-md border border-gray-200 bg-white text-gray-700 px-1.5 py-1 max-w-[140px] focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">Unassigned</option>
            {members?.map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
            {chat.assigned_to && !assignee && <option value={chat.assigned_to}>Former member</option>}
          </select>
          {p.canWrite && (
            <Menu button={() => (
              <button type="button" className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-50" title="Convert this reply into an action">
                <Wand2 className="w-3.5 h-3.5" /> Convert <ChevronDown className="w-3 h-3 text-gray-400" />
              </button>
            )}>
              {(close) => (
                <>
                  {([['task', 'Task', CheckSquare], ['tag', 'Tag', TagIcon], ['stage', 'Stage change', Layers], ['reenrol', 'Re-enrol in sequence', Repeat]] as const).map(([k, label, Icon]) => (
                    <button key={k} type="button" role="menuitem" onClick={() => { close(); p.onConvert(k); }} className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 flex items-center gap-2 text-gray-700"><Icon className="w-4 h-4 text-gray-400" />{label}</button>
                  ))}
                </>
              )}
            </Menu>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className={cn('flex-1 min-h-0 overflow-y-auto px-3 md:px-5 py-4', wa ? 'space-y-1.5 bg-[#efeae2] bg-[radial-gradient(rgba(0,0,0,0.035)_1px,transparent_1px)] [background-size:14px_14px]' : 'space-y-3')}>
        {p.messagesError && <ErrorBox message={p.messagesError} />}
        {!p.messagesError && p.messagesLoading && !messages && <Spinner />}
        {messages && messages.length === 0 && <EmptyState title="No messages yet" description="Messages in this conversation will appear here." />}
        {grouped.map((g) => (
          <div key={g.day} className={wa ? 'space-y-1.5' : 'space-y-3'}>
            {wa
              ? <div className="flex justify-center py-1"><span className="text-[11px] text-gray-600 bg-white/90 rounded-md px-2.5 py-1 shadow-sm">{g.day}</span></div>
              : <div className="flex items-center gap-3 text-[11px] text-gray-400 uppercase tracking-wide"><span className="flex-1 h-px bg-gray-200" />{g.day}<span className="flex-1 h-px bg-gray-200" /></div>}
            {g.items.map((m) => (
              <MessageBubble
                key={m.id} m={m} attribution={attributionQ.data?.[m.id]} provider={chat.provider} now={now} canEdit={canEditMessages} onEdit={p.onEditMessage} onDelete={p.onDeleteMessage}
                isGroup={isGroup} contactName={isGroup ? undefined : name} highlight={highlightId === m.id}
                quotedLocal={m.quoted?.unipile_message_id ? byUnipileId.get(m.quoted.unipile_message_id) ?? null : null}
                onReply={setReplyTo} onReact={react} onForward={setForwarding} onJumpTo={jumpTo}
              />
            ))}
          </div>
        ))}
      </div>

      <Compose key={chat.id} chat={chat} sender={sender} workspaceId={p.workspaceId} disabledReason={disabledReason} onError={p.onError}
        replyTo={replyTo} replyToName={replyTo ? (replyTo.direction === 'out' ? 'You' : (replyTo.sender_name || name)) : undefined} onCancelReply={() => setReplyTo(null)} />
      <ForwardDialog chat={chat} message={forwarding} onClose={() => setForwarding(null)} onForward={forward} />
    </div>
  );
}
