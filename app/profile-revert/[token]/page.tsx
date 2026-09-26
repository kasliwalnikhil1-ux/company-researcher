'use client';

// Public page (no login): the account owner reverts an applied change with the 30-day link from the notification email.
import { useParams } from 'next/navigation';
import { RevertPage } from '@/components/outreach/profile/OwnerPage';

export default function Page() {
  const params = useParams<{ token: string }>();
  return <RevertPage token={String(params?.token ?? '')} />;
}
