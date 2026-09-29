'use client';

import { useState } from 'react';
import { CheckCircle2, Play, Trash2, XCircle } from 'lucide-react';
import { runRegression, useDeleteScenario, useScenarios } from '@/lib/outreach/aiReplies';
import type { RegressionResult, Scenario } from '@/lib/outreach/aiReplies';
import { Badge, Button, ErrorBox, Spinner, timeAgo } from '@/components/outreach/ui';
import { ConfirmModal } from '@/components/outreach/settings/shared';
import { DECISION_LABEL, aiErrorText } from './simModel';

type RunInput = Omit<Parameters<typeof runRegression>[0], 'workspace_id'>;
type ScenarioResult = RegressionResult['results'][number];

function Changes({ res, stageLabel }: { res: ScenarioResult; stageLabel: (k: string | null | undefined) => string }) {
  const rows = res.turns.filter((t) => t.changed || t.expected.decision !== t.got.decision || (t.expected.stage_after && t.expected.stage_after !== t.got.stage_after));
  if (!rows.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {rows.map((t) => {
        const decisionOff = t.expected.decision !== t.got.decision;
        const stageOff = !!t.expected.stage_after && t.expected.stage_after !== t.got.stage_after;
        return (
          <div key={t.after_turn} className="rounded-lg border border-gray-200 bg-white p-2.5 text-xs space-y-1">
            <div className="font-medium text-gray-700">After line {t.after_turn + 1}</div>
            {decisionOff && <div className="text-red-700">Expected {DECISION_LABEL[t.expected.decision]}, got {DECISION_LABEL[t.got.decision]}.</div>}
            {stageOff && <div className="text-red-700">Expected stage {stageLabel(t.expected.stage_after)}, got {stageLabel(t.got.stage_after)}.</div>}
            {t.changed && (
              <div className="grid sm:grid-cols-2 gap-2">
                <div><div className="text-gray-500 mb-0.5">Before</div><div className="rounded bg-red-50 text-red-900 px-2 py-1 whitespace-pre-wrap break-words">{t.prev_text ?? '(no reply)'}</div></div>
                <div><div className="text-gray-500 mb-0.5">Now</div><div className="rounded bg-green-50 text-green-900 px-2 py-1 whitespace-pre-wrap break-words">{t.got.text ?? '(no reply)'}</div></div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The stored result of the last run: either this scenario's own entry or a whole regression result. */
function lastResult(s: Scenario): ScenarioResult | undefined {
  const r = s.last_result as unknown as { results?: ScenarioResult[]; turns?: unknown } | null;
  if (!r) return undefined;
  if (Array.isArray(r.results)) return r.results.find((x) => x.scenario_id === s.id);
  return Array.isArray(r.turns) ? (r as unknown as ScenarioResult) : undefined;
}

/** Saved conversations (the regression set) for the prompt being tested. */
export default function ScenarioList({ ws, canEdit, masterPromptId, runInput, stageLabel, onOpen }: {
  ws: string;
  canEdit: boolean;
  /** null = scenarios of the workspace prompt. */
  masterPromptId: string | null;
  runInput: RunInput;
  stageLabel: (k: string | null | undefined) => string;
  onOpen: (s: Scenario) => void;
}) {
  const scenarios = useScenarios(ws, masterPromptId);
  const del = useDeleteScenario(ws);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RegressionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Scenario | null>(null);

  async function runAll() {
    setRunning(true); setError(null);
    try {
      setResult(await runRegression({ workspace_id: ws, ...runInput }));
      scenarios.refetch();
    } catch (e) { setError(aiErrorText(e).message); } finally { setRunning(false); }
  }

  const list = scenarios.data ?? [];
  const byId = new Map((result?.results ?? []).map((r) => [r.scenario_id, r]));

  return (
    <section aria-labelledby="ai-sim-scenarios" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <h4 id="ai-sim-scenarios" className="text-sm font-semibold text-gray-900">Saved conversations</h4>
          <p className="text-xs text-gray-500">Every save of the master prompt re-runs these and shows which replies changed.</p>
        </div>
        {result && <span className="text-sm text-gray-700">{result.passed}/{result.total} pass</span>}
        {canEdit && <Button size="sm" variant="secondary" onClick={runAll} loading={running} disabled={!list.length}><Play className="w-3.5 h-3.5" />Run all</Button>}
      </div>
      {error && <ErrorBox message={error} />}
      {scenarios.isLoading ? <Spinner className="py-6" /> : scenarios.isError ? <ErrorBox message={aiErrorText(scenarios.error).message} /> : !list.length ? (
        <p className="text-sm text-gray-500 rounded-lg border border-dashed border-gray-300 px-3 py-4 text-center">No saved conversations yet. Play one above and save it.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((s) => {
            const res = byId.get(s.id) ?? lastResult(s);
            const passed = byId.has(s.id) ? res!.passed : s.passed;
            return (
              <li key={s.id} className="rounded-lg border border-gray-200 bg-gray-50/50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {passed === true ? <CheckCircle2 className="w-4 h-4 text-green-600" aria-label="Passes" /> : passed === false ? <XCircle className="w-4 h-4 text-red-600" aria-label="Fails" /> : <span className="w-4" />}
                  <span className="text-sm font-medium text-gray-900 truncate">{s.name}</span>
                  <Badge>{s.turns.length} lines</Badge>
                  <span className="text-xs text-gray-500">{s.last_run_at ? `Last run ${timeAgo(s.last_run_at)}${s.last_version ? ` on version ${s.last_version}` : ''}` : 'Not run yet'}</span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => onOpen(s)}>Open</Button>
                    {canEdit && (
                      <button type="button" aria-label={`Delete ${s.name}`} onClick={() => setToDelete(s)} className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
                    )}
                  </div>
                </div>
                {res && <Changes res={res} stageLabel={stageLabel} />}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmModal open={!!toDelete} onClose={() => setToDelete(null)} loading={del.isPending} title="Delete this conversation?" confirmLabel="Delete"
        onConfirm={async () => { if (!toDelete) return; try { await del.mutateAsync(toDelete.id); setToDelete(null); } catch (e) { setError(aiErrorText(e).message); setToDelete(null); } }}>
        <p>&ldquo;{toDelete?.name}&rdquo; will no longer be checked when the prompt changes.</p>
      </ConfirmModal>
    </section>
  );
}
