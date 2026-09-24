'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { BarChart3, Building2, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { qk, useClients, useSenders, useSequences } from '@/lib/outreach/queries';
import { Button, Card, EmptyState, ErrorBox, fmtDate, Input, Modal, PageHeader, PageLoader, SearchableSelect, Spinner, Table, Td, Th, useToast } from '@/components/outreach/ui';
import { browserTimezone, slugify, timezoneChoices } from '@/components/outreach/senders/helpers';
import type { Client } from '@/lib/outreach/types';
import { fmtInt, fmtRate, presetRange, useReportClients } from '@/lib/outreach/reports';
import { CountRate, MetricLabel } from '@/components/outreach/reports/primitives';

export default function ClientsPage() {
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const clients = useClients(ws);
  const senders = useSenders(isManager ? ws : null);
  const sequences = useSequences(isManager ? ws : null);
  const tzList = useMemo(() => timezoneChoices(), []);
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

  // Last 30 days per client, from the same function the reports page uses (one call for every client).
  const timezone = (typeof workspace?.settings?.timezone === 'string' && workspace.settings.timezone) || 'UTC';
  const range = useMemo(() => presetRange('30d', timezone), [timezone]);
  const report = useReportClients({ ws, range, enabled: isManager });
  const byClient = useMemo(() => Object.fromEntries((report.data ?? []).map((r) => [r.client_id, r])), [report.data]);
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

  if (!workspace) return <PageLoader />;
  if (!isManager) return <div><PageHeader title="Clients" /><ErrorBox message="Only owners and managers can manage clients." /></div>;

  return (
    <div>
      <PageHeader title="Clients" subtitle="Optional partitions for agencies: scope senders, leads, sequences and viewers per client"
        actions={<Button onClick={() => setEditing('new')} disabled={!canWrite}><Plus className="w-4 h-4" /> New client</Button>} />

      {clients.isLoading ? <Spinner className="min-h-[50vh]" /> : clients.isError ? <ErrorBox message={(clients.error as Error).message} /> : !clients.data?.length ? (
        <Card><EmptyState icon={<Building2 className="w-6 h-6" />} title="No clients yet" description="Clients are optional. Create one per customer if you run outreach for several companies; you can then invite a client viewer who only sees their own inbox and stats." action={<Button onClick={() => setEditing('new')} disabled={!canWrite}>Create client</Button>} /></Card>
      ) : (
        <Table>
          <thead><tr><Th>Client</Th><Th>Slug</Th><Th>Timezone</Th><Th className="text-right">Senders</Th><Th className="text-right">Leads</Th><Th className="text-right">Sequences</Th><Th className="text-right"><MetricLabel metric="touches">Touches (30d)</MetricLabel></Th><Th className="text-right"><MetricLabel metric="replies">Replies (30d)</MetricLabel></Th><Th className="text-right"><MetricLabel metric="interested">Interested (30d)</MetricLabel></Th><Th>Created</Th><Th></Th></tr></thead>
          <tbody>
            {clients.data.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium text-gray-900">{c.name}</Td>
                <Td className="font-mono text-xs text-gray-600">{c.slug ?? '—'}</Td>
                <Td>{c.timezone ?? <span className="text-gray-400">—</span>}</Td>
                <Td className="text-right tabular-nums">{senders.isLoading ? '…' : senderCount[c.id] ?? 0}</Td>
                <Td className="text-right tabular-nums">{report.isLoading ? '…' : fmtInt(byClient[c.id]?.leads ?? 0)}</Td>
                <Td className="text-right tabular-nums">{sequences.isLoading ? '…' : sequenceCount[c.id] ?? 0}</Td>
                <Td className="text-right tabular-nums">{report.isLoading ? '…' : fmtInt(byClient[c.id]?.totals.touches ?? 0)}</Td>
                <Td className="text-right">{report.isLoading ? '…' : byClient[c.id] ? <CountRate count={fmtInt(byClient[c.id].totals.replies)} rate={fmtRate(byClient[c.id].totals.reply_rate)} /> : '—'}</Td>
                <Td className="text-right">{report.isLoading ? '…' : byClient[c.id] ? <CountRate count={fmtInt(byClient[c.id].totals.interested)} rate={fmtRate(byClient[c.id].totals.positive_reply_rate)} /> : '—'}</Td>
                <Td className="whitespace-nowrap">{fmtDate(c.created_at, false)}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    <Link href={`/outreach/reports?client=${c.id}`} title="Open this client in reports"><Button size="sm" variant="ghost" aria-label="Open this client in reports"><BarChart3 className="w-4 h-4" /></Button></Link>
                    <Link href={`/outreach/c/${c.id}`} title="Open the client portal"><Button size="sm" variant="ghost" aria-label="Open the client portal"><ExternalLink className="w-4 h-4" /></Button></Link>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(c)} disabled={!canWrite} aria-label="Edit client"><Pencil className="w-4 h-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(c)} disabled={!canWrite} aria-label="Delete client"><Trash2 className="w-4 h-4 text-red-500" /></Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {report.isError && <ErrorBox className="mt-3" message={`The 30-day numbers could not be loaded. ${(report.error as Error).message}`} />}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'New client' : 'Edit client'} size="sm"
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save} loading={busy} disabled={!form.name.trim()}>{editing === 'new' ? 'Create' : 'Save'}</Button></>}>
        <form onSubmit={save} className="space-y-3">
          <Input label="Name" value={form.name} autoFocus required onChange={(e) => setForm({ ...form, name: e.target.value, slug: form.slugTouched ? form.slug : slugify(e.target.value) })} placeholder="Acme Corp" />
          <Input label="Slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: slugify(e.target.value), slugTouched: true })} hint="Used in URLs and exports; letters, digits and dashes." />
          <SearchableSelect label="Timezone" value={form.timezone} onChange={(tz) => setForm({ ...form, timezone: tz })} options={tzList} searchPlaceholder="Search city, region or GMT offset…" />
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
