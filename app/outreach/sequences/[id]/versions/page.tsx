'use client';

// Version history live in the builder now (the "Versions" tab). Old links land there.
import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { PageLoader } from '@/components/outreach/ui';

export default function SequenceVersionsPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  const router = useRouter();
  useEffect(() => { if (id) router.replace(`/outreach/sequences/${id}?tab=versions`); }, [id, router]);
  return <PageLoader />;
}
