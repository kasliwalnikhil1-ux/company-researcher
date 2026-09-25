'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, UserPlus, RefreshCw, ChevronLeft, ChevronRight, Coins, Users, Clock, Ban, Linkedin, Briefcase } from 'lucide-react';
import { Button, Input, Modal, Select, Table, Th, Td, timeAgo, ErrorBox } from '@/components/outreach/ui';
import { adminApi, FUNDRAISING_PLANS, type AdminUser, type UserFilter } from '@/lib/platform/admin';
import type { AccessStatus } from '@/lib/platform/access';
import { AccessChips, CopyField, PlanBadge, StatusBadge, errMsg, fmtDay, fmtNum, useAdminToast, useDebounced } from './shared';

const PAGE = 50;

function StatCard({ label, value, hint, icon: Icon, tone = 'indigo', onClick, active }: { label: string; value: React.ReactNode; hint?: string; icon: React.ElementType; tone?: string; onClick?: () => void; active?: boolean }) {
  const tones: Record<string, string> = { indigo: 'bg-indigo-100 text-indigo-700', amber: 'bg-amber-100 text-amber-700', emerald: 'bg-emerald-100 text-emerald-700', rose: 'bg-rose-100 text-rose-700', gray: 'bg-gray-100 text-gray-700', sky: 'bg-sky-100 text-sky-700' };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={`text-left bg-white border rounded-xl px-4 py-3 flex items-center gap-3 ${active ? 'border-indigo-400 ring-1 ring-indigo-200' : 'border-gray-200'} ${onClick ? 'hover:border-indigo-300' : ''}`}>
      <div className={`rounded-lg p-2 ${tones[tone] ?? tones.indigo}`}><Icon className="w-4 h-4" /></div>
      <div className="min-w-0">
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-lg font-semibold text-gray-900 leading-tight">{value}</div>
        {hint && <div className="text-[11px] text-gray-400">{hint}</div>}
      </div>
    </Tag>
  );
}

function CreateAccountModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const [plan, setPlan] = useState<string>('free');
  const [credits, setCredits] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ userId: string; email: string; inviteLink: string | null } | null>(null);
  const toast = useAdminToast();

  const reset = () => { setEmail(''); setPassword(''); setNote(''); setPlan('free'); setCredits(''); setErr(null); setResult(null); };

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await adminApi.createAccount({ email: email.trim(), password: password || undefined, note: note || undefined });
      if (plan !== 'free') await adminApi.setBilling(r.userId, { plan, billing_status: 'active' });
      const c = Number(credits);
      if (credits !== '' && Number.isFinite(c) && c > 0) await adminApi.adjustCredits(r.userId, { set: Math.floor(c), note: 'initial balance' });
      setResult(r);
      toast('Account created');
      onCreated(r.userId);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} title="Create an account" size="md" footer={result ? (
      <Button onClick={() => { reset(); onClose(); }}>Done</Button>
    ) : (
      <>
        <Button variant="secondary" onClick={() => { reset(); onClose(); }} disabled={busy}>Cancel</Button>
        <Button loading={busy} onClick={submit} disabled={!email.trim()}>Create</Button>
      </>
    )}>
      {result ? (
        <div className="space-y-3 text-sm text-gray-700">
          <p><span className="font-medium text-gray-900">{result.email}</span> is created and approved.</p>
          {result.inviteLink ? (
            <>
              <p>No password was set, so the person finishes sign-up from this invitation link (an email is sent too when the project has SMTP configured):</p>
              <CopyField value={result.inviteLink} />
            </>
          ) : (
            <p>They can sign in with the password you set. Use “Recovery link” on the account to let them choose their own.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus placeholder="person@company.com" />
          <Input label="Password (optional)" type="text" value={password} onChange={(e) => setPassword(e.target.value)} hint="Leave empty to send an invitation link instead. At least 8 characters." />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Fundraising plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
              {FUNDRAISING_PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
            <Input label="Starting credits (optional)" type="number" min={0} value={credits} onChange={(e) => setCredits(e.target.value)} placeholder="keep default" />
          </div>
          <Input label="Admin note (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. pilot customer, referred by…" />
          <p className="text-xs text-gray-500">The account starts as <span className="font-medium">active</span> with the platform-default features. Outreach workspaces and CRM membership are set from the account drawer afterwards.</p>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
      )}
    </Modal>
  );
}

export default function UsersTab({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useAdminToast();
  const [search, setSearch] = useState('');
  const dsearch = useDebounced(search);
  const [filter, setFilter] = useState<UserFilter>({ sort: 'newest' });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const overview = useQuery({ queryKey: ['admin', 'overview'], queryFn: adminApi.overview });
  const users = useQuery({
    queryKey: ['admin', 'users', dsearch, filter, page],
    queryFn: () => adminApi.listUsers(dsearch, filter, PAGE, page * PAGE),
    placeholderData: (prev) => prev,
  });

  const rows = useMemo(() => {
    const r = users.data?.rows ?? [];
    // the RPC's page is right, its order inside the page is not guaranteed: sort again here
    const s = filter.sort ?? 'newest';
    return [...r].sort((a, b) => {
      if (s === 'oldest') return a.created_at.localeCompare(b.created_at);
      if (s === 'last_seen') return (b.last_sign_in_at ?? '').localeCompare(a.last_sign_in_at ?? '');
      if (s === 'credits') return b.credits_remaining - a.credits_remaining;
      if (s === 'email') return (a.email ?? '').localeCompare(b.email ?? '');
      return b.created_at.localeCompare(a.created_at);
    });
  }, [users.data, filter.sort]);

  const total = users.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const setF = (patch: Partial<UserFilter>) => { setFilter((f) => ({ ...f, ...patch })); setPage(0); setSelected(new Set()); };
  const toggleStatusFilter = (s: AccessStatus) => setF({ status: filter.status === s ? '' : s });

  const bulk = async (status: AccessStatus) => {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const n = await adminApi.bulkStatus([...selected], status);
      toast(`${n} account${n === 1 ? '' : 's'} set to ${status}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBulkBusy(false); }
  };

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const o = overview.data;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        <StatCard label="Accounts" value={fmtNum(o?.users)} hint={o ? `${o.signups_7d} new this week` : undefined} icon={Users} onClick={() => setF({ status: '' })} active={!filter.status} />
        <StatCard label="Pending approval" value={fmtNum(o?.pending)} icon={Clock} tone="amber" onClick={() => toggleStatusFilter('pending')} active={filter.status === 'pending'} />
        <StatCard label="Active" value={fmtNum(o?.active)} icon={Users} tone="emerald" onClick={() => toggleStatusFilter('active')} active={filter.status === 'active'} />
        <StatCard label="Blocked / banned" value={`${fmtNum(o?.blocked)} / ${fmtNum(o?.banned)}`} icon={Ban} tone="rose" onClick={() => toggleStatusFilter('blocked')} active={filter.status === 'blocked'} />
        <StatCard label="Credits outstanding" value={fmtNum(o?.credits_outstanding)} hint={o ? `${fmtNum(o.credits_used_30d)} used in 30 days` : undefined} icon={Coins} tone="sky" />
        <StatCard label="Outreach workspaces" value={fmtNum(o?.outreach_workspaces)} hint={o ? `${fmtNum(o.outreach_senders)} senders` : undefined} icon={Linkedin} tone="indigo" />
        <StatCard label="CRM team" value={fmtNum(o?.crm_members)} hint={o ? `${o.admins} admin${o.admins === 1 ? '' : 's'}` : undefined} icon={Briefcase} tone="gray" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder="Search by email or account id…" className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <Select value={filter.status ?? ''} onChange={(e) => setF({ status: e.target.value as AccessStatus | '' })} className="w-auto">
          <option value="">Any status</option><option value="pending">Pending</option><option value="active">Active</option><option value="blocked">Blocked</option>
        </Select>
        <Select value={filter.plan ?? ''} onChange={(e) => setF({ plan: e.target.value })} className="w-auto">
          <option value="">Any plan</option>{FUNDRAISING_PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
        <Select value={filter.outreach === undefined ? '' : String(filter.outreach)} onChange={(e) => setF({ outreach: e.target.value === '' ? undefined : e.target.value === 'true' })} className="w-auto">
          <option value="">Outreach: any</option><option value="true">Has a workspace</option><option value="false">No workspace</option>
        </Select>
        <Select value={filter.crm === undefined ? '' : String(filter.crm)} onChange={(e) => setF({ crm: e.target.value === '' ? undefined : e.target.value === 'true' })} className="w-auto">
          <option value="">CRM: any</option><option value="true">On the team</option><option value="false">Not on the team</option>
        </Select>
        <Select value={filter.admin === undefined ? (filter.banned ? 'banned' : '') : 'admin'} onChange={(e) => setF({ admin: e.target.value === 'admin' ? true : undefined, banned: e.target.value === 'banned' ? true : undefined })} className="w-auto">
          <option value="">Everyone</option><option value="admin">Admins only</option><option value="banned">Banned only</option>
        </Select>
        <Select value={filter.sort ?? 'newest'} onChange={(e) => setF({ sort: e.target.value as UserFilter['sort'] })} className="w-auto">
          <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="last_seen">Last seen</option><option value="credits">Most credits</option><option value="email">Email A–Z</option>
        </Select>
        <Button variant="secondary" size="md" onClick={() => qc.invalidateQueries({ queryKey: ['admin'] })} title="Refresh"><RefreshCw className={`w-4 h-4 ${users.isFetching ? 'animate-spin' : ''}`} /></Button>
        <Button onClick={() => setCreating(true)}><UserPlus className="w-4 h-4" />Create account</Button>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2 text-sm text-indigo-900">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" loading={bulkBusy} onClick={() => bulk('active')}>Approve</Button>
          <Button size="sm" variant="secondary" loading={bulkBusy} onClick={() => bulk('pending')}>Set pending</Button>
          <Button size="sm" variant="danger" loading={bulkBusy} onClick={() => bulk('blocked')}>Block</Button>
          <button type="button" className="ml-auto text-xs underline" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {users.error && <ErrorBox message={errMsg(users.error)} />}

      <Table>
        <thead>
          <tr>
            <Th className="w-8"><input type="checkbox" checked={allOnPage} onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...rows.map((r) => r.id)]) : new Set([...selected].filter((id) => !rows.some((r) => r.id === id))))} /></Th>
            <Th>Account</Th>
            <Th>Status</Th>
            <Th title="Fundraising / Outreach / CRM, as this account sees them">Access</Th>
            <Th>Plan · credits</Th>
            <Th>Outreach</Th>
            <Th>Last sign-in</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {users.isLoading && <tr><Td colSpan={8} className="text-center text-gray-500 py-8">Loading accounts…</Td></tr>}
          {!users.isLoading && rows.length === 0 && <tr><Td colSpan={8} className="text-center text-gray-500 py-8">No accounts match.</Td></tr>}
          {rows.map((u: AdminUser) => (
            <tr key={u.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => onOpenUser(u.id)}>
              <Td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(u.id)} onChange={(e) => { const n = new Set(selected); if (e.target.checked) n.add(u.id); else n.delete(u.id); setSelected(n); }} /></Td>
              <Td>
                <div className="font-medium text-gray-900 truncate max-w-[260px]">{u.email ?? u.id}</div>
                <div className="text-xs text-gray-400">Signed up {fmtDay(u.created_at)}{u.primary_use ? ` · ${u.primary_use}` : ''}{!u.email_confirmed_at ? ' · unconfirmed' : ''}</div>
              </Td>
              <Td><StatusBadge status={u.status} banned={u.banned} /></Td>
              <Td><AccessChips user={u} /></Td>
              <Td>
                <div className="flex items-center gap-2"><PlanBadge plan={u.plan} /><span className="tabular-nums text-gray-900">{fmtNum(u.credits_remaining)}</span><span className="text-xs text-gray-400">left</span></div>
                <div className="text-xs text-gray-400">{fmtNum(u.credits_used)} used · billing {u.billing_status}</div>
              </Td>
              <Td>
                {u.outreach.length === 0 ? <span className="text-gray-400">—</span> : (
                  <div className="text-xs text-gray-700">
                    {u.outreach.slice(0, 2).map((w) => <div key={w.workspace_id} className="truncate max-w-[180px]">{w.name} <span className="text-gray-400">· {w.plan} · {w.role}</span></div>)}
                    {u.outreach.length > 2 && <div className="text-gray-400">+{u.outreach.length - 2} more</div>}
                  </div>
                )}
              </Td>
              <Td className="text-gray-500 whitespace-nowrap">{u.last_sign_in_at ? timeAgo(u.last_sign_in_at) : 'never'}</Td>
              <Td className="text-right"><Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); onOpenUser(u.id); }}>Manage</Button></Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>{total === 0 ? 'No accounts' : `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${fmtNum(total)}`}</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="w-4 h-4" /></Button>
          <span className="px-2">Page {page + 1} / {pages}</span>
          <Button size="sm" variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="w-4 h-4" /></Button>
        </div>
      </div>

      <CreateAccountModal open={creating} onClose={() => setCreating(false)} onCreated={() => qc.invalidateQueries({ queryKey: ['admin'] })} />
    </div>
  );
}
