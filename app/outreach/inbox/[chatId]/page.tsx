'use client';

import { Suspense } from 'react';
import { useParams, useSearchParams } from '@/lib/outreach/nav';
import type { SentSegment } from '@/lib/outreach/inboxSent';
import InboxView from '@/components/outreach/inbox/InboxView';
import { useInboxRestrict } from '@/components/outreach/inbox/hooks';

function InboxChatPageInner() {
  const params = useParams<{ chatId: string }>();
  const chatId = typeof params?.chatId === 'string' ? params.chatId : null;
  // The reports drill-down (?chats=&label=) stays active while moving between threads.
  const restrict = useInboxRestrict();
  // ?view=sent: opened from a Sent row, so the Sent list stays beside the thread (and ?m= flashes the message)
  const search = useSearchParams();
  const sent = search.get('view') === 'sent';
  return <InboxView chatId={chatId} restrict={restrict} listView={sent ? 'sent' : 'replies'} segment={sent ? (search.get('segment') as SentSegment | null) : null} />;
}

export default function InboxChatPage() {
  return (
    <Suspense fallback={null}>
      <InboxChatPageInner />
    </Suspense>
  );
}
