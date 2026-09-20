'use client';

import React, { useState } from 'react';
import { Filter } from 'lucide-react';
import { EmptyState, Select } from '@/components/outreach/ui';
import { useLists, useSenders, useSequences, useTags } from '@/lib/outreach/queries';
import { FUNNEL_LABELS, csvFileName, downloadCsv, fmtRange, useReportFunnel, type FunnelFilters, type FunnelStage } from '@/lib/outreach/reports';
import { ChartSkeleton, ExportButton, MetricLabel, Refreshing, RetryError, Section } from './primitives';
import { FunnelBars } from './charts';
import type { TabProps } from './OverviewTab';

export default function FunnelTab({ ws, client, range }: TabProps) {
  const [filters, setFilters] = useState<FunnelFilters>({});
  const sequences = useSequences(ws); const senders = useSenders(ws); const lists = useLists(ws); const tags = useTags(ws);
  const q = useReportFunnel({ ws, client, range }, filters);
  const set = (k: keyof FunnelFilters) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters((f) => ({ ...f, [k]: e.target.value || undefined }));
  const filtered = Object.values(filters).some(Boolean);

  const seqOptions = (sequences.data ?? []).filter((s) => s.status !== 'archived' && (!client || s.client_id === client));
  const senderOptions = (senders.data ?? []).filter((s) => !client || s.client_id === client);

  const exportCsv = () => downloadCsv<FunnelStage>(csvFileName('funnel', range), [
    { header: 'Stage', value: (s) => FUNNEL_LABELS[s.stage] }, { header: 'Leads', value: (s) => s.count }, { header: '% of enrolled', value: (s) => s.pct_of_enrolled },
    { header: '% of previous step', value: (s) => s.pct_of_previous }, { header: 'Median hours from previous step', value: (s) => s.median_hours_from_previous },
  ], q.data?.stages ?? []);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Select label="Sequence" value={filters.sequence_id ?? ''} onChange={set('sequence_id')}><option value="">All sequences</option>{seqOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Select label="Sender" value={filters.sender_id ?? ''} onChange={set('sender_id')}><option value="">All senders</option>{senderOptions.map((s) => <option key={s.id} value={s.id}>{s.display_name ?? 'Unnamed sender'}</option>)}</Select>
        <Select label="List" value={filters.list_id ?? ''} onChange={set('list_id')}><option value="">All lists</option>{(lists.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
        <Select label="Tag" value={filters.tag_id ?? ''} onChange={set('tag_id')}><option value="">All tags</option>{(tags.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
      </div>

      {q.isLoading ? <ChartSkeleton height={360} /> : q.isError ? <RetryError error={q.error} onRetry={() => q.refetch()} /> : !q.data ? null : (
        <Refreshing active={q.isPlaceholderData}>
          <Section
            title={<MetricLabel metric="funnel">Funnel of leads enrolled {fmtRange(range)}</MetricLabel>}
            description="This follows the leads enrolled in the period through every later stage, whenever that stage happened. A lead enrolled on the last day can still reply next week and will then show up here."
            actions={<ExportButton onClick={exportCsv} disabled={!q.data.cohort} />}>
            {!q.data.cohort ? (
              <EmptyState icon={<Filter className="w-6 h-6" />} title="No leads were enrolled in this period"
                description={filtered ? 'Clear a filter or pick a longer range. The funnel only counts leads whose enrolment date falls inside the range.' : 'Pick a longer range. The funnel only counts leads whose enrolment date falls inside the range.'} />
            ) : (
              <>
                <div className="grid grid-cols-[150px_1fr] gap-4 mb-2">
                  <span />
                  <div className="flex items-center gap-3"><span className="flex-1" />
                    <div className="w-[230px] grid grid-cols-[70px_80px_80px] text-right text-[11px] font-semibold uppercase tracking-wide text-gray-500"><span>Leads</span><span>Of enrolled</span><span>Of previous</span></div>
                  </div>
                </div>
                <FunnelBars stages={q.data.stages} />
              </>
            )}
          </Section>
        </Refreshing>
      )}
    </div>
  );
}
