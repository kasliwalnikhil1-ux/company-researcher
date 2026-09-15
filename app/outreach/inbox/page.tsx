'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import InboxView from '@/components/outreach/inbox/InboxView';
import type { ChatFilters } from '@/lib/outreach/queries';

function InboxPageInner() {
  const params = useSearchParams();
  const initial: Partial<ChatFilters> = {};
  const intent = params.get('intent');
  if (intent) initial.intent = intent;
  if (params.get('unread') === '1') initial.unread = true;
  const sender = params.get('sender_id');
  if (sender) initial.sender_id = sender;
  const client = params.get('client_id');
  if (client) initial.client_id = client;
  return <InboxView chatId={null} initialFilters={Object.keys(initial).length ? initial : undefined} />;
}

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner />
    </Suspense>
  );
}
