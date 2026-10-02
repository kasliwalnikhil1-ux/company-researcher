'use client';

// Plan feature gates (pricing-billing-PRD.md §11.3): the small plan tag and the one-line note a locked feature shows next
// to its disabled control. The server enforces every gate; these only say why a control is off and where to upgrade.
import Link from '@/lib/outreach/nav';
import { Lock } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { planLabel, usePlanFeature, type FeatureKey } from '@/lib/outreach/billing';
import { Badge } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';

/** "Scale" / "Enterprise" with a tiny lock: the plan that unlocks a feature. */
export function PlanTag({ plan }: { plan: string | null | undefined }) {
  const label = planLabel(plan);
  if (!label) return null;
  return <Badge tone="indigo" className="gap-1"><Lock className="w-3 h-3" aria-hidden="true" />{label}</Badge>;
}

/**
 * One line for a locked feature: the plan tag, "{what} is available on Scale." and, for the owner, an Upgrade link that
 * opens the change screen with that plan selected. Renders nothing while the feature is on (and while billing loads).
 */
export function UpgradeNote({ feature, what, className }: { feature: FeatureKey; what: string; className?: string }) {
  const { workspace, isOwner } = useWorkspace();
  const f = usePlanFeature(workspace?.id, feature);
  if (f.enabled) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-600', className)}>
      <PlanTag plan={f.minPlan} />
      <span>{what} is available on {f.minPlanLabel || 'a higher plan'}.</span>
      {isOwner ? <Link href={f.upgradeHref} className="font-medium text-indigo-600 hover:underline">Upgrade</Link> : <span>Ask the workspace owner to upgrade.</span>}
    </div>
  );
}
