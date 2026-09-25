'use client';

// Enrolment and the enrolled leads live in the builder now (the "Leads" tab). Old links land there.
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { PageLoader } from '@/components/outreach/ui';

export default function EnrollPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  const router = useRouter();
  useEffect(() => { if (id) router.replace(`/outreach/sequences/${id}?tab=leads`); }, [id, router]);
  return <PageLoader />;
}
