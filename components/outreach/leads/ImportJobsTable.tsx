'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useImportJobs, useSenders } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import type { ImportJob, JobStatus } from '@/lib/outreach/types';
import { Badge, Button, EmptyState, ErrorBox, Modal, Spinner, Table, Td, Th, fmtDate, timeAgo } from '@/components/outreach/ui';
import { AlertCircle, Building2, MessageSquare, Pause, Play, ThumbsUp, XCircle, FileSpreadsheet, Search, Users } from 'lucide-react';
import { importKindLabel } from '@/lib/outreach/intel';
import { formatNumber, type ToastFn } from './helpers';

const STATUS_TONE: Record<JobStatus, 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo'> = { queued: 'blue', running: 'indigo', paused: 'amber', done: 'green', failed: 'red', cancelled: 'gray' };

type JobRow = ImportJob & { mode?: 'upsert' | 'update_only'; update_fields?: string[]; enrich?: boolean; schedule_id?: string | null };
interface JobParams { storage_path?: string; api?: string; url?: string; post_url?: string; name?: string | null; companies?: unknown[]; only_replied?: boolean; repeat_run?: number; _state?: { not_found?: number | string[]; row_errors?: number; first_row_error?: string | null; company_name?: string | null; idx?: number } }

function KindIcon({ kind }: { kind: string }) {
  const cls = 'w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5';
  if (kind === 'csv') return <FileSpreadsheet className={cls} />;
  if (kind === 'relations') return <Users className={cls} />;
  if (kind === 'post_engagement') return <ThumbsUp className={cls} />;
  if (kind === 'conversations') return <MessageSquare className={cls} />;
  if (kind === 'company_people') return <Building2 className={cls} />;
  return <Search className={cls} />;
}

function jobLabel(j: JobRow): string {
  const p = j.params as JobParams;
  const kind: string = j.kind;
  if (kind === 'csv') return String(p.storage_path ?? '').split('/').pop()?.replace(/^\d+-/, '') || 'CSV file';
  if (kind === 'search_url') return `${p.api === 'sales_navigator' ? 'Sales Navigator' : 'Classic'} people search`;
  if (kind === 'relations') return '1st-degree connections';
  if (kind === 'post_engagement') return 'People who engaged with a post';
  if (kind === 'conversations') return p.only_replied ? 'Conversations where they replied' : 'All conversations without a lead';
  if (kind === 'sn_saved_search' || kind === 'sn_lead_list') return p.name || importKindLabel(kind);
  if (kind === 'company_people') return `People in ${Array.isArray(p.companies) ? p.companies.length : 0} companies`;
  return importKindLabel(kind);
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
          {(rows as JobRow[]).map((j) => {
            const sender = senders.data?.find((s) => s.id === j.sender_id);
            const pct = j.total_expected ? Math.min(100, Math.round((j.fetched / j.total_expected) * 100)) : null;
            const live = j.status === 'queued' || j.status === 'running';
            const label = jobLabel(j);
            const p = j.params as JobParams;
            const st = p._state ?? {};
            const link = (j.kind as string) === 'post_engagement' ? p.post_url : j.kind === 'search_url' ? p.url : undefined;
            const notFound = Array.isArray(st.not_found) ? st.not_found.length : Number(st.not_found ?? 0);
            const failed = j.status === 'failed';
            return (
              <tr key={j.id} className="align-top">
                <Td>
                  <div className="flex items-start gap-2 min-w-[180px]">
                    <KindIcon kind={j.kind} />
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate max-w-[260px]" title={label}>{label}</div>
                      <div className="text-xs text-gray-500">{importKindLabel(j.kind)}{link && /^https:\/\//i.test(link) ? <> · <a href={link} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">{(j.kind as string) === 'post_engagement' ? 'open post' : 'open search'}</a></> : null}</div>
                      {(j.mode === 'update_only' || j.enrich || j.schedule_id) && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {j.mode === 'update_only' && <Badge tone="purple"><span title={j.update_fields?.length ? `Columns: ${j.update_fields.join(', ')}` : undefined}>Update only</span></Badge>}
                          {j.enrich && <Badge tone="indigo">Enrich after import</Badge>}
                          {j.schedule_id && <Badge tone="blue">Repeating{p.repeat_run ? ` · run ${p.repeat_run}` : ''}</Badge>}
                        </div>
                      )}
                      {/* The real reason, as the worker wrote it. Failed jobs say why; running jobs with a message are waiting on something. */}
                      {j.error && (
                        <div role={failed ? 'alert' : undefined} className={`mt-1 flex items-start gap-1.5 text-xs max-w-[360px] break-words rounded-md px-2 py-1 ${failed ? 'bg-red-50 text-red-700 border border-red-100' : 'bg-amber-50 text-amber-800 border border-amber-100'}`}>
                          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /><span>{failed ? 'Failed: ' : ''}{j.error}</span>
                        </div>
                      )}
                      {failed && !j.error && <div className="mt-1 text-xs text-red-700">Failed without an error message. Start the import again, and contact support if it fails twice.</div>}
                      {notFound > 0 && <div className="text-xs text-gray-500 mt-0.5">{j.mode === 'update_only' ? `${formatNumber(notFound)} rows matched no lead and were skipped.` : `${formatNumber(notFound)} compan${notFound === 1 ? 'y was' : 'ies were'} not found on LinkedIn${Array.isArray(st.not_found) ? `: ${st.not_found.slice(0, 5).join(', ')}${notFound > 5 ? '…' : ''}` : ''}.`}</div>}
                      {!!st.row_errors && <div className="text-xs text-amber-700 mt-0.5">{formatNumber(st.row_errors)} rows could not be read{st.first_row_error ? `. First error: ${st.first_row_error}` : ''}.</div>}
                      {(j.kind as string) === 'company_people' && j.status === 'running' && st.company_name && <div className="text-xs text-gray-500 mt-0.5">Now on: {st.company_name}</div>}
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
                    <div className="text-xs text-gray-700 tabular-nums">{formatNumber(j.fetched)}{j.total_expected != null ? ` / ${formatNumber(j.total_expected)}` : ''} {j.kind === 'csv' ? 'rows' : 'fetched'}</div>
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
