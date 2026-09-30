'use client';

// Sequence builder → AI replies: the whole settings UI for one sequence (changes doc §4.1, contract §8).
import { useCallback, useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSequences, useStages } from '@/lib/outreach/queries';
import { aisqk, useSequenceAiReplies, type DraftPromptV2 } from '@/lib/outreach/aiRepliesSequence';
import { Button, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { TabPage } from '../TabPanels';
import AdvancedSection from './AdvancedSection';
import KnowledgeSection from './KnowledgeSection';
import ModeHeader from './ModeHeader';
import { NumbersRow, StageStrip } from './NumbersAndStages';
import PromptCard from './PromptCard';
import ScenariosSection from './ScenariosSection';
import SendersBlock from './SendersBlock';
import TestConversationDrawer from './TestConversationDrawer';
import UnansweredSection from './UnansweredSection';
import { errText } from './shared';

export default function AiRepliesTab({ sequenceId }: { sequenceId: string | null | undefined }) {
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id ?? null;
  const toast = useToast();
  const qc = useQueryClient();
  const q = useSequenceAiReplies(sequenceId);
  const stagesQ = useStages(ws);
  const sequencesQ = useSequences(ws);
  const [draft, setDraft] = useState<DraftPromptV2 | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const canEdit = isManager && canWrite;
  const onDraftChange = useCallback((d: DraftPromptV2 | null) => setDraft(d), []);
  const reload = useCallback(() => { if (sequenceId) qc.invalidateQueries({ queryKey: aisqk.seqSettings(sequenceId) }); }, [qc, sequenceId]);

  if (!sequenceId) {
    return (
      <TabPage title="AI replies" wide>
        <Note>Save the sequence first. AI replies are set per sequence once it exists.</Note>
      </TabPage>
    );
  }

  const s = q.data;
  return (
    <div role="tabpanel" className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto px-4 py-5 md:px-6 max-w-5xl">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox message={errText(q.error)} />}
      {s && ws && (
        <div className="space-y-4">
          <ModeHeader sequenceId={sequenceId} s={s} canEdit={canEdit} notify={toast.show} />

          <PromptCard key={s.prompt.id ?? 'prompt'} sequenceId={sequenceId} ws={ws} s={s} canEdit={canEdit} sequences={sequencesQ.data ?? []} notify={toast.show} onDraftChange={onDraftChange} onReload={reload} />

          <ScenariosSection sequenceId={sequenceId} cards={s.prompt.scenarios ?? []} canEdit={canEdit} notify={toast.show} />

          <KnowledgeSection sequenceId={sequenceId} ws={ws} knowledge={s.prompt.knowledge ?? []} faqs={s.prompt.faqs ?? []} canEdit={canEdit} notify={toast.show} />

          <section className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
            <NumbersRow sequenceId={sequenceId} s={s} canEdit={canEdit} notify={toast.show} />
            <StageStrip s={s} />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button variant="secondary" onClick={() => setTestOpen(true)}><MessageSquareText className="w-4 h-4" />Test a conversation</Button>
              <span className="text-xs text-gray-500">{draft ? 'Tests your unsaved edits too.' : 'Play the prospect and see what the AI would do. Nothing is sent.'}</span>
            </div>
          </section>

          <AdvancedSection sequenceId={sequenceId} s={s} stages={stagesQ.data ?? []} canEdit={canEdit} notify={toast.show} />

          <UnansweredSection sequenceId={sequenceId} canEdit={canEdit} notify={toast.show} />

          <SendersBlock sequenceId={sequenceId} ws={ws} senders={s.senders ?? []} canEdit={canEdit} notify={toast.show} />

          <TestConversationDrawer open={testOpen} onClose={() => setTestOpen(false)} ws={ws} s={s} draft={draft} canEdit={canEdit} />
        </div>
      )}
      {toast.node}
      </div>
    </div>
  );
}
