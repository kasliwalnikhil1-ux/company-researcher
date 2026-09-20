'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Info } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { Button, Table, Td, Th } from '@/components/outreach/ui';
import { csvFileName, downloadCsv, fmtInt, fmtMoney, fmtMultiple, useReportCost, type CostReport } from '@/lib/outreach/reports';
import { ExportButton, KpiTile, Refreshing, RetryError, Section, TableSkeleton, TilesSkeleton } from './primitives';
import type { TabProps } from './OverviewTab';

function DefaultCostEditor({ report, onNotice }: { report: CostReport; onNotice: (m: string, t?: 'success' | 'error') => void }) {
  const { workspace, isOwner, refresh } = useWorkspace();
  const qc = useQueryClient();
  const current = report.default_sender_monthly_cost;
  const [value, setValue] = useState(current === null ? '' : String(current));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValue(current === null ? '' : String(current)); }, [current]);

  const parsed = value.trim() === '' ? null : Number(value);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000);
  const dirty = parsed !== current;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace || invalid || !dirty) return;
    setBusy(true);
    try {
      const next: Record<string, unknown> = { ...(workspace.settings ?? {}) };
      if (parsed === null) delete next.sender_monthly_cost; else next.sender_monthly_cost = parsed;
      const { error } = await supabase.from('outreach_workspaces').update({ settings: next }).eq('id', workspace.id);
      if (error) throw error;
      await refresh();
      await qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'reports', 'cost'] });
      onNotice('Default sender cost saved.');
    } catch (er) { onNotice(parseError(er).message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Section title="What a sender costs" description="Used for every sender that has no cost of its own. Count the LinkedIn seat, this platform and anything else you pay per account each month.">
      {isOwner ? (
        <form onSubmit={save} className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 mb-1">Default monthly cost per sender ({report.currency})</span>
            <input type="number" inputMode="decimal" min={0} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} placeholder="For example 99" aria-invalid={invalid}
              className="w-48 px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </label>
          <Button type="submit" loading={busy} disabled={invalid || !dirty}>Save</Button>
          {invalid && <span className="text-xs text-red-600 pb-2.5">Enter an amount between 0 and 100,000.</span>}
        </form>
      ) : <p className="text-sm text-gray-700">Default monthly cost per sender: <span className="font-medium tabular-nums">{current === null ? 'not set' : fmtMoney(current, report.currency)}</span>. Only an owner can change it.</p>}
      <p className="text-xs text-gray-500 mt-3">A sender can have its own monthly cost. Set it on the sender’s page under <Link href="/outreach/senders" className="underline">Senders</Link>, and it replaces the default for that sender.</p>
    </Section>
  );
}

export default function CostTab({ ws, client, range, onNotice }: TabProps & { onNotice: (m: string, t?: 'success' | 'error') => void }) {
  const q = useReportCost({ ws, client, range });
  if (q.isLoading) return <div className="space-y-6"><TilesSkeleton count={4} /><TableSkeleton cols={4} rows={3} /></div>;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  if (!r) return null;
  const cur = r.currency;
  const showReturn = r.won_value !== null && r.won_value !== undefined;
  const per = (n: number, what: string) => `${fmtInt(n)} ${what}`;

  const exportCsv = () => downloadCsv(csvFileName('cost', range, 'per-sender'), [
    { header: 'Sender', value: (s) => s.name }, { header: `Monthly cost (${cur})`, value: (s) => s.monthly_cost }, { header: 'Days connected in the period', value: (s) => s.days }, { header: `Cost in the period (${cur})`, value: (s) => s.cost },
  ], r.per_sender);

  return (
    <Refreshing active={q.isPlaceholderData}>
      <div className="space-y-6">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <KpiTile label="Cost per reply" metric="cost_per_reply" value={fmtMoney(r.cost_per_reply, cur)} sub={per(r.replies, r.replies === 1 ? 'reply' : 'replies')} />
          <KpiTile label="Cost per interested reply" value={fmtMoney(r.cost_per_interested, cur)} sub={per(r.interested, 'interested')} />
          <KpiTile label="Cost per meeting" value={fmtMoney(r.cost_per_meeting, cur)} sub={per(r.meetings, r.meetings === 1 ? 'meeting' : 'meetings')} />
          <KpiTile label="Sender cost in this period" value={fmtMoney(r.cost, cur)} sub={`${fmtInt(r.senders)} ${r.senders === 1 ? 'sender' : 'senders'}${r.senders_without_cost > 0 ? `, ${fmtInt(r.senders_without_cost)} without a cost` : ''}`} />
        </div>

        {showReturn ? (
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <KpiTile label="Won value" metric="won" value={fmtMoney(r.won_value, cur)} sub={per(r.won, r.won === 1 ? 'deal won' : 'deals won')} />
            <KpiTile label="Return" value={fmtMultiple(r.return_multiple)} sub="Won value ÷ sender cost" />
          </div>
        ) : r.note ? (
          <div className="flex items-start gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700"><Info className="w-4 h-4 mt-0.5 text-gray-400 flex-shrink-0" /><span>{r.note}</span></div>
        ) : null}
        {showReturn && r.note && <div className="flex items-start gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700"><Info className="w-4 h-4 mt-0.5 text-gray-400 flex-shrink-0" /><span>{r.note}</span></div>}

        <DefaultCostEditor report={r} onNotice={onNotice} />

        <Section title="Cost per sender" description="Monthly cost × days connected in the period ÷ 30." actions={<ExportButton onClick={exportCsv} disabled={!r.per_sender.length} />}>
          {!r.per_sender.length ? <p className="text-sm text-gray-500">No sender was connected in this period.</p> : (
            <Table>
              <thead><tr><Th>Sender</Th><Th className="text-right">Monthly cost</Th><Th className="text-right">Days connected</Th><Th className="text-right">Cost in the period</Th></tr></thead>
              <tbody>{r.per_sender.map((s) => (
                <tr key={s.sender_id}>
                  <Td><Link href={`/outreach/senders/${s.sender_id}`} className="font-medium text-gray-900 hover:underline">{s.name ?? 'Unnamed sender'}</Link></Td>
                  <Td className="text-right">{s.monthly_cost === null ? <span className="text-gray-400">Not set</span> : <span className="tabular-nums">{fmtMoney(s.monthly_cost, cur)}</span>}</Td>
                  <Td className="text-right tabular-nums">{fmtInt(s.days)}</Td>
                  <Td className="text-right tabular-nums">{fmtMoney(s.cost, cur)}</Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Section>
      </div>
    </Refreshing>
  );
}
