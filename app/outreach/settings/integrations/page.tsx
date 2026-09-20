'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Plug, X } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError } from '@/lib/outreach/api';
import { Badge, Button, ErrorBox, Spinner, timeAgo } from '@/components/outreach/ui';
import { Note, SettingsFrame } from '@/components/outreach/settings/shared';
import IntegrationPanel from '@/components/outreach/settings/IntegrationPanel';
import { sk, useIntegrations } from '@/components/outreach/settings/hooks';
import { CRM_PROVIDERS, crmLabel, oauthErrorText, plainCrmError } from '@/components/outreach/settings/crm';
import type { CrmProvider, Integration } from '@/components/outreach/settings/types';
import { cn } from '@/lib/utils';

const PATH = '/outreach/settings/integrations';
const STATUS: Record<Integration['status'], { label: string; tone: 'green' | 'red' | 'blue' | 'gray' }> = {
  active: { label: 'Connected', tone: 'green' }, error: { label: 'Needs attention', tone: 'red' }, connecting: { label: 'Connecting…', tone: 'blue' }, disconnected: { label: 'Disconnected', tone: 'gray' },
};

export default function IntegrationsSettingsPage() {
  const { workspace, role, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const router = useRouter();
  const qc = useQueryClient();
  const allowed = role === 'owner' || role === 'manager';
  const integrations = useIntegrations(allowed ? ws : null);
  const [busy, setBusy] = useState<CrmProvider | null>(null);
  const [selected, setSelected] = useState<CrmProvider | null>(null);
  const [banner, setBanner] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [cardError, setCardError] = useState<Partial<Record<CrmProvider, string>>>({});

  // Back from the CRM's sign-in page: ?connected=<provider> or ?error=<code>[&provider=<provider>]
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const connected = q.get('connected'); const error = q.get('error'); const provider = q.get('provider');
    if (!connected && !error) return;
    if (connected) { setBanner({ tone: 'green', text: `${crmLabel(connected)} is connected. With the default rule, leads are pushed once they reply. Check the settings below.` }); if (CRM_PROVIDERS.some((p) => p.value === connected)) setSelected(connected as CrmProvider); }
    else if (error) setBanner({ tone: 'red', text: oauthErrorText(error, provider) });
    router.replace(PATH);
    if (ws) qc.invalidateQueries({ queryKey: sk.integrations(ws) });
  }, [router, qc, ws]);

  const byProvider = new Map((integrations.data ?? []).map((i) => [i.provider, i]));
  // open the first live integration by default
  useEffect(() => {
    if (selected || !integrations.data) return;
    const first = integrations.data.find((i) => i.status === 'active' || i.status === 'error');
    if (first) setSelected(first.provider);
  }, [integrations.data, selected]);

  async function connect(provider: CrmProvider) {
    if (!ws) return;
    setBusy(provider); setCardError({ ...cardError, [provider]: undefined });
    try {
      const r = await callFn<{ url?: string }>('crm-oauth', { action: 'start', workspace_id: ws, provider, return_url: `${window.location.origin}${PATH}` });
      if (!r?.url || !/^https:\/\//i.test(r.url)) throw new Error('The sign-in link is missing. Try again in a minute.');
      window.location.href = r.url;     // full-page redirect to the CRM; never an iframe
    } catch (e) {
      const pe = parseError(e);
      setCardError({ ...cardError, [provider]: pe.code === 'E_NOT_CONFIGURED' ? 'This CRM is not enabled on this platform yet.' : pe.message });
      setBusy(null);
    }
  }

  const current = selected ? byProvider.get(selected) : undefined;

  return (
    <SettingsFrame min="manager">
      {banner && (
        <div role="status" className={cn('flex items-start gap-2 rounded-xl border px-4 py-3 mb-6 text-sm', banner.tone === 'green' ? 'bg-green-50 border-green-200 text-green-900' : 'bg-red-50 border-red-200 text-red-800')}>
          {banner.tone === 'green' ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
          <span className="flex-1">{banner.text}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss" className="p-0.5 rounded hover:bg-black/5"><X className="w-4 h-4" /></button>
        </div>
      )}

      <p className="text-sm text-gray-600 mb-4 max-w-3xl">Connect your CRM and leads flow in both directions. We push contacts, companies, messages, stages and deals. We pull lists to import and the customers you never want to contact. By default only leads who replied are pushed, so your CRM does not fill up with cold contacts.</p>

      {integrations.isLoading ? <Spinner /> : integrations.isError ? <ErrorBox message={parseError(integrations.error).message} /> : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          {CRM_PROVIDERS.map((p) => {
            const i = byProvider.get(p.value);
            const live = i && (i.status === 'active' || i.status === 'error');
            const isSelected = selected === p.value && !!i && i.status !== 'connecting';
            const err = cardError[p.value];
            return (
              <div key={p.value} className={cn('bg-white border rounded-xl p-5 flex flex-col', isSelected ? 'border-indigo-500 ring-1 ring-indigo-500' : 'border-gray-200')}>
                <div className="flex items-center gap-3">
                  <span className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-sm font-bold flex-shrink-0" style={{ background: p.color }} aria-hidden>{p.label[0]}</span>
                  <div className="min-w-0 flex-1"><div className="text-sm font-semibold text-gray-900">{p.label}</div>{i?.account_label && i.status !== 'disconnected' && <div className="text-xs text-gray-500 truncate" title={i.account_label}>{i.account_label}</div>}</div>
                  {i && <Badge tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Badge>}
                </div>
                <p className="text-xs text-gray-500 mt-3 flex-1">{p.blurb}</p>
                {live && <div className="text-xs text-gray-500 mt-3">Last sync: {i!.last_sync_at ? timeAgo(i!.last_sync_at) : 'not yet'}{i!.last_pull_at ? ` · last pull ${timeAgo(i!.last_pull_at)}` : ''}</div>}
                {live && i!.last_error && <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-2.5 py-2" title={i!.last_error}>{plainCrmError(i!.last_error, p.value)}</div>}
                {i?.status === 'connecting' && <div className="mt-2 text-xs text-gray-500">Waiting for you to finish the {p.label} sign-in. If you closed that window, press Connect again.</div>}
                {err && <div className="mt-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">{err}</div>}
                <div className="flex flex-wrap gap-2 mt-4">
                  {live && <Button size="sm" variant={isSelected ? 'primary' : 'secondary'} onClick={() => setSelected(p.value)} aria-pressed={isSelected}>{isSelected ? 'Showing settings' : 'Settings and log'}</Button>}
                  {(!live || i!.status === 'error') && <Button size="sm" variant={live ? 'secondary' : 'primary'} onClick={() => connect(p.value)} loading={busy === p.value} disabled={!canWrite || (!!busy && busy !== p.value)}><Plug className="w-3.5 h-3.5" /> {live ? 'Connect again' : i?.status === 'disconnected' ? 'Connect again' : 'Connect'}</Button>}
                  {i?.status === 'disconnected' && <Button size="sm" variant="ghost" onClick={() => setSelected(p.value)}>Sync log</Button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {current && current.status !== 'connecting' ? <IntegrationPanel key={current.id} integration={current} /> : !integrations.isLoading && !integrations.isError && (
        <Note className="max-w-3xl">Connecting opens the CRM&apos;s own sign-in page. We ask for access to contacts, companies, deals and lists, and store the access encrypted. You can disconnect at any time; nothing in this workspace is deleted when you do.</Note>
      )}
      {!canWrite && <Note tone="amber" className="mt-6">This workspace is read-only, so integrations cannot be changed right now.</Note>}
    </SettingsFrame>
  );
}
