'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Forward } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { chatTitle } from '@/lib/outreach/channels';
import type { Chat, Message } from '@/lib/outreach/types';
import { Avatar, Modal, Spinner, ErrorBox } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';

type TargetRow = Pick<Chat, 'id' | 'attendee_name' | 'attendee_public_identifier' | 'attendee_picture_url' | 'subject' | 'last_message_at'> & { outreach_leads: { full_name: string | null; picture_url: string | null } | null };

/** WhatsApp "Forward to…": the other chats of the same WhatsApp number, newest first. */
export default function ForwardDialog({ chat, message, onClose, onForward }: { chat: Chat; message: Message | null; onClose: () => void; onForward: (m: Message, toChatId: string) => Promise<void> }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const targets = useQuery({
    queryKey: ['outreach', 'forward-targets', chat.sender_id],
    enabled: !!message,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_chats')
        .select('id, attendee_name, attendee_public_identifier, attendee_picture_url, subject, last_message_at, outreach_leads(full_name, picture_url)')
        .eq('sender_id', chat.sender_id).neq('id', chat.id).not('unipile_chat_id', 'is', null)
        .order('last_message_at', { ascending: false, nullsFirst: false }).limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as TargetRow[];
    },
  });
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const rows = targets.data ?? [];
    return s ? rows.filter((r) => `${chatTitle(r)} ${r.attendee_public_identifier ?? ''}`.toLowerCase().includes(s)) : rows;
  }, [targets.data, q]);

  const pick = async (id: string) => {
    if (!message || busy) return;
    setBusy(id);
    try { await onForward(message, id); onClose(); } finally { setBusy(null); }
  };

  return (
    <Modal open={!!message} onClose={onClose} title={<span className="inline-flex items-center gap-2"><Forward className="w-4 h-4" /> Forward message to</span>}>
      <div className="relative mb-3">
        <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or number" aria-label="Search chats" className="w-full text-sm pl-8 pr-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      </div>
      {targets.error && <ErrorBox message={(targets.error as Error).message} />}
      {targets.isLoading && <Spinner />}
      <ul className="max-h-[50vh] overflow-y-auto divide-y divide-gray-100 -mx-1">
        {list.map((r) => (
          <li key={r.id}>
            <button type="button" disabled={!!busy} onClick={() => pick(r.id)} className={cn('w-full flex items-center gap-3 px-2 py-2 rounded-md text-left hover:bg-gray-50 disabled:opacity-60', busy === r.id && 'bg-indigo-50')}>
              <Avatar src={r.attendee_picture_url || r.outreach_leads?.picture_url} name={chatTitle(r)} size={8} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900 truncate">{chatTitle(r)}</span>
                {r.attendee_public_identifier && r.attendee_public_identifier !== chatTitle(r) && <span className="block text-xs text-gray-500 truncate">{r.attendee_public_identifier}</span>}
              </span>
              {busy === r.id && <span className="text-xs text-indigo-600">Sending…</span>}
            </button>
          </li>
        ))}
        {!targets.isLoading && list.length === 0 && <li className="px-2 py-6 text-center text-sm text-gray-500">No chats found.</li>}
      </ul>
    </Modal>
  );
}
