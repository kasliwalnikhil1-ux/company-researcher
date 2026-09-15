'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, Copy, ExternalLink, GitBranch, MoreHorizontal, Plus, Search, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk, useClients, useSenders, useSequences } from '@/lib/outreach/queries';
import type { Sequence, SequenceStatus } from '@/lib/outreach/types';
import { Avatar, Badge, Button, EmptyState, ErrorBox, Input, Modal, PageHeader, Select, Spinner, Table, Td, Th, timeAgo, useToast } from '@/components/outreach/ui';
import { ConfirmModal } from '@/components/outreach/sequences/Modals';
import { useSequenceSummary } from '@/components/outreach/sequences/hooks';
import { formatGraphError, nodeCount, senderName, STATUS_TONE } from '@/components/outreach/sequences/helpers';

const STATUSES: SequenceStatus[] = ['draft', 'active', 'paused', 'archived'];

const MENU_ITEM = 'w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-gray-700';

function RowMenu({ s, canManage, onDuplicate, onArchive, onDelete }: { s: Sequence; canManage: boolean; onDuplicate: () => void; onArchive: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const deletable = s.status === 'draft' || s.status === 'archived';

  // The table scrolls horizontally, so an absolutely positioned menu gets clipped by the
  // card. Render it in a portal and anchor it to the button in viewport coordinates.
  const place = useCallback(() => {
    const anchor = btnRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const menu = menuRef.current?.getBoundingClientRect();
    const w = menu?.width || 176;
    const h = menu?.height || 160;
    const gap = 4;
    const edge = 8;
    const left = Math.min(Math.max(edge, anchor.right - w), window.innerWidth - w - edge);
    const below = anchor.bottom + gap;
    const top = below + h > window.innerHeight - edge ? Math.max(edge, anchor.top - h - gap) : below;
    setPos({ top, left });
  }, []);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen((o) => !o)} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500" aria-label="Actions" aria-haspopup="menu" aria-expanded={open}><MoreHorizontal className="w-4 h-4" /></button>
      {open && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div ref={menuRef} role="menu" style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="fixed z-50 w-44 bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm">
            <Link href={`/outreach/sequences/${s.id}`} className={MENU_ITEM} role="menuitem" onClick={close}><ExternalLink className="w-4 h-4 flex-shrink-0" /> Open</Link>
            {canManage && <button type="button" onClick={() => { close(); onDuplicate(); }} className={MENU_ITEM} role="menuitem"><Copy className="w-4 h-4 flex-shrink-0" /> Duplicate</button>}
            {canManage && s.status !== 'archived' && <button type="button" onClick={() => { close(); onArchive(); }} className={MENU_ITEM} role="menuitem"><Archive className="w-4 h-4 flex-shrink-0" /> Archive</button>}
            {canManage && <button type="button" disabled={!deletable} title={deletable ? undefined : 'Only draft or archived sequences can be deleted'} onClick={() => { close(); onDelete(); }} className={cn(MENU_ITEM, 'hover:bg-red-50 text-red-600 disabled:opacity-40 disabled:hover:bg-transparent')} role="menuitem"><Trash2 className="w-4 h-4 flex-shrink-0" /> Delete</button>}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

export default function SequencesPage() {
  const { workspace, isManager, suspended } = useWorkspace();
  const ws = workspace?.id ?? null;
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const seqs = useSequences(ws);
  const senders = useSenders(ws);
  const clients = useClients(ws);
  const summary = useSequenceSummary(ws);
  const canManage = isManager && !suspended;

  const [status, setStatus] = useState<'' | SequenceStatus>('');
  const [client, setClient] = useState('');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newClient, setNewClient] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'archive' | 'delete'; s: Sequence } | null>(null);

  const summaryMap = useMemo(() => Object.fromEntries((summary.data ?? []).map((r) => [r.sequence_id, r])), [summary.data]);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (seqs.data ?? []).filter((s) => (!status || s.status === status) && (!client || s.client_id === client) && (!needle || s.name.toLowerCase().includes(needle)));
  }, [seqs.data, status, client, search]);

  const invalidate = () => { if (ws) { qc.invalidateQueries({ queryKey: qk.sequences(ws) }); qc.invalidateQueries({ queryKey: ['outreach', ws, 'sequence_summary'] }); } };

  const create = async () => {
    if (!ws || !newName.trim()) return;
    setCreating(true);
    try {
      const id = await rpc<string>('create_sequence', { p_workspace: ws, p_name: newName.trim(), p_client_id: newClient || null });
      invalidate();
      router.push(`/outreach/sequences/${id}`);
    } catch (e) { toast.show(parseError(e).message, 'error'); setCreating(false); }
  };

  const duplicate = async (s: Sequence) => {
    if (!ws) return;
    setBusyId(s.id);
    try {
      const id = await rpc<string>('create_sequence', { p_workspace: ws, p_name: `${s.name} (copy)`, p_client_id: s.client_id });
      await rpc('save_sequence', { p_id: id, p_graph: s.graph, p_pool: s.sender_pool, p_settings: s.settings, p_assignment: s.assignment, p_use_sender_schedule: s.use_sender_schedule, p_brief: s.brief ?? '' });
      invalidate();
      toast.show(`Duplicated “${s.name}”`);
    } catch (e) { toast.show(formatGraphError(e), 'error'); }
    finally { setBusyId(null); }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    const { kind, s } = confirm;
    setBusyId(s.id);
    try {
      if (kind === 'archive') { await rpc('set_sequence_status', { p_id: s.id, p_status: 'archived' }); toast.show(`Archived “${s.name}”`); }
      else {
        const { error } = await supabase.from('outreach_sequences').delete().eq('id', s.id);
        if (error) throw parseError(error);
        toast.show(`Deleted “${s.name}”`);
      }
      invalidate();
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusyId(null); setConfirm(null); }
  };

  return (
    <div>
      <PageHeader title="Sequences" subtitle="Multi-step LinkedIn and email flows run by your sender pool."
        actions={canManage && <Button onClick={() => { setNewName(''); setNewClient(''); setCreateOpen(true); }}><Plus className="w-4 h-4" /> New sequence</Button>} />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search sequences" aria-label="Search sequences" className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value as '' | SequenceStatus)} aria-label="Filter by status" className="w-auto">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
        </Select>
        {(clients.data?.length ?? 0) > 0 && (
          <Select value={client} onChange={(e) => setClient(e.target.value)} aria-label="Filter by client" className="w-auto">
            <option value="">All clients</option>
            {clients.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}
      </div>

      {seqs.isLoading ? <Spinner /> : seqs.error ? <ErrorBox message={parseError(seqs.error).message} /> : rows.length === 0 ? (
        <EmptyState icon={<GitBranch className="w-6 h-6" />} title={seqs.data?.length ? 'No sequences match these filters' : 'No sequences yet'}
          description={seqs.data?.length ? 'Try a different status, client or search.' : 'Build your first flow: invitation, wait for connection, follow-up messages, and CRM updates.'}
          action={canManage && !seqs.data?.length ? <Button onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" /> New sequence</Button> : undefined} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Sequence</Th><Th>Status</Th><Th>Client</Th><Th>Pool</Th>
              <Th className="text-right">Live</Th><Th className="text-right">Completed</Th><Th className="text-right">Replied</Th><Th className="text-right">Sent</Th><Th className="text-right">Queued</Th>
              <Th>Updated</Th><Th className="w-10"></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const sm = summaryMap[s.id];
              const pool = s.sender_pool.map((id) => senders.data?.find((x) => x.id === id)).filter(Boolean) as NonNullable<typeof senders.data>;
              const clientName = clients.data?.find((c) => c.id === s.client_id)?.name;
              return (
                <tr key={s.id} className={cn('hover:bg-gray-50', busyId === s.id && 'opacity-50')}>
                  <Td>
                    <Link href={`/outreach/sequences/${s.id}`} className="font-medium text-gray-900 hover:text-indigo-700">{s.name}</Link>
                    <div className="text-xs text-gray-400">{nodeCount(s.graph)} steps · v{s.head_version}</div>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge tone={STATUS_TONE[s.status]} className="capitalize">{s.status}</Badge>
                      {s.throttled_reason && <Badge tone="amber" className="cursor-help"><span title={s.throttled_reason} className="inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> throttled</span></Badge>}
                    </div>
                  </Td>
                  <Td className="text-gray-600">{clientName ?? <span className="text-gray-400">—</span>}</Td>
                  <Td>
                    {pool.length === 0 ? <span className="text-xs text-gray-400">Empty</span> : (
                      <div className="flex items-center gap-1.5" title={pool.map(senderName).join(', ')}>
                        <span className="flex -space-x-2">{pool.slice(0, 4).map((p) => <span key={p.id} className="ring-2 ring-white rounded-full"><Avatar src={p.picture_url} name={senderName(p)} size={6} /></span>)}</span>
                        <span className="text-xs text-gray-600">{pool.length === 1 ? senderName(pool[0]) : `${pool.length} senders`}</span>
                        {pool.some((p) => p.status !== 'ok') && <span className="text-xs text-amber-700" title="Some senders are not connected">!</span>}
                      </div>
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">{sm?.live ?? 0}</Td>
                  <Td className="text-right tabular-nums">{sm?.completed ?? 0}</Td>
                  <Td className="text-right tabular-nums">{sm?.replied ?? 0}</Td>
                  <Td className="text-right tabular-nums">{sm?.sent ?? 0}</Td>
                  <Td className="text-right tabular-nums">{sm?.queued ?? 0}</Td>
                  <Td className="text-gray-500 whitespace-nowrap" title={s.updated_at}>{timeAgo(s.updated_at)}</Td>
                  <Td className="text-right"><RowMenu s={s} canManage={canManage} onDuplicate={() => duplicate(s)} onArchive={() => setConfirm({ kind: 'archive', s })} onDelete={() => setConfirm({ kind: 'delete', s })} /></Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <Modal open={createOpen} onClose={() => !creating && setCreateOpen(false)} title="New sequence" size="sm"
        footer={<><Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button><Button loading={creating} disabled={!newName.trim()} onClick={create}>Create and open</Button></>}>
        <div className="space-y-3">
          <Input label="Name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Founders — invite + 2 follow-ups" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          <Select label="Client (optional)" value={newClient} onChange={(e) => setNewClient(e.target.value)}>
            <option value="">No client</option>
            {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
      </Modal>

      <ConfirmModal open={confirm?.kind === 'archive'} title="Archive sequence" confirmLabel="Archive" danger busy={!!busyId} onClose={() => setConfirm(null)} onConfirm={runConfirm}
        body={<p>Archiving “{confirm?.s.name}” exits all live enrollments ({summaryMap[confirm?.s.id ?? '']?.live ?? 0}) and stops scheduling. The graph and history are kept.</p>} />
      <ConfirmModal open={confirm?.kind === 'delete'} title="Delete sequence" confirmLabel="Delete permanently" danger busy={!!busyId} onClose={() => setConfirm(null)} onConfirm={runConfirm}
        body={<p>This permanently deletes “{confirm?.s.name}”, its versions, node statistics and enrollment history. This cannot be undone.</p>} />
      {toast.node}
    </div>
  );
}
