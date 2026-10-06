'use client';

import { Suspense, useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from '@/lib/outreach/nav';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import HubFrame from '@/components/outreach/ai/hub/HubFrame';
import ActivityTable from '@/components/outreach/ai/hub/ActivityTable';
import { ACTIVITY_DEFAULTS, ACTIVITY_RANGES, isAiFeature, type ActivityFilters, type ActivityRange } from '@/lib/outreach/aiHub';
import { PageLoader } from '@/components/outreach/ui';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * /outreach/ai/activity: what the AI generated, across every feature.
 *   ?feature=reply|line|draft|website|profile   ?where=<sequence, variable or website id>
 *   ?range=today|7|30|90|custom  ?from=YYYY-MM-DD  ?to=YYYY-MM-DD   ?q=<text>
 * The filters live in the URL so a filtered list can be linked (a website's "Recent answers", a sequence's replies).
 */
function ActivityView() {
  const { workspace, isManager } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  const filters: ActivityFilters = useMemo(() => {
    const feature = search.get('feature');
    const where = search.get('where');
    const range = search.get('range');
    const from = search.get('from') ?? '', to = search.get('to') ?? '';
    return {
      feature: isAiFeature(feature) ? feature : null,
      where: where && UUID.test(where) ? where : null,
      range: ACTIVITY_RANGES.some((r) => r.id === range) ? (range as ActivityRange) : ACTIVITY_DEFAULTS.range,
      from: DAY.test(from) ? from : '', to: DAY.test(to) ? to : '',
      q: (search.get('q') ?? '').slice(0, 200),
    };
  }, [search]);

  const setFilters = useCallback((f: ActivityFilters) => {
    const p = new URLSearchParams();
    if (f.feature) p.set('feature', f.feature);
    if (f.where) p.set('where', f.where);
    if (f.range !== ACTIVITY_DEFAULTS.range) p.set('range', f.range);
    if (f.range === 'custom') { if (f.from) p.set('from', f.from); if (f.to) p.set('to', f.to); }
    if (f.q.trim()) p.set('q', f.q.trim());
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router]);

  if (!workspace) return <PageLoader />;
  return <ActivityTable ws={workspace.id} filters={filters} onFilters={setFilters} canExport={isManager} />;
}

export default function AiActivityPage() {
  return (
    <HubFrame>
      <Suspense fallback={<PageLoader />}>
        <ActivityView />
      </Suspense>
    </HubFrame>
  );
}
