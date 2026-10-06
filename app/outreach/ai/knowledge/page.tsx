'use client';

import { Suspense } from 'react';
import { useSearchParams } from '@/lib/outreach/nav';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import HubFrame from '@/components/outreach/ai/hub/HubFrame';
import KnowledgeLibrary from '@/components/outreach/ai/hub/knowledge/KnowledgeLibrary';
import { PageLoader } from '@/components/outreach/ui';

/**
 * /outreach/ai/knowledge: the workspace's library of what the AI may answer from.
 *   (no view)   Sources: websites, documents and texts, with the sequences and websites that use each one
 *   ?view=qa    Q&A: question and answer pairs, shared unless limited to some sequences and websites
 * Unanswered questions are a row here and are answered in Needs you.
 */
function KnowledgeView() {
  const { workspace } = useWorkspace();
  const search = useSearchParams();
  if (!workspace) return <PageLoader />;
  return <KnowledgeLibrary ws={workspace.id} view={search.get('view') === 'qa' ? 'qa' : 'sources'} />;
}

export default function AiKnowledgePage() {
  return (
    <HubFrame>
      <Suspense fallback={<PageLoader />}>
        <KnowledgeView />
      </Suspense>
    </HubFrame>
  );
}
