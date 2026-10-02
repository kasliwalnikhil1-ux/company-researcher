'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { useConsentList, useRequestConsentV2, useRevokeConsentV2, type ConsentRequestResult, type ConsentSenderV2 } from '@/lib/outreach/aiRepliesSequence';
import { EmptyState, ErrorBox, Spinner, Textarea } from '@/components/outreach/ui';
import { ConfirmModal, Note } from '@/components/outreach/settings/shared';
import ConsentSenderCard from './ConsentSenderCard';
import RequestConsentModal from './RequestConsentModal';

/** Sender-owner approval for Auto (changes doc §4.2): one approval per sender, covering every sequence the team turns on. */
export default function ConsentPanel({ ws, canEdit, isManager, notify }: {
  ws: string; canEdit: boolean; isManager: boolean; notify: (m: string, t?: 'success' | 'error') => void;
}) {
  const q = useConsentList(isManager ? ws : null);
  const request = useRequestConsentV2(ws);
  const revoke = useRevokeConsentV2(ws);
  const [result, setResult] = useState<{ sender: ConsentSenderV2; r: ConsentRequestResult; n: number } | null>(null);
  const [revoking, setRevoking] = useState<ConsentSenderV2 | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  if (!isManager) return <Note>Only owners and managers can see and manage sender approvals.</Note>;
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={parseError(q.error).message} />;

  const senders = q.data ?? [];

  async function doRequest(sender: ConsentSenderV2) {
    setBusy(sender.sender_id);
    try {
      const r = await request.mutateAsync(sender.sender_id);
      if (r.granted) notify(r.already ? `${sender.sender_name ?? 'This account'} had already approved.` : `Approved for ${sender.sender_name ?? 'your account'}.`);
      else setResult((prev) => ({ sender, r, n: (prev?.n ?? 0) + 1 }));
    } catch (e) { notify(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  async function doRevoke() {
    if (!revoking?.consent) return;
    if (!reason.trim()) { notify('Add a reason to revoke the approval.', 'error'); return; }
    try {
      await revoke.mutateAsync({ consentId: revoking.consent.id, reason: reason.trim() });
      notify(`Approval revoked for ${revoking.sender_name ?? 'the sender'}.`);
      setRevoking(null); setReason('');
    } catch (e) { notify(parseError(e).message, 'error'); }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Auto writes as a real person, so the owner of each LinkedIn account approves it once: &ldquo;AI may reply as me in the sequences my team turns on.&rdquo; The owner sees the daily cap and three example replies from their own recent chats. Approving your own accounts takes one click. Prompt edits never ask again; a weekly email lists which sequences used the approval.
      </p>
      {senders.length === 0 ? (
        <EmptyState icon={<ShieldCheck className="w-6 h-6" />} title="No LinkedIn senders yet" description="Connect a LinkedIn sender to ask its owner to approve Auto for Replies." />
      ) : senders.map((s) => (
        <ConsentSenderCard key={s.sender_id} sender={s} canEdit={canEdit} busy={busy === s.sender_id}
          onRequest={() => doRequest(s)} onRevoke={() => { setReason(''); setRevoking(s); }} />
      ))}

      {result && <RequestConsentModal key={`${result.sender.sender_id}:${result.n}`} sender={result.sender} result={result.r} onClose={() => setResult(null)} />}
      <ConfirmModal open={!!revoking} onClose={() => setRevoking(null)} onConfirm={doRevoke} loading={revoke.isPending} title="Revoke approval?" confirmLabel="Revoke">
        <p>Auto stops for <strong>{revoking?.sender_name}</strong> in every sequence{revoking?.sequences_on_auto.length ? ` (${revoking.sequences_on_auto.map((x) => x.name).join(', ')})` : ''}. Any AI reply waiting to be sent is cancelled within a minute. Drafts keep coming.</p>
        <Textarea label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="min-h-[60px]" placeholder="e.g. The owner asked us to stop" />
        {revoke.isError && <ErrorBox message={parseError(revoke.error).message} />}
      </ConfirmModal>
    </div>
  );
}
