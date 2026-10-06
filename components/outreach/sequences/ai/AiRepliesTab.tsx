'use client';

// Sequence builder → AI tab: the AI replies settings of one sequence (changes doc §4.1, contract §8) and what the AI wrote for it.
// One feature card (mode + notices + test) on top, then sub-tabs: Instructions (prompt, scenarios, knowledge) · Settings (incl. the prompt's
// own settings, portalled in by PromptCard) · Activity. No sender approval: a sender in the pool replies on Auto (migration 079).
import { useCallback, useMemo, useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSequences, useStages } from '@/lib/outreach/queries';
import { aisqk, useSequenceAiReplies, useUnanswered, type DraftPromptV2 } from '@/lib/outreach/aiRepliesSequence';
import { Button, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { TabPage } from '../TabPanels';
import AdvancedSection from './AdvancedSection';
import KnowledgeSection from './KnowledgeSection';
import ModeHeader from './ModeHeader';
import { NumbersRow, StageStrip } from './NumbersAndStages';
import PromptCard from './PromptCard';
import ScenariosSection from './ScenariosSection';
import TestConversationDrawer from './TestConversationDrawer';
import UnansweredSection from './UnansweredSection';
import { Section, errText } from './shared';
import { cn } from '@/lib/utils';
import { Tabs } from '@/components/ui/Tabs';
import { changedParts, normalize } from '@/components/outreach/settings/ai-replies/prompt/promptModel';
import Link from '@/lib/outreach/nav';
import ActivityTable from '@/components/outreach/ai/hub/ActivityTable';
import { hubHref } from '@/lib/outreach/aiHub';

type SubTab = 'prompt' | 'rules' | 'activity';

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
  const [settingsHost, setSettingsHost] = useState<HTMLDivElement | null>(null);
  const [sub, setSubState] = useState<SubTab>('prompt');
  const [seen, setSeen] = useState<Set<SubTab>>(() => new Set(['prompt']));
  const setSub = (k: SubTab) => { setSubState(k); setSeen((prev) => (prev.has(k) ? prev : new Set(prev).add(k))); };
  const openQuestions = useUnanswered(sequenceId, 'open');
  const canEdit = isManager && canWrite;
  const onDraftChange = useCallback((d: DraftPromptV2 | null) => setDraft(d), []);
  const reload = useCallback(() => { if (sequenceId) qc.invalidateQueries({ queryKey: aisqk.seqSettings(sequenceId) }); }, [qc, sequenceId]);

  // which tab holds the unsaved edits: the prompt's Settings block is drawn under the Settings tab
  const draftParts = useMemo(() => (draft && q.data ? changedParts(normalize(q.data.prompt), draft) : []), [draft, q.data]);

  if (!sequenceId) {
    return (
      <TabPage title="AI replies" subtitle="AI automatically replies to prospects who respond to this sequence." wide>
        <Note>Save the sequence first. AI replies are set per sequence once it exists.</Note>
      </TabPage>
    );
  }

  const s = q.data;
  const unanswered = openQuestions.data?.length ?? 0;
  const tabs: Array<{ k: SubTab; label: string; count?: number; title: string }> = [
    { k: 'prompt', label: 'Instructions', count: unanswered || undefined, title: 'How the AI replies: who it is, how a conversation goes, scenario cards and what it may answer from.' },
    { k: 'rules', label: 'Settings', title: 'Stages, limits, timing, languages and when a person takes over.' },
    { k: 'activity', label: 'Activity', title: 'Every reply the AI drafted or sent for this sequence.' },
  ];
  const current = tabs.find((t) => t.k === sub);
  const panel = (k: SubTab) => cn('space-y-4', sub !== k && 'hidden');
  return (
    <TabPage title="AI replies" subtitle="AI automatically replies to prospects who respond to this sequence." wide>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox message={errText(q.error)} />}
      {s && ws && (
        <div className="space-y-4">
          <ModeHeader sequenceId={sequenceId} s={s} canEdit={canEdit} notify={toast.show}
            actions={<Button size="sm" variant="secondary" onClick={() => setTestOpen(true)} title={draft ? 'Tests your unsaved edits too.' : 'Play the prospect and see what the AI would do. Nothing is sent.'}><MessageSquareText className="w-4 h-4" />Test a conversation</Button>} />

          {/* What the AI works from, one part at a time. Panels stay mounted so unsaved prompt edits survive a switch. */}
          <Tabs label="AI replies settings" value={sub} onChange={setSub} className="pt-2"
            items={tabs.map((t) => ({ value: t.k, title: t.title, label: <>
              {t.label}
              {((t.k === 'prompt' && draftParts.some((x) => x !== 'Settings')) || (t.k === 'rules' && draftParts.includes('Settings'))) && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-label="Unsaved edits" />}
              {t.count ? <span className="min-w-[1.25rem] px-1 rounded-full bg-amber-100 text-amber-800 text-[11px] font-medium tabular-nums text-center">{t.count}</span> : null}
            </> }))} />
          {current && <p className="-mt-1 text-xs text-gray-500">{current.title}</p>}

          <div className={panel('prompt')}>
            <PromptCard key={s.prompt.id ?? 'prompt'} sequenceId={sequenceId} ws={ws} s={s} canEdit={canEdit} sequences={sequencesQ.data ?? []} notify={toast.show} onDraftChange={onDraftChange} onReload={reload} settingsHost={settingsHost} />
            <ScenariosSection sequenceId={sequenceId} cards={s.prompt.scenarios ?? []} canEdit={canEdit} notify={toast.show} />
            <KnowledgeSection sequenceId={sequenceId} ws={ws} knowledge={s.prompt.knowledge ?? []} faqs={s.prompt.faqs ?? []} canEdit={canEdit} notify={toast.show} />
            <UnansweredSection sequenceId={sequenceId} canEdit={canEdit} notify={toast.show} />
          </div>

          <div className={panel('rules')}>
            <Section title="Conversation" help="How far the AI takes a conversation before it pitches and before a person takes over.">
              <NumbersRow sequenceId={sequenceId} s={s} canEdit={canEdit} notify={toast.show} />
              <StageStrip s={s} />
            </Section>
            <AdvancedSection sequenceId={sequenceId} s={s} stages={stagesQ.data ?? []} canEdit={canEdit} notify={toast.show} alwaysOpen />
            {/* PromptCard draws the prompt's own settings (reply length, bot question, skip to pitch) here */}
            <div ref={setSettingsHost} />
          </div>

          {/* The Activity table, pre-filtered to this sequence's replies (it replaced the run log in Settings). Mounted on first open. */}
          <div className={panel('activity')}>
            {seen.has('activity') && (
              <Section title="What the AI wrote" actions={<Link href={hubHref.activity({ feature: 'reply', where: sequenceId })} className="text-xs font-medium text-indigo-700 hover:underline">Open in Activity</Link>}>
                <ActivityTable ws={ws} fixed={{ feature: 'reply', where: sequenceId }} pageSize={20} emptyText="The AI has not written a reply for this sequence in this period." />
              </Section>
            )}
          </div>

          <TestConversationDrawer open={testOpen} onClose={() => setTestOpen(false)} ws={ws} s={s} draft={draft} canEdit={canEdit} />
        </div>
      )}
      {toast.node}
    </TabPage>
  );
}
