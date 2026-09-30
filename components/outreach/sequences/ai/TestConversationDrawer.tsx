'use client';

// "Test a conversation": play the prospect against the sequence's prompt (saved, or the unsaved edits). Never sends.
import { useMemo, useRef, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import type { Scenario, SimState } from '@/lib/outreach/aiReplies';
import { simulateV2, useSaveTestConversation, type DraftPromptV2, type SequenceAiSettings, type SimulateInputV2 } from '@/lib/outreach/aiRepliesSequence';
import { useSenders } from '@/lib/outreach/queries';
import { Button, useToast } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { forSend, normalize } from '@/components/outreach/settings/ai-replies/prompt/promptModel';
import SaveScenarioModal from '@/components/outreach/settings/ai-replies/simulator/SaveScenarioModal';
import ScenarioList from '@/components/outreach/settings/ai-replies/simulator/ScenarioList';
import SimChat from '@/components/outreach/settings/ai-replies/simulator/SimChat';
import SimSetup, { type PromptSource } from '@/components/outreach/settings/ai-replies/simulator/SimSetup';
import { EMPTY_LEAD, aiErrorText, currentState, fromScenario, stageLabeler, toScenario, toThread, turnId } from '@/components/outreach/settings/ai-replies/simulator/simModel';
import type { ExampleProspect, SimLead, SimTurn } from '@/components/outreach/settings/ai-replies/simulator/simModel';
import { Drawer } from './shared';

export default function TestConversationDrawer({ open, onClose, ws, s, draft, canEdit }: {
  open: boolean; onClose: () => void; ws: string; s: SequenceAiSettings;
  /** Unsaved prompt edits from the card (null when the editor matches the saved prompt). */
  draft: DraftPromptV2 | null;
  canEdit: boolean;
}) {
  return (
    <Drawer open={open} onClose={onClose} title="Test a conversation" subtitle="Play the prospect and see what the AI would do at each step, and why. Nothing is sent." wide>
      {open && <Session ws={ws} s={s} draft={draft} canEdit={canEdit} />}
    </Drawer>
  );
}

function Session({ ws, s, draft, canEdit }: { ws: string; s: SequenceAiSettings; draft: DraftPromptV2 | null; canEdit: boolean }) {
  const toast = useToast();
  const senders = useSenders(ws);
  const saveTest = useSaveTestConversation(ws);
  const [turns, setTurns] = useState<SimTurn[]>([]);
  const [startState] = useState<SimState | null>(null);
  const [lead, setLead] = useState<SimLead>(EMPTY_LEAD);
  const [senderId, setSenderId] = useState(s.senders[0]?.sender_id ?? '');
  const [sourcePick, setSourcePick] = useState<PromptSource | null>(null);
  const [example, setExample] = useState<ExampleProspect | null>(null);
  const [scriptIdx, setScriptIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; setup: boolean } | null>(null);
  const [saveKey, setSaveKey] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const epoch = useRef(0);

  // the unsaved edits carry the cards and Q&A of the saved prompt (they are stored separately and saved at once)
  const draftPrompt = useMemo<DraftPromptV2 | undefined>(() => (draft ? {
    ...forSend({ ...draft, scenarios: s.prompt.scenarios.map((c) => ({ id: c.id, title: c.title, when_text: c.when_text, do_text: c.do_text, enabled: c.enabled })) }),
    faqs: s.prompt.faqs.filter((f) => f.enabled).map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
  } : undefined), [draft, s.prompt.scenarios, s.prompt.faqs]);
  const sources: Array<{ key: PromptSource; label: string; disabled?: boolean; hint?: string }> = [
    { key: 'saved', label: `Saved prompt (v${s.prompt.version})` },
    { key: 'draft', label: 'My unsaved edits', disabled: !draftPrompt, hint: draftPrompt ? undefined : 'Change the prompt to test edits before saving' },
  ];
  const source: PromptSource = sourcePick === 'draft' && draftPrompt ? 'draft' : 'saved';
  const settings = source === 'draft' && draftPrompt ? draftPrompt.settings : normalize(s.prompt).settings;
  const stageLabel = useMemo(() => stageLabeler(settings?.stages), [settings?.stages]);
  const linkedIn = useMemo(() => (senders.data ?? []).filter((x) => x.provider === 'LINKEDIN'), [senders.data]);

  function input(thread: SimTurn[]): SimulateInputV2 {
    const l = Object.fromEntries(Object.entries(lead).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const state = currentState(thread, startState);
    return {
      workspace_id: ws, sequence_id: s.sequence_id, sender_id: senderId || null,
      ...(Object.keys(l).length ? { lead: l } : {}),
      ...(source === 'draft' && draftPrompt ? { draft_prompt: draftPrompt } : {}),
      ...(state ? { state } : {}),
      thread: toThread(thread),
    };
  }

  async function reply(thread: SimTurn[]) {
    if (!canEdit) return;
    const my = ++epoch.current;
    setBusy(true); setError(null);
    try {
      const result = await simulateV2(input(thread));
      if (my !== epoch.current) return;
      setTurns([...thread, { id: turnId(), from: 'ai', result, stateBefore: currentState(thread, startState) }]);
    } catch (e) {
      if (my === epoch.current) setError(aiErrorText(e));
    } finally {
      if (my === epoch.current) setBusy(false);
    }
  }

  function restart(next: SimTurn[], ex: ExampleProspect | null = null) {
    epoch.current++;
    setBusy(false); setError(null); setTurns(next); setExample(ex); setScriptIdx(ex ? 1 : 0);
    return next;
  }

  const onProspect = (text: string, andReply: boolean) => {
    const next = [...turns, { id: turnId(), from: 'prospect' as const, text }];
    setTurns(next);
    if (example && example.script[scriptIdx] === text) setScriptIdx((i) => i + 1);
    if (andReply) reply(next);
  };
  const onExample = (e: ExampleProspect) => {
    setLead(e.lead);
    const next = restart([{ id: turnId(), from: 'prospect', text: e.script[0] }], e);
    if (canEdit) reply(next);
  };
  const onOpenScenario = (sc: Scenario) => { restart(fromScenario(sc)); toast.show(`Loaded "${sc.name}". Press Get AI reply to continue it.`); };

  async function doSave(name: string) {
    setSaveError(null);
    try {
      const data = toScenario(turns);
      await saveTest.mutateAsync({ masterPromptId: s.prompt.id, name, turns: data.turns, expected: data.expected });
      setSaveKey(null);
      toast.show('Saved. Run the set after a prompt change to catch differences.');
    } catch (e) { setSaveError(aiErrorText(e).message); }
  }

  const scenarioData = useMemo(() => toScenario(turns), [turns]);
  const firstLine = turns.find((t) => t.from === 'prospect');
  const defaultName = example?.title ?? (firstLine && firstLine.from === 'prospect' ? firstLine.text.slice(0, 60) : 'Test conversation');

  return (
    <div className="space-y-5">
      {!canEdit && <Note>Only owners and managers can run a test. You can look at the saved test conversations.</Note>}
      <SimSetup testingLabel={s.sequence_name} source={source} sources={sources} onSource={setSourcePick} senders={linkedIn} senderId={senderId} onSender={setSenderId}
        lead={lead} onLead={setLead} onExample={onExample} activeExample={example?.key ?? null} disabled={busy} />
      <SimChat turns={turns} stageLabel={stageLabel} busy={busy} canRun={canEdit} error={error}
        nextScripted={example?.script[scriptIdx] ?? null} onProspect={onProspect} onUs={(text) => setTurns([...turns, { id: turnId(), from: 'us', text }])}
        onReply={() => reply(turns)} onUndo={() => { epoch.current++; setBusy(false); setTurns(turns.slice(0, -1)); }} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={!turns.length && !example} onClick={() => restart([])}><RotateCcw className="w-3.5 h-3.5" />Reset</Button>
        {canEdit && (
          <Button variant="secondary" size="sm" disabled={busy || !scenarioData.expected.length} onClick={() => { setSaveError(null); setSaveKey(Date.now()); }}>
            <Save className="w-3.5 h-3.5" />Save as test conversation
          </Button>
        )}
        {source === 'draft' && <span className="text-xs text-amber-700">Using your unsaved edits.</span>}
      </div>
      <ScenarioList ws={ws} canEdit={canEdit} masterPromptId={s.prompt.id} stageLabel={stageLabel} onOpen={onOpenScenario}
        runInput={{ sequence_id: s.sequence_id, ...(source === 'draft' && draftPrompt ? { draft_prompt: draftPrompt } : {}) }} />
      {saveKey !== null && (
        <SaveScenarioModal key={saveKey} onClose={() => setSaveKey(null)} data={scenarioData} defaultName={defaultName} stageLabel={stageLabel}
          loading={saveTest.isPending} error={saveError} onSave={doSave} />
      )}
      {toast.node}
    </div>
  );
}
