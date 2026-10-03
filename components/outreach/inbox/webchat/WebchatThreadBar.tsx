'use client';

// Web chat conversation actions (web-chat-PRD.md §8), the controls row of the thread header on WEBCHAT threads:
// the visitor's presence, "AI on / off", status (open / pending / snoozed / resolved) and the assignee — one short row.
// Priority + labels open below on demand (from the thread's "more" menu); canned responses live in the reply box.
// Also shows the visitor's live typing preview and marks visitor messages read for the agent (read receipts in the
// widget) whenever the thread is open.

import { useEffect, useMemo, useState } from 'react';
import { Bot, BotOff, Check, ChevronDown, Clock, Tag, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rpc } from '@/lib/outreach/api';
import type { Chat, Member, Message } from '@/lib/outreach/types';
import { Badge } from '@/components/outreach/ui';
import { useNow } from '../hooks';
import AssigneeSelect from '../AssigneeSelect';
import { CHAT_STATUS_LABELS, PRIORITY_LABELS, useConversationUpdate } from '@/lib/outreach/webchat';

const SNOOZE = [['1h', 1], ['4h', 4], ['Tomorrow', 24], ['3 days', 72], ['1 week', 168]] as const;
const STATUS_DOT: Record<string, string> = { open: 'bg-emerald-500', pending: 'bg-amber-500', snoozed: 'bg-sky-500', resolved: 'bg-gray-400' };

export default function WebchatThreadBar({ chat, messages, members, canWrite, onError, onNotice, narrow = false, detailsOpen, onDetailsOpen }: {
  chat: Chat; messages: Message[] | undefined; members: Member[] | undefined; workspaceId: string; canWrite: boolean; onError: (m: string) => void; onNotice?: (m: string) => void;
  /** a squeezed thread column: the AI button says just "AI on / off" (the rest stays in the title) */
  narrow?: boolean;
  /** the priority + labels editor row (opened from the thread's "more" menu or the labels chip) */
  detailsOpen: boolean; onDetailsOpen: (open: boolean) => void;
}) {
  const upd = useConversationUpdate();
  const [labelDraft, setLabelDraft] = useState('');
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const status = chat.status ?? 'open';
  const unreadVisitor = useMemo(() => (messages ?? []).some((m) => m.direction === 'in' && m.sender_type === 'visitor' && !m.read_by_agent_at && !m.id.startsWith('temp-')), [messages]);
  const now = useNow(15_000, true);
  const typing = chat.visitor_typing_at && now - new Date(chat.visitor_typing_at).getTime() < 60_000 ? chat.visitor_typing_text : null;
  const online = chat.visitor_last_seen_at ? now - new Date(chat.visitor_last_seen_at).getTime() < 3 * 60_000 : false;

  // read receipts (PRD §5.4): the visitor sees ✓✓ once an agent has this thread open
  useEffect(() => { if (unreadVisitor) rpc('webchat_agent_read', { p_chat: chat.id }).catch(() => {}); }, [chat.id, unreadVisitor]);

  const patch = async (p: Record<string, unknown>, notice?: string) => {
    try { await upd.mutateAsync({ chat: chat.id, patch: p }); if (notice) onNotice?.(notice); }
    catch (e) { onError((e as Error).message); }
  };
  // Review mode: the assistant writes a suggestion into the reply box; a person sends it
  const review = chat.ai_mode === 'review';
  const toggleAi = async (on: boolean) => { try { await rpc('webchat_agent_ai', { p_chat: chat.id, p_on: on }); onNotice?.(on ? (review ? 'The assistant will suggest answers again' : 'The assistant will answer again') : 'The assistant stopped for this conversation'); } catch (e) { onError((e as Error).message); } };
  const aiOn = !!chat.ai_mode && chat.ai_mode !== 'off' && !chat.handed_off_at;
  const labels = chat.labels ?? [];
  const priorityLabel = chat.priority ? PRIORITY_LABELS[chat.priority] ?? chat.priority : null;
  const tagSummary = [priorityLabel, ...labels].filter(Boolean).join(', ');
  const presence = `${online ? 'On the site now' : 'Away'}${chat.source ? ` · came in from ${chat.source}` : ''}${chat.visitor_last_seen_at ? ` · last seen ${new Date(chat.visitor_last_seen_at).toLocaleString()}` : ' · never seen active'}`;
  const aiText = aiOn ? (narrow ? 'AI on' : review ? 'AI suggesting' : 'AI answering') : (narrow ? 'AI off' : 'AI paused');
  const aiTitle = aiOn
    ? (review ? 'The assistant suggests answers for you to send. Click to stop it.' : 'The assistant answers this visitor. Click to stop it.')
    : chat.handoff_reason ? `Handed off: ${chat.handoff_reason.replace(/_/g, ' ')}. Click to let the assistant continue.` : 'The assistant is paused here. Click to let it continue.';
  const sel = 'text-xs rounded-md border border-gray-200 bg-white px-1.5 py-1 text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-60';

  return (
    <div className="px-3 md:px-5 pb-2 space-y-1.5 text-xs" data-testid="webchat-bar">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={cn('flex-shrink-0 w-2 h-2 rounded-full mx-0.5', online ? 'bg-emerald-500' : 'bg-gray-300')} title={presence} aria-label={presence} role="img" />
        {chat.ai_mode && chat.ai_mode !== 'off' && (
          <button type="button" disabled={!canWrite} onClick={() => toggleAi(!aiOn)} title={aiTitle} aria-pressed={aiOn}
            className={cn('flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-full border whitespace-nowrap disabled:cursor-default', aiOn ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50')}>
            {aiOn ? <Bot className="w-3.5 h-3.5" /> : <BotOff className="w-3.5 h-3.5" />}{aiText}
          </button>
        )}
        <span className="relative inline-flex items-center flex-shrink-0 rounded-full border border-gray-200 bg-white text-gray-700">
          <span className={cn('pointer-events-none absolute left-2 w-1.5 h-1.5 rounded-full', STATUS_DOT[status] ?? 'bg-gray-400')} aria-hidden />
          <select className="appearance-none bg-transparent pl-5 pr-6 py-1 rounded-full max-w-[130px] truncate cursor-pointer disabled:cursor-default focus:outline-none focus:ring-2 focus:ring-indigo-400" value={status} disabled={!canWrite} aria-label="Conversation status" title="Conversation status"
            onChange={(e) => { const v = e.target.value; if (v === 'snoozed') setSnoozeOpen(true); else patch({ status: v }, v === 'resolved' ? 'Conversation resolved' : undefined); }}>
            {Object.entries(CHAT_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}{k === 'snoozed' && chat.snoozed_until ? ` · until ${new Date(chat.snoozed_until).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })}` : ''}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 w-3 h-3 text-gray-400" aria-hidden />
        </span>
        {/* labels only show here when there are some, and only where there is room; the "more" menu always opens them */}
        {tagSummary && !narrow && (
          <button type="button" onClick={() => onDetailsOpen(!detailsOpen)} aria-expanded={detailsOpen} className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-gray-600 hover:bg-gray-100 min-w-0" title={`${tagSummary}${canWrite ? ' (click to edit)' : ''}`}>
            <Tag className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" /><span className="truncate max-w-[140px]">{tagSummary}</span>
          </button>
        )}
        {chat.csat && !narrow && <Badge tone="green">CSAT {chat.csat.rating}/5</Badge>}
        <span className="flex-1" />
        <AssigneeSelect value={chat.assigned_to} members={members} disabled={!canWrite} onChange={(id) => patch({ assigned_to: id })} excludeClientViewers />
      </div>
      {snoozeOpen && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Snooze for">
          <Clock className="w-3.5 h-3.5 text-gray-400" />
          {SNOOZE.map(([l, h]) => <button key={l} type="button" className="px-2 py-0.5 rounded border border-gray-200 bg-white hover:border-indigo-400" onClick={() => { setSnoozeOpen(false); patch({ status: 'snoozed', snoozed_until: new Date(Date.now() + h * 3600_000).toISOString() }, `Snoozed for ${l}`); }}>{l}</button>)}
          <button type="button" className="text-gray-400 hover:text-gray-700" onClick={() => setSnoozeOpen(false)}>Cancel</button>
        </div>
      )}
      {detailsOpen && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-gray-50 border border-gray-100 px-2 py-1.5">
          <select className={sel} value={chat.priority ?? ''} disabled={!canWrite} aria-label="Priority" onChange={(e) => patch({ priority: e.target.value || null })}>
            <option value="">No priority</option>
            {Object.entries(PRIORITY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <span className="inline-flex items-center gap-1 flex-wrap min-w-0 flex-1">
            <Tag className="w-3.5 h-3.5 text-gray-400" />
            {labels.map((l) => <Badge key={l} tone="indigo"><span>{l}</span>{canWrite && <button type="button" className="ml-1 text-indigo-400 hover:text-indigo-800" aria-label={`Remove label ${l}`} onClick={() => patch({ labels: labels.filter((x) => x !== l) })}>×</button>}</Badge>)}
            {canWrite && <input value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && labelDraft.trim()) { e.preventDefault(); patch({ labels: [...labels, labelDraft.trim()] }); setLabelDraft(''); } }} placeholder="+ label" aria-label="Add label" className="w-24 text-base md:text-xs border-b border-dashed border-gray-300 bg-transparent px-1 py-0.5 focus:outline-none focus:border-indigo-500" />}
          </span>
          <button type="button" onClick={() => onDetailsOpen(false)} className="p-0.5 text-gray-400 hover:text-gray-700" aria-label="Close priority and labels"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {typing && <div className="text-gray-500 italic truncate" aria-live="polite"><Check className="inline w-3 h-3 mr-1 text-gray-300" />Visitor is typing: “{typing}”</div>}
    </div>
  );
}
