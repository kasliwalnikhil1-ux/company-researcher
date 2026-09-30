'use client';

import { useMemo } from 'react';
import { useLibraryPrompt, useWorkspaceReplySettings } from '@/lib/outreach/aiRepliesSequence';

const DEFAULT_STAGES = [
  { key: 'engage', label: 'Engage' }, { key: 'relate', label: 'Relate' }, { key: 'pitch', label: 'Pitch' }, { key: 'next_step', label: 'Next step' },
];

/**
 * Conversation stage labels for the workspace-wide screens (activity, reports): the workspace's default library prompt
 * when one is set, else the shipped four. "Re-engage" (dormant sessions) and the terminal "Closing" are always present.
 * Each sequence's own tab uses its own prompt's stages.
 */
export function useStageLabels(ws: string | null | undefined) {
  const wsq = useWorkspaceReplySettings(ws);
  const mp = useLibraryPrompt(wsq.data?.default_prompt_id ?? null);
  return useMemo(() => {
    const defined = mp.data?.settings?.stages?.length ? mp.data.settings.stages.map((s) => ({ key: s.key, label: s.label || s.key })) : DEFAULT_STAGES;
    const stages = [
      ...(defined.some((s) => s.key === 're_engage') ? [] : [{ key: 're_engage', label: 'Re-engage' }]),
      ...defined,
      ...(defined.some((s) => s.key === 'closing') ? [] : [{ key: 'closing', label: 'Closing' }]),
    ];
    const labels: Record<string, string> = Object.fromEntries(stages.map((s) => [s.key, s.label]));
    return { stages, labels };
  }, [mp.data]);
}
