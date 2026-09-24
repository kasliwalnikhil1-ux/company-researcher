'use client';

// Publish dialog (plan items 5–7): shows what a publish would touch before anything changes, then publishes.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, MessageSquare, Minus, Pencil, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError, rpc } from '@/lib/outreach/api';
import type { GraphIssue } from '@/lib/outreach/graph';
import type { Graph } from '@/lib/outreach/types';
import { Badge, Button, ErrorBox, Modal, Spinner, Textarea } from '@/components/outreach/ui';
import { IssueList } from './Modals';
import type { Draft } from './draft';
import { formatGraphError, nodeTitle } from './helpers';
import { fmtInt, plural, type ImpactIssue, type PublishImpact, type PublishImpactNode, type PublishMode, type PublishResult, type RemovedMode } from './publishTypes';

export type PublishOutcome = PublishResult;

interface Props {
  open: boolean;
  onClose: () => void;
  sequenceId: string;
  liveGraph: Graph;
  draft: Draft;
  /** Plain labels of the non-graph fields that differ from the live sequence ("name", "settings", …). */
  metaLabels: string[];
  onFocusNode: (id: string) => void;
  onPublished: (r: PublishOutcome) => void;
}

const toIssues = (items: ImpactIssue[] | undefined): GraphIssue[] => (items ?? []).map((i) => ({ node_id: i.node_id ?? undefined, code: String(i.code ?? 'issue'), message: String(i.message ?? i.code ?? 'Issue') }));

const CHANGE_META: Record<PublishImpactNode['change'], { tone: 'green' | 'red' | 'amber'; label: string; Icon: typeof Plus }> = {
  added: { tone: 'green', label: 'Added', Icon: Plus },
  removed: { tone: 'red', label: 'Removed', Icon: Minus },
  changed: { tone: 'amber', label: 'Changed', Icon: Pencil },
};

function Choice({ checked, onSelect, title, children, name, disabled }: { checked: boolean; onSelect: () => void; title: string; children: React.ReactNode; name: string; disabled?: boolean }) {
  return (
    <label className={cn('flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors', checked ? 'border-indigo-500 bg-indigo-50/50' : 'border-gray-200 hover:bg-gray-50', disabled && 'opacity-60 cursor-not-allowed')}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} disabled={disabled} className="mt-0.5 text-indigo-600 focus:ring-indigo-500" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-900">{title}</span>
        <span className="block text-xs text-gray-600 mt-0.5">{children}</span>
      </span>
    </label>
  );
}

function Check({ checked, onChange, title, children }: { checked: boolean; onChange: (v: boolean) => void; title: string; children?: React.ReactNode }) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
      <span className="min-w-0">
        <span className="block text-sm text-gray-900">{title}</span>
        {children && <span className="block text-xs text-gray-500 mt-0.5">{children}</span>}
      </span>
    </label>
  );
}

export default function PublishDialog({ open, onClose, sequenceId, liveGraph, draft, metaLabels, onFocusNode, onPublished }: Props) {
  const [impact, setImpact] = useState<PublishImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<PublishMode>('all');
  const [updateQueued, setUpdateQueued] = useState(false);
  const [reschedule, setReschedule] = useState(false);
  const [removedMode, setRemovedMode] = useState<RemovedMode>('skip');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleHit, setStaleHit] = useState<string | null>(null);
  const [result, setResult] = useState<PublishOutcome | null>(null);
  const reqId = useRef(0);
  // The graph the numbers were computed for. Publishing sends exactly this graph.
  const graphRef = useRef<Graph>(draft.graph);

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    graphRef.current = draft.graph;
    setLoading(true); setLoadError(null);
    try {
      const r = await rpc<PublishImpact>('publish_impact', { p_id: sequenceId, p_graph: graphRef.current });
      if (mine !== reqId.current) return;
      setImpact(r);
    } catch (e) {
      if (mine !== reqId.current) return;
      setLoadError(parseError(e).message);
    } finally { if (mine === reqId.current) setLoading(false); }
  }, [sequenceId, draft.graph]);

  useEffect(() => {
    if (!open) return;
    setImpact(null); setResult(null); setError(null); setStaleHit(null); setMode('all'); setUpdateQueued(false); setReschedule(false); setRemovedMode('skip'); setNote('');
    void load();
    // only when the dialog opens: edits cannot happen underneath an open modal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const errors = useMemo(() => toIssues(impact?.validation?.errors), [impact]);
  const warnings = useMemo(() => toIssues(impact?.validation?.warnings), [impact]);
  const nodes = impact?.nodes ?? [];
  const removedWithLeads = nodes.filter((n) => n.change === 'removed' && n.leads_here > 0);
  const removedLeadCount = removedWithLeads.reduce((a, n) => a + n.leads_here, 0);
  const textChanged = nodes.some((n) => n.text_changed);
  const delayChanged = nodes.some((n) => n.delay_changed);
  const affectable = impact ? Math.max(impact.in_flight - impact.already_pinned, 0) : 0;
  const stale = !!impact?.stale || !!staleHit;
  const blocked = errors.length > 0;
  const title = (n: PublishImpactNode) => nodeTitle(draft.graph.nodes[n.node_id] ?? liveGraph.nodes[n.node_id]) || n.type;

  const publish = async (force: boolean) => {
    setBusy(true); setError(null);
    try {
      const r = await rpc<PublishResult>('publish_sequence', {
        p_id: sequenceId, p_graph: graphRef.current, p_mode: mode, p_note: note.trim() || null, p_force: force,
        p_update_queued: mode === 'all' && textChanged && updateQueued && (impact?.queued_with_old_text ?? 0) > 0,
        p_reschedule_delays: mode === 'all' && delayChanged && reschedule && (impact?.waiting_on_changed_delay ?? 0) > 0,
        p_removed_mode: removedMode, p_pool: null, p_settings: draft.settings ?? null, p_name: draft.name.trim() || null,
        p_assignment: draft.assignment, p_use_sender_schedule: draft.useSenderSchedule, p_client_id: draft.clientId ?? null, p_brief: draft.brief ?? '',
      });
      setResult(r);
      onPublished(r);
    } catch (e) {
      const err = parseError(e);
      if (err.code === 'E_DRAFT_STALE') { setStaleHit(err.message); void load(); }
      else setError(formatGraphError(e, draft.graph));
    } finally { setBusy(false); }
  };

  if (!open) return null;

  if (result) {
    return (
      <Modal open onClose={onClose} title={`Version ${result.version} is live`} size="md" footer={<Button onClick={onClose} autoFocus>Done</Button>}>
        <div className="space-y-3 text-sm text-gray-700">
          <div className="flex items-center gap-2 text-green-800 bg-green-50 rounded-lg px-3 py-2"><CheckCircle2 className="w-4 h-4 flex-shrink-0" /> Published. The draft is cleared.</div>
          <ul className="space-y-1.5 list-disc pl-5">
            {result.mode === 'new_only'
              ? <li>{fmtInt(result.pinned)} {plural(result.pinned, 'lead')} in flight {result.pinned === 1 ? 'stays' : 'stay'} on the version {result.pinned === 1 ? 'it is' : 'they are'} on. New leads start on version {result.version}.</li>
              : <li>Everyone who has not reached the changed steps yet follows version {result.version}.</li>}
            {result.queued_updated > 0 && <li>{fmtInt(result.queued_updated)} queued {plural(result.queued_updated, 'message')} will use the new text.</li>}
            {result.rescheduled > 0 && <li>{fmtInt(result.rescheduled)} waiting {plural(result.rescheduled, 'lead')} rescheduled to the new delay.</li>}
            {result.removed_step_leads > 0 && <li>{fmtInt(result.removed_step_leads)} {plural(result.removed_step_leads, 'lead')} on removed steps {removedMode === 'skip' ? 'moved to the next step' : 'exited the sequence'}.</li>}
          </ul>
          <p className="text-xs text-gray-500">The versions page shows how many leads run on each version and lets you move them to the latest one.</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} title="Publish changes" size="lg" footer={
      <>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        {stale
          ? <Button variant="danger" loading={busy} disabled={loading || blocked || !impact} onClick={() => publish(true)}>Review and publish anyway</Button>
          : <Button loading={busy} disabled={loading || blocked || !impact} onClick={() => publish(false)}>Publish</Button>}
      </>
    }>
      {loading && !impact ? (
        <div className="py-8 text-center"><Spinner className="py-2" /><p className="text-sm text-gray-600">Checking who this change affects…</p></div>
      ) : loadError ? (
        <div className="space-y-3"><ErrorBox message={loadError} /><Button variant="secondary" size="sm" onClick={load}>Try again</Button></div>
      ) : impact ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-800" aria-live="polite">
            <span className="font-semibold">{fmtInt(impact.in_flight)} {plural(impact.in_flight, 'lead')} in flight.</span>{' '}
            {fmtInt(impact.on_or_after_changed)} {impact.on_or_after_changed === 1 ? 'is' : 'are'} on or after a step you changed.{' '}
            {fmtInt(impact.queued_with_old_text)} {plural(impact.queued_with_old_text, 'message')} with the old text {impact.queued_with_old_text === 1 ? 'is' : 'are'} already queued.
            {impact.already_pinned > 0 && <> {fmtInt(impact.already_pinned)} {plural(impact.already_pinned, 'lead')} {impact.already_pinned === 1 ? 'is' : 'are'} pinned to an older version and not affected.</>}
          </p>

          {stale && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>Version {impact.head_version} was published while you were editing{impact.draft_base_version ? ` (your draft started from version ${impact.draft_base_version})` : ''}. The list below compares your draft with that version. Publishing replaces it.</span>
            </div>
          )}

          <IssueList items={errors} level="error" graph={draft.graph} onFocus={(id) => { onFocusNode(id); onClose(); }} />
          <IssueList items={warnings} level="warning" graph={draft.graph} onFocus={(id) => { onFocusNode(id); onClose(); }} />
          {blocked && <p className="text-xs text-gray-600">Fix the blocking errors first. Nothing has changed for live leads.</p>}

          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">What changes</h4>
            {nodes.length === 0 ? (
              <p className="text-sm text-gray-600">No step changes. Only the layout{metaLabels.length > 0 ? ' and the settings below are' : ' is'} published.</p>
            ) : (
              <ul className="rounded-lg border border-gray-200 divide-y divide-gray-100 max-h-56 overflow-y-auto">
                {nodes.map((n) => {
                  const m = CHANGE_META[n.change] ?? CHANGE_META.changed;
                  return (
                    <li key={n.node_id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      <Badge tone={m.tone}><m.Icon className="w-3 h-3 mr-1" />{m.label}</Badge>
                      {n.change === 'removed'
                        ? <span className="font-medium text-gray-900 truncate max-w-[14rem]">{title(n)}</span>
                        : <button type="button" onClick={() => { onFocusNode(n.node_id); onClose(); }} className="font-medium text-gray-900 hover:text-indigo-700 hover:underline truncate max-w-[14rem]">{title(n)}</button>}
                      {n.text_changed && <span className="inline-flex items-center gap-1 text-xs text-gray-500"><MessageSquare className="w-3 h-3" /> text</span>}
                      {n.delay_changed && <span className="inline-flex items-center gap-1 text-xs text-gray-500"><Clock className="w-3 h-3" /> timing</span>}
                      <span className="ml-auto text-xs text-gray-500 tabular-nums whitespace-nowrap">{fmtInt(n.leads_here)} {plural(n.leads_here, 'lead')} here · {fmtInt(n.queued)} queued</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {metaLabels.length > 0 && <p className="text-xs text-gray-500 mt-1.5">Also published: {metaLabels.join(', ')}.</p>}
          </div>

          <fieldset disabled={busy || blocked} className="space-y-2">
            <legend className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Who gets the new version</legend>
            <Choice name="publish-mode" checked={mode === 'all'} onSelect={() => setMode('all')} title="Everyone who hasn't reached the changed steps yet">
              Leads before a changed step follow the new version when they get there. Steps already done are never repeated.
            </Choice>
            <Choice name="publish-mode" checked={mode === 'new_only'} onSelect={() => setMode('new_only')} title="New leads only">
              The {fmtInt(affectable)} {plural(affectable, 'lead')} in flight finish on the version they are on. Only leads enrolled from now on get the new version.
            </Choice>
            {affectable === 0 && <p className="text-xs text-gray-500">No leads are in flight, so both choices do the same.</p>}
          </fieldset>

          {mode === 'all' && !blocked && ((textChanged && impact.queued_with_old_text > 0) || (delayChanged && impact.waiting_on_changed_delay > 0)) && (
            <div className="space-y-2.5 rounded-lg bg-gray-50 border border-gray-200 p-3">
              {textChanged && impact.queued_with_old_text > 0 && (
                <Check checked={updateQueued} onChange={setUpdateQueued} title={`Update the ${fmtInt(impact.queued_with_old_text)} already-queued ${plural(impact.queued_with_old_text, 'message')} too`}>
                  Unticked, they go out with the old text. Ticked, they are written again from the new text when they send. Messages a teammate edited or approved by hand always stay as they are.
                </Check>
              )}
              {delayChanged && impact.waiting_on_changed_delay > 0 && (
                <Check checked={reschedule} onChange={setReschedule} title={`Reschedule the ${fmtInt(impact.waiting_on_changed_delay)} ${plural(impact.waiting_on_changed_delay, 'lead')} waiting in this delay`}>
                  Their wait is counted again from when they entered the delay. Leads already past the new wait continue right away. Unticked: they keep their current wait.
                </Check>
              )}
            </div>
          )}

          {removedWithLeads.length > 0 && !blocked && (
            mode === 'all' ? (
              <fieldset disabled={busy} className="space-y-2">
                <legend className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{fmtInt(removedLeadCount)} {plural(removedLeadCount, 'lead')} on {removedWithLeads.length === 1 ? 'a step' : 'steps'} you removed</legend>
                <Choice name="removed-mode" checked={removedMode === 'skip'} onSelect={() => setRemovedMode('skip')} title={`Move ${removedLeadCount === 1 ? 'it' : 'them'} to the next step`}>
                  Queued actions for the removed step are cancelled and the {plural(removedLeadCount, 'lead')} {removedLeadCount === 1 ? 'continues' : 'continue'} from the step that followed it.
                </Choice>
                <Choice name="removed-mode" checked={removedMode === 'exit'} onSelect={() => setRemovedMode('exit')} title={`Exit ${removedLeadCount === 1 ? 'it' : 'them'}`}>
                  The {plural(removedLeadCount, 'lead')} {removedLeadCount === 1 ? 'leaves' : 'leave'} the sequence. History and chats are kept.
                </Choice>
              </fieldset>
            ) : (
              <p className="text-xs text-gray-600">{fmtInt(removedLeadCount)} {plural(removedLeadCount, 'lead')} on removed steps {removedLeadCount === 1 ? 'finishes' : 'finish'} on the version {removedLeadCount === 1 ? 'it is' : 'they are'} on, where the step still exists.</p>
            )
          )}

          <Textarea label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} rows={2} placeholder="What changed and why. Shown on the versions page." className="!min-h-[56px]" disabled={busy} />

          {error && <ErrorBox message={error} />}
        </div>
      ) : null}
    </Modal>
  );
}
