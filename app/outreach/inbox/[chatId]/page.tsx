'use client';

import { useParams } from 'next/navigation';
import InboxView from '@/components/outreach/inbox/InboxView';

export default function InboxChatPage() {
  const params = useParams<{ chatId: string }>();
  const chatId = typeof params?.chatId === 'string' ? params.chatId : null;
  return <InboxView chatId={chatId} />;
}
