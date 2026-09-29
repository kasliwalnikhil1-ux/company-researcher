'use client';

import { useMemo, useRef, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { simulate, useAiRun, useMasterPrompt, useMasterPromptList, useSaveScenario } from '@/lib/outreach/aiReplies';
import type { PromptScope, Scenario, SimulateInput } from '@/lib/outreach/aiReplies';
import { useClients, useSenders, useSequences } from '@/lib/outreach/queries';
import { Button, Card, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { SIMULATOR_ANCHOR, WithDraftProvider, sameScope, useAiPromptDraft } from '../prompt/draftContext';
import type { PromptScopeRef } from '../prompt/draftContext';
import { forSend, normalize } from '../prompt/promptModel';
import { scopeLabel } from '../prompt/ScopePicker';
import { buildReplay } from './replay';
import type { Replay } from './replay';
import { DECISION_LABEL, EMPTY_LEAD, aiErrorText, currentState, fromScenario, stageLabeler, toScenario, toThread, turnId } from './simModel';
import type { ExampleProspect, SimLead, SimTurn } from './simModel';
import SaveScenarioModal from './SaveScenarioModal';
import ScenarioList from './ScenarioList';
import SimChat from './SimChat';
import SimSetup from './SimSetup';
import type { PromptSource } from './SimSetup';

export interface SimulatorPanelProps {
  ws: string;
  canEdit: boolean;
  /** "Why did it say that?": a real run to replay with the exact prompt version it used. */
  runId?: string | null;
  scope?: { scope: PromptScope; scopeId: string | null };
}

const WORKSPACE: PromptScopeRef = { scope: 'workspace', scopeId: null };

/** Settings → AI replies → Conversation simulator. Never sends anything and never creates real runs. */
export function SimulatorPanel(props: SimulatorPanelProps) {
  return <WithDraftProvider><Loader {...props} /></WithDraftProvider>;
}
export default SimulatorPanel;

function Loader(props: SimulatorPanelProps) {
  const run = useAiRun(props.runId ?? null);
  const list = useMasterPromptList(props.ws);
  const waiting = !!props.runId && (run.isLoading || list.isLoading);
  const replay = useMemo(() => (props.runId && run.data ? buildReplay(run.data, list.data) : null), [props.runId, run.data, list.data]);
  return (
    <div id={SIMULATOR_ANCHOR} className="scroll-mt-4">
      <Card title="Conversation simulator">
        {waiting ? <Spinner /> : props.runId && run.isError ? <ErrorBox message={aiErrorText(run.error).message} /> : (
          <Session key={replay?.runId ?? 'blank'} {...props} replay={replay} />
        )}
      </Card>
    </div>
  );
}

function Session({ ws, canEdit, scope: scopeProp, replay }: SimulatorPanelProps & { replay: Replay | null }) {
  const ctx = useAiPromptDraft();
  const toast = useToast();
  const list = useMasterPromptList(ws);
  const senders = useSenders(ws);
  const clients = useClients(ws);
  const sequences = useSequences(ws);
  const saveScenario = useSaveScenario(ws);
  const scope = replay?.scope ?? ctx.scope ?? scopeProp ?? WORKSPACE;
  const saved = useMasterPrompt(ws, scope.scope, scope.scopeId);

  const [turns, setTurns] = useState<SimTurn[]>(replay?.turns ?? []);
  const [startState, setStartState] = useState(replay?.state ?? null);
  const [lead, setLead] = useState<SimLead>(replay?.lead ?? EMPTY_LEAD);
  const [senderId, setSenderId] = useState(replay?.senderId ?? '');
  const [sourcePick, setSourcePick] = useState<PromptSource | null>(null);
  const [example, setExample] = useState<ExampleProspect | null>(null);
  const [scriptIdx, setScriptIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; setup: boolean } | null>(null);
  const [saveKey, setSaveKey] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const epoch = useRef(0);

  const sp = saved.data;
  const savedAvail = !!sp && (sp.exists || !!sp.inherited);
  const draft = ctx.draft && sameScope(ctx.draft, scope) && ctx.draft.dirty ? ctx.draft.prompt : null;
  const sources: Array<{ key: PromptSource; label: string; disabled?: boolean; hint?: string }> = [
    ...(replay?.version ? [{ key: 'version' as const, label: `Version ${replay.version} (used then)` }] : []),
    { key: 'saved', label: savedAvail ? 'Saved prompt' : 'Starting template', disabled: !sp },
    { key: 'draft', label: 'My unsaved edits', disabled: !draft, hint: draft ? undefined : 'Change the master prompt to try edits before saving' },
  ];
  const pickOk = !!sourcePick && sources.some((s) => s.key === sourcePick && !s.disabled);
  const source: PromptSource = pickOk ? sourcePick! : replay?.version ? 'version' : 'saved';
  const settings = source === 'draft' && draft ? draft.settings : sp ? normalize(savedAvail ? sp : sp.template).settings : undefined;
  const stageLabel = useMemo(() => stageLabeler(settings?.stages), [settings?.stages]);
  const linkedIn = useMemo(() => (senders.data ?? []).filter((s) => s.provider === 'LINKEDIN'), [senders.data]);
  const label = scopeLabel(scope, clients.data, sequences.data, list.data);
  const overrideId = scope.scope !== 'workspace' && sp?.exists ? sp.id : null;
  // nothing saved anywhere yet: test the starting template the editor shows
  const draftPrompt = source === 'draft' && draft ? draft : source === 'saved' && sp && !savedAvail ? forSend(normalize(sp.template)) : undefined;

  function input(thread: SimTurn[]): SimulateInput {
    const l = Object.fromEntries(Object.entries(lead).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const state = currentState(thread, startState);
    return {
      workspace_id: ws, scope: scope.scope, scope_id: scope.scopeId, sender_id: senderId || null,
      ...(Object.keys(l).length ? { lead: l } : {}),
      ...(draftPrompt ? { draft_prompt: draftPrompt } : {}),
      ...(source === 'version' && replay?.version ? { version: replay.version } : {}),
      ...(state ? { state } : {}),
      thread: toThread(thread),
    };
  }

  async function reply(thread: SimTurn[]) {
    if (!canEdit) return;
    const my = ++epoch.current;
    setBusy(true); setError(null);
    try {
      const result = await simulate(input(thread));
      if (my !== epoch.current) return;
      setTurns([...thread, { id: turnId(), from: 'ai', result, stateBefore: currentState(thread, startState) }]);
    } catch (e) {
      if (my === epoch.current) setError(aiErrorText(e));
    } finally {
      if (my === epoch.current) setBusy(false);
    }
  }

  /** Start over with `next` lines; any reply still on its way is ignored. */
  function restart(next: SimTurn[], opts: { example?: ExampleProspect | null; state?: typeof startState } = {}) {
    epoch.current++;
    setBusy(false); setError(null);
    setTurns(next); setStartState(opts.state ?? null);
    setExample(opts.example ?? null); setScriptIdx(opts.example ? 1 : 0);
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
    const next = restart([{ id: turnId(), from: 'prospect', text: e.script[0] }], { example: e });
    if (canEdit) reply(next);
  };
  const onOpenScenario = (s: Scenario) => { restart(fromScenario(s)); toast.show(`Loaded “${s.name}”. Press Get AI reply to continue it.`); };

  async function doSaveScenario(name: string, onlyOverride: boolean) {
    setSaveError(null);
    try {
      const data = toScenario(turns);
      await saveScenario.mutateAsync({ masterPromptId: onlyOverride ? overrideId : null, name, turns: data.turns, expected: data.expected });
      setSaveKey(null);
      toast.show('Saved. It will be re-run on every prompt save.');
    } catch (e) { setSaveError(aiErrorText(e).message); }
  }

  const scenarioData = useMemo(() => toScenario(turns), [turns]);
  const firstLine = turns.find((t) => t.from === 'prospect');
  const defaultName = example?.title ?? (firstLine && firstLine.from === 'prospect' ? firstLine.text.slice(0, 60) : 'Test conversation');

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-600">Play the prospect and see what the AI would do at each step, and why. Nothing is sent.</p>
      {!canEdit && <Note>Only owners and managers can run the simulator. You can look at the saved conversations.</Note>}
      {replay && (
        <Note tone="indigo">
          Loaded the real conversation{replay.leadName ? ` with ${replay.leadName}` : ''} and the state the AI saw.
          It decided <span className="font-medium">{replay.original.decision ? DECISION_LABEL[replay.original.decision] : 'nothing yet'}</span>
          {replay.original.rule ? <> following &ldquo;{replay.original.rule}&rdquo;</> : null}
          {replay.original.text ? <>: &ldquo;{replay.original.text}&rdquo;</> : '.'} Press Get AI reply to run it again.
        </Note>
      )}
      <SimSetup testingLabel={label} source={source} sources={sources} onSource={setSourcePick} senders={linkedIn} senderId={senderId} onSender={setSenderId}
        lead={lead} onLead={setLead} onExample={onExample} activeExample={example?.key ?? null} disabled={busy} />
      <SimChat turns={turns} stageLabel={stageLabel} busy={busy} canRun={canEdit} error={error}
        nextScripted={example?.script[scriptIdx] ?? null} onProspect={onProspect} onUs={(text) => setTurns([...turns, { id: turnId(), from: 'us', text }])}
        onReply={() => reply(turns)} onUndo={() => { epoch.current++; setBusy(false); setTurns(turns.slice(0, -1)); }} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={!turns.length && !example}
          onClick={() => restart(replay ? replay.turns : [], { state: replay?.state ?? null })}>
          <RotateCcw className="w-3.5 h-3.5" />{replay ? 'Back to the real conversation' : 'Reset'}
        </Button>
        {canEdit && (
          <Button variant="secondary" size="sm" disabled={busy || !scenarioData.expected.length} onClick={() => { setSaveError(null); setSaveKey(Date.now()); }}>
            <Save className="w-3.5 h-3.5" />Save as test conversation
          </Button>
        )}
        {source === 'draft' && <span className="text-xs text-amber-700">Using your unsaved edits.</span>}
      </div>
      <ScenarioList ws={ws} canEdit={canEdit} masterPromptId={overrideId} stageLabel={stageLabel} onOpen={onOpenScenario}
        runInput={{ master_prompt_id: sp?.exists ? sp.id : null, scope: scope.scope, scope_id: scope.scopeId, ...(draftPrompt ? { draft_prompt: draftPrompt } : {}) }} />
      {saveKey !== null && (
        <SaveScenarioModal key={saveKey} onClose={() => setSaveKey(null)} data={scenarioData} defaultName={defaultName} stageLabel={stageLabel}
          overrideLabel={overrideId ? label : null} loading={saveScenario.isPending} error={saveError} onSave={doSaveScenario} />
      )}
      {saved.isError && <ErrorBox message={aiErrorText(saved.error).message} />}
      {toast.node}
    </div>
  );
}
