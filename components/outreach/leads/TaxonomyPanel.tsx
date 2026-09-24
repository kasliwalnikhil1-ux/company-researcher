'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useClients, useLists, useStages, useTags } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { Button, EmptyState, ErrorBox, Input, Modal, Select, Spinner, Table, Td, Th } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { Check, ChevronDown, ChevronUp, FolderOpen, Layers, Pencil, Plus, Tag as TagIcon, Trash2, Users, X } from 'lucide-react';
import { PALETTE, chipStyle, type ToastFn } from './helpers';

export type TaxonomyKind = 'lists' | 'stages' | 'tags';

export const TAXONOMY: Record<TaxonomyKind, { table: string; label: string; singular: string; placeholder: string; blurb: string; deleteHint: string }> = {
  lists: {
    table: 'outreach_lists', label: 'Lists', singular: 'list', placeholder: 'Q3 SaaS founders',
    blurb: 'Lists group leads by where they came from or what you plan to do with them. A lead belongs to one list, and a list can be limited to one client.',
    deleteHint: 'Leads in this list keep their data; the list field is cleared.',
  },
  stages: {
    table: 'outreach_stages', label: 'Stages', singular: 'stage', placeholder: 'Qualified',
    blurb: 'Stages track how far a lead has come. They apply in this order across the pipeline, the lead table and reports.',
    deleteHint: 'Leads in this stage will have no stage.',
  },
  tags: {
    table: 'outreach_tags', label: 'Tags', singular: 'tag', placeholder: 'hot',
    blurb: 'Tags are free labels. A lead can carry any number of them, and you can filter or bulk-edit by tag.',
    deleteHint: 'The tag is removed from every lead.',
  },
};

interface Row { id: string; name: string; color?: string | null; position?: number; client_id?: string | null; kind?: string | null }

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Colour">
      {PALETTE.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} title={c} onClick={() => onChange(c)}
          className={cn('w-5 h-5 rounded-full border-2 transition-transform', value === c ? 'border-gray-900 scale-110' : 'border-transparent hover:scale-110')} style={{ backgroundColor: c }} />
      ))}
    </div>
  );
}

/** How many leads sit in each list / stage / tag. One head-only count per row, run in parallel. */
function useTaxonomyCounts(ws: string | undefined, kind: TaxonomyKind, ids: string[]) {
  return useQuery({
    queryKey: ['outreach', ws ?? '', 'taxonomy-counts', kind, ids],
    enabled: !!ws && ids.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(ids.map(async (id) => {
        const q = kind === 'tags'
          ? supabase.from('outreach_lead_tags').select('lead_id', { count: 'exact', head: true }).eq('tag_id', id)
          : supabase.from('outreach_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', ws!).eq(kind === 'lists' ? 'list_id' : 'stage_id', id);
        const { count, error } = await q;
        if (error) throw error;
        return [id, count ?? 0] as const;
      }));
      return Object.fromEntries(entries) as Record<string, number>;
    },
  });
}

const ICON: Record<TaxonomyKind, React.ReactNode> = { lists: <FolderOpen className="w-6 h-6" />, stages: <Layers className="w-6 h-6" />, tags: <TagIcon className="w-6 h-6" /> };

/**
 * Full-width management panel for one taxonomy (lists, stages or tags): add, rename, recolour, reorder, delete,
 * with a lead count per row and a shortcut to the lead table filtered on that row.
 */
export function TaxonomyPanel({ kind, toast, onViewLeads }: { kind: TaxonomyKind; toast: ToastFn; onViewLeads: (id: string) => void }) {
  const { workspace, canWrite, isManager } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const meta = TAXONOMY[kind];
  const lists = useLists(kind === 'lists' ? ws : null);
  const stages = useStages(kind === 'stages' ? ws : null);
  const tags = useTags(kind === 'tags' ? ws : null);
  const clients = useClients(kind === 'lists' ? ws : null);
  const q = kind === 'lists' ? lists : kind === 'stages' ? stages : tags;
  const rows = (q.data ?? []) as Row[];
  const counts = useTaxonomyCounts(ws, kind, rows.map((r) => r.id));

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PALETTE[8]);
  const [newClient, setNewClient] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);

  const invalidate = () => {
    if (!ws) return;
    qc.invalidateQueries({ queryKey: kind === 'lists' ? qk.lists(ws) : kind === 'stages' ? qk.stages(ws) : qk.tags(ws) });
    qc.invalidateQueries({ queryKey: ['outreach', ws, 'leads'] });
    qc.invalidateQueries({ queryKey: ['outreach', ws, 'taxonomy-counts', kind] });
  };

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(key); setError(null);
    try { await fn(); invalidate(); if (ok) toast(ok); }
    catch (e) { setError(parseError(e).message); }
    finally { setBusy(null); }
  };

  const create = () => {
    const name = newName.trim();
    if (!ws || !name) return;
    run('create', async () => {
      const payload: Record<string, unknown> = { workspace_id: ws, name };
      if (kind === 'tags') payload.color = newColor;
      if (kind === 'stages') { payload.color = newColor; payload.position = rows.length ? Math.max(...rows.map((r) => r.position ?? 0)) + 1 : 0; }
      if (kind === 'lists') payload.client_id = newClient || null;
      const { error: err } = await supabase.from(meta.table).insert(payload);
      if (err) throw err;
      setNewName('');
    }, `${meta.singular[0].toUpperCase()}${meta.singular.slice(1)} created`);
  };

  const saveEdit = (row: Row) => {
    const name = editName.trim();
    if (!name) return;
    run(row.id, async () => {
      const patch: Record<string, unknown> = { name };
      if (kind !== 'lists') patch.color = editColor || null;
      const { error: err } = await supabase.from(meta.table).update(patch).eq('id', row.id);
      if (err) throw err;
      setEditing(null);
    }, 'Saved');
  };

  const remove = (row: Row) => run(row.id, async () => {
    const { error: err } = await supabase.from(meta.table).delete().eq('id', row.id);
    if (err) throw err;
    setConfirmDelete(null);
  }, 'Deleted');

  const move = (row: Row, dir: -1 | 1) => {
    const sorted = [...rows].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const i = sorted.findIndex((r) => r.id === row.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= sorted.length) return;
    const other = sorted[j];
    run(row.id, async () => {
      const a = await supabase.from(meta.table).update({ position: j }).eq('id', row.id);
      if (a.error) throw a.error;
      const b = await supabase.from(meta.table).update({ position: i }).eq('id', other.id);
      if (b.error) throw b.error;
    });
  };

  const canDelete = canWrite && (kind !== 'stages' || isManager);
  const clientName = (id: string | null | undefined) => (id ? clients.data?.find((c) => c.id === id)?.name ?? 'Client' : null);
  const iconBtn = 'p-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-30 disabled:hover:bg-transparent';

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
        <p className="text-sm text-gray-600">{meta.blurb}</p>
        {canWrite && (
          <form className="mt-3 pt-3 border-t border-gray-100 flex flex-col gap-2 lg:flex-row lg:items-end" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <div className="flex-1 min-w-[200px]"><Input label={`New ${meta.singular}`} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={meta.placeholder} /></div>
            {kind === 'lists' && (clients.data?.length ?? 0) > 0 && (
              <div className="lg:w-52"><Select label="Client" value={newClient} onChange={(e) => setNewClient(e.target.value)}>
                <option value="">Any client</option>
                {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select></div>
            )}
            {kind !== 'lists' && (
              <div>
                <span className="block text-xs font-medium text-gray-600 mb-1.5">Colour</span>
                <div className="h-[38px] flex items-center"><ColorPicker value={newColor} onChange={setNewColor} /></div>
              </div>
            )}
            <Button type="submit" loading={busy === 'create'} disabled={!newName.trim()}><Plus className="w-4 h-4" /> Add {meta.singular}</Button>
          </form>
        )}
      </div>

      {error && <ErrorBox message={error} />}

      {q.isLoading ? <Spinner className="min-h-[30vh]" /> : q.error ? <ErrorBox message={parseError(q.error).message} /> : rows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl">
          <EmptyState icon={ICON[kind]} title={`No ${kind} yet`} description={canWrite ? `Create your first ${meta.singular} above.` : `Nobody has created a ${meta.singular} in this workspace yet.`} />
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              {kind === 'stages' && <Th className="w-12">#</Th>}
              <Th>Name</Th>
              {kind === 'lists' && <Th>Client</Th>}
              {kind === 'stages' && <Th title="Built-in meaning used by the pipeline and reports">Type</Th>}
              <Th className="text-right">Leads</Th>
              <Th className="text-right"><span className="sr-only">Actions</span></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const isEditing = editing === row.id;
              const n = counts.data?.[row.id];
              return (
                <tr key={row.id} className="hover:bg-gray-50/60">
                  {kind === 'stages' && <Td className="text-xs text-gray-400 tabular-nums">{idx + 1}</Td>}
                  <Td>
                    {isEditing ? (
                      <div className="space-y-2 max-w-md">
                        <input aria-label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(row); if (e.key === 'Escape') setEditing(null); }}
                          className="w-full px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" autoFocus />
                        {kind !== 'lists' && <ColorPicker value={editColor} onChange={setEditColor} />}
                      </div>
                    ) : kind === 'lists' ? (
                      <span className="font-medium text-gray-900">{row.name}</span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border" style={chipStyle(row.color)}>{row.name}</span>
                    )}
                  </Td>
                  {kind === 'lists' && <Td className="text-gray-500">{clientName(row.client_id) ?? <span className="text-gray-400">Any client</span>}</Td>}
                  {kind === 'stages' && <Td className="text-gray-500 capitalize">{row.kind ?? <span className="text-gray-400">Custom</span>}</Td>}
                  <Td className="text-right tabular-nums text-gray-700">{n == null ? <span className="text-gray-300">…</span> : n.toLocaleString()}</Td>
                  <Td className="text-right">
                    <div className="inline-flex items-center gap-0.5">
                      {isEditing ? (
                        <>
                          <button type="button" title="Save" onClick={() => saveEdit(row)} disabled={busy === row.id || !editName.trim()} className="p-1.5 rounded-md text-green-600 hover:bg-green-50 disabled:opacity-30"><Check className="w-4 h-4" /></button>
                          <button type="button" title="Cancel" onClick={() => setEditing(null)} className={iconBtn}><X className="w-4 h-4" /></button>
                        </>
                      ) : (
                        <>
                          <button type="button" title={`Show leads in this ${meta.singular}`} onClick={() => onViewLeads(row.id)} className={iconBtn}><Users className="w-4 h-4" /></button>
                          {canWrite && kind === 'stages' && (
                            <>
                              <button type="button" title="Move up" onClick={() => move(row, -1)} disabled={idx === 0 || !!busy} className={iconBtn}><ChevronUp className="w-4 h-4" /></button>
                              <button type="button" title="Move down" onClick={() => move(row, 1)} disabled={idx === rows.length - 1 || !!busy} className={iconBtn}><ChevronDown className="w-4 h-4" /></button>
                            </>
                          )}
                          {canWrite && <button type="button" title="Rename" onClick={() => { setEditing(row.id); setEditName(row.name); setEditColor(row.color ?? PALETTE[0]); }} className={iconBtn}><Pencil className="w-4 h-4" /></button>}
                          {canDelete && <button type="button" title="Delete" onClick={() => setConfirmDelete(row)} className="p-1.5 rounded-md text-gray-500 hover:bg-red-50 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>}
                        </>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {kind === 'stages' && canWrite && !isManager && <p className="text-xs text-gray-500">Only managers can delete stages.</p>}

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title={`Delete "${confirmDelete?.name ?? ''}"?`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button><Button variant="danger" loading={!!confirmDelete && busy === confirmDelete.id} onClick={() => confirmDelete && remove(confirmDelete)}>Delete</Button></>}>
        <p className="text-sm text-gray-600">
          {confirmDelete && counts.data?.[confirmDelete.id] ? <>{counts.data[confirmDelete.id].toLocaleString()} lead{counts.data[confirmDelete.id] === 1 ? '' : 's'} currently use this {meta.singular}. </> : null}
          {meta.deleteHint} This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
