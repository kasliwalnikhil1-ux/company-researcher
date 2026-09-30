'use client';

import { useCallback, useMemo } from 'react';
import { Download, History, RefreshCw } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { useSenders, useSequences } from '@/lib/outreach/queries';
import { usePersistedFilters } from '@/lib/outreach/persistedFilters';
import { Button, Card, EmptyState, ErrorBox, Spinner } from '@/components/outreach/ui';
import { useStageLabels } from '../useStageLabels';
import ActivityFilters from './ActivityFilters';
import RunsTable from './RunsTable';
import RunDrawer from './RunDrawer';
import { RUN_FILTER_DEFAULTS, exportRunsCsv, matchesText, toRpcFilters, useRunsPaged } from './runsData';

/** Every AI reply run, filterable and exportable. `openRunId` (from the URL) shows the run drawer. */
export default function ActivityPanel({ ws, openRunId, onOpenRun }: {
  ws: string; openRunId: string | null; onOpenRun: (id: string | null) => void;
}) {
  const { filters: f, patch, reset, ready } = usePersistedFilters('ai-runs', ws, RUN_FILTER_DEFAULTS, { omit: ['q'] });
  const rpcFilters = useMemo(() => toRpcFilters(f), [f]);
  const q = useRunsPaged(ready ? ws : null, rpcFilters);
  const senders = useSenders(ws);
  const sequences = useSequences(ws);
  const { stages, labels } = useStageLabels(ws);

  const loaded = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items ?? []), [q.data]);
  const rows = useMemo(() => loaded.filter((r) => matchesText(r, f.q)), [loaded, f.q]);
  const closeDrawer = useCallback(() => onOpenRun(null), [onOpenRun]);

  return (
    <Card title="Activity"
      actions={(
        <>
          <Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching} aria-label="Refresh"><RefreshCw className={q.isFetching ? 'w-3.5 h-3.5 animate-spin' : 'w-3.5 h-3.5'} />Refresh</Button>
          <Button size="sm" variant="secondary" disabled={!rows.length} onClick={() => exportRunsCsv(rows, labels)} title="Downloads the rows loaded below">
            <Download className="w-3.5 h-3.5" />Export CSV
          </Button>
        </>
      )}>
      <div className="space-y-4">
        <ActivityFilters f={f} patch={patch} reset={reset} stages={stages}
          senders={(senders.data ?? []).map((s) => ({ id: s.id, label: s.display_name || s.public_identifier || 'Sender' }))}
          sequences={(sequences.data ?? []).map((s) => ({ id: s.id, label: s.name }))} />

        {(!ready || q.isLoading) && <Spinner />}
        {q.error && <ErrorBox message={parseError(q.error).message} />}
        {ready && !q.isLoading && !q.error && rows.length === 0 && (
          <EmptyState icon={<History className="w-6 h-6" />} title={loaded.length ? 'No loaded runs match the search' : 'No AI replies yet'}
            description={loaded.length ? 'Clear the search box or load more runs.' : 'Runs appear here when a lead replies on LinkedIn and AI Auto Replies are on.'} />
        )}
        {rows.length > 0 && <RunsTable rows={rows} stageLabels={labels} onOpen={(id) => onOpenRun(id)} />}

        <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
          <span>{loaded.length ? `${rows.length === loaded.length ? loaded.length : `${rows.length} of ${loaded.length}`} runs loaded` : ''}</span>
          {q.hasNextPage && <Button size="sm" variant="secondary" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>Load more</Button>}
        </div>
      </div>

      {openRunId && <RunDrawer key={openRunId} runId={openRunId} stageLabels={labels} onClose={closeDrawer} />}
    </Card>
  );
}
