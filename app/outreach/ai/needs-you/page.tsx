'use client';

import { Suspense, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import HubFrame from '@/components/outreach/ai/hub/HubFrame';
import NeedsYouView from '@/components/outreach/ai/hub/needs/NeedsYouView';
import { hubHref, isNeedsYouType, type NeedsYouFilters } from '@/lib/outreach/aiHub';
import { PageLoader } from '@/components/outreach/ui';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /outreach/ai/needs-you: every AI output that waits for a person.
 *   ?type=reply|line|draft|website|question|profile   ?where=<sequence, variable or website id>   ?mine=all
 * Mine is the default (cards assigned to me or to nobody); mine=all shows everything I may act on.
 * The filters live in the URL so a filtered queue can be linked ("5 replies need you" on a sequence).
 */
function NeedsYou() {
  const { workspace } = useWorkspace();
  const router = useRouter();
  const search = useSearchParams();

  const filters: NeedsYouFilters = useMemo(() => {
    const type = search.get('type');
    const where = search.get('where');
    return { type: isNeedsYouType(type) ? type : null, where: where && UUID.test(where) ? where : null, mine: search.get('mine') !== 'all' };
  }, [search]);

  const setFilters = useCallback((f: NeedsYouFilters) => router.replace(hubHref.needsYou(f), { scroll: false }), [router]);

  if (!workspace) return <PageLoader />;
  return <NeedsYouView ws={workspace.id} filters={filters} onFilters={setFilters} />;
}

export default function AiNeedsYouPage() {
  return (
    <HubFrame subtitle="Needs you: what the AI wrote and a person has to approve, across Replies, Personalized lines, Step drafts, the Website assistant and Profile drafts.">
      <Suspense fallback={<PageLoader />}>
        <NeedsYou />
      </Suspense>
    </HubFrame>
  );
}
