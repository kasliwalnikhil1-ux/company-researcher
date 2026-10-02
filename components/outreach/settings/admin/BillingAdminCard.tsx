'use client';

import { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { adminApi, type BillingCostReport, type BillingOverview, type BillingSwitch } from '@/lib/platform/admin';
import { parseError } from '@/lib/platform/access';
import { longDate, planLabel } from '@/lib/outreach/billing';
import { Badge, Button, Card, ErrorBox, Spinner, Stat, Toggle, useToast } from '@/components/outreach/ui';
import { ConfirmModal } from '@/components/admin/shared';

const KEY = ['outreach', 'platform', 'billing-overview'] as const;
/** Where an operator sets a plan for a workspace that should keep working. */
const ADMIN_WORKSPACES = '/admin?tab=outreach';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const accountsText = (n: number) => count(n, 'account', 'accounts');
/** How many workspaces turning a switch on would touch right now (the RPC asks for a confirmation above zero). */
const affectedBy = (o: BillingOverview, key: BillingSwitch) =>
  key === 'billing_enforced' ? o.trials_that_would_expire.length + o.trials_over_limit.length + o.paid_over_limit.length : o.due_for_deletion.length;
/** The vendor behind the connector is never named in the UI, not even inside an error it returned. */
const scrub = (s: string) => s.replace(/unipile|unilogin/gi, 'connector');

const DONE: Record<BillingSwitch, { on: string; off: string }> = {
  billing_enforced: { on: 'Billing enforcement is on.', off: 'Billing enforcement is off.' },
  billing_data_deletion: { on: 'Automatic deletion is on.', off: 'Automatic deletion is off.' },
};

function ListBlock({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200">
      <div className="px-3 py-2 border-b border-gray-100">
        <div className="text-sm font-medium text-gray-900">{title}</div>
        <div className="text-xs text-gray-500">{note}</div>
      </div>
      <ul className="divide-y divide-gray-100 max-h-56 overflow-y-auto">{children}</ul>
    </div>
  );
}

function ListRow({ name, detail }: { name: string; detail: React.ReactNode }) {
  return (
    <li className="px-3 py-1.5 flex items-center justify-between gap-3 text-sm">
      <span className="truncate text-gray-900">{name}</span>
      <span className="text-xs text-gray-500 whitespace-nowrap">{detail}</span>
    </li>
  );
}

function SwitchRow({ title, on, busy, disabled, onChange, children }: { title: string; on: boolean; busy: boolean; disabled: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900">{title}</span>
          <Badge tone={on ? 'green' : 'gray'}>{busy ? 'Saving…' : on ? 'On' : 'Off'}</Badge>
        </div>
        <div className="text-sm text-gray-600 mt-1 space-y-1">{children}</div>
      </div>
      <div className="flex-shrink-0 pt-0.5"><Toggle checked={on} onChange={onChange} disabled={disabled} /></div>
    </div>
  );
}

/** The daily report: accounts paid for vs connected here vs on the connector (pricing-billing-PRD.md §12 #6). */
function CostReport({ day, report, pendingNow }: { day: string; report: BillingCostReport; pendingNow: number }) {
  const billed = Number(report.accounts_billed ?? 0);
  const trial = Number(report.trial_accounts ?? 0);
  const onConnector = report.connector_accounts ?? null;
  const gap = report.gap ?? null;
  const swaps = report.swaps ?? [];
  const orphans = report.connector_orphans ?? [];
  const paused = Number(report.paused_over_limit ?? 0);
  const gapHint = gap == null ? 'Needs the connector’s count' : gap > 0 ? 'More on the connector than paid for' : gap < 0 ? 'Fewer on the connector than paid for' : 'The connector matches what is paid for';

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div className="text-sm font-medium text-gray-900">Latest cost report</div>
        {/* `day` is a plain date: read it at local noon so it never slips to the day before */}
        <div className="text-xs text-gray-500">Report for {longDate(`${day}T12:00:00`) || day}</div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Accounts paid for" value={(billed + trial).toLocaleString()} hint={`${billed.toLocaleString()} billed + ${trial.toLocaleString()} trial`} />
        <Stat label="Connected in the app" value={report.connected != null ? Number(report.connected).toLocaleString() : '—'} />
        <Stat label="On the connector" value={onConnector != null ? Number(onConnector).toLocaleString() : '—'} hint={onConnector == null ? 'Not counted in this report' : undefined} />
        <Stat label="Gap" value={gap == null ? '—' : <span className={gap > 0 ? 'text-rose-600' : undefined}>{gap > 0 ? `+${gap}` : gap}</span>} hint={gapHint} />
        <Stat label="Pending deletions" value={Number(report.deletions_pending ?? 0).toLocaleString()} hint={`Connector accounts waiting to be removed. ${pendingNow.toLocaleString()} right now`} />
      </div>
      <p className="text-xs text-gray-500 mt-2">The gap is the accounts on the connector minus the accounts paid for. Above zero, the connector is billing for accounts that no plan or trial covers.{paused > 0 ? ` ${accountsText(paused)} paused for being over the plan’s limit.` : ''}</p>
      {report.connector_error && <ErrorBox className="mt-3" message={`The connector could not be read for this report: ${scrub(report.connector_error)}`} />}

      {(swaps.length > 0 || orphans.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
          {swaps.length > 0 && (
            <ListBlock title={`${count(swaps.length, 'workspace', 'workspaces')} swapping accounts often`} note="Swaps this month. Each one costs an extra connector account for the month.">
              {swaps.map((s) => <ListRow key={s.workspace_id} name={s.name ?? s.workspace_id} detail={count(s.swaps, 'swap', 'swaps')} />)}
            </ListBlock>
          )}
          {orphans.length > 0 && (
            <ListBlock title={`${count(orphans.length, 'connector account', 'connector accounts')} with no sender`} note="On the connector, owned by no sender and not queued for deletion. They are paid for and unused.">
              {orphans.map((a) => <ListRow key={a.id} name={a.name ?? a.id} detail={<>{a.type ? `${a.type} · ` : ''}{a.created_at ? `${longDate(a.created_at)} · ` : ''}<span className="font-mono">{a.id}</span></>} />)}
            </ListBlock>
          )}
        </div>
      )}
      {swaps.length === 0 && orphans.length === 0 && <p className="text-xs text-gray-500 mt-1">No workspace is swapping accounts often, and every connector account in the report belongs to a sender.</p>}
    </div>
  );
}

/**
 * The billing v2 rollout switches and the daily cost report (platform_admin_billing_overview / platform_admin_billing_set).
 * Lives in Settings → Admin (localhost only); the RPCs also require a platform admin, so anyone else sees their error here.
 */
export default function BillingAdminCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const overview = useQuery({ queryKey: KEY, staleTime: 30_000, retry: 0, queryFn: () => adminApi.billingOverview() });
  const [confirming, setConfirming] = useState<BillingSwitch | null>(null);
  const [busy, setBusy] = useState<BillingSwitch | null>(null);
  const o = overview.data;

  async function apply(key: BillingSwitch, value: boolean, confirm: boolean) {
    const next = await adminApi.billingSet(key, value, confirm);
    qc.setQueryData(KEY, next);
    toast.show(DONE[key][value ? 'on' : 'off']);
  }

  async function flip(key: BillingSwitch, value: boolean) {
    if (!o) return;
    // turning a switch on while workspaces would be affected needs an explicit yes
    if (value && affectedBy(o, key) > 0) { setConfirming(key); return; }
    setBusy(key);
    try { await apply(key, value, false); }
    catch (e) {
      const err = parseError(e);
      // the lists changed since this card loaded: load them again, then ask
      if (err.code === 'E_CONFIRM_REQUIRED') { await overview.refetch(); setConfirming(key); }
      else toast.show(err.message, 'error');
    } finally { setBusy(null); }
  }

  const expired = o?.trials_that_would_expire ?? [];
  const trialsOver = o?.trials_over_limit ?? [];
  const paidOver = o?.paid_over_limit ?? [];
  const due = o?.due_for_deletion ?? [];
  /** What enforcement does to a list: already happening when it is on, a forecast while it is off. */
  const effect = (s: string) => (o?.enforced ? `${s[0].toUpperCase()}${s.slice(1)}` : `Once enforcement is on, ${s}`);

  return (
    <Card className="mb-6" title="Billing"
      actions={<>
        {o && <span className="text-xs text-gray-500">Price book {o.price_version}</span>}
        <Button size="sm" variant="secondary" onClick={() => overview.refetch()} loading={overview.isFetching}><RefreshCw className="w-3.5 h-3.5" /> Re-check</Button>
      </>}>
      {overview.isLoading ? <Spinner /> : overview.isError ? <ErrorBox message={parseError(overview.error).message} /> : o ? (
        <div className="space-y-6">
          <div>
            <SwitchRow title="Billing enforcement" on={o.enforced} busy={busy === 'billing_enforced'} disabled={busy !== null} onChange={(v) => flip('billing_enforced', v)}>
              <p>While this is off, no workspace is limited and nothing expires.</p>
              <p>When it is on, trials end after 7 days, and the account limit and plan features apply.</p>
            </SwitchRow>
            {expired.length + trialsOver.length + paidOver.length === 0 ? (
              <p className="text-xs text-gray-500 mt-3">{o.enforced ? 'No trial is waiting to be ended and no workspace is over its limit.' : 'Turning it on would not change anything for the workspaces as they are now.'}</p>
            ) : (
              <>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
                  {expired.length > 0 && (
                    <ListBlock title={`${count(expired.length, 'trial', 'trials')} already over`} note={effect('their accounts will be disconnected at the next hourly run.')}>
                      {expired.map((w) => <ListRow key={w.workspace_id} name={w.name} detail={`ended ${longDate(w.trial_ends_at) || 'earlier'} · ${accountsText(w.accounts)}`} />)}
                    </ListBlock>
                  )}
                  {trialsOver.length > 0 && (
                    <ListBlock title={`${count(trialsOver.length, 'running trial', 'running trials')} over the trial limit`} note={effect('the accounts above the trial limit will be paused.')}>
                      {trialsOver.map((w) => <ListRow key={w.workspace_id} name={w.name} detail={`${w.accounts} connected, limit ${w.limit ?? 0}`} />)}
                    </ListBlock>
                  )}
                  {paidOver.length > 0 && (
                    <ListBlock title={`${count(paidOver.length, 'paid workspace', 'paid workspaces')} over the plan’s limit`} note={effect('the accounts above the plan’s limit will be paused.')}>
                      {paidOver.map((w) => <ListRow key={w.workspace_id} name={w.name} detail={`${planLabel(w.plan)} · ${w.accounts} connected, limit ${w.limit ?? 0}`} />)}
                    </ListBlock>
                  )}
                </div>
                <p className="text-sm text-gray-600 mt-3">
                  {o.enforced ? 'To keep one of these workspaces working, set its plan and accounts.' : 'Before turning enforcement on, set a plan for the workspaces that should keep working.'}{' '}
                  <Link href={ADMIN_WORKSPACES} className="inline-flex items-center gap-1 text-indigo-600 hover:underline">Open workspaces in the admin console <ArrowUpRight className="w-3.5 h-3.5" /></Link>
                </p>
              </>
            )}
          </div>

          <div className="pt-6 border-t border-gray-100">
            <SwitchRow title="Delete lapsed workspaces automatically" on={o.data_deletion} busy={busy === 'billing_data_deletion'} disabled={busy !== null} onChange={(v) => flip('billing_data_deletion', v)}>
              <p>While this is off, nothing is deleted.</p>
              <p>When it is on, the daily run deletes workspaces that are past their date: 30 days after a trial ended, 90 days after a subscription was cancelled. Deleted data cannot be brought back.</p>
            </SwitchRow>
            {due.length === 0 ? <p className="text-xs text-gray-500 mt-3">No workspace is past its date.</p> : (
              <div className="mt-4 max-w-xl">
                <ListBlock title={`${count(due.length, 'workspace', 'workspaces')} past the date`} note={o.data_deletion ? 'They will be deleted at the next daily run.' : 'Once automatic deletion is on, they will be deleted at the next daily run.'}>
                  {due.map((w) => <ListRow key={w.workspace_id} name={w.name} detail={`${planLabel(w.plan)} · due ${longDate(w.data_delete_after)}`} />)}
                </ListBlock>
              </div>
            )}
          </div>

          <div className="pt-6 border-t border-gray-100">
            {o.latest_cost_report
              ? <CostReport day={o.latest_cost_report.day} report={o.latest_cost_report.report ?? {}} pendingNow={Number(o.deletions_pending ?? 0)} />
              : <><div className="text-sm font-medium text-gray-900">Latest cost report</div><p className="text-sm text-gray-500 mt-1">No report yet. The daily billing run writes one. {count(Number(o.deletions_pending ?? 0), 'connector account is', 'connector accounts are')} waiting to be removed.</p></>}
          </div>
        </div>
      ) : null}

      <ConfirmModal open={confirming === 'billing_enforced'} onClose={() => setConfirming(null)} title="Turn billing enforcement on?" confirmLabel="Turn enforcement on" danger
        message={<div className="space-y-2">
          <p>This applies to every workspace. Right now it affects:</p>
          <ul className="list-disc pl-5 space-y-1">
            {expired.length > 0 && <li><b>{count(expired.length, 'trial that is', 'trials that are')} already over.</b> Their accounts will be disconnected at the next hourly run.</li>}
            {trialsOver.length > 0 && <li><b>{count(trialsOver.length, 'running trial', 'running trials')} over the trial limit.</b> The extra accounts will be paused.</li>}
            {paidOver.length > 0 && <li><b>{count(paidOver.length, 'paid workspace', 'paid workspaces')} over the plan’s limit.</b> The extra accounts will be paused.</li>}
            {expired.length + trialsOver.length + paidOver.length === 0 && <li>No workspace as things stand now.</li>}
          </ul>
          <p>If any of them should keep working, cancel and set its plan in the admin console first.</p>
        </div>}
        onConfirm={() => apply('billing_enforced', true, true)} />

      <ConfirmModal open={confirming === 'billing_data_deletion'} onClose={() => setConfirming(null)} title="Turn automatic deletion on?" confirmLabel="Turn deletion on" danger requireText="delete"
        message={<div className="space-y-2">
          <p><b>{count(due.length, 'workspace is', 'workspaces are')} past the date</b> and will be deleted at the next daily run, with their leads, sequences and conversations.</p>
          <p>Deleted data cannot be brought back.</p>
        </div>}
        onConfirm={() => apply('billing_data_deletion', true, true)} />

      {toast.node}
    </Card>
  );
}
