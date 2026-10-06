'use client';

// Bell (private-notes-PRD.md §6.1, reply-notifications-PRD.md §6): replies, website chat, mentions, AI handoffs and
// assignments, newest first; opens the conversation (or the note); Mark all read. Pause lives here too, with the time
// left shown beside the bell while sounds and desktop notifications are paused.
import { useEffect, useRef, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { Bell, BellOff, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/components/outreach/ui';
import { notificationLink, useMarkAllMentionsRead, useMarkNotificationsRead, useNotesBadge, useNotifications, type NotificationRow } from '@/lib/outreach/notes';
import { PAUSE_OPTIONS, isPaused, pauseLeftLabel, pauseUntil, useAlertSettings, useSaveAlertSettings } from '@/lib/outreach/alerts';
import AlertKindIcon from '@/components/outreach/alerts/AlertKindIcon';

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export default function NotificationBell({ ws, className }: { ws: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const badge = useNotesBadge(ws);
  const list = useNotifications(ws, open);
  const markAll = useMarkAllMentionsRead(ws);
  const markSome = useMarkNotificationsRead(ws);
  const settings = useAlertSettings(ws).data;
  const save = useSaveAlertSettings(ws);
  const now = useNow(30_000);
  const paused = isPaused(settings, now);
  const left = pauseLeftLabel(settings, now);
  const leftShort = pauseLeftLabel(settings, now, true);
  const unread = badge.data?.unread_notifications ?? 0;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const openRow = (n: NotificationRow) => { if (!n.read_at) markSome.mutate([n.id]); setOpen(false); };
  const BellIcon = paused ? BellOff : Bell;

  return (
    <div ref={ref} className={cn('relative flex items-center gap-1.5', className)}>
      {leftShort && <span className="hidden sm:inline text-[11px] text-gray-500 whitespace-nowrap tabular-nums" title={`Sounds and desktop notifications are paused · ${left}`}>{leftShort}</span>}
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} aria-label={unread ? `${unread} unread notifications` : 'Notifications'} title={paused ? `Notifications · paused (${left})` : 'Notifications'}
        className={cn('relative flex-shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg border', open ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50')}>
        <BellIcon className="w-4 h-4" />
        {unread > 0 && <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] leading-4 text-center tabular-nums">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 top-full mt-1.5 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <span className="text-sm font-semibold text-gray-900">Notifications</span>
            <button type="button" onClick={() => markAll.mutate()} disabled={!unread || markAll.isPending} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 disabled:text-gray-400"><Check className="w-3.5 h-3.5" /> Mark all read</button>
          </div>
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-gray-100 bg-gray-50/60">
            {paused ? (
              <>
                <span className="text-xs text-gray-600 inline-flex items-center gap-1"><BellOff className="w-3.5 h-3.5" /> Paused · {left}</span>
                <button type="button" onClick={() => save.mutate({ paused_until: null })} disabled={save.isPending} className="text-xs font-medium text-indigo-600 hover:text-indigo-800">Resume</button>
              </>
            ) : (
              <label className="flex items-center justify-between gap-2 w-full text-xs text-gray-600">
                <span>Sounds and desktop</span>
                <select aria-label="Pause sounds and desktop notifications" value="" disabled={!settings || save.isPending}
                  onChange={(e) => { const v = e.target.value as (typeof PAUSE_OPTIONS)[number]['value']; if (v) save.mutate({ paused_until: pauseUntil(v) }); }}
                  className="text-xs border border-gray-200 rounded-md bg-white px-1.5 py-0.5 text-gray-700">
                  <option value="">Pause…</option>
                  {PAUSE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {list.isLoading && <div className="px-3 py-6 text-center text-xs text-gray-500">Loading…</div>}
            {list.data && list.data.length === 0 && <div className="px-3 py-6 text-center text-xs text-gray-500">Nothing yet. Replies, mentions and conversations handed to you land here.</div>}
            {list.data?.map((n) => {
              const merged = (n.count ?? 1) > 1 && (n.kind === 'reply_new' || n.kind === 'webchat_message');
              const quoted = n.kind === 'note_mention' || n.kind === 'ai_handoff';
              const channel = typeof n.data?.channel === 'string' ? n.data.channel : null;
              const body = (
                <>
                  <span className="mt-0.5"><AlertKindIcon kind={n.kind} muted={!!n.read_at} className="w-3.5 h-3.5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-sm truncate', n.read_at ? 'text-gray-700' : 'font-medium text-gray-900')}>{n.title}</span>
                    {n.body && <span className="block text-xs text-gray-500 line-clamp-2">{merged ? `${n.count} new messages · ` : ''}{quoted ? `“${n.body}”` : n.body}</span>}
                    <span className="block text-[11px] text-gray-400 mt-0.5">{timeAgo(n.updated_at ?? n.created_at)}{channel ? ` · ${channel}` : ''}{!n.access ? ' · You no longer have access' : ''}</span>
                  </span>
                  {!n.read_at && <span className="mt-2 w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" aria-label="Unread" />}
                </>
              );
              const cls = cn('flex items-start gap-2 px-3 py-2 border-b border-gray-50', n.access && n.chat_id ? 'hover:bg-gray-50' : 'opacity-70', !n.read_at && 'bg-amber-50/40');
              return n.access && n.chat_id
                ? <Link key={n.id} href={notificationLink(n)} onClick={() => openRow(n)} className={cls}>{body}</Link>
                : <div key={n.id} className={cls} onClick={() => openRow(n)}>{body}</div>;
            })}
          </div>
          <div className="px-3 py-2 text-right"><Link href="/outreach/settings/notifications" onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-gray-800">Notification settings</Link></div>
        </div>
      )}
    </div>
  );
}
