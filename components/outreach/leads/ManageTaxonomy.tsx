'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useClients, useLists, useStages, useTags } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { Button, EmptyState, ErrorBox, Input, Modal, Select, Spinner } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { Check, Pencil, Trash2, X, ChevronUp, ChevronDown } from 'lucide-react';
import { PALETTE, chipStyle, type ToastFn } from './helpers';

export type TaxonomyKind = 'lists' | 'stages' | 'tags';
const TABLE: Record<TaxonomyKind, string> = { lists: 'outreach_lists', stages: 'outreach_stages', tags: 'outreach_tags' };
const TITLE: Record<TaxonomyKind, string> = { lists: 'Manage lists', stages: 'Manage stages', tags: 'Manage tags' };

interface Row { id: string; name: string; color?: string | null; position?: number; client_id?: string | null }

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Colour">
      {PALETTE.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} title={c} onClick={() => onChange(c)}
          className={cn('w-5 h-5 rounded-full border-2', value === c ? 'border-gray-900' : 'border-transparent')} style={{ backgroundColor: c }} />
      ))}
    </div>
  );
}

export function ManageTaxonomyModal({ kind, open, onClose, toast }: { kind: TaxonomyKind; open: boolean; onClose: () => void; toast: ToastFn }) {
  const { workspace, isManager } = useWorkspace();
  const qc = useQueryClient();
  const lists = useLists(kind === 'lists' ? workspace?.id : null);
  const stages = useStages(kind === 'stages' ? workspace?.id : null);
  const tags = useTags(kind === 'tags' ? workspace?.id : null);
  const clients = useClients(kind === 'lists' ? workspace?.id : null);
  const q = kind === 'lists' ? lists : kind === 'stages' ? stages : tags;
  const rows = (q.data ?? []) as Row[];

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PALETTE[8]);
  const [newClient, setNewClient] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);

  const invalidate = () => { if (workspace) qc.invalidateQueries({ queryKey: kind === 'lists' ? qk.lists(workspace.id) : kind === 'stages' ? qk.stages(workspace.id) : qk.tags(workspace.id) }); if (workspace) qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'leads'] }); };

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(key); setError(null);
    try { await fn(); invalidate(); if (ok) toast(ok); }
    catch (e) { setError(parseError(e).message); }
    finally { setBusy(null); }
  };

  const create = () => {
    const name = newName.trim();
    if (!workspace || !name) return;
    run('create', async () => {
      const payload: Record<string, unknown> = { workspace_id: workspace.id, name };
      if (kind === 'tags') payload.color = newColor;
      if (kind === 'stages') { payload.color = newColor; payload.position = rows.length ? Math.max(...rows.map((r) => r.position ?? 0)) + 1 : 0; }
      if (kind === 'lists') payload.client_id = newClient || null;
      const { error: err } = await supabase.from(TABLE[kind]).insert(payload);
      if (err) throw err;
      setNewName('');
    }, 'Created');
  };

  const saveEdit = (row: Row) => {
    const name = editName.trim();
    if (!name) return;
    run(row.id, async () => {
      const patch: Record<string, unknown> = { name };
      if (kind !== 'lists') patch.color = editColor || null;
      const { error: err } = await supabase.from(TABLE[kind]).update(patch).eq('id', row.id);
      if (err) throw err;
      setEditing(null);
    }, 'Saved');
  };

  const remove = (row: Row) => run(row.id, async () => {
    const { error: err } = await supabase.from(TABLE[kind]).delete().eq('id', row.id);
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
      const a = await supabase.from(TABLE[kind]).update({ position: j }).eq('id', row.id);
      if (a.error) throw a.error;
      const b = await supabase.from(TABLE[kind]).update({ position: i }).eq('id', other.id);
      if (b.error) throw b.error;
    });
  };

  const canDelete = kind === 'stages' ? isManager : true;
  const deleteHint = kind === 'lists' ? 'Leads in this list keep their data; the list field is cleared.' : kind === 'stages' ? 'Leads in this stage will have no stage.' : 'The tag is removed from every lead.';

  return (
    <Modal open={open} onClose={onClose} title={TITLE[kind]} size="md" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="flex-1"><Input label={`New ${kind.slice(0, -1)}`} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={kind === 'lists' ? 'Q3 SaaS founders' : kind === 'stages' ? 'Qualified' : 'hot'} /></div>
            {kind === 'lists' && (
              <div className="sm:w-44"><Select label="Client" value={newClient} onChange={(e) => setNewClient(e.target.value)}>
                <option value="">Any client</option>
                {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select></div>
            )}
            <Button type="submit" loading={busy === 'create'} disabled={!newName.trim()}>Add</Button>
          </div>
          {kind !== 'lists' && <ColorPicker value={newColor} onChange={setNewColor} />}
        </form>
        {error && <ErrorBox message={error} />}
        {q.isLoading ? <Spinner /> : rows.length === 0 ? <EmptyState title={`No ${kind} yet`} description={`Create your first ${kind.slice(0, -1)} above.`} /> : (
          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
            {rows.map((row, idx) => (
              <li key={row.id} className="px-3 py-2 flex items-center gap-2">
                {editing === row.id ? (
                  <div className="flex-1 space-y-2">
                    <input aria-label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(row); if (e.key === 'Escape') setEditing(null); }} className="w-full px-2 py-1 text-sm rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" autoFocus />
                    {kind !== 'lists' && <ColorPicker value={editColor} onChange={setEditColor} />}
                  </div>
                ) : (
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    {kind === 'stages' && <span className="text-xs text-gray-400 w-5 tabular-nums">{idx + 1}.</span>}
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border truncate" style={kind !== 'lists' ? chipStyle(row.color) : undefined}>{row.name}</span>
                    {kind === 'lists' && row.client_id && <span className="text-xs text-gray-400 truncate">{clients.data?.find((c) => c.id === row.client_id)?.name ?? 'client'}</span>}
                  </div>
                )}
                <div className="flex items-center gap-0.5">
                  {editing === row.id ? (
                    <>
                      <button title="Save" onClick={() => saveEdit(row)} disabled={busy === row.id} className="p-1.5 rounded-md text-green-600 hover:bg-green-50"><Check className="w-4 h-4" /></button>
                      <button title="Cancel" onClick={() => setEditing(null)} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"><X className="w-4 h-4" /></button>
                    </>
                  ) : (
                    <>
                      {kind === 'stages' && (
                        <>
                          <button title="Move up" onClick={() => move(row, -1)} disabled={idx === 0 || !!busy} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-30"><ChevronUp className="w-4 h-4" /></button>
                          <button title="Move down" onClick={() => move(row, 1)} disabled={idx === rows.length - 1 || !!busy} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-30"><ChevronDown className="w-4 h-4" /></button>
                        </>
                      )}
                      <button title="Rename" onClick={() => { setEditing(row.id); setEditName(row.name); setEditColor(row.color ?? PALETTE[0]); }} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"><Pencil className="w-4 h-4" /></button>
                      {canDelete && <button title="Delete" onClick={() => setConfirmDelete(row)} className="p-1.5 rounded-md text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {kind === 'stages' && !isManager && <p className="text-xs text-gray-500">Only managers can delete stages.</p>}
      </div>
      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title={`Delete "${confirmDelete?.name ?? ''}"?`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button><Button variant="danger" loading={!!confirmDelete && busy === confirmDelete.id} onClick={() => confirmDelete && remove(confirmDelete)}>Delete</Button></>}>
        <p className="text-sm text-gray-600">{deleteHint} This cannot be undone.</p>
      </Modal>
    </Modal>
  );
}
