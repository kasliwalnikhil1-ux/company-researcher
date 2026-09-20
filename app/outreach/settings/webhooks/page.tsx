'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, Plus, RotateCcw, Trash2, Webhook } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk, useWebhooks } from '@/lib/outreach/queries';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Modal, Spinner, Table, Td, Th, Toggle, fmtDate, useToast } from '@/components/outreach/ui';
import { ApiSubTabs } from '@/components/outreach/settings/SettingsTabs';
import { ConfirmModal, CopyButton, SettingsFrame, Switch } from '@/components/outreach/settings/shared';
import { sk, useDeliveries } from '@/components/outreach/settings/hooks';
import { NEW_EVENT_NAMES, type Delivery } from '@/components/outreach/settings/types';
import { EVENT_NAMES, type OutboundWebhook } from '@/lib/outreach/types';
import { cn } from '@/lib/utils';

const ALL_EVENTS: string[] = [...new Set<string>([...EVENT_NAMES, ...NEW_EVENT_NAMES])].sort();

function deliveryState(d: Delivery): { label: string; tone: 'green' | 'red' | 'amber' } {
  if (d.delivered_at) return { label: `Delivered${d.status ? ` · ${d.status}` : ''}`, tone: 'green' };
  if (d.status || d.last_error) return { label: `Failed${d.status ? ` · ${d.status}` : ''}`, tone: 'red' };
  return { label: 'Waiting', tone: 'amber' };
}

export default function WebhooksSettingsPage() {
  const { workspace, role, isOwner, canWrite } = useWorkspace();
  const canManage = role === 'owner' || role === 'manager';
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const allowed = role === 'owner' || role === 'manager';
  const hooks = useWebhooks(allowed ? ws : null);
  const deliveries = useDeliveries(allowed ? ws : null);

  const [url, setUrl] = useState('');
  const [all, setAll] = useState(true);
  const [events, setEvents] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<OutboundWebhook | null>(null);
  const [viewing, setViewing] = useState<Delivery | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);

  const hookById = useMemo(() => new Map((hooks.data ?? []).map((h) => [h.id, h])), [hooks.data]);
  const groups = useMemo(() => { const g = new Map<string, string[]>(); for (const e of ALL_EVENTS) { const p = e.split('.')[0]; g.set(p, [...(g.get(p) ?? []), e]); } return [...g.entries()]; }, []);
  const urlOk = /^https:\/\/[^\s]+$/i.test(url.trim());
  const rows = useMemo(() => (deliveries.data ?? []).filter((d) => !onlyFailed || (!d.delivered_at && (d.status || d.last_error))), [deliveries.data, onlyFailed]);

  const refresh = () => qc.invalidateQueries({ queryKey: qk.webhooks(ws ?? '') });
  const refreshDeliveries = () => qc.invalidateQueries({ queryKey: sk.deliveries(ws ?? '') });

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!ws || !urlOk || (!all && events.length === 0)) return;
    setBusy('create'); setFormError(null);
    try {
      await rpc('create_webhook', { p_ws: ws, p_url: url.trim(), p_events: all ? ['*'] : events });
      toast.show('Webhook created. Reveal its secret to check signatures.');
      setUrl(''); setEvents([]); setAll(true); refresh();
    } catch (er) { setFormError(parseError(er).message); }
    finally { setBusy(null); }
  }

  async function setActive(h: OutboundWebhook, active: boolean) {
    setBusy(h.id);
    try {
      await rpc('set_webhook_active', { p_id: h.id, p_active: active });
      toast.show(active ? 'Webhook is on again. The failure count was reset.' : 'Webhook is off. No events are sent to it.');
      refresh();
    } catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  async function remove() {
    if (!deleteTarget) return;
    setBusy(deleteTarget.id);
    try { await rpc('delete_webhook', { p_id: deleteTarget.id }); toast.show('Webhook deleted.'); setDeleteTarget(null); refresh(); refreshDeliveries(); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  async function replay(d: Delivery) {
    setBusy(`replay-${d.id}`);
    try { await rpc<number>('replay_delivery', { p_delivery: d.id }); toast.show('Queued again. The copy is marked "replayed": true so your endpoint can tell it apart.'); setViewing(null); refreshDeliveries(); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  const canReplay = (d: Delivery) => canWrite && !!d.webhook_id && !!hookById.get(d.webhook_id)?.active;

  return (
    <SettingsFrame min="manager">
      <ApiSubTabs />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2" title={<span className="flex items-center gap-2"><Webhook className="w-4 h-4" /> Outbound webhooks</span>}>
          <p className="text-xs text-gray-500 mb-4">Each delivery is a JSON POST. The header <code>x-signature</code> holds the hex HMAC-SHA256 of the raw body, keyed with the webhook&apos;s secret; <code>x-event</code> and <code>x-delivery-id</code> name the event and the delivery. Failed deliveries are retried with growing pauses. After repeated failures a webhook is switched off. Fix the endpoint, switch it on again, then replay what it missed.</p>
          {hooks.isLoading ? <Spinner /> : hooks.isError ? <ErrorBox message={parseError(hooks.error).message} /> : !hooks.data?.length ? <EmptyState icon={<Webhook className="w-6 h-6" />} title="No webhooks yet" description="Add an HTTPS endpoint to receive events such as invite.accepted, message.received or meeting.booked." /> : (
            <div className="divide-y divide-gray-100">
              {hooks.data.map((h) => (
                <div key={h.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-sm text-gray-900 break-all flex-1 min-w-[200px]">{h.url}</code>
                    {canManage ? <span className="flex items-center gap-2 text-xs text-gray-500"><Switch label={`Webhook ${h.url} is ${h.active ? 'on' : 'off'}`} checked={h.active} onChange={(v) => setActive(h, v)} disabled={!canWrite || busy === h.id} />{h.active ? 'on' : 'off'}</span> : <Badge tone={h.active ? 'green' : 'gray'}>{h.active ? 'on' : 'off'}</Badge>}
                    {canWrite && <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(h)} aria-label={`Delete webhook ${h.url}`}><Trash2 className="w-4 h-4 text-red-500" /></Button>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {(h.events.includes('*') ? ['all events'] : h.events).map((e) => <Badge key={e} tone={e === 'all events' ? 'indigo' : 'gray'}>{e}</Badge>)}
                    {h.failures > 0 && <Badge tone="red">{h.failures} failure{h.failures === 1 ? '' : 's'} in a row</Badge>}
                    <span className="text-[11px] text-gray-400 ml-auto">created {fmtDate(h.created_at, false)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-xs text-gray-500">Secret:</span>
                    <code className="text-xs text-gray-700 font-mono break-all">{reveal[h.id] ? h.secret : '•'.repeat(24)}</code>
                    <button type="button" className="p-1 rounded text-gray-400 hover:text-gray-700" aria-label={reveal[h.id] ? 'Hide secret' : 'Show secret'} onClick={() => setReveal({ ...reveal, [h.id]: !reveal[h.id] })}>{reveal[h.id] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}</button>
                    <CopyButton value={h.secret} label="Copy secret" className="w-7 h-7" />
                  </div>
                  {!h.active && !canManage && <div className="text-xs text-gray-500 mt-1">An owner or manager can switch it on again.</div>}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Add webhook">
          <form onSubmit={create} className="space-y-3" noValidate>
            <Input label="Endpoint URL" placeholder="https://example.com/hooks/outreach" value={url} onChange={(e) => { setUrl(e.target.value); setFormError(null); }} error={url && !urlOk ? 'The URL must start with https://' : undefined} disabled={!canWrite} spellCheck={false} />
            <Toggle checked={all} onChange={setAll} label="Send every event" disabled={!canWrite} />
            {!all && (
              <fieldset className="max-h-64 overflow-y-auto border border-gray-200 rounded-lg p-2 space-y-2">
                <legend className="sr-only">Events to send</legend>
                {groups.map(([group, names]) => (
                  <div key={group}>
                    <div className="text-[11px] uppercase tracking-wide text-gray-400 px-1">{group}</div>
                    {names.map((n) => (
                      <label key={n} className={cn('flex items-center gap-2 px-1 py-1 text-sm rounded cursor-pointer hover:bg-gray-50', events.includes(n) && 'text-indigo-700')}>
                        <input type="checkbox" className="rounded border-gray-300 text-indigo-600" checked={events.includes(n)} onChange={(e) => setEvents(e.target.checked ? [...events, n] : events.filter((x) => x !== n))} /> {n}
                        {(NEW_EVENT_NAMES as readonly string[]).includes(n) && <Badge tone="blue" className="ml-auto">new</Badge>}
                      </label>
                    ))}
                  </div>
                ))}
              </fieldset>
            )}
            {!all && events.length === 0 && <div className="text-xs text-amber-700">Tick at least one event.</div>}
            {formError && <ErrorBox message={formError} />}
            <Button type="submit" className="w-full" loading={busy === 'create'} disabled={!canWrite || !urlOk || (!all && events.length === 0)}><Plus className="w-4 h-4" /> Create webhook</Button>
          </form>
        </Card>
      </div>

      <Card className="mt-6" title="Recent deliveries" actions={<><Toggle checked={onlyFailed} onChange={setOnlyFailed} label="Failed only" /><span className="text-xs text-gray-400">latest 100</span></>}>
        {deliveries.isLoading ? <Spinner /> : deliveries.isError ? <ErrorBox message={parseError(deliveries.error).message} /> : rows.length === 0 ? <div className="text-sm text-gray-500 py-4">{deliveries.data?.length ? 'No failed deliveries. All good.' : 'No deliveries yet. They show up here as soon as an event fires.'}</div> : (
          <Table>
            <thead><tr><Th>When</Th><Th>Event</Th><Th>Endpoint</Th><Th>Status</Th><Th className="text-right">Attempts</Th><Th>Error</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {rows.map((d) => {
                const st = deliveryState(d); const hook = d.webhook_id ? hookById.get(d.webhook_id) : undefined;
                return (
                  <tr key={d.id}>
                    <Td className="whitespace-nowrap">{fmtDate(d.created_at)}</Td>
                    <Td className="font-medium text-gray-900 whitespace-nowrap">{d.event ?? '—'}{d.replay_of != null && <Badge tone="blue" className="ml-1.5">replay</Badge>}</Td>
                    <Td className="max-w-[220px] truncate text-xs" title={hook?.url}>{hook?.url ?? <span className="text-gray-400">deleted</span>}</Td>
                    <Td className="whitespace-nowrap"><Badge tone={st.tone}>{st.label}</Badge></Td>
                    <Td className="text-right tabular-nums">{d.attempts}</Td>
                    <Td className="max-w-[240px] truncate text-xs text-red-600" title={d.last_error ?? undefined}>{d.delivered_at ? '' : d.last_error ?? ''}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => setViewing(d)}>View</Button>
                      {canReplay(d) && <Button size="sm" variant="ghost" onClick={() => replay(d)} loading={busy === `replay-${d.id}`} aria-label={`Replay delivery ${d.id}`}><RotateCcw className="w-3.5 h-3.5" /> Replay</Button>}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={!!viewing} onClose={() => setViewing(null)} size="lg" title={<span>Delivery #{viewing?.id} · {viewing?.event}</span>}
        footer={<><Button variant="secondary" onClick={() => setViewing(null)}>Close</Button>{viewing && canReplay(viewing) && <Button onClick={() => replay(viewing)} loading={busy === `replay-${viewing.id}`}><RotateCcw className="w-4 h-4" /> Replay</Button>}</>}>
        {viewing && (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div><dt className="text-gray-500">Status</dt><dd className="mt-0.5"><Badge tone={deliveryState(viewing).tone}>{deliveryState(viewing).label}</Badge></dd></div>
              <div><dt className="text-gray-500">Attempts</dt><dd className="mt-0.5 text-gray-900">{viewing.attempts}</dd></div>
              <div><dt className="text-gray-500">Created</dt><dd className="mt-0.5 text-gray-900">{fmtDate(viewing.created_at)}</dd></div>
              <div><dt className="text-gray-500">Delivered</dt><dd className="mt-0.5 text-gray-900">{fmtDate(viewing.delivered_at)}</dd></div>
            </dl>
            {viewing.last_error && !viewing.delivered_at && <ErrorBox message={viewing.last_error} />}
            <div>
              <div className="flex items-center justify-between mb-1"><span className="text-xs font-medium text-gray-600">Payload</span><CopyButton value={JSON.stringify(viewing.payload, null, 2)} label="Copy payload" className="w-7 h-7" /></div>
              <pre className="text-[11px] leading-relaxed bg-gray-900 text-gray-100 rounded-lg p-3 overflow-auto max-h-80"><code>{JSON.stringify(viewing.payload, null, 2)}</code></pre>
            </div>
            {viewing.webhook_id && !hookById.get(viewing.webhook_id)?.active && <div className="text-xs text-gray-500">This delivery cannot be replayed because its webhook is {hookById.get(viewing.webhook_id) ? 'switched off' : 'deleted'}.</div>}
          </div>
        )}
      </Modal>

      <ConfirmModal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={remove} loading={busy === deleteTarget?.id} title="Delete webhook?" confirmLabel="Delete">
        <p>Events stop going to <code className="text-xs break-all">{deleteTarget?.url}</code> straight away. Its delivery history is removed too, so nothing can be replayed afterwards.</p>
      </ConfirmModal>
      {toast.node}
    </SettingsFrame>
  );
}
