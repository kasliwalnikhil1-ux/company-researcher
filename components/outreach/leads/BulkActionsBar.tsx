'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients, useLists, useStages, useTags } from '@/lib/outreach/queries';
import { parseError, rpc } from '@/lib/outreach/api';
import { Button, ErrorBox, Modal, Select } from '@/components/outreach/ui';
import { AlertTriangle, GitBranch, ShieldCheck, ShieldOff, Sparkles, Tag as TagIcon, Trash2, Wand2, X } from 'lucide-react';
import { requestEnrichment, stashSelection, type EnrichResult } from '@/lib/outreach/intel';
import { BULK_CAP, type ToastFn } from './helpers';

type Op = 'add_tag' | 'remove_tag' | 'set_list' | 'set_stage' | 'set_client' | 'set_dnc' | 'clear_dnc' | 'delete';
const OP_LABEL: Record<Op, string> = { add_tag: 'Add tag', remove_tag: 'Remove tag', set_list: 'Set list', set_stage: 'Set stage', set_client: 'Set client', set_dnc: 'Mark do-not-contact', clear_dnc: 'Clear do-not-contact', delete: 'Delete leads' };

export function BulkActionsBar({ selected, onClear, onEnroll, toast }: { selected: string[]; onClear: () => void; onEnroll: () => void; toast: ToastFn }) {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const tags = useTags(workspace?.id);
  const lists = useLists(workspace?.id);
  const stages = useStages(workspace?.id);
  const clients = useClients(workspace?.id);
  const [op, setOp] = useState<Op | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [wantPosts, setWantPosts] = useState(false);
  const [enrichResult, setEnrichResult] = useState<EnrichResult | null>(null);

  const n = selected.length;
  const overCap = n > BULK_CAP;
  if (n === 0) return null;

  const open = (o: Op) => { setOp(o); setValue(''); setError(null); };
  const needsValue = op === 'add_tag' || op === 'remove_tag';
  const options = op === 'add_tag' || op === 'remove_tag' ? tags.data : op === 'set_list' ? lists.data : op === 'set_stage' ? stages.data : op === 'set_client' ? clients.data : undefined;

  const run = async () => {
    if (!workspace || !op || overCap) return;
    if (needsValue && !value) return;
    setBusy(true); setError(null);
    try {
      const count = await rpc<number>('bulk_leads', { p_ws: workspace.id, p_lead_ids: selected, p_op: op, p_value: value || null });
      qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'leads'] });
      qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'dashboard'] });
      for (const id of selected.slice(0, 50)) qc.invalidateQueries({ queryKey: ['outreach', 'lead', id] });
      toast(`${OP_LABEL[op]}: ${count.toLocaleString()} ${op === 'add_tag' || op === 'remove_tag' ? 'change' : 'lead'}${count === 1 ? '' : 's'}`);
      setOp(null);
      if (op === 'delete') onClear();
    } catch (e) {
      setError(parseError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const openEnrich = () => { setEnrichOpen(true); setEnrichResult(null); setWantPosts(false); setError(null); };
  const runEnrich = async () => {
    if (!workspace || overCap) return;
    setBusy(true); setError(null);
    try {
      const r = await requestEnrichment(workspace.id, selected, { wantPosts, reason: 'manual' });
      setEnrichResult(r);
      qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'leads'] });
      for (const id of selected.slice(0, 50)) qc.invalidateQueries({ queryKey: ['outreach', 'lead', id] });
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };
  // AI lines: at most 2000 leads per batch (outreach_ai_generate_request). The selection travels in sessionStorage, not the URL.
  const toAiReview = () => { const key = stashSelection(selected.slice(0, 2000)); router.push(`/outreach/ai-review?generate=1&selection=${key}`); };

  const valueLabel = op === 'add_tag' || op === 'remove_tag' ? 'Tag' : op === 'set_list' ? 'List' : op === 'set_stage' ? 'Stage' : op === 'set_client' ? 'Client' : '';

  return (
    <>
      <div className="sticky top-0 z-10 bg-indigo-600 text-white rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-2 shadow-md">
        <span className="text-sm font-medium mr-2">{n.toLocaleString()} selected</span>
        {overCap && <span className="inline-flex items-center gap-1 text-xs bg-amber-400 text-amber-950 rounded-full px-2 py-0.5"><AlertTriangle className="w-3 h-3" /> Bulk actions are capped at {BULK_CAP.toLocaleString()} leads</span>}
        <div className="flex flex-wrap items-center gap-1.5">
          <BulkBtn onClick={() => open('add_tag')}><TagIcon className="w-3.5 h-3.5" /> Add tag</BulkBtn>
          <BulkBtn onClick={() => open('remove_tag')}>Remove tag</BulkBtn>
          <BulkBtn onClick={() => open('set_list')}>Set list</BulkBtn>
          <BulkBtn onClick={() => open('set_stage')}>Set stage</BulkBtn>
          {(clients.data?.length ?? 0) > 0 && <BulkBtn onClick={() => open('set_client')}>Set client</BulkBtn>}
          <BulkBtn onClick={() => open('set_dnc')}><ShieldOff className="w-3.5 h-3.5" /> Mark DNC</BulkBtn>
          <BulkBtn onClick={() => open('clear_dnc')}><ShieldCheck className="w-3.5 h-3.5" /> Clear DNC</BulkBtn>
          <BulkBtn onClick={openEnrich}><Sparkles className="w-3.5 h-3.5" /> Enrich</BulkBtn>
          <BulkBtn onClick={toAiReview}><Wand2 className="w-3.5 h-3.5" /> Generate AI lines</BulkBtn>
          <BulkBtn onClick={onEnroll}><GitBranch className="w-3.5 h-3.5" /> Enrol in sequence</BulkBtn>
          <BulkBtn onClick={() => open('delete')} danger><Trash2 className="w-3.5 h-3.5" /> Delete</BulkBtn>
        </div>
        <button type="button" onClick={onClear} title="Clear selection" className="ml-auto p-1 rounded-md hover:bg-white/15"><X className="w-4 h-4" /></button>
      </div>

      <Modal open={!!op} onClose={() => !busy && setOp(null)} title={op ? `${OP_LABEL[op]} — ${n.toLocaleString()} lead${n === 1 ? '' : 's'}` : ''} size="sm"
        footer={<>
          <Button variant="secondary" onClick={() => setOp(null)} disabled={busy}>Cancel</Button>
          <Button variant={op === 'delete' ? 'danger' : 'primary'} loading={busy} disabled={overCap || (needsValue && !value)} onClick={run}>{op === 'delete' ? 'Delete permanently' : 'Apply'}</Button>
        </>}>
        {overCap && <ErrorBox className="mb-3" message={`Select at most ${BULK_CAP.toLocaleString()} leads per bulk action.`} />}
        {op === 'delete' && (
          <p className="text-sm text-gray-700">This permanently deletes {n.toLocaleString()} lead{n === 1 ? '' : 's'} together with their tags, relation states, enrollments and tasks. Conversations remain in the inbox. This cannot be undone.</p>
        )}
        {op === 'set_dnc' && <p className="text-sm text-gray-700">Marked leads are excluded from every sequence; live enrollments exit with <em>suppressed</em> and queued actions are cancelled.</p>}
        {op === 'clear_dnc' && <p className="text-sm text-gray-700">Leads become eligible for outreach again. Existing enrollments are not restarted.</p>}
        {options && (
          <div className="space-y-2">
            <Select label={valueLabel} value={value} onChange={(e) => setValue(e.target.value)}>
              {needsValue ? <option value="">Choose a tag…</option> : <option value="">None (clear)</option>}
              {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
            {options.length === 0 && <p className="text-xs text-gray-500">Nothing to choose from yet — use the Manage menu to create one.</p>}
          </div>
        )}
        {error && <ErrorBox className="mt-3" message={error} />}
      </Modal>

      <Modal open={enrichOpen} onClose={() => !busy && setEnrichOpen(false)} title={`Enrich ${n.toLocaleString()} lead${n === 1 ? '' : 's'}`} size="sm"
        footer={enrichResult
          ? <Button onClick={() => setEnrichOpen(false)}>Done</Button>
          : <><Button variant="secondary" onClick={() => setEnrichOpen(false)} disabled={busy}>Cancel</Button><Button loading={busy} disabled={overCap} onClick={runEnrich}>Enrich</Button></>}>
        {overCap && <ErrorBox className="mb-3" message={`Select at most ${BULK_CAP.toLocaleString()} leads per bulk action.`} />}
        {!enrichResult ? (
          <div className="space-y-3 text-sm text-gray-700">
            <p>Reads the full LinkedIn profile of each lead: about, roles, education, skills and languages. Leads enriched in the last 90 days are skipped. Leads never enriched are always taken.</p>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={wantPosts} onChange={(e) => setWantPosts(e.target.checked)} className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
              <span>Also fetch recent posts<span className="block text-xs text-gray-500">Posts use a separate daily allowance, not profile views. Tick this if you will use a recent-post variable, AI lines or a “posted recently” filter.</span></span>
            </label>
            <p className="text-xs text-gray-500">This runs in the background with profile views left over after the day&apos;s sequence actions, so a large selection takes days. Leads that enter a sequence are enriched for free either way.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <dl className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-green-50 border border-green-100 py-2"><dt className="text-[11px] text-green-800">Queued</dt><dd className="text-lg font-semibold text-green-900 tabular-nums">{enrichResult.queued.toLocaleString()}</dd></div>
              <div className="rounded-lg bg-gray-50 border border-gray-200 py-2"><dt className="text-[11px] text-gray-600">Skipped, still fresh</dt><dd className="text-lg font-semibold text-gray-900 tabular-nums">{(enrichResult.skipped_fresh ?? 0).toLocaleString()}</dd></div>
              <div className="rounded-lg bg-amber-50 border border-amber-100 py-2"><dt className="text-[11px] text-amber-800">No LinkedIn id</dt><dd className="text-lg font-semibold text-amber-900 tabular-nums">{(enrichResult.skipped_no_linkedin_id ?? 0).toLocaleString()}</dd></div>
            </dl>
            {enrichResult.queued + (enrichResult.skipped_fresh ?? 0) + (enrichResult.skipped_no_linkedin_id ?? 0) < n && <p className="text-xs text-gray-500">The rest were left out because they are marked do-not-contact or belong to a client you cannot see.</p>}
            {enrichResult.note && <p className="text-xs text-gray-500">{enrichResult.note}</p>}
          </div>
        )}
        {error && <ErrorBox className="mt-3" message={error} />}
      </Modal>
    </>
  );
}

function BulkBtn({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return <button type="button" onClick={onClick} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap ${danger ? 'bg-red-500/90 hover:bg-red-500' : 'bg-white/15 hover:bg-white/25'}`}>{children}</button>;
}
