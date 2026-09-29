'use client';

// Public page (no login): the account owner turns Autopilot off with the revoke link from the confirmation email.
import { useParams } from 'next/navigation';
import { RevokePage } from '@/app/ai-reply-consent/_components/ConsentPages';

export default function Page() {
  const params = useParams<{ token: string }>();
  return <RevokePage token={String(params?.token ?? '')} />;
}
