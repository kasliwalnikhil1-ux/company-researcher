'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff, Plus, Trash2, Webhook } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { qk, useWebhooks } from '@/lib/outreach/queries';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Modal, PageHeader, Spinner, Table, Td, Th, Toggle, fmtDate, useToast } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import { copyText } from '@/components/outreach/senders/helpers';
import { EVENT_NAMES, type OutboundWebhook } from '@/lib/outreach/types';
import { cn } from '@/lib/utils';

type Delivery = { id: number; webhook_id: string | null; event: string | null; status: number | null; attempts: number; delivered_at: string | null; last_error: string | null; created_at: string; next_at: string };

export default function WebhooksSettingsPage() {
  const { workspace, isOwner, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const hooks = useWebhooks(isOwner ? ws : null);
  const [url, setUrl] = useState('');
  const [all, setAll] = useState(true);
  const [events, setEvents] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<OutboundWebhook | null>(null);

  const deliveries = useQuery({
    queryKey: ['outreach', ws ?? '', 'webhook-deliveries'], enabled: !!ws && isOwner, refetchInterval: 30000,
    queryFn: async () => { const { data, error } = await supabase.from('outreach_outbound_webhook_deliveries').select('id, webhook_id, event, status, attempts, delivered_at, last_error, created_at, next_at').eq('workspace_id', ws!).order('created_at', { ascending: false }).limit(100); if (error) throw parseError(error); return (data ?? []) as Delivery[]; },
  });
  const hookUrl = useMemo(() => new Map((hooks.data ?? []).map((h) => [h.id, h.url])), [hooks.data]);
  const groups = useMemo(() => { const g = new Map<string, string[]>(); for (const e of EVENT_NAMES) { const p = e.split('.')[0]; g.set(p, [...(g.get(p) ?? []), e]); } return [...g.entries()]; }, []);
  const urlOk = /^https:\/\/[^\s]+$/i.test(url.trim());

  const refresh = () => qc.invalidateQueries({ queryKey: qk.webhooks(ws ?? '') });

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!urlOk || (!all && events.length === 0)) return;
    setBusy('create');
    try { const { error } = await supabase.from('outreach_outbound_webhooks').insert({ workspace_id: ws, url: url.trim(), events: all ? ['*'] : events }); if (error) throw error; toast.show('Webhook created. Reveal its secret to verify signatures.'); setUrl(''); setEvents([]); setAll(true); refresh(); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  async function setActive(h: OutboundWebhook, active: boolean) {
    setBusy(h.id);
    try { const { error } = await supabase.from('outreach_outbound_webhooks').update({ active, ...(active ? { failures: 0 } : {}) }).eq('id', h.id); if (error) throw error; refresh(); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  async function remove() {
    if (!deleteTarget) return;
    setBusy(deleteTarget.id);
    try { const { error } = await supabase.from('outreach_outbound_webhooks').delete().eq('id', deleteTarget.id); if (error) throw error; toast.show('Webhook deleted.'); setDeleteTarget(null); refresh(); deliveries.refetch(); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  if (!workspace) return <Spinner />;
  if (!isOwner) return <div><PageHeader title="Settings" subtitle={workspace.name} /><SettingsTabs /><ErrorBox message="Only the workspace owner can manage outbound webhooks." /></div>;

  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <SettingsTabs />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2" title={<span className="flex items-center gap-2"><Webhook className="w-4 h-4" /> Outbound webhooks</span>}>
          <p className="text-xs text-gray-500 mb-4">Each delivery is a JSON POST signed with <code>X-Outreach-Signature: sha256=HMAC(secret, body)</code>. Failed deliveries retry with backoff; a webhook is disabled automatically after repeated failures — re-enable it here once the endpoint is fixed.</p>
          {hooks.isLoading ? <Spinner /> : hooks.isError ? <ErrorBox message={(hooks.error as Error).message} /> : !hooks.data?.length ? <EmptyState title="No webhooks yet" description="Add an HTTPS endpoint to receive events like invite.accepted or message.received." /> : (
            <div className="divide-y divide-gray-100">
              {hooks.data.map((h) => (
                <div key={h.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-sm text-gray-900 break-all flex-1 min-w-[200px]">{h.url}</code>
                    <Toggle checked={h.active} onChange={(v) => setActive(h, v)} disabled={!canWrite || busy === h.id} label={h.active ? 'active' : 'off'} />
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(h)} disabled={!canWrite} aria-label="Delete webhook"><Trash2 className="w-4 h-4 text-red-500" /></Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {(h.events.includes('*') ? ['all events'] : h.events).map((e) => <Badge key={e} tone={e === 'all events' ? 'indigo' : 'gray'}>{e}</Badge>)}
                    {h.failures > 0 && <Badge tone="red">{h.failures} failure{h.failures === 1 ? '' : 's'}</Badge>}
                    <span className="text-[11px] text-gray-400 ml-auto">created {fmtDate(h.created_at, false)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-xs text-gray-500">Secret:</span>
                    <code className="text-xs text-gray-700 font-mono">{reveal[h.id] ? h.secret : '•'.repeat(24)}</code>
                    <button type="button" className="p-1 rounded text-gray-400 hover:text-gray-700" aria-label={reveal[h.id] ? 'Hide secret' : 'Reveal secret'} onClick={() => setReveal({ ...reveal, [h.id]: !reveal[h.id] })}>{reveal[h.id] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}</button>
                    <button type="button" className="p-1 rounded text-gray-400 hover:text-gray-700" aria-label="Copy secret" onClick={async () => toast.show((await copyText(h.secret)) ? 'Secret copied.' : 'Copy failed.')}><Copy className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Add webhook">
          <form onSubmit={create} className="space-y-3">
            <Input label="Endpoint URL" placeholder="https://example.com/hooks/outreach" value={url} onChange={(e) => setUrl(e.target.value)} error={url && !urlOk ? 'Must be an https:// URL' : undefined} disabled={!canWrite} />
            <Toggle checked={all} onChange={setAll} label="All events (*)" disabled={!canWrite} />
            {!all && (
              <div className="max-h-64 overflow-y-auto border border-gray-200 rounded-lg p-2 space-y-2">
                {groups.map(([group, names]) => (
                  <div key={group}>
                    <div className="text-[11px] uppercase tracking-wide text-gray-400 px-1">{group}</div>
                    {names.map((n) => (
                      <label key={n} className={cn('flex items-center gap-2 px-1 py-1 text-sm rounded cursor-pointer hover:bg-gray-50', events.includes(n) && 'text-indigo-700')}>
                        <input type="checkbox" className="rounded border-gray-300 text-indigo-600" checked={events.includes(n)} onChange={(e) => setEvents(e.target.checked ? [...events, n] : events.filter((x) => x !== n))} /> {n}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <Button type="submit" className="w-full" loading={busy === 'create'} disabled={!canWrite || !urlOk || (!all && events.length === 0)}><Plus className="w-4 h-4" /> Create webhook</Button>
          </form>
        </Card>
      </div>

      <Card className="mt-6" title="Recent deliveries" actions={<span className="text-xs text-gray-400">latest 100</span>}>
        {deliveries.isLoading ? <Spinner /> : deliveries.isError ? <ErrorBox message={(deliveries.error as Error).message} /> : !deliveries.data?.length ? <div className="text-sm text-gray-500 py-4">No deliveries yet.</div> : (
          <Table>
            <thead><tr><Th>When</Th><Th>Event</Th><Th>Endpoint</Th><Th>Status</Th><Th className="text-right">Attempts</Th><Th>Delivered</Th><Th>Last error</Th></tr></thead>
            <tbody>
              {deliveries.data.map((d) => (
                <tr key={d.id}>
                  <Td className="whitespace-nowrap">{fmtDate(d.created_at)}</Td>
                  <Td className="font-medium text-gray-900">{d.event ?? '—'}</Td>
                  <Td className="max-w-[220px] truncate text-xs" title={d.webhook_id ? hookUrl.get(d.webhook_id) : undefined}>{d.webhook_id ? hookUrl.get(d.webhook_id) ?? <span className="text-gray-400">deleted</span> : '—'}</Td>
                  <Td>{d.delivered_at ? <Badge tone="green">{d.status ?? 'ok'}</Badge> : d.status ? <Badge tone="red">{d.status}</Badge> : <Badge tone="amber">pending</Badge>}</Td>
                  <Td className="text-right tabular-nums">{d.attempts}</Td>
                  <Td className="whitespace-nowrap">{d.delivered_at ? fmtDate(d.delivered_at) : d.next_at && !d.delivered_at ? <span className="text-xs text-gray-400">retry {fmtDate(d.next_at)}</span> : '—'}</Td>
                  <Td className="max-w-[240px] truncate text-xs text-red-600" title={d.last_error ?? undefined}>{d.last_error ?? ''}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete webhook?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="danger" onClick={remove} loading={busy === deleteTarget?.id}>Delete</Button></>}>
        <p className="text-sm text-gray-700">Deliveries stop immediately and the delivery history for <code className="text-xs break-all">{deleteTarget?.url}</code> is removed.</p>
      </Modal>
      {toast.node}
    </div>
  );
}
