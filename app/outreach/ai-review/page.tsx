'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { hubHref } from '@/lib/outreach/aiHub';
import { PageLoader } from '@/components/outreach/ui';

const KEPT = ['batch', 'generate', 'leads', 'selection'] as const;

/**
 * /outreach/ai-review moved into the AI hub (kept for one release).
 *   ?batch= / ?generate=1 / ?leads= / ?selection=   → AI → Setup → Personalized lines, the lines view, same params
 *   nothing                                          → AI → Needs you, lines only
 * A client redirect because the params decide where it goes.
 */
function AiReviewRedirect() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const kept = new URLSearchParams();
    for (const k of KEPT) { const v = params.get(k); if (v) kept.set(k, v); }
    const rest = kept.toString();
    router.replace(rest ? `${hubHref.setupLines('lines')}&${rest}` : hubHref.needsYou({ type: 'line' }));
  }, [params, router]);
  return <PageLoader />;
}

export default function AiReviewPage() {
  return <Suspense fallback={<PageLoader />}><AiReviewRedirect /></Suspense>;
}
