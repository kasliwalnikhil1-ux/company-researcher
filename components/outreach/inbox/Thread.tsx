'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Archive, ArchiveRestore, MailOpen, ChevronDown, PanelRight, Linkedin, Mail, ExternalLink, Wand2, CheckSquare, Tag as TagIcon, Layers, Repeat } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { Chat, Intent, Lead, Member, Message, Sender } from '@/lib/outreach/types';
import { Avatar, IntentBadge, Spinner, ErrorBox, EmptyState, StatusPill } from '@/components/outreach/ui';
import MessageBubble from './MessageBubble';
import Compose from './Compose';
import { INTENTS, INTENT_LABELS, memberLabel, useNow, editWindowRemainingMs } from './hooks';

export type ConvertKind = 'task' | 'tag' | 'stage' | 'reenrol';
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
  const name = chat.attendee_name || lead?.full_name || chat.attendee_public_identifier || 'Unknown';
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastCountRef = useRef(0);

  // Tick only while some outbound LinkedIn message is inside its 60-minute edit window.
  const hasEditable = useMemo(() => chat.provider === 'LINKEDIN' && !!messages?.some((m) => m.direction === 'out' && !m.deleted_at && editWindowRemainingMs(m.sent_at, Date.now()) > 0), [messages, chat.provider]);
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

  return (
    <div className="flex flex-col h-full min-h-0 bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-2 flex-wrap">
        <button type="button" onClick={p.onBack} className="md:hidden p-1.5 rounded-md hover:bg-gray-100 text-gray-600" aria-label="Back to conversations"><ArrowLeft className="w-4 h-4" /></button>
        <Avatar src={chat.attendee_picture_url ?? lead?.picture_url} name={name} size={9} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-gray-900 truncate">{name}</span>
            {chat.provider === 'LINKEDIN' ? <Linkedin className="w-3.5 h-3.5 text-[#0a66c2]" aria-label="LinkedIn" /> : <Mail className="w-3.5 h-3.5 text-emerald-600" aria-label="Email" />}
            {lead && <Link href={`/outreach/leads/${lead.id}`} className="text-gray-400 hover:text-indigo-600" title="Open lead"><ExternalLink className="w-3.5 h-3.5" /></Link>}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {[lead?.headline, lead?.company].filter(Boolean).join(' · ') || chat.subject || chat.attendee_public_identifier || '—'}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {sender && (
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-gray-600 px-2 py-1 rounded-md bg-gray-100" title="Sender">
              <Avatar src={sender.picture_url} name={sender.display_name} size={4} />
              <span className="truncate max-w-[120px]">{sender.display_name ?? sender.public_identifier}</span>
              {sender.status !== 'ok' && <StatusPill status={sender.status} reason={sender.status_reason} />}
            </span>
          )}
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
          <button type="button" onClick={p.onMarkUnread} disabled={!p.canWrite} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 disabled:opacity-40" title="Mark as unread (u)" aria-label="Mark as unread"><MailOpen className="w-4 h-4" /></button>
          <button type="button" onClick={() => p.onArchive(!chat.archived)} disabled={!p.canWrite} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 disabled:opacity-40" title={chat.archived ? 'Unarchive (e)' : 'Archive (e)'} aria-label={chat.archived ? 'Unarchive' : 'Archive'}>{chat.archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}</button>
          <button type="button" onClick={p.onTogglePanel} className="xl:hidden p-1.5 rounded-md hover:bg-gray-100 text-gray-500" title="Lead details" aria-label="Toggle lead panel"><PanelRight className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 md:px-5 py-4 space-y-3">
        {p.messagesError && <ErrorBox message={p.messagesError} />}
        {!p.messagesError && p.messagesLoading && !messages && <Spinner />}
        {messages && messages.length === 0 && <EmptyState title="No messages yet" description="Messages in this conversation will appear here." />}
        {grouped.map((g) => (
          <div key={g.day} className="space-y-3">
            <div className="flex items-center gap-3 text-[11px] text-gray-400 uppercase tracking-wide"><span className="flex-1 h-px bg-gray-200" />{g.day}<span className="flex-1 h-px bg-gray-200" /></div>
            {g.items.map((m) => (
              <MessageBubble key={m.id} m={m} provider={chat.provider} now={now} canEdit={canEditMessages} onEdit={p.onEditMessage} onDelete={p.onDeleteMessage} />
            ))}
          </div>
        ))}
      </div>

      <Compose key={chat.id} chat={chat} sender={sender} workspaceId={p.workspaceId} disabledReason={disabledReason} onError={p.onError} />
    </div>
  );
}
