'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe2, Plus, Trash2 } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { useClients } from '@/lib/outreach/queries';
import { Badge, Button, Card, ErrorBox, Input, Select, Spinner, fmtDate, useToast } from '@/components/outreach/ui';
import { ConfirmModal, CopyField, isHostname } from './shared';
import { sk, useDomains } from './hooks';
import type { DomainRow } from './types';

const STATUS: Record<DomainRow['status'], { label: string; tone: 'amber' | 'blue' | 'green' | 'red'; text: string }> = {
  pending_dns: { label: 'Pending DNS', tone: 'amber', text: 'Add both records below at your DNS provider. We look for them every few minutes.' },
  verifying: { label: 'Verifying', tone: 'blue', text: 'We found the records and are issuing the certificate. This usually takes a few minutes.' },
  active: { label: 'Active', tone: 'green', text: 'Clients who open this address see only the portal, with your branding.' },
  failed: { label: 'Failed', tone: 'red', text: 'We could not verify the domain. Check the records, then remove the domain and add it again.' },
};

/** Custom domains for the client portal (item 23, level 2). */
export default function DomainsCard() {
  const { workspace, isOwner, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useDomains(ws);
  const clients = useClients(ws);
  const [host, setHost] = useState('');
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<DomainRow | null>(null);
  const clientName = useMemo(() => new Map((clients.data ?? []).map((c) => [c.id, c.name])), [clients.data]);
  const editable = isOwner && canWrite;

  const clean = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const hostError = host && !isHostname(clean) ? 'Enter a hostname such as reports.agency.com' : undefined;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!ws || !clean || hostError) return;
    setBusy(true); setError(null);
    try {
      await rpc('add_domain', { p_ws: ws, p_hostname: clean, p_client: clientId || null });
      setHost(''); setClientId('');
      await qc.invalidateQueries({ queryKey: sk.domains(ws) });
      toast.show('Domain added. Create the two DNS records shown below.');
    } catch (er) { setError(parseError(er).message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!toRemove || !ws) return;
    setBusy(true);
    try { await rpc('remove_domain', { p_id: toRemove.id }); await qc.invalidateQueries({ queryKey: sk.domains(ws) }); toast.show('Domain removed.'); setToRemove(null); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><Globe2 className="w-4 h-4" /> Custom domains</span>}>
      <p className="text-xs text-gray-500 mb-4">Point a hostname of yours at us and your clients open the portal at <code>reports.youragency.com</code>. On that address they see the portal only: your name, your logo, your colour, your help links. A domain can land on one client&apos;s portal or on the workspace.</p>
      {domains.isLoading ? <Spinner /> : domains.isError ? <ErrorBox message={parseError(domains.error).message} /> : (
        <div className="space-y-4">
          {(domains.data ?? []).length === 0 && <div className="text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg px-4 py-5 text-center">No custom domain yet.</div>}
          {(domains.data ?? []).map((d) => {
            const st = STATUS[d.status] ?? STATUS.pending_dns;
            return (
              <div key={d.id} className="border border-gray-200 rounded-lg p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-gray-900 break-all">{d.hostname}</span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  <span className="text-xs text-gray-500">{d.client_id ? `Opens the portal of ${clientName.get(d.client_id) ?? 'a client'}` : 'Opens the workspace portal'}</span>
                  <span className="ml-auto flex items-center gap-1">
                    {d.status === 'active' && <a href={`https://${d.hostname}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline">Open <ExternalLink className="w-3 h-3" /></a>}
                    {editable && <Button size="sm" variant="ghost" onClick={() => setToRemove(d)} aria-label={`Remove ${d.hostname}`}><Trash2 className="w-4 h-4 text-red-500" /></Button>}
                  </span>
                </div>
                <p className="text-xs text-gray-600">{st.text}</p>
                {d.last_error && d.status !== 'active' && <ErrorBox message={d.last_error} />}
                {d.status !== 'active' && (
                  <div className="bg-gray-50 rounded-lg p-3 space-y-3">
                    {d.dns.map((r) => (
                      <div key={r.type} className="grid grid-cols-1 sm:grid-cols-[70px_1fr_1fr] gap-3">
                        <div><div className="text-xs font-medium text-gray-600 mb-1">Type</div><div className="px-1 py-2 text-xs font-mono text-gray-800">{r.type}</div></div>
                        <CopyField label="Name / host" value={r.name} />
                        {r.value ? <CopyField label="Value" value={r.value} /> : <div><div className="text-xs font-medium text-gray-600 mb-1">Value</div><div className="text-xs text-gray-500 py-2">Only the workspace owner can see this value.</div></div>}
                      </div>
                    ))}
                    <p className="text-[11px] text-gray-500">Some DNS providers want the name without your domain at the end (for example <code>reports</code> instead of <code>reports.agency.com</code>). Switch off any proxy or &ldquo;orange cloud&rdquo; on the CNAME.</p>
                  </div>
                )}
                <div className="text-[11px] text-gray-400">{d.last_checked_at ? `Last checked ${fmtDate(d.last_checked_at)}` : 'Not checked yet'}{d.verified_at ? ` · verified ${fmtDate(d.verified_at, false)}` : ''}</div>
              </div>
            );
          })}

          {editable && (
            <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[1fr_220px_auto] gap-3 sm:items-start border-t border-gray-100 pt-4" noValidate>
              <Input label="Hostname" value={host} onChange={(e) => { setHost(e.target.value); setError(null); }} placeholder="reports.agency.com" error={hostError} spellCheck={false} />
              <Select label="Lands on (optional)" value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">The workspace portal</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              <Button type="submit" className="sm:mt-5" loading={busy} disabled={!clean || !!hostError}><Plus className="w-4 h-4" /> Add domain</Button>
            </form>
          )}
          {error && <ErrorBox message={error} />}
        </div>
      )}
      <ConfirmModal open={!!toRemove} onClose={() => setToRemove(null)} onConfirm={remove} loading={busy} title="Remove this domain?" confirmLabel="Remove domain">
        <p><code className="text-xs">{toRemove?.hostname}</code> stops showing the portal straight away. Clients can still sign in on the normal address. You can delete the DNS records afterwards.</p>
      </ConfirmModal>
      {toast.node}
    </Card>
  );
}
