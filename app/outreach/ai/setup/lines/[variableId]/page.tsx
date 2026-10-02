'use client';

import { useParams } from '@/lib/outreach/nav';
import HubFrame from '@/components/outreach/ai/hub/HubFrame';
import VariableEditor from '@/components/outreach/ai/hub/lines/VariableEditor';
import { hubHref } from '@/lib/outreach/aiHub';

/** /outreach/ai/setup/lines/<variable id>: one variable of Personalized lines (its settings, its mode, its lines). */
export default function AiSetupLinePage() {
  const params = useParams<{ variableId: string }>();
  return (
    <HubFrame back={{ href: hubHref.setupLines(), label: 'Personalized lines' }} subtitle="Personalized lines: what the AI writes for one variable, its mode and the lines it wrote.">
      <VariableEditor variableId={String(params?.variableId ?? '')} />
    </HubFrame>
  );
}
