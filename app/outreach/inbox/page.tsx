'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from '@/lib/outreach/nav';
import InboxView from '@/components/outreach/inbox/InboxView';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { readInboxViewState } from '@/lib/outreach/inboxSent';
import { useInboxRestrict } from '@/components/outreach/inbox/hooks';
import type { ChatFilters } from '@/lib/outreach/queries';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function InboxPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { workspace } = useWorkspace();
  const ws = workspace?.id ?? null;
  const restrict = useInboxRestrict();
  // The person's last view comes back (inbox-replies-sent-PRD.md §4.1): /outreach/inbox opens Sent when they left it on Sent.
  // Links with parameters (dashboard, reports, mentions) always open Replies.
  const plain = params.toString() === '';
  useEffect(() => {
    if (!ws || !plain) return;
    const st = readInboxViewState(ws);
    if (st.view === 'sent') router.replace(`/outreach/inbox/sent${st.segment !== 'sent' ? `?segment=${st.segment}` : ''}`);
  }, [ws, plain, router]);
  const initial: Partial<ChatFilters> & { sequence_id?: string | null } = {};
  // `?intent=a,b` and `?sender_id=a,b` take one value or a comma-separated list (the filters are multi-select)
  const list = (key: string) => (params.get(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const intents = list('intent');
  if (intents.length) initial.intents = intents;
  if (params.get('unread') === '1') initial.unread = true;
  // the "6 new replies" notification opens Replies → Needs reply
  const chip = params.get('chip');
  if (chip === 'needs_reply' || chip === 'waiting_on_them' || chip === 'all') initial.chip = chip;
  const senders = list('sender_id').filter((id) => UUID.test(id));
  if (senders.length) initial.sender_ids = senders;
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
