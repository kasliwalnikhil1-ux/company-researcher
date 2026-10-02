'use client';

import { Suspense, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from '@/lib/outreach/nav';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Info, Minus, Plus, ShieldCheck } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import {
  billingApi, billingKey, confirmWithBank, isPaidPlan, longDate, money, periodNoun, planLine, TALK_TO_US_URL, useBilling,
  type BillingState, type QuoteResponse,
} from '@/lib/outreach/billing';
import { discountedCents, pricing, type BillingPeriod, type PlanId } from '@/lib/outreach/pricing';
import { BackLink, Badge, Button, Card, ErrorBox, PageHeader, PageLoader, Spinner } from '@/components/outreach/ui';
import { useDebouncedValue } from '@/lib/outreach/billing';
import { cn } from '@/lib/utils';

const MAX = pricing.book.max_self_serve_accounts;
const STEPS = pricing.steps;
const clampAccounts = (n: number) => Math.max(1, Math.min(9999, Math.round(n || 1)));

/** Pending 3-D Secure step: confirm in the app when Stripe.js is configured, otherwise on Stripe's own invoice page. */
function PendingPayment({ ws, clientSecret, hostedUrl, onDone, onError }: { ws: string; clientSecret: string | null; hostedUrl: string | null; onDone: (s: BillingState) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function check() {
    setBusy('check');
    try { const r = await billingApi.sync(ws); onDone(r.state); if (r.state.pending_payment) onError('The payment is not confirmed yet.'); }
    catch (e) { onError(parseError(e).message); }
    finally { setBusy(null); }
  }
  async function confirmHere() {
    if (!clientSecret) return;
    setBusy('confirm');
    try {
      const r = await confirmWithBank(clientSecret);
      if (r.ok) { const s = await billingApi.sync(ws); onDone(s.state); }
      else if (r.error !== 'no_publishable_key') onError(r.error ?? 'The payment was not confirmed.');
    } catch (e) { onError(parseError(e).message); }
    finally { setBusy(null); }
  }
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 space-y-3">
      <div className="flex items-start gap-2"><ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" /><div><strong>Your bank needs you to confirm this payment.</strong> Nothing has changed yet: the change applies the moment the payment is confirmed.</div></div>
      <div className="flex flex-wrap gap-2">
        {clientSecret && process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY && <Button onClick={confirmHere} loading={busy === 'confirm'} disabled={!!busy}>Confirm with your bank</Button>}
        {hostedUrl && <a href={hostedUrl} target="_blank" rel="noopener noreferrer"><Button variant={clientSecret && process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ? 'secondary' : 'primary'} disabled={!!busy}>Open the payment page</Button></a>}
        <Button variant="secondary" onClick={check} loading={busy === 'check'} disabled={!!busy}>I&apos;ve confirmed it</Button>
        <Button variant="ghost" disabled={!!busy} loading={busy === 'abandon'} onClick={async () => { setBusy('abandon'); try { const r = await billingApi.abandonPayment(ws); onDone(r.state); } catch (e) { onError(parseError(e).message); } finally { setBusy(null); } }}>Abandon this change</Button>
      </div>
    </div>
  );
}

function ChangeInner() {
  const { workspace, isOwner, refresh } = useWorkspace();
  const ws = workspace?.id;
  const router = useRouter();
  const search = useSearchParams();
  const qc = useQueryClient();
  const billing = useBilling(ws);
  const b = billing.data;

  // what the customer picked; until they touch a control it follows the link's preset, then what the workspace has
  const [planE, setPlan] = useState<PlanId | null>(null);
  const [accountsE, setAccounts] = useState<number | null>(null);
  const [periodE, setPeriod] = useState<BillingPeriod | null>(null);
  const [keep, setKeep] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ clientSecret: string | null; hostedUrl: string | null } | null>(null);

  const start = useMemo(() => {
    if (!b) return null;
    const qp = search.get('plan'), qa = Number(search.get('accounts')), qper = search.get('period');
    const current = isPaidPlan(b.plan) ? b.plan : null;
    return {
      plan: (pricing.isPlan(qp) ? qp : current ?? (isPaidPlan(b.plan_before_suspension) ? b.plan_before_suspension : b.feature_plan ?? 'scale')) as PlanId,
      accounts: clampAccounts(Number.isFinite(qa) && qa >= 1 ? qa : current ? (b.accounts_requested ?? b.accounts_billed ?? 1) : Math.max(1, b.accounts?.used ?? 1)),
      period: (pricing.isPeriod(qper) ? qper : b.billing_period ?? 'monthly') as BillingPeriod,
    };
  }, [b, search]);
  const plan = planE ?? start?.plan ?? null;
  const accounts = accountsE ?? start?.accounts ?? null;
  const period = periodE ?? start?.period ?? null;

  const hasSub = !!b?.has_subscription;
  const from = useMemo(() => (hasSub && b && isPaidPlan(b.plan) && b.billing_period && b.accounts_billed ? { plan: b.plan, period: b.billing_period, accounts: b.accounts_billed } : null), [hasSub, b]);
  const ready = !!(plan && accounts && period);
  const over = !!accounts && accounts > MAX && !b?.custom_price;
  const local = ready && !over ? pricing.quote(plan!, period!, accounts!) : null;
  const split = ready && from && !over ? pricing.splitChange(from, { plan: plan!, period: period!, accounts: accounts! }, b?.custom_price ? 5000 : MAX) : null;
  const discount = b?.early_supporter?.discount ?? 0;
  const blockedLocal = split?.blocked ?? null;

  // the server's quote, a moment after the controls settle (each one is a fresh preview of the change at Stripe)
  const wanted = ready ? JSON.stringify({ plan, accounts, period, keep }) : '';
  const settled = useDebouncedValue(wanted, 350);
  const canQuote = !!ws && ready && !over && !!b?.enforced && !b.comp && !b.pending_payment && !action && !blockedLocal;
  const quoteQuery = useQuery({
    queryKey: ['outreach', ws ?? '', 'billing-quote', settled, b?.plan, b?.accounts_billed, b?.billing_period],
    enabled: canQuote && settled === wanted && settled !== '',
    queryFn: () => { const t = JSON.parse(settled) as { plan: PlanId; accounts: number; period: BillingPeriod; keep: string[] | null }; return billingApi.quote(ws!, { plan: t.plan, accounts: t.accounts, period: t.period }, t.keep); },
    staleTime: 60_000, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const quote: QuoteResponse | null = canQuote && settled === wanted ? quoteQuery.data ?? null : null;
  const quoting = canQuote && (settled !== wanted || quoteQuery.isFetching);
  const quoteError = canQuote && settled === wanted && quoteQuery.isError ? { code: parseError(quoteQuery.error).code, message: parseError(quoteQuery.error).message } : null;

  const applyState = (s: BillingState) => { if (ws) qc.setQueryData(billingKey(ws), s); refresh().catch(() => null); };
  const finish = (s: BillingState) => {
    applyState(s);
    if (!s.pending_payment) { setAction(null); qc.invalidateQueries({ queryKey: ['outreach', ws ?? ''] }); router.push('/outreach/billing'); }
  };

  async function confirm() {
    if (!ws || !quote) return;
    setBusy(true); setError(null);
    try {
      if (quote.quote.mode === 'checkout') { const r = await billingApi.checkout(ws, quote.quote_id); window.location.href = r.url; return; }
      const r = await billingApi.change(ws, quote.quote_id, keep);
      if (r.status === 'requires_action') {
        applyState(r.state);
        setAction({ clientSecret: r.client_secret ?? null, hostedUrl: r.hosted_invoice_url ?? null });
        // the bank's step opens in place when the app has a Stripe publishable key; otherwise the panel links to Stripe's page
        if (r.client_secret) {
          const c = await confirmWithBank(r.client_secret);
          if (c.ok) finish((await billingApi.sync(ws)).state);
          else if (c.error !== 'no_publishable_key') setError(c.error ?? 'The payment was not confirmed.');
        }
      } else finish(r.state);
    } catch (e) {
      const pe = parseError(e);
      setError(pe.message);
      // the amount moved, or someone else changed the subscription: show the fresh figure
      if (pe.code === 'E_QUOTE_STALE') { await billing.refetch(); await quoteQuery.refetch(); }
    } finally { setBusy(false); }
  }

  if (!workspace) return <PageLoader />;
  if (!isOwner) return <div><PageHeader title="Change plan" subtitle={workspace.name} /><ErrorBox message="Only the workspace owner can change the plan." /></div>;
  if (billing.isLoading || !b || !ready) return <PageLoader />;

  const q = quote?.quote ?? null;
  const title = hasSub ? 'Change plan' : 'Subscribe';
  const toPause = q?.senders_to_pause ?? [];
  const keepLimit = q?.final.accounts ?? 0;
  const kept = toPause.filter((s) => s.keep).map((s) => s.sender_id);
  const toggleKeep = (id: string) => {
    const cur = keep ?? kept;
    if (cur.includes(id)) setKeep(cur.filter((x) => x !== id));
    else if (cur.length < keepLimit) setKeep([...cur, id]);
  };
  const listCents = local ? local.period_total * 100 : null;
  const payCents = listCents != null ? discountedCents(listCents, discount) : null;
  const nothingToDo = !b.enforced || b.comp;

  return (
    <div>
      <BackLink href="/outreach/billing">Billing</BackLink>
      <PageHeader title={title} subtitle={hasSub ? `You have ${planLine(b.plan, b.accounts_billed, b.billing_period)}` : workspace.name} />

      {!b.enforced && <ErrorBox className="mb-6" message="Billing is not switched on for this workspace yet, so there is nothing to change." />}
      {b.comp && <ErrorBox className="mb-6" message="This workspace's plan is managed by our team. Talk to us to change it." />}
      {b.cancel_at_period_end && hasSub && <div className="flex items-start gap-2 p-3 mb-6 rounded-lg bg-amber-50 text-amber-800 text-sm border border-amber-200"><Info className="w-4 h-4 mt-0.5 shrink-0" /><span>Your subscription is set to end on {longDate(b.current_period_end)}. Confirming a change here resumes it.</span></div>}
      {(b.pending_payment || action) && ws && (
        <div className="mb-6"><PendingPayment ws={ws} clientSecret={action?.clientSecret ?? null} hostedUrl={action?.hostedUrl ?? b.pending_payment?.hosted_invoice_url ?? null} onDone={finish} onError={setError} />{error && <ErrorBox className="mt-3" message={error} />}</div>
      )}

      <div className={cn('grid grid-cols-1 lg:grid-cols-3 gap-6', (nothingToDo || b.pending_payment || action) && 'opacity-60 pointer-events-none')} aria-disabled={nothingToDo || !!b.pending_payment || !!action}>
        <div className="lg:col-span-2 space-y-6">
          <Card title="Plan">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3" role="radiogroup" aria-label="Plan">
              {pricing.book.plans.map((p) => {
                const price = accounts && !over ? pricing.perAccount(p.id, period!, pricing.quote(p.id, period!, accounts).billed) : null;
                const selected = plan === p.id;
                return (
                  <button key={p.id} type="button" role="radio" aria-checked={selected} onClick={() => { setPlan(p.id); setKeep(null); }}
                    className={cn('flex flex-col items-stretch justify-start h-full text-left p-4 rounded-xl border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500', selected ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-gray-200 hover:bg-gray-50')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-gray-900">{p.name}</span>
                      {from?.plan === p.id && <Badge tone="green">current</Badge>}
                    </div>
                    <div className="mt-1 text-sm text-gray-900"><span className="text-lg font-semibold">{price != null ? `$${price}` : '—'}</span> <span className="text-gray-500">per account / month</span></div>
                    <div className="text-xs text-gray-500 mt-1 min-h-[2rem]">{p.for}</div>
                    <ul className="mt-3 space-y-1">
                      {p.highlights.map((h) => <li key={h} className="flex items-start gap-1.5 text-xs text-gray-700">{h.endsWith(':') ? <span className="font-medium">{h}</span> : <><Check className="w-3.5 h-3.5 mt-0.5 text-indigo-600 shrink-0" /><span>{h}</span></>}</li>)}
                    </ul>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card title="Accounts">
            <p className="text-sm text-gray-600">How many LinkedIn accounts, mailboxes, Instagram accounts and WhatsApp numbers you can connect. The price per account drops at 5, 10, 20, 50 and 100. Teammates are free.</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="inline-flex items-center rounded-lg border border-gray-300 overflow-hidden">
                <button type="button" aria-label="One account fewer" className="px-3 py-2 hover:bg-gray-50 disabled:opacity-40" disabled={(accounts ?? 1) <= 1} onClick={() => { setAccounts(clampAccounts((accounts ?? 1) - 1)); setKeep(null); }}><Minus className="w-4 h-4" /></button>
                <input type="number" min={1} inputMode="numeric" aria-label="Number of accounts" value={accounts ?? ''} onChange={(e) => { setAccounts(clampAccounts(Number(e.target.value))); setKeep(null); }}
                  className="w-20 text-center text-base font-semibold border-0 focus:ring-0 py-2" />
                <button type="button" aria-label="One account more" className="px-3 py-2 hover:bg-gray-50" onClick={() => { setAccounts(clampAccounts((accounts ?? 1) + 1)); setKeep(null); }}><Plus className="w-4 h-4" /></button>
              </div>
              {b.accounts && <span className="text-sm text-gray-500">{b.accounts.used} connected now</span>}
            </div>
            <div className="mt-5 px-1">
              <input type="range" min={1} max={MAX} step={1} value={Math.min(accounts ?? 1, MAX)} onChange={(e) => { setAccounts(Number(e.target.value)); setKeep(null); }} aria-label="Number of accounts" className="w-full accent-indigo-600" />
              <div className="relative h-5 mt-1 text-xs text-gray-500">
                {STEPS.map((s) => (
                  <button key={s} type="button" onClick={() => { setAccounts(s); setKeep(null); }} className={cn('absolute -translate-x-1/2 hover:text-indigo-700', (local?.billed ?? accounts) === s && 'text-indigo-700 font-semibold')} style={{ left: `${((s - 1) / (MAX - 1)) * 100}%` }}>
                    {s === MAX ? `${s}+` : s}
                  </button>
                ))}
              </div>
            </div>
            {over && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-700">
                <span>Plans with more than {MAX} accounts are set up with our team.</span>
                <a href={TALK_TO_US_URL} target="_blank" rel="noopener noreferrer"><Button variant="secondary" size="sm">Talk to us</Button></a>
              </div>
            )}
            {local?.best_price && (
              <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-900">
                <Info className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{local.billed} accounts cost {local.requested_total === local.period_total ? 'the same as' : 'less than'} {local.requested} ({money(local.period_total * 100)} vs {money(local.requested_total * 100)}). You&apos;ll get {local.billed}.</span>
              </div>
            )}
          </Card>

          <Card title="Billing period">
            <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden" role="radiogroup" aria-label="Billing period">
              {pricing.book.periods.map((p) => (
                <button key={p.id} type="button" role="radio" aria-checked={period === p.id} onClick={() => { setPeriod(p.id); setKeep(null); }}
                  className={cn('px-4 py-2 text-sm font-medium border-r border-gray-300 last:border-r-0', period === p.id ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50')}>
                  {p.label}{p.discount > 0 ? <span className={cn('ml-1.5 text-xs', period === p.id ? 'text-indigo-100' : 'text-green-700')}>−{Math.round(p.discount * 100)}%</span> : null}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">Quarterly and annual are paid up front for the whole period.</p>
          </Card>

          {toPause.length > 0 && q && (
            <Card title={`Choose which ${keepLimit} account${keepLimit === 1 ? '' : 's'} to keep`}>
              <p className="text-sm text-gray-600">You have more accounts connected than the new plan allows. From {longDate(q.later_at ?? q.next_invoice.at)} the others pause (nothing is deleted, and their leads wait). If you don&apos;t choose, we keep the most active ones.</p>
              <ul className="mt-3 divide-y divide-gray-100">
                {toPause.map((s) => {
                  const on = (keep ?? kept).includes(s.sender_id);
                  const full = !on && (keep ?? kept).length >= keepLimit;
                  return (
                    <li key={s.sender_id} className="flex items-center justify-between gap-3 py-2">
                      <label className={cn('flex items-center gap-2 text-sm min-w-0', full ? 'text-gray-400' : 'text-gray-900 cursor-pointer')}>
                        <input type="checkbox" checked={on} disabled={full} onChange={() => toggleKeep(s.sender_id)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                        <span className="truncate">{s.name ?? 'Account'}</span>
                        <span className="text-xs text-gray-500 shrink-0">{s.provider.charAt(0) + s.provider.slice(1).toLowerCase()} · {s.activity_14d} action{s.activity_14d === 1 ? '' : 's'} in 14 days</span>
                      </label>
                      <Badge tone={on ? 'green' : s.action === 'disconnect' ? 'gray' : 'amber'}>{on ? 'stays' : s.action === 'disconnect' ? 'disconnects' : 'pauses'}</Badge>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>

        <div>
          <div className="lg:sticky lg:top-4 space-y-4">
            <Card title="Summary">
              {over ? <p className="text-sm text-gray-600">Talk to us for more than {MAX} accounts.</p> : (
                <div className="space-y-4 text-sm">
                  <div>
                    <div className="font-medium text-gray-900">{planLine(plan, local?.billed ?? accounts, period)}</div>
                    {local && <div className="text-gray-600 mt-0.5">${local.per_account} × {local.billed} account{local.billed === 1 ? '' : 's'}{local.months > 1 ? ` × ${local.months} months` : ''} = {money(listCents!)} / {periodNoun(period)}</div>}
                    {discount > 0 && payCents != null && <div className="text-green-700 mt-0.5">Early supporter −{Math.round(discount * 100)}%: {money(payCents)} / {periodNoun(period)}</div>}
                  </div>

                  {blockedLocal ? (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-gray-50 border border-gray-200 text-gray-700"><Info className="w-4 h-4 mt-0.5 shrink-0" /><span>{blockedLocal.message}</span></div>
                  ) : quoteError ? (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /><span>{quoteError.message}</span></div>
                  ) : !q ? (
                    <div className="flex items-center gap-2 text-gray-500 py-2">{quoting && <><Spinner className="w-4 h-4" /> Working out the exact amount…</>}</div>
                  ) : (
                    <div className={cn('space-y-4 transition-opacity', quoting && 'opacity-60')}>
                      <div className="rounded-lg border border-gray-200 divide-y divide-gray-100">
                        <div className="p-3">
                          <div className="flex items-baseline justify-between gap-3"><span className="font-medium text-gray-900">Today</span><span className="text-lg font-semibold text-gray-900">{money(q.charge_today_cents)}</span></div>
                          {q.now_changes.length > 0 ? <ul className="mt-1.5 space-y-0.5 text-gray-700">{q.now_changes.map((c) => <li key={c}>{c}</li>)}</ul> : <p className="mt-1 text-gray-500">Nothing changes today.</p>}
                          {q.proration_note && <p className="mt-1.5 text-xs text-gray-500">{q.proration_note}</p>}
                          {!!q.tax_today_cents && <p className="mt-1 text-xs text-gray-500">Includes {money(q.tax_today_cents)} tax.</p>}
                          {q.tax_note && <p className="mt-1 text-xs text-gray-500">{q.tax_note}</p>}
                        </div>
                        <div className="p-3">
                          <div className="flex items-baseline justify-between gap-3"><span className="font-medium text-gray-900">On {longDate(q.later_at ?? q.next_invoice.at)}</span><span className="font-semibold text-gray-900">{q.next_invoice.cents != null ? money(q.next_invoice.cents) : 'per your agreement'}</span></div>
                          {q.later_changes.length > 0 && <ul className="mt-1.5 space-y-0.5 text-gray-700">{q.later_changes.map((c) => <li key={c}>{c}</li>)}</ul>}
                          <p className="mt-1.5 text-xs text-gray-500">Your next invoice, then every {periodNoun(q.final.period)}. Tax is added where it applies.</p>
                        </div>
                      </div>

                      {!!q.effects?.length && (
                        <div>
                          <div className="font-medium text-gray-900">What switches off on {longDate(q.later_at ?? q.next_invoice.at)}</div>
                          <ul className="mt-1.5 space-y-1 text-gray-700">{q.effects.map((e) => <li key={e.feature} className="flex items-start gap-1.5"><Minus className="w-3.5 h-3.5 mt-1 text-gray-400 shrink-0" /><span>{e.text}</span></li>)}</ul>
                          <p className="mt-1.5 text-xs text-gray-500">Nothing is deleted. Upgrading again brings these back.</p>
                        </div>
                      )}
                      {q.replaces_scheduled && b.scheduled_change && <p className="text-xs text-gray-500">This replaces the change already scheduled for {longDate(b.scheduled_change.effective_at)}.</p>}
                      {q.price_version_change && <p className="text-xs text-gray-500">Changing plan moves you to the current prices.</p>}

                      {error && <ErrorBox message={error} />}
                      <Button className="w-full" onClick={confirm} loading={busy} disabled={busy || quoting || !!b.pending_payment || !!action}>
                        {q.mode === 'checkout' ? `Continue to payment · ${money(q.charge_today_cents)}` : q.applies_now ? `Confirm and pay ${money(q.charge_today_cents)}` : 'Schedule change'}
                      </Button>
                      <p className="text-xs text-gray-500 text-center">Payments are non-refundable. You can cancel any time and keep access until the end of the period you paid for.</p>
                    </div>
                  )}
                </div>
              )}
            </Card>
            {hasSub && <p className="text-xs text-gray-500 px-1">More accounts, a higher plan or a longer billing period apply now. Fewer accounts, a lower plan or a shorter period apply at your next renewal. To pause or leave, use Cancel subscription on the Billing page.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChangePlanPage() {
  return <Suspense fallback={<PageLoader />}><ChangeInner /></Suspense>;
}
