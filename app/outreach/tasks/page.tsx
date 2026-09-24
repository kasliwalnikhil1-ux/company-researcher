'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { CheckSquare, ExternalLink, Phone, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { supabase } from '@/utils/supabase/client';
import { parseError } from '@/lib/outreach/api';
import { useClients, useMembers, useTasks } from '@/lib/outreach/queries';
import type { Lead, Sender, Task } from '@/lib/outreach/types';
import { Avatar, Badge, Button, EmptyState, ErrorBox, fmtDate, PageHeader, PageLoader, Spinner, Table, Td, Th, useToast } from '@/components/outreach/ui';
import TaskDrawer, { TASK_KINDS, memberName, parseCallBody, taskKindLabel, taskKindTone } from '@/components/outreach/tasks/TaskDrawer';
import { sanitizeLike, usePersistedFilters } from '@/lib/outreach/persistedFilters';

type TaskRow = Task & { outreach_leads: Partial<Lead> | null; outreach_senders: Partial<Sender> | null };

function TasksPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { workspace, canWrite, role } = useWorkspace();
  const ws = workspace?.id ?? null;
  const toast = useToast();
  const userId = user?.id ?? null;

  // Tab, kind, assignee and client filters are remembered per workspace in this browser; ?kind= in the URL wins.
  const urlKind = params.get('kind');
  const { filters: taskFilters, patch: patchTaskFilters, ready: filtersReady } = usePersistedFilters<{ tab: 'open' | 'completed'; kind: string; mine: boolean; clientId: string }>('tasks', ws, { tab: 'open', kind: '', mine: false, clientId: '' }, {
    overrides: urlKind ? { kind: urlKind } : null,
    sanitize: (raw, d) => { const v = sanitizeLike(raw, d); if (v.tab !== 'open' && v.tab !== 'completed') v.tab = 'open'; if (v.kind && !(TASK_KINDS as readonly string[]).includes(v.kind)) v.kind = ''; return v; },
  });
  const { tab, kind, mine, clientId } = taskFilters;
  const setTab = (v: 'open' | 'completed') => patchTaskFilters({ tab: v });
  const setKind = (v: string) => patchTaskFilters({ kind: v });
  const setMine = (v: boolean) => patchTaskFilters({ mine: v });
  const setClientId = (v: string) => patchTaskFilters({ clientId: v });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAssignee, setBulkAssignee] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [openTask, setOpenTask] = useState<string | null>(null);

  // Deep link (?task=<id>) from the inbox lead panel.
  useEffect(() => { const t = params.get('task'); if (t) setOpenTask(t); }, [params]);
  const closeDrawer = () => { setOpenTask(null); if (params.get('task')) router.replace('/outreach/tasks'); };

  const tasksQ = useTasks(filtersReady ? ws : null, { open: tab === 'open', kind: kind || null, assigned_to: mine ? userId : null });
  const membersQ = useMembers(ws);
  const clientsQ = useClients(ws);

  const rows = useMemo(() => {
    const all = (tasksQ.data ?? []) as TaskRow[];
    return clientId ? all.filter((t) => t.client_id === clientId) : all;
  }, [tasksQ.data, clientId]);

  useEffect(() => { setSelected(new Set()); }, [tab, kind, mine, clientId]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const assignOne = async (id: string, assigned_to: string | null) => {
    const { error } = await supabase.from('outreach_tasks').update({ assigned_to }).eq('id', id);
    if (error) { toast.show(parseError(error).message, 'error'); return; }
    qc.invalidateQueries({ queryKey: ['outreach', ws ?? '', 'tasks'] });
  };
  const bulkAssign = async () => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const { error } = await supabase.from('outreach_tasks').update({ assigned_to: bulkAssignee || null }).in('id', Array.from(selected));
      if (error) throw parseError(error);
      toast.show(`${selected.size} task${selected.size === 1 ? '' : 's'} assigned to ${memberName(membersQ.data, bulkAssignee || null)}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['outreach', ws ?? '', 'tasks'] });
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBulkBusy(false); }
  };

  if (!ws) return null;
  if (role === 'client_viewer') return <ErrorBox message="Tasks are not available for client viewers." />;

  const openCount = tab === 'open' ? rows.length : null;

  return (
    <div>
      <PageHeader title="Tasks" subtitle="Manual steps, calls, AI drafts to review, leads held after a reply, follow-ups and sender reconnects." actions={
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          {(['open', 'completed'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={cn('px-3 py-1.5 text-sm rounded-md capitalize', tab === t ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50')}>{t}{t === 'open' && openCount != null && tasksQ.data ? ` (${openCount})` : ''}</button>
          ))}
        </div>
      } />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Task kind" className="text-sm rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">All kinds</option>
          {TASK_KINDS.map((k) => <option key={k} value={k}>{taskKindLabel(k)}</option>)}
        </select>
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          <button type="button" onClick={() => setMine(false)} className={cn('px-2.5 py-1 text-sm rounded-md', !mine ? 'bg-gray-100 text-gray-900' : 'text-gray-600')}>Anyone</button>
          <button type="button" onClick={() => setMine(true)} className={cn('px-2.5 py-1 text-sm rounded-md', mine ? 'bg-gray-100 text-gray-900' : 'text-gray-600')}>Assigned to me</button>
        </div>
        {!!clientsQ.data?.length && (
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client" className="text-sm rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">All clients</option>
            {clientsQ.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {selected.size > 0 && canWrite && (
          <div className="ml-auto flex items-center gap-2 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-1.5 text-sm text-indigo-800">
            <Users className="w-4 h-4" />
            <span>{selected.size} selected</span>
            <select value={bulkAssignee} onChange={(e) => setBulkAssignee(e.target.value)} aria-label="Assign selected tasks to" className="text-sm rounded-md border border-indigo-200 bg-white px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="">Unassigned</option>
              {membersQ.data?.map((m) => <option key={m.user_id} value={m.user_id}>{memberName(membersQ.data, m.user_id)}{m.user_id === userId ? ' (me)' : ''}</option>)}
            </select>
            <Button size="sm" loading={bulkBusy} onClick={bulkAssign}>Assign</Button>
            <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-indigo-600 hover:underline">Clear</button>
          </div>
        )}
      </div>

      {(!filtersReady || tasksQ.isLoading) && <Spinner className="min-h-[50vh]" />}
      {tasksQ.error && <ErrorBox message={parseError(tasksQ.error).message} />}
      {tasksQ.data && rows.length === 0 && (
        <EmptyState icon={<CheckSquare className="w-6 h-6" />} title={tab === 'open' ? 'No open tasks' : 'No completed tasks'} description={tab === 'open' ? 'Tasks appear here when a sequence reaches a manual step or a call, an AI draft needs approval, a lead is held after a reply, a reply needs a follow-up, or a sender needs reconnecting.' : 'Completed tasks will be listed here.'} />
      )}
      {rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              {canWrite && <Th className="w-8"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} className="rounded border-gray-300" /></Th>}
              <Th>Kind</Th>
              <Th>Task</Th>
              <Th>Lead</Th>
              <Th className="hidden md:table-cell">Sender</Th>
              <Th>{tab === 'open' ? 'Due' : 'Completed'}</Th>
              <Th>Assignee</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const overdue = tab === 'open' && t.due_at && new Date(t.due_at).getTime() < Date.now();
              const leadName = t.outreach_leads?.full_name ?? null;
              return (
                <tr key={t.id} onClick={() => setOpenTask(t.id)} className={cn('cursor-pointer hover:bg-gray-50', selected.has(t.id) && 'bg-indigo-50/60')}>
                  {canWrite && <Td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${t.title}`} checked={selected.has(t.id)} onChange={() => toggle(t.id)} className="rounded border-gray-300" /></Td>}
                  <Td><Badge tone={taskKindTone(t.kind)}>{taskKindLabel(t.kind)}</Badge></Td>
                  <Td className="max-w-[320px]">
                    <div className="font-medium text-gray-900 truncate">{t.title}</div>
                    {t.kind === 'review_ai_draft' && !t.ai_draft && !t.completed_at && <div className="text-xs text-fuchsia-600">Drafting…</div>}
                    {(t.kind as string) === 'call'
                      ? <div className="text-xs text-gray-500 truncate inline-flex items-center gap-1"><Phone className="w-3 h-3" />{parseCallBody(t.body).phone ?? 'No number on file'}</div>
                      : t.body && <div className="text-xs text-gray-500 truncate">{t.body}</div>}
                  </Td>
                  <Td>
                    {t.outreach_leads?.id ? (
                      <Link href={`/outreach/leads/${t.outreach_leads.id}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 hover:text-indigo-600">
                        <Avatar src={t.outreach_leads.picture_url} name={leadName} size={6} />
                        <span className="truncate max-w-[160px]">{leadName ?? t.outreach_leads.public_identifier ?? 'Lead'}</span>
                        <ExternalLink className="w-3 h-3 text-gray-400" />
                      </Link>
                    ) : <span className="text-gray-400">—</span>}
                  </Td>
                  <Td className="hidden md:table-cell text-gray-600">{t.outreach_senders?.display_name ?? <span className="text-gray-400">—</span>}</Td>
                  <Td className={cn('whitespace-nowrap', overdue && 'text-red-600 font-medium')}>{tab === 'open' ? (t.due_at ? fmtDate(t.due_at) : '—') : fmtDate(t.completed_at)}</Td>
                  <Td onClick={(e) => e.stopPropagation()}>
                    {tab === 'open' && canWrite ? (
                      <select value={t.assigned_to ?? ''} onChange={(e) => assignOne(t.id, e.target.value || null)} aria-label="Assignee" className="text-xs rounded-md border border-gray-200 bg-white px-2 py-1 max-w-[150px] focus:outline-none focus:ring-2 focus:ring-indigo-500">
                        <option value="">Unassigned</option>
                        {membersQ.data?.map((m) => <option key={m.user_id} value={m.user_id}>{memberName(membersQ.data, m.user_id)}</option>)}
                        {t.assigned_to && !membersQ.data?.some((m) => m.user_id === t.assigned_to) && <option value={t.assigned_to}>Former member</option>}
                      </select>
                    ) : <span className="text-gray-600">{memberName(membersQ.data, t.assigned_to)}</span>}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {openTask && <TaskDrawer taskId={openTask} onClose={closeDrawer} members={membersQ.data} workspaceId={ws} canWrite={canWrite} toast={toast.show} />}
      {toast.node}
    </div>
  );
}

export default function TasksPage() {
  return <Suspense fallback={<PageLoader />}><TasksPageInner /></Suspense>;
}
