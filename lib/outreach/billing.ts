'use client';

// Billing v2 for the web app (pricing-billing-PRD.md §11): the billing state every screen reads, the owner actions, and the
// small helpers the meters, banners and plan gates share. Prices and the "now vs at renewal" rules come from
// lib/outreach/pricing.ts (the same file the edge functions run); every amount shown before a confirm comes from the server.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { callFn, rpc } from './api';
import { pricing, formatUsd, type BillingPeriod, type PlanId } from './pricing';

export type WorkspacePlan = 'trial' | 'trial_expired' | 'launch' | 'scale' | 'enterprise' | 'suspended' | 'cancelled';
export const PLAN_LABEL: Record<string, string> = {
  trial: 'Trial', trial_expired: 'Trial ended', launch: 'Launch', scale: 'Scale', enterprise: 'Enterprise', suspended: 'Suspended', cancelled: 'Cancelled',
};
export const planLabel = (plan: string | null | undefined): string => PLAN_LABEL[String(plan ?? '')] ?? String(plan ?? '');
export const PAID_PLANS: PlanId[] = ['launch', 'scale', 'enterprise'];
export const isPaidPlan = (p: string | null | undefined): p is PlanId => (PAID_PLANS as string[]).includes(String(p));
/** Plans on which nothing may be written or sent (the workspace is read-only). */
export const INACTIVE_PLANS = ['suspended', 'cancelled', 'trial_expired'];

/** Feature keys of the plan matrix (pricing/v1.json `features`). */
export type FeatureKey = 'ai_auto_reply' | 'clients' | 'client_viewer' | 'client_reports' | 'tracking_domains' | 'white_label' | 'webhooks' | 'public_api' | 'crm_sync' | 'priority_processing' | 'ai_limits' | 'webchat_inboxes' | 'voice_minutes' | 'voice_max_minutes' | 'voice_concurrency' | 'voice_own_key';

export interface AccountSlots {
  /** false while the platform has not switched billing on: nothing is limited */
  enforced: boolean;
  plan: string;
  trial: boolean;
  /** accounts the plan allows (null = no limit) */
  billed: number | null;
  requested: number | null;
  /** accounts connected: LinkedIn accounts + mailboxes + Instagram accounts + WhatsApp numbers */
  used: number;
  /** held by sign-in links that are still open */
  reserved: number;
  /** paused because the plan has fewer accounts than are connected */
  over_limit: number;
  /** free accounts (null = no limit) */
  available: number | null;
}

export interface ScheduledChange { plan: PlanId | null; accounts_billed: number; accounts_requested?: number; billing_period: BillingPeriod | null; effective_at: string | null; keep_sender_ids?: string[] }
export interface PendingPayment { invoice_id: string | null; hosted_invoice_url: string | null; expires_at: string | null; change_id?: string | null }

export interface BillingState {
  workspace_id: string;
  enforced: boolean;
  plan: WorkspacePlan;
  /** the plan whose features apply (Scale during the trial; the last plan while suspended / cancelled) */
  feature_plan: PlanId;
  read_only: boolean;
  is_owner: boolean;
  features?: Record<string, { enabled: boolean; limit: number | null; min_plan: PlanId | null }>;
  /** set for a client viewer whose agency's plan has no client access */
  access_blocked?: 'client_viewer_plan' | null;
  accounts?: AccountSlots;
  trial?: { ends_at: string | null; account_limit: number; days_left: number | null };
  past_due?: boolean;
  past_due_since?: string | null;
  cancel_at_period_end?: boolean;
  current_period_end?: string | null;
  data_delete_after?: string | null;
  paused_over_limit?: Array<{ sender_id: string; name: string | null }>;
  // owner only
  billing_period?: BillingPeriod | null;
  accounts_requested?: number | null;
  accounts_billed?: number | null;
  current_period_start?: string | null;
  cancelled_at?: string | null;
  scheduled_change?: ScheduledChange | null;
  pending_payment?: PendingPayment | null;
  stripe_status?: string | null;
  has_customer?: boolean;
  has_subscription?: boolean;
  comp?: boolean;
  price_version?: string;
  custom_price?: boolean;
  plan_before_suspension?: string | null;
  disputed?: boolean;
  early_supporter?: { tier: number | null; discount: number } | null;
  quote_current?: { per_account: number; period_total: number; billed: number; months: number } | null;
}

export const billingKey = (ws: string) => ['outreach', ws, 'billing'] as const;

/** Billing state of a workspace. Members see the account meter and features; the owner also sees the subscription. */
export function useBilling(ws: string | null | undefined) {
  return useQuery({
    queryKey: billingKey(ws ?? ''), enabled: !!ws, staleTime: 30_000, refetchOnWindowFocus: true,
    queryFn: () => rpc<BillingState>('billing_state', { p_ws: ws! }),
  });
}

/** Refresh billing after something that changes it (a connect, a disable, a plan change). */
export function useInvalidateBilling() {
  const qc = useQueryClient();
  return (ws: string | null | undefined) => { if (ws) qc.invalidateQueries({ queryKey: billingKey(ws) }); };
}

export interface FeatureAccess {
  /** true while loading, so nothing flashes as locked */
  enabled: boolean;
  limit: number | null;
  /** the cheapest plan that includes the feature */
  minPlan: PlanId | null;
  minPlanLabel: string;
  /** link to the change screen with that plan selected */
  upgradeHref: string;
  loading: boolean;
}

/** Is a plan feature on for this workspace? Use it to show a small plan tag and an upgrade link on locked features (PRD §11.3). */
export function usePlanFeature(ws: string | null | undefined, key: FeatureKey): FeatureAccess {
  const b = useBilling(ws);
  const f = b.data?.features?.[key];
  let minPlan = (f?.min_plan ?? pricing.planFor(key)) as PlanId | null;
  // a counted feature (website inboxes) is "on" on every plan: the upgrade that helps is the next plan with a higher limit
  if (f?.enabled !== false && f?.limit != null && b.data) {
    const cur = pricing.planRank(b.data.feature_plan);
    const next = [...pricing.book.plans].sort((x, y) => x.rank - y.rank).find((p) => { const l = pricing.feature(p.id, key).limit; return p.rank > cur && (l == null || l > f.limit!); });
    minPlan = next?.id ?? minPlan;
  }
  return {
    enabled: b.data ? f?.enabled !== false : true, limit: f?.limit ?? null, minPlan,
    minPlanLabel: minPlan ? planLabel(minPlan) : '', upgradeHref: changeHref({ plan: minPlan ?? undefined }), loading: b.isLoading,
  };
}

/** The change screen, optionally pre-set (e.g. +1 account from the Connect button, or a plan from a locked feature). */
export function changeHref(preset: { plan?: PlanId; accounts?: number; period?: BillingPeriod } = {}): string {
  const q = new URLSearchParams();
  if (preset.plan) q.set('plan', preset.plan);
  if (preset.accounts) q.set('accounts', String(preset.accounts));
  if (preset.period) q.set('period', preset.period);
  const s = q.toString();
  return `/outreach/billing/change${s ? `?${s}` : ''}`;
}

/** "7 of 10 accounts" for the senders meter; null when nothing is limited. */
export function accountsMeter(a: AccountSlots | undefined): { text: string; used: number; billed: number; full: boolean; pct: number } | null {
  if (!a || a.billed == null) return null;
  const full = (a.available ?? 0) < 1;
  return { text: `${a.used} of ${a.billed} account${a.billed === 1 ? '' : 's'}`, used: a.used, billed: a.billed, full, pct: a.billed > 0 ? Math.min(100, Math.round((a.used / a.billed) * 100)) : 100 };
}

/**
 * What one more account costs today, for the "Add an account — $X today" button. An estimate from the price book (same
 * billing period, time left in it); the change screen shows the server's exact figure before anything is charged.
 */
export function addAccountEstimate(b: BillingState | undefined): { accounts: number; cents: number | null } | null {
  if (!b || !isPaidPlan(b.plan) || !b.billing_period || !b.accounts_billed || b.custom_price) return null;
  const want = b.accounts_billed + 1;
  if (want > pricing.book.max_self_serve_accounts) return { accounts: want, cents: null };
  const q = pricing.quote(b.plan, b.billing_period, want);
  const start = b.current_period_start ? new Date(b.current_period_start).getTime() : NaN, end = b.current_period_end ? new Date(b.current_period_end).getTime() : NaN;
  if (!(end > start)) return { accounts: q.billed, cents: null };
  const left = Math.min(Math.max((end - Date.now()) / (end - start), 0), 1);
  const diff = (q.period_total - pricing.rawTotal(b.plan, b.billing_period, b.accounts_billed)) * 100;
  const discount = b.early_supporter?.discount ?? 0;
  return { accounts: q.billed, cents: Math.max(Math.round((diff - Math.round(diff * discount)) * left), 0) };
}

// ---------------------------------------------------------------------------
// Owner actions (edge function outreach-billing)
// ---------------------------------------------------------------------------
export interface Quote {
  mode: 'checkout' | 'change';
  from?: { plan: PlanId; accounts: number; period: BillingPeriod };
  to: { plan: PlanId; accounts: number; period: BillingPeriod };
  immediate?: { plan: PlanId; accounts: number; period: BillingPeriod };
  final: { plan: PlanId; accounts: number; period: BillingPeriod };
  applies_now?: boolean;
  applies_at_renewal?: boolean;
  charge_today_cents: number;
  tax_today_cents?: number;
  tax_note?: string;
  lines?: Array<{ description: string; amount_cents: number; proration: boolean }>;
  proration_note?: string | null;
  per_account: number | null;
  months: number;
  next_invoice: { at: string; cents: number | null; list_cents: number | null };
  later_at?: string | null;
  now_changes: string[];
  later_changes: string[];
  best_price: { requested: number; billed: number; requested_total_cents: number; billed_total_cents: number; note: string } | null;
  early_supporter: { discount: number; saves_cents?: number } | null;
  effects?: Array<{ feature: string; count: number; text: string }>;
  senders_to_pause?: Array<{ sender_id: string; name: string | null; provider: string; status: string; activity_14d: number; keep: boolean; action: 'keep' | 'pause' | 'disconnect' }>;
  resumes_subscription?: boolean;
  replaces_scheduled?: boolean;
  price_version_change?: { from: string; to: string } | null;
  non_refundable: true;
}
export interface QuoteResponse { quote_id: string; expires_at: string; quote: Quote; has_subscription: boolean }
export interface ChangeResponse { status: 'applied' | 'scheduled' | 'requires_action'; client_secret?: string | null; hosted_invoice_url?: string | null; charged_cents?: number; effective_at?: string | null; state: BillingState }

export const CANCEL_REASONS: Array<{ value: string; label: string }> = [
  { value: 'too_expensive', label: 'It costs too much' },
  { value: 'missing_feature', label: 'It’s missing something I need' },
  { value: 'switched_tool', label: 'I’m moving to another tool' },
  { value: 'not_using', label: 'I’m not using it enough' },
  { value: 'technical_issues', label: 'Too many problems' },
  { value: 'temporary', label: 'I only need a break' },
  { value: 'other', label: 'Something else' },
];

export const billingApi = {
  quote: (ws: string, target: { plan: PlanId; accounts: number; period: BillingPeriod }, keep?: string[] | null) =>
    callFn<QuoteResponse>('billing', { action: 'quote', workspace_id: ws, ...target, keep_sender_ids: keep ?? undefined }),
  change: (ws: string, quoteId: string, keep?: string[] | null) => callFn<ChangeResponse>('billing', { action: 'change', workspace_id: ws, quote_id: quoteId, keep_sender_ids: keep ?? undefined }),
  checkout: (ws: string, quoteId: string) => callFn<{ url: string }>('billing', { action: 'checkout', workspace_id: ws, quote_id: quoteId }),
  cancelScheduled: (ws: string) => callFn<{ ok: true; state: BillingState }>('billing', { action: 'cancel_scheduled_change', workspace_id: ws }),
  cancel: (ws: string, reason: string, comment: string) => callFn<{ ok: true; access_until: string | null; state: BillingState }>('billing', { action: 'cancel', workspace_id: ws, reason, comment }),
  resume: (ws: string) => callFn<{ ok: true; state: BillingState }>('billing', { action: 'resume', workspace_id: ws }),
  portal: (ws: string) => callFn<{ url: string }>('billing', { action: 'portal', workspace_id: ws }),
  payNow: (ws: string) => callFn<{ url: string | null; amount_due_cents: number | null }>('billing', { action: 'pay_now', workspace_id: ws }),
  abandonPayment: (ws: string) => callFn<{ ok: true; state: BillingState }>('billing', { action: 'abandon_payment', workspace_id: ws }),
  sync: (ws: string) => callFn<{ ok: true; state: BillingState }>('billing', { action: 'sync', workspace_id: ws }),
};

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------
export const periodLabel = (p: BillingPeriod | null | undefined): string => (p ? pricing.periodById(p).label : '');
export const periodNoun = (p: BillingPeriod | null | undefined): string => (p === 'annual' ? 'year' : p === 'quarterly' ? 'quarter' : 'month');
export const money = formatUsd;

/** "Scale · 10 accounts · Monthly" */
export function planLine(plan: string | null | undefined, accounts: number | null | undefined, period: BillingPeriod | null | undefined): string {
  return [planLabel(plan), accounts != null ? `${accounts} account${accounts === 1 ? '' : 's'}` : null, period ? periodLabel(period) : null].filter(Boolean).join(' · ');
}

export function longDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Why a sender is not connected, for billing reasons (status_reason values written by billing v2). */
export function billingReasonText(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'over_plan_limit': return 'Paused: the plan has fewer accounts than are connected';
    case 'billing_suspended': return 'Paused until the open invoice is paid';
    case 'billing_cancelled': return 'Paused: the subscription has ended';
    case 'trial_expired': return 'The trial ended';
    case 'user_disconnected': return 'Disconnected by a teammate';
    case 'NO_FREE_ACCOUNT': return 'No free account on the plan when the sign-in finished. Add an account and connect again';
    case 'RECONNECT_WRONG_ACCOUNT': return 'A different account signed in. Reconnect with the account this sender had, or connect the other one as a new sender';
    default: return null;
  }
}

/** Stripe.js, loaded only when a payment needs the bank's confirmation (3-D Secure). */
export async function confirmWithBank(clientSecret: string): Promise<{ ok: boolean; error?: string }> {
  const pk = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!pk) return { ok: false, error: 'no_publishable_key' };
  const w = window as unknown as { Stripe?: (key: string) => { handleNextAction: (o: { clientSecret: string }) => Promise<{ error?: { message?: string }; paymentIntent?: { status: string } }> } };
  if (!w.Stripe) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/'; s.async = true;
      s.onload = () => resolve(); s.onerror = () => reject(new Error('Stripe.js could not be loaded'));
      document.head.appendChild(s);
    });
  }
  if (!w.Stripe) return { ok: false, error: 'Stripe.js could not be loaded' };
  const r = await w.Stripe(pk).handleNextAction({ clientSecret });
  if (r.error) return { ok: false, error: r.error.message ?? 'The payment was not confirmed' };
  return { ok: true };
}

/** Where "Talk to us" goes (plans above the self-serve limit, custom agreements). */
export const TALK_TO_US_URL = process.env.NEXT_PUBLIC_OUTREACH_SALES_URL || 'https://growthxai.com/demo/';

/** A value that only changes once it has stopped changing for `ms` (the change screen asks for a quote when the controls settle). */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
