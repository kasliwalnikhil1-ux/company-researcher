'use client';

// Toast for a fresh notification (private-notes-PRD.md §6.1): "Aarushi mentioned you in Priya Nair (Razorpay): '…'" →
// opens the note. Mounted once in the outreach Shell; auto-dismisses after 8 s.
import { useEffect } from 'react';
import Link from '@/lib/outreach/nav';
import { Lock, X } from 'lucide-react';
import { noteLink, type IncomingNotification } from '@/lib/outreach/notes';

function Item({ n, onDismiss }: { n: IncomingNotification; onDismiss: () => void }) {
  useEffect(() => { const t = setTimeout(onDismiss, 8000); return () => clearTimeout(t); }, [onDismiss]);
  const inner = (
    <>
      <Lock className="w-4 h-4 mt-0.5 text-amber-600 flex-shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-gray-900 truncate">{n.title}</span>
        {n.body && <span className="block text-xs text-gray-600 line-clamp-2">“{n.body}”</span>}
      </span>
    </>
  );
  return (
    <div role="status" className="pointer-events-auto flex items-start gap-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-amber-200 bg-white shadow-lg px-3 py-2.5">
      {n.chat_id ? <Link href={noteLink(n.chat_id, n.note_id)} onClick={onDismiss} className="flex items-start gap-2 min-w-0 flex-1 hover:opacity-90">{inner}</Link> : <div className="flex items-start gap-2 min-w-0 flex-1">{inner}</div>}
      <button type="button" onClick={onDismiss} className="p-0.5 text-gray-400 hover:text-gray-700" aria-label="Dismiss"><X className="w-4 h-4" /></button>
    </div>
  );
}

export default function MentionToast({ items, onDismiss }: { items: IncomingNotification[]; onDismiss: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="fixed top-4 right-4 z-[70] flex flex-col gap-2 pointer-events-none" aria-live="polite">
      {items.map((n) => <Item key={n.id} n={n} onDismiss={() => onDismiss(n.id)} />)}
    </div>
  );
}
