'use client';

import { tabClass, tabStripClass } from '@/components/ui/Tabs';
import { VIEW_TOOLTIP, type InboxView } from '@/lib/outreach/inboxSent';

/**
 * Replies · Sent, at the top of the inbox list (inbox-replies-sent-PRD.md §4.1). Replies carries the unread count (the
 * sidebar badge's number); Sent carries no number, only a red dot while Failed has something nobody acted on.
 */
export default function InboxViewSwitch({ view, onChange, unread, failed, showSent = true }: {
  view: InboxView; onChange: (v: InboxView) => void; unread: number; failed: number; showSent?: boolean;
}) {
  const tab = (v: InboxView, label: string, badge: React.ReactNode) => (
    <button
      key={v}
      type="button"
      role="tab"
      aria-selected={view === v}
      title={VIEW_TOOLTIP[v]}
      onClick={() => onChange(v)}
      className={tabClass(view === v, true)}
    >
      {label}
      {badge}
    </button>
  );
  return (
    <div className="px-3 pt-1">
      <div className={tabStripClass} role="tablist" aria-label="Inbox view">
        {tab('replies', 'Replies', unread > 0 ? <span className="min-w-[18px] px-1 rounded-full bg-indigo-600 text-white text-[10px] leading-[18px] tabular-nums" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span> : null)}
        {showSent && tab('sent', 'Sent', failed > 0 ? <span className="w-1.5 h-1.5 rounded-full bg-rose-500" aria-label={`${failed} failed send${failed === 1 ? '' : 's'} to look at`} title={`${failed} failed send${failed === 1 ? '' : 's'} in the last 7 days`} /> : null)}
      </div>
    </div>
  );
}
