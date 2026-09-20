'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import { Card, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { sk, useSettingsStages } from './hooks';
import { STAGE_KINDS, type StageKind, type StageRow } from './types';

const selectCls = 'w-full px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 disabled:text-gray-500';

/** What each pipeline stage means. The funnel, auto-staging and the cost report read `kind`; Won can carry a default deal value. */
export default function StageKindsCard() {
  const { workspace, isOwner, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const stages = useSettingsStages(ws);
  const [busy, setBusy] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const editable = isOwner && canWrite;
  const currency = String((workspace?.settings as Record<string, unknown> | undefined)?.currency ?? 'USD');

  const problems = useMemo(() => {
    const rows = stages.data ?? [];
    const out: string[] = [];
    const seen = new Map<StageKind, string[]>();
    for (const r of rows) if (r.kind) seen.set(r.kind, [...(seen.get(r.kind) ?? []), r.name]);
    for (const [k, names] of seen) if (names.length > 1) out.push(`${names.join(' and ')} share the kind "${k}". The first one in the pipeline is used when a lead is moved automatically.`);
    for (const k of ['interested', 'meeting', 'won'] as StageKind[]) if (rows.length && !seen.has(k)) out.push(`No stage has the kind "${k}". ${k === 'interested' ? 'Interested replies cannot move the lead on their own.' : k === 'meeting' ? 'A booked meeting cannot move the lead on its own.' : 'The funnel and the cost report cannot count won deals.'}`);
    return out;
  }, [stages.data]);

  async function update(row: StageRow, patch: Partial<Pick<StageRow, 'kind' | 'deal_value'>>) {
    setBusy(row.id);
    try {
      const { data, error } = await supabase.from('outreach_stages').update(patch).eq('id', row.id).select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('E_FORBIDDEN: you cannot edit stages in this workspace');
      await Promise.all([qc.invalidateQueries({ queryKey: sk.stages(ws ?? '') }), qc.invalidateQueries({ queryKey: qk.stages(ws ?? '') })]);
      toast.show('Stage saved.');
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  function commitValue(row: StageRow) {
    const raw = values[row.id];
    if (raw === undefined) return;
    const trimmed = raw.trim();
    const n = trimmed === '' ? null : Number(trimmed);
    if (n != null && (!Number.isFinite(n) || n < 0)) { toast.show('Deal value must be a positive number.', 'error'); return; }
    setValues((v) => { const { [row.id]: _drop, ...rest } = v; return rest; });
    if (n === (row.deal_value == null ? null : Number(row.deal_value))) return;
    update(row, { deal_value: n });
  }

  return (
    <Card title="Pipeline stages">
      <p className="text-xs text-gray-500 mb-4">Tell us what each stage means. The funnel report counts leads by these kinds, replies classified interested move a lead to the Interested stage, a booked meeting moves it to Meeting, and the cost report uses the Won stage and its deal value. Stage names and order are edited on the Leads page.</p>
      {stages.isLoading ? <Spinner /> : stages.isError ? <ErrorBox message={parseError(stages.error).message} /> : !stages.data?.length ? <div className="text-sm text-gray-500">No stages yet. Add them on the Leads page.</div> : (
        <div className="divide-y divide-gray-100">
          {stages.data.map((s) => (
            <div key={s.id} className="py-2.5 grid grid-cols-1 sm:grid-cols-[1fr_200px_180px] gap-2 sm:gap-4 sm:items-center">
              <div className="flex items-center gap-2 min-w-0"><span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: s.color ?? '#9ca3af' }} /><span className="text-sm font-medium text-gray-900 truncate">{s.name}</span></div>
              <label className="block">
                <span className="sr-only">Kind of stage {s.name}</span>
                <select className={selectCls} value={s.kind ?? ''} disabled={!editable || busy === s.id}
                  onChange={(e) => update(s, { kind: (e.target.value || null) as StageKind | null, ...(e.target.value !== 'won' && s.deal_value != null ? { deal_value: null } : {}) })}>
                  <option value="">None (not counted)</option>
                  {STAGE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}: {k.hint.toLowerCase()}</option>)}
                </select>
              </label>
              {s.kind === 'won' ? (
                <label className="block">
                  <span className="sr-only">Default deal value for {s.name}</span>
                  <div className="flex items-center gap-2">
                    <input className={selectCls} inputMode="decimal" placeholder="Default deal value" disabled={!editable || busy === s.id}
                      value={values[s.id] ?? (s.deal_value == null ? '' : String(s.deal_value))}
                      onChange={(e) => setValues({ ...values, [s.id]: e.target.value })} onBlur={() => commitValue(s)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
                    <span className="text-xs text-gray-500">{currency}</span>
                  </div>
                </label>
              ) : <span className="hidden sm:block" />}
            </div>
          ))}
        </div>
      )}
      {problems.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {problems.map((p) => <div key={p} className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /><span>{p}</span></div>)}
        </div>
      )}
      <div className="text-xs text-gray-400 mt-3">The deal value on Won is optional. It is used when a won lead has no value of its own.{!isOwner && ' Only the workspace owner can change stage kinds.'}</div>
      {toast.node}
    </Card>
  );
}
