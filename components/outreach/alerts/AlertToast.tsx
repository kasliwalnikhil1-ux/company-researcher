'use client';

// In-app toast for a fresh alert (reply-notifications-PRD.md §4.3; private-notes-PRD.md §6.1): who, the first line of
// what they wrote, **Open**. Shown only while the person is in the app on another page (the alert engine decides).
// Mounted once in the outreach Shell; auto-dismisses after 8 s; reading the conversation anywhere removes it.
import { useEffect } from 'react';
import Link from '@/lib/outreach/nav';
import { X } from 'lucide-react';
import { notificationLink, type IncomingNotification } from '@/lib/outreach/notes';
import AlertKindIcon from './AlertKindIcon';

function firstLine(n: IncomingNotification): string | null {
  const t = (n.data?.text as string | undefined) ?? n.body;
  if (!t) return null;
  return t.split('\n')[0];
}

function Item({ n, onDismiss }: { n: IncomingNotification; onDismiss: () => void }) {
  useEffect(() => { const t = setTimeout(onDismiss, 8000); return () => clearTimeout(t); }, [onDismiss]);
  const line = firstLine(n);
  const quoted = n.kind === 'note_mention' || n.kind === 'ai_handoff';
  return (
    <div role="status" className="pointer-events-auto flex items-start gap-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white shadow-lg px-3 py-2.5">
      <AlertKindIcon kind={n.kind} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-gray-900 truncate">{n.title}</span>
        {line && <span className="block text-xs text-gray-600 line-clamp-2">{quoted ? `“${line}”` : line}</span>}
        {n.chat_id && <Link href={notificationLink(n)} onClick={onDismiss} className="inline-block mt-1 text-xs font-medium text-indigo-600 hover:text-indigo-800">Open</Link>}
      </span>
      <button type="button" onClick={onDismiss} className="p-0.5 text-gray-400 hover:text-gray-700" aria-label="Dismiss"><X className="w-4 h-4" /></button>
    </div>
  );
}

export default function AlertToast({ items, onDismiss }: { items: IncomingNotification[]; onDismiss: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="fixed top-[calc(1rem_+_var(--demo-bar,0px))] right-4 z-[70] flex flex-col gap-2 pointer-events-none" aria-live="polite">
      {items.map((n) => <Item key={n.id} n={n} onDismiss={() => onDismiss(n.id)} />)}
    </div>
  );
}
