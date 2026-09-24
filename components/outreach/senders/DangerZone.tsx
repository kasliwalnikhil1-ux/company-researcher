'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Globe, Pause, Play, Power } from 'lucide-react';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import { Button, Card, ErrorBox, Input, Modal, SearchableSelect } from '@/components/outreach/ui';
import { COUNTRIES } from './helpers';
import type { Sender } from '@/lib/outreach/types';

type Notify = (message: string, type?: 'success' | 'error') => void;

export default function DangerZone({ sender, isManager, canWrite, notify }: { sender: Sender; isManager: boolean; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const router = useRouter();
  const canEdit = isManager && canWrite;
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [deleteUnipile, setDeleteUnipile] = useState(false);
  const [purge, setPurge] = useState(true);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [country, setCountry] = useState('');
  const [proxyError, setProxyError] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.sender(sender.id) }); qc.invalidateQueries({ queryKey: qk.senders(sender.workspace_id) }); qc.invalidateQueries({ queryKey: qk.dashboard(sender.workspace_id) });
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
      const r = await callFn<{ ok: boolean; unipile_deleted: boolean }>('sender-disable', { sender_id: sender.id, delete_unipile: deleteUnipile, purge_secrets: purge });
      notify(deleteUnipile ? (r.unipile_deleted ? 'Sender disabled and the connected account deleted.' : 'Sender disabled. Deleting the connected account failed and was logged.') : 'Sender disabled.');
      invalidate(); setOpen(false);
      router.push('/outreach/senders');
    } catch (e) { setError(parseError(e).message); }
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
  const billingPaused = sender.status === 'paused' && ['billing_suspended', 'trial_expired'].includes(sender.status_reason ?? '');

  return (
    <div className="space-y-6">
      <Card title="Pause / resume">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-sm text-gray-700">
            {sender.status === 'paused' ? <>This sender is <strong>paused</strong>{sender.status_reason ? ` (${sender.status_reason})` : ''}. Nothing is sent until you resume.</> :
              sender.status === 'ok' ? <>Pausing holds every queued action and stops the planner for this sender. Enrollments keep their place and continue when resumed.</> :
                <>Pause/resume is only available while the sender is connected (current status: <strong>{sender.status}</strong>).</>}
          </div>
          {sender.status === 'paused' ? (
            <Button variant="secondary" onClick={togglePause} loading={busy === 'pause'} disabled={billingPaused} title={billingPaused ? 'Paused for billing; it resumes automatically once the subscription is active' : undefined}><Play className="w-4 h-4" /> Resume</Button>
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

      <Card title={<span className="flex items-center gap-2 text-red-700"><AlertTriangle className="w-4 h-4" /> Disable sender</span>} className="border-red-200">
        <div className="text-sm text-gray-700 space-y-1.5">
          <p>Disabling cancels every queued action, exits all live enrollments with <code className="text-xs bg-gray-100 px-1 rounded">exited_sender_disabled</code>, and stops all syncing. Chats and history stay readable.</p>
          <p>Optionally delete the connected account (revokes the held session token) and purge stored cookies / pairing tokens. Deleting the connected account cannot be undone; you would reconnect from scratch.</p>
        </div>
        <div className="mt-4">
          <Button variant="danger" onClick={() => { setOpen(true); setConfirmText(''); setError(null); }} disabled={isDisabled}><Power className="w-4 h-4" /> {isDisabled ? 'Already disabled' : 'Disable sender…'}</Button>
        </div>
      </Card>

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
          <p className="text-sm text-gray-700">You are about to disable <strong>{sender.display_name ?? 'this sender'}</strong>. Queued actions are cancelled and live enrollments exit immediately.</p>
          <label className="flex items-start gap-2 text-sm text-gray-800">
            <input type="checkbox" className="mt-0.5 rounded border-gray-300 text-red-600 focus:ring-red-500" checked={deleteUnipile} onChange={(e) => { setDeleteUnipile(e.target.checked); if (e.target.checked) setPurge(true); }} />
            <span><span className="font-medium">Delete the connected account</span><br /><span className="text-gray-500">Revokes the session token held on the owner’s behalf and removes the account from the connector. Permanent.</span></span>
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
