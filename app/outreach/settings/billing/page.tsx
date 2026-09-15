'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CreditCard, ExternalLink, XCircle } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError } from '@/lib/outreach/api';
import { useSenders } from '@/lib/outreach/queries';
import { Badge, Button, Card, ErrorBox, PageHeader, Select, Spinner, Stat, Table, Td, Th, fmtDate, useToast } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import { cn } from '@/lib/utils';

type Plan = 'team' | 'agency' | 'agency_plus';
const PLANS: Array<{ id: Plan; label: string; blurb: string }> = [
  { id: 'team', label: 'Team', blurb: 'Per active sender. Unlimited sequences, inbox, AI classify. Best for one company.' },
  { id: 'agency', label: 'Agency', blurb: 'Per active sender. Adds client partitions, client viewer surface and per-client exports.' },
  { id: 'agency_plus', label: 'Agency Plus', blurb: 'Per active sender. Adds outbound webhooks, priority worker slots and higher AI quotas.' },
];
const PLAN_LABEL: Record<string, string> = { trial: 'Trial', team: 'Team', agency: 'Agency', agency_plus: 'Agency Plus', suspended: 'Suspended' };

function BillingInner() {
  const { workspace, isOwner, refresh } = useWorkspace();
  const ws = workspace?.id;
  const router = useRouter();
  const search = useSearchParams();
  const checkout = search.get('checkout');
  const toast = useToast();
  const senders = useSenders(ws);
  const [plan, setPlan] = useState<Plan>(workspace && ['team', 'agency', 'agency_plus'].includes(workspace.plan) ? (workspace.plan as Plan) : 'team');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (checkout === 'success') { refresh(); }
    if (checkout) { const t = setTimeout(() => router.replace('/outreach/settings/billing'), 15000); return () => clearTimeout(t); }
  }, [checkout, refresh, router]);

  const since = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); }, []);
  const usage = useQuery({
    queryKey: ['outreach', ws ?? '', 'billing-usage', since], enabled: !!ws && isOwner,
    queryFn: async () => { const { data, error } = await supabase.from('outreach_billing_usage').select('day, active_senders, active_mailboxes').eq('workspace_id', ws!).gte('day', since).order('day', { ascending: false }); if (error) throw parseError(error); return (data ?? []) as Array<{ day: string; active_senders: number; active_mailboxes: number }>; },
  });

  const active = (senders.data ?? []).filter((s) => s.status !== 'disabled');
  const linkedin = active.filter((s) => s.provider === 'LINKEDIN').length;
  const mailboxes = active.length - linkedin;
  const peak = usage.data?.length ? Math.max(...usage.data.map((u) => u.active_senders)) : null;

  async function go(action: 'checkout' | 'portal') {
    setBusy(action);
    try { const r = await callFn<{ url: string }>('stripe-webhook', action === 'checkout' ? { action, workspace_id: ws, plan } : { action, workspace_id: ws }); window.location.href = r.url; }
    catch (e) { toast.show(parseError(e).message, 'error'); setBusy(null); }
  }

  if (!workspace) return <Spinner />;
  if (!isOwner) return <div><PageHeader title="Settings" subtitle={workspace.name} /><SettingsTabs /><ErrorBox message="Only the workspace owner can view billing." /></div>;
  const suspended = workspace.plan === 'suspended';
  const pastDue = workspace.stripe_status === 'past_due' || workspace.stripe_status === 'unpaid' || !!workspace.past_due_since;
  const trialDaysLeft = workspace.trial_ends_at ? Math.ceil((new Date(workspace.trial_ends_at).getTime() - Date.now()) / 86_400_000) : null;
  const hasSubscription = !!workspace.stripe_status && workspace.stripe_status !== 'canceled';

  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <SettingsTabs />

      {checkout === 'success' && <div className="flex items-start gap-2 p-3 mb-6 rounded-lg bg-green-50 text-green-800 text-sm border border-green-200"><CheckCircle2 className="w-4 h-4 mt-0.5" /><span>Checkout complete. Stripe confirms the subscription within a few seconds; the plan below updates automatically.</span></div>}
      {checkout === 'cancel' && <div className="flex items-start gap-2 p-3 mb-6 rounded-lg bg-gray-50 text-gray-700 text-sm border border-gray-200"><XCircle className="w-4 h-4 mt-0.5" /><span>Checkout cancelled. Nothing was charged.</span></div>}
      {pastDue && !suspended && <div className="flex items-start gap-2 p-3 mb-6 rounded-lg bg-amber-50 text-amber-800 text-sm border border-amber-200"><AlertTriangle className="w-4 h-4 mt-0.5" /><span>Payment is past due{workspace.past_due_since ? ` since ${fmtDate(workspace.past_due_since, false)}` : ''}. The workspace becomes read-only and senders pause 7 days after the failed payment. Update the card in the billing portal.</span></div>}
      {suspended && <div className="flex items-start gap-2 p-3 mb-6 rounded-lg bg-red-50 text-red-800 text-sm border border-red-200"><AlertTriangle className="w-4 h-4 mt-0.5" /><span>This workspace is suspended. Senders are paused and writes are blocked until a subscription is active again.</span></div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2" title="Plan">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-2xl font-bold text-gray-900">{PLAN_LABEL[workspace.plan] ?? workspace.plan}</span>
            {workspace.stripe_status && <Badge tone={workspace.stripe_status === 'active' || workspace.stripe_status === 'trialing' ? 'green' : workspace.stripe_status === 'canceled' ? 'gray' : 'amber'}>Stripe: {workspace.stripe_status}</Badge>}
            {workspace.plan === 'trial' && <Badge tone={trialDaysLeft != null && trialDaysLeft > 0 ? 'blue' : 'red'}>{trialDaysLeft != null && trialDaysLeft > 0 ? `${trialDaysLeft} day${trialDaysLeft === 1 ? '' : 's'} left` : 'trial expired'}</Badge>}
          </div>
          {workspace.plan === 'trial' && <p className="text-sm text-gray-600 mt-2">Trial ends {fmtDate(workspace.trial_ends_at, false)}. Up to 3 senders, no card required. Subscribe before it ends to keep senders running.</p>}
          <p className="text-sm text-gray-600 mt-2">Billing is metered by <strong>peak daily active senders</strong> (status ≠ disabled) in each period, synced nightly and invoiced in arrears. Mailboxes beyond the included ones are billed as add-ons.</p>

          <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3">
            {PLANS.map((p) => (
              <button key={p.id} type="button" onClick={() => setPlan(p.id)} aria-pressed={plan === p.id} className={cn('text-left p-4 rounded-xl border transition-colors', plan === p.id ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-gray-200 hover:bg-gray-50')}>
                <div className="font-semibold text-gray-900 flex items-center gap-2">{p.label}{workspace.plan === p.id && <Badge tone="green">current</Badge>}</div>
                <div className="text-xs text-gray-500 mt-1">{p.blurb}</div>
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="w-48"><Select value={plan} onChange={(e) => setPlan(e.target.value as Plan)} aria-label="Plan">{PLANS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select></div>
            <Button onClick={() => go('checkout')} loading={busy === 'checkout'} disabled={!!busy}><CreditCard className="w-4 h-4" /> {hasSubscription ? 'Change plan' : 'Upgrade'}</Button>
            <Button variant="secondary" onClick={() => go('portal')} loading={busy === 'portal'} disabled={!!busy} title="Update card, download invoices, cancel"><ExternalLink className="w-4 h-4" /> Manage billing</Button>
          </div>
          <p className="text-xs text-gray-400 mt-2">Checkout opens Stripe with quantity = current active senders ({Math.max(1, active.length)}). “Manage billing” opens the Stripe customer portal (requires an existing billing account).</p>
        </Card>

        <div className="space-y-3">
          <Stat label="Active senders" value={senders.isLoading ? '…' : active.length} hint={`${linkedin} LinkedIn · ${mailboxes} mailbox${mailboxes === 1 ? '' : 'es'}`} />
          <Stat label="Peak active (30d)" value={usage.isLoading ? '…' : peak ?? '—'} hint="what Stripe quantity syncs to" />
          <Stat label="Trial ends" value={workspace.plan === 'trial' ? fmtDate(workspace.trial_ends_at, false) : '—'} />
        </div>
      </div>

      <Card className="mt-6" title="Usage (last 30 days)">
        {usage.isLoading ? <Spinner /> : usage.isError ? <ErrorBox message={(usage.error as Error).message} /> : !usage.data?.length ? <div className="text-sm text-gray-500 py-4">No usage recorded yet. The nightly billing sync writes one row per day.</div> : (
          <Table>
            <thead><tr><Th>Day</Th><Th className="text-right">Active senders</Th><Th className="text-right">Active mailboxes</Th></tr></thead>
            <tbody>{usage.data.map((u) => <tr key={u.day}><Td className="font-medium text-gray-900">{u.day}</Td><Td className="text-right tabular-nums">{u.active_senders}</Td><Td className="text-right tabular-nums">{u.active_mailboxes}</Td></tr>)}</tbody>
          </Table>
        )}
      </Card>
      {toast.node}
    </div>
  );
}

export default function BillingSettingsPage() {
  return <Suspense fallback={<Spinner />}><BillingInner /></Suspense>;
}
