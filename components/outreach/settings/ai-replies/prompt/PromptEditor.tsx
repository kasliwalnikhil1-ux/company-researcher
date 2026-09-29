'use client';

import { useCallback, useMemo, useState } from 'react';
import { History } from 'lucide-react';
import { runRegression, useSaveMasterPrompt } from '@/lib/outreach/aiReplies';
import type { DraftPrompt, PromptSettings, PromptVersion, StageDef } from '@/lib/outreach/aiReplies';
import type { Stage } from '@/lib/outreach/types';
import { parseError } from '@/lib/outreach/api';
import { Button, Textarea, timeAgo } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';
import { sameScope, useAiPromptDraft } from './draftContext';
import type { EditorBase, PromptScopeRef } from './draftContext';
import { EMPTY_SECTIONS, SECTION_META, changedParts, compileGuided, forSend, normalize, validate } from './promptModel';
import PromptSettingsForm from './PromptSettingsForm';
import SafetyRules from './SafetyRules';
import SaveDialog from './SaveDialog';
import type { ChangeKind } from './SaveDialog';
import SaveResult from './SaveResult';
import type { RegressionState, SaveOutcome } from './SaveResult';
import StageTable from './StageTable';
import VersionHistoryDrawer from './VersionHistoryDrawer';
import { aiErrorText } from '../simulator/simModel';

type Base = EditorBase;

/**
 * The editor for one scope. Mount it with a `key` per scope (and per reload): it keeps what it was loaded with in
 * state and never syncs props into state, so a background refetch can't wipe someone's edits. Unsaved edits are
 * also kept in the draft context, so switching tabs and coming back restores them.
 */
export default function PromptEditor({ ws, canEdit, scope, scopeLabel, initial, latestVersion, pipelineStages, onReload }: {
  ws: string;
  canEdit: boolean;
  scope: PromptScopeRef;
  scopeLabel: string;
  initial: Base;
  /** Newest saved version the server reports (to spot someone else's save). */
  latestVersion: number | null;
  pipelineStages: Stage[];
  onReload: () => void;
}) {
  const { draft: kept, publishDraft, openSimulator } = useAiPromptDraft();
  const save = useSaveMasterPrompt(ws);
  // restore unsaved edits left in the context for this same prompt (the editor unmounts on a tab switch)
  const [restored] = useState(() => (kept?.dirty && sameScope(kept, scope) && kept.editor.base.id === initial.id ? kept.editor : null));
  const [base, setBase] = useState<Base>(restored?.base ?? initial);
  const [edited, setEdited] = useState<DraftPrompt | null>(restored?.edited ?? null);
  const [showErrors, setShowErrors] = useState(false);
  const [saveKey, setSaveKey] = useState(0);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [regression, setRegression] = useState<RegressionState | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const isFirst = base.id === null;
  const current = edited ?? base.prompt;
  const parts = useMemo(() => (edited ? changedParts(base.prompt, edited) : []), [base.prompt, edited]);
  const dirty = parts.length > 0;
  const errors = useMemo(() => validate(current), [current]);
  const readOnly = !canEdit;
  const lockedKeys = useMemo(() => new Set(isFirst ? [] : base.prompt.settings.stages.map((s) => s.key)), [isFirst, base.prompt]);
  const stageName = useCallback((id: string) => pipelineStages.find((s) => s.id === id)?.name, [pipelineStages]);

  /** Tell the simulator (and the unsaved-changes guard) what the editor holds. `null` = nothing unsaved. */
  const publish = (next: DraftPrompt | null, b: Base) => {
    if (!next) { publishDraft(null); return; }
    publishDraft({
      scope: scope.scope, scopeId: scope.scopeId, scopeLabel, masterPromptId: b.id, baseVersion: b.version,
      dirty: changedParts(b.prompt, next).length > 0, prompt: forSend(next), editor: { base: b, edited: next },
    });
  };

  const update = (next: DraftPrompt) => { setEdited(next); publish(next, base); };
  const setSettings = (patch: Partial<PromptSettings>) => update({ ...current, settings: { ...current.settings, ...patch } });
  const discard = () => { setEdited(null); setShowErrors(false); publish(null, base); };

  function setMode(mode: 'guided' | 'raw') {
    if (mode === current.editor_mode) return;
    // Raw starts from the guided text as it is now (unless raw text was already edited); switching back keeps the sections
    const rawUntouched = !current.body.trim() || (base.prompt.editor_mode === 'guided' && current.body === base.prompt.body);
    const body = mode === 'raw' && rawUntouched ? compileGuided(current.sections ?? EMPTY_SECTIONS, current.settings) : current.body;
    update({ ...current, editor_mode: mode, body });
  }

  function openSave() {
    setShowErrors(true);
    if (errors.length) return;
    setSaveError(null); setConflict(false); setSaveKey((k) => k + 1); setSaveOpen(true);
  }

  async function confirmSave(kind: ChangeKind, note: string | null) {
    setSaveError(null);
    try {
      const payload = forSend(current);
      const r = await save.mutateAsync({ scope: scope.scope, scope_id: scope.scopeId, ...payload, change_kind: kind, note, base_version: base.version });
      const p = r.prompt;
      const nextBase: Base = { prompt: normalize(p), id: p.id, version: p.version, savedBy: p.updated_by_name, savedAt: p.updated_at };
      setBase(nextBase); setEdited(null); setShowErrors(false); setSaveOpen(false);
      publish(null, nextBase);
      setOutcome({ version: p.version, kind: isFirst ? 'substantive' : kind, reconsent: r.reconsent ?? null });
      if (p.id) {
        setRegression({ status: 'running' });
        runRegression({ workspace_id: ws, master_prompt_id: p.id })
          .then((result) => setRegression({ status: 'done', result }))
          .catch((e) => setRegression({ status: 'error', message: aiErrorText(e).message }));
      }
    } catch (e) {
      const err = parseError(e);
      if (err.code === 'E_CONFLICT') setConflict(true);
      else setSaveError(aiErrorText(err).message);
    }
  }

  function restore(v: PromptVersion) {
    update(normalize(v));
    setHistoryOpen(false);
  }

  const newer = latestVersion != null && base.version != null && latestVersion > base.version;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Editor mode" className="inline-flex rounded-lg border border-gray-300 p-0.5 bg-gray-50">
          {(['guided', 'raw'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={current.editor_mode === m} disabled={readOnly} onClick={() => setMode(m)}
              className={cn('px-3 py-1 text-sm rounded-md', current.editor_mode === m ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-900', readOnly && 'cursor-default')}>
              {m === 'guided' ? 'Guided' : 'Raw'}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-500">
          {isFirst ? 'Not saved yet' : `Version ${base.version}${base.savedBy ? ` · saved by ${base.savedBy}` : ''}${base.savedAt ? ` ${timeAgo(base.savedAt)}` : ''}`}
          {dirty && <span className="ml-2 font-medium text-amber-700">Unsaved changes</span>}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {!isFirst && <Button variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}><History className="w-3.5 h-3.5" />History</Button>}
          {dirty && canEdit && <Button variant="ghost" size="sm" onClick={discard}>Discard changes</Button>}
          {canEdit && <Button size="sm" onClick={openSave} disabled={!dirty && !isFirst}>{isFirst ? 'Save master prompt' : 'Save'}</Button>}
        </div>
      </div>

      {newer && (
        <Note tone="amber">
          Someone saved version {latestVersion} after you opened this.{' '}
          <button type="button" className="underline underline-offset-2 font-medium" onClick={onReload}>Load it</button>{dirty ? ' (your unsaved edits will be lost).' : '.'}
        </Note>
      )}
      {!canEdit && <Note>Only owners and managers can change the master prompt. You can read it and try it in the simulator.</Note>}
      {outcome && <SaveResult outcome={outcome} regression={regression} onOpenSimulator={openSimulator} onDismiss={() => { setOutcome(null); setRegression(null); }} />}
      {showErrors && errors.length > 0 && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <div className="font-medium mb-1">Fix these before saving:</div>
          <ul className="list-disc pl-5 space-y-0.5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      {current.editor_mode === 'guided' ? (
        <>
          <div className="space-y-4">
            {SECTION_META.map((m) => (
              <Textarea key={m.key} label={m.title} hint={m.hint} rows={m.rows} readOnly={readOnly} value={current.sections?.[m.key] ?? ''}
                onChange={(e) => update({ ...current, sections: { ...(current.sections ?? EMPTY_SECTIONS), [m.key]: e.target.value } })} />
            ))}
          </div>
          <section aria-labelledby="ai-stage-table" className="space-y-2">
            <div>
              <h4 id="ai-stage-table" className="text-sm font-semibold text-gray-900">Conversation stages</h4>
              <p className="text-xs text-gray-500">The AI moves through these in order. Early stages never pitch; the pitch stage waits for the number of exchanges below unless they ask.</p>
            </div>
            <StageTable stages={current.settings.stages} lockedKeys={lockedKeys} disabled={readOnly} onChange={(stages: StageDef[]) => setSettings({ stages })} />
          </section>
        </>
      ) : (
        <div className="space-y-2">
          <Textarea label="Master prompt" rows={22} readOnly={readOnly} value={current.body} className="font-mono text-xs leading-relaxed"
            onChange={(e) => update({ ...current, body: e.target.value })} />
          <Note>In Raw mode the stage rules are not checked automatically; the AI and the safety rules still apply.</Note>
        </div>
      )}

      <section aria-labelledby="ai-prompt-settings" className="space-y-3">
        <h4 id="ai-prompt-settings" className="text-sm font-semibold text-gray-900">Settings</h4>
        <PromptSettingsForm value={current.settings} pipelineStages={pipelineStages} disabled={readOnly} onChange={setSettings} />
      </section>

      <SafetyRules />

      {saveOpen && (
        <SaveDialog key={saveKey} open onClose={() => setSaveOpen(false)} isFirst={isFirst} parts={parts} loading={save.isPending}
          error={saveError} conflict={conflict} onReload={() => { setSaveOpen(false); onReload(); }} onConfirm={confirmSave} />
      )}
      {base.id && (
        <VersionHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} masterPromptId={base.id} editor={current}
          canEdit={canEdit} stageName={stageName} onRestore={restore} />
      )}
    </div>
  );
}
