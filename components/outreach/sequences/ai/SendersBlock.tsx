'use client';

// The pool's LinkedIn senders and whether their owner approved AI replies (one approval per sender, §4.2).
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useRequestConsentV2, type ConsentRequestResult, type SequenceSender } from '@/lib/outreach/aiRepliesSequence';
import { Badge, Button, Modal, fmtDate } from '@/components/outreach/ui';
import { CopyField, Note } from '@/components/outreach/settings/shared';
import { Section, errText } from './shared';

const STATE: Record<SequenceSender['consent'], { label: string; tone: 'green' | 'amber' | 'gray' }> = {
  granted: { label: 'Approved', tone: 'green' }, pending: { label: 'Approval requested', tone: 'amber' }, missing: { label: 'Not approved', tone: 'gray' },
};

export default function SendersBlock({ sequenceId, ws, senders, canEdit, notify }: { sequenceId: string; ws: string; senders: SequenceSender[]; canEdit: boolean; notify: (m: string, t?: 'success' | 'error') => void }) {
  const req = useRequestConsentV2(ws, sequenceId);
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<{ name: string; url: string; expires?: string } | null>(null);

  async function request(s: SequenceSender) {
    setBusy(s.sender_id);
    try {
      const r: ConsentRequestResult = await req.mutateAsync(s.sender_id);
      if (r.granted) notify(r.already ? `${s.sender_name ?? 'This account'} had already approved AI Auto Replies.` : `Approved for ${s.sender_name ?? 'your account'}.`);
      else if (r.emailed) notify(`Approval link emailed to ${s.owner_email ?? 'the owner'}.`);
      else if (r.link) setLink({ name: s.sender_name ?? 'Sender', url: r.link, expires: r.expires_at });
      else notify('Request sent.');
    } catch (e) { notify(errText(e), 'error'); }
    finally { setBusy(null); }
  }

  return (
    <Section title="Senders" help="Auto sends as a real person, so the owner of each account approves once: the approval covers every sequence your team turns on. Draft never needs approval.">
      {senders.length === 0 ? (
        <p className="text-sm text-gray-500">No LinkedIn sender in the pool yet. Add one under Senders.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {senders.map((s) => {
            const st = STATE[s.consent] ?? STATE.missing;
            return (
              <li key={s.sender_id} className="py-2.5 first:pt-0 last:pb-0 flex flex-wrap items-center gap-2">
                <ShieldCheck className={`w-4 h-4 flex-shrink-0 ${s.consent === 'granted' ? 'text-green-600' : 'text-gray-300'}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900">{s.sender_name ?? 'Sender'}{s.owner_is_me && <Badge tone="indigo" className="ml-2">Yours</Badge>}</div>
                  <div className="text-xs text-gray-500">
                    {s.owner_email ?? 'No owner email on file'}
                    {s.consent === 'pending' && s.pending_link_expires_at && <> · link expires {fmtDate(s.pending_link_expires_at, false)}</>}
                    {s.consent === 'granted' && s.granted_via === 'owner_is_operator' && <> · approved in the app</>}
                  </div>
                </div>
                <Badge tone={st.tone}>{st.label}</Badge>
                {canEdit && s.consent !== 'granted' && (
                  s.owner_is_me
                    ? <Button size="sm" onClick={() => request(s)} loading={busy === s.sender_id}>Approve for my account</Button>
                    : <Button size="sm" variant="secondary" onClick={() => request(s)} loading={busy === s.sender_id}>{s.consent === 'pending' ? 'Send approval link again' : 'Send approval link'}</Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={!!link} onClose={() => setLink(null)} title="Send this approval link yourself" size="md" footer={<Button onClick={() => setLink(null)}>Done</Button>}>
        <div className="space-y-3">
          <Note tone="amber">{link?.name} has no owner email on file, so nothing was sent. Pass the link on; it works for 7 days.</Note>
          {link && <CopyField label="Approval link" value={link.url} hint={link.expires ? `Expires ${fmtDate(link.expires)}` : undefined} />}
        </div>
      </Modal>
    </Section>
  );
}
