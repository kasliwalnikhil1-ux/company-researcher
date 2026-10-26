'use client';

// Sender page → Account tab (sender-lifecycle-PRD.md §8.2). Four actions, each one step further than the last:
//   Pause / Resume   sending stops, leads stay, manual replies still go out
//   Disable / Enable leads leave their sequences, the connector link stays (late replies arrive), the paid account stays used
//   Remove           connector account unlinked and deleted, stored sign-in wiped, paid account freed; history stays
//   Erase…           owner only, typed name, scheduled 24 h ahead, cancellable; conversations and personal data gone for good
// Every dialog shows the counts from the preview before its button is enabled. The proxy-country card stays here too.
import { useRef, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Globe, Pause, Play, Power, RotateCcw, Trash2, Unplug, Users } from 'lucide-react';
import { callFn, parseError } from '@/lib/outreach/api';
import { useBilling, useInvalidateBilling } from '@/lib/outreach/billing';
import { qk } from '@/lib/outreach/queries';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { Badge, Button, Card, ErrorBox, Input, Modal, SearchableSelect, fmtDate } from '@/components/outreach/ui';
import { BILLING_PAUSE_REASONS, COUNTRIES, PROVIDER_LABELS, billingRefusalRemedy, isBillingRefusal, lifecycleBadge, removedReasonText } from './helpers';
import { commitEnrollment, runEnrollPreview } from '@/app/outreach/sequences/[id]/enroll/EnrollGuard';
import type { EnrollPreview, Sender } from '@/lib/outreach/types';

type Notify = (message: string, type?: 'success' | 'error') => void;

interface Preview {
  sender: { id: string; name: string | null; provider: string; status: string; unipile_linked: boolean; auto_remove_after_days: number; auto_remove_at: string | null; erase_scheduled_at: string | null; pause_resume_at: string | null; removal_pending: boolean };
  queued_actions: number; in_flight_actions: number; live_enrollments: number;
  sequences: Array<{ sequence_id: string; name: string; status: string; leads: number; other_active_senders: number }>;
  sequences_left_without_sender: number; rules_to_pause: number; imports_to_pause: number; ai_runs_scheduled: number; profile_changes_queued: number;
  open_tasks: number; chats: number; messages: number; leads_contacted: number; ai_consents: number; profile_authority: number; slot_freed: boolean;
}
type Exited = Array<{ sequence_id: string; name: string; lead_ids: string[] }>;
type Action = 'pause' | 'resume' | 'disable' | 'enable' | 'remove' | 'erase';

const n = (v: number, one: string, many = `${one}s`) => `${v.toLocaleString()} ${v === 1 ? one : many}`;

/** Why Resume is not a manual action for a sender the plan paused. */
function billingPauseText(reason: string | null): string {
  switch (reason) {
    case 'over_plan_limit': return 'Paused because the plan has fewer accounts than are connected. It resumes once the plan has room for it';
    case 'billing_suspended': return 'Paused until the open invoice is paid. It resumes on its own after that';
    case 'billing_cancelled': return 'Paused because the subscription has ended. It resumes when the workspace subscribes again';
    default: return 'Paused for billing; it resumes automatically once the subscription is active';
  }
}

/** The counts a dialog lists (PRD §3.3 / §3.4). */
function PreviewList({ p, action }: { p: Preview | null; action: Action }) {
  if (!p) return <div className="text-sm text-gray-500">Checking what this changes…</div>;
  const items: string[] = [];
  if (action === 'pause') {
    items.push(`${n(p.queued_actions, 'queued action')} wait until you resume`);
    items.push(`${n(p.live_enrollments, 'lead')} stay in their sequences and continue on resume`);
    items.push('Replies from the inbox still go out');
  } else {
    if (action !== 'enable') {
      items.push(`${n(p.queued_actions + p.in_flight_actions, 'queued action')} ${p.in_flight_actions ? `are cancelled (${p.in_flight_actions} already sending will finish)` : 'are cancelled'}`);
      const stops = p.sequences_left_without_sender;
      items.push(`${n(p.live_enrollments, 'lead')} leave ${n(p.sequences.length, 'sequence')}${stops ? `. ${n(stops, 'sequence has', 'sequences have')} no other active sender and will stop sending` : ''}`);
      if (p.imports_to_pause || p.rules_to_pause) items.push(`${[p.imports_to_pause ? n(p.imports_to_pause, 'import job') : '', p.rules_to_pause ? n(p.rules_to_pause, 'auto-enrol rule') : ''].filter(Boolean).join(' and ')} ${action === 'disable' ? 'are paused' : 'stop'}`);
      if (p.ai_runs_scheduled) items.push(`${n(p.ai_runs_scheduled, 'scheduled AI reply', 'scheduled AI replies')} are cancelled; drafts are kept`);
      if (p.profile_changes_queued) items.push(`${n(p.profile_changes_queued, 'queued profile change')} are cancelled`);
    }
    if (action === 'disable') {
      items.push('New replies keep arriving. You can enable it again any time');
      items.push(`It still uses one of your paid accounts. If it stays disabled for ${p.sender.auto_remove_after_days} days we remove it automatically`);
    }
    if (action === 'remove') {
      items.push(p.sender.unipile_linked ? 'The account is unlinked and its stored sign-in is deleted' : 'Its stored sign-in is deleted');
      items.push(`All conversations (${n(p.chats, 'chat')}), the contact history of ${n(p.leads_contacted, 'lead')} and every report number stay`);
      if (p.slot_freed) items.push('This frees one of your paid accounts');
      if (p.ai_consents || p.profile_authority) items.push('AI-reply consent and profile authority are revoked');
      items.push('To use this account again, the owner has to sign in again. Its history comes back when they do');
      if (p.sender.provider === 'LINKEDIN') items.push('LinkedIn may still list our session under the owner’s active sessions. They can end it there');
      if (p.sender.provider === 'WHATSAPP') items.push('The owner can unlink the device in WhatsApp → Linked devices');
    }
    if (action === 'erase') {
      items.push(`${n(p.chats, 'conversation')} with ${n(p.messages, 'message')} are deleted for good`);
      items.push('Report numbers stay, shown as “Erased sender”; leads still count as contacted');
      if (p.sender.status !== 'removed') items.push(p.slot_freed ? 'The account is removed first (unlinked, sign-in wiped, paid account freed)' : 'The account is removed first');
      items.push('Scheduled 24 hours ahead. You can cancel until then; after that it cannot be undone');
    }
    if (action === 'enable') {
      items.push('Sequence sends start again for leads that are enrolled with this sender');
      items.push('Leads that left when it was disabled do not come back by themselves');
      if (p.rules_to_pause || p.imports_to_pause) items.push('Paused auto-enrol rules and imports stay paused until you resume them');
    }
  }
  return <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">{items.map((t) => <li key={t}>{t}</li>)}</ul>;
}

export default function DangerZone({ sender, isManager, canWrite, notify }: { sender: Sender; isManager: boolean; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const { isOwner } = useWorkspace();
  const billing = useBilling(sender.workspace_id);
  const invalidateBilling = useInvalidateBilling();
  const canEdit = isManager && canWrite;
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Action | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');
  const [resumeAt, setResumeAt] = useState('');
  const [reenrol, setReenrol] = useState(false);
  const [refused, setRefused] = useState<{ code: string; message: string } | null>(null);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [country, setCountry] = useState('');
  const [proxyError, setProxyError] = useState<string | null>(null);
  // re-enrol with other senders (D6): after the disable, one enrol preview per sequence the leads left
  const [reenrolState, setReenrolState] = useState<{ exited: Exited; previews: Record<string, EnrollPreview | null>; done: Record<string, number> } | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.sender(sender.id) }); qc.invalidateQueries({ queryKey: qk.senders(sender.workspace_id) }); qc.invalidateQueries({ queryKey: qk.dashboard(sender.workspace_id) });
    qc.invalidateQueries({ queryKey: qk.senderEvents(sender.id) }); qc.invalidateQueries({ queryKey: qk.sequences(sender.workspace_id) });
    invalidateBilling(sender.workspace_id);   // removing frees an account; disabling keeps it
  };

  // the preview is fetched when a dialog opens (an event, not an effect); a dialog closed before the answer ignores it
  const previewRun = useRef(0);
  const open = (a: Action) => {
    setDialog(a); setPreview(null); setError(null); setConfirmText(''); setReason(''); setResumeAt(''); setReenrol(false); setRefused(null); setReenrolState(null);
    const mine = ++previewRun.current;
    callFn<Preview>('sender-lifecycle', { sender_id: sender.id, action: 'preview', preview_action: a })
      .then((p) => { if (previewRun.current === mine) setPreview(p); })
      .catch((e) => { if (previewRun.current === mine) setError(parseError(e).message); });
  };
  const close = () => { if (!busy) { previewRun.current++; setDialog(null); setReenrolState(null); } };

  async function act(action: Exclude<Action, 'erase'> | 'erase_schedule' | 'erase_cancel', extra: Record<string, unknown> = {}) {
    setBusy(action); setError(null); setRefused(null);
    try {
      const r = await callFn<Record<string, unknown>>('sender-lifecycle', { sender_id: sender.id, action, ...extra });
      invalidate();
      return r;
    } catch (e) {
      const err = parseError(e);
      if (isBillingRefusal(err.code)) setRefused({ code: err.code, message: err.message }); else setError(err.message);
      return null;
    } finally { setBusy(null); }
  }

  async function doPause() {
    const at = resumeAt ? new Date(resumeAt) : null;
    const r = await act('pause', { resume_at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null });
    if (r) { notify(at ? `Sender paused until ${fmtDate(at.toISOString())}. Replies still go out.` : 'Sender paused. Replies still go out; sequence sends wait.'); close(); }
  }
  async function doResume() {
    const r = await act('resume');
    if (r) { notify(`Sender resumed.${Number(r.backlog_spread) > 0 ? ` ${r.backlog_spread} overdue actions were spread over the next days.` : ''}`); close(); }
  }
  async function doDisable() {
    const r = await act('disable', { reason: reason.trim() || null });
    if (!r) return;
    const exited = (r.exited as Exited | undefined) ?? [];
    notify('Sender disabled. Its leads left their sequences; late replies still arrive.');
    if (reenrol && exited.some((x) => x.lead_ids.length)) {
      // one preview per sequence, with the fresh-sender rule: only a sender who never contacted the lead
      const previews: Record<string, EnrollPreview | null> = {};
      for (const x of exited) {
        try { previews[x.sequence_id] = await runEnrollPreview(x.sequence_id, x.lead_ids, null, false, 'fresh_sender'); }
        catch (e) { previews[x.sequence_id] = null; setError(parseError(e).message); }
      }
      setReenrolState({ exited, previews, done: {} });
    } else close();
  }
  async function doReenrol(seqId: string) {
    const x = reenrolState?.exited.find((e) => e.sequence_id === seqId);
    const pv = reenrolState?.previews[seqId];
    if (!x || !pv || !pv.eligible_ids.length) return;
    setBusy(`reenrol:${seqId}`); setError(null);
    try {
      const r = await commitEnrollment(seqId, pv.eligible_ids, { senderId: null, priority: 100, includeReplied: false, waitEnrichment: null, assignment: 'fresh_sender' });
      setReenrolState((s) => (s ? { ...s, done: { ...s.done, [seqId]: r.enrolled } } : s));
      notify(`${n(r.enrolled, 'lead')} re-enrolled in ${x.name} with other senders.`);
      qc.invalidateQueries({ queryKey: qk.sequence(seqId) });
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(null); }
  }
  async function doEnable() {
    const r = await act('enable');
    if (!r) return;
    const st = String(r.state ?? 'ok');
    notify(st === 'ok' ? 'Sender enabled. Enrol leads again where you want it.' : st === 'removed' ? 'This sender has no connected account left, so it is now a removed sender. Reconnect it from the top of the page.' : `Sender enabled, but the account needs a sign-in (${st}). Use Reconnect at the top of the page.`);
    close();
  }
  async function doRemove() {
    const r = await act('remove', { reason: reason.trim() || null });
    if (!r) return;
    notify(r.state === 'removal_pending' ? 'Removal requested. The connector has not confirmed yet; the sender stays disabled until it does and we retry every hour.' : 'Sender removed. Conversations, contact history and report numbers stay.');
    close();
  }
  async function doErase() {
    const r = await act('erase_schedule');
    if (!r) return;
    notify(`Erase scheduled for ${fmtDate(String(r.erase_scheduled_at))}. Until then you can cancel.`);
    close();
  }
  async function doEraseCancel() {
    const r = await act('erase_cancel');
    if (r) notify('Erase cancelled. Nothing was deleted.');
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

  if (!canEdit) return <ErrorBox message={canWrite ? 'Only owners and managers can pause, disable or remove senders.' : 'This workspace is read-only, so senders cannot be changed right now.'} />;

  const status = sender.status;
  const isRemoved = status === 'removed' || status === 'disconnected';
  const isErased = status === 'erased';
  const isDisabled = status === 'disabled';
  const isPaused = status === 'paused';
  const removalPending = !!sender.removal_requested_at && !isRemoved && !isErased;
  const eraseScheduled = !!sender.erase_scheduled_at && !isErased;
  const billingPaused = isPaused && (sender.pause_reason === 'billing' || BILLING_PAUSE_REASONS.includes(sender.status_reason ?? ''));
  const warningPaused = isPaused && sender.status_reason === 'provider_warning';
  const expected = (sender.display_name ?? 'erase').trim();
  const badge = lifecycleBadge(sender);
  const countryName = (code: string) => { const c = COUNTRIES.find((x) => x.code === code); return c ? `${c.name} (${code})` : code; };
  const refusedRemedy = refused ? billingRefusalRemedy(refused.code, billing.data, isOwner) : null;
  const seqName = (id: string) => reenrolState?.exited.find((e) => e.sequence_id === id)?.name ?? 'sequence';

  return (
    <div className="space-y-6">
      {(badge || removalPending || eraseScheduled) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
          {removalPending && <span className="text-gray-600">The connector has not confirmed the removal yet. We retry every hour; the sender sends nothing in the meantime.</span>}
          {eraseScheduled && <Button size="sm" variant="secondary" onClick={doEraseCancel} loading={busy === 'erase_cancel'} disabled={!isOwner || !!busy} title={isOwner ? undefined : 'Only the workspace owner can cancel an erase'}>Cancel erase</Button>}
        </div>
      )}

      {isErased ? <ErrorBox message="This sender was erased. Its conversations and personal data are gone; report numbers show it as “Erased sender”. Connect the account again as a new sender if you need it." /> : (
        <>
          {!isRemoved && (
            <Card title={<span className="flex items-center gap-2">{isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />} Pause / resume</span>}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="text-sm text-gray-700">
                  {billingPaused ? <>This sender is <strong>paused</strong> because the workspace is paused for billing. {billingPauseText(sender.status_reason)}. Replies from the inbox wait too.</>
                    : warningPaused ? <>This sender rests after a warning from {PROVIDER_LABELS[sender.provider]}. Resume it from the warning banner at the top of the page.</>
                    : isPaused ? <>This sender is <strong>paused</strong>{sender.pause_resume_at && new Date(sender.pause_resume_at) > new Date() ? ` until ${fmtDate(sender.pause_resume_at)}` : ''}. Sequence and AI sends wait; leads keep their place; replies from the inbox still go out.</>
                    : status === 'ok' ? <>Pausing stops sequence and AI sends for a while. Leads stay in their sequences and continue when you resume; you can still answer people who replied.</>
                    : <>Pause is available while the sender is connected (it is <strong>{status}</strong>).</>}
                </div>
                {isPaused && billingPaused
                  ? (isOwner ? <Link href="/outreach/billing"><Button variant="secondary"><Play className="w-4 h-4" /> Update payment</Button></Link> : <span className="text-xs text-gray-500">The workspace owner updates payment on the Billing page.</span>)
                  : isPaused
                  ? <Button variant="secondary" onClick={() => open('resume')} disabled={warningPaused || !!busy}><Play className="w-4 h-4" /> Resume</Button>
                  : <Button variant="secondary" onClick={() => open('pause')} disabled={status !== 'ok' || !!busy}><Pause className="w-4 h-4" /> Pause…</Button>}
              </div>
            </Card>
          )}

          {!isRemoved && (
            <Card title={<span className="flex items-center gap-2"><Power className="w-4 h-4" /> {isDisabled ? 'Enable' : 'Disable'}</span>}>
              <div className="text-sm text-gray-700 space-y-1.5">
                {isDisabled ? (
                  <>
                    <p>This sender is <strong>disabled</strong>{sender.disabled_at ? ` since ${fmtDate(sender.disabled_at, false)}` : ''}. Its leads left their sequences; replies that still arrive show in the inbox and stop those leads’ sequences on other senders.</p>
                    <p>It still uses one of your paid accounts{sender.auto_remove_at ? ` and is removed automatically on ${fmtDate(sender.auto_remove_at, false)} unless you enable it` : ''}.</p>
                  </>
                ) : (
                  <>
                    <p>Disabling turns the sender off: queued actions are cancelled and its leads leave their sequences. The connection stays, so late replies still arrive, and you can enable it again any time.</p>
                    <p>A disabled sender still uses one of your paid accounts. After {sender.auto_remove_after_days ?? 30} days disabled it is removed automatically (you get an email a week before).</p>
                  </>
                )}
              </div>
              {refused && refusedRemedy && dialog === null && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
                  <div className="font-medium">{refused.message}</div>
                  <div className="mt-2">{refusedRemedy.href ? <Link href={refusedRemedy.href}><Button size="sm">{refusedRemedy.label}</Button></Link> : refusedRemedy.label}</div>
                </div>
              )}
              <div className="mt-4">
                {isDisabled
                  ? <Button variant="secondary" onClick={() => open('enable')} disabled={!!busy || removalPending}><RotateCcw className="w-4 h-4" /> Enable…</Button>
                  : <Button variant="secondary" onClick={() => open('disable')} disabled={!!busy || !['ok', 'paused', 'credentials', 'error', 'connecting'].includes(status)}><Power className="w-4 h-4" /> Disable…</Button>}
              </div>
            </Card>
          )}

          {sender.provider === 'LINKEDIN' && !isRemoved && (
            <Card title={<span className="flex items-center gap-2"><Globe className="w-4 h-4" /> Change proxy country</span>}>
              <div className="text-sm text-gray-700 space-y-1.5">
                <p>This sender’s traffic goes through a fixed proxy IP that was pinned when the owner opened the sign-in link{sender.proxy_country ? <>; it was last set to <strong>{countryName(sender.proxy_country)}</strong> from this app</> : null}. LinkedIn expects that location to stay the same.</p>
                <p>Change it only to correct a wrong pin. Moving a healthy account to a new IP can trigger a security check or a temporary restriction.</p>
              </div>
              <div className="mt-4">
                <Button variant="secondary" onClick={() => { setProxyOpen(true); setCountry(''); setProxyError(null); }} disabled={!sender.unipile_account_id || isDisabled}><Globe className="w-4 h-4" /> Change proxy country…</Button>
                {!sender.unipile_account_id && <span className="ml-3 text-xs text-gray-400">Available once the sender is connected.</span>}
              </div>
            </Card>
          )}

          <Card title={<span className="flex items-center gap-2 text-red-700"><Unplug className="w-4 h-4" /> Remove</span>} className="border-red-200">
            <div className="text-sm text-gray-700 space-y-1.5">
              {isRemoved ? (
                <>
                  <p>This sender was <strong>removed</strong>{sender.removed_at ? ` on ${fmtDate(sender.removed_at, false)}` : ''}{removedReasonText(sender.removed_via, sender.status_reason) ? ` (${removedReasonText(sender.removed_via, sender.status_reason)!.toLowerCase()})` : ''}. Its account is unlinked and its stored sign-in deleted; conversations, contact history and report numbers stay, read-only.</p>
                  <p>To use this account again, the owner signs in again from <strong>Reconnect</strong> at the top of the page. Its history, health and warm-up come back with it.</p>
                </>
              ) : (
                <>
                  <p>Removing unlinks the account and deletes its stored sign-in. Everything from Disable happens too: leads leave their sequences. All conversations, contact history and report numbers stay.</p>
                  <p>This frees one of your paid accounts. To use the account again, the owner has to sign in again; its history comes back when they do.</p>
                </>
              )}
            </div>
            {!isRemoved && (
              <div className="mt-4">
                <Button variant="danger" onClick={() => open('remove')} disabled={!!busy || removalPending}><Unplug className="w-4 h-4" /> {removalPending ? 'Removal pending' : 'Remove…'}</Button>
              </div>
            )}
          </Card>

          <Card title={<span className="flex items-center gap-2 text-red-700"><Trash2 className="w-4 h-4" /> Erase</span>} className="border-red-200">
            <div className="text-sm text-gray-700 space-y-1.5">
              <p>Erasing deletes this sender’s conversations and personal data for good. Report numbers stay, shown as “Erased sender”, and leads still count as contacted. If it is not removed yet, Remove runs first.</p>
              <p>Scheduled 24 hours ahead and cancellable until then. After it runs it cannot be undone. {isOwner ? 'Workspace owner only.' : 'Only the workspace owner can erase a sender.'}</p>
            </div>
            <div className="mt-4">
              {eraseScheduled
                ? <Button variant="secondary" onClick={doEraseCancel} loading={busy === 'erase_cancel'} disabled={!isOwner || !!busy}>Cancel erase (scheduled {fmtDate(sender.erase_scheduled_at)})</Button>
                : <Button variant="danger" onClick={() => open('erase')} disabled={!isOwner || !!busy} title={isOwner ? undefined : 'Only the workspace owner can erase a sender'}><Trash2 className="w-4 h-4" /> Erase…</Button>}
            </div>
          </Card>
        </>
      )}

      <Modal open={dialog === 'pause'} onClose={close} title={`Pause ${sender.display_name ?? 'this sender'}?`} size="md"
        footer={<><Button variant="secondary" onClick={close} disabled={!!busy}>Cancel</Button><Button onClick={doPause} loading={busy === 'pause'} disabled={!preview || !!busy}>Pause sender</Button></>}>
        <div className="space-y-4">
          <PreviewList p={preview} action="pause" />
          <Input type="datetime-local" label="Resume automatically at (optional)" value={resumeAt} onChange={(e) => setResumeAt(e.target.value)} />
          <p className="text-xs text-gray-500">Actions that fall due during the pause wait; on resume the planner spreads them over the following days within the normal daily caps.</p>
          {error && <ErrorBox message={error} />}
        </div>
      </Modal>

      <Modal open={dialog === 'resume'} onClose={close} title={`Resume ${sender.display_name ?? 'this sender'}?`} size="md"
        footer={<><Button variant="secondary" onClick={close} disabled={!!busy}>Cancel</Button><Button onClick={doResume} loading={busy === 'resume'} disabled={!preview || !!busy}>Resume sender</Button></>}>
        <div className="space-y-4">
          {preview ? <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5"><li>{n(preview.queued_actions, 'queued action')} start again, spread within the daily caps</li><li>{n(preview.live_enrollments, 'lead')} continue where they stopped</li></ul> : <div className="text-sm text-gray-500">Checking what this changes…</div>}
          {refused && refusedRemedy && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{refused.message}{refusedRemedy.href && <div className="mt-2"><Link href={refusedRemedy.href}><Button size="sm">{refusedRemedy.label}</Button></Link></div>}</div>}
          {error && <ErrorBox message={error} />}
        </div>
      </Modal>

      <Modal open={dialog === 'disable'} onClose={close} title={reenrolState ? 'Re-enrol with other senders' : `Disable ${sender.display_name ?? 'this sender'} (${PROVIDER_LABELS[sender.provider]})?`} size="lg"
        footer={reenrolState
          ? <Button onClick={close} disabled={!!busy}>Done</Button>
          : <><Button variant="secondary" onClick={close} disabled={!!busy}>Cancel</Button><Button variant="danger" onClick={doDisable} loading={busy === 'disable'} disabled={!preview || !!busy}>{reenrol ? 'Disable and choose new senders' : 'Disable sender'}</Button></>}>
        {reenrolState ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-700">{sender.display_name ?? 'The sender'} is disabled. For each sequence below, the preview shows who can start again from step 1 with a sender who has never contacted them, and who is excluded and why. Nothing is enrolled until you confirm per sequence.</p>
            {reenrolState.exited.map((x) => {
              const pv = reenrolState.previews[x.sequence_id];
              const done = reenrolState.done[x.sequence_id];
              return (
                <div key={x.sequence_id} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">{x.name}</div>
                      <div className="text-xs text-gray-500">{n(x.lead_ids.length, 'lead')} left this sequence</div>
                    </div>
                    {done != null ? <Badge tone="green">{n(done, 'lead')} re-enrolled</Badge>
                      : <Button size="sm" onClick={() => doReenrol(x.sequence_id)} loading={busy === `reenrol:${x.sequence_id}`} disabled={!pv || !pv.eligible || !!busy}><Users className="w-4 h-4" /> Enrol {pv ? pv.eligible.toLocaleString() : ''}</Button>}
                  </div>
                  {pv ? (
                    <div className="mt-2 text-xs text-gray-600 space-y-1">
                      {pv.assignment.length > 0 && <div>Goes to: {pv.assignment.map((a) => `${a.name ?? 'sender'} (${a.leads})`).join(', ')}</div>}
                      {Object.keys(pv.excluded).length > 0 && <div>Excluded: {Object.entries(pv.excluded).map(([k, v]) => `${v.count} ${k === 'no_fresh_sender' ? 'no fresh sender left' : k === 'replied_recently' ? 'replied recently' : k === 'already_enrolled' ? 'already enrolled' : k.startsWith('suppressed') ? 'suppressed' : k.replace(/_/g, ' ')}`).join(' · ')}</div>}
                      {pv.warnings.map((w) => <div key={w} className="text-amber-700">{w}</div>)}
                    </div>
                  ) : <div className="mt-2 text-xs text-gray-500">The preview for {seqName(x.sequence_id)} could not be loaded.</div>}
                </div>
              );
            })}
            {error && <ErrorBox message={error} />}
          </div>
        ) : (
          <div className="space-y-4">
            <PreviewList p={preview} action="disable" />
            {preview && preview.sequences.length > 0 && (
              <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm">
                {preview.sequences.map((s) => <div key={s.sequence_id} className="flex items-center justify-between px-3 py-1.5"><span className="truncate">{s.name}</span><span className="text-gray-500 whitespace-nowrap">{n(s.leads, 'lead')}{s.other_active_senders === 0 ? ' · no other active sender' : ''}</span></div>)}
              </div>
            )}
            {preview && preview.live_enrollments > 0 && (
              <fieldset className="space-y-1.5 text-sm text-gray-800">
                <legend className="font-medium mb-1">What should happen to the {n(preview.live_enrollments, 'lead')}?</legend>
                <label className="flex items-start gap-2"><input type="radio" className="mt-0.5" checked={!reenrol} onChange={() => setReenrol(false)} /><span><span className="font-medium">Exit them</span><br /><span className="text-gray-500">They leave their sequences and are not contacted again.</span></span></label>
                <label className="flex items-start gap-2"><input type="radio" className="mt-0.5" checked={reenrol} onChange={() => setReenrol(true)} /><span><span className="font-medium">Re-enrol them with other senders</span><br /><span className="text-gray-500">Opens the enrol preview per sequence: a sender who never contacted the lead, starting from step 1. You confirm before anything is enrolled.</span></span></label>
              </fieldset>
            )}
            <Input label="Reason (optional, kept in the sender’s history)" value={reason} onChange={(e) => setReason(e.target.value)} />
            {error && <ErrorBox message={error} />}
          </div>
        )}
      </Modal>

      <Modal open={dialog === 'enable'} onClose={close} title={`Enable ${sender.display_name ?? 'this sender'}?`} size="md"
        footer={<><Button variant="secondary" onClick={close} disabled={!!busy}>Cancel</Button><Button onClick={doEnable} loading={busy === 'enable'} disabled={!preview || !!busy}>Enable sender</Button></>}>
        <div className="space-y-4">
          <PreviewList p={preview} action="enable" />
          {refused && refusedRemedy && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{refused.message}{refusedRemedy.href && <div className="mt-2"><Link href={refusedRemedy.href}><Button size="sm">{refusedRemedy.label}</Button></Link></div>}</div>}
          {error && <ErrorBox message={error} />}
        </div>
      </Modal>

      <Modal open={dialog === 'remove'} onClose={close} title={`Remove ${sender.display_name ?? 'this sender'} (${PROVIDER_LABELS[sender.provider]})?`} size="lg"
        footer={<><Button variant="secondary" onClick={close} disabled={!!busy}>Cancel</Button><Button variant="danger" onClick={doRemove} loading={busy === 'remove'} disabled={!preview || !!busy}>Remove sender</Button></>}>
        <div className="space-y-4">
          <PreviewList p={preview} action="remove" />
          <Input label="Reason (optional, kept in the sender’s history)" value={reason} onChange={(e) => setReason(e.target.value)} />
          {error && <ErrorBox message={error} />}
        </div>
      </Modal>

      <Modal open={dialog === 'erase'} onClose={close} title={`Erase ${sender.display_name ?? 'this sender'}?`} size="md"
        footer={<><Button variant="secondary" onClick={close} disabled={!!busy}>Cancel</Button><Button variant="danger" onClick={doErase} loading={busy === 'erase_schedule'} disabled={!preview || !!busy || confirmText.trim() !== expected}>Schedule erase</Button></>}>
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /><span>This deletes the conversations with this sender for good. It runs in 24 hours; until then you can cancel from this tab.</span></div>
          <PreviewList p={preview} action="erase" />
          <Input label={`Type “${expected}” to confirm`} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
          {error && <ErrorBox message={error} />}
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
    </div>
  );
}
