'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk, useClients, useSequences } from '@/lib/outreach/queries';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Select, Spinner, Table, Td, Th, fmtDate, useToast } from '@/components/outreach/ui';
import { ConfirmModal, SettingsFrame } from '@/components/outreach/settings/shared';
import BlacklistUpload from '@/components/outreach/settings/BlacklistUpload';
import { sk, useBlacklist } from '@/components/outreach/settings/hooks';
import type { AddSuppressionsResult, BlacklistKind, BlacklistRow, BlacklistScope } from '@/components/outreach/settings/types';
import { cn } from '@/lib/utils';
import { sanitizeLike, usePersistedFilters } from '@/lib/outreach/persistedFilters';

const KINDS: Array<{ value: BlacklistKind; label: string; placeholder: string; hint: string; tone: 'blue' | 'purple' | 'indigo' | 'amber' }> = [
  { value: 'domain', label: 'Domain', placeholder: 'competitor.com', hint: 'Blocks every lead whose work or personal email is at this domain.', tone: 'blue' },
  { value: 'email', label: 'Email', placeholder: 'jane@company.com', hint: 'Blocks this exact address.', tone: 'purple' },
  { value: 'public_identifier', label: 'LinkedIn profile', placeholder: 'linkedin.com/in/jane-doe', hint: 'Paste the profile URL or the part after /in/.', tone: 'indigo' },
  { value: 'company', label: 'Company', placeholder: 'Acme Inc or linkedin.com/company/acme', hint: 'The company name as it appears on the lead (letter case does not matter), or its LinkedIn company URL. Blocks everyone who works there.', tone: 'amber' },
];
const kindMeta = (k: string) => KINDS.find((x) => x.value === k);
const PAGE = 100;

function sourceLabel(source: string): { text: string; tone: 'gray' | 'blue' | 'green' | 'amber' } {
  if (source === 'manual') return { text: 'Manual', tone: 'gray' };
  if (source === 'csv') return { text: 'CSV', tone: 'blue' };
  if (source === 'unsubscribe') return { text: 'Unsubscribe', tone: 'amber' };
  if (source.startsWith('crm')) { const p = source.split(':')[1]; return { text: p ? `CRM: ${p[0].toUpperCase()}${p.slice(1)}` : 'CRM', tone: 'green' }; }
  return { text: source, tone: 'gray' };
}

function validate(kind: BlacklistKind, raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Enter a value';
  if (v.length > 300) return 'That value is too long';
  if (kind === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return 'Enter a full email address';
  if (kind === 'domain' && !/^(https?:\/\/)?(www\.)?([a-z0-9-]+\.)+[a-z]{2,}([/?#].*)?$/i.test(v)) return 'Enter a domain such as competitor.com';
  if (kind === 'public_identifier' && /\s/.test(v)) return 'Paste the profile URL or the part after /in/';
  if (kind === 'public_identifier' && /linkedin\.com\//i.test(v) && !/linkedin\.com\/in\//i.test(v)) return 'That is not a profile URL. For a company page choose Company.';
  return null;
}

export default function BlacklistsSettingsPage() {
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  // Short lists are searched in the browser (value, reason, client, sequence). A list longer than one server page is searched by value in the database.
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(t); }, [search]);
  const all = useBlacklist(ws);
  const longList = (all.data?.total ?? 0) > (all.data?.rows.length ?? 0);
  const list = useBlacklist(ws, longList ? debounced : '');
  const clients = useClients(ws);
  const sequences = useSequences(ws);
  const canEdit = isManager && canWrite;

  // what gets added
  const [scope, setScope] = useState<BlacklistScope>('workspace');
  const [clientId, setClientId] = useState('');
  const [sequenceId, setSequenceId] = useState('');
  const [mode, setMode] = useState<'one' | 'csv'>('one');
  const [kind, setKind] = useState<BlacklistKind>('domain');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<BlacklistRow | null>(null);

  // what is shown
  // Scope, kind and source filters are remembered per workspace in this browser; the search is not.
  type ShownFilters = { fScope: 'all' | BlacklistScope; fKind: 'all' | BlacklistKind; fSource: 'all' | 'manual' | 'csv' | 'crm' | 'unsubscribe' };
  const { filters: shownFilters, patch: patchShown } = usePersistedFilters<ShownFilters>('suppressions', ws, { fScope: 'all', fKind: 'all', fSource: 'all' }, {
    sanitize: (raw, d) => {
      const v = sanitizeLike(raw, d);
      if (!['all', 'workspace', 'client', 'sequence'].includes(v.fScope)) v.fScope = 'all';
      if (v.fKind !== 'all' && !KINDS.some((k) => k.value === v.fKind)) v.fKind = 'all';
      if (!['all', 'manual', 'csv', 'crm', 'unsubscribe'].includes(v.fSource)) v.fSource = 'all';
      return v;
    },
  });
  const { fScope, fKind, fSource } = shownFilters;
  const setFScope = (v: ShownFilters['fScope']) => patchShown({ fScope: v });
  const setFKind = (v: ShownFilters['fKind']) => patchShown({ fKind: v });
  const setFSource = (v: ShownFilters['fSource']) => patchShown({ fSource: v });
  const [shown, setShown] = useState(PAGE);

  const clientName = useMemo(() => new Map((clients.data ?? []).map((c) => [c.id, c.name])), [clients.data]);
  const sequenceName = useMemo(() => new Map((sequences.data ?? []).map((s) => [s.id, s.name])), [sequences.data]);

  const scopeReady = scope === 'workspace' || (scope === 'client' ? !!clientId : !!sequenceId);
  const scopeLabel = scope === 'workspace' ? 'the whole workspace' : scope === 'client' ? (clientName.get(clientId) ?? 'the client') : (sequenceName.get(sequenceId) ?? 'the sequence');
  const pClient = scope === 'client' ? clientId || null : null;
  const pSequence = scope === 'sequence' ? sequenceId || null : null;
  const valueError = validate(kind, value);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list.data?.rows ?? []).filter((r) => {
      const rScope: BlacklistScope = r.sequence_id ? 'sequence' : r.client_id ? 'client' : 'workspace';
      if (fScope !== 'all' && rScope !== fScope) return false;
      if (fKind !== 'all' && r.kind !== fKind) return false;
      if (fSource !== 'all' && !(fSource === 'crm' ? r.source.startsWith('crm') : r.source === fSource)) return false;
      if (!q) return true;
      return r.value.toLowerCase().includes(q) || (r.reason ?? '').toLowerCase().includes(q)
        || (r.client_id ? (clientName.get(r.client_id) ?? '').toLowerCase().includes(q) : false)
        || (r.sequence_id ? (sequenceName.get(r.sequence_id) ?? '').toLowerCase().includes(q) : false);
    });
  }, [list.data, search, fScope, fKind, fSource, clientName, sequenceName]);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: sk.blacklist(ws ?? '') }), qc.invalidateQueries({ queryKey: qk.suppressions(ws ?? '') })]);

  async function addOne(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!ws || valueError || !scopeReady) return;
    setBusy('one');
    try {
      const r = await rpc<AddSuppressionsResult>('add_suppressions', { p_ws: ws, p_rows: [{ kind, value: value.trim(), reason: reason.trim() || null }], p_client: pClient, p_sequence: pSequence, p_source: 'manual' });
      if (r?.added) { toast.show(`Blocked for ${scopeLabel}. Leads that match stop being contacted; nothing is deleted.`); setValue(''); setReason(''); setTouched(false); }
      else toast.show('That entry is already on this list.', 'error');
      refresh();
    } catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  async function remove() {
    if (!toDelete) return;
    setBusy(toDelete.id);
    try {
      const { data, error } = await supabase.from('outreach_suppressions').delete().eq('id', toDelete.id).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('E_FORBIDDEN: only owners and managers can remove entries');
      toast.show('Removed. Matching leads can be contacted again.');
      setToDelete(null); refresh();
    } catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  const total = all.data?.total ?? 0;
  const loaded = list.data?.rows.length ?? 0;
  const windowed = (list.data?.total ?? 0) > loaded;

  return (
    <SettingsFrame>
      <div className="flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 mb-6">
        <ShieldCheck className="w-5 h-5 text-green-700 mt-0.5 flex-shrink-0" />
        <div className="text-sm text-green-900"><strong>Blocking never deletes a lead, its timeline or its conversations.</strong> A blocked lead cannot be enrolled, and a lead that is already in a sequence is stopped before its next step. Remove the entry and the lead can be contacted again.</div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2" title={<span className="flex items-center gap-2"><Ban className="w-4 h-4" /> Blacklists {total > 0 && <span className="text-xs font-normal text-gray-400">{total.toLocaleString()} entr{total === 1 ? 'y' : 'ies'}</span>}</span>}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
            <div className="col-span-2 md:col-span-1"><Input placeholder={longList ? 'Search by value…' : 'Search value, reason, client…'} value={search} onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }} aria-label="Search the blacklist" /></div>
            <Select aria-label="Filter by scope" value={fScope} onChange={(e) => { setFScope(e.target.value as typeof fScope); setShown(PAGE); }}><option value="all">All scopes</option><option value="workspace">Workspace</option><option value="client">Client</option><option value="sequence">Sequence</option></Select>
            <Select aria-label="Filter by kind" value={fKind} onChange={(e) => { setFKind(e.target.value as typeof fKind); setShown(PAGE); }}><option value="all">All kinds</option>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select>
            <Select aria-label="Filter by source" value={fSource} onChange={(e) => { setFSource(e.target.value as typeof fSource); setShown(PAGE); }}><option value="all">All sources</option><option value="manual">Manual</option><option value="csv">CSV</option><option value="crm">CRM</option><option value="unsubscribe">Unsubscribe</option></Select>
          </div>
          {list.isLoading ? <Spinner /> : list.isError ? <ErrorBox message={parseError(list.error).message} /> : rows.length === 0 ? (
            <EmptyState icon={<Ban className="w-6 h-6" />} title={total ? 'No matches' : 'Nothing is blocked yet'} description={total ? 'Try a different search or filter.' : 'Add competitors, existing customers, or people who asked not to be contacted. You can block for the whole workspace, one client or one sequence.'} />
          ) : (
            <>
              <Table>
                <thead><tr><Th>Kind</Th><Th>Value</Th><Th>Scope</Th><Th>Source</Th><Th>Reason</Th><Th>Added</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
                <tbody>
                  {rows.slice(0, shown).map((s) => {
                    const src = sourceLabel(s.source); const fromCrm = s.source.startsWith('crm');
                    return (
                      <tr key={s.id}>
                        <Td><Badge tone={kindMeta(s.kind)?.tone ?? 'gray'}>{kindMeta(s.kind)?.label ?? s.kind}</Badge></Td>
                        <Td className="font-mono text-xs text-gray-900 break-all">{s.value}</Td>
                        <Td className="whitespace-nowrap">{s.sequence_id ? <span title="Sequence"><span className="text-gray-400">Sequence · </span>{sequenceName.get(s.sequence_id) ?? 'deleted'}</span> : s.client_id ? <span title="Client"><span className="text-gray-400">Client · </span>{clientName.get(s.client_id) ?? 'hidden'}</span> : 'Workspace'}</Td>
                        <Td><Badge tone={src.tone}>{src.text}</Badge></Td>
                        <Td className="text-gray-600 max-w-[200px] truncate" title={s.reason ?? undefined}>{s.reason ?? <span className="text-gray-300">—</span>}</Td>
                        <Td className="whitespace-nowrap">{fmtDate(s.created_at, false)}</Td>
                        <Td className="text-right">{canEdit && (fromCrm
                          ? <Link href="/outreach/settings/integrations" className="text-xs text-indigo-600 hover:underline whitespace-nowrap" title="This entry is kept in step with your CRM">Managed by CRM</Link>
                          : <Button size="sm" variant="ghost" onClick={() => setToDelete(s)} aria-label={`Remove ${s.value}`}><Trash2 className="w-4 h-4 text-red-500" /></Button>)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
                <span>Showing {Math.min(shown, rows.length).toLocaleString()} of {rows.length.toLocaleString()}{windowed ? `. Only the newest ${loaded.toLocaleString()} matches are loaded: search by value to narrow it down` : ''}</span>
                {rows.length > shown && <Button size="sm" variant="secondary" onClick={() => setShown(shown + PAGE * 5)}>Show more</Button>}
              </div>
            </>
          )}
          <p className="text-xs text-gray-400 mt-4">Entries with the source CRM come from the &ldquo;customers and open deals&rdquo; sync and are managed under <Link href="/outreach/settings/integrations" className="text-indigo-600 hover:underline">Integrations</Link>. They are refreshed on every sync and removed when the CRM is disconnected. Unsubscribes are also stored on the lead itself and always apply to the whole workspace.</p>
        </Card>

        <Card title="Block someone">
          {!canEdit ? <div className="text-sm text-gray-500">Only owners and managers can change the blacklists.</div> : (
            <div className="space-y-4">
              <fieldset>
                <legend className="block text-xs font-medium text-gray-600 mb-1">Applies to</legend>
                <div className="grid grid-cols-3 gap-1 p-0.5 rounded-lg bg-gray-100" role="radiogroup">
                  {(['workspace', 'client', 'sequence'] as BlacklistScope[]).map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={scope === s} onClick={() => setScope(s)} className={cn('px-2 py-1.5 text-sm rounded-md font-medium capitalize', scope === s ? 'bg-white shadow-sm text-indigo-700' : 'text-gray-600 hover:text-gray-900')}>{s}</button>
                  ))}
                </div>
                <div className="text-xs text-gray-500 mt-1.5">{scope === 'workspace' ? 'Nobody in this workspace can contact a match.' : scope === 'client' ? 'Only this client\'s leads and sequences are affected. Other clients can still reach them.' : 'Only this one sequence skips a match.'}</div>
              </fieldset>
              {scope === 'client' && (
                <Select label="Client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                  <option value="">{clients.isLoading ? 'Loading…' : clients.data?.length ? 'Choose a client' : 'No clients yet'}</option>
                  {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              )}
              {scope === 'sequence' && (
                <Select label="Sequence" value={sequenceId} onChange={(e) => setSequenceId(e.target.value)}>
                  <option value="">{sequences.isLoading ? 'Loading…' : sequences.data?.length ? 'Choose a sequence' : 'No sequences yet'}</option>
                  {(sequences.data ?? []).filter((s) => s.status !== 'archived').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              )}

              <div className="inline-flex rounded-lg border border-gray-200 p-0.5" role="tablist" aria-label="How to add">
                {([['one', 'Add one'], ['csv', 'Upload CSV']] as const).map(([m, label]) => <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn('px-3 py-1.5 text-sm font-medium rounded-md', mode === m ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>{label}</button>)}
              </div>

              {mode === 'one' ? (
                <form onSubmit={addOne} className="space-y-3" noValidate>
                  <Select label="Kind" value={kind} onChange={(e) => { setKind(e.target.value as BlacklistKind); setTouched(false); }}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select>
                  <Input label="Value" value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => setTouched(!!value)} placeholder={kindMeta(kind)?.placeholder} hint={kindMeta(kind)?.hint} error={touched && valueError ? valueError : undefined} />
                  <Input label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Existing customer" maxLength={300} />
                  <Button type="submit" className="w-full" loading={busy === 'one'} disabled={!scopeReady || !value.trim()}><Plus className="w-4 h-4" /> Block for {scopeLabel}</Button>
                  {!scopeReady && <div className="text-xs text-amber-700">Pick the {scope} first.</div>}
                </form>
              ) : (
                <BlacklistUpload workspaceId={ws ?? ''} clientId={pClient} sequenceId={pSequence} scopeLabel={scopeLabel} scopeReady={scopeReady && !!ws} onDone={() => { refresh(); }} />
              )}
            </div>
          )}
        </Card>
      </div>

      <ConfirmModal open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={remove} loading={busy === toDelete?.id} title="Remove from the blacklist?" confirmLabel="Remove">
        <p><code className="text-xs break-all">{toDelete?.value}</code> will no longer be blocked{toDelete?.sequence_id ? ' in this sequence' : toDelete?.client_id ? ' for this client' : ''}. Leads that match can be enrolled and contacted again.</p>
        {toDelete?.source === 'unsubscribe' && <p className="text-amber-700">This entry came from an unsubscribe. The lead keeps its own unsubscribed flag, so it still will not get email.</p>}
      </ConfirmModal>
      {toast.node}
    </SettingsFrame>
  );
}
