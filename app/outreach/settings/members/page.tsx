'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Briefcase, Check, Copy, Crown, Eye, Lock, Mail, RefreshCw, Trash2, User, UserPlus, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { db } from '@/lib/outreach/backend';
import { useSessionUser } from '@/lib/outreach/session';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { qk, useClients, useInvitations, useMembers } from '@/lib/outreach/queries';
import { usePlanFeature } from '@/lib/outreach/billing';
import { UpgradeNote } from '@/components/outreach/PlanGate';
import { Badge, Button, Card, EmptyState, ErrorBox, fmtDate, Input, Modal, PageHeader, PageLoader, Select, Spinner, Table, Td, Th, Toggle, useToast } from '@/components/outreach/ui';
import { MemberAvatar } from '@/components/outreach/members';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import { copyText } from '@/components/outreach/senders/helpers';
import type { Client, Invitation, Member, Role } from '@/lib/outreach/types';

const ROLES: Array<{ value: Role; label: string; hint: string; icon: LucideIcon }> = [
  { value: 'owner', label: 'Owner', hint: 'Everything, incl. billing, members, webhooks', icon: Crown },
  { value: 'manager', label: 'Manager', hint: 'Senders, sequences, leads, exports', icon: Briefcase },
  { value: 'member', label: 'Member', hint: 'Leads, tasks, inbox (scoped to clients)', icon: User },
  { value: 'client_viewer', label: 'Client viewer', hint: 'Read-only inbox and stats for their client', icon: Eye },
];

function RolePicker({ value, onChange, isLocked, disabled }: { value: Role; onChange: (r: Role) => void; isLocked: (r: Role) => boolean; disabled?: boolean }) {
  const pickable = ROLES.filter((r) => !isLocked(r.value)).map((r) => r.value);
  // Arrow keys move the choice like a native radio group, skipping roles the plan does not include.
  function onKeyDown(e: React.KeyboardEvent) {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step || pickable.length === 0) return;
    e.preventDefault();
    const next = pickable[(pickable.indexOf(value) + step + pickable.length) % pickable.length];
    onChange(next);
    (e.currentTarget.querySelector(`[data-role="${next}"]`) as HTMLElement | null)?.focus();
  }
  return (
    <div>
      <div id="invite-role-label" className="text-xs font-medium text-gray-600 mb-1">Role</div>
      <div role="radiogroup" aria-labelledby="invite-role-label" onKeyDown={onKeyDown} className="space-y-1.5">
        {ROLES.map((r) => {
          const selected = value === r.value; const locked = isLocked(r.value); const Icon = r.icon;
          return (
            <button key={r.value} type="button" role="radio" aria-checked={selected} data-role={r.value} tabIndex={selected ? 0 : -1}
              disabled={disabled || locked} onClick={() => onChange(r.value)}
              className={cn('w-full flex items-start gap-2.5 text-left rounded-lg border px-3 py-2 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500',
                selected ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50',
                (disabled || locked) && 'opacity-60 cursor-not-allowed hover:bg-white')}>
              <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md', selected ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500')}><Icon className="w-3.5 h-3.5" /></span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900">{r.label}{locked && <span className="inline-flex items-center gap-0.5 text-[11px] font-normal text-gray-400"><Lock className="w-3 h-3" /> Not on your plan</span>}</span>
                <span className="block text-xs text-gray-500 mt-0.5">{r.hint}</span>
              </span>
              <span className={cn('mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', selected ? 'border-indigo-600 bg-indigo-600' : 'border-gray-300 bg-white')}>{selected && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ClientScope({ value, clients, onChange, disabled }: { value: string[]; clients: Client[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = value.length === 0 ? 'All clients' : value.length === 1 ? clients.find((c) => c.id === value[0])?.name ?? '1 client' : `${value.length} clients`;
  if (clients.length === 0) return <span className="text-xs text-gray-400">no clients</span>;
  return (
    <div className="relative">
      <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap">{label}</button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute z-30 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg p-2 max-h-64 overflow-y-auto">
            <label className="flex items-center gap-2 px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50 rounded cursor-pointer"><input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} className="rounded border-gray-300 text-indigo-600" /> All clients</label>
            <div className="border-t border-gray-100 my-1" />
            {clients.map((c) => (
              <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50 rounded cursor-pointer">
                <input type="checkbox" className="rounded border-gray-300 text-indigo-600" checked={value.includes(c.id)} onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))} /> <span className="truncate">{c.name}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function MembersSettingsPage() {
  const { workspace, isOwner, canWrite } = useWorkspace();
  const { user } = useSessionUser();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const members = useMembers(isOwner ? ws : null);
  const invitations = useInvitations(isOwner ? ws : null);
  const clients = useClients(ws);
  // Client viewers belong to Scale (billing v2): on a plan without them the role cannot be given, and existing viewers' logins are paused (not deleted).
  const viewerGate = usePlanFeature(ws, 'client_viewer');
  const viewerLocked = (r: Role) => r === 'client_viewer' && !viewerGate.enabled;
  const [busy, setBusy] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [invite, setInvite] = useState<{ email: string; role: Role; client_ids: string[] }>({ email: '', role: 'member', client_ids: [] });
  const [lastInvite, setLastInvite] = useState<{ link: string; emailed: boolean; email: string } | null>(null);

  const refreshMembers = () => qc.invalidateQueries({ queryKey: qk.members(ws ?? '') });
  const refreshInvites = () => qc.invalidateQueries({ queryKey: qk.invitations(ws ?? '') });

  async function updateMember(m: Member, patch: { role?: Role; client_ids?: string[]; can_reply?: boolean }) {
    setBusy(m.user_id);
    try {
      await rpc('update_member', { p_ws: ws, p_user: m.user_id, p_role: patch.role ?? m.role, p_client_ids: patch.client_ids ?? m.client_ids, p_can_reply: patch.can_reply ?? m.can_reply });
      toast.show('Member updated.'); refreshMembers();
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  async function removeMember() {
    if (!removeTarget) return;
    setBusy(removeTarget.user_id);
    try { await rpc('remove_member', { p_ws: ws, p_user: removeTarget.user_id }); toast.show('Member removed.'); refreshMembers(); setRemoveTarget(null); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy('invite');
    try {
      const r = await callFn<{ invitation: Invitation; link: string; emailed: boolean }>('invite-member', { workspace_id: ws, email: invite.email.trim(), role: invite.role, client_ids: invite.client_ids });
      setLastInvite({ link: r.link, emailed: r.emailed, email: r.invitation.email });
      setInvite({ email: '', role: 'member', client_ids: [] });
      toast.show(r.emailed ? `Invitation emailed to ${r.invitation.email}.` : 'Invitation created. Email delivery is not configured — copy the link below.');
      refreshInvites();
    } catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(null); }
  }

  async function resend(inv: Invitation) {
    setBusy(inv.id);
    try { const r = await callFn<{ link: string; emailed: boolean }>('invite-member', { workspace_id: ws, resend_id: inv.id }); toast.show(r.emailed ? 'Invitation re-sent and extended by 7 days.' : 'Invitation extended; email is not configured, copy the link instead.'); refreshInvites(); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  async function deleteInvite(inv: Invitation) {
    setBusy(inv.id);
    try { const { error } = await db.from('outreach_invitations').delete().eq('id', inv.id); if (error) throw error; toast.show('Invitation deleted.'); refreshInvites(); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  const inviteLink = (token: string) => `${typeof window !== 'undefined' ? window.location.origin : ''}/outreach/invite/${token}`;

  if (!workspace) return <PageLoader />;
  if (!isOwner) return <div><PageHeader title="Settings" subtitle={workspace.name} /><SettingsTabs /><ErrorBox message="Only the workspace owner can manage members and invitations." /></div>;
  const pending = (invitations.data ?? []).filter((i) => !i.accepted_at);
  const clientList = clients.data ?? [];

  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <SettingsTabs />

      <Card title="Members" className="mb-6">
        {members.isLoading ? <Spinner /> : members.isError ? <ErrorBox message={(members.error as Error).message} /> : (
          <Table>
            <thead><tr><Th>Member</Th><Th>Role</Th><Th>Client scope</Th><Th>Can reply</Th><Th>Joined</Th><Th></Th></tr></thead>
            <tbody>
              {(members.data ?? []).map((m) => {
                const me = m.user_id === user?.id; const scoped = m.role === 'member' || m.role === 'client_viewer';
                return (
                  <tr key={m.user_id}>
                    <Td><div className="flex items-center gap-2.5"><MemberAvatar member={m} size={8} /><div className="min-w-0"><div className="font-medium text-gray-900">{m.display_name ?? m.email ?? m.user_id.slice(0, 8)}{me && <Badge tone="indigo" className="ml-2">you</Badge>}</div>{m.display_name && m.email && <div className="text-xs text-gray-500">{m.email}</div>}</div></div></Td>
                    <Td>
                      <Select value={m.role} onChange={(e) => updateMember(m, { role: e.target.value as Role })} disabled={me || !canWrite || busy === m.user_id} aria-label={`Role for ${m.email ?? m.user_id}`} className="w-40">
                        {ROLES.map((r) => <option key={r.value} value={r.value} title={r.hint} disabled={viewerLocked(r.value) && m.role !== 'client_viewer'}>{r.label}</option>)}
                      </Select>
                      {viewerLocked(m.role) && <div className="text-xs text-gray-400 mt-1">Access paused by plan</div>}
                    </Td>
                    <Td>{scoped ? <ClientScope value={m.client_ids} clients={clientList} onChange={(ids) => updateMember(m, { client_ids: ids })} disabled={!canWrite || busy === m.user_id} /> : <span className="text-xs text-gray-400">all</span>}</Td>
                    <Td><Toggle checked={m.can_reply} onChange={(v) => updateMember(m, { can_reply: v })} disabled={!canWrite || busy === m.user_id} /></Td>
                    <Td className="whitespace-nowrap">{fmtDate(m.created_at, false)}</Td>
                    <Td className="text-right">{!me && <Button size="sm" variant="ghost" onClick={() => setRemoveTarget(m)} disabled={!canWrite} aria-label="Remove member"><Trash2 className="w-4 h-4 text-red-500" /></Button>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <p className="text-xs text-gray-400 mt-3">Members and client viewers with an empty scope see all clients. Owners and managers always see everything.</p>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card title={<span className="flex items-center gap-2"><UserPlus className="w-4 h-4" /> Invite</span>}>
          <form onSubmit={sendInvite} className="space-y-3">
            <Input label="Email" type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} placeholder="colleague@company.com" disabled={!canWrite} />
            <RolePicker value={invite.role} onChange={(role) => setInvite({ ...invite, role })} isLocked={viewerLocked} disabled={!canWrite} />
            <UpgradeNote feature="client_viewer" what="The client viewer role" />
            {(invite.role === 'member' || invite.role === 'client_viewer') && (
              <div><div className="text-xs font-medium text-gray-600 mb-1">Client scope</div><ClientScope value={invite.client_ids} clients={clientList} onChange={(ids) => setInvite({ ...invite, client_ids: ids })} disabled={!canWrite} />{invite.role === 'client_viewer' && invite.client_ids.length === 0 && clientList.length > 0 && <div className="text-xs text-amber-600 mt-1">Client viewers should be scoped to one client.</div>}</div>
            )}
            <Button type="submit" loading={busy === 'invite'} disabled={!canWrite || !invite.email.trim()} className="w-full"><Mail className="w-4 h-4" /> Send invitation</Button>
          </form>
          {lastInvite && (
            <div className="mt-4 rounded-lg bg-green-50 border border-green-200 p-3 text-xs text-green-900">
              <div className="font-medium">{lastInvite.emailed ? `Emailed to ${lastInvite.email}` : `Created for ${lastInvite.email} (not emailed)`}</div>
              <div className="flex gap-2 mt-2"><input readOnly value={lastInvite.link} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" className="flex-1 px-2 py-1 font-mono rounded border border-green-200 bg-white text-gray-700" /><Button size="sm" variant="secondary" onClick={async () => toast.show((await copyText(lastInvite.link)) ? 'Link copied.' : 'Copy failed.')}><Copy className="w-3.5 h-3.5" /></Button></div>
              <div className="mt-1 text-green-800">Valid for 7 days.</div>
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2" title="Pending invitations" actions={<span className="text-xs text-gray-400">{pending.length} pending</span>}>
          {invitations.isLoading ? <Spinner /> : invitations.isError ? <ErrorBox message={(invitations.error as Error).message} /> : pending.length === 0 ? <EmptyState title="No pending invitations" description="Accepted invitations disappear from this list." /> : (
            <Table>
              <thead><tr><Th>Email</Th><Th>Role</Th><Th>Expires</Th><Th></Th></tr></thead>
              <tbody>
                {pending.map((inv) => {
                  const expired = new Date(inv.expires_at).getTime() < Date.now();
                  return (
                    <tr key={inv.id}>
                      <Td className="font-medium text-gray-900">{inv.email}</Td>
                      <Td><Badge tone="gray">{inv.role.replace('_', ' ')}</Badge>{inv.client_ids.length > 0 && <span className="text-xs text-gray-400 ml-1">{inv.client_ids.length} client{inv.client_ids.length === 1 ? '' : 's'}</span>}</Td>
                      <Td>{expired ? <Badge tone="red">expired</Badge> : <span className="whitespace-nowrap">{fmtDate(inv.expires_at)}</span>}</Td>
                      <Td>
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" title="Copy invitation link" onClick={async () => toast.show((await copyText(inviteLink(inv.token))) ? 'Link copied.' : 'Copy failed.')}><Copy className="w-4 h-4" /></Button>
                          <Button size="sm" variant="ghost" title="Resend (extends 7 days)" onClick={() => resend(inv)} loading={busy === inv.id} disabled={!canWrite}><RefreshCw className="w-4 h-4" /></Button>
                          <Button size="sm" variant="ghost" title="Delete invitation" onClick={() => deleteInvite(inv)} disabled={!canWrite || busy === inv.id}><Trash2 className="w-4 h-4 text-red-500" /></Button>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <Modal open={!!removeTarget} onClose={() => setRemoveTarget(null)} title="Remove member?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setRemoveTarget(null)}>Cancel</Button><Button variant="danger" onClick={removeMember} loading={busy === removeTarget?.user_id}><Check className="w-4 h-4" /> Remove</Button></>}>
        <p className="text-sm text-gray-700"><strong>{removeTarget?.display_name ?? removeTarget?.email}</strong> loses access to this workspace immediately. Chats assigned to them stay assigned until reassigned.</p>
      </Modal>
      {toast.node}
    </div>
  );
}
