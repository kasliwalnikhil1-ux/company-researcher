'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil } from 'lucide-react';
import { rpc } from '@/lib/outreach/api';
import { Button, Card, ErrorBox, Input, Modal, Spinner, Table, Td, Th, timeAgo, useToast } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { fillLink, fmtUsage, type HealthUsage as Usage, type UsageRow } from '@/lib/outreach/health';
import Link from '@/lib/outreach/nav';

const GROUP_LABEL: Record<string, string> = { supabase: 'Supabase plan', functions: 'Edge Functions', cron: 'Scheduled jobs', linkedin: 'LinkedIn through the channel provider, per account' };

function ManualModal({ row, onClose, onDone }: { row: UsageRow | null; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState('');
  const { show, node } = useToast();
  const m = useMutation({
    mutationFn: () => {
      const n = Number(v.replace(/,/g, ''));
      if (!Number.isFinite(n) || n < 0) throw new Error('Enter a number');
      // bytes are typed in GB on the Usage page
      return rpc('health_set_manual_usage', { p_key: row!.key, p_value: row!.unit === 'bytes' ? Math.round(n * 1024 ** 3) : Math.round(n) });
    },
    onSuccess: () => { onDone(); onClose(); },
    onError: (e: Error) => show(e.message, 'error'),
  });
  if (!row) return null;
  return (
    <Modal open={!!row} onClose={onClose} title={row.label} size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending}>Save</Button></>}>
      <p className="text-sm text-gray-600 mb-3">Open Supabase → Usage, choose the current billing period, and type the number here. Health keeps it and shows the trend.</p>
      <Input label={row.unit === 'bytes' ? 'Used this period (GB)' : 'Used this period'} value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" autoFocus />
      <a href={fillLink('https://supabase.com/dashboard/org/{org}/usage')} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-3 text-sm text-indigo-600 hover:underline"><ExternalLink className="w-3.5 h-3.5" /> Open Usage in Supabase</a>
      {node}
    </Modal>
  );
}

export default function HealthUsage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['health-usage'], queryFn: () => rpc<Usage>('health_usage'), refetchInterval: 120_000 });
  const [manual, setManual] = useState<UsageRow | null>(null);
  const { show, node } = useToast();
  const recheck = useMutation({ mutationFn: () => rpc('health_recheck_limits'), onSuccess: () => { qc.invalidateQueries({ queryKey: ['health-usage'] }); show('Marked as rechecked today.'); }, onError: (e: Error) => show(e.message, 'error') });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorBox message={(q.error as Error).message} />;
  const u = q.data!;
  const groups = [...new Set(u.rows.map((r) => r.grp))];
  const pctTone = (p: number | null) => p == null ? '' : p >= 85 ? 'text-red-700' : p >= 70 ? 'text-amber-700' : 'text-gray-900';
  return (
    <div className="space-y-6">
      {u.upgrade && (
        <Card title="Do I need to upgrade?">
          <p className="text-sm text-gray-900">{u.upgrade.text}</p>
          <details className="mt-2"><summary className="text-xs text-indigo-600 cursor-pointer">How this is decided</summary>
            <ul className="text-xs text-gray-600 mt-1 space-y-0.5 list-disc pl-4">
              <li>No: no rule below is met.</li>
              <li>Fix first: a rule is met and Slow queries (db-3), Stuck queries (db-4) or Advisor findings (db-9) is amber or red. Named: {String(u.upgrade.reasons?.fix_first ?? 'none')}.</li>
              <li>Go up one compute size: with those three green, CPU over 80% for more than an hour, memory over 85% or swap in use, or connections at 80%, on 3 of the last 7 days. Busy days seen: {String(u.upgrade.reasons?.heavy_days_of_7 ?? 0)} of 7.</li>
              <li>Move from Free to Pro: the project is on Free with paying customers, or a Free limit is past 70%. Plan: {u.plan}.</li>
              <li>Expect a higher bill: a limit that only costs money will pass its included amount this month. {JSON.stringify(u.upgrade.reasons?.usage_over ?? [])}</li>
            </ul>
            <div className="text-[11px] text-gray-400 mt-1">Worked out {timeAgo(u.upgrade.at)}.</div>
          </details>
        </Card>
      )}
      <Card title={`Limits on the ${u.plan === 'free' ? 'Free' : 'Pro'} plan, ${u.compute_size} compute`} actions={<div className="flex items-center gap-2 text-xs text-gray-500">{u.recheck_due && <span className="text-amber-800">Prices and quotas were last checked over a month ago.</span>}<Button size="sm" variant="secondary" onClick={() => recheck.mutate()} loading={recheck.isPending}>Mark as rechecked</Button></div>}>
        <p className="text-xs text-gray-500 mb-3">Plan and compute size are chosen once in Settings. &quot;Reached on&quot; is at the last 7 days&apos; rate. Egress and the two Realtime numbers have no API: type them in from Supabase → Usage (the daily email reminds you weekly).{u.manual_age_days != null && ` The by-hand numbers are ${u.manual_age_days} days old.`}</p>
        {groups.map((g) => (
          <div key={g} className="mb-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">{GROUP_LABEL[g] ?? g}</div>
            <div className="overflow-x-auto">
              <Table>
                <thead><tr><Th>Limit</Th><Th className="text-right">Used</Th><Th className="text-right">Of</Th><Th className="text-right">%</Th><Th>Reached on</Th><Th>How it is measured</Th><Th></Th></tr></thead>
                <tbody>
                  {u.rows.filter((r) => r.grp === g).map((r) => (
                    <tr key={r.key + r.plan}>
                      <Td className="text-gray-900">{r.label}{r.note && <div className="text-[11px] text-gray-400">{r.note}</div>}</Td>
                      <Td className="text-right tabular-nums">{r.measured_by === 'fixed' ? <span className="text-gray-300">—</span> : r.used == null ? <span className="text-gray-400">{r.manual ? 'not entered' : '—'}</span> : fmtUsage(r.used, r.unit)}</Td>
                      <Td className="text-right tabular-nums text-gray-600">{r.limit == null ? <span className="text-gray-300">—</span> : fmtUsage(r.limit, r.unit)}{r.unit && !['bytes', 'count'].includes(r.unit) && <span className="text-gray-400"> {r.unit}</span>}</Td>
                      <Td className={cn('text-right tabular-nums', pctTone(r.pct))}>{r.pct == null ? '' : `${r.pct}%`}</Td>
                      <Td className="text-gray-600">{r.reached_on ? new Date(r.reached_on).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : r.month_estimate != null ? `on track for ${fmtUsage(r.month_estimate, r.unit)}` : ''}</Td>
                      <Td className="text-gray-500 text-xs">{r.measured_by}{r.manual && r.used_manual_at && <div className="text-[11px] text-gray-400">entered {timeAgo(r.used_manual_at)}</div>}</Td>
                      <Td className="whitespace-nowrap">{r.manual && <Button size="sm" variant="ghost" onClick={() => setManual(r)}><Pencil className="w-3.5 h-3.5" /> Enter</Button>}{r.source_url && <a href={fillLink(r.source_url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline ml-1" title={`Source, checked ${r.checked_on ?? '?'}`}><ExternalLink className="w-3 h-3" /></a>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </div>
        ))}
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Compute sizes</div>
        <Table>
          <thead><tr><Th>Size</Th><Th className="text-right">Direct connections</Th><Th>Note</Th></tr></thead>
          <tbody>{u.compute.map((c) => <tr key={c.key} className={cn(c.key === `compute_${u.compute_size}` && 'bg-indigo-50/40')}><Td className="text-gray-900">{c.label}{c.key === `compute_${u.compute_size}` && <span className="ml-2 text-[11px] text-indigo-700">current · {u.connections.in_use} of {u.connections.max} in use</span>}</Td><Td className="text-right tabular-nums">{c.connections}</Td><Td className="text-gray-600 text-xs">{c.note}</Td></tr>)}</tbody>
        </Table>
        <a href="https://supabase.com/docs/guides/platform/compute-and-disk" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-2 text-xs text-indigo-600 hover:underline"><ExternalLink className="w-3 h-3" /> Larger sizes in Supabase&apos;s compute table</a>
      </Card>
      <Card title="Customers near their own limits">
        <p className="text-xs text-gray-500 mb-3">Workspaces at 80% or more of their senders, seats, AI allowance or voice minutes: a list of customers to talk to about a bigger plan. &quot;AI stopped&quot; rows never turn a platform check red; their key or allowance is theirs to fix.</p>
        {u.customers.length === 0 ? <div className="text-sm text-gray-500">Nobody is near a limit.</div> : (
          <Table>
            <thead><tr><Th>Workspace</Th><Th>Plan</Th><Th>Near</Th><Th></Th></tr></thead>
            <tbody>{u.customers.map((c) => <tr key={c.workspace_id}><Td className="text-gray-900">{c.workspace}{c.ai_stopped && <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-red-50 text-red-700">AI has stopped</span>}</Td><Td>{c.plan}</Td><Td className="text-gray-700">{c.flags.join(' · ')}</Td><Td><Link href={`/outreach/settings/admin?workspace=${c.workspace_id}`} className="text-xs text-indigo-600 hover:underline">Open</Link></Td></tr>)}</tbody>
          </Table>
        )}
      </Card>
      <ManualModal row={manual} onClose={() => setManual(null)} onDone={() => qc.invalidateQueries({ queryKey: ['health-usage'] })} />
      {node}
    </div>
  );
}
