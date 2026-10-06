'use client';

import { useEffect, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { ArrowDownLeft, ArrowUpRight, RefreshCw } from 'lucide-react';
import { PaginationBar } from '@/components/outreach/Pagination';
import { parseError } from '@/lib/outreach/api';
import { Badge, Button, ErrorBox, Spinner, Table, Td, Th, Toggle, fmtDate } from '@/components/outreach/ui';
import { SYNC_LOG_PAGE_SIZE, useSyncLog } from './hooks';
import { opLabel, plainCrmError } from './crm';

/** The visible sync log: every push and pull, with the reason when something was skipped or failed. */
export default function SyncLogTable({ integrationId, provider }: { integrationId: string; provider: string }) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [page, setPage] = useState(0);
  const log = useSyncLog(integrationId, errorsOnly, page);
  const rows = log.data?.rows ?? [];
  const total = log.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / SYNC_LOG_PAGE_SIZE));
  const from = total === 0 ? 0 : page * SYNC_LOG_PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * SYNC_LOG_PAGE_SIZE);
  useEffect(() => { setPage(0); }, [integrationId, errorsOnly]);
  // The log can shrink under the open page (a refetch, a cleanup): step back to the last page that has rows.
  useEffect(() => { if (log.data && page > pageCount - 1) setPage(pageCount - 1); }, [log.data, page, pageCount]);
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div><div className="text-sm font-semibold text-gray-900">Sync log</div><div className="text-xs text-gray-500">Every operation, newest first. Skipped means the lead did not match your &ldquo;who gets synced&rdquo; rule yet.</div></div>
        <div className="flex items-center gap-3"><Toggle checked={errorsOnly} onChange={setErrorsOnly} label="Errors only" /><Button size="sm" variant="secondary" onClick={() => log.refetch()} loading={log.isFetching} aria-label="Refresh the sync log"><RefreshCw className="w-3.5 h-3.5" /></Button></div>
      </div>
      {log.isLoading ? <Spinner /> : log.isError ? <ErrorBox message={parseError(log.error).message} /> : !rows.length ? (
        <div className="text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg px-4 py-6 text-center">{errorsOnly ? 'No errors. Every operation went through.' : 'Nothing synced yet. With the default rule the first entry appears when a lead replies.'}</div>
      ) : (
        <>
          <div className={log.isPlaceholderData ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <Table>
              <thead><tr><Th>Time</Th><Th>Direction</Th><Th>Operation</Th><Th>Lead</Th><Th>Status</Th><Th>Detail</Th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap">{fmtDate(r.at)}</Td>
                    <Td className="whitespace-nowrap">{r.direction === 'push' ? <span className="inline-flex items-center gap-1 text-gray-700"><ArrowUpRight className="w-3.5 h-3.5 text-indigo-500" /> To CRM</span> : <span className="inline-flex items-center gap-1 text-gray-700"><ArrowDownLeft className="w-3.5 h-3.5 text-green-600" /> From CRM</span>}</Td>
                    <Td className="whitespace-nowrap">{opLabel(r.op)}</Td>
                    <Td className="max-w-[180px] truncate">{r.lead_id ? <Link href={`/outreach/leads/${r.lead_id}`} className="text-indigo-600 hover:underline">{r.outreach_leads?.full_name ?? 'Open lead'}</Link> : <span className="text-gray-300">—</span>}</Td>
                    <Td><Badge tone={r.status === 'ok' ? 'green' : r.status === 'error' ? 'red' : 'gray'}>{r.status === 'ok' ? 'Done' : r.status === 'error' ? 'Error' : 'Skipped'}</Badge></Td>
                    <Td className="max-w-[320px] text-xs text-gray-600" title={r.detail ?? undefined}>{r.status === 'error' ? plainCrmError(r.detail, provider) : r.detail ?? ''}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <PaginationBar page={page} pageCount={pageCount} setPage={(p) => setPage(Math.max(0, Math.min(pageCount - 1, p)))} total={total} from={from} to={to} />
        </>
      )}
    </div>
  );
}
