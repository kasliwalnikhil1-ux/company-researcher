'use client';

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import AiReviewView from '@/components/outreach/ai/AiReviewView';
import { readSelection } from '@/lib/outreach/intel';
import { PageLoader } from '@/components/outreach/ui';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /outreach/ai-review
 *   ?batch=<id>                 open one batch
 *   ?generate=1                 open the "Generate lines" dialog
 *   ?leads=<id,id,…>            leads to generate for (short selections)
 *   ?selection=<key>            leads to generate for, handed over in sessionStorage by the leads list (long selections)
 */
function AiReviewPageInner() {
  const params = useSearchParams();
  const batchParam = params.get('batch');
  const batch = batchParam && UUID.test(batchParam) ? batchParam : null;
  const leadsParam = params.get('leads');
  const selectionKey = params.get('selection');
  const selection = useMemo(() => {
    const fromUrl = (leadsParam ?? '').split(',').map((s) => s.trim()).filter((s) => UUID.test(s));
    const stored = readSelection(selectionKey).filter((s) => UUID.test(s));
    return Array.from(new Set([...fromUrl, ...stored]));
  }, [leadsParam, selectionKey]);
  const generate = params.get('generate') === '1' || selection.length > 0;
  return <AiReviewView batchId={batch} generate={generate} selection={selection} />;
}

export default function AiReviewPage() {
  return <Suspense fallback={<PageLoader />}><AiReviewPageInner /></Suspense>;
}
