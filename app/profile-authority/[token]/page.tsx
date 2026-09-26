'use client';

// Public page (no login): the account owner grants field-level permission from the link in their email.
import { useParams } from 'next/navigation';
import { AuthorityPage } from '@/components/outreach/profile/OwnerPage';

export default function Page() {
  const params = useParams<{ token: string }>();
  return <AuthorityPage token={String(params?.token ?? '')} />;
}
