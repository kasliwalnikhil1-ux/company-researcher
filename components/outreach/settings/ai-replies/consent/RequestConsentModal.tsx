'use client';

import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { useRequestConsent, type ConsentSender, type PromptListRow } from '@/lib/outreach/aiReplies';
import { Button, ErrorBox, Modal, Select, fmtDate } from '@/components/outreach/ui';
import { CopyField, Note } from '@/components/outreach/settings/shared';

type Result = { granted?: boolean; link?: string; emailed?: boolean; expires_at?: string };

/** Ask a sender's owner to approve autopilot for one master prompt. Mount with a `key` per open. */
export default function RequestConsentModal({ ws, sender, prompts, initialPromptId, onClose }: {
  ws: string; sender: ConsentSender; prompts: PromptListRow[]; initialPromptId: string | null; onClose: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(initialPromptId);
  const [result, setResult] = useState<Result | null>(null);
  const req = useRequestConsent(ws);
  const promptId = picked ?? prompts[0]?.id ?? '';

  async function submit() {
    if (!promptId) return;
    try { setResult(await req.mutateAsync({ senderId: sender.sender_id, masterPromptId: promptId })); } catch { /* shown below */ }
  }

  return (
    <Modal open onClose={onClose} size="md" title={`Request consent · ${sender.sender_name}`}
      footer={result ? <Button onClick={onClose}>Done</Button> : (
        <><Button variant="secondary" onClick={onClose} disabled={req.isPending}>Cancel</Button><Button onClick={submit} loading={req.isPending} disabled={!promptId}>Send request</Button></>
      )}>
      {!result ? (
        <div className="space-y-3">
          {prompts.length === 0 ? (
            <Note tone="amber">Save a master prompt first. The owner approves a specific prompt.</Note>
          ) : (
            <Select label="Master prompt" value={promptId} onChange={(e) => setPicked(e.target.value)}>
              {prompts.map((p) => <option key={p.id} value={p.id}>{p.scope_label} · v{p.version}</option>)}
            </Select>
          )}
          <p className="text-sm text-gray-600">
            {sender.owner_is_me
              ? 'You own this account, so consent is recorded straight away.'
              : sender.owner_email
                ? <>We email <strong>{sender.owner_email}</strong> a link. It works for 7 days.</>
                : 'This sender has no owner email. You get a link to pass on yourself.'}
          </p>
          <p className="text-xs text-gray-500">The owner sees the full master prompt, the daily cap, the hold window and three example drafts before agreeing.</p>
          {req.error && <ErrorBox message={parseError(req.error).message} />}
        </div>
      ) : result.granted ? (
        <div className="flex items-start gap-2 text-sm text-green-800">
          <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" aria-hidden="true" />
          <span>You own this account, consent recorded.</span>
        </div>
      ) : (
        <div className="space-y-3">
          <Note tone={result.emailed ? 'green' : 'amber'}>
            {result.emailed ? `Emailed to ${sender.owner_email ?? 'the owner'}.` : 'Not emailed. Send this link to the account owner yourself.'}
          </Note>
          {result.link && <CopyField label="Consent link" value={result.link} hint={result.expires_at ? `Expires ${fmtDate(result.expires_at)}` : undefined} />}
        </div>
      )}
    </Modal>
  );
}
