'use client';

import HubFrame from '@/components/outreach/ai/hub/HubFrame';
import FeatureCards from '@/components/outreach/ai/hub/setup/FeatureCards';

/** /outreach/ai/setup: one row per AI feature (mode, what it wrote this week, where it is managed) plus General. */
export default function AiSetupPage() {
  return (
    <HubFrame subtitle="Setup: how each AI feature is switched on, what it wrote this week and where you manage it.">
      <FeatureCards />
    </HubFrame>
  );
}
