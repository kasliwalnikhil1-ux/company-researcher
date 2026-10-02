'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CheckCircle2, CreditCard, ExternalLink, Plus, XCircle } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import {
  accountsMeter, billingApi, billingKey, CANCEL_REASONS, changeHref, isPaidPlan, longDate, money, periodLabel, periodNoun, planLabel, planLine, useBilling,
  type BillingState,
} from '@/lib/outreach/billing';
import { discountedCents, pricing, type BillingPeriod } from '@/lib/outreach/pricing';
import { Badge, Button, Card, ErrorBox, fmtDate, Modal, PageHeader, PageLoader, Spinner, Table, Td, Textarea, Th, useToast } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';

type Tone = 'red' | 'amber' | 'blue' | 'green' | 'gray';
const TONES: Record<Tone, string> = {
  red: 'bg-red-50 text-red-800 border-red-200', amber: 'bg-amber-50 text-amber-800 border-amber-200', blue: 'bg-blue-50 text-blue-800 border-blue-200',
  green: 'bg-green-50 text-green-800 border-green-200', gray: 'bg-gray-50 text-gray-700 border-gray-200',
};

/** One clear banner with one button per state (PRD §11.1). */
function Banner({ tone, icon, children, action }: { tone: Tone; icon?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={cn('flex flex-col sm:flex-row sm:items-center gap-3 p-4 mb-6 rounded-xl border text-sm', TONES[tone])}>
      <div className="flex items-start gap-2 flex-1 min-w-0">{icon ?? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}<div className="min-w-0">{children}</div></div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** A plan state as stored on a billing change: quotes say `accounts` / `period`, the workspace says `accounts_billed` / `billing_period`. */
interface StateJson { plan?: string | null; accounts?: number | null; accounts_billed?: number | null; period?: BillingPeriod | null; billing_period?: BillingPeriod | null }
interface ChangeRow { id: string; kind: string; status: string; created_at: string; applied_at: string | null; from_state: StateJson; to_state: StateJson; immediate: StateJson | null; scheduled: StateJson | null; charge_today_cents: number | null; requested_by_email: string | null; error: string | null }

function changeText(c: ChangeRow): string {
  const st = (s: StateJson | null | undefined) => (s ? planLine(s.plan, s.accounts ?? s.accounts_billed, s.period ?? s.billing_period) : '');
  if (c.kind === 'cancel') return 'Cancelled at the end of the period';
  if (c.kind === 'resume') return 'Cancellation undone';
  if (c.kind === 'cancel_scheduled') return `Scheduled change dropped (${st(c.scheduled)})`;
  if (c.kind === 'checkout') return `Subscribed: ${st(c.immediate ?? c.to_state)}`;
  if (c.kind === 'admin') return `Set by our team: ${st(c.to_state)}`;
  const parts = [c.immediate ? `Now: ${st(c.immediate)}` : null, c.scheduled ? `At renewal: ${st(c.scheduled)}` : null].filter(Boolean);
  return parts.join(' · ') || st(c.to_state);
}

function BillingInner() {
  const { workspace, isOwner, refresh } = useWorkspace();
  const ws = workspace?.id;
  const router = useRouter();
  const search = useSearchParams();
  const checkout = search.get('checkout');
  const toast = useToast();
  const qc = useQueryClient();
  const billing = useBilling(ws);
  const b = billing.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);

  const setState = (s: BillingState) => { if (ws) qc.setQueryData(billingKey(ws), s); refresh().catch(() => null); };

  // back from Stripe Checkout: the webhook usually lands first; ask the server to read the subscription in case it has not
  useEffect(() => {
    if (!ws || !isOwner || checkout !== 'success') return;
    let stop = false;
    (async () => {
      for (let i = 0; i < 6 && !stop; i++) {
        try { const r = await billingApi.sync(ws); setState(r.state); if (r.state.has_subscription) break; } catch { /* the page still shows what the webhook wrote */ }
        await new Promise((res) => setTimeout(res, 2500));
      }
    })();
    const t = setTimeout(() => router.replace('/outreach/billing'), 20000);
    return () => { stop = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, isOwner, checkout]);

  const since = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 60); return d.toISOString().slice(0, 10); }, []);
  const usage = useQuery({
    queryKey: ['outreach', ws ?? '', 'billing-usage', since], enabled: !!ws && isOwner,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_billing_usage').select('day, accounts, accounts_billed, active_senders, active_mailboxes').eq('workspace_id', ws!).gte('day', since).order('day');
      if (error) throw parseError(error);
      return (data ?? []) as Array<{ day: string; accounts: number; accounts_billed: number | null; active_senders: number; active_mailboxes: number }>;
    },
  });
  const history = useQuery({ queryKey: ['outreach', ws ?? '', 'billing-changes'], enabled: !!ws && isOwner, queryFn: () => rpc<ChangeRow[]>('billing_changes', { p_ws: ws!, p_limit: 20 }) });

  async function run<T>(key: string, fn: () => Promise<T>, done?: (r: T) => void) {
    setBusy(key);
    try { const r = await fn(); done?.(r); qc.invalidateQueries({ queryKey: ['outreach', ws ?? '', 'billing-changes'] }); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }
  const openUrl = (key: string, fn: () => Promise<{ url: string | null }>, none: string) => run(key, fn, (r) => { if (r.url) window.location.href = r.url; else toast.show(none, 'error'); });

  async function cancel() {
    if (!ws || !reason) return;
    setBusy('cancel'); setCancelError(null);
    try {
      const r = await billingApi.cancel(ws, reason, comment);
      setState(r.state); setCancelOpen(false); setReason(''); setComment('');
      toast.show(`Cancelled. You keep full access until ${longDate(r.access_until)}.`);
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'billing-changes'] });
    } catch (e) { setCancelError(parseError(e).message); }
    finally { setBusy(null); }
  }

  if (!workspace) return <PageLoader />;
  if (!isOwner) return <div><PageHeader title="Billing" subtitle={workspace.name} /><ErrorBox message="Only the workspace owner can view billing." /></div>;
  if (billing.isLoading) return <PageLoader />;
  if (billing.isError || !b) return <div><PageHeader title="Billing" subtitle={workspace.name} /><ErrorBox message={parseError(billing.error).message} /></div>;

  const paid = isPaidPlan(b.plan);
  const meter = accountsMeter(b.accounts);
  const discount = b.early_supporter?.discount ?? 0;
  const listCents = paid && b.billing_period && b.accounts_billed && !b.custom_price ? pricing.rawTotal(b.plan as 'launch', b.billing_period, b.accounts_billed) * 100 : null;
  const payCents = listCents != null ? discountedCents(listCents, discount) : null;
  const sc = b.scheduled_change;
  const scCents = sc?.plan && sc.billing_period && !b.custom_price ? discountedCents(pricing.rawTotal(sc.plan, sc.billing_period, sc.accounts_billed) * 100, discount) : null;
  const nextCents = b.cancel_at_period_end ? null : scCents ?? payCents;
  const maxUsage = Math.max(1, ...(usage.data ?? []).map((u) => Math.max(u.accounts || u.active_senders + u.active_mailboxes, u.accounts_billed ?? 0)));

  return (
    <div>
      <PageHeader title="Billing" subtitle={workspace.name} />

      {checkout === 'success' && <Banner tone="green" icon={<CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}>Payment received. {b.has_subscription ? 'Your plan is active: connect your accounts from Senders.' : 'Your plan appears here within a few seconds.'}</Banner>}
      {checkout === 'cancel' && <Banner tone="gray" icon={<XCircle className="w-4 h-4 mt-0.5 shrink-0" />}>Checkout was closed. Nothing was charged.</Banner>}

      {!b.enforced && (
        <Banner tone="gray" icon={<CreditCard className="w-4 h-4 mt-0.5 shrink-0" />}>
          Billing is not switched on for this workspace yet. Every feature is available and accounts are not limited; nothing is charged.
        </Banner>
      )}
      {b.enforced && b.plan === 'trial' && (
        <Banner tone={(b.trial?.days_left ?? 9) <= 2 ? 'amber' : 'blue'} icon={<CalendarClock className="w-4 h-4 mt-0.5 shrink-0" />}
          action={<Link href={changeHref()}><Button>Subscribe</Button></Link>}>
          <strong>{b.trial?.days_left === 0 ? 'Your trial ends today.' : `Your trial ends in ${b.trial?.days_left} day${b.trial?.days_left === 1 ? '' : 's'}.`}</strong> {b.trial?.account_limit ?? 1} account, no card required.
          Subscribe to keep your account connected: without a subscription it is disconnected on {longDate(b.trial?.ends_at)}.
        </Banner>
      )}
      {b.plan === 'trial_expired' && (
        <Banner tone="red" action={<Link href={changeHref()}><Button>Subscribe</Button></Link>}>
          <strong>Your trial has ended.</strong> Your account is disconnected and nothing is being sent. Your sequences, leads and conversations are kept{b.data_delete_after ? ` until ${longDate(b.data_delete_after)}` : ''}: subscribe, reconnect the account, and everything carries on.
        </Banner>
      )}
      {b.plan === 'cancelled' && (
        <Banner tone="red" action={<Link href={changeHref({ plan: isPaidPlan(b.plan_before_suspension) ? b.plan_before_suspension : undefined })}><Button>Subscribe again</Button></Link>}>
          <strong>This subscription has ended.</strong> Senders are paused and the workspace is read-only. Your data is kept{b.data_delete_after ? ` until ${longDate(b.data_delete_after)}` : ' for 90 days'}.
        </Banner>
      )}
      {b.plan === 'suspended' && (
        <Banner tone="red" action={b.has_customer ? <Button onClick={() => openUrl('pay', () => billingApi.payNow(ws!), 'There is no open invoice to pay.')} loading={busy === 'pay'}>Pay now</Button> : undefined}>
          <strong>This workspace is suspended.</strong> {b.disputed ? 'A card dispute is open on a payment for this workspace.' : 'The invoice is still unpaid.'} Senders are paused and nothing sends. Once it is settled they resume on their own.
        </Banner>
      )}
      {b.plan !== 'suspended' && b.past_due && (
        <Banner tone="amber" action={<Button onClick={() => openUrl('pay', () => billingApi.payNow(ws!), 'There is no open invoice to pay.')} loading={busy === 'pay'}>Pay now</Button>}>
          <strong>Your last payment didn&apos;t go through.</strong> We&apos;ll try the card again. If it is still open 7 days after {b.past_due_since ? longDate(b.past_due_since) : 'the first attempt'}, sending pauses until it is paid.
        </Banner>
      )}
      {b.pending_payment && (
        <Banner tone="amber" action={<Link href={changeHref()}><Button>Finish payment</Button></Link>}>
          <strong>A payment is waiting for your bank&apos;s confirmation.</strong> The change you made applies once it is confirmed{b.pending_payment.expires_at ? ` (before ${fmtDate(b.pending_payment.expires_at)})` : ''}.
        </Banner>
      )}
      {b.cancel_at_period_end && paid && (
        <Banner tone="amber" action={<Button onClick={() => run('resume', () => billingApi.resume(ws!), (r) => { setState(r.state); toast.show('Your subscription continues.'); })} loading={busy === 'resume'}>Keep my subscription</Button>}>
          <strong>Your subscription ends on {longDate(b.current_period_end)}.</strong> You have full access until then. After that, senders pause and the workspace becomes read-only.
        </Banner>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2" title="Your plan">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-xl font-semibold text-gray-900">{paid ? planLine(b.plan, b.accounts_billed, b.billing_period) : planLabel(b.plan)}</div>
              {b.plan === 'trial' && <p className="text-sm text-gray-600 mt-1">{b.trial?.account_limit ?? 1} account, no card required. You have Scale&apos;s features during the trial.</p>}
              {b.comp && <p className="text-sm text-gray-600 mt-1">This plan is managed by our team; nothing is charged here.</p>}
            </div>
            {paid && !b.comp && (
              <div className="text-right">
                {payCents != null ? (
                  <>
                    <div className="text-xl font-semibold text-gray-900">{money(payCents)} <span className="text-sm font-normal text-gray-500">/ {periodNoun(b.billing_period)}</span></div>
                    {discount > 0 && listCents != null && <div className="text-xs text-gray-500 mt-0.5">early supporter −{Math.round(discount * 100)}% on {money(listCents)}</div>}
                    {b.quote_current && <div className="text-xs text-gray-500 mt-0.5">${b.quote_current.per_account} per account per month</div>}
                  </>
                ) : <div className="text-sm text-gray-600">Custom agreement</div>}
              </div>
            )}
          </div>

          {meter && (
            <div className="mt-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-gray-700"><span className="font-medium text-gray-900">{meter.text}</span> used{b.accounts?.reserved ? <span className="text-gray-500"> · {b.accounts.reserved} being connected</span> : null}</div>
                {paid && b.has_subscription && !b.cancel_at_period_end && <Link href={changeHref({ accounts: (b.accounts_billed ?? 0) + 1 })}><Button variant="secondary" size="sm"><Plus className="w-3.5 h-3.5" /> Add accounts</Button></Link>}
              </div>
              <div className="mt-2 h-2 bg-gray-100 rounded-full overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={meter.billed} aria-valuenow={meter.used} aria-label="Accounts used">
                <div className={cn('h-full rounded-full', meter.used > meter.billed ? 'bg-red-500' : meter.full ? 'bg-amber-500' : 'bg-indigo-500')} style={{ width: `${meter.pct}%` }} />
              </div>
              <p className="text-xs text-gray-500 mt-1.5">An account is a LinkedIn account, a mailbox, an Instagram account or a WhatsApp number. Teammates and client viewers are free.</p>
              {!!b.accounts?.over_limit && <p className="text-sm text-amber-700 mt-2">{b.accounts.over_limit} account{b.accounts.over_limit === 1 ? ' is' : 's are'} paused because your plan has {meter.billed}. Add accounts or remove some on <Link href="/outreach/senders" className="underline">Senders</Link>.</p>}
            </div>
          )}

          {paid && b.has_subscription && (
            <dl className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
              <div><dt className="text-gray-500">{b.cancel_at_period_end ? 'Access until' : 'Next invoice'}</dt>
                <dd className="text-gray-900 font-medium">{longDate(b.current_period_end)}{nextCents != null ? <> · {money(nextCents)}<span className="font-normal text-gray-500"> plus tax where it applies</span></> : null}</dd></div>
              <div><dt className="text-gray-500">Billing period</dt><dd className="text-gray-900 font-medium">{periodLabel(b.billing_period)}</dd></div>
            </dl>
          )}

          {sc && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-indigo-50 border border-indigo-100 text-sm text-indigo-900">
              <span><strong>Scheduled:</strong> switches to {planLine(sc.plan ?? b.plan, sc.accounts_billed, sc.billing_period ?? b.billing_period)} on {longDate(sc.effective_at ?? b.current_period_end)}{scCents != null ? <> ({money(scCents)} / {periodNoun(sc.billing_period ?? b.billing_period)})</> : null}.</span>
              <Button variant="secondary" size="sm" onClick={() => run('unschedule', () => billingApi.cancelScheduled(ws!), (r) => { setState(r.state); toast.show('The scheduled change was cancelled.'); })} loading={busy === 'unschedule'}>Cancel this change</Button>
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-2">
            {b.enforced && !b.comp && <Link href={changeHref()}><Button disabled={!!busy}><CreditCard className="w-4 h-4" /> {b.has_subscription ? 'Change plan' : 'Subscribe'}</Button></Link>}
            {b.has_customer && <Button variant="secondary" onClick={() => openUrl('portal', () => billingApi.portal(ws!), 'The billing portal is not available.')} loading={busy === 'portal'} disabled={!!busy}><ExternalLink className="w-4 h-4" /> Payment method &amp; invoices</Button>}
            {paid && b.has_subscription && !b.cancel_at_period_end && <Button variant="ghost" onClick={() => { setCancelOpen(true); setCancelError(null); }} disabled={!!busy}>Cancel subscription</Button>}
          </div>
          <p className="text-xs text-gray-400 mt-3">More accounts and upgrades apply straight away; you pay the difference for the rest of your billing period. Fewer accounts and downgrades apply from your next billing period. Payments are non-refundable.</p>
        </Card>

        <Card title="Accounts connected over time">
          {usage.isLoading ? <Spinner /> : usage.isError ? <ErrorBox message={(usage.error as Error).message} /> : !usage.data?.length ? <p className="text-sm text-gray-500">Nothing recorded yet. One point is added each day.</p> : (
            <div>
              <div className="flex items-end gap-[2px] h-28" aria-hidden="true">
                {usage.data.map((u) => {
                  const n = u.accounts || u.active_senders + u.active_mailboxes;
                  return <div key={u.day} className="flex-1 min-w-[2px] bg-indigo-400/80 rounded-t" style={{ height: `${Math.max(3, Math.round((n / maxUsage) * 100))}%` }} title={`${u.day}: ${n} connected${u.accounts_billed != null ? ` of ${u.accounts_billed}` : ''}`} />;
                })}
              </div>
              <div className="flex justify-between text-xs text-gray-400 mt-1"><span>{usage.data[0].day}</span><span>{usage.data[usage.data.length - 1].day}</span></div>
              <p className="text-xs text-gray-500 mt-3">For information only. Your bill is the number of accounts on your plan, not how many are connected.</p>
            </div>
          )}
        </Card>
      </div>

      <Card className="mt-6" title="Billing history">
        {history.isLoading ? <Spinner /> : history.isError ? <ErrorBox message={parseError(history.error).message} /> : !history.data?.length ? <p className="text-sm text-gray-500">No plan changes yet.{b.has_customer ? ' Invoices are under “Payment method & invoices”.' : ''}</p> : (
          <Table>
            <thead><tr><Th>When</Th><Th>Change</Th><Th className="text-right">Charged</Th><Th>Status</Th><Th>By</Th></tr></thead>
            <tbody>
              {history.data.map((c) => (
                <tr key={c.id}>
                  <Td className="whitespace-nowrap text-gray-600">{fmtDate(c.applied_at ?? c.created_at)}</Td>
                  <Td className="text-gray-900">{changeText(c)}{c.status === 'failed' && c.error ? <div className="text-xs text-red-600 mt-0.5">{c.error}</div> : null}</Td>
                  <Td className="text-right">{c.charge_today_cents ? money(c.charge_today_cents) : '—'}</Td>
                  <Td><Badge tone={c.status === 'applied' ? 'green' : c.status === 'scheduled' ? 'indigo' : c.status === 'pending_payment' ? 'amber' : c.status === 'failed' ? 'red' : 'gray'}>{c.status === 'pending_payment' ? 'waiting for payment' : c.status}</Badge></Td>
                  <Td className="text-gray-600">{c.requested_by_email ?? (c.kind === 'admin' ? 'our team' : '—')}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel your subscription?" size="md"
        footer={<><Button variant="secondary" onClick={() => setCancelOpen(false)}>Keep my subscription</Button><Button variant="danger" onClick={cancel} loading={busy === 'cancel'} disabled={!reason}>Cancel subscription</Button></>}>
        <div className="space-y-4 text-sm text-gray-700">
          <p>You keep full access until <strong>{longDate(b.current_period_end)}</strong>, the end of the period you paid for. After that, senders pause, nothing sends, and the workspace is read-only. Your data is kept for 90 days.</p>
          <p className="text-gray-500">There is no refund for the rest of the period. You can undo this any time before {longDate(b.current_period_end)}.</p>
          <fieldset>
            <legend className="font-medium text-gray-900 mb-2">What&apos;s the main reason?</legend>
            <div className="space-y-1.5">
              {CANCEL_REASONS.map((r) => (
                <label key={r.value} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="cancel-reason" value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} className="text-indigo-600 focus:ring-indigo-500" />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Textarea label="Anything we should know? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} rows={3} maxLength={2000} />
          {sc && <p className="text-amber-700">The change scheduled for {longDate(sc.effective_at)} is dropped when you cancel.</p>}
          {cancelError && <ErrorBox message={cancelError} />}
        </div>
      </Modal>
      {toast.node}
    </div>
  );
}

export default function BillingPage() {
  return <Suspense fallback={<PageLoader />}><BillingInner /></Suspense>;
}
