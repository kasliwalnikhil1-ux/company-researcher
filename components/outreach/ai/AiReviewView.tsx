'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronLeft, ChevronRight, HelpCircle, Loader2, RefreshCw, ShieldCheck, SkipForward, Sparkles, Wand2 } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { factLines, ik, useAiBatches, useAiRealtime, useAiReviewList, type AiBatch, type AiGenerateResult, type AiReviewAction, type AiReviewRow, type AiValueStatus } from '@/lib/outreach/intel';
import { Badge, Button, EmptyState, ErrorBox, Modal, PageHeader, Spinner, Table, Td, Th, timeAgo, useToast } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { GenerateLinesModal } from './GenerateLinesModal';
import { usePersistedFilters } from '@/lib/outreach/persistedFilters';

const PAGE_SIZE = 50;
const BLANK_COPY = 'Nothing usable on the profile — the fallback will be used';

const STATUS_FILTERS: Array<{ id: string; label: string }> = [
  { id: 'generated', label: 'To review' }, { id: 'approved', label: 'Approved' }, { id: 'skipped', label: 'Skipped' },
  { id: 'blank', label: 'Blank' }, { id: 'failed', label: 'Failed' }, { id: 'pending', label: 'Still generating' }, { id: 'all', label: 'All' },
];
// One line under the filter so the chosen status is never a guess.
const STATUS_HINTS: Record<string, string> = {
  generated: 'Written by the AI and waiting for a person. Nothing here is sent until you approve it.',
  approved: 'Approved lines. These are the only lines a message can send.',
  skipped: 'You chose the fallback for these leads. Approve a line to use it after all.',
  blank: 'The profile had nothing usable, so the fallback is used. Type your own line to replace it.',
  failed: 'The line could not be written. The fallback is used unless you regenerate it.',
  pending: 'Still being written. Lines move to “To review” as they finish.',
  all: 'Every line, whatever its status.',
};
const GUIDE_KEY = 'outreach.ai-review.guide-hidden';

function Guide() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => { try { setHidden(window.localStorage.getItem(GUIDE_KEY) === '1'); } catch { /* storage blocked */ } }, []);
  const toggle = () => { const next = !hidden; setHidden(next); try { window.localStorage.setItem(GUIDE_KEY, next ? '1' : '0'); } catch { /* storage blocked */ } };
  const steps: Array<{ title: string; body: ReactNode }> = [
    { title: 'Create an AI variable', body: <>In <Link href="/outreach/settings/ai" className="text-indigo-700 underline">Settings → AI Personalization</Link>, write what the AI should say (for example one sentence about their current role) and a fallback. You get a token like <code className="text-[11px] bg-white border border-indigo-100 rounded px-1">{'{{ai.opener|fallback}}'}</code>.</> },
    { title: 'Choose how lines get approved', body: <><strong>Review</strong>: you approve each line. <strong>Auto</strong>: lines that pass the checks are approved for you, and the rest come here. Auto starts with 20 lines for you to review.</> },
    { title: 'Generate lines', body: <>Click <strong>Generate lines</strong>, pick the variable and a list, a tag or the leads you selected. Use <strong>Try it</strong> on one lead first to check the prompt. Lines are written in the background, up to 2,000 leads per batch.</> },
    { title: 'Review what needs you', body: <>Each row shows the profile facts the AI used, the line it wrote and any check it failed. <strong>Approve</strong> it, type over it and press <strong>Save and approve</strong> (or Ctrl+Enter), <strong>regenerate</strong> it, or <strong>skip</strong> it to use the fallback. Auto-approved lines can be revoked until they are sent.</> },
    { title: 'Use it in a message', body: <>Paste the token into a sequence step. To make leads wait for their line instead of sending the fallback, turn on <strong>Hold leads until AI-written lines are approved</strong> in the sequence settings, and set how long they may wait.</> },
  ];
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 mb-4 text-sm text-indigo-900" role="note">
      <div className="flex items-start gap-2 px-4 py-3">
        <ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span className="flex-1"><span className="font-semibold">Only approved lines are ever sent, approved by you or by the checks. Everything else uses the fallback.</span> A lead whose sequence waits for review starts as soon as its line is approved, skipped or blank.</span>
        <button type="button" onClick={toggle} aria-expanded={!hidden} className="inline-flex items-center gap-1 text-xs font-medium text-indigo-700 hover:underline whitespace-nowrap">
          <HelpCircle className="w-3.5 h-3.5" /> {hidden ? 'How it works' : 'Hide guide'}<ChevronDown className={cn('w-3.5 h-3.5 transition-transform', !hidden && 'rotate-180')} />
        </button>
      </div>
      {!hidden && (
        <ol className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3 px-4 pb-4">
          {steps.map((s, i) => (
            <li key={s.title} className="rounded-lg bg-white/70 border border-indigo-100 p-3">
              <div className="flex items-center gap-2 font-semibold text-indigo-950"><span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[11px] flex items-center justify-center tabular-nums">{i + 1}</span>{s.title}</div>
              <p className="text-xs text-indigo-900/80 mt-1.5 leading-relaxed">{s.body}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const STATUS_META: Record<AiValueStatus, { tone: 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'purple'; label: string }> = {
  pending: { tone: 'blue', label: 'Generating' }, generated: { tone: 'amber', label: 'To review' }, approved: { tone: 'green', label: 'Approved' },
  skipped: { tone: 'gray', label: 'Skipped' }, blank: { tone: 'gray', label: 'Blank' }, failed: { tone: 'red', label: 'Failed' },
};
const BATCH_META: Record<string, { tone: 'blue' | 'amber' | 'green' | 'gray'; label: string }> = {
  generating: { tone: 'blue', label: 'Generating' }, review: { tone: 'amber', label: 'Review' }, done: { tone: 'green', label: 'Done' }, cancelled: { tone: 'gray', label: 'Cancelled' },
};

function BatchItem({ b, active, onSelect }: { b: AiBatch; active: boolean; onSelect: () => void }) {
  const meta = BATCH_META[b.status] ?? BATCH_META.done;
  const pending = b.pending ?? 0;
  const done = Math.max(0, b.total - pending);
  const pct = b.total > 0 ? Math.round((done / b.total) * 100) : 100;
  return (
    <button type="button" onClick={onSelect} aria-current={active ? 'true' : undefined}
      className={cn('w-full text-left rounded-xl border p-3 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500', active ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50')}>
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0 text-sm font-semibold text-gray-900 truncate">{b.outreach_ai_variables?.name ?? 'Deleted variable'}</span>
        <Badge tone={meta.tone}>{b.status === 'generating' && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}{meta.label}</Badge>
      </div>
      <div className="text-xs text-gray-500 mt-0.5 truncate">{b.outreach_ai_variables ? `{{ai.${b.outreach_ai_variables.key}}}` : ''} · {b.total.toLocaleString()} lead{b.total === 1 ? '' : 's'} · {timeAgo(b.created_at)}</div>
      {b.status === 'generating' && (
        <div className="mt-2">
          <div className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={b.total} aria-valuenow={done} aria-label="Lines written"><div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} /></div>
          <div className="text-[11px] text-gray-500 mt-1 tabular-nums">{done.toLocaleString()} of {b.total.toLocaleString()} written</div>
        </div>
      )}
      {b.status === 'review' && <div className="text-[11px] text-amber-700 mt-1 tabular-nums">{(b.awaiting_review ?? 0).toLocaleString()} waiting for review</div>}
    </button>
  );
}

function Row({ row, canWrite, checked, onCheck, draft, onDraft, busy, onAct }: {
  row: AiReviewRow; canWrite: boolean; checked: boolean; onCheck: () => void; draft: string | undefined; onDraft: (v: string | undefined) => void;
  busy: string | null; onAct: (action: AiReviewAction, text?: string) => void;
}) {
  const stored = row.body ?? '';
  const value = draft ?? stored;
  const dirty = draft !== undefined && draft.trim() !== stored.trim();
  const facts = factLines(row.facts);
  const meta = STATUS_META[row.status] ?? STATUS_META.generated;
  const isBlank = row.status === 'blank' || (row.status !== 'pending' && row.status !== 'failed' && !stored.trim());
  const canApprove = !!stored.trim() && (row.status === 'generated' || row.status === 'skipped');
  const working = busy === row.value_id;

  return (
    <tr className={cn('align-top', checked && 'bg-indigo-50/50')}>
      {canWrite && <Td className="w-8"><input type="checkbox" aria-label={`Select ${row.lead_name ?? 'lead'}`} checked={checked} onChange={onCheck} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /></Td>}
      <Td className="min-w-[160px] max-w-[220px]">
        <Link href={`/outreach/leads/${row.lead_id}`} className="font-medium text-gray-900 hover:text-indigo-700 block truncate">{row.lead_name ?? 'Unnamed lead'}</Link>
        <span className="block text-xs text-gray-500 truncate">{[row.title, row.company].filter(Boolean).join(' · ') || '—'}</span>
      </Td>
      <Td className="min-w-[200px] max-w-[300px]">
        {facts.length === 0 ? <span className="text-xs text-gray-400">{row.status === 'pending' ? 'Not written yet' : 'No facts recorded'}</span> : (
          <ul className="text-xs text-gray-600 space-y-0.5 list-disc ml-4">
            {facts.slice(0, 4).map((f, i) => <li key={i} className="break-words line-clamp-2">{f}</li>)}
            {facts.length > 4 && <li className="list-none -ml-4 text-gray-400" title={facts.slice(4).join('\n')}>and {facts.length - 4} more</li>}
          </ul>
        )}
      </Td>
      <Td className="min-w-[280px]">
        {row.status === 'pending' ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Writing…</span>
        ) : row.status === 'failed' ? (
          <span className="text-xs text-red-600">The line could not be written. The fallback will be used unless you regenerate it.</span>
        ) : (
          <>
            {isBlank && draft === undefined && <p className="text-xs text-gray-500 mb-1">{BLANK_COPY}{row.fallback ? <>: <span className="text-gray-700">{row.fallback}</span></> : '.'}</p>}
            <textarea value={value} onChange={(e) => onDraft(e.target.value === stored ? undefined : e.target.value)} readOnly={!canWrite} rows={Math.min(5, Math.max(2, Math.ceil(value.length / 60)))}
              aria-label={`Generated line for ${row.lead_name ?? 'lead'}`} placeholder={isBlank ? 'Write your own line to use instead of the fallback' : undefined}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && dirty && value.trim()) { e.preventDefault(); onAct('edit', value.trim()); } if (e.key === 'Escape' && dirty) onDraft(undefined); }}
              className={cn('w-full text-sm px-2.5 py-1.5 rounded-lg border bg-white text-gray-900 resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500', dirty ? 'border-indigo-400' : 'border-gray-200')} />
            {dirty && (
              <div className="flex items-center gap-2 mt-1">
                <Button size="sm" loading={working} disabled={!value.trim()} onClick={() => onAct('edit', value.trim())}><Check className="w-3.5 h-3.5" /> Save and approve</Button>
                <button type="button" onClick={() => onDraft(undefined)} className="text-xs text-gray-500 hover:underline">Discard edit</button>
              </div>
            )}
          </>
        )}
      </Td>
      <Td className="whitespace-nowrap">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {row.edited && <span className="block text-[11px] text-gray-400 mt-0.5">edited by hand</span>}
      </Td>
      {canWrite && (
        <Td className="text-right whitespace-nowrap">
          <div className="inline-flex items-center gap-1">
            {canApprove && !dirty && <Button size="sm" loading={working} onClick={() => onAct('approve')} title="Approve this line"><Check className="w-3.5 h-3.5" /> Approve</Button>}
            {row.status !== 'pending' && <Button size="sm" variant="secondary" disabled={working} onClick={() => onAct('regenerate')} title="Write a new line"><RefreshCw className="w-3.5 h-3.5" /><span className="sr-only">Regenerate</span></Button>}
            {row.status !== 'skipped' && row.status !== 'pending' && row.status !== 'blank' && row.status !== 'failed' && <Button size="sm" variant="ghost" disabled={working} onClick={() => onAct('skip')} title="Skip: the fallback is used for this lead"><SkipForward className="w-3.5 h-3.5" /> Skip</Button>}
          </div>
        </Td>
      )}
    </tr>
  );
}

export default function AiReviewView({ batchId, generate, selection }: { batchId: string | null; generate: boolean; selection: string[] }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspace, canWrite, isManager, role } = useWorkspace();
  const ws = workspace?.id ?? null;

  // The status filter is remembered per workspace in this browser.
  const { filters: reviewFilters, patch: patchReviewFilters, ready: filtersReady } = usePersistedFilters('ai-review', ws, { status: 'generated' });
  const status = reviewFilters.status;
  const setStatus = (v: string) => patchReviewFilters({ status: v });
  const [page, setPage] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(generate);
  const generatedRef = useRef(false);

  useAiRealtime(ws);
  const batchesQ = useAiBatches(ws);
  const listQ = useAiReviewList(filtersReady ? ws : null, { batch: batchId, status, page, pageSize: PAGE_SIZE });

  useEffect(() => { setPage(0); setChecked(new Set()); setDrafts({}); }, [batchId, status, ws]);
  useEffect(() => { setChecked(new Set()); }, [page]);

  const rows = useMemo(() => listQ.data?.rows ?? [], [listQ.data]);
  const total = listQ.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const batch = batchesQ.data?.find((b) => b.id === batchId) ?? null;
  const awaitingAll = useMemo(() => (batchesQ.data ?? []).reduce((a, b) => a + (b.awaiting_review ?? 0), 0), [batchesQ.data]);

  const selectBatch = useCallback((id: string | null) => router.replace(id ? `/outreach/ai-review?batch=${id}` : '/outreach/ai-review'), [router]);

  const refresh = useCallback(() => {
    if (!ws) return;
    qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-review'] });
    qc.invalidateQueries({ queryKey: ik.aiBatches(ws) });
    qc.invalidateQueries({ queryKey: ['outreach', ws, 'dashboard'] });
  }, [qc, ws]);

  const act = async (ids: string[], action: AiReviewAction, text?: string, busyKey?: string) => {
    if (!ids.length) return;
    setBusy(busyKey ?? 'bulk');
    try {
      let updated = 0;
      // ai_review takes at most 2000 ids per call
      for (let i = 0; i < ids.length; i += 2000) {
        const r = await rpc<{ updated: number }>('ai_review', { p_value_ids: ids.slice(i, i + 2000), p_action: action, p_text: action === 'edit' ? text : null });
        updated += r?.updated ?? 0;
      }
      setDrafts((d) => { const n = { ...d }; for (const id of ids) delete n[id]; return n; });
      setChecked((s) => { const n = new Set(s); for (const id of ids) n.delete(id); return n; });
      const word = action === 'approve' ? 'approved' : action === 'edit' ? 'saved and approved' : action === 'skip' ? 'skipped. The fallback is used for them' : 'queued to be written again';
      toast.show(`${updated.toLocaleString()} line${updated === 1 ? '' : 's'} ${word}.${updated < ids.length ? ` ${(ids.length - updated).toLocaleString()} had no line to approve.` : ''}`);
      refresh();
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  };

  const approvable = useMemo(() => rows.filter((r) => (r.status === 'generated' || r.status === 'skipped') && !!(r.body ?? '').trim() && drafts[r.value_id] === undefined), [rows, drafts]);
  const unsaved = rows.filter((r) => drafts[r.value_id] !== undefined).length;
  const skippable = useMemo(() => rows.filter((r) => checked.has(r.value_id) && r.status !== 'pending'), [rows, checked]);
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.value_id));

  const onGenerated = (r: AiGenerateResult) => {
    generatedRef.current = true;   // the URL now points at the new batch; closing the dialog must not put the old one back
    toast.show(`${r.to_generate.toLocaleString()} line${r.to_generate === 1 ? '' : 's'} queued.${r.kept_existing ? ` ${r.kept_existing.toLocaleString()} existing line${r.kept_existing === 1 ? ' was' : 's were'} kept.` : ''}`);
    refresh();
    setStatus(r.to_generate > 0 ? 'all' : 'generated');
    selectBatch(r.batch_id);
  };

  if (!ws) return null;
  if (role === 'client_viewer') return <ErrorBox message="AI Personalization is not available for client viewers." />;

  return (
    <div>
      <PageHeader title="AI Personalization" subtitle="Lines the AI wrote ahead of time for each lead. Approve them yourself, or let the checks approve the good ones." actions={canWrite ? <Button onClick={() => setGenerateOpen(true)}><Wand2 className="w-4 h-4" /> Generate lines</Button> : undefined} />

      <Guide />

      <div className="grid grid-cols-1 lg:grid-cols-[300px,1fr] gap-4">
        {/* Left: batches */}
        <aside aria-label="Batches" className="space-y-2">
          <button type="button" onClick={() => selectBatch(null)} aria-current={!batchId ? 'true' : undefined}
            className={cn('w-full text-left rounded-xl border p-3 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500', !batchId ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50')}>
            <div className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-indigo-500" /><span className="text-sm font-semibold text-gray-900 flex-1">All lines</span>{awaitingAll > 0 && <Badge tone="amber">{awaitingAll.toLocaleString()} to review</Badge>}</div>
            <div className="text-xs text-gray-500 mt-0.5">Every batch and variable together</div>
          </button>
          {batchesQ.isLoading && <Spinner className="py-6" />}
          {batchesQ.error && <ErrorBox message={parseError(batchesQ.error).message} />}
          {batchesQ.data?.length === 0 && <p className="text-xs text-gray-500 px-1">No batches yet. Generate lines for a list, a tag or a selection of leads.</p>}
          <div className="space-y-2 lg:max-h-[70vh] lg:overflow-y-auto lg:pr-1">
            {batchesQ.data?.map((b) => <BatchItem key={b.id} b={b} active={b.id === batchId} onSelect={() => selectBatch(b.id)} />)}
          </div>
        </aside>

        {/* Right: review table */}
        <section aria-label="Review table" className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="text-sm rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500">
              {STATUS_FILTERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            {batch && <span className="text-sm text-gray-600 truncate">{batch.outreach_ai_variables?.name ?? 'Batch'} · {timeAgo(batch.created_at)}</span>}
            {batchId && !batch && batchesQ.isSuccess && <span className="text-sm text-amber-700">This batch is not in the recent list. Its lines are still shown.</span>}
            <div className="flex-1" />
            {canWrite && (
              <>
                <Button variant="secondary" size="sm" disabled={skippable.length === 0 || !!busy} onClick={() => act(skippable.map((r) => r.value_id), 'skip')}><SkipForward className="w-3.5 h-3.5" /> Skip selected{skippable.length ? ` (${skippable.length})` : ''}</Button>
                <Button size="sm" disabled={approvable.length === 0 || !!busy} loading={busy === 'bulk'} onClick={() => setConfirmAll(true)} title="Approves the lines on this page only. Rows with an unsaved edit are left out."><Check className="w-3.5 h-3.5" /> Approve all shown{approvable.length ? ` (${approvable.length})` : ''}</Button>
              </>
            )}
          </div>
          {STATUS_HINTS[status] && <p className="text-xs text-gray-500 -mt-1 mb-3">{STATUS_HINTS[status]}</p>}

          {!filtersReady || listQ.isLoading ? <Spinner /> : listQ.error ? <ErrorBox message={parseError(listQ.error).message} /> : rows.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl">
              <EmptyState icon={<Sparkles className="w-6 h-6" />} title={status === 'generated' ? 'Nothing to review' : 'No lines here'}
                description={status === 'generated' ? (batch?.status === 'generating' ? 'Lines are still being written. They appear here as they finish.' : 'Every line in this view has been handled. Pick another status to see them.') : 'No line has this status. Try another filter.'}
                action={canWrite && !batchId && (batchesQ.data?.length ?? 0) === 0 ? <Button onClick={() => setGenerateOpen(true)}><Wand2 className="w-4 h-4" /> Generate lines</Button> : undefined} />
            </div>
          ) : (
            <>
              <div className={listQ.isFetching ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
                <Table>
                  <thead>
                    <tr>
                      {canWrite && <Th className="w-8"><input type="checkbox" aria-label="Select all shown" checked={allChecked} onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.value_id)))} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /></Th>}
                      <Th>Lead</Th>
                      <Th title="What the AI read on the lead's profile. It may only use these facts.">Source facts used</Th>
                      <Th title="Type over a line to change it, then Save and approve (Ctrl+Enter). Esc discards the edit.">Generated line</Th>
                      <Th>Status</Th>
                      {canWrite && <Th className="text-right">Actions</Th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <Row key={r.value_id} row={r} canWrite={canWrite} checked={checked.has(r.value_id)} busy={busy}
                        onCheck={() => setChecked((s) => { const n = new Set(s); if (n.has(r.value_id)) n.delete(r.value_id); else n.add(r.value_id); return n; })}
                        draft={drafts[r.value_id]} onDraft={(v) => setDrafts((d) => { const n = { ...d }; if (v === undefined) delete n[r.value_id]; else n[r.value_id] = v; return n; })}
                        onAct={(action, text) => act([r.value_id], action, text, r.value_id)} />
                    ))}
                  </tbody>
                </Table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600 mt-3">
                <span>Showing <span className="font-medium text-gray-900 tabular-nums">{(page * PAGE_SIZE + 1).toLocaleString()}–{Math.min(total, (page + 1) * PAGE_SIZE).toLocaleString()}</span> of <span className="font-medium text-gray-900 tabular-nums">{total.toLocaleString()}</span></span>
                <div className="flex items-center gap-1">
                  <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}><ChevronLeft className="w-4 h-4" /> Prev</Button>
                  <span className="px-2 tabular-nums">Page {page + 1} / {pageCount}</span>
                  <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>Next <ChevronRight className="w-4 h-4" /></Button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <Modal open={confirmAll} onClose={() => setConfirmAll(false)} title={`Approve ${approvable.length.toLocaleString()} line${approvable.length === 1 ? '' : 's'}?`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirmAll(false)}>Cancel</Button><Button onClick={async () => { setConfirmAll(false); await act(approvable.map((r) => r.value_id), 'approve'); }}>Approve</Button></>}>
        <div className="text-sm text-gray-700 space-y-2">
          <p>These are the lines shown on this page. Once approved, a sequence step that uses the variable can send them.</p>
          {unsaved > 0 && <p className="text-amber-700">{unsaved} line{unsaved === 1 ? ' has' : 's have'} an edit you have not saved. {unsaved === 1 ? 'It is' : 'They are'} left out. Use “Save and approve” on {unsaved === 1 ? 'that row' : 'those rows'}.</p>}
        </div>
      </Modal>

      {generateOpen && <GenerateLinesModal open onClose={() => { setGenerateOpen(false); if (generate && !generatedRef.current) router.replace(batchId ? `/outreach/ai-review?batch=${batchId}` : '/outreach/ai-review'); generatedRef.current = false; }} workspaceId={ws} isManager={isManager} selection={selection} onGenerated={onGenerated} />}
      {toast.node}
    </div>
  );
}
