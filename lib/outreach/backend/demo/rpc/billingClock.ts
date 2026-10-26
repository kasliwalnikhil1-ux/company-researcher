/**
 * Demo handlers: the payment-failure clock (sender-lifecycle-PRD v1.2 §5.9). The tour's workspace is active, so the clock
 * is quiet; the shape matches outreach_billing_clock so the Billing page and the shell banners render the same.
 * Owns: billing_clock, billing_emails_set
 */
import { demoError, type RpcArea } from '../ctx';
import type { DemoStore, Row } from '../store';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DAY = 86_400_000;

function ws(store: DemoStore, id: string): Row {
  const w = store.get('outreach_workspaces', id);
  if (!w || w.deleted_at) demoError('E_NOT_FOUND', 'workspace');
  return w;
}

/** trialing · active · past_due · suspended · canceled · trial_expired, derived from the plan the way the database trigger does. */
export function billingStatusOf(w: Row): string {
  if (w.plan === 'suspended') return 'suspended';
  if (w.plan === 'cancelled') return 'canceled';
  if (w.plan === 'trial_expired') return 'trial_expired';
  if (['past_due', 'unpaid'].includes(String(w.stripe_status ?? '')) && w.past_due_since) return 'past_due';
  if (w.plan === 'trial') return 'trialing';
  return 'active';
}

export const billingClockRpc = {
  billing_clock: (a, ctx) => {
    const id = String(a.p_ws ?? '');
    const w = ws(ctx.store, id);
    const m = ctx.store.t('outreach_members').find((x) => x.workspace_id === id && x.user_id === ctx.userId);
    if (!m) demoError('E_FORBIDDEN', 'not a member of workspace');
    const owner = m.role === 'owner';
    const status = billingStatusOf(w);
    const base = status === 'past_due' || status === 'suspended' ? (w.past_due_since ? Date.parse(w.past_due_since) : null) : status === 'canceled' && w.cancelled_at ? Date.parse(w.cancelled_at) : null;
    const steps = base == null ? [] : status === 'canceled'
      ? [{ step: 'erase', label: 'Workspace data deleted', at: w.data_delete_after ?? new Date(base + 60 * DAY).toISOString(), done: false }]
      : [
        { step: 'suspend', label: 'Sending stops, workspace read-only', at: new Date(base + 7 * DAY).toISOString(), done: status === 'suspended' },
        { step: 'remove', label: 'Connected accounts disconnected (history kept)', at: new Date(base + 21 * DAY).toISOString(), done: false },
        { step: 'erase', label: 'Workspace data deleted', at: new Date(base + 67 * DAY).toISOString(), done: false },
      ];
    const ownerRow = ctx.store.t('outreach_members').filter((x) => x.workspace_id === id && x.role === 'owner').sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))[0];
    return {
      billing_status: status, plan: w.plan, plan_before_suspension: w.plan_before_suspension ?? null, past_due_since: w.past_due_since ?? null, suspended_at: w.suspended_at ?? null,
      cancelled_at: w.cancelled_at ?? null, cancel_at_period_end: !!w.cancel_at_period_end, current_period_end: w.current_period_end ?? null, data_delete_after: w.data_delete_after ?? null,
      day: base == null ? null : Math.floor((Date.now() - base) / DAY), steps,
      billing_action_required: !!w.billing_action_required, overdue_invoice_url: owner ? w.overdue_invoice_url ?? null : null,
      billing_emails: owner ? (w.billing_emails ?? []) : null, read_only: ['suspended', 'canceled', 'trial_expired'].includes(status),
      owner_name: ownerRow?.display_name ?? null,
      removed_for_billing: ctx.store.t('outreach_senders').filter((s) => s.workspace_id === id && s.status === 'removed' && ['billing', 'canceled'].includes(String(s.removed_via))).length,
      paused_for_billing: ctx.store.t('outreach_senders').filter((s) => s.workspace_id === id && s.status === 'paused' && s.pause_reason === 'billing' && !s.deleted_at).length,
    };
  },

  billing_emails_set: (a, ctx) => {
    const id = String(a.p_ws ?? '');
    ws(ctx.store, id);
    const m = ctx.store.t('outreach_members').find((x) => x.workspace_id === id && x.user_id === ctx.userId);
    if (m?.role !== 'owner') demoError('E_FORBIDDEN', 'owner required');
    const raw = Array.isArray(a.p_emails) ? (a.p_emails as unknown[]) : [];
    if (raw.length > 5) demoError('E_PAYLOAD_INVALID', 'at most 5 extra billing contacts');
    const cleaned: string[] = [];
    for (const e of raw) {
      const em = String(e ?? '').trim().toLowerCase();
      if (!em) continue;
      if (!EMAIL_RE.test(em)) demoError('E_PAYLOAD_INVALID', `"${em}" is not an email address`);
      if (!cleaned.includes(em)) cleaned.push(em);
    }
    ctx.store.update('outreach_workspaces', id, { billing_emails: cleaned });
    return { billing_emails: cleaned };
  },
} satisfies RpcArea;
