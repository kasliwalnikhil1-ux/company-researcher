'use client';

import { Suspense } from 'react';
import { useSearchParams } from '@/lib/outreach/nav';
import InboxView from '@/components/outreach/inbox/InboxView';
import type { SentSegment } from '@/lib/outreach/inboxSent';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sent (inbox-replies-sent-PRD.md §4.3): `?segment=scheduled|failed`, `?item=<id>` opens a send's detail pane. */
function SentPageInner() {
  const params = useSearchParams();
  const seg = params.get('segment');
  const segment: SentSegment = seg === 'scheduled' || seg === 'failed' ? seg : 'sent';
  const item = params.get('item');
  return <InboxView chatId={null} listView="sent" segment={segment} sentItemId={item && UUID.test(item) ? item : null} />;
}

export default function InboxSentPage() {
  return (
    <Suspense fallback={null}>
      <SentPageInner />
    </Suspense>
  );
}
