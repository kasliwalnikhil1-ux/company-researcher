'use client';

import { Fragment, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { Avatar, Badge, Button, Input, Modal, Select, Spinner, Table, Th, Td, ErrorBox, timeAgo } from '@/components/outreach/ui';
import {
  adminApi, describeDetails, EARLY_SUPPORTER_DISCOUNTS, OUTREACH_BILLING_PERIODS, OUTREACH_PLANS, OUTREACH_ROLES,
  type AdminBillingChange, type AdminBillingSlots, type AdminBillingStateSnapshot, type AdminWorkspace, type AdminWorkspacePatch,
  type EarlySupporterDiscount, type OutreachBillingPeriod, type OutreachPlan, type OutreachRole, type OutreachSettablePlan,
} from '@/lib/platform/admin';
import { longDate, money, planLabel, planLine } from '@/lib/outreach/billing';
import { AccountPicker, ConfirmModal, Drawer, KV, Section, WsPlanBadge, errMsg, fmtDay, fmtNum, toDateInput, useAdminToast, useDebounced } from './shared';

const PERIOD_LABEL: Record<OutreachBillingPeriod, string> = { monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual' };
const PAID_PLANS = ['launch', 'scale', 'enterprise'];
/** Plans on which the workspace is read-only and its senders are paused or disconnected. */
const INACTIVE_PLANS = ['suspended', 'cancelled', 'trial_expired'];
const isSettablePlan = (p: string): p is OutreachSettablePlan => (OUTREACH_PLANS as string[]).includes(p);
const percent = (d: number | null | undefined) => `${Math.round(Number(d ?? 0) * 100)}%`;

/** '' = no limit (null); otherwise a whole number of 1 or more. undefined = not a valid entry. */
function parseAccounts(v: string): number | null | undefined {
  const t = v.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/** The account limit that applies to a workspace, counted the way the database does (outreach__slot_limit). null = no limit. */
function accountLimit(w: AdminWorkspace): number | null {
  if (w.plan === 'trial') return w.trial_account_limit ?? null;
  if (PAID_PLANS.includes(w.plan) || w.plan === 'suspended') return w.accounts_billed ?? null;
  return 0;
}

function fmtWhen(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Name, plan, trial end and the billing columns of one workspace. Only the keys that changed are sent, so an untouched
 * field is never rewritten. Mounted per workspace (keyed on its id by the caller), so the form starts from the saved values.
 */
function EditWorkspaceModal({ w, onClose, onSaved }: { w: AdminWorkspace; onClose: () => void; onSaved: () => void }) {
  const toast = useAdminToast();
  const savedDiscount = Number(w.early_supporter_discount ?? 0);
  const [name, setName] = useState(w.name);
  const [plan, setPlan] = useState<OutreachPlan>(w.plan);
  const [trial, setTrial] = useState(toDateInput(w.trial_ends_at));
  const [accounts, setAccounts] = useState(w.accounts_billed == null ? '' : String(w.accounts_billed));
  const [period, setPeriod] = useState<OutreachBillingPeriod | ''>(w.billing_period ?? '');
  const [priceId, setPriceId] = useState(w.custom_price_id ?? '');
  const [discount, setDiscount] = useState(String(savedDiscount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acc = parseAccounts(accounts);
  const price = priceId.trim();
  const priceOk = !price || /^price_[A-Za-z0-9]+$/.test(price);

  const patch: AdminWorkspacePatch = {};
  if (name.trim() && name.trim() !== w.name) patch.name = name.trim();
  if (plan !== w.plan && isSettablePlan(plan)) patch.plan = plan;
  if (trial && trial !== toDateInput(w.trial_ends_at)) patch.trial_ends_at = new Date(trial + 'T00:00:00Z').toISOString();
  if (acc !== undefined && acc !== (w.accounts_billed ?? null)) patch.accounts_billed = acc;
  if ((period || null) !== (w.billing_period ?? null)) patch.billing_period = period || null;
  if (priceOk && (price || null) !== (w.custom_price_id ?? null)) patch.custom_price_id = price || null;
  if (Number(discount) !== savedDiscount) patch.early_supporter_discount = Number(discount) as EarlySupporterDiscount;
  const dirty = Object.keys(patch).length > 0;
  const valid = !!name.trim() && acc !== undefined && priceOk;

  const suspending = plan === 'suspended' && w.plan !== 'suspended';
  const reactivating = INACTIVE_PLANS.includes(w.plan) && plan !== w.plan && plan !== 'suspended';
  const makesComp = patch.plan !== undefined && PAID_PLANS.includes(patch.plan) && !w.has_subscription;

  return (
    <Modal open onClose={onClose} title={`Edit ${w.name}`} size="md" footer={<>
      <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button variant={suspending ? 'danger' : 'primary'} loading={busy} disabled={!dirty || !valid} onClick={async () => {
        setBusy(true); setError(null);
        try {
          await adminApi.setWorkspace(w.id, patch);
          toast('Workspace updated'); onSaved(); onClose();
        } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
      }}>{suspending ? 'Suspend workspace' : 'Save'}</Button>
    </>}>
      <div className="space-y-3">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} error={name.trim() ? undefined : 'A name is required.'} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label="Plan" value={plan} onChange={(e) => setPlan(e.target.value as OutreachPlan)}>
            {!isSettablePlan(w.plan) && <option value={w.plan} disabled>{planLabel(w.plan)} (now)</option>}
            {OUTREACH_PLANS.map((p) => <option key={p} value={p}>{planLabel(p)}</option>)}
          </Select>
          <Input label="Trial ends" type="date" value={trial} onChange={(e) => setTrial(e.target.value)} hint="Only matters on a trial. A later date on a trial that ended makes it a trial again." />
        </div>

        <div className="pt-3 border-t border-gray-100">
          <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Billing</div>
          {w.has_subscription && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">This workspace is billed through Stripe{w.stripe_status ? ` (${w.stripe_status})` : ''}. Its plan, accounts and period follow the subscription, so changes to them here are refused. Suspending still works.</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Accounts" type="number" min={1} step={1} inputMode="numeric" value={accounts} onChange={(e) => setAccounts(e.target.value)} placeholder="No limit"
              error={acc === undefined ? 'Enter a whole number of 1 or more, or leave it empty.' : undefined}
              hint={`Empty means no limit. ${fmtNum(w.accounts_used)} connected now${w.plan === 'trial' ? `; a trial is limited to ${fmtNum(w.trial_account_limit)} whatever is set here` : ''}.`} />
            <Select label="Billing period" value={period} onChange={(e) => setPeriod(e.target.value as OutreachBillingPeriod | '')}>
              <option value="">Not set</option>
              {OUTREACH_BILLING_PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}
            </Select>
            <Input label="Custom Enterprise price id" value={priceId} onChange={(e) => setPriceId(e.target.value)} placeholder="price_…" className="font-mono"
              error={priceOk ? undefined : 'A Stripe price id looks like price_…'} hint="A Stripe price made for this workspace. Empty uses the price book." />
            <Select label="Early-supporter discount" value={discount} onChange={(e) => setDiscount(e.target.value)}>
              {EARLY_SUPPORTER_DISCOUNTS.map((d) => <option key={d} value={String(d)}>{d === 0 ? 'None' : percent(d)}</option>)}
            </Select>
          </div>
        </div>

        {makesComp && <p className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">A paid plan set here makes this a comp workspace: no Stripe subscription and nothing is charged. Set the accounts it may connect, or leave them empty for no limit.</p>}
        {suspending && <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">Suspending pauses every connected sender and blocks all writes for the members of this workspace until you set a plan again. Sequences resume on their own afterwards.</p>}
        {reactivating && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">Paused senders will be resumed. Accounts that were disconnected stay disconnected until someone reconnects them.</p>}
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

// ─── billing history ─────────────────────────────────────────────────
const CHANGE_KIND: Record<string, string> = { change: 'Change', checkout: 'Subscribed', cancel: 'Cancel', resume: 'Cancellation undone', cancel_scheduled: 'Scheduled change dropped', admin: 'Set by admin' };
const CHANGE_STATUS: Record<string, { label: string; tone: 'gray' | 'green' | 'red' | 'amber' | 'blue' }> = {
  applied: { label: 'applied', tone: 'green' }, scheduled: { label: 'scheduled', tone: 'blue' }, pending_payment: { label: 'payment pending', tone: 'amber' },
  failed: { label: 'failed', tone: 'red' }, cancelled: { label: 'cancelled', tone: 'gray' },
};

/** "Scale · 10 accounts · Monthly" from a stored state (self-serve rows say `accounts`, admin rows `accounts_billed`). */
function stateText(s: AdminBillingStateSnapshot | null | undefined): string {
  if (!s) return '—';
  const line = planLine(s.plan, s.accounts_billed ?? s.accounts ?? null, s.billing_period ?? s.period ?? null);
  return (line || '—') + (s.cancel ? ' · cancelling' : '');
}

/** The line under "from → to": what applied now and what waits for renewal, or what the admin changed. */
function changeNote(c: AdminBillingChange): string {
  if (c.kind === 'admin') {
    const simple = Object.entries(c.quote?.admin ?? {}).filter(([, v]) => v === null || typeof v !== 'object' || 'from' in v || 'to' in v);
    return describeDetails(Object.fromEntries(simple));
  }
  if (c.kind === 'cancel_scheduled') return c.scheduled ? `Dropped: ${stateText(c.scheduled)}` : '';
  return [c.immediate ? `Now: ${stateText(c.immediate)}` : null, c.scheduled ? `At renewal: ${stateText(c.scheduled)}` : null].filter(Boolean).join(' · ');
}

function slotsLine(s: AdminBillingSlots): string {
  const parts = [s.billed == null ? `${s.used} account${s.used === 1 ? '' : 's'} connected, no limit` : `${s.used} of ${s.billed} account${s.billed === 1 ? '' : 's'} used`];
  if (s.reserved > 0) parts.push(`${s.reserved} held by open sign-in links`);
  if (s.available != null) parts.push(`${s.available} free`);
  if (s.over_limit > 0) parts.push(`${s.over_limit} paused over the limit`);
  return parts.join(' · ');
}

/** Plan changes, Stripe events and the account slots of one workspace (platform_admin_outreach_billing). Read-only. */
function BillingHistoryDrawer({ w, onClose }: { w: AdminWorkspace; onClose: () => void }) {
  const q = useQuery({ queryKey: ['admin', 'workspace-billing', w.id], queryFn: () => adminApi.outreachBilling(w.id) });
  const b = q.data;
  const es = b?.early_supporter;
  return (
    <Drawer open onClose={onClose} title={`Billing history: ${w.name}`} subtitle={planLine(w.plan, w.accounts_billed, w.billing_period) || undefined}>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox message={errMsg(q.error)} />}
      {b && (
        <>
          <Section title="Accounts and subscription">
            <p className="text-sm text-gray-900">{slotsLine(b.slots)}</p>
            <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
              <KV label="Billing">{w.has_subscription ? `Stripe${w.stripe_status ? ` (${w.stripe_status})` : ''}` : w.billing_comp ? 'Comp, set by an admin' : 'No subscription'}</KV>
              <KV label={w.cancel_at_period_end ? 'Ends' : 'Renews'}>{longDate(w.current_period_end) || '—'}</KV>
              <KV label="Early supporter">{es ? `#${es.position} · tier ${es.tier} · ${percent(es.discount)}${es.forfeited_at ? ` · forfeited ${longDate(es.forfeited_at)}` : ''}` : Number(w.early_supporter_discount ?? 0) > 0 ? percent(w.early_supporter_discount) : '—'}</KV>
              <KV label="Stripe customer"><span className="font-mono text-xs">{w.stripe_customer_id ?? '—'}</span></KV>
              <KV label="Stripe subscription"><span className="font-mono text-xs">{w.stripe_subscription_id ?? '—'}</span></KV>
              <KV label="Custom price"><span className="font-mono text-xs">{w.custom_price_id ?? '—'}</span></KV>
            </dl>
          </Section>

          <Section title="Plan changes" description="Newest first. Quotes that were never confirmed are left out.">
            {b.changes.length === 0 ? <p className="text-sm text-gray-500">No plan changes yet.</p> : (
              <Table>
                <thead><tr><Th>When</Th><Th>Kind</Th><Th>From → to</Th><Th className="text-right">Charged</Th><Th>Status</Th><Th>By</Th></tr></thead>
                <tbody>
                  {b.changes.map((c) => {
                    const note = changeNote(c);
                    const st = CHANGE_STATUS[c.status] ?? { label: c.status, tone: 'gray' as const };
                    const cents = c.quote?.charge_today_cents;
                    const charged = c.status === 'applied' || c.status === 'scheduled';
                    return (
                      <tr key={c.id}>
                        <Td className="whitespace-nowrap text-xs align-top">{fmtWhen(c.created_at)}</Td>
                        <Td className="align-top">{CHANGE_KIND[c.kind] ?? c.kind}</Td>
                        <Td className="align-top">
                          <div className="text-gray-900">{stateText(c.from_state)} → {stateText(c.to_state)}</div>
                          {note && <div className="text-xs text-gray-500 break-words">{note}</div>}
                          {c.error && <div className="text-xs text-rose-600 break-words">{c.error}</div>}
                        </Td>
                        <Td className="text-right tabular-nums whitespace-nowrap align-top">
                          {typeof cents === 'number' ? <span className={charged ? '' : 'text-gray-400'} title={charged ? undefined : 'Quoted; this amount was not charged'}>{money(cents)}</span> : <span className="text-gray-400">—</span>}
                          {c.stripe_invoice_id && <div className="text-[11px] text-gray-400 font-mono">{c.stripe_invoice_id}</div>}
                        </Td>
                        <Td className="align-top"><span title={c.applied_at ? `Applied ${fmtWhen(c.applied_at)}` : undefined}><Badge tone={st.tone}>{st.label}</Badge></span></Td>
                        <Td className="text-xs align-top">{c.requested_by_email ?? <span className="text-gray-400">—</span>}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Section>

          <Section title="Stripe events" description="Newest first.">
            {b.events.length === 0 ? <p className="text-sm text-gray-500">No Stripe events for this workspace.</p> : (
              <Table>
                <thead><tr><Th>Type</Th><Th>Received</Th><Th>Processed</Th></tr></thead>
                <tbody>
                  {b.events.map((e) => (
                    <tr key={e.id}>
                      <Td className="align-top"><div className="font-mono text-xs text-gray-900">{e.type}</div><div className="font-mono text-[11px] text-gray-400">{e.id}</div></Td>
                      <Td className="whitespace-nowrap text-xs align-top">{fmtWhen(e.received_at)}</Td>
                      <Td className="text-xs align-top">{e.error ? <span className="text-rose-600 break-words">{e.error}</span> : e.processed_at ? <span className="whitespace-nowrap">{fmtWhen(e.processed_at)}</span> : <span className="text-amber-700">not processed yet</span>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
        </>
      )}
    </Drawer>
  );
}

function MembersPanel({ w, onOpenUser, onChanged }: { w: AdminWorkspace; onOpenUser: (id: string) => void; onChanged: () => void }) {
  const toast = useAdminToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pickRole, setPickRole] = useState<OutreachRole>('member');
  const [removing, setRemoving] = useState<{ id: string; email: string | null } | null>(null);
  const act = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); toast(label); onChanged(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  };
  return (
    <div className="bg-gray-50 border-t border-gray-200 px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Members</div>
        <div className="flex items-center gap-2">
          {adding && <Select value={pickRole} onChange={(e) => setPickRole(e.target.value as OutreachRole)} className="w-auto py-1">{OUTREACH_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</Select>}
          <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>{adding ? 'Cancel' : 'Add member'}</Button>
        </div>
      </div>
      {adding && (
        <div className="mb-3 max-w-md">
          <AccountPicker autoFocus exclude={w.members.map((m) => m.user_id)} onPick={(u) => act('add', `${u.email} added as ${pickRole}`, async () => { await adminApi.setWorkspaceMember(w.id, u.id, pickRole); setAdding(false); })} />
        </div>
      )}
      <div className="grid gap-1.5">
        {w.members.map((m) => (
          <div key={m.user_id} className="flex flex-wrap items-center gap-2 text-sm bg-white border border-gray-200 rounded-lg px-3 py-1.5">
            <Avatar name={m.email ?? m.user_id} size={6} />
            <button type="button" className="text-gray-900 hover:underline truncate max-w-[260px]" onClick={() => onOpenUser(m.user_id)}>{m.email ?? m.user_id}</button>
            <Select value={m.role} onChange={(e) => act(m.user_id, 'Role updated', () => adminApi.setWorkspaceMember(w.id, m.user_id, e.target.value as OutreachRole))} className="w-auto py-1 text-xs">{OUTREACH_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
            {m.client_ids.length > 0 && <Badge tone="gray">{m.client_ids.length} client{m.client_ids.length === 1 ? '' : 's'}</Badge>}
            {!m.can_reply && <Badge tone="amber">no reply</Badge>}
            <Button size="sm" variant="ghost" className="ml-auto" loading={busy === m.user_id + 'rm'} onClick={() => setRemoving({ id: m.user_id, email: m.email })}>Remove</Button>
          </div>
        ))}
      </div>
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} title="Remove from workspace?" confirmLabel="Remove" danger
        message={<>{removing?.email ?? removing?.id} loses access to <b>{w.name}</b>. Leads, chats and sequences stay with the workspace.</>}
        onConfirm={() => act((removing?.id ?? '') + 'rm', 'Member removed', () => adminApi.setWorkspaceMember(w.id, removing!.id, null))} />
    </div>
  );
}

export default function OutreachTab({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const dsearch = useDebounced(search);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<AdminWorkspace | null>(null);
  const [history, setHistory] = useState<AdminWorkspace | null>(null);
  const q = useQuery({ queryKey: ['admin', 'workspaces', dsearch, includeDeleted], queryFn: () => adminApi.workspaces(dsearch, includeDeleted), placeholderData: (p) => p });
  const rows = q.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const byPlan = rows.reduce<Record<string, number>>((acc, w) => { acc[w.plan] = (acc[w.plan] ?? 0) + 1; return acc; }, {});

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by workspace, slug, member email or id…" className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-gray-600"><input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />Show deleted</label>
        <Button variant="secondary" onClick={refresh}><RefreshCw className={`w-4 h-4 ${q.isFetching ? 'animate-spin' : ''}`} /></Button>
      </div>

      <div className="flex flex-wrap gap-2 text-sm text-gray-600">
        <span>{fmtNum(rows.length)} workspace{rows.length === 1 ? '' : 's'}</span>
        {Object.entries(byPlan).map(([p, n]) => <span key={p} className="inline-flex items-center gap-1"><WsPlanBadge plan={p} /> {n}</span>)}
      </div>

      {q.error && <ErrorBox message={errMsg(q.error)} />}

      <Table>
        <thead><tr><Th className="w-8" /><Th>Workspace</Th><Th>Owner</Th><Th>Plan</Th><Th className="text-right" title="Accounts connected / accounts the plan allows. ∞ means no limit; a trial shows its trial limit.">Accounts</Th><Th>Trial ends</Th><Th className="text-right">Senders</Th><Th className="text-right">Leads</Th><Th className="text-right">Sequences</Th><Th className="text-right" title="Automated actions in the last 7 days">7d actions</Th><Th>Created</Th><Th /></tr></thead>
        <tbody>
          {q.isLoading && <tr><Td colSpan={12} className="text-center text-gray-500 py-8">Loading…</Td></tr>}
          {!q.isLoading && rows.length === 0 && <tr><Td colSpan={12} className="text-center text-gray-500 py-8">No workspaces.</Td></tr>}
          {rows.map((w) => {
            const isOpen = open.has(w.id);
            const limit = accountLimit(w);
            const used = w.accounts_used ?? 0;
            const discount = Number(w.early_supporter_discount ?? 0);
            const sc = w.scheduled_change;
            return (
              <Fragment key={w.id}>
                <tr className={`hover:bg-gray-50 ${w.deleted_at ? 'opacity-50' : ''}`}>
                  <Td><button type="button" className="p-1 rounded hover:bg-gray-100" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(w.id)) n.delete(w.id); else n.add(w.id); return n; })} aria-label="Members">{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></Td>
                  <Td><div className="font-medium text-gray-900">{w.name}</div><div className="text-xs text-gray-400 font-mono">{w.slug}{w.deleted_at ? ' · deleted' : ''}</div></Td>
                  <Td>{w.owner_email ? <button type="button" className="hover:underline" onClick={() => { const o = w.members.find((m) => m.role === 'owner'); if (o) onOpenUser(o.user_id); }}>{w.owner_email}</button> : <span className="text-gray-400">—</span>}<div className="text-xs text-gray-400">{w.members.length} member{w.members.length === 1 ? '' : 's'} · {w.clients} client{w.clients === 1 ? '' : 's'}</div></Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      <WsPlanBadge plan={w.plan} />
                      {w.billing_comp && <span title="Plan set by an admin. No Stripe subscription."><Badge tone="pink">comp</Badge></span>}
                      {w.has_subscription && <span title="Billed through a live Stripe subscription"><Badge tone="green">Stripe</Badge></span>}
                    </div>
                    {w.billing_period && <div className="text-xs text-gray-500">{PERIOD_LABEL[w.billing_period] ?? w.billing_period}{w.has_subscription && w.current_period_end && !w.cancel_at_period_end ? ` · renews ${longDate(w.current_period_end)}` : ''}</div>}
                    {w.stripe_status && <div className="text-xs text-gray-400">stripe {w.stripe_status}</div>}
                    {w.plan === 'suspended' && w.plan_before_suspension && <div className="text-xs text-gray-400">was {planLabel(w.plan_before_suspension)}</div>}
                    {discount > 0 && <div className="text-xs text-emerald-700">early supporter −{percent(discount)}{w.early_supporter_position != null ? ` · #${w.early_supporter_position}` : ''}</div>}
                    {w.custom_price_id && <div className="text-xs text-gray-400" title={w.custom_price_id}>custom price</div>}
                    {w.cancel_at_period_end && <div className="text-xs text-amber-700">cancels {longDate(w.current_period_end) || 'at the end of the period'}</div>}
                    {sc && <div className="text-xs text-blue-700">scheduled: {planLine(sc.plan ?? w.plan, sc.accounts_billed, sc.billing_period) || 'a change'}{sc.effective_at ?? w.current_period_end ? ` on ${longDate(sc.effective_at ?? w.current_period_end)}` : ''}</div>}
                    {w.data_delete_after && <div className="text-xs text-rose-600">data deleted after {longDate(w.data_delete_after)}</div>}
                  </Td>
                  <Td className="text-right tabular-nums whitespace-nowrap">
                    <span className={limit != null && used > limit ? 'text-rose-600 font-medium' : ''}>{fmtNum(used)} / {limit == null ? '∞' : fmtNum(limit)}</span>
                    {w.accounts_requested != null && w.accounts_requested !== w.accounts_billed && <div className="text-xs text-gray-400">asked for {fmtNum(w.accounts_requested)}</div>}
                  </Td>
                  <Td className="whitespace-nowrap">{w.plan === 'trial' || w.plan === 'trial_expired' ? <span className={new Date(w.trial_ends_at) < new Date() ? 'text-rose-600' : ''}>{fmtDay(w.trial_ends_at)}</span> : <span className="text-gray-400">—</span>}</Td>
                  <Td className="text-right tabular-nums">{w.senders_ok}/{w.senders}</Td>
                  <Td className="text-right tabular-nums">{fmtNum(w.leads)}</Td>
                  <Td className="text-right tabular-nums">{fmtNum(w.sequences)}</Td>
                  <Td className="text-right tabular-nums">{fmtNum(w.actions_7d)}</Td>
                  <Td className="text-gray-500 whitespace-nowrap">{timeAgo(w.created_at)}</Td>
                  <Td className="text-right"><div className="flex justify-end gap-1.5"><Button size="sm" variant="ghost" onClick={() => setHistory(w)}>Billing history</Button><Button size="sm" variant="secondary" onClick={() => setEditing(w)}>Edit</Button></div></Td>
                </tr>
                {isOpen && <tr><td colSpan={12} className="p-0"><MembersPanel w={w} onOpenUser={onOpenUser} onChanged={refresh} /></td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </Table>

      {editing && <EditWorkspaceModal key={editing.id} w={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {history && <BillingHistoryDrawer key={history.id} w={history} onClose={() => setHistory(null)} />}
    </div>
  );
}
