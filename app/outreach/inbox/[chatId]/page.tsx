'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import InboxView from '@/components/outreach/inbox/InboxView';
import { useInboxRestrict } from '@/components/outreach/inbox/hooks';

function InboxChatPageInner() {
  const params = useParams<{ chatId: string }>();
  const chatId = typeof params?.chatId === 'string' ? params.chatId : null;
  // The reports drill-down (?chats=&label=) stays active while moving between threads.
  const restrict = useInboxRestrict();
  return <InboxView chatId={chatId} restrict={restrict} />;
}

export default function InboxChatPage() {
  return (
    <Suspense fallback={null}>
      <InboxChatPageInner />
    </Suspense>
  );
}
