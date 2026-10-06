'use client';

import { useState } from 'react';
import { ArrowLeft, Clock, ExternalLink, HelpCircle, MessageSquare } from 'lucide-react';
import Link from '@/lib/outreach/nav';
import { cn } from '@/lib/utils';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { Avatar, Button } from '@/components/outreach/ui';
import { WhyNotSendingDialog } from '@/components/outreach/sequences/WhyNotSendingDialog';
import { CHANNEL_LABEL, STATUS_TONE, TYPE_LABEL, sourceLine, statusLabel, type SentItem } from '@/lib/outreach/inboxSent';
import { remedyFor, rowActions, useSentRowActions } from './SentActions';

/**
 * The middle pane for a Sent row that has no message to scroll to: a planned step, an AI reply in its hold, a failed
 * send, a bounced email or a connection request without a conversation. Shows the full text, where it came from, the
 * status with its reason and what to do about it, and the same actions as the row menu.
 */
export default function SentDetail({ ws, item, onBack, onOpenChat, onOpenLead, canWrite, isManager, tz, toast }: {
  ws: string; item: SentItem; onBack: () => void; onOpenChat: (it: SentItem) => void; onOpenLead: (it: SentItem) => void;
  canWrite: boolean; isManager: boolean; tz: string | null; toast: (m: string, kind?: 'error') => void;
}) {
  const actions = useSentRowActions({ ws, toast, onOpenChat, onOpenLead });
  const [why, setWhy] = useState(false);
  const acts = rowActions(item, { write: canWrite, manager: isManager }).filter((a) => a.key !== 'open_chat' && a.key !== 'open_lead');
  const remedy = remedyFor(item);
  const when = new Date(item.at);
  const whenText = `${item.segment === 'scheduled' ? 'Planned for' : item.segment === 'failed' ? (item.status === 'bounced' ? 'Bounced' : 'Failed') : 'Sent'} ${when.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) })}`;
  return (
    <div className="flex flex-col h-full min-h-0 bg-gray-50">
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-3 md:px-5 py-2.5 flex items-center gap-2.5">
        <button type="button" onClick={onBack} className="md:hidden -ml-1 p-1.5 rounded-md hover:bg-gray-100 text-gray-600" aria-label="Back to the list"><ArrowLeft className="w-4 h-4" /></button>
        <Avatar src={item.lead?.picture_url} name={item.lead?.name ?? '?'} size={10} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-base font-semibold text-gray-900 truncate">{item.lead?.name ?? 'Unknown recipient'}</h2>
            {item.lead?.id && <Link href={`/outreach/leads/${item.lead.id}`} className="flex-shrink-0 text-gray-400 hover:text-indigo-600" title="Open lead"><ExternalLink className="w-3.5 h-3.5" /></Link>}
          </div>
          <div className="text-xs text-gray-500 truncate">{[item.lead?.headline, item.lead?.company].filter(Boolean).join(' · ') || '—'}</div>
        </div>
        {item.chat_id && <Button size="sm" variant="secondary" onClick={() => onOpenChat(item)}><MessageSquare className="w-3.5 h-3.5" /> Conversation</Button>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 md:px-6 py-4">
        <div className="max-w-2xl mx-auto space-y-3">
          <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded border', STATUS_TONE[item.status])}>{statusLabel(item, tz)}</span>
              <span className="text-gray-500 inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{whenText}</span>
            </div>
            <div className="text-xs text-gray-500 space-y-0.5">
              <div><span className="text-gray-400">What:</span> {TYPE_LABEL[item.type]}{item.subject ? ` · “${item.subject}”` : ''}</div>
              <div><span className="text-gray-400">Where it came from:</span> {item.sequence?.id
                ? <Link href={`/outreach/sequences/${item.sequence.id}`} className="text-indigo-600 hover:underline">{sourceLine(item)}</Link>
                : sourceLine(item)}{item.from_ai_draft ? ' · AI draft' : ''}</div>
              <div className="flex items-center gap-1"><span className="text-gray-400">From:</span> <ProviderLogo provider={item.sender.provider ?? 'LINKEDIN'} className="w-3 h-3 rounded-[2px]" />
                {item.sender.id ? <Link href={`/outreach/senders/${item.sender.id}`} className="hover:underline">{item.sender.name ?? 'Sender'}</Link> : item.sender.name} · {CHANNEL_LABEL[item.channel] ?? item.channel}</div>
            </div>
            {item.body || item.preview
              ? <div className="text-sm text-gray-800 whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 max-h-80 overflow-y-auto">{item.body || item.preview}</div>
              : <div className="text-sm text-gray-400 italic">{item.type === 'connection_request' ? 'No note: a plain connection request.' : 'No text'}</div>}
          </div>

          {(item.status_text || remedy) && (
            <div className={cn('rounded-xl border p-3 text-sm', item.status === 'failed' || item.status === 'bounced' ? 'border-rose-200 bg-rose-50 text-rose-900' : item.status === 'held' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-gray-200 bg-white text-gray-700')}>
              {item.status_text && <p className="font-medium">{item.status_text}</p>}
              {remedy && <p className="text-xs mt-0.5 opacity-90"><span className="font-medium">What to do:</span> {remedy}</p>}
              {item.status === 'held' && item.enrollment_id && (
                <button type="button" onClick={() => setWhy(true)} className="mt-1.5 inline-flex items-center gap-1 text-xs underline"><HelpCircle className="w-3.5 h-3.5" /> Why isn&apos;t it sending?</button>
              )}
            </div>
          )}

          {(acts.length > 0 || item.lead?.id) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {acts.map((a) => (
                <Button key={a.key} size="sm" variant={a.danger ? 'secondary' : a.key === 'retry' || a.key === 'ai_send_now' ? 'primary' : 'secondary'} title={a.title}
                  className={a.danger ? 'text-rose-600' : undefined} disabled={actions.busy} onClick={() => actions.run(a.key, [item])}>{a.label}</Button>
              ))}
              {item.lead?.id && <Button size="sm" variant="ghost" onClick={() => onOpenLead(item)}>{item.status === 'bounced' ? 'Open lead (fix the address)' : 'Open lead'}</Button>}
            </div>
          )}
          {!canWrite && <p className="text-xs text-gray-400">Read-only: you can see this send but not change it.</p>}
        </div>
      </div>
      {actions.modals}
      <WhyNotSendingDialog open={why} onClose={() => setWhy(false)} enrollmentId={item.enrollment_id} />
    </div>
  );
}
