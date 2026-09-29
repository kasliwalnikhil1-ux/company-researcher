'use client';

// Public page (no login): the LinkedIn account owner reads the master prompt and consents to AI replies (Autopilot).
import { useParams } from 'next/navigation';
import { ConsentPage } from '@/app/ai-reply-consent/_components/ConsentPages';

export default function Page() {
  const params = useParams<{ token: string }>();
  return <ConsentPage token={String(params?.token ?? '')} />;
}
