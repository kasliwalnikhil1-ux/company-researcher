'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff, Ban, KeyRound, Trash2, Plus, Minus } from 'lucide-react';
import { Badge, Button, Input, Select, Table, Th, Td, Textarea, fmtDate, ErrorBox, PageLoader } from '@/components/outreach/ui';
import { useAccess } from '@/contexts/AccessContext';
import { FEATURES } from '@/lib/platform/access';
import { adminApi, actionLabel, describeDetails, BILLING_CYCLES, BILLING_STATUSES, FUNDRAISING_PLANS, OUTREACH_PLANS, OUTREACH_ROLES, type AdminUserDetail, type OutreachPlan, type OutreachRole } from '@/lib/platform/admin';
import { AccessChips, ConfirmModal, CopyField, Drawer, KV, PlanBadge, Section, StatusBadge, TriState, WsPlanBadge, errMsg, fmtDay, fmtNum, toDateInput, useAdminToast } from './shared';

export default function UserDrawer({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['admin', 'user', userId], queryFn: () => adminApi.getUser(userId as string), enabled: !!userId });
  const u = q.data;
  return (
    <Drawer open={!!userId} onClose={onClose} title={u?.email ?? 'Account'} subtitle={u ? <span className="font-mono">{u.id}</span> : undefined}
      actions={u && (
        <div className="flex items-center gap-2">
          <StatusBadge status={u.status} banned={u.banned} />
          {u.is_admin && <Badge tone="purple">Admin</Badge>}
        </div>
      )}>
      {q.isLoading && <PageLoader className="min-h-[40vh]" />}
      {q.error && <ErrorBox message={errMsg(q.error)} />}
      {/* keyed by account so every section's form state starts fresh for a different account */}
      {u && <DrawerBody key={u.id} u={u} onClose={onClose} />}
    </Drawer>
  );
}

function DrawerBody({ u, onClose }: { u: AdminUserDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useAdminToast();
  const me = useAccess();
  const isSelf = u.id === me.access?.user_id;
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const run = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); toast(label); refresh(); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const [confirm, setConfirm] = useState<null | 'ban' | 'unban' | 'delete' | 'admin_on' | 'admin_off' | 'block'>(null);
  const [recovery, setRecovery] = useState<string | null>(null);

  return (
    <>
      {/* ── quick actions ── */}
      <div className="flex flex-wrap items-center gap-2">
        {u.status !== 'active' && <Button size="sm" onClick={() => run('Account approved', () => adminApi.setAccess(u.id, { status: 'active' }))}><ShieldCheck className="w-4 h-4" />Approve</Button>}
        {u.status === 'active' && !isSelf && !u.is_admin && <Button size="sm" variant="secondary" onClick={() => setConfirm('block')}><ShieldOff className="w-4 h-4" />Block</Button>}
        {u.status === 'blocked' && <Button size="sm" variant="secondary" onClick={() => run('Set to pending', () => adminApi.setAccess(u.id, { status: 'pending' }))}>Set pending</Button>}
        {!isSelf && (u.banned
          ? <Button size="sm" variant="secondary" onClick={() => setConfirm('unban')}><Ban className="w-4 h-4" />Lift sign-in ban</Button>
          : <Button size="sm" variant="secondary" onClick={() => setConfirm('ban')}><Ban className="w-4 h-4" />Ban sign-in</Button>)}
        <Button size="sm" variant="secondary" onClick={() => run('Recovery link ready', async () => { const r = await adminApi.recoveryLink(u.id); setRecovery(r.link); })}><KeyRound className="w-4 h-4" />Recovery link</Button>
        {!isSelf && (u.is_admin
          ? <Button size="sm" variant="secondary" onClick={() => setConfirm('admin_off')}>Remove admin</Button>
          : <Button size="sm" variant="secondary" onClick={() => setConfirm('admin_on')}>Make admin</Button>)}
        {!isSelf && !u.is_admin && <Button size="sm" variant="danger" className="ml-auto" onClick={() => setConfirm('delete')}><Trash2 className="w-4 h-4" />Delete</Button>}
      </div>
      {recovery && <CopyField label="Password recovery link (valid for a short time, share it with the person)" value={recovery} />}

      <AccountSection u={u} isSelf={isSelf} onSaved={refresh} />
      <AccessSection u={u} onSaved={refresh} />
      <FundraisingSection u={u} onSaved={refresh} />
      <OutreachSection u={u} onSaved={refresh} />
      <CrmSection u={u} onSaved={refresh} />
      <HistorySection u={u} />

      <ConfirmModal open={confirm === 'block'} onClose={() => setConfirm(null)} title="Block this account?" confirmLabel="Block" danger
        message={<>The person keeps their data but cannot use any product until unblocked. The database refuses their outreach, CRM and credit calls immediately.</>}
        onConfirm={() => run('Account blocked', () => adminApi.setAccess(u.id, { status: 'blocked' }))} />
      <ConfirmModal open={confirm === 'ban'} onClose={() => setConfirm(null)} title="Ban sign-in?" confirmLabel="Ban" danger
        message={<>Supabase Auth will refuse every sign-in for <b>{u.email}</b> until the ban is lifted. Existing sessions expire on their own.</>}
        onConfirm={() => run('Sign-in banned', () => adminApi.setBanned(u.id, true))} />
      <ConfirmModal open={confirm === 'unban'} onClose={() => setConfirm(null)} title="Lift the sign-in ban?" confirmLabel="Lift ban"
        message={<>{u.email} will be able to sign in again.</>}
        onConfirm={() => run('Ban lifted', () => adminApi.setBanned(u.id, false))} />
      <ConfirmModal open={confirm === 'admin_on'} onClose={() => setConfirm(null)} title="Make this account an admin?" confirmLabel="Make admin"
        message={<>Admins can open this page and change every account, plan, credit balance and workspace. The account is also set to active.</>}
        onConfirm={() => run('Admin access granted', () => adminApi.setAdmin(u.id, true))} />
      <ConfirmModal open={confirm === 'admin_off'} onClose={() => setConfirm(null)} title="Remove admin access?" confirmLabel="Remove"
        message={<>{u.email} keeps a normal account.</>}
        onConfirm={() => run('Admin access removed', () => adminApi.setAdmin(u.id, false))} />
      <ConfirmModal open={confirm === 'delete'} onClose={() => setConfirm(null)} title="Delete this account?" confirmLabel="Delete permanently" danger requireText={u.email ?? u.id}
        message={<>This removes the sign-in and, through the foreign keys in the database, everything the account owns: settings, credit history, outreach memberships (workspaces they created stay, with their other members), CRM membership. It cannot be undone.</>}
        onConfirm={async () => { await adminApi.deleteAccount(u.id, u.email ?? ''); toast('Account deleted'); onClose(); refresh(); }} />
    </>
  );
}

// ─── Account ─────────────────────────────────────────────────────────
function AccountSection({ u, isSelf, onSaved }: { u: AdminUserDetail; isSelf: boolean; onSaved: () => void }) {
  const toast = useAdminToast();
  const [noteEdit, setNoteEdit] = useState<string | null>(null);   // null = untouched, shows the saved value
  const [busy, setBusy] = useState(false);
  const saved = u.note ?? '';
  const note = noteEdit ?? saved;
  const dirty = noteEdit !== null && noteEdit !== saved;
  return (
    <Section title="Account" description={isSelf ? 'This is your own account.' : undefined}>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3">
        <KV label="Signed up">{fmtDate(u.created_at)}</KV>
        <KV label="Last sign-in">{u.last_sign_in_at ? fmtDate(u.last_sign_in_at) : 'never'}</KV>
        <KV label="Sign-in method">{u.provider}{u.email_confirmed_at ? '' : ' · email not confirmed'}</KV>
        <KV label="Approved">{u.approved_at ? fmtDay(u.approved_at) : '—'}</KV>
        <KV label="Onboarding">{u.onboarding_completed ? `done (${u.primary_use ?? 'unknown'})` : u.primary_use ? `in progress (${u.primary_use})` : 'not started'}</KV>
        <KV label="Stripe customer">{u.stripe_customer_id ?? '—'}</KV>
      </dl>
      <div className="mt-4">
        <Textarea label="Admin note (never shown to the person)" value={note} onChange={(e) => setNoteEdit(e.target.value)} className="min-h-[60px]" placeholder="Who they are, what was agreed, anything the next admin should know." />
        {dirty && (
          <div className="mt-2 flex gap-2">
            <Button size="sm" loading={busy} onClick={async () => { setBusy(true); try { await adminApi.setAccess(u.id, { note }); toast('Note saved'); setNoteEdit(null); onSaved(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); } }}>Save note</Button>
            <Button size="sm" variant="ghost" onClick={() => setNoteEdit(null)}>Discard</Button>
          </div>
        )}
      </div>
    </Section>
  );
}

// ─── Access (what they can see) ──────────────────────────────────────
function AccessSection({ u, onSaved }: { u: AdminUserDetail; onSaved: () => void }) {
  const toast = useAdminToast();
  const savedOverrides = useMemo(() => u.overrides ?? {}, [u.overrides]);
  const [edit, setEdit] = useState<Record<string, boolean> | null>(null);
  const overrides = edit ?? savedOverrides;
  const [busy, setBusy] = useState(false);
  const dirty = edit !== null && JSON.stringify(edit) !== JSON.stringify(savedOverrides);
  const platformDefault = (key: string) => (typeof u.features[key] === 'boolean' && !(key in savedOverrides) ? u.features[key] : undefined);

  return (
    <Section title="What this account can see" description="“Default” follows the platform rule for that feature; On / Off overrides it for this account only. Outreach and fundraising switches are enforced by the database as well."
      actions={<div className="flex items-center gap-2"><AccessChips user={u} /></div>}>
      <div className="divide-y divide-gray-100">
        {FEATURES.map((f) => {
          const pd = platformDefault(f.key);
          return (
            <div key={f.key} className="flex items-start justify-between gap-4 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900">{f.label}</div>
                <div className="text-xs text-gray-500">{f.description}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">Default: {pd === undefined ? f.defaultRule : pd ? 'On (platform default)' : 'Off (platform default)'}</div>
              </div>
              <TriState value={overrides[f.key]} onChange={(v) => setEdit(() => { const n = { ...overrides }; if (v === undefined) delete n[f.key]; else n[f.key] = v; return n; })} />
            </div>
          );
        })}
        <div className="flex items-start justify-between gap-4 py-2.5">
          <div>
            <div className="text-sm font-medium text-gray-900">Sales CRM</div>
            <div className="text-xs text-gray-500">Membership of the internal sales team. Managed in the CRM section below.</div>
          </div>
          <Badge tone={u.crm?.is_active ? 'green' : 'gray'}>{u.crm?.is_active ? 'Member' : 'Not a member'}</Badge>
        </div>
      </div>
      {dirty && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" loading={busy} onClick={async () => { setBusy(true); try { await adminApi.setAccess(u.id, { features: overrides }); toast('Access saved'); setEdit(null); onSaved(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); } }}>Save access</Button>
          <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Discard</Button>
        </div>
      )}
    </Section>
  );
}

// ─── Fundraising: plan + credits ─────────────────────────────────────
type BillingForm = { plan: string; billing_status: string; billing_cycle: string; renewal_date: string };

function FundraisingSection({ u, onSaved }: { u: AdminUserDetail; onSaved: () => void }) {
  const toast = useAdminToast();
  const saved: BillingForm = { plan: u.plan, billing_status: u.billing_status, billing_cycle: u.billing_cycle ?? '', renewal_date: toDateInput(u.renewal_date) };
  const [edit, setEdit] = useState<Partial<BillingForm> | null>(null);
  const form: BillingForm = { ...saved, ...(edit ?? {}) };
  const dirty = edit !== null && (Object.keys(form) as (keyof BillingForm)[]).some((k) => form[k] !== saved[k]);
  const [busy, setBusy] = useState(false);
  const [delta, setDelta] = useState('');
  const [setTo, setSetTo] = useState('');
  const [note, setNote] = useState('');
  const [cbusy, setCbusy] = useState(false);
  const patch = (p: Partial<BillingForm>) => setEdit((e) => ({ ...(e ?? {}), ...p }));

  const credits = async (change: { delta?: number; set?: number }) => {
    setCbusy(true);
    try { await adminApi.adjustCredits(u.id, { ...change, note: note || undefined }); toast('Credits updated'); setDelta(''); setSetTo(''); setNote(''); onSaved(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setCbusy(false); }
  };

  return (
    <Section title="Fundraising · plan and credits" description="Credits are spent one per AI investor analysis." actions={<PlanBadge plan={u.plan} />}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Select label="Plan" value={form.plan} onChange={(e) => patch({ plan: e.target.value })}>{FUNDRAISING_PLANS.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
        <Select label="Billing status" value={form.billing_status} onChange={(e) => patch({ billing_status: e.target.value })}>{BILLING_STATUSES.map((p) => <option key={p} value={p}>{p.replace('_', ' ')}</option>)}</Select>
        <Select label="Billing cycle" value={form.billing_cycle} onChange={(e) => patch({ billing_cycle: e.target.value })}><option value="">—</option>{BILLING_CYCLES.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
        <Input label="Renewal date" type="date" value={form.renewal_date} onChange={(e) => patch({ renewal_date: e.target.value })} />
      </div>
      {dirty && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" loading={busy} onClick={async () => {
            setBusy(true);
            try { await adminApi.setBilling(u.id, { plan: form.plan, billing_status: form.billing_status, billing_cycle: form.billing_cycle || null, renewal_date: form.renewal_date || null }); toast('Plan saved'); setEdit(null); onSaved(); }
            catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
          }}>Save plan</Button>
          <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Discard</Button>
        </div>
      )}

      <div className="mt-5 grid md:grid-cols-[auto,1fr] gap-4 items-start">
        <div className="bg-gray-50 border border-gray-200 rounded-xl px-5 py-4 min-w-[180px]">
          <div className="text-xs text-gray-500">Balance</div>
          <div className="text-3xl font-bold text-gray-900 tabular-nums">{fmtNum(u.credits_remaining)}</div>
          <div className="text-xs text-gray-400 mt-1">{fmtNum(u.credits_used)} used in total</div>
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <Input label="Add or remove" type="number" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="e.g. 50 or -10" className="w-36" />
            <Button size="md" variant="secondary" loading={cbusy} disabled={!delta || !Number.isFinite(Number(delta)) || Number(delta) === 0} onClick={() => credits({ delta: Math.trunc(Number(delta)) })}>{Number(delta) < 0 ? <Minus className="w-4 h-4" /> : <Plus className="w-4 h-4" />}Apply</Button>
            <span className="text-xs text-gray-400 pb-2.5">or</span>
            <Input label="Set balance to" type="number" min={0} value={setTo} onChange={(e) => setSetTo(e.target.value)} placeholder="e.g. 100" className="w-36" />
            <Button size="md" variant="secondary" loading={cbusy} disabled={setTo === '' || !Number.isFinite(Number(setTo)) || Number(setTo) < 0} onClick={() => credits({ set: Math.trunc(Number(setTo)) })}>Set</Button>
          </div>
          <Input label="Reason (kept in the audit log)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. paid invoice #123, goodwill top-up" />
        </div>
      </div>

      {u.credit_log.length > 0 && (
        <details className="mt-4">
          <summary className="text-xs font-medium text-gray-600 cursor-pointer">Recent credit usage ({u.credit_log.length})</summary>
          <Table className="mt-2">
            <thead><tr><Th>When</Th><Th>Action</Th><Th>Investor</Th><Th className="text-right">Credits</Th></tr></thead>
            <tbody>{u.credit_log.map((r) => <tr key={r.id}><Td className="whitespace-nowrap">{fmtDate(r.created_at)}</Td><Td>{r.action}</Td><Td>{r.investor_name ?? '—'}</Td><Td className="text-right tabular-nums">{r.credits_used}</Td></tr>)}</tbody>
          </Table>
        </details>
      )}
    </Section>
  );
}

// ─── Outreach workspaces ─────────────────────────────────────────────
function OutreachSection({ u, onSaved }: { u: AdminUserDetail; onSaved: () => void }) {
  const toast = useAdminToast();
  const outreachOn = typeof u.features.outreach === 'boolean' ? u.features.outreach : true;
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addWs, setAddWs] = useState('');
  const [addRole, setAddRole] = useState<OutreachRole>('member');
  const allWs = useQuery({ queryKey: ['admin', 'workspaces', '', false], queryFn: () => adminApi.workspaces('', false), enabled: adding });
  const candidates = useMemo(() => (allWs.data ?? []).filter((w) => !u.outreach.some((o) => o.workspace_id === w.id)), [allWs.data, u.outreach]);

  const act = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); toast(label); onSaved(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  };

  return (
    <Section title="Outreach" description={outreachOn ? 'Workspaces this account belongs to. Plan and trial are per workspace; suspending pauses every connected sender.' : 'Outreach is switched off for this account (see access above); memberships are kept.'}
      actions={<>
        <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>Add to a workspace</Button>
        <Button size="sm" variant="secondary" loading={busy === 'create'} onClick={() => act('create', 'Workspace created', () => adminApi.createWorkspaceFor(u.id))}>New workspace for them</Button>
      </>}>
      {adding && (
        <div className="mb-4 flex flex-wrap items-end gap-2 bg-gray-50 border border-gray-200 rounded-lg p-3">
          <Select label="Workspace" value={addWs} onChange={(e) => setAddWs(e.target.value)} className="min-w-[240px]">
            <option value="">{allWs.isLoading ? 'Loading…' : 'Choose a workspace'}</option>
            {candidates.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.owner_email ?? 'no owner'} · {w.plan}</option>)}
          </Select>
          <Select label="Role" value={addRole} onChange={(e) => setAddRole(e.target.value as OutreachRole)} className="w-auto">{OUTREACH_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
          <Button size="md" disabled={!addWs} loading={busy === 'add'} onClick={() => act('add', 'Added to workspace', async () => { await adminApi.setWorkspaceMember(addWs, u.id, addRole); setAdding(false); setAddWs(''); })}>Add</Button>
        </div>
      )}
      {u.outreach.length === 0 ? <p className="text-sm text-gray-500">No workspace yet. One is created the first time they open Outreach, or you can create it now.</p> : (
        <div className="space-y-3">
          {u.outreach.map((w) => <WorkspaceRow key={`${w.workspace_id}:${w.plan}:${w.trial_ends_at}:${w.role}`} w={w} userId={u.id} busy={busy} act={act} />)}
        </div>
      )}
    </Section>
  );
}

function WorkspaceRow({ w, userId, busy, act }: { w: AdminUserDetail['outreach'][number]; userId: string; busy: string | null; act: (key: string, label: string, fn: () => Promise<unknown>) => Promise<void> }) {
  // the row is keyed on the saved values, so plain initial state is enough
  const [plan, setPlan] = useState<OutreachPlan>(w.plan);
  const [trial, setTrial] = useState(toDateInput(w.trial_ends_at));
  const dirty = plan !== w.plan || trial !== toDateInput(w.trial_ends_at);
  const k = w.workspace_id;
  return (
    <div className="border border-gray-200 rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="font-medium text-gray-900">{w.name}</div>
        <WsPlanBadge plan={w.plan} />
        <span className="text-xs text-gray-400">{w.members} member{w.members === 1 ? '' : 's'} · {w.senders} sender{w.senders === 1 ? '' : 's'}{w.stripe_status ? ` · stripe ${w.stripe_status}` : ''}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
        <Select label="Plan" value={plan} onChange={(e) => setPlan(e.target.value as OutreachPlan)}>{OUTREACH_PLANS.map((p) => <option key={p} value={p}>{p === 'agency_plus' ? 'agency+' : p}</option>)}</Select>
        <Input label="Trial ends" type="date" value={trial} onChange={(e) => setTrial(e.target.value)} />
        <Select label="Their role" value={w.role} onChange={(e) => act(k + 'role', 'Role updated', () => adminApi.setWorkspaceMember(k, userId, e.target.value as OutreachRole))}>{OUTREACH_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
        <div className="flex gap-2">
          {dirty && <Button size="sm" loading={busy === k} onClick={() => act(k, 'Workspace updated', () => adminApi.setWorkspace(k, { plan, trial_ends_at: trial ? new Date(trial + 'T00:00:00Z').toISOString() : undefined }))}>Save</Button>}
          <Button size="sm" variant="ghost" loading={busy === k + 'rm'} onClick={() => act(k + 'rm', 'Removed from workspace', () => adminApi.setWorkspaceMember(k, userId, null))}>Remove</Button>
        </div>
      </div>
    </div>
  );
}

// ─── CRM ─────────────────────────────────────────────────────────────
function CrmSection({ u, onSaved }: { u: AdminUserDetail; onSaved: () => void }) {
  const toast = useAdminToast();
  const savedName = u.crm?.display_name ?? '';
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const name = nameEdit ?? savedName;
  const [busy, setBusy] = useState(false);
  const save = async (patch: { active?: boolean; displayName?: string }, label: string) => {
    setBusy(true);
    try { await adminApi.setCrmMember(u.id, patch); toast(label); setNameEdit(null); onSaved(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Section title="Sales CRM team" description="The CRM is one internal team: members see every deal. Deactivating keeps their history." actions={<Badge tone={u.crm?.is_active ? 'green' : 'gray'}>{u.crm ? (u.crm.is_active ? 'Active member' : 'Deactivated') : 'Not a member'}</Badge>}>
      <div className="flex flex-wrap items-end gap-2">
        <Input label="Display name" value={name} onChange={(e) => setNameEdit(e.target.value)} placeholder={u.email?.split('@')[0]} className="w-56" />
        {u.crm?.is_active ? (
          <>
            {name !== savedName && <Button size="md" loading={busy} onClick={() => save({ displayName: name }, 'Name saved')}>Save name</Button>}
            <Button size="md" variant="secondary" loading={busy} onClick={() => save({ active: false }, 'Removed from the CRM team')}>Deactivate</Button>
          </>
        ) : (
          <Button size="md" loading={busy} onClick={() => save({ active: true, displayName: name || undefined }, 'Added to the CRM team')}>{u.crm ? 'Reactivate' : 'Add to the team'}</Button>
        )}
      </div>
    </Section>
  );
}

// ─── History ─────────────────────────────────────────────────────────
function HistorySection({ u }: { u: AdminUserDetail }) {
  return (
    <Section title="Admin history" description="Every change an admin made to this account.">
      {u.audit.length === 0 ? <p className="text-sm text-gray-500">Nothing yet.</p> : (
        <ul className="divide-y divide-gray-100">
          {u.audit.map((a) => (
            <li key={a.id} className="py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-gray-900">{actionLabel(a.action)}</span>
                <span className="text-xs text-gray-400 whitespace-nowrap">{fmtDate(a.created_at)} · {a.admin_email ?? 'system'}</span>
              </div>
              {describeDetails(a.details) && <div className="text-xs text-gray-500 mt-0.5 break-words">{describeDetails(a.details)}</div>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
