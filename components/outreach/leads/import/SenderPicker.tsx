'use client';

import { useQuery } from '@tanstack/react-query';
import type { Sender } from '@/lib/outreach/types';
import { rpc } from '@/lib/outreach/api';
import { Select, StatusPill } from '@/components/outreach/ui';

/** LinkedIn senders that are connected — the only ones that can run imports. */
export function importableSenders(senders: Sender[] | undefined): Sender[] {
  return (senders ?? []).filter((s) => s.provider === 'LINKEDIN' && s.status === 'ok');
}

export function senderLabel(s: Sender): string {
  return s.display_name ?? s.public_identifier ?? s.owner_email ?? 'LinkedIn sender';
}

/** Today's search_page budget for a sender (sender-local day). Falls back to the effective cap when no budget row exists yet. */
export function useSearchPageBudget(senderId: string | null | undefined) {
  return useQuery({
    queryKey: ['outreach', 'sender', senderId ?? '', 'search-page-budget'], enabled: !!senderId, refetchInterval: 60000,
    queryFn: async () => {
      const today = await rpc<Record<string, { used: number; reserved: number; cap: number }>>('sender_today', { p_sender: senderId });
      const row = today?.search_page;
      if (row) return { used: row.used, reserved: row.reserved, cap: row.cap, planned: true };
      const cap = await rpc<number>('effective_cap', { p_sender: senderId, p_type: 'search_page' });
      return { used: 0, reserved: 0, cap: Number(cap ?? 0), planned: false };
    },
  });
}

export function SenderPicker({ senders, allSenders, value, onChange, label = 'Sender', hint }: { senders: Sender[]; allSenders: Sender[]; value: string; onChange: (id: string) => void; label?: string; hint?: string }) {
  const notReady = allSenders.filter((s) => s.provider === 'LINKEDIN' && s.status !== 'ok');
  const selected = senders.find((s) => s.id === value);
  return (
    <div className="space-y-1.5">
      <Select label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{senders.length ? 'Choose a connected LinkedIn sender…' : 'No connected LinkedIn senders'}</option>
        {senders.map((s) => <option key={s.id} value={s.id}>{senderLabel(s)}{s.has_sales_nav ? ' · Sales Navigator' : ''}{s.warmup_level < 5 ? ` · warmup L${s.warmup_level}` : ''}</option>)}
      </Select>
      {selected && <div className="flex items-center gap-2 text-xs text-gray-500"><StatusPill status={selected.status} reason={selected.status_reason} /> {selected.timezone} · level {selected.warmup_level} · health {selected.health_score}</div>}
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
      {senders.length === 0 && notReady.length > 0 && <p className="text-xs text-amber-700">{notReady.length} LinkedIn sender{notReady.length === 1 ? ' is' : 's are'} not connected right now — fix them under Senders to use them for imports.</p>}
    </div>
  );
}
