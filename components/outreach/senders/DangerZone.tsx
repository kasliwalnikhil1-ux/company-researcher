'use client';

import { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useRouter } from '@/lib/outreach/nav';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Globe, Pause, Play, Power, RotateCcw, Unplug } from 'lucide-react';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { useBilling, useInvalidateBilling } from '@/lib/outreach/billing';
import { qk } from '@/lib/outreach/queries';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { Button, Card, ErrorBox, Input, Modal, SearchableSelect } from '@/components/outreach/ui';
import { BILLING_PAUSE_REASONS, COUNTRIES, billingRefusalRemedy, isBillingRefusal } from './helpers';
import type { Sender } from '@/lib/outreach/types';

type Notify = (message: string, type?: 'success' | 'error') => void;

/** Why Resume is not a manual action for a sender the plan paused. */
function billingPauseText(reason: string | null): string {
  switch (reason) {
    case 'over_plan_limit': return 'Paused because the plan has fewer accounts than are connected. It resumes once the plan has room for it';
    case 'billing_suspended': return 'Paused until the open invoice is paid. It resumes on its own after that';
    case 'billing_cancelled': return 'Paused because the subscription has ended. It resumes when the workspace subscribes again';
    default: return 'Paused for billing; it resumes automatically once the subscription is active';
  }
}

export default function DangerZone({ sender, isManager, canWrite, notify }: { sender: Sender; isManager: boolean; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const router = useRouter();
  const { isOwner } = useWorkspace();
  const billing = useBilling(sender.workspace_id);
  const invalidateBilling = useInvalidateBilling();
  const canEdit = isManager && canWrite;
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  // Re-enable refused by the plan: no free account (E_ACCOUNT_LIMIT) or the plan is not active (E_PLAN_SUSPENDED).
  const [enableRefused, setEnableRefused] = useState<{ code: string; message: string } | null>(null);
  const [deleteUnipile, setDeleteUnipile] = useState(false);
  const [purge, setPurge] = useState(true);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [country, setCountry] = useState('');
  const [proxyError, setProxyError] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.sender(sender.id) }); qc.invalidateQueries({ queryKey: qk.senders(sender.workspace_id) }); qc.invalidateQueries({ queryKey: qk.dashboard(sender.workspace_id) });
    invalidateBilling(sender.workspace_id);   // disconnecting, disabling and re-enabling change how many accounts are in use
  };

  async function togglePause() {
    const pause = sender.status === 'ok';
    setBusy('pause');
    try { await rpc('pause_sender', { p_sender: sender.id, p_pause: pause }); notify(pause ? 'Sender paused. Queued actions stay queued until you resume.' : 'Sender resumed.'); invalidate(); }
    catch (e) { notify(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  async function disable() {
    setBusy('disable'); setError(null);
    try {
      // the connected account is always removed now; delete_unipile only means "also remove the sender from the workspace"
      await callFn<{ ok: boolean; unipile_deleted: boolean }>('sender-disable', { sender_id: sender.id, delete_unipile: deleteUnipile, purge_secrets: purge });
      notify(deleteUnipile ? 'Sender disabled and removed from the workspace.' : 'Sender disabled. Its connected account was removed; re-enable it from its Danger tab to use it again.');
      invalidate(); setOpen(false);
      router.push('/outreach/senders');
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(null); }
  }

  async function disconnect() {
    setBusy('disconnect'); setDisconnectError(null);
    try {
      await callFn<{ ok: boolean; account_deleted: boolean }>('sender-manage', { sender_id: sender.id, action: 'disconnect' });
      notify('Account disconnected. The sender, its conversations and its leads are kept.');
      invalidate(); setDisconnectOpen(false);
    } catch (e) { setDisconnectError(parseError(e).message); }
    finally { setBusy(null); }
  }

  async function enable() {
    setBusy('enable'); setEnableRefused(null);
    try {
      await callFn('sender-manage', { sender_id: sender.id, action: 'enable' });
      notify('Sender re-enabled. Use Reconnect at the top of this page to sign in again.');
      invalidate();
    } catch (e) {
      const err = parseError(e);
      if (isBillingRefusal(err.code)) { setEnableRefused({ code: err.code, message: err.message }); invalidateBilling(sender.workspace_id); }
      else notify(err.message, 'error');
    }
    finally { setBusy(null); }
  }

  async function changeProxy() {
    if (!country) return;
    setBusy('proxy'); setProxyError(null);
    try {
      await callFn('sender-update-proxy', { sender_id: sender.id, country });
      notify(`Proxy moved to ${country}. The account now connects from a new IP; the change is audited.`);
      invalidate(); setProxyOpen(false); setCountry('');
    } catch (e) { setProxyError(parseError(e).message); }
    finally { setBusy(null); }
  }

  if (!canEdit) return <ErrorBox message={canWrite ? 'Only owners and managers can pause or disable senders.' : 'This workspace is read-only, so senders cannot be changed right now.'} />;
  const expected = (sender.display_name ?? 'disable').trim();
  const isDisabled = sender.status === 'disabled';
  const isLinkedIn = sender.provider === 'LINKEDIN';
  const countryName = (code: string) => { const c = COUNTRIES.find((x) => x.code === code); return c ? `${c.name} (${code})` : code; };
  // paused by the plan (unpaid invoice, ended subscription, fewer accounts than connected): Resume is not a manual action
  const billingPaused = sender.status === 'paused' && BILLING_PAUSE_REASONS.includes(sender.status_reason ?? '');
  const isDisconnected = sender.status === 'disconnected';
  const canDisconnect = !isDisabled && !isDisconnected && sender.provider !== 'WEBCHAT';
  const enableRemedy = enableRefused ? billingRefusalRemedy(enableRefused.code, billing.data, isOwner) : null;

  return (
    <div className="space-y-6">
      <Card title="Pause / resume">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-sm text-gray-700">
            {billingPaused ? <>This sender is <strong>paused</strong> by the plan. {billingPauseText(sender.status_reason)}.</> :
              sender.status === 'paused' ? <>This sender is <strong>paused</strong>{sender.status_reason ? ` (${sender.status_reason})` : ''}. Nothing is sent until you resume.</> :
              sender.status === 'ok' ? <>Pausing holds every queued action and stops the planner for this sender. Enrollments keep their place and continue when resumed.</> :
                <>Pause/resume is only available while the sender is connected (current status: <strong>{sender.status}</strong>).</>}
          </div>
          {sender.status === 'paused' ? (
            <Button variant="secondary" onClick={togglePause} loading={busy === 'pause'} disabled={billingPaused} title={billingPaused ? billingPauseText(sender.status_reason) : undefined}><Play className="w-4 h-4" /> Resume</Button>
          ) : (
            <Button variant="secondary" onClick={togglePause} loading={busy === 'pause'} disabled={sender.status !== 'ok'}><Pause className="w-4 h-4" /> Pause sender</Button>
          )}
        </div>
      </Card>

      {isLinkedIn && (
        <Card title={<span className="flex items-center gap-2"><Globe className="w-4 h-4" /> Change proxy country</span>}>
          <div className="text-sm text-gray-700 space-y-1.5">
            <p>This sender’s traffic goes through a fixed proxy IP that was pinned when the owner opened the sign-in link{sender.proxy_country ? <>; it was last set to <strong>{countryName(sender.proxy_country)}</strong> from this app</> : null}. LinkedIn expects that location to stay the same.</p>
            <p>Change it only to correct a wrong pin, for example when someone opened the connect link from a country the owner does not live in. Moving a healthy account to a new IP can trigger a security check or a temporary restriction.</p>
          </div>
          <div className="mt-4">
            <Button variant="secondary" onClick={() => { setProxyOpen(true); setCountry(''); setProxyError(null); }} disabled={!sender.unipile_account_id || isDisabled}><Globe className="w-4 h-4" /> Change proxy country…</Button>
            {!sender.unipile_account_id && <span className="ml-3 text-xs text-gray-400">Available once the sender is connected.</span>}
          </div>
        </Card>
      )}

      {canDisconnect && (
        <Card title={<span className="flex items-center gap-2"><Unplug className="w-4 h-4" /> Disconnect account</span>}>
          <div className="text-sm text-gray-700 space-y-1.5">
            <p>Disconnecting removes the connected account from this workspace&apos;s plan and frees one account. The sender, its conversations and its leads stay; leads in its sequences wait and carry on after you reconnect.</p>
            <p>Reconnecting later needs the same account to sign in again, and a free account on the plan.</p>
          </div>
          <div className="mt-4">
            <Button variant="secondary" onClick={() => { setDisconnectOpen(true); setDisconnectError(null); }}><Unplug className="w-4 h-4" /> Disconnect account…</Button>
          </div>
        </Card>
      )}

      {isDisabled && (
        <Card title={<span className="flex items-center gap-2"><RotateCcw className="w-4 h-4" /> Re-enable sender</span>}>
          <div className="text-sm text-gray-700 space-y-1.5">
            <p>This sender is disabled and its connected account was removed. Re-enabling brings it back as disconnected: it needs a free account on the plan, and the owner then signs in again with the same account.</p>
            <p>Its leads were taken out of their sequences when it was disabled; enrol them again once it is connected.</p>
          </div>
          {enableRefused && enableRemedy && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
              <div className="font-medium">{enableRefused.message}</div>
              <div className="mt-2">{enableRemedy.href ? <Link href={enableRemedy.href}><Button size="sm">{enableRemedy.label}</Button></Link> : enableRemedy.label}</div>
            </div>
          )}
          <div className="mt-4">
            <Button variant="secondary" onClick={enable} loading={busy === 'enable'} disabled={!!busy}><RotateCcw className="w-4 h-4" /> Re-enable sender</Button>
          </div>
        </Card>
      )}

      <Card title={<span className="flex items-center gap-2 text-red-700"><AlertTriangle className="w-4 h-4" /> Disable sender</span>} className="border-red-200">
        <div className="text-sm text-gray-700 space-y-1.5">
          <p>Disabling cancels every planned action, takes this sender&apos;s leads out of their sequences, and stops syncing. Chats and history stay readable.</p>
          <p>The connected account and the saved sign-in are removed, which frees one account on the plan. To use this sender again you re-enable it here and the owner signs in again.</p>
          <p>You can also remove the sender from the workspace. That cannot be undone.</p>
        </div>
        <div className="mt-4">
          <Button variant="danger" onClick={() => { setOpen(true); setConfirmText(''); setError(null); }} disabled={isDisabled}><Power className="w-4 h-4" /> {isDisabled ? 'Already disabled' : 'Disable sender…'}</Button>
        </div>
      </Card>

      <Modal open={disconnectOpen} onClose={() => setDisconnectOpen(false)} title="Disconnect this account?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setDisconnectOpen(false)} disabled={busy === 'disconnect'}>Cancel</Button><Button variant="danger" onClick={disconnect} loading={busy === 'disconnect'}>Disconnect account</Button></>}>
        <div className="space-y-3">
          <p className="text-sm text-gray-700">The connected account of <strong>{sender.display_name ?? 'this sender'}</strong> is removed from this workspace and one account on the plan becomes free. Nothing is sent from it until it is reconnected.</p>
          <p className="text-sm text-gray-700">The sender, its conversations and its leads are kept. To reconnect, the same account signs in again; a different account is refused.</p>
          {disconnectError && <ErrorBox message={disconnectError} />}
        </div>
      </Modal>

      <Modal open={proxyOpen} onClose={() => setProxyOpen(false)} title="Move this sender's proxy?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setProxyOpen(false)}>Cancel</Button><Button variant="danger" onClick={changeProxy} loading={busy === 'proxy'} disabled={!country || country === (sender.proxy_country ?? '')}>Move proxy</Button></>}>
        <div className="space-y-4">
          <p className="text-sm text-gray-700">LinkedIn will see <strong>{sender.display_name ?? 'this sender'}</strong> connecting from a new IP in the country you pick. Choose the country where the account owner really is.</p>
          <SearchableSelect value={country} onChange={setCountry} aria-label="Proxy country" placeholder="Select country…" searchPlaceholder="Search country or code…" options={COUNTRIES.map((c) => ({ value: c.code, label: c.name, hint: c.code }))} />
          {proxyError && <ErrorBox message={proxyError} />}
        </div>
      </Modal>

      <Modal open={open} onClose={() => setOpen(false)} title="Disable this sender?" size="md"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" onClick={disable} loading={busy === 'disable'} disabled={confirmText.trim() !== expected}>Disable sender</Button></>}>
        <div className="space-y-4">
          <p className="text-sm text-gray-700">You are about to disable <strong>{sender.display_name ?? 'this sender'}</strong>. Queued actions are cancelled and live enrollments exit immediately. Its connected account is removed and frees one account on the plan.</p>
          <label className="flex items-start gap-2 text-sm text-gray-800">
            <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-red-600 focus:ring-red-500" checked={deleteUnipile} onChange={(e) => { setDeleteUnipile(e.target.checked); if (e.target.checked) setPurge(true); }} />
            <span><span className="font-medium">Also remove this sender from the workspace</span><br /><span className="text-gray-500">It leaves the senders list and cannot be re-enabled. Permanent.</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-800">
            <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-red-600 focus:ring-red-500" checked={purge} disabled={deleteUnipile} onChange={(e) => setPurge(e.target.checked)} />
            <span><span className="font-medium">Purge stored secrets</span><br /><span className="text-gray-500">Erases encrypted cookies and the extension pairing token.</span></span>
          </label>
          <Input label={`Type “${expected}” to confirm`} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
          {error && <ErrorBox message={error} />}
        </div>
      </Modal>
    </div>
  );
}
