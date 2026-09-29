'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { useConsent, useGrantOperatorConsent, useMasterPromptList, useRevokeConsent, type ConsentRow, type ConsentSender } from '@/lib/outreach/aiReplies';
import { EmptyState, ErrorBox, Spinner, Textarea } from '@/components/outreach/ui';
import { ConfirmModal, Note } from '@/components/outreach/settings/shared';
import ConsentSenderCard from './ConsentSenderCard';
import RequestConsentModal from './RequestConsentModal';

/** Sender-owner consent for autopilot (PRD §4.1). The list is manager-only; members get a notice. */
export default function ConsentPanel({ ws, canEdit, isManager, notify }: {
  ws: string; canEdit: boolean; isManager: boolean; notify: (m: string, t?: 'success' | 'error') => void;
}) {
  const q = useConsent(isManager ? ws : null);
  const prompts = useMasterPromptList(ws);
  const grant = useGrantOperatorConsent(ws);
  const revoke = useRevokeConsent(ws);
  const [requesting, setRequesting] = useState<{ sender: ConsentSender; promptId: string | null; n: number } | null>(null);
  const [revoking, setRevoking] = useState<{ sender: ConsentSender; consent: ConsentRow } | null>(null);
  const [reason, setReason] = useState('');
  const [granting, setGranting] = useState<string | null>(null);

  if (!isManager) return <Note>Only owners and managers can see and manage sender consent.</Note>;
  if (q.isLoading || prompts.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={parseError(q.error).message} />;

  const senders = q.data ?? [];
  const promptRows = prompts.data ?? [];

  async function doGrant(sender: ConsentSender, promptId: string) {
    setGranting(`${sender.sender_id}:${promptId}`);
    try { await grant.mutateAsync({ senderId: sender.sender_id, masterPromptId: promptId }); notify('You own this account, consent recorded'); }
    catch (e) { notify(parseError(e).message, 'error'); }
    finally { setGranting(null); }
  }

  async function doRevoke() {
    if (!revoking) return;
    if (!reason.trim()) { notify('Add a reason to revoke consent.', 'error'); return; }
    try {
      await revoke.mutateAsync({ consentId: revoking.consent.id, reason: reason.trim() });
      notify(`Consent revoked for ${revoking.sender.sender_name}`);
      setRevoking(null); setReason('');
    } catch (e) { notify(parseError(e).message, 'error'); }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Autopilot writes as a real person, so the owner of each sender account must agree first, per master prompt. The owner sees the full master prompt, the daily cap, the hold window and three example drafts from their own recent chats. Changing what the prompt says (not just its style) asks them again.
      </p>
      {senders.length === 0 ? (
        <EmptyState icon={<ShieldCheck className="w-6 h-6" />} title="No senders yet" description="Connect a LinkedIn sender to request consent for autopilot." />
      ) : senders.map((s) => (
        <ConsentSenderCard key={s.sender_id} sender={s} prompts={promptRows} canEdit={canEdit} granting={granting}
          onRequest={(promptId) => setRequesting((r) => ({ sender: s, promptId, n: (r?.n ?? 0) + 1 }))}
          onGrant={(promptId) => doGrant(s, promptId)}
          onRevoke={(consent) => { setReason(''); setRevoking({ sender: s, consent }); }} />
      ))}

      {requesting && (
        <RequestConsentModal key={`${requesting.sender.sender_id}:${requesting.n}`} ws={ws} sender={requesting.sender} prompts={promptRows}
          initialPromptId={requesting.promptId} onClose={() => setRequesting(null)} />
      )}
      <ConfirmModal open={!!revoking} onClose={() => setRevoking(null)} onConfirm={doRevoke} loading={revoke.isPending} title="Revoke consent?" confirmLabel="Revoke">
        <p>Autopilot stops for <strong>{revoking?.sender.sender_name}</strong> on <strong>{revoking?.consent.scope_label}</strong>. Any AI reply waiting to be sent is cancelled within a minute. Drafts keep coming.</p>
        <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="min-h-[60px]" placeholder="e.g. The owner asked us to stop" />
        {revoke.isError && <ErrorBox message={parseError(revoke.error).message} />}
      </ConfirmModal>
    </div>
  );
}
