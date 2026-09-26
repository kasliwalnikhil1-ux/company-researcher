'use client';

// QA score beside the acceptance rate per sender (PRD §8.4): the evidence for re-weighting the checks.
import Link from 'next/link';
import { Avatar, EmptyState, HealthBar, Spinner, Table, Td, Th } from '@/components/outreach/ui';
import { useQaCorrelation } from '@/lib/outreach/profile';
import { QaScoreBadge } from './QaCard';

export default function InsightsPanel({ ws }: { ws: string }) {
  const q = useQaCorrelation(ws);
  const rows = q.data ?? [];
  const withBoth = rows.filter((r) => r.qa != null && r.acceptance_rate != null);
  const hi = withBoth.filter((r) => (r.qa ?? 0) >= 70), lo = withBoth.filter((r) => (r.qa ?? 0) < 70);
  const avg = (xs: typeof rows) => (xs.length ? (xs.reduce((a, r) => a + (r.acceptance_rate ?? 0), 0) / xs.length).toFixed(1) : null);
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 max-w-2xl">Acceptance depends on who you target, what the note says, and what the prospect sees when they click the profile. This compares the profile score with the 30-day acceptance rate so the checks can be re-weighted on evidence rather than opinion.</p>
      {withBoth.length >= 4 && (
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <div className="rounded-xl border border-gray-200 bg-white p-3"><div className="text-xs text-gray-500">Profile score ≥ 70 ({hi.length})</div><div className="text-xl font-semibold text-gray-900">{avg(hi) ?? '—'}%</div><div className="text-[11px] text-gray-500">average acceptance</div></div>
          <div className="rounded-xl border border-gray-200 bg-white p-3"><div className="text-xs text-gray-500">Profile score &lt; 70 ({lo.length})</div><div className="text-xl font-semibold text-gray-900">{avg(lo) ?? '—'}%</div><div className="text-[11px] text-gray-500">average acceptance</div></div>
        </div>
      )}
      {q.isLoading ? <Spinner /> : rows.length === 0 ? <EmptyState title="No LinkedIn senders" /> : (
        <Table>
          <thead><tr><Th>Sender</Th><Th>Profile</Th><Th>Health</Th><Th className="text-right">Invites (30d)</Th><Th className="text-right">Accepted</Th><Th className="text-right">Acceptance</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sender_id}>
                <Td><Link href={`/outreach/senders/${r.sender_id}?tab=Profile`} className="flex items-center gap-2 text-gray-900 hover:text-indigo-700"><Avatar name={r.name} size={6} /><span className="font-medium">{r.name ?? 'Sender'}</span></Link></Td>
                <Td><QaScoreBadge score={r.qa} /></Td>
                <Td><HealthBar score={r.health} /></Td>
                <Td className="text-right tabular-nums">{r.invites_30d}</Td>
                <Td className="text-right tabular-nums">{r.accepted_30d}</Td>
                <Td className="text-right tabular-nums">{r.acceptance_rate == null ? <span className="text-gray-400" title="Fewer than 10 invitations">n/a</span> : `${r.acceptance_rate}%`}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
