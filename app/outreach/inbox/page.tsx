'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import InboxView from '@/components/outreach/inbox/InboxView';
import { useInboxRestrict } from '@/components/outreach/inbox/hooks';
import type { ChatFilters } from '@/lib/outreach/queries';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function InboxPageInner() {
  const params = useSearchParams();
  const restrict = useInboxRestrict();
  const initial: Partial<ChatFilters> & { sequence_id?: string | null } = {};
  const intent = params.get('intent');
  if (intent) initial.intent = intent;
  if (params.get('unread') === '1') initial.unread = true;
  const sender = params.get('sender_id');
  if (sender) initial.sender_id = sender;
  const client = params.get('client_id');
  if (client) initial.client_id = client;
  const sequence = params.get('sequence_id');
  if (sequence && UUID.test(sequence)) initial.sequence_id = sequence;
  return <InboxView chatId={null} initialFilters={Object.keys(initial).length ? initial : undefined} restrict={restrict} />;
}

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner />
    </Suspense>
  );
}
