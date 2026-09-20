'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Repeat, Trash2 } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useLists, useSenders } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { ik, importKindLabel, useImportSchedules, type ImportSchedule } from '@/lib/outreach/intel';
import { Badge, Button, EmptyState, ErrorBox, Modal, Spinner, Table, Td, Th, Toggle, fmtDate, timeAgo } from '@/components/outreach/ui';
import { formatNumber, type ToastFn } from './helpers';

const CADENCE: Record<string, string> = { daily: 'Every day', weekly: 'Every week', monthly: 'Every month' };

function detail(s: ImportSchedule): string | null {
  const p = s.params as { url?: string; post_url?: string; name?: string | null; companies?: unknown[] };
  if (s.kind === 'post_engagement') return p.post_url ?? null;
  if (s.kind === 'search_url') return p.url ?? null;
  if (s.kind === 'sn_saved_search' || s.kind === 'sn_lead_list') return p.name ?? null;
  if (s.kind === 'company_people') return Array.isArray(p.companies) ? `${p.companies.length} companies` : null;
  return null;
}

export function ImportSchedulesTable({ toast }: { toast: ToastFn }) {
  const { workspace, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const schedules = useImportSchedules(ws);
  const senders = useSenders(ws);
  const lists = useLists(ws);
  const [busy, setBusy] = useState<string | null>(null);
  const [remove, setRemove] = useState<ImportSchedule | null>(null);

  const refresh = () => { if (ws) qc.invalidateQueries({ queryKey: ik.importSchedules(ws) }); };

  const setActive = async (s: ImportSchedule, active: boolean) => {
    setBusy(s.id);
    // optimistic: the toggle should not lag behind the click
    if (ws) qc.setQueryData<ImportSchedule[]>(ik.importSchedules(ws), (old) => old?.map((x) => (x.id === s.id ? { ...x, active } : x)));
    try {
      const { error } = await supabase.from('outreach_import_schedules').update({ active }).eq('id', s.id);
      if (error) throw error;
      toast(active ? 'Repeating import switched on' : 'Repeating import paused. Imports that already started keep running.');
    } catch (e) { toast(parseError(e).message, 'error'); }
    finally { setBusy(null); refresh(); }
  };

  const doRemove = async () => {
    if (!remove) return;
    setBusy(remove.id);
    try {
      const { error } = await supabase.from('outreach_import_schedules').delete().eq('id', remove.id);
      if (error) throw error;
      toast('Repeating import deleted');
      setRemove(null);
    } catch (e) { toast(parseError(e).message, 'error'); }
    finally { setBusy(null); refresh(); }
  };

  if (schedules.isLoading) return <Spinner className="py-6" />;
  if (schedules.error) return <ErrorBox message={parseError(schedules.error).message} />;
  const rows = schedules.data ?? [];
  if (rows.length === 0) {
    return <div className="bg-white border border-gray-200 rounded-xl"><EmptyState icon={<Repeat className="w-6 h-6" />} title="No repeating imports" description="Choose a rhythm under “Repeat” when you start an import. It then runs again on its own and adds only new people." /></div>;
  }

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>Import</Th>
            <Th>Rhythm</Th>
            <Th className="hidden md:table-cell">Sender</Th>
            <Th>Next run</Th>
            <Th className="hidden md:table-cell">Last run</Th>
            <Th className="hidden lg:table-cell text-right">Runs</Th>
            <Th>Active</Th>
            {canWrite && <Th className="text-right">Actions</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const sender = senders.data?.find((x) => x.id === s.sender_id);
            const list = s.list_id ? lists.data?.find((l) => l.id === s.list_id) : undefined;
            const d = detail(s);
            const failed = s.last_job?.status === 'failed';
            return (
              <tr key={s.id} className="align-top">
                <Td>
                  <div className="min-w-[180px]">
                    <div className="font-medium text-gray-900 truncate max-w-[280px]" title={s.name}>{s.name}</div>
                    <div className="text-xs text-gray-500 truncate max-w-[280px]" title={d ?? undefined}>{importKindLabel(s.kind)}{d ? ` · ${d}` : ''}</div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {list && <Badge tone="gray">List: {list.name}</Badge>}
                      {s.tag_ids.length > 0 && <Badge tone="gray">{s.tag_ids.length} tag{s.tag_ids.length === 1 ? '' : 's'}</Badge>}
                      {s.enrich && <Badge tone="indigo">Enrich after import</Badge>}
                    </div>
                    {failed && s.last_job?.error && <div className="text-xs text-red-600 mt-1 max-w-[320px] break-words">Last run failed: {s.last_job.error}</div>}
                  </div>
                </Td>
                <Td className="whitespace-nowrap">{CADENCE[s.cadence] ?? s.cadence}</Td>
                <Td className="hidden md:table-cell"><span className="block max-w-[160px] truncate">{sender ? (sender.display_name ?? sender.public_identifier ?? 'Sender') : <span className="text-red-600">Sender removed</span>}</span></Td>
                <Td className="whitespace-nowrap text-xs">{!s.active ? <span className="text-gray-400">Paused</span> : new Date(s.next_run_at).getTime() <= Date.now() ? 'Due now' : fmtDate(s.next_run_at)}</Td>
                <Td className="hidden md:table-cell whitespace-nowrap text-xs text-gray-500">
                  {s.last_run_at ? timeAgo(s.last_run_at) : 'Not yet'}
                  {s.last_job && <Badge tone={failed ? 'red' : s.last_job.status === 'done' ? 'green' : 'blue'} className="ml-1.5">{s.last_job.status}</Badge>}
                </Td>
                <Td className="hidden lg:table-cell text-right tabular-nums">{formatNumber(s.runs)}</Td>
                <Td><Toggle checked={s.active} disabled={!canWrite || busy === s.id} onChange={(v) => setActive(s, v)} label={s.active ? "On" : "Off"} /></Td>
                {canWrite && <Td className="text-right"><Button size="sm" variant="ghost" className="text-red-600" disabled={busy === s.id} onClick={() => setRemove(s)} title="Delete this repeating import"><Trash2 className="w-3.5 h-3.5" /> Delete</Button></Td>}
              </tr>
            );
          })}
        </tbody>
      </Table>
      <Modal open={!!remove} onClose={() => setRemove(null)} title="Delete this repeating import?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setRemove(null)}>Keep it</Button><Button variant="danger" loading={!!remove && busy === remove.id} onClick={doRemove}>Delete</Button></>}>
        <p className="text-sm text-gray-600">“{remove?.name}” will not run again. Leads it already imported stay, and an import that is running now finishes.</p>
      </Modal>
    </>
  );
}
