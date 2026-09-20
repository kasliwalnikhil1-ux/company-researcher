'use client';

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Repeat, Sparkles } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useClients, useLists, useTags } from '@/lib/outreach/queries';
import { callFn } from '@/lib/outreach/api';
import { REPEATABLE_KINDS, ik, saveImportSchedule, type ImportCadence, type ImportKindV2 } from '@/lib/outreach/intel';
import { Select } from '@/components/outreach/ui';
import { TagMultiSelect } from './TagMultiSelect';

/** Options every import shares: where the leads go, enrichment, and repeating. */
export interface ImportCommon { clientId: string; listId: string; tagIds: string[]; enrich: boolean; cadence: '' | ImportCadence }
export const EMPTY_COMMON: ImportCommon = { clientId: '', listId: '', tagIds: [], enrich: false, cadence: '' };

const CADENCE_LABEL: Record<ImportCadence, string> = { daily: 'Every day', weekly: 'Every week', monthly: 'Every month' };

export function ImportOptions({ kind, value, onChange, enrichHint }: { kind: ImportKindV2; value: ImportCommon; onChange: (v: ImportCommon) => void; enrichHint?: string }) {
  const { workspace } = useWorkspace();
  const clients = useClients(workspace?.id);
  const lists = useLists(workspace?.id);
  const tags = useTags(workspace?.id);
  const repeatable = REPEATABLE_KINDS.includes(kind);
  const set = <K extends keyof ImportCommon>(k: K, v: ImportCommon[K]) => onChange({ ...value, [k]: v });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Select label="Client (optional)" value={value.clientId} onChange={(e) => set('clientId', e.target.value)}>
          <option value="">No client</option>
          {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select label="Add to list (optional)" value={value.listId} onChange={(e) => set('listId', e.target.value)}>
          <option value="">No list</option>
          {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
      </div>
      <TagMultiSelect tags={tags.data ?? []} value={value.tagIds} onChange={(v) => set('tagIds', v)} />

      <div className="rounded-xl border border-gray-200 divide-y divide-gray-100">
        <label className="flex items-start gap-2.5 p-3 cursor-pointer">
          <input type="checkbox" checked={value.enrich} onChange={(e) => set('enrich', e.target.checked)} className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
          <span className="text-sm text-gray-800">
            <span className="inline-flex items-center gap-1.5 font-medium"><Sparkles className="w-3.5 h-3.5 text-indigo-500" /> Enrich these leads after import</span>
            <span className="block text-xs text-gray-500 mt-0.5">{enrichHint ?? 'Reads each full profile in the background with profile views left over after the day’s sequence actions, so it can take days. Leads that enter a sequence are enriched for free anyway.'}</span>
          </span>
        </label>
        {repeatable && (
          <div className="p-3">
            <label className="flex flex-wrap items-center gap-2 text-sm text-gray-800">
              <span className="inline-flex items-center gap-1.5 font-medium"><Repeat className="w-3.5 h-3.5 text-indigo-500" /> Repeat</span>
              <select aria-label="Repeat this import" value={value.cadence} onChange={(e) => set('cadence', e.target.value as ImportCommon['cadence'])} className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="">Run once</option>
                {(Object.keys(CADENCE_LABEL) as ImportCadence[]).map((c) => <option key={c} value={c}>{CADENCE_LABEL[c]}</option>)}
              </select>
            </label>
            <p className="text-xs text-gray-500 mt-1">{value.cadence ? 'Runs now, then again on this rhythm. Only new people are added. Every run uses the same daily limits and working hours. Pair it with an auto-enrol rule to keep a sequence topped up.' : 'Run it again on a rhythm to pick up new people only.'}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export interface CreateImportInput {
  kind: ImportKindV2;
  sender_id?: string | null;
  /**
   * Source settings, e.g. {post_url, include} or {companies, title_keywords, per_company}. outreach-imports-create reads them as
   * top-level body keys; they are also sent under `params` so either reading works.
   */
  fields?: Record<string, unknown>;
  /** Name of the repeating import. */
  name?: string;
}
export interface CreateImportResult { scheduled: boolean; scheduleError: string | null; warnings: string[]; estimatedDays: number | null }

/**
 * Create the import job and, when a rhythm is chosen, the repeating import (outreach_save_import_schedule).
 * The schedule stores the params of the job the function created, so later runs read exactly what the first run read.
 */
export async function createImport(ws: string, input: CreateImportInput, common: ImportCommon, qc: QueryClient): Promise<CreateImportResult> {
  const fields = input.fields ?? {};
  const body = {
    ...fields, ...(Object.keys(fields).length ? { params: fields } : {}),
    workspace_id: ws, kind: input.kind, sender_id: input.sender_id ?? null,
    client_id: common.clientId || null, list_id: common.listId || null, tag_ids: common.tagIds, enrich: common.enrich,
  };
  const res = await callFn<{ job?: { params?: Record<string, unknown> }; warnings?: string[]; estimate?: { estimated_days?: number } }>('imports-create', body);
  qc.invalidateQueries({ queryKey: qk.imports(ws) });
  const out: CreateImportResult = { scheduled: false, scheduleError: null, warnings: Array.isArray(res?.warnings) ? res.warnings.map(String) : [], estimatedDays: typeof res?.estimate?.estimated_days === 'number' ? res.estimate.estimated_days : null };
  if (!common.cadence || !REPEATABLE_KINDS.includes(input.kind) || !input.sender_id) return out;
  try {
    // The schedule stores the validated params of the job that was just created (the worker's own format), minus run state.
    const { repeat_run: _run, _state: _st, ...jobParams } = (res?.job?.params ?? {}) as Record<string, unknown>;
    const params = Object.keys(jobParams).length ? jobParams : fields;
    await saveImportSchedule({ workspace_id: ws, sender_id: input.sender_id, kind: input.kind, params, list_id: common.listId || null, tag_ids: common.tagIds, client_id: common.clientId || null, enrich: common.enrich, cadence: common.cadence, name: input.name });
    qc.invalidateQueries({ queryKey: ik.importSchedules(ws) });
    return { ...out, scheduled: true };
  } catch (e) {
    return { ...out, scheduleError: e instanceof Error ? e.message : String(e) };
  }
}

export function useImportCreator() {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  return (input: CreateImportInput, common: ImportCommon) => {
    if (!workspace) return Promise.reject(new Error('No workspace selected'));
    return createImport(workspace.id, input, common, qc);
  };
}

export function importStartedMessage(base: string, r: CreateImportResult): { message: string; type: 'success' | 'error' } {
  const parts = [base];
  if (r.estimatedDays != null && r.estimatedDays > 0) parts.push(`Estimated time: about ${r.estimatedDays} day${r.estimatedDays === 1 ? '' : 's'}.`);
  parts.push(...r.warnings);
  if (r.scheduleError) return { message: `${parts.join(' ')} The repeat could not be saved: ${r.scheduleError}`, type: 'error' };
  if (r.scheduled) parts.push('It will repeat on the rhythm you chose.');
  return { message: parts.join(' '), type: 'success' };
}
