'use client';

import { Button, Modal, fmtDate } from '@/components/outreach/ui';
import { CopyField, Note } from '@/components/outreach/settings/shared';
import type { ConsentRequestResult, ConsentSenderV2 } from '@/lib/outreach/aiRepliesSequence';

/** What happened after "Send approval link": emailed, or a link to pass on by hand. Mount with a `key` per open. */
export default function RequestConsentModal({ sender, result, onClose }: { sender: ConsentSenderV2; result: ConsentRequestResult; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} size="md" title={`Approval request · ${sender.sender_name ?? 'Sender'}`} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="space-y-3">
        <Note tone={result.emailed ? 'green' : 'amber'}>
          {result.emailed ? `Emailed to ${sender.owner_email ?? 'the owner'}. The link works for 7 days.` : 'Not emailed. Send this link to the account owner yourself; it works for 7 days.'}
        </Note>
        {result.link && <CopyField label="Approval link" value={result.link} hint={result.expires_at ? `Expires ${fmtDate(result.expires_at)}` : undefined} />}
        <p className="text-xs text-gray-500">The owner sees what the AI may do, the daily cap and three example replies from their own conversations before agreeing. One approval covers every sequence your team turns on.</p>
      </div>
    </Modal>
  );
}
