'use client';

// Public page (no login): the account owner applies or declines a proposed profile change.
import { useParams } from 'next/navigation';
import { ApprovalPage } from '@/components/outreach/profile/OwnerPage';

export default function Page() {
  const params = useParams<{ token: string }>();
  return <ApprovalPage token={String(params?.token ?? '')} />;
}
