'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Wrench } from 'lucide-react';
import { useRouter, useSearchParams } from '@/lib/outreach/nav';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useIsLocalhost } from '@/lib/outreach/platformAdmin';
import { rpc } from '@/lib/outreach/api';
import { Button, ErrorBox, PageHeader, PageLoader, timeAgo, useToast } from '@/components/outreach/ui';
import { Tabs } from '@/components/ui/Tabs';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import { STATUS_DOT, STATUS_LABELS, type HealthOverview } from '@/lib/outreach/health';
import { cn } from '@/lib/utils';
import HealthNow from '@/components/outreach/settings/admin/health/HealthNow';
import HealthUsage from '@/components/outreach/settings/admin/health/HealthUsage';
import HealthStuck from '@/components/outreach/settings/admin/health/HealthStuck';
import HealthSettings from '@/components/outreach/settings/admin/health/HealthSettings';

type Tab = 'now' | 'usage' | 'stuck' | 'settings';
const TABS: Array<{ value: Tab; label: string }> = [{ value: 'now', label: 'Now' }, { value: 'usage', label: 'Usage and limits' }, { value: 'stuck', label: 'Stuck users' }, { value: 'settings', label: 'Settings' }];

/**
 * Settings → Admin → Health (health-page-PRD.md §3): is anything wrong, where to look, and what to do. Platform admins
 * only (every RPC checks), rendered only on localhost like the rest of the Admin tab, never in the product tour.
 * `?tab=now|usage|stuck|settings`, `?check=<key>` opens one card's Look closer panel (the emails link here).
 */
function HealthPageInner() {
  const { workspace } = useWorkspace();
  const local = useIsLocalhost();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { show, node } = useToast();
  const tab = (TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'now') as Tab;
  const [openKey, setOpenKey] = useState<string | null>(params.get('check'));

  useEffect(() => { if (local === false) router.replace('/outreach/settings/workspace'); }, [local, router]);

  const setParams = (next: { tab?: Tab; check?: string | null }) => {
    const p = new URLSearchParams(params.toString());
    if (next.tab !== undefined) { if (next.tab === 'now') p.delete('tab'); else p.set('tab', next.tab); }
    if (next.check !== undefined) { if (next.check) p.set('check', next.check); else p.delete('check'); }
    router.replace(`/outreach/settings/admin/health${p.toString() ? `?${p}` : ''}`);
  };

  const overview = useQuery({ queryKey: ['health-overview'], queryFn: () => rpc<HealthOverview>('health_overview'), refetchInterval: 60_000, enabled: local === true });
  const runNow = useMutation({
    mutationFn: () => rpc<{ ran: number; errors: string[]; collect_error?: string }>('health_run_now'),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['health-overview'] }); qc.invalidateQueries({ queryKey: ['health-usage'] }); qc.invalidateQueries({ queryKey: ['health-stuck'] }); show(`Checked: ${r.ran} checks ran${r.errors?.length ? `, ${r.errors.length} hit an error` : ''}${r.collect_error ? '; the collector could not be reached' : ''}.`); },
    onError: (e: Error) => show(e.message, 'error'),
  });

  const o = overview.data;
  const headline = useMemo(() => o ? `${o.counts.act} needs action · ${o.counts.watch} to watch · ${o.counts.ok} fine · ${o.counts.unknown} couldn't check${o.counts.snoozed ? ` · ${o.counts.snoozed} snoozed` : ''}` : '', [o]);

  if (!workspace || local !== true) return <PageLoader />;
  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <SettingsTabs />
      <div className="flex items-start gap-2 p-3 mb-6 rounded-lg bg-amber-50 text-amber-900 text-sm border border-amber-200">
        <Wrench className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span>Health is a platform-admin view of the whole product: every workspace, every function, every outside service. Nothing here is about {workspace.name} alone.</span>
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <h2 className="text-lg font-semibold text-gray-900">Health</h2>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          {o?.last_run_at ? <span title={o.last_run_at}>Last checked {timeAgo(o.last_run_at)}</span> : <span>Not checked yet</span>}
          {o?.collect?.at && <span title={JSON.stringify(o.collect.value)}>· collector {timeAgo(o.collect.at)}</span>}
          <Button size="sm" variant="secondary" onClick={() => runNow.mutate()} loading={runNow.isPending}><RefreshCw className="w-3.5 h-3.5" /> Check now</Button>
        </div>
      </div>
      {overview.isError && <ErrorBox message={(overview.error as Error).message} className="mb-4" />}
      {o?.stale && <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-900"><b>Checks have stopped.</b> The numbers below are old: <code>ops.health_run()</code> last ran {o.last_run_at ? timeAgo(o.last_run_at) : 'never'}. See guide G16 (the scheduler stopped, or a check&apos;s SQL has an error).</div>}
      {o && (
        <div className="flex items-center gap-2 mb-3">
          <span className={cn('inline-block w-3 h-3 rounded-full', STATUS_DOT[o.verdict])} title={STATUS_LABELS[o.verdict]} />
          <span className="text-sm text-gray-900">{headline}</span>
        </div>
      )}
      {o?.upgrade && tab === 'now' && (
        <div className="mb-5 p-3 rounded-lg bg-white border border-gray-200">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Do I need to upgrade?</div>
          <div className="text-sm text-gray-900">{o.upgrade.text} <button type="button" className="text-xs text-indigo-600 hover:underline ml-1" onClick={() => setParams({ tab: 'usage' })}>How this is decided</button></div>
        </div>
      )}
      <div className="mb-5"><Tabs value={tab} onChange={(v) => setParams({ tab: v })} items={TABS} label="Health sections" /></div>
      {overview.isLoading && !o ? <PageLoader /> : null}
      {tab === 'now' && o && <HealthNow overview={o} openKey={openKey} onOpenKey={(k) => { setOpenKey(k); setParams({ check: k }); }} />}
      {tab === 'usage' && <HealthUsage />}
      {tab === 'stuck' && <HealthStuck />}
      {tab === 'settings' && o && <HealthSettings key={o.settings.updated_at} settings={o.settings} checks={o.checks} />}
      {node}
    </div>
  );
}

export default function HealthPage() {
  return <Suspense fallback={<PageLoader />}><HealthPageInner /></Suspense>;
}
