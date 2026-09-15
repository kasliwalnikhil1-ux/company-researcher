'use client';

import { useParams } from 'next/navigation';
import Builder from '@/components/outreach/sequences/Builder';

export default function SequenceBuilderPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  return <Builder key={id} id={id} />;
}
