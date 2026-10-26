'use client';

// Sender page → "Whose account". Every email about the account goes to the sign-in email of the member who holds it, never to
// a typed address (migration 103). Managers (or the member who holds it) can hand it to another teammate; a change cancels
// open sign-in / permission links and resets grants. While the account is signed out the card shows the sign-in email clock
// and "Send a new sign-in link".
import { useState } from 'react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useMembers } from '@/lib/outreach/queries';
import { MemberPicker } from '@/components/outreach/members';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Mail, UserCheck, Users } from 'lucide-react';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import { useSessionUser } from '@/lib/outreach/session';
import { Badge, Button, Card, Modal, fmtDate, timeAgo } from '@/components/outreach/ui';
import { disconnectBadge } from './helpers';
import type { Sender } from '@/lib/outreach/types';

type Notify = (message: string, type?: 'success' | 'error') => void;

export interface HolderView {
  kind: 'member' | 'member_left' | 'none';
  user_id: string | null;
  name: string | null;
  mine: boolean;
  email: string | null;
  connected_by: { user_id: string; name: string | null; member: boolean } | null;
  copied_to: string[];
  can_change: boolean;
  holder_notified_at: string | null;
  holder_reminders_sent: number;
  holder_email_held_until: string | null;
  disconnected_at: string | null;
}

interface LastEmail { type: string; to: string; status: string; sent_at: string; updated_at: string; bounce_type: string | null; outside: boolean }

export const holderKey = (id: string) => [...qk.sender(id), 'holder'] as const;
export function useHolderView(senderId: string | null | undefined) {
  return useQuery({ queryKey: holderKey(senderId ?? ''), enabled: !!senderId, queryFn: () => rpc<HolderView>('sender_holder_view', { p_sender: senderId }) });
}

/** "you (maya@…)", "Sam (team)". */
export function holderText(h: HolderView | null | undefined, fallback = 'the account holder'): string {
  if (!h || h.kind === 'none') return fallback;
  if (h.mine) return `you${h.email ? ` (${h.email})` : ''}`;
  if (h.kind === 'member_left') return h.name ? `${h.name} (team)` : 'the workspace owners';
  return h.name ? `${h.name} (team)` : fallback;
}

const EMAIL_TYPE_TEXT: Record<string, string> = {
  sender_reconnect_needed: 'Sign-in email', sender_reconnect_reminder: 'Sign-in reminder', sender_reconnect_manual: 'Sign-in email', sender_connected_notice: 'Connection notice',
  ai_reply_consent_request: 'AI replies permission request', ai_reply_consent_confirmed: 'AI replies confirmation', profile_authority_request: 'Profile permission request',
  profile_change_applied: 'Profile change notice', profile_change_proposed: 'Profile change proposal', sender_removed_notice: 'Disconnect notice', sender_auto_remove_notice: 'Removal notice',
  sender_erase_notice: 'Erase notice', sender_holder_changed: 'Holder change notice', sender_removal_billing_notice: 'Billing disconnect notice', sender_reconnect_after_billing: 'Sign-in email',
};
const STATUS_TEXT: Record<string, string> = { sent: 'sent', delivered: 'delivered', delayed: 'delayed', bounced: 'bounced', complained: 'marked as spam', failed: 'failed', suppressed: 'not delivered (address blocked)' };

export default function WhoseAccountCard({ sender, canManage, notify }: { sender: Sender; canManage: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const { user } = useSessionUser();
  const holder = useHolderView(sender.id);
  const last = useQuery({ queryKey: [...qk.sender(sender.id), 'last-holder-email'] as const, queryFn: () => rpc<LastEmail | null>('email_log_sender_last', { p_sender: sender.id }) });
  const [open, setOpen] = useState(false);
  const { workspace } = useWorkspace();
  const members = useMembers(open ? workspace?.id : null);
  const [choice, setChoice] = useState<'mine' | 'other'>('mine');
  const [teammate, setTeammate] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const h = holder.data ?? null;
  const signedOut = sender.status === 'credentials' || sender.status === 'error';
  const erased = sender.status === 'erased';
  const canChange = canManage || !!h?.can_change;
  const badge = disconnectBadge(sender);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: holderKey(sender.id) });
    qc.invalidateQueries({ queryKey: qk.sender(sender.id) });
    qc.invalidateQueries({ queryKey: qk.senders(sender.workspace_id) });
    qc.invalidateQueries({ queryKey: [...qk.sender(sender.id), 'last-holder-email'] });
  };

  function openChange() {
    const other = h?.kind === 'member' && !h.mine && h.user_id ? h.user_id : '';
    setChoice(other ? 'other' : 'mine'); setTeammate(other); setError(null); setOpen(true);
  }

  async function save() {
    setBusy('save'); setError(null);
    try {
      const r = await callFn<{ changed: boolean; links_cancelled?: number; grants_revoked?: number; notify_member?: string | null }>('sender-lifecycle', { sender_id: sender.id, action: 'set_holder', holder: choice === 'mine' ? { mine: true } : { user_id: teammate } });
      setOpen(false);
      if (!r.changed) notify('Nothing changed.');
      else notify(`Saved.${(r.links_cancelled ?? 0) > 0 || (r.grants_revoked ?? 0) > 0 ? ' Open sign-in links were cancelled and permissions reset; the new person grants them again.' : ''}${r.notify_member ? ' Your teammate has been told.' : ''}`);
      invalidate();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(null); }
  }

  async function sendLink() {
    setBusy('link');
    try {
      const r = await callFn<{ sent: boolean; to: string | null }>('sender-lifecycle', { sender_id: sender.id, action: 'send_signin_link' });
      notify(r.to ? `Sign-in email sent to ${r.to}. The reminder clock starts again.` : 'Sign-in email sent.');
      invalidate();
    } catch (e) { notify(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  const title = <span className="flex items-center gap-2"><UserCheck className="w-4 h-4" /> Whose account</span>;
  if (erased) return null;

  return (
    <Card title={title} actions={canChange && h && h.kind !== 'none' ? <Button size="sm" variant="secondary" onClick={openChange} disabled={!!busy}>Change</Button> : undefined}>
      {holder.isLoading ? <div className="text-sm text-gray-400">Loading…</div> : holder.isError ? <div className="text-sm text-red-700">{parseError(holder.error).message}</div> : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {h?.kind === 'member' ? (
              <>
                <span className="font-medium text-gray-900">{h.mine ? `Yours${h.email ? ` (${h.email})` : ''}` : `${h.name ?? 'A teammate'}'s`}</span>
                <Badge tone="indigo">{h.mine ? 'You' : 'Team'}</Badge>
              </>
            ) : h?.kind === 'member_left' ? (
              <>
                <span className="font-medium text-gray-900">Nobody</span>
                <span className="text-gray-600">{h.name ? `the person who held it left; emails go to ${h.name}` : 'the person who held it left the workspace; emails go to the owners'}</span>
              </>
            ) : <span className="text-gray-500">No holder on record.</span>}
          </div>
          <p className="text-xs text-gray-500">
            Sign-in links, permission requests and notices about this account go to this person&apos;s sign-in email.
          </p>
          {last.data && (
            <div className="flex items-center gap-1.5 text-xs text-gray-600" title={fmtDate(last.data.updated_at)}>
              <Mail className="w-3.5 h-3.5 text-gray-400" />
              <span>{EMAIL_TYPE_TEXT[last.data.type] ?? 'Email'} to {last.data.to} · <span className={last.data.status === 'bounced' || last.data.status === 'failed' || last.data.status === 'suppressed' ? 'text-red-700 font-medium' : last.data.status === 'delivered' ? 'text-green-700' : ''}>{STATUS_TEXT[last.data.status] ?? last.data.status}</span> {fmtDate(last.data.status === 'sent' ? last.data.sent_at : last.data.updated_at, false)}</span>
            </div>
          )}
          {signedOut && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2">
              {badge && <div className={badge.held ? 'text-amber-800' : 'text-red-800'}>{badge.text}{sender.disconnected_at ? ` (${timeAgo(sender.disconnected_at)})` : ''}</div>}
              {badge?.held && <div className="text-xs text-amber-800">Several accounts dropped at once. Sign-in emails are held until {fmtDate(sender.holder_email_held_until)} in case the provider recovers on its own.</div>}
              {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={sendLink} loading={busy === 'link'} disabled={!!busy}><KeyRound className="w-3.5 h-3.5" /> Send a new sign-in link</Button>
                  <span className="text-xs text-gray-600">Emails {holderText(h)} and starts the reminder clock again.</span>
                </div>
              )}
            </div>
          )}
          {!canChange && h && h.kind !== 'none' && <p className="text-xs text-gray-400">Only a manager, or the person who holds this account, can change it.</p>}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Whose account is this?" size="md"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} loading={busy === 'save'} disabled={choice === 'other' && !teammate}>Save</Button></>}>
        <div className="space-y-3 text-sm text-gray-700">
          <label className="flex items-start gap-2 cursor-pointer p-3 rounded-lg border border-gray-200 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50">
            <input type="radio" name="holder" className="mt-0.5 text-indigo-600 focus:ring-indigo-500" checked={choice === 'mine'} onChange={() => setChoice('mine')} />
            <span><span className="font-medium text-gray-900">Mine.</span> Emails about it go to {user?.email ?? 'your sign-in email'}.</span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer p-3 rounded-lg border border-gray-200 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50">
            <input type="radio" name="holder" className="mt-0.5 text-indigo-600 focus:ring-indigo-500" checked={choice === 'other'} onChange={() => setChoice('other')} />
            <span className="flex-1 min-w-0">
              <span className="font-medium text-gray-900">A teammate&apos;s.</span>
              <span className="block mt-2" onClick={() => setChoice('other')}><MemberPicker value={teammate} onChange={(id) => { setTeammate(id); setChoice('other'); }} members={(members.data ?? []).filter((m) => m.role !== 'client_viewer')} currentUserId={user?.id ?? null} allowEmpty={false} emptyLabel="Choose a teammate" aria-label="Teammate" /></span>
              <span className="block text-xs text-gray-500 mt-1">Emails about the account go to their sign-in email. Someone outside the team has to be invited to the workspace first.</span>
            </span>
          </label>
          <p className="text-xs text-gray-500 flex items-start gap-1.5"><Users className="w-3.5 h-3.5 mt-0.5 shrink-0" /> Changing the holder cancels open sign-in, permission and disconnect links and resets AI-reply and profile permissions; the new person grants them again. The old outside address, if any, is told.</p>
          {error && <div className="text-sm text-red-700">{error}</div>}
        </div>
      </Modal>
    </Card>
  );
}
