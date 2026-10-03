/**
 * The tour's main call to action, shared by the demo bar and the sidebar:
 * - signed out: "Start your outreach" → sign-up / the product;
 * - signed in, account still waiting for its onboarding call (it would only see the booking page): "Try GrowthxAI" →
 *   the onboarding Calendly in a new tab;
 * - signed in otherwise: "Back to my workspace" → /outreach.
 */
import type { User } from '@supabase/supabase-js';
import { leaveDemo } from '@/lib/outreach/mode';
import { lastAccessStatus } from '@/lib/platform/access';
import { onboardingCalendlyUrl } from '@/lib/platform/leads';

export interface DemoCta {
  label: string;
  go(): void;
}

export function demoCta(user: User | null): DemoCta {
  if (!user) return { label: 'Start your outreach', go: () => leaveDemo() };
  if (lastAccessStatus(user.id) === 'pending') {
    const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string };
    const url = onboardingCalendlyUrl(user.email ?? null, meta.full_name ?? meta.name ?? null, 'product_tour');
    return { label: 'Try GrowthxAI', go: () => { window.open(url, '_blank', 'noopener'); } };
  }
  return { label: 'Back to my workspace', go: () => leaveDemo('/outreach') };
}
