'use client';

// Field-level authority from the account owner (PRD §4.2): grants, pending permission links, self-grant when the
// signed-in user owns the account, a permission-link request for managers, and revocation.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Link2, ShieldCheck, ShieldOff, UserCheck } from 'lucide-react';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { Badge, Button, Card, Input, Modal, Select, fmtDate, timeAgo } from '@/components/outreach/ui';
import { copyText } from '@/components/outreach/senders/helpers';
import { FIELD_GROUPS, GROUP_LABELS, profileKeysFor, useProfileAuthority, type FieldGroup } from '@/lib/outreach/profile';
import { cn } from '@/lib/utils';

type Notify = (message: string, type?: 'success' | 'error') => void;

function GroupPicker({ value, onChange, disabled }: { value: FieldGroup[]; onChange: (v: FieldGroup[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {FIELD_GROUPS.map((g) => { const on = value.includes(g); return <button key={g} type="button" disabled={disabled} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== g) : [...value, g])} className={cn('text-xs px-2.5 py-1 rounded-full border', on ? 'bg-indigo-50 border-indigo-300 text-indigo-800' : 'border-gray-200 text-gray-600 hover:bg-gray-50')}>{GROUP_LABELS[g]}</button>; })}
      <button type="button" disabled={disabled} className="text-xs text-gray-500 underline ml-1" onClick={() => onChange(value.length === FIELD_GROUPS.length ? [] : [...FIELD_GROUPS])}>{value.length === FIELD_GROUPS.length ? 'none' : 'all'}</button>
    </div>
  );
}

export default function AuthorityCard({ senderId, ws, ownerEmail, isManager, canWrite, notify, initialOpen }: { senderId: string; ws: string; ownerEmail: string | null; isManager: boolean; canWrite: boolean; notify: Notify; initialOpen?: boolean }) {
  const qc = useQueryClient();
  const auth = useProfileAuthority(senderId);
  const [open, setOpen] = useState<null | 'self' | 'link'>(initialOpen ? 'link' : null);
  const [groups, setGroups] = useState<FieldGroup[]>(['headline', 'about']);
  const [mode, setMode] = useState<'propose_only' | 'direct'>('propose_only');
  const [email, setEmail] = useState(ownerEmail ?? '');
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ link?: string; email_sent: boolean; owner_email: string } | null>(null);
  const invalidate = () => { for (const k of profileKeysFor(senderId, ws)) qc.invalidateQueries({ queryKey: k }); };

  async function grantSelf() {
    setBusy(true);
    try { await rpc('profile_authority_self', { p_sender: senderId, p_groups: groups, p_mode: mode, p_expires_days: days ? Number(days) : null }); notify(`Permission recorded for ${groups.length} field group(s).`); setOpen(null); invalidate(); }
    catch (e) { notify(parseError(e).message, 'error'); } finally { setBusy(false); }
  }
  async function sendLink() {
    setBusy(true);
    try {
      const r = await callFn<{ link?: string; email_sent: boolean; owner_email: string; email_configured: boolean }>('profile', { action: 'authority_link', sender_id: senderId, field_groups: groups, mode, owner_email: email.trim() || undefined, grant_days: days ? Number(days) : undefined });
      setIssued(r);
      notify(r.email_sent ? `Permission request emailed to ${r.owner_email}.` : r.link ? 'Link created. Email delivery is not set up here, so pass the link to the owner yourself.' : 'Link created but nobody could be emailed.', r.email_sent || r.link ? 'success' : 'error');
      invalidate();
    } catch (e) { notify(parseError(e).message, 'error'); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    if (!confirm('Revoke this permission? Changes waiting on it are cancelled.')) return;
    try { await rpc('profile_authority_revoke', { p_authority: id, p_reason: 'revoked in the app' }); notify('Permission revoked.'); invalidate(); } catch (e) { notify(parseError(e).message, 'error'); }
  }

  const d = auth.data;
  const active = (d?.grants ?? []).filter((g) => g.active);
  const pendingLinks = (d?.links ?? []).filter((l) => !l.accepted_at && !l.declined_at && new Date(l.expires_at) > new Date());

  return (
    <Card title={<span className="flex items-center gap-2"><ShieldCheck className="w-4 h-4" /> Owner permission</span>} actions={canWrite ? (
      <div className="flex gap-1.5">
        {d?.caller_is_owner && <Button size="sm" variant="secondary" onClick={() => setOpen('self')}><UserCheck className="w-3.5 h-3.5" /> This is my account</Button>}
        {isManager && <Button size="sm" onClick={() => { setIssued(null); setOpen('link'); }}><Link2 className="w-3.5 h-3.5" /> Ask the owner</Button>}
      </div>) : undefined}>
      <p className="text-xs text-gray-600 mb-3">Editing someone&apos;s headline, About or work history is editing their professional identity, so it needs the account owner&apos;s own permission per field, separate from the outreach connection. <b>Proposals</b>: the owner applies each change with one click from their email. <b>Direct</b>: changes apply on schedule and the owner is emailed afterwards with a revert link.</p>
      {auth.isLoading ? <div className="text-sm text-gray-500">Loading…</div> : active.length === 0 ? (
        <div className="text-sm text-gray-700 bg-amber-50 border border-amber-200 rounded-lg p-3">No permission yet. Nothing can be written to this profile until the owner{d?.owner_email ? ` (${d.owner_email})` : ''} grants it{d?.caller_is_owner ? ', or you confirm this is your own account' : ''}.</div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {active.map((g) => (
            <li key={g.id} className="flex items-center justify-between py-2 text-sm">
              <div className="flex items-center gap-2 min-w-0"><span className="font-medium text-gray-900">{GROUP_LABELS[g.field_group]}</span><Badge tone={g.mode === 'direct' ? 'green' : 'amber'}>{g.mode === 'direct' ? 'Direct' : 'Proposals'}</Badge><span className="text-xs text-gray-500 truncate">by {g.granted_by_email}{g.granted_via === 'owner_is_operator' ? ' (own account)' : ''}{g.expires_at ? ` · until ${fmtDate(g.expires_at, false)}` : ''}</span></div>
              {canWrite && (isManager || d?.caller_is_owner) && <button className="text-xs text-red-600 hover:text-red-800 inline-flex items-center gap-1" onClick={() => revoke(g.id)}><ShieldOff className="w-3 h-3" /> Revoke</button>}
            </li>
          ))}
        </ul>
      )}
      {pendingLinks.length > 0 && <div className="mt-3 text-xs text-gray-600">{pendingLinks.length} permission request{pendingLinks.length > 1 ? 's' : ''} waiting for {pendingLinks[0].owner_email} (sent {timeAgo(pendingLinks[0].created_at)}, valid until {fmtDate(pendingLinks[0].expires_at, false)}).</div>}

      <Modal open={open === 'self'} onClose={() => setOpen(null)} title="Permission for your own account" size="md"
        footer={<><Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button><Button loading={busy} onClick={grantSelf} disabled={!groups.length}>Record permission</Button></>}>
        <div className="space-y-3 text-sm">
          <p className="text-gray-700">You own this account, so you can grant permission to yourself and your team. You will still be emailed after every change.</p>
          <GroupPicker value={groups} onChange={setGroups} />
          <Select label="Mode" value={mode} onChange={(e) => setMode(e.target.value as 'propose_only' | 'direct')}><option value="propose_only">Proposals: I click Apply on each change</option><option value="direct">Direct: changes apply on schedule, I am emailed after</option></Select>
          <Input label="Expires after (days, optional)" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} placeholder="never" />
        </div>
      </Modal>

      <Modal open={open === 'link'} onClose={() => setOpen(null)} title="Ask the account owner for permission" size="md"
        footer={<><Button variant="secondary" onClick={() => setOpen(null)}>Close</Button>{!issued && <Button loading={busy} onClick={sendLink} disabled={!groups.length || !email.trim()}><KeyRound className="w-4 h-4" /> Send request</Button>}</>}>
        <div className="space-y-3 text-sm">
          <p className="text-gray-700">The owner gets a signed link (valid 7 days, no login). They can narrow the request or decline. Direct permission can only be requested for people who agreed to it out of band.</p>
          <Input label="Owner email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@company.com" disabled={!!issued} />
          <GroupPicker value={groups} onChange={setGroups} disabled={!!issued} />
          <Select label="Mode" value={mode} onChange={(e) => setMode(e.target.value as 'propose_only' | 'direct')} disabled={!!issued}><option value="propose_only">Proposals (recommended): the owner applies each change</option><option value="direct">Direct: apply on schedule, owner emailed after</option></Select>
          <Input label="Permission lasts (days, optional)" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} placeholder="until revoked" disabled={!!issued} />
          {issued && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="text-xs text-gray-700">{issued.email_sent ? `Emailed to ${issued.owner_email}.` : 'Email delivery is not set up on this deployment. Copy the link and send it to the owner yourself.'}</div>
              {issued.link && <div className="flex gap-2 mt-2"><input readOnly value={issued.link} onFocus={(e) => e.currentTarget.select()} aria-label="Permission link" className="flex-1 px-2 py-1.5 text-xs font-mono rounded-md border border-gray-200 bg-white" /><Button size="sm" variant="secondary" onClick={async () => notify((await copyText(issued.link!)) ? 'Link copied.' : 'Copy failed.')}><Copy className="w-3.5 h-3.5" /></Button></div>}
            </div>
          )}
        </div>
      </Modal>
    </Card>
  );
}
