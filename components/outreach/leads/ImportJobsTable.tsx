'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useImportJobs, useSenders } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import type { ImportJob, JobStatus } from '@/lib/outreach/types';
import { Badge, Button, EmptyState, ErrorBox, Modal, Spinner, Table, Td, Th, fmtDate, timeAgo } from '@/components/outreach/ui';
import { Pause, Play, XCircle, FileSpreadsheet, Search, Users } from 'lucide-react';
import { formatNumber, type ToastFn } from './helpers';

const STATUS_TONE: Record<JobStatus, 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo'> = { queued: 'blue', running: 'indigo', paused: 'amber', done: 'green', failed: 'red', cancelled: 'gray' };
const KIND_LABEL: Record<ImportJob['kind'], string> = { search_url: 'Search URL', csv: 'CSV', relations: 'Connections' };

function KindIcon({ kind }: { kind: ImportJob['kind'] }) {
  const cls = 'w-4 h-4 text-gray-400';
  return kind === 'csv' ? <FileSpreadsheet className={cls} /> : kind === 'relations' ? <Users className={cls} /> : <Search className={cls} />;
}

export function ImportJobsTable({ toast }: { toast: ToastFn }) {
  const { workspace, canWrite } = useWorkspace();
  const qc = useQueryClient();
  const jobs = useImportJobs(workspace?.id);
  const senders = useSenders(workspace?.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelJob, setCancelJob] = useState<ImportJob | null>(null);

  const update = async (job: ImportJob, patch: Partial<ImportJob>, msg: string) => {
    setBusy(job.id);
    try {
      const { error } = await supabase.from('outreach_import_jobs').update(patch).eq('id', job.id);
      if (error) throw error;
      if (workspace) qc.invalidateQueries({ queryKey: qk.imports(workspace.id) });
      toast(msg);
    } catch (e) {
      toast(parseError(e).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  if (jobs.isLoading) return <Spinner />;
  if (jobs.error) return <ErrorBox message={parseError(jobs.error).message} />;
  const rows = jobs.data ?? [];
  if (rows.length === 0) return <div className="bg-white border border-gray-200 rounded-xl"><EmptyState title="No imports yet" description="Jobs you start above appear here with live progress." /></div>;

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>Import</Th>
            <Th>Status</Th>
            <Th className="hidden md:table-cell">Sender</Th>
            <Th>Progress</Th>
            <Th className="hidden lg:table-cell">Leads</Th>
            <Th className="hidden lg:table-cell">Next run</Th>
            <Th className="hidden md:table-cell">Created</Th>
            {canWrite && <Th className="text-right">Actions</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((j) => {
            const sender = senders.data?.find((s) => s.id === j.sender_id);
            const pct = j.total_expected ? Math.min(100, Math.round((j.fetched / j.total_expected) * 100)) : null;
            const live = j.status === 'queued' || j.status === 'running';
            const label = j.kind === 'csv' ? String((j.params as { storage_path?: string }).storage_path ?? '').split('/').pop()?.replace(/^\d+-/, '') || 'CSV file'
              : j.kind === 'search_url' ? `${(j.params as { api?: string }).api === 'sales_navigator' ? 'Sales Navigator' : 'Classic'} people search` : '1st-degree connections';
            return (
              <tr key={j.id} className="align-top">
                <Td>
                  <div className="flex items-start gap-2 min-w-[180px]">
                    <KindIcon kind={j.kind} />
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate max-w-[260px]" title={label}>{label}</div>
                      <div className="text-xs text-gray-500">{KIND_LABEL[j.kind]}{j.kind === 'search_url' && (j.params as { url?: string }).url ? <> · <a href={(j.params as { url?: string }).url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">open search</a></> : null}</div>
                      {j.error && <div className="text-xs text-red-600 mt-0.5 max-w-[320px] break-words" title={j.error}>{j.error}</div>}
                    </div>
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-col gap-1 items-start">
                    <Badge tone={STATUS_TONE[j.status]}>{j.status}</Badge>
                    {j.capped && <Badge tone="amber" className="cursor-help"><span title="LinkedIn caps how many search results can be read; this job stopped at the cap.">capped</span></Badge>}
                  </div>
                </Td>
                <Td className="hidden md:table-cell"><span className="block max-w-[160px] truncate">{sender ? (sender.display_name ?? sender.public_identifier ?? 'Sender') : j.sender_id ? 'Removed sender' : '—'}</span></Td>
                <Td>
                  <div className="min-w-[140px]">
                    <div className="text-xs text-gray-700 tabular-nums">{formatNumber(j.fetched)}{j.total_expected != null ? ` / ${formatNumber(j.total_expected)}` : ''} fetched</div>
                    {pct != null && <div className="mt-1 h-1.5 w-full bg-gray-200 rounded-full overflow-hidden"><div className={`h-full ${j.status === 'failed' ? 'bg-red-500' : j.status === 'done' ? 'bg-green-500' : 'bg-indigo-500'}`} style={{ width: `${pct}%` }} /></div>}
                  </div>
                </Td>
                <Td className="hidden lg:table-cell text-xs whitespace-nowrap"><span className="text-green-700">{formatNumber(j.created_leads)} new</span> · <span className="text-gray-600">{formatNumber(j.updated_leads)} updated</span></Td>
                <Td className="hidden lg:table-cell text-xs text-gray-500 whitespace-nowrap">{live && j.next_run_at ? (new Date(j.next_run_at).getTime() <= Date.now() ? 'due now' : fmtDate(j.next_run_at)) : j.finished_at ? `finished ${timeAgo(j.finished_at)}` : '—'}</Td>
                <Td className="hidden md:table-cell text-xs text-gray-500 whitespace-nowrap">{timeAgo(j.created_at)}</Td>
                {canWrite && (
                  <Td className="text-right whitespace-nowrap">
                    {live && <Button size="sm" variant="secondary" loading={busy === j.id} onClick={() => update(j, { status: 'paused' }, 'Import paused')} title="Pause"><Pause className="w-3.5 h-3.5" /> Pause</Button>}
                    {j.status === 'paused' && <Button size="sm" variant="secondary" loading={busy === j.id} onClick={() => update(j, { status: 'queued', next_run_at: new Date().toISOString(), error: null }, 'Import resumed')} title="Resume"><Play className="w-3.5 h-3.5" /> Resume</Button>}
                    {(live || j.status === 'paused') && <Button size="sm" variant="ghost" className="text-red-600 ml-1" disabled={busy === j.id} onClick={() => setCancelJob(j)} title="Cancel"><XCircle className="w-3.5 h-3.5" /> Cancel</Button>}
                  </Td>
                )}
              </tr>
            );
          })}
        </tbody>
      </Table>
      <Modal open={!!cancelJob} onClose={() => setCancelJob(null)} title="Cancel this import?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setCancelJob(null)}>Keep running</Button><Button variant="danger" loading={!!cancelJob && busy === cancelJob.id} onClick={async () => { if (cancelJob) { await update(cancelJob, { status: 'cancelled', next_run_at: null, finished_at: new Date().toISOString() }, 'Import cancelled'); setCancelJob(null); } }}>Cancel import</Button></>}>
        <p className="text-sm text-gray-600">Leads already imported stay. The job cannot be resumed afterwards; start a new import instead.</p>
      </Modal>
    </>
  );
}
