'use client';

import Link from '@/lib/outreach/nav';
import { PenLine, Trash2 } from 'lucide-react';
import { discardProfileDraft } from '@/lib/outreach/aiHub';
import { Button } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import NeedCard, { ClampText, Hint, Part, linkButton } from './NeedCard';
import { metaText, type CardProps } from './types';

/** Profile Studio is the Profile tab of the sender page; `change` opens that draft in its editor. */
export const profileStudioHref = (senderId: string, changeId?: string) => `/outreach/senders/${senderId}?tab=Profile${changeId ? `&change=${changeId}` : ''}`;

/**
 * Profile: the AI drafted a headline or an About section for a sender. It is never applied from here: the owner's
 * permission and the schedule live in Profile Studio, so "Edit and apply" opens it.
 */
export default function ProfileCard({ row, hidden, api }: CardProps) {
  const senderId = row.where_id ?? row.who_id;
  const headline = metaText(row, 'field') === 'headline';
  return (
    <NeedCard row={row} hidden={hidden}
      trigger={row.trigger_text ? <Part label="Note:"><ClampText text={row.trigger_text} className="text-gray-700" /></Part> : undefined}
      ai={<Part label={headline ? 'Headline:' : 'About:'}><ClampText text={(row.ai_text ?? '').trim()} /></Part>}
      extra={api.canWrite && senderId ? <Hint>Edit and apply opens this draft in Profile Studio, where the owner&apos;s permission and the schedule are checked.</Hint> : undefined}
      actions={api.canWrite ? (
        <>
          {senderId && <Link href={profileStudioHref(senderId, row.id)} className={cn(linkButton, 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700')}><PenLine className="w-3.5 h-3.5" aria-hidden="true" /> Edit and apply</Link>}
          <Button size="sm" variant="ghost" onClick={() => api.defer(row, 'Draft discarded', () => discardProfileDraft(row.id))} title="The draft is dropped. The profile does not change."><Trash2 className="w-3.5 h-3.5" /> Discard</Button>
        </>
      ) : undefined} />
  );
}
