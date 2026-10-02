'use client';

import Link from '@/lib/outreach/nav';
import { Badge, Button, Card, fmtDate } from '@/components/outreach/ui';
import type { ConsentSenderV2 } from '@/lib/outreach/aiRepliesSequence';
import { isPast } from '../format';

type Tone = 'green' | 'amber' | 'red' | 'gray';

export function consentStatus(s: ConsentSenderV2): { label: string; tone: Tone } {
  const c = s.consent;
  if (c?.valid) return { label: 'Approved', tone: 'green' };
  if (c && isPast(c.expires_at)) return { label: 'Expired', tone: 'red' };
  if (c) return { label: 'Not valid', tone: 'red' };
  if (s.pending_link) return { label: 'Approval requested', tone: 'amber' };
  return { label: 'Not approved', tone: 'gray' };
}

/** One sender: its single approval, the pending link, the sequences on Auto and what a manager can do. */
export default function ConsentSenderCard({ sender, canEdit, busy, onRequest, onRevoke }: {
  sender: ConsentSenderV2; canEdit: boolean; busy: boolean; onRequest: () => void; onRevoke: () => void;
}) {
  const st = consentStatus(sender);
  const needs = !sender.consent?.valid;
  const c = sender.consent;
  return (
    <Card
      title={<span className="flex flex-wrap items-center gap-2">{sender.sender_name ?? 'Sender'}<Badge tone={st.tone}>{st.label}</Badge>{sender.owner_is_me && <Badge tone="indigo">Yours</Badge>}</span>}
      actions={canEdit && (
        <>
          {needs && sender.owner_is_me && <Button size="sm" onClick={onRequest} loading={busy}>Approve for my account</Button>}
          {needs && !sender.owner_is_me && <Button size="sm" variant="secondary" onClick={onRequest} loading={busy}>{sender.pending_link ? 'Send approval link again' : 'Send approval link'}</Button>}
          {c && <Button size="sm" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={onRevoke}>Revoke</Button>}
        </>
      )}>
      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div><dt className="text-xs text-gray-500">Owner</dt><dd className="text-gray-800">{sender.owner_email ?? <span className="text-amber-700">No email on file. Requests give you a link to pass on.</span>}</dd></div>
        <div>
          <dt className="text-xs text-gray-500">Approval</dt>
          <dd className="text-gray-800">
            {c ? (
              <>
                {c.granted_via === 'owner_is_operator' ? 'By the owner, in the app' : 'Signed link'}{c.granted_by_email ? ` · ${c.granted_by_email}` : ''}
                <div className="text-xs text-gray-500">Given {fmtDate(c.granted_at, false)} · expires {fmtDate(c.expires_at, false)}{c.scope?.daily_cap ? ` · up to ${c.scope.daily_cap} sends a day` : ''}</div>
              </>
            ) : sender.pending_link ? (
              <>Link sent {sender.pending_link.email ? `to ${sender.pending_link.email} ` : ''}{fmtDate(sender.pending_link.created_at)}, expires {fmtDate(sender.pending_link.expires_at)}</>
            ) : 'None yet'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Sequences on Auto</dt>
          <dd className="text-gray-800">
            {sender.sequences_on_auto.length === 0 ? 'None' : sender.sequences_on_auto.map((q, i) => (
              <span key={q.id}>{i > 0 && ', '}<Link href={`/outreach/sequences/${q.id}?tab=ai`} className="text-indigo-700 hover:underline">{q.name}</Link></span>
            ))}
            {needs && sender.sequences_on_auto.length > 0 && <div className="text-xs text-amber-700">Replies in these sequences are drafts until the owner approves.</div>}
          </dd>
        </div>
        <div><dt className="text-xs text-gray-500">Sent by Auto, last 7 days</dt><dd className="text-gray-800 tabular-nums">{sender.ai_sent_7d}</dd></div>
      </dl>
    </Card>
  );
}
