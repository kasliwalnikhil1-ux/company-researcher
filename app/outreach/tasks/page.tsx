'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useRouter, useSearchParams } from '@/lib/outreach/nav';
import { useQueryClient } from '@tanstack/react-query';
import { CheckSquare, ExternalLink, Phone, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSessionUser } from '@/lib/outreach/session';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { db } from '@/lib/outreach/backend';
import { parseError } from '@/lib/outreach/api';
import { useClients, useMembers, useTasksPage } from '@/lib/outreach/queries';
import type { Lead, Sender, Task } from '@/lib/outreach/types';
import { Avatar, Badge, Button, EmptyState, ErrorBox, fmtDate, PageHeader, PageLoader, Spinner, Table, Td, Th, useToast } from '@/components/outreach/ui';
import TaskDrawer, { TASK_KINDS, memberName, parseCallBody, taskKindLabel, taskKindTone } from '@/components/outreach/tasks/TaskDrawer';
import { MemberChip, MemberPicker } from '@/components/outreach/members';
import { sanitizeLike, usePersistedFilters } from '@/lib/outreach/persistedFilters';
import { LIST_PAGE_SIZE, PaginationBar } from '@/components/outreach/Pagination';
import { NEEDS_YOU_RULE, hubHref } from '@/lib/outreach/aiHub';

type TaskRow = Task & { outreach_leads: Partial<Lead> | null; outreach_senders: Partial<Sender> | null };

function TasksPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { user } = useSessionUser();
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

  // Old links to the AI kinds that moved out of Tasks (dashboard cards, emails) go to their new home.
  useEffect(() => {
    if (urlKind === 'review_ai_draft') router.replace(hubHref.needsYou({ type: 'draft', mine: false }));
    else if (urlKind === 'ai_escalation') router.replace(hubHref.needsYou({ type: 'reply', mine: false }));
  }, [urlKind, router]);

  // Deep link (?task=<id>) from the inbox lead panel.
  useEffect(() => { const t = params.get('task'); if (t) setOpenTask(t); }, [params]);
  const closeDrawer = () => { setOpenTask(null); if (params.get('task')) router.replace('/outreach/tasks'); };

  // Paged on the server (a workspace can have thousands of tasks); any filter change goes back to page 1.
  const filterKey = [ws, tab, kind, mine, clientId].join('|');
  const [pageState, setPageState] = useState({ key: filterKey, page: 0 });
  const page = pageState.key === filterKey ? pageState.page : 0;
  const tasksQ = useTasksPage(filtersReady ? ws : null, { open: tab === 'open', kind: kind || null, assigned_to: mine ? userId : null, client_id: clientId || null, page, pageSize: LIST_PAGE_SIZE });
  const membersQ = useMembers(ws);
  const clientsQ = useClients(ws);

  const rows = useMemo(() => (tasksQ.data?.rows ?? []) as TaskRow[], [tasksQ.data]);
  const total = tasksQ.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  // Selection is per page: moving to another page clears it.
  const setPage = (p: number) => { setSelected(new Set()); setPageState({ key: filterKey, page: Math.max(0, Math.min(pageCount - 1, p)) }); };
  // A page past the end (after completing the last tasks on it) steps back to the last page.
  if (tasksQ.data && !tasksQ.isPlaceholderData && page > 0 && page >= pageCount) setPageState({ key: filterKey, page: pageCount - 1 });

  useEffect(() => { setSelected(new Set()); }, [tab, kind, mine, clientId]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const assignOne = async (id: string, assigned_to: string | null) => {
    const { error } = await db.from('outreach_tasks').update({ assigned_to }).eq('id', id);
    if (error) { toast.show(parseError(error).message, 'error'); return; }
    qc.invalidateQueries({ queryKey: ['outreach', ws ?? '', 'tasks'] });
  };
  const bulkAssign = async () => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const { error } = await db.from('outreach_tasks').update({ assigned_to: bulkAssignee || null }).in('id', Array.from(selected));
      if (error) throw parseError(error);
      toast.show(`${selected.size} task${selected.size === 1 ? '' : 's'} assigned to ${memberName(membersQ.data, bulkAssignee || null)}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['outreach', ws ?? '', 'tasks'] });
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBulkBusy(false); }
  };

  if (!ws) return null;
  if (role === 'client_viewer') return <ErrorBox message="Tasks are not available for client viewers." />;

  const openCount = tab === 'open' ? total : null;

  return (
    <div>
      <PageHeader title="Tasks" subtitle={<>Things you do yourself: manual steps, calls, follow-ups, leads held after a reply, conversations the AI handed over and sender reconnects. What the AI wrote and waits for your approval is in <Link href={hubHref.needsYou()} className="text-indigo-700 hover:underline">AI → Needs you</Link>.</>} actions={
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          {(['open', 'completed'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t} className={cn('px-3 py-1.5 text-sm font-medium rounded-md capitalize', tab === t ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>{t}{t === 'open' && openCount != null && tasksQ.data ? ` (${openCount})` : ''}</button>
          ))}
        </div>
      } />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Task kind" className="text-sm rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="">All kinds</option>
          {TASK_KINDS.map((k) => <option key={k} value={k}>{taskKindLabel(k)}</option>)}
        </select>
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
          <button type="button" aria-pressed={!mine} onClick={() => setMine(false)} className={cn('px-2.5 py-1 text-sm font-medium rounded-md', !mine ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>Anyone</button>
          <button type="button" aria-pressed={mine} onClick={() => setMine(true)} className={cn('px-2.5 py-1 text-sm font-medium rounded-md', mine ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>Assigned to me</button>
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
            <MemberPicker size="sm" value={bulkAssignee} onChange={setBulkAssignee} members={membersQ.data} currentUserId={userId} aria-label="Assign selected tasks to" className="w-44" />
            <Button size="sm" loading={bulkBusy} onClick={bulkAssign}>Assign</Button>
            <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-indigo-600 hover:underline">Clear</button>
          </div>
        )}
      </div>

      {(!filtersReady || tasksQ.isLoading) && <Spinner className="min-h-[50vh]" />}
      {tasksQ.error && <ErrorBox message={parseError(tasksQ.error).message} />}
      {tasksQ.data && rows.length === 0 && (
        <EmptyState icon={<CheckSquare className="w-6 h-6" />} title={tab === 'open' ? 'No open tasks' : 'No completed tasks'} description={tab === 'open' ? `Tasks appear here when a sequence reaches a manual step or a call, a lead is held after a reply, a reply needs a follow-up, the AI hands a conversation over, or a sender needs reconnecting. ${NEEDS_YOU_RULE}` : 'Completed tasks will be listed here.'}
          action={tab === 'open' ? <Link href={hubHref.needsYou()} className="text-sm font-medium text-indigo-700 hover:underline">Open AI → Needs you</Link> : undefined} />
      )}
      {rows.length > 0 && (
        <div className={cn('transition-opacity', tasksQ.isPlaceholderData && 'opacity-60')}>
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
                  <Td className="hidden md:table-cell text-gray-600">
                    {t.outreach_senders?.display_name ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Avatar src={t.outreach_senders.picture_url} name={t.outreach_senders.display_name} size={6} />
                        <span className="truncate max-w-[160px]">{t.outreach_senders.display_name}</span>
                      </span>
                    ) : <span className="text-gray-400">—</span>}
                  </Td>
                  <Td className={cn('whitespace-nowrap', overdue && 'text-red-600 font-medium')}>{tab === 'open' ? (t.due_at ? fmtDate(t.due_at) : '—') : fmtDate(t.completed_at)}</Td>
                  <Td onClick={(e) => e.stopPropagation()}>
                    {tab === 'open' && canWrite ? (
                      <MemberPicker size="sm" value={t.assigned_to} onChange={(id) => assignOne(t.id, id || null)} members={membersQ.data} currentUserId={userId} aria-label="Assignee" className="w-40" />
                    ) : <MemberChip userId={t.assigned_to} members={membersQ.data} className="text-gray-600 max-w-[170px]" />}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        </div>
      )}
      {rows.length > 0 && (
        <div>
          <PaginationBar page={page} pageCount={pageCount} setPage={setPage} total={total} from={page * LIST_PAGE_SIZE + 1} to={Math.min(total, (page + 1) * LIST_PAGE_SIZE)} />
        </div>
      )}

      {openTask && <TaskDrawer taskId={openTask} onClose={closeDrawer} members={membersQ.data} workspaceId={ws} canWrite={canWrite} toast={toast.show} />}
      {toast.node}
    </div>
  );
}

export default function TasksPage() {
  return <Suspense fallback={<PageLoader />}><TasksPageInner /></Suspense>;
}
