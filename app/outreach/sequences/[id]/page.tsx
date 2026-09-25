'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import Builder from '@/components/outreach/sequences/Builder';
import { PageLoader } from '@/components/outreach/ui';

export default function SequenceBuilderPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  // the builder reads ?tab= with useSearchParams, which needs a Suspense boundary for prerendering
  return <Suspense fallback={<PageLoader />}><Builder key={id} id={id} /></Suspense>;
}
