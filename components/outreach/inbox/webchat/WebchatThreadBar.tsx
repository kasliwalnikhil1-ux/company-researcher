'use client';

// Web chat conversation actions (web-chat-PRD.md §8) shown under the thread header on WEBCHAT threads only:
// status (open / pending / snoozed / resolved), assignee, priority, labels, "Let AI continue / Stop the AI", the visitor's
// live typing preview, and the canned-response shortcuts the composer expands ("/shortcut"). Also marks visitor messages
// read for the agent (read receipts in the widget) whenever the thread is open.

import { useEffect, useMemo, useState } from 'react';
import { Bot, BotOff, Check, ChevronDown, Clock, Tag, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rpc } from '@/lib/outreach/api';
import type { Chat, Member, Message } from '@/lib/outreach/types';
import { Badge } from '@/components/outreach/ui';
import { memberLabel, useNow } from '../hooks';
import { CHAT_STATUS_LABELS, PRIORITY_LABELS, useCannedResponses, useConversationUpdate } from '@/lib/outreach/webchat';

const SNOOZE = [['1h', 1], ['4h', 4], ['Tomorrow', 24], ['3 days', 72], ['1 week', 168]] as const;

export default function WebchatThreadBar({ chat, messages, members, workspaceId, canWrite, onError, onNotice }: { chat: Chat; messages: Message[] | undefined; members: Member[] | undefined; workspaceId: string; canWrite: boolean; onError: (m: string) => void; onNotice?: (m: string) => void }) {
  const upd = useConversationUpdate();
  const canned = useCannedResponses(workspaceId);
  const [labelDraft, setLabelDraft] = useState('');
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [cannedOpen, setCannedOpen] = useState(false);
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
  const sel = 'text-xs rounded-md border border-gray-200 bg-white px-2 py-1 text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-60';

  return (
    <div className="px-4 md:px-5 py-2 bg-white border-b border-gray-200 flex flex-wrap items-center gap-2 text-xs" data-testid="webchat-bar">
      <span className={cn('inline-flex items-center gap-1.5', online ? 'text-emerald-700' : 'text-gray-500')} title={chat.visitor_last_seen_at ? `Last seen ${new Date(chat.visitor_last_seen_at).toLocaleString()}` : 'Never seen active'}>
        <span className={cn('w-2 h-2 rounded-full', online ? 'bg-emerald-500' : 'bg-gray-300')} /> {online ? 'On the site now' : 'Away'}
      </span>
      {chat.source && <Badge tone="gray">{chat.source}</Badge>}
      <select className={sel} value={status} disabled={!canWrite} aria-label="Conversation status" onChange={(e) => { const v = e.target.value; if (v === 'snoozed') setSnoozeOpen(true); else patch({ status: v }, v === 'resolved' ? 'Conversation resolved' : undefined); }}>
        {Object.entries(CHAT_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}{k === 'snoozed' && chat.snoozed_until ? ` · until ${new Date(chat.snoozed_until).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })}` : ''}</option>)}
      </select>
      {snoozeOpen && (
        <span className="inline-flex items-center gap-1" role="group" aria-label="Snooze for">
          <Clock className="w-3.5 h-3.5 text-gray-400" />
          {SNOOZE.map(([l, h]) => <button key={l} type="button" className="px-2 py-0.5 rounded border border-gray-200 hover:border-indigo-400" onClick={() => { setSnoozeOpen(false); patch({ status: 'snoozed', snoozed_until: new Date(Date.now() + h * 3600_000).toISOString() }, `Snoozed for ${l}`); }}>{l}</button>)}
          <button type="button" className="text-gray-400 hover:text-gray-700" onClick={() => setSnoozeOpen(false)}>Cancel</button>
        </span>
      )}
      <select className={sel} value={chat.assigned_to ?? ''} disabled={!canWrite} aria-label="Assignee" onChange={(e) => patch({ assigned_to: e.target.value || null })}>
        <option value="">Unassigned</option>
        {(members ?? []).filter((m) => m.role !== 'client_viewer').map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
      </select>
      <select className={sel} value={chat.priority ?? ''} disabled={!canWrite} aria-label="Priority" onChange={(e) => patch({ priority: e.target.value || null })}>
        <option value="">No priority</option>
        {Object.entries(PRIORITY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <span className="inline-flex items-center gap-1 flex-wrap">
        <Tag className="w-3.5 h-3.5 text-gray-400" />
        {(chat.labels ?? []).map((l) => <Badge key={l} tone="indigo"><span>{l}</span>{canWrite && <button type="button" className="ml-1 text-indigo-400 hover:text-indigo-800" aria-label={`Remove label ${l}`} onClick={() => patch({ labels: (chat.labels ?? []).filter((x) => x !== l) })}>×</button>}</Badge>)}
        {canWrite && <input value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && labelDraft.trim()) { e.preventDefault(); patch({ labels: [...(chat.labels ?? []), labelDraft.trim()] }); setLabelDraft(''); } }} placeholder="+ label" aria-label="Add label" className="w-20 text-xs border-b border-dashed border-gray-300 bg-transparent px-1 py-0.5 focus:outline-none focus:border-indigo-500" />}
      </span>
      {chat.ai_mode && chat.ai_mode !== 'off' && canWrite && (
        <button type="button" onClick={() => toggleAi(!aiOn)} className={cn('inline-flex items-center gap-1 px-2 py-1 rounded-md border', aiOn ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50')} title={aiOn ? (review ? 'The assistant suggests answers for you to send. Click to stop it.' : 'The assistant answers this visitor. Click to stop it.') : chat.handoff_reason ? `Handed off: ${chat.handoff_reason.replace(/_/g, ' ')}. Click to let the assistant continue.` : 'Let the assistant continue'}>
          {aiOn ? <Bot className="w-3.5 h-3.5" /> : <BotOff className="w-3.5 h-3.5" />}{aiOn ? (review ? 'AI suggesting' : 'AI answering') : 'Let AI continue'}
        </button>
      )}
      {chat.csat && <Badge tone="green">CSAT {chat.csat.rating}/5</Badge>}
      <span className="ml-auto relative">
        <button type="button" className="inline-flex items-center gap-1 text-gray-600 hover:text-gray-900" onClick={() => setCannedOpen((o) => !o)} aria-expanded={cannedOpen} title="Type /shortcut in the reply box to expand a canned response">
          <Zap className="w-3.5 h-3.5" /> Canned <ChevronDown className="w-3 h-3" />
        </button>
        {cannedOpen && (
          <div className="absolute right-0 top-6 z-20 w-72 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg p-2 text-xs">
            {(canned.data ?? []).length === 0 && <p className="text-gray-500 p-1">No canned responses yet. Add them in Website assistant → your website → Canned responses.</p>}
            {(canned.data ?? []).map((c) => (
              <button key={c.id} type="button" className="block w-full text-left p-1.5 rounded hover:bg-gray-50" onClick={async () => { try { await navigator.clipboard.writeText(`/${c.short_code}`); onNotice?.(`Copied /${c.short_code} — paste it in the reply box`); } catch { /* ignore */ } setCannedOpen(false); }}>
                <span className="font-mono text-indigo-700">/{c.short_code}</span> <span className="text-gray-600">{c.content.slice(0, 80)}</span>
              </button>
            ))}
          </div>
        )}
      </span>
      {typing && <div className="w-full text-gray-500 italic truncate" aria-live="polite"><Check className="inline w-3 h-3 mr-1 text-gray-300" />Visitor is typing: “{typing}”</div>}
    </div>
  );
}
