'use client';

import { useMemo } from 'react';
import { useMasterPrompt } from '@/lib/outreach/aiReplies';

const DEFAULT_STAGES = [
  { key: 'engage', label: 'Engage' }, { key: 'relate', label: 'Relate' }, { key: 'pitch', label: 'Pitch' }, { key: 'next_step', label: 'Next step' },
];

/** Conversation stages of the workspace master prompt (falls back to the shipped four), plus the terminal "Closing". */
export function useStageLabels(ws: string | null | undefined) {
  const mp = useMasterPrompt(ws, 'workspace', null);
  return useMemo(() => {
    const defined = mp.data?.settings?.stages?.length ? mp.data.settings.stages.map((s) => ({ key: s.key, label: s.label || s.key })) : DEFAULT_STAGES;
    const stages = [...defined, ...(defined.some((s) => s.key === 'closing') ? [] : [{ key: 'closing', label: 'Closing' }])];
    const labels: Record<string, string> = Object.fromEntries(stages.map((s) => [s.key, s.label]));
    return { stages, labels };
  }, [mp.data]);
}
