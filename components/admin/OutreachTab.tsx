'use client';

import { Fragment, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { Badge, Button, Input, Modal, Select, Table, Th, Td, ErrorBox, timeAgo } from '@/components/outreach/ui';
import { adminApi, OUTREACH_PLANS, OUTREACH_ROLES, type AdminWorkspace, type OutreachPlan, type OutreachRole } from '@/lib/platform/admin';
import { AccountPicker, ConfirmModal, WsPlanBadge, errMsg, fmtDay, fmtNum, toDateInput, useAdminToast, useDebounced } from './shared';

/** Mounted per workspace (keyed on its id by the caller), so the form starts from the saved values. */
function EditWorkspaceModal({ w, onClose, onSaved }: { w: AdminWorkspace; onClose: () => void; onSaved: () => void }) {
  const toast = useAdminToast();
  const [name, setName] = useState(w.name);
  const [plan, setPlan] = useState<OutreachPlan>(w.plan);
  const [trial, setTrial] = useState(toDateInput(w.trial_ends_at));
  const [busy, setBusy] = useState(false);
  const suspending = plan === 'suspended' && w.plan !== 'suspended';
  return (
    <Modal open onClose={onClose} title={`Edit ${w.name}`} size="sm" footer={<>
      <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button variant={suspending ? 'danger' : 'primary'} loading={busy} onClick={async () => {
        setBusy(true);
        try {
          await adminApi.setWorkspace(w.id, { name, plan, trial_ends_at: trial ? new Date(trial + 'T00:00:00Z').toISOString() : undefined });
          toast('Workspace updated'); onSaved(); onClose();
        } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
      }}>{suspending ? 'Suspend workspace' : 'Save'}</Button>
    </>}>
      <div className="space-y-3">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Select label="Plan" value={plan} onChange={(e) => setPlan(e.target.value as OutreachPlan)}>{OUTREACH_PLANS.map((p) => <option key={p} value={p}>{p === 'agency_plus' ? 'agency+' : p}</option>)}</Select>
        <Input label="Trial ends" type="date" value={trial} onChange={(e) => setTrial(e.target.value)} hint="Only matters while the plan is “trial”." />
        {suspending && <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">Suspending pauses every connected sender and blocks all writes for the members of this workspace until you set a plan again. Sequences resume on their own afterwards.</p>}
        {w.plan === 'suspended' && plan !== 'suspended' && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">Paused senders will be resumed.</p>}
      </div>
    </Modal>
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
        <thead><tr><Th className="w-8" /><Th>Workspace</Th><Th>Owner</Th><Th>Plan</Th><Th>Trial ends</Th><Th className="text-right">Senders</Th><Th className="text-right">Leads</Th><Th className="text-right">Sequences</Th><Th className="text-right" title="Automated actions in the last 7 days">7d actions</Th><Th>Created</Th><Th /></tr></thead>
        <tbody>
          {q.isLoading && <tr><Td colSpan={11} className="text-center text-gray-500 py-8">Loading…</Td></tr>}
          {!q.isLoading && rows.length === 0 && <tr><Td colSpan={11} className="text-center text-gray-500 py-8">No workspaces.</Td></tr>}
          {rows.map((w) => {
            const isOpen = open.has(w.id);
            return (
              <Fragment key={w.id}>
                <tr className={`hover:bg-gray-50 ${w.deleted_at ? 'opacity-50' : ''}`}>
                  <Td><button type="button" className="p-1 rounded hover:bg-gray-100" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(w.id)) n.delete(w.id); else n.add(w.id); return n; })} aria-label="Members">{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></Td>
                  <Td><div className="font-medium text-gray-900">{w.name}</div><div className="text-xs text-gray-400 font-mono">{w.slug}{w.deleted_at ? ' · deleted' : ''}</div></Td>
                  <Td>{w.owner_email ? <button type="button" className="hover:underline" onClick={() => { const o = w.members.find((m) => m.role === 'owner'); if (o) onOpenUser(o.user_id); }}>{w.owner_email}</button> : <span className="text-gray-400">—</span>}<div className="text-xs text-gray-400">{w.members.length} member{w.members.length === 1 ? '' : 's'} · {w.clients} client{w.clients === 1 ? '' : 's'}</div></Td>
                  <Td><WsPlanBadge plan={w.plan} />{w.stripe_status && <div className="text-xs text-gray-400">stripe {w.stripe_status}</div>}{w.plan === 'suspended' && w.plan_before_suspension && <div className="text-xs text-gray-400">was {w.plan_before_suspension}</div>}</Td>
                  <Td className="whitespace-nowrap">{w.plan === 'trial' ? <span className={new Date(w.trial_ends_at) < new Date() ? 'text-rose-600' : ''}>{fmtDay(w.trial_ends_at)}</span> : <span className="text-gray-400">—</span>}</Td>
                  <Td className="text-right tabular-nums">{w.senders_ok}/{w.senders}</Td>
                  <Td className="text-right tabular-nums">{fmtNum(w.leads)}</Td>
                  <Td className="text-right tabular-nums">{fmtNum(w.sequences)}</Td>
                  <Td className="text-right tabular-nums">{fmtNum(w.actions_7d)}</Td>
                  <Td className="text-gray-500 whitespace-nowrap">{timeAgo(w.created_at)}</Td>
                  <Td className="text-right"><Button size="sm" variant="secondary" onClick={() => setEditing(w)}>Edit</Button></Td>
                </tr>
                {isOpen && <tr><td colSpan={11} className="p-0"><MembersPanel w={w} onOpenUser={onOpenUser} onChanged={refresh} /></td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </Table>

      {editing && <EditWorkspaceModal key={editing.id} w={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}
