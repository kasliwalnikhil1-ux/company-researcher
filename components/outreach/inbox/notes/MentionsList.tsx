'use client';

// The inbox "Mentions" view (private-notes-PRD.md §6.2): conversations where the signed-in user was mentioned in a
// private note, unread first, then newest. Each row shows the note snippet and who wrote it.
import { AtSign, Check, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { channelLabel } from '@/lib/outreach/channels';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { Avatar, EmptyState, ErrorBox, Spinner, timeAgo } from '@/components/outreach/ui';
import { useMarkAllMentionsRead, useMentions, type MentionRow } from '@/lib/outreach/notes';
import { parseError } from '@/lib/outreach/api';

export interface MentionsListProps {
  ws: string;
  selectedId: string | null;
  onSelect: (chatId: string, noteId: string) => void;
  unreadOnly: boolean;
  onUnreadOnly: (v: boolean) => void;
}

function rowName(r: MentionRow): string { return r.chat.lead_name || r.chat.attendee_name || r.chat.subject || 'Conversation'; }

export default function MentionsList({ ws, selectedId, onSelect, unreadOnly, onUnreadOnly }: MentionsListProps) {
  const q = useMentions(ws, unreadOnly);
  const markAll = useMarkAllMentionsRead(ws);
  const rows = q.data;
  const unread = rows?.filter((r) => !r.read_at).length ?? 0;
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 text-xs">
        <label className="inline-flex items-center gap-1 text-gray-600 cursor-pointer"><input type="checkbox" className="accent-amber-600" checked={unreadOnly} onChange={(e) => onUnreadOnly(e.target.checked)} /> Unread only</label>
        <span className="flex-1" />
        <button type="button" onClick={() => markAll.mutate()} disabled={!unread || markAll.isPending} className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 disabled:text-gray-400"><Check className="w-3.5 h-3.5" /> Mark all read</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" role="listbox" aria-label="Mentions">
        {q.error && <ErrorBox message={parseError(q.error).message} className="m-3" />}
        {!q.error && q.isLoading && !rows && <Spinner />}
        {rows && rows.length === 0 && <EmptyState icon={<AtSign className="w-6 h-6" />} title={unreadOnly ? 'No unread mentions' : 'No mentions yet'} description="When a teammate writes @you in a private note, the conversation shows up here." />}
        {rows?.map((r) => {
          const active = r.chat_id === selectedId;
          const name = rowName(r);
          const unreadRow = !r.read_at;
          return (
            <button key={`${r.chat_id}-${r.note_id}`} type="button" role="option" aria-selected={active} onClick={() => onSelect(r.chat_id, r.note_id)}
              className={cn('w-full text-left px-3 py-2.5 flex items-start gap-2.5 border-b border-l-[3px] transition-colors', active ? 'bg-indigo-100/60 border-l-indigo-600 border-b-indigo-100' : 'border-l-transparent border-b-gray-100 hover:bg-gray-50', unreadRow && !active && 'bg-amber-50/40')}>
              <div className="pt-0.5"><Avatar src={r.chat.picture_url || r.chat.lead_picture_url} name={name} size={9} /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={cn('text-sm truncate', unreadRow ? 'font-semibold text-gray-900' : 'font-medium text-gray-800')}>{name}</span>
                  {r.chat.company && <span className="text-[11px] text-gray-500 truncate">· {r.chat.company}</span>}
                  <span title={channelLabel(r.chat.provider)} className="flex-shrink-0"><ProviderLogo provider={r.chat.provider} className="w-3 h-3 rounded-[2px]" /></span>
                  <span className="ml-auto text-[11px] text-gray-400 flex-shrink-0 tabular-nums">{timeAgo(r.created_at)}</span>
                </div>
                <div className="mt-0.5 flex items-start gap-1.5 text-xs">
                  <Lock className="w-3 h-3 mt-0.5 text-amber-600 flex-shrink-0" />
                  <span className={cn('min-w-0 flex-1', unreadRow ? 'text-gray-800' : 'text-gray-500')}><span className="font-medium text-gray-700">{r.author}:</span> <span className="line-clamp-2">{r.snippet}</span></span>
                  {r.unread_count > 1 && <span className="text-[10px] bg-amber-500 text-white rounded-full px-1.5 py-0.5 leading-none flex-shrink-0">{r.unread_count}</span>}
                  {r.unread_count === 1 && unreadRow && <span className="w-2 h-2 mt-1 rounded-full bg-amber-500 flex-shrink-0" aria-label="Unread" />}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
