'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { qk, useClients, useSenders, useSequences } from '@/lib/outreach/queries';
import { Button, Card, EmptyState, ErrorBox, Input, Modal, PageHeader, Select, Spinner, Table, Td, Th, fmtDate, useToast } from '@/components/outreach/ui';
import { browserTimezone, slugify, timezoneOptions } from '@/components/outreach/senders/helpers';
import type { Client } from '@/lib/outreach/types';

export default function ClientsPage() {
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const clients = useClients(ws);
  const senders = useSenders(isManager ? ws : null);
  const sequences = useSequences(isManager ? ws : null);
  const tzList = useMemo(() => timezoneOptions(), []);
  const [editing, setEditing] = useState<Client | 'new' | null>(null);
  const [form, setForm] = useState({ name: '', slug: '', timezone: browserTimezone(), slugTouched: false });
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing === 'new') setForm({ name: '', slug: '', timezone: browserTimezone(), slugTouched: false });
    else if (editing) setForm({ name: editing.name, slug: editing.slug ?? '', timezone: editing.timezone ?? browserTimezone(), slugTouched: true });
    setError(null);
  }, [editing]);

  const clientIds = (clients.data ?? []).map((c) => c.id);
  const leadCounts = useQuery({
    queryKey: ['outreach', ws ?? '', 'client-lead-counts', clientIds], enabled: !!ws && isManager && clientIds.length > 0,
    queryFn: async () => {
      const out: Record<string, number> = {};
      await Promise.all(clientIds.map(async (id) => { const { count, error } = await supabase.from('outreach_leads').select('id', { count: 'exact', head: true }).eq('workspace_id', ws!).eq('client_id', id); if (error) throw parseError(error); out[id] = count ?? 0; }));
      return out;
    },
  });
  const senderCount = useMemo(() => { const m: Record<string, number> = {}; for (const s of senders.data ?? []) if (s.client_id && s.status !== 'disabled') m[s.client_id] = (m[s.client_id] ?? 0) + 1; return m; }, [senders.data]);
  const sequenceCount = useMemo(() => { const m: Record<string, number> = {}; for (const s of sequences.data ?? []) if (s.client_id && s.status !== 'archived') m[s.client_id] = (m[s.client_id] ?? 0) + 1; return m; }, [sequences.data]);

  const refresh = () => { qc.invalidateQueries({ queryKey: qk.clients(ws ?? '') }); qc.invalidateQueries({ queryKey: qk.senders(ws ?? '') }); qc.invalidateQueries({ queryKey: qk.sequences(ws ?? '') }); };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const name = form.name.trim(); const slug = slugify(form.slug || name) || null;
    if (!name) return;
    setBusy(true); setError(null);
    try {
      if (editing === 'new') { const { error: er } = await supabase.from('outreach_clients').insert({ workspace_id: ws, name, slug, timezone: form.timezone || null }); if (er) throw er; toast.show('Client created.'); }
      else if (editing) { const { error: er } = await supabase.from('outreach_clients').update({ name, slug, timezone: form.timezone || null }).eq('id', editing.id); if (er) throw er; toast.show('Client updated.'); }
      setEditing(null); refresh();
    } catch (er) { const pe = parseError(er); setError(/duplicate|unique/i.test(pe.message) ? 'That slug is already used by another client in this workspace.' : pe.message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!deleteTarget) return;
    setBusy(true);
    try { const { error: er } = await supabase.from('outreach_clients').delete().eq('id', deleteTarget.id); if (er) throw er; toast.show('Client deleted. Its senders, leads and sequences are now unassigned.'); setDeleteTarget(null); refresh(); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(false); }
  }

  if (!workspace) return <Spinner />;
  if (!isManager) return <div><PageHeader title="Clients" /><ErrorBox message="Only owners and managers can manage clients." /></div>;

  return (
    <div>
      <PageHeader title="Clients" subtitle="Optional partitions for agencies: scope senders, leads, sequences and viewers per client"
        actions={<Button onClick={() => setEditing('new')} disabled={!canWrite}><Plus className="w-4 h-4" /> New client</Button>} />

      {clients.isLoading ? <Spinner /> : clients.isError ? <ErrorBox message={(clients.error as Error).message} /> : !clients.data?.length ? (
        <Card><EmptyState icon={<Building2 className="w-6 h-6" />} title="No clients yet" description="Clients are optional. Create one per customer if you run outreach for several companies; you can then invite a client viewer who only sees their own inbox and stats." action={<Button onClick={() => setEditing('new')} disabled={!canWrite}>Create client</Button>} /></Card>
      ) : (
        <Table>
          <thead><tr><Th>Client</Th><Th>Slug</Th><Th>Timezone</Th><Th className="text-right">Senders</Th><Th className="text-right">Leads</Th><Th className="text-right">Sequences</Th><Th>Created</Th><Th></Th></tr></thead>
          <tbody>
            {clients.data.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium text-gray-900">{c.name}</Td>
                <Td className="font-mono text-xs text-gray-600">{c.slug ?? '—'}</Td>
                <Td>{c.timezone ?? <span className="text-gray-400">—</span>}</Td>
                <Td className="text-right tabular-nums">{senders.isLoading ? '…' : senderCount[c.id] ?? 0}</Td>
                <Td className="text-right tabular-nums">{leadCounts.isLoading ? '…' : leadCounts.data?.[c.id] ?? 0}</Td>
                <Td className="text-right tabular-nums">{sequences.isLoading ? '…' : sequenceCount[c.id] ?? 0}</Td>
                <Td className="whitespace-nowrap">{fmtDate(c.created_at, false)}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    <Link href={`/outreach/c/${c.id}`} title="Open client viewer"><Button size="sm" variant="ghost"><ExternalLink className="w-4 h-4" /></Button></Link>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(c)} disabled={!canWrite} aria-label="Edit client"><Pencil className="w-4 h-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(c)} disabled={!canWrite} aria-label="Delete client"><Trash2 className="w-4 h-4 text-red-500" /></Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'New client' : 'Edit client'} size="sm"
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save} loading={busy} disabled={!form.name.trim()}>{editing === 'new' ? 'Create' : 'Save'}</Button></>}>
        <form onSubmit={save} className="space-y-3">
          <Input label="Name" value={form.name} autoFocus required onChange={(e) => setForm({ ...form, name: e.target.value, slug: form.slugTouched ? form.slug : slugify(e.target.value) })} placeholder="Acme Corp" />
          <Input label="Slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: slugify(e.target.value), slugTouched: true })} hint="Used in URLs and exports; letters, digits and dashes." />
          <Select label="Timezone" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {!tzList.includes(form.timezone) && form.timezone && <option value={form.timezone}>{form.timezone}</option>}
            {tzList.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </Select>
          {error && <ErrorBox message={error} />}
        </form>
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete client?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="danger" onClick={remove} loading={busy}>Delete</Button></>}>
        <p className="text-sm text-gray-700">Deleting <strong>{deleteTarget?.name}</strong> does not delete senders, leads or sequences — they become unassigned (no client). Client viewers scoped to this client lose access to it.</p>
      </Modal>
      {toast.node}
    </div>
  );
}
