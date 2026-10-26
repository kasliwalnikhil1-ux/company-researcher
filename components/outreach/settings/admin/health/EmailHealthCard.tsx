'use client';

// Platform admin → Health: the email path (custom-sending-domain-PRD.md §8.3): domains by state, fallback rate, bounce and
// complaint rates, outbox backlog, the auth hook.
import { Mail } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { useEmailPlatformStats } from '@/lib/outreach/emailSending';
import { Card, ErrorBox, Spinner } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';

const pct = (num: number, den: number) => (den > 0 ? `${((100 * num) / den).toFixed(1)}%` : '—');

function Tile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2.5">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={cn('text-lg font-semibold tabular-nums', warn ? 'text-red-700' : 'text-gray-900')}>{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

export default function EmailHealthCard() {
  const q = useEmailPlatformStats();
  if (q.isLoading) return <Card title="Email"><Spinner /></Card>;
  if (q.isError) return <Card title="Email"><ErrorBox message={parseError(q.error).message} /></Card>;
  const s = q.data!;
  const brandTotal = (s.brand_7d ?? 0) + (s.fell_back_7d ?? 0);
  const sent7 = Math.max(brandTotal, (s.bounced_7d ?? 0) + (s.complained_7d ?? 0), 1);
  const domains = Object.entries(s.domains ?? {}).filter(([k]) => k !== 'removed');
  return (
    <Card title={<span className="flex items-center gap-2"><Mail className="w-4 h-4" /> Email</span>}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Outbox backlog" value={String(s.outbox_backlog ?? 0)} sub={`${s.outbox_overdue ?? 0} overdue by 5 min+`} warn={(s.outbox_overdue ?? 0) > 0} />
        <Tile label="Sent (24 h)" value={String(s.sent_24h ?? 0)} sub={`${s.failed_24h ?? 0} failed`} warn={(s.failed_24h ?? 0) > 0} />
        <Tile label="Fallback rate (7 d)" value={pct(s.fell_back_7d ?? 0, brandTotal)} sub={`${s.fell_back_7d ?? 0} of ${brandTotal} brand emails from GrowthxAI instead`} warn={brandTotal > 0 && (s.fell_back_7d ?? 0) / brandTotal > 0.2} />
        <Tile label="Bounces · complaints (7 d)" value={`${pct(s.bounced_7d ?? 0, sent7)} · ${pct(s.complained_7d ?? 0, sent7)}`} sub={`${s.bounced_7d ?? 0} bounced, ${s.complained_7d ?? 0} complaints`} warn={(s.complained_7d ?? 0) >= 3} />
        <Tile label="Auth hook (24 h)" value={`${s.auth_sent_24h ?? 0} sent`} sub={`${s.auth_failed_24h ?? 0} failed`} warn={(s.auth_failed_24h ?? 0) > 0} />
        <div className="rounded-lg border border-gray-200 px-3 py-2.5 col-span-2 md:col-span-3">
          <div className="text-xs text-gray-500">Customer domains by state</div>
          <div className="text-sm text-gray-900 mt-1">{domains.length ? domains.map(([k, n]) => `${k}: ${n}`).join(' · ') : 'None yet'}</div>
        </div>
      </div>
    </Card>
  );
}
