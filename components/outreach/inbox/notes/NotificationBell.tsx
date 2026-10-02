'use client';

// Bell (private-notes-PRD.md §6.1): unread mentions + other notifications, newest first; opens the note; Mark all read.
import { useEffect, useRef, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { Bell, Check, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/components/outreach/ui';
import { noteLink, useMarkAllMentionsRead, useMarkNotificationsRead, useNotesBadge, useNotifications, type NotificationRow } from '@/lib/outreach/notes';

export default function NotificationBell({ ws, className }: { ws: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const badge = useNotesBadge(ws);
  const list = useNotifications(ws, open);
  const markAll = useMarkAllMentionsRead(ws);
  const markSome = useMarkNotificationsRead(ws);
  const unread = badge.data?.unread_notifications ?? 0;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const openRow = (n: NotificationRow) => { if (!n.read_at) markSome.mutate([n.id]); setOpen(false); };

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} aria-label={unread ? `${unread} unread notifications` : 'Notifications'} title="Notifications"
        className={cn('relative flex-shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg border', open ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50')}>
        <Bell className="w-4 h-4" />
        {unread > 0 && <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] leading-4 text-center tabular-nums">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 top-full mt-1.5 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <span className="text-sm font-semibold text-gray-900">Notifications</span>
            <button type="button" onClick={() => markAll.mutate()} disabled={!unread || markAll.isPending} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 disabled:text-gray-400"><Check className="w-3.5 h-3.5" /> Mark all read</button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {list.isLoading && <div className="px-3 py-6 text-center text-xs text-gray-500">Loading…</div>}
            {list.data && list.data.length === 0 && <div className="px-3 py-6 text-center text-xs text-gray-500">Nothing yet. When a teammate mentions you in a private note, it lands here.</div>}
            {list.data?.map((n) => {
              const body = (
                <>
                  <span className="mt-0.5 flex-shrink-0"><Lock className={cn('w-3.5 h-3.5', n.read_at ? 'text-gray-300' : 'text-amber-600')} /></span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-sm truncate', n.read_at ? 'text-gray-700' : 'font-medium text-gray-900')}>{n.title}</span>
                    {n.body && <span className="block text-xs text-gray-500 line-clamp-2">“{n.body}”</span>}
                    <span className="block text-[11px] text-gray-400 mt-0.5">{timeAgo(n.created_at)}{!n.access ? ' · You no longer have access' : ''}</span>
                  </span>
                  {!n.read_at && <span className="mt-2 w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" aria-label="Unread" />}
                </>
              );
              const cls = cn('flex items-start gap-2 px-3 py-2 border-b border-gray-50', n.access && n.chat_id ? 'hover:bg-gray-50' : 'opacity-70', !n.read_at && 'bg-amber-50/40');
              return n.access && n.chat_id
                ? <Link key={n.id} href={noteLink(n.chat_id, n.note_id)} onClick={() => openRow(n)} className={cls}>{body}</Link>
                : <div key={n.id} className={cls} onClick={() => openRow(n)}>{body}</div>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}
