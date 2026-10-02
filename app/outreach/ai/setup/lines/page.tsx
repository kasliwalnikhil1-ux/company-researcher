'use client';

import { Suspense, useMemo } from 'react';
import { useSearchParams } from '@/lib/outreach/nav';
import HubFrame, { SETUP_BACK } from '@/components/outreach/ai/hub/HubFrame';
import AiReviewView from '@/components/outreach/ai/AiReviewView';
import LinesViewSwitch from '@/components/outreach/ai/hub/lines/LinesViewSwitch';
import VariablesView from '@/components/outreach/ai/hub/lines/VariablesView';
import { readSelection } from '@/lib/outreach/intel';
import { PageLoader } from '@/components/outreach/ui';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /outreach/ai/setup/lines: Personalized lines.
 *   (no view)                   the variables: token, prompt, mode, how many lines are ready or waiting
 *   ?view=lines                 every line of every variable: batches, the status filter, Generate lines
 *   ?batch=<id>                 open one batch
 *   ?generate=1                 open the "Generate lines" dialog
 *   ?leads=<id,id,…>            leads to generate for (short selections)
 *   ?selection=<key>            leads to generate for, handed over in sessionStorage by the leads list (long selections)
 * The last four belong to the lines view and open it on their own, as they did on /outreach/ai-review.
 */
function LinesSetupView() {
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
  const lines = params.get('view') === 'lines' || !!batchParam || generate;

  if (lines) return <AiReviewView embedded header={<LinesViewSwitch view="lines" />} batchId={batch} generate={generate} selection={selection} />;
  return <VariablesView header={<LinesViewSwitch view="variables" />} />;
}

export default function AiSetupLinesPage() {
  return (
    <HubFrame back={SETUP_BACK} subtitle="Personalized lines: one AI-written line per lead, or several fields from one AI call, used in a message as tokens. Only approved lines are sent.">
      <Suspense fallback={<PageLoader />}>
        <LinesSetupView />
      </Suspense>
    </HubFrame>
  );
}
