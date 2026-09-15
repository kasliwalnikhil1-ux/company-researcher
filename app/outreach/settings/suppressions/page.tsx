'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, Plus, Trash2, Upload } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { qk, useSuppressions } from '@/lib/outreach/queries';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, PageHeader, Select, Spinner, Table, Td, Textarea, Th, fmtDate, useToast } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import type { Suppression } from '@/lib/outreach/types';

type Kind = Suppression['kind'];
const KINDS: Array<{ value: Kind; label: string; hint: string }> = [
  { value: 'domain', label: 'Email domain', hint: 'e.g. competitor.com — blocks every lead with a work email at that domain' },
  { value: 'public_identifier', label: 'LinkedIn identifier', hint: 'the part after linkedin.com/in/' },
  { value: 'email', label: 'Email address', hint: 'exact address' },
];

function detectKind(v: string): Kind { if (v.includes('@')) return 'email'; if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) && !v.includes('/')) return 'domain'; return 'public_identifier'; }
function normalize(kind: Kind, raw: string): string {
  let v = raw.trim();
  if (kind === 'public_identifier') { v = v.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, '').replace(/\/.*$/, '').replace(/\?.*$/, ''); }
  if (kind === 'domain') { v = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').replace(/^@/, ''); }
  return v.toLowerCase();
}

export default function SuppressionsSettingsPage() {
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const list = useSuppressions(ws);
  const canEdit = isManager && canWrite;
  const [kind, setKind] = useState<Kind>('domain');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [bulk, setBulk] = useState('');
  const [bulkKind, setBulkKind] = useState<Kind | 'auto'>('auto');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(() => (list.data ?? []).filter((s) => !filter || s.value.includes(filter.toLowerCase()) || (s.reason ?? '').toLowerCase().includes(filter.toLowerCase())), [list.data, filter]);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.suppressions(ws ?? '') });

  async function insert(items: Array<{ kind: Kind; value: string; reason: string | null }>) {
    const clean = items.filter((i) => i.value);
    if (!clean.length) return 0;
    const { error } = await supabase.from('outreach_suppressions').upsert(clean.map((i) => ({ workspace_id: ws, ...i })), { onConflict: 'workspace_id,kind,value', ignoreDuplicates: true });
    if (error) throw error;
    return clean.length;
  }

  async function addOne(e: React.FormEvent) {
    e.preventDefault();
    setBusy('one');
    try { await insert([{ kind, value: normalize(kind, value), reason: reason.trim() || null }]); toast.show('Suppression added.'); setValue(''); setReason(''); refresh(); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  async function addBulk() {
    const lines = bulk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setBusy('bulk');
    try {
      const items = lines.map((l) => { const k = bulkKind === 'auto' ? detectKind(l) : bulkKind; return { kind: k, value: normalize(k, l), reason: reason.trim() || 'bulk import' }; });
      const n = await insert(items);
      toast.show(`${n} entr${n === 1 ? 'y' : 'ies'} processed (duplicates ignored).`); setBulk(''); refresh();
    } catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  async function remove(s: Suppression) {
    setBusy(s.id);
    try { const { error } = await supabase.from('outreach_suppressions').delete().eq('id', s.id); if (error) throw error; refresh(); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  if (!workspace) return <Spinner />;

  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <SettingsTabs />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2" title={<span className="flex items-center gap-2"><Ban className="w-4 h-4" /> Suppression list</span>} actions={<div className="w-56"><Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter suppressions" /></div>}>
          <p className="text-xs text-gray-500 mb-4">Suppressed leads are never contacted: enrolling them is refused and any live enrollment exits with <code>exited_suppressed</code>. Leads also carry their own “do not contact” flag, and email unsubscribes are honoured globally.</p>
          {list.isLoading ? <Spinner /> : list.isError ? <ErrorBox message={(list.error as Error).message} /> : rows.length === 0 ? <EmptyState title={list.data?.length ? 'No matches' : 'Nothing suppressed'} description={list.data?.length ? 'Try a different filter.' : 'Add competitor domains, existing customers or people who asked not to be contacted.'} /> : (
            <Table>
              <thead><tr><Th>Kind</Th><Th>Value</Th><Th>Reason</Th><Th>Added</Th><Th></Th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <Td><Badge tone={s.kind === 'domain' ? 'blue' : s.kind === 'email' ? 'purple' : 'indigo'}>{s.kind.replace('_', ' ')}</Badge></Td>
                    <Td className="font-mono text-xs text-gray-900 break-all">{s.value}</Td>
                    <Td className="text-gray-600">{s.reason ?? <span className="text-gray-300">—</span>}</Td>
                    <Td className="whitespace-nowrap">{fmtDate(s.created_at, false)}</Td>
                    <Td className="text-right">{canEdit && <Button size="sm" variant="ghost" onClick={() => remove(s)} loading={busy === s.id} aria-label="Remove suppression"><Trash2 className="w-4 h-4 text-red-500" /></Button>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Add one">
            {!canEdit && <div className="text-xs text-gray-400 mb-2">Only managers can edit suppressions.</div>}
            <form onSubmit={addOne} className="space-y-3">
              <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} disabled={!canEdit}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select>
              <Input label="Value" value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'domain' ? 'competitor.com' : kind === 'email' ? 'jane@company.com' : 'jane-doe-123'} hint={KINDS.find((k) => k.value === kind)?.hint} required disabled={!canEdit} />
              <Input label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="existing customer" disabled={!canEdit} />
              <Button type="submit" className="w-full" loading={busy === 'one'} disabled={!canEdit || !value.trim()}><Plus className="w-4 h-4" /> Add</Button>
            </form>
          </Card>
          <Card title="Bulk paste">
            <div className="space-y-3">
              <Select label="Kind" value={bulkKind} onChange={(e) => setBulkKind(e.target.value as Kind | 'auto')} disabled={!canEdit}><option value="auto">Auto-detect per line</option>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select>
              <Textarea label="One value per line" value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'competitor.com\njane@acme.com\nlinkedin.com/in/jane-doe'} hint="Auto-detect: contains @ → email, looks like a host → domain, otherwise LinkedIn identifier. Full LinkedIn URLs are trimmed." disabled={!canEdit} />
              <Button variant="secondary" className="w-full" onClick={addBulk} loading={busy === 'bulk'} disabled={!canEdit || !bulk.trim()}><Upload className="w-4 h-4" /> Import {bulk.split(/\r?\n/).filter((l) => l.trim()).length || ''} lines</Button>
            </div>
          </Card>
        </div>
      </div>
      {toast.node}
    </div>
  );
}
