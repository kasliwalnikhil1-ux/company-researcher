'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ArrowRight, Search, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { SEQUENCE_ASSIGNMENTS, type EnrollResult } from '@/lib/outreach/types';
import { useClients, useLeads, useLists, useSenders, useSequence, useStages, useTags, type LeadFilters } from '@/lib/outreach/queries';
import { Avatar, BackLink, Badge, Button, Card, EmptyState, ErrorBox, Input, PageLoader, Select, Spinner, StatusPill, Table, Td, Th, Toggle, useToast } from '@/components/outreach/ui';
import { ProjectionView } from '@/components/outreach/sequences/Projection';
import EnrollmentsTable from '@/components/outreach/sequences/EnrollmentsTable';
import { fetchLeadIds, projectSequence, useEffectiveCaps, type ProjectionRow } from '@/components/outreach/sequences/hooks';
import { senderName, STATUS_TONE } from '@/components/outreach/sequences/helpers';
import { commitEnrollment, EnrollOptions, EnrollPreviewPanel, EnrollResultPanel, requestAiLines, useEnrollPreview, useSequenceAiVariables, type AiBatchLink, type EnrollOptionsValue } from './EnrollGuard';

const PAGE = 50;
const MAX = 10000;

function Step({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className={cn('flex items-center gap-2 text-sm', active ? 'text-indigo-700 font-medium' : done ? 'text-gray-700' : 'text-gray-400')}>
      <span className={cn('w-6 h-6 rounded-full flex items-center justify-center text-xs border', active ? 'bg-indigo-600 text-white border-indigo-600' : done ? 'bg-green-100 text-green-700 border-green-200' : 'border-gray-300')}>{done ? '✓' : n}</span>
      {label}
    </div>
  );
}

export default function EnrollPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  const { workspace, canWrite } = useWorkspace();
  const ws = workspace?.id ?? null;
  const qc = useQueryClient();
  const toast = useToast();
  const seq = useSequence(id);
  const senders = useSenders(ws);
  const clients = useClients(ws), lists = useLists(ws), stages = useStages(ws), tags = useTags(ws);

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [filters, setFilters] = useState<LeadFilters>({ dnc: false, page: 0, pageSize: PAGE });
  const [searchText, setSearchText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectingAll, setSelectingAll] = useState<number | null>(null);
  const [fixedSender, setFixedSender] = useState('');
  const [priority, setPriority] = useState(100);
  const [projection, setProjection] = useState<{ row: ProjectionRow | null; error?: string; loading: boolean } | null>(null);
  const [enrolling, setEnrolling] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<EnrollResult | null>(null);
  const [partialError, setPartialError] = useState<string | null>(null);
  const [includeReplied, setIncludeReplied] = useState(false);
  const [options, setOptions] = useState<EnrollOptionsValue | null>(null);
  const [aiBatches, setAiBatches] = useState<AiBatchLink[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setFilters((f) => ({ ...f, search: searchText.trim() || undefined, page: 0 })), 300); return () => clearTimeout(t); }, [searchText]);
  const leads = useLeads(ws, filters);
  const pool = useMemo(() => (seq.data?.sender_pool ?? []).map((sid) => senders.data?.find((s) => s.id === sid)).filter(Boolean) as NonNullable<typeof senders.data>, [seq.data?.sender_pool, senders.data]);
  const caps = useEffectiveCaps(pool.map((s) => s.id), 'invite');
  const count = selected.size;
  const ids = useMemo(() => [...selected], [selected]);
  const ai = useSequenceAiVariables(ws, seq.data?.graph);
  // The enrol guard: eligibility, exclusions, assignment and warnings all come from the database.
  const guard = useEnrollPreview(seq.data?.id ?? null, ids, fixedSender || null, includeReplied, step === 3);
  const eligible = guard.preview?.eligible ?? 0;
  const opts: EnrollOptionsValue = options ?? { waitEnrichment: !!seq.data?.settings?.wait_for_enrichment, generateAi: true };

  useEffect(() => {
    if (step !== 3 || !seq.data || eligible === 0) { setProjection(null); return; }
    let cancelled = false;
    setProjection({ row: null, loading: true });
    projectSequence(seq.data.id, eligible).then((row) => { if (!cancelled) setProjection({ row, loading: false }); }).catch((e) => { if (!cancelled) setProjection({ row: null, loading: false, error: parseError(e).message }); });
    return () => { cancelled = true; };
  }, [step, seq.data, eligible]);

  const toggle = (lid: string) => setSelected((s) => { const n = new Set(s); if (n.has(lid)) n.delete(lid); else n.add(lid); return n; });
  const pageIds = (leads.data?.rows ?? []).map((l) => l.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((x) => selected.has(x));
  const togglePage = () => setSelected((s) => { const n = new Set(s); if (allPageSelected) pageIds.forEach((x) => n.delete(x)); else pageIds.forEach((x) => n.add(x)); return n; });

  const selectAllMatching = async () => {
    if (!ws) return;
    setSelectingAll(0);
    try {
      const ids = await fetchLeadIds(ws, filters, MAX, (n) => setSelectingAll(n));
      setSelected(new Set(ids));
      toast.show(`Selected ${ids.length.toLocaleString()} lead${ids.length === 1 ? '' : 's'}${(leads.data?.count ?? 0) > MAX ? ` (capped at ${MAX.toLocaleString()})` : ''}`);
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setSelectingAll(null); }
  };

  const enroll = async () => {
    if (!seq.data || !ws || !guard.preview || eligible === 0) return;
    const sequenceId = seq.data.id;
    const enrolledIds = guard.preview.eligible_ids;
    setEnrolling({ done: 0, total: ids.length });
    setPartialError(null); setAiError(null); setAiBatches([]);
    let total: EnrollResult | null = null;
    try {
      // every selected lead goes to the database, so the result row also says who was skipped and why
      total = await commitEnrollment(sequenceId, ids, { senderId: fixedSender || null, priority, includeReplied, waitEnrichment: opts.waitEnrichment, onProgress: (done, all) => setEnrolling({ done, total: all }) });
    } catch (e) {
      const partial = (e as { partial?: EnrollResult }).partial;
      if (partial && partial.enrolled > 0) { total = partial; setPartialError(parseError(e).message); }
      else toast.show(parseError(e).message, 'error');
    }
    if (total) {
      if (opts.generateAi && ai.used.length > 0 && total.enrolled > 0 && enrolledIds.length > 0) {
        try { setAiBatches(await requestAiLines(ws, sequenceId, ai.used, enrolledIds)); }
        catch (e) { setAiError(parseError(e).message); }
      }
      setResult(total);
      setStep(4);
      qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'sequence_summary'] });
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'dashboard'] });
    }
    setEnrolling(null);
  };

  const reset = () => { setSelected(new Set()); setResult(null); setProjection(null); setIncludeReplied(false); setAiBatches([]); setAiError(null); setPartialError(null); setStep(1); };

  if (seq.isLoading) return <PageLoader />;
  if (seq.error) return <ErrorBox message={parseError(seq.error).message} />;
  if (!seq.data) return <EmptyState title="Sequence not found" action={<Link href="/outreach/sequences"><Button variant="secondary">Back to sequences</Button></Link>} />;
  const s = seq.data;
  const poolEmpty = pool.length === 0;
  const pageCount = Math.max(1, Math.ceil((leads.data?.count ?? 0) / PAGE));

  return (
    <div className="space-y-6">
      <div>
        <BackLink href={`/outreach/sequences/${id}`}>Back to builder</BackLink>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-gray-900">Enrol leads</h1>
          <span className="text-gray-400">·</span>
          <span className="text-gray-700">{s.name}</span>
          <Badge tone={STATUS_TONE[s.status]} className="capitalize">{s.status}</Badge>
        </div>
      </div>

      {s.status !== 'active' && (
        <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3"><AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>The sequence is <span className="font-medium">{s.status}</span>. Enrolled leads wait at the start step and only progress once it is activated.</span></div>
      )}
      {poolEmpty && (
        <div className="flex items-start gap-2 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-4 py-3"><AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>The sender pool is empty. Add at least one sender in the builder before enrolling.</span></div>
      )}

      {canWrite && (
        <Card>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-5">
            <Step n={1} label="Choose leads" active={step === 1} done={step > 1} />
            <Step n={2} label="Sender pool" active={step === 2} done={step > 2} />
            <Step n={3} label="Review and confirm" active={step === 3} done={step > 3} />
          </div>

          {step === 1 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[180px] max-w-xs">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" />
                  <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search name, company, headline, email" aria-label="Search leads" className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                {(clients.data?.length ?? 0) > 0 && <Select aria-label="Client" value={filters.client_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, client_id: e.target.value || null, page: 0 }))} className="w-auto"><option value="">All clients</option>{clients.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
                <Select aria-label="List" value={filters.list_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, list_id: e.target.value || null, page: 0 }))} className="w-auto"><option value="">All lists</option>{(lists.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
                <Select aria-label="Stage" value={filters.stage_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, stage_id: e.target.value || null, page: 0 }))} className="w-auto"><option value="">All stages</option>{(stages.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
                <Select aria-label="Tag" value={filters.tag_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, tag_id: e.target.value || null, page: 0 }))} className="w-auto"><option value="">Any tag</option>{(tags.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
                <Toggle checked={filters.dnc == null} onChange={(v) => setFilters((f) => ({ ...f, dnc: v ? null : false, page: 0 }))} label="Include do-not-contact" />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-gray-700"><span className="font-semibold">{count.toLocaleString()}</span> selected</span>
                {count > 0 && <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-gray-500 hover:text-gray-800 underline">Clear</button>}
                <span className="text-gray-300">|</span>
                <span className="text-gray-500">{(leads.data?.count ?? 0).toLocaleString()} matching</span>
                <Button variant="secondary" size="sm" loading={selectingAll != null} disabled={!leads.data?.count} onClick={selectAllMatching}>
                  {selectingAll != null ? `Collecting ${selectingAll.toLocaleString()}…` : `Select all matching${(leads.data?.count ?? 0) > MAX ? ` (first ${MAX.toLocaleString()})` : ''}`}
                </Button>
              </div>
              {leads.isLoading ? <Spinner /> : leads.error ? <ErrorBox message={parseError(leads.error).message} /> : (leads.data?.rows.length ?? 0) === 0 ? (
                <EmptyState title="No leads match" description="Adjust the filters or import leads first." />
              ) : (
                <>
                  <Table>
                    <thead><tr><Th className="w-8"><input type="checkbox" aria-label="Select page" checked={allPageSelected} onChange={togglePage} className="rounded border-gray-300 text-indigo-600" /></Th><Th>Lead</Th><Th>Company / title</Th><Th>Email</Th><Th>Client</Th></tr></thead>
                    <tbody>
                      {leads.data!.rows.map((l) => (
                        <tr key={l.id} className={cn('hover:bg-gray-50 cursor-pointer', selected.has(l.id) && 'bg-indigo-50/50')} onClick={() => toggle(l.id)}>
                          <Td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${l.full_name ?? 'lead'}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} className="rounded border-gray-300 text-indigo-600" /></Td>
                          <Td><div className="flex items-center gap-2"><Avatar src={l.picture_url} name={l.full_name} size={8} /><div className="min-w-0"><div className="font-medium text-gray-900 truncate">{l.full_name || l.public_identifier || '—'}</div><div className="text-xs text-gray-500 truncate max-w-[220px]">{l.headline}</div></div>{l.do_not_contact && <Badge tone="red">DNC</Badge>}</div></Td>
                          <Td className="text-gray-600"><div className="truncate max-w-[200px]">{l.company || '—'}</div><div className="text-xs text-gray-400 truncate max-w-[200px]">{l.title}</div></Td>
                          <Td className="text-gray-600 text-xs">{l.email_work || l.email_personal || <span className="text-gray-300">—</span>}</Td>
                          <Td className="text-gray-600 text-xs">{clients.data?.find((c) => c.id === l.client_id)?.name ?? '—'}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>Page {(filters.page ?? 0) + 1} of {pageCount}</span>
                    <div className="flex gap-1">
                      <Button variant="secondary" size="sm" disabled={(filters.page ?? 0) === 0} onClick={() => setFilters((f) => ({ ...f, page: Math.max(0, (f.page ?? 0) - 1) }))}>Previous</Button>
                      <Button variant="secondary" size="sm" disabled={(filters.page ?? 0) + 1 >= pageCount} onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 0) + 1 }))}>Next</Button>
                    </div>
                  </div>
                </>
              )}
              <div className="flex justify-end pt-2"><Button disabled={count === 0 || poolEmpty} onClick={() => setStep(2)}>Continue <ArrowRight className="w-4 h-4" /></Button></div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-2">Sender pool ({pool.length})</h3>
                <Table>
                  <thead><tr><Th>Sender</Th><Th>Status</Th><Th>Level</Th><Th className="text-right">Invites / day</Th></tr></thead>
                  <tbody>
                    {pool.map((p) => (
                      <tr key={p.id}>
                        <Td><div className="flex items-center gap-2"><Avatar src={p.picture_url} name={senderName(p)} size={8} /><span>{senderName(p)}</span><span className="text-xs text-gray-400">{p.provider === 'LINKEDIN' ? (p.is_premium ? 'Premium' : 'Free') : p.provider}</span></div></Td>
                        <Td><StatusPill status={p.status} reason={p.status_reason} /></Td>
                        <Td className="text-gray-600">{p.warmup_level}</Td>
                        <Td className="text-right tabular-nums">{caps.isLoading ? '…' : caps.data?.[p.id] ?? '—'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <p className="text-xs text-gray-500 mt-1">Assignment rule: <span className="font-medium text-gray-700">{SEQUENCE_ASSIGNMENTS.find((a) => a.value === s.assignment)?.label ?? s.assignment}</span>. {SEQUENCE_ASSIGNMENTS.find((a) => a.value === s.assignment)?.description} Senders that are not connected send nothing until they are reconnected.</p>
              </div>
              <div className="grid sm:grid-cols-2 gap-3 max-w-xl">
                <Select label="Fixed sender (optional)" value={fixedSender} onChange={(e) => setFixedSender(e.target.value)}>
                  <option value="">Use the assignment rule</option>
                  {pool.map((p) => <option key={p.id} value={p.id} disabled={p.status !== 'ok'}>{senderName(p)}{p.status !== 'ok' ? ` (${p.status})` : ''}</option>)}
                </Select>
                <Input type="number" min={1} max={1000} label="Priority" value={priority} onChange={(e) => setPriority(Math.max(1, Number(e.target.value) || 100))} hint="Lower numbers are planned first (default 100)." />
              </div>
              <div className="flex justify-between pt-2"><Button variant="secondary" onClick={() => setStep(1)}><ArrowLeft className="w-4 h-4" /> Back</Button><Button onClick={() => setStep(3)}>Continue <ArrowRight className="w-4 h-4" /></Button></div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <div className="grid sm:grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border border-gray-200 p-3"><div className="text-xs text-gray-500">Sender</div><div className="text-lg font-semibold truncate">{fixedSender ? senderName(pool.find((p) => p.id === fixedSender)) : `${pool.length} in pool`}</div></div>
                <div className="rounded-lg border border-gray-200 p-3"><div className="text-xs text-gray-500">Priority</div><div className="text-lg font-semibold">{priority}</div></div>
              </div>
              <EnrollPreviewPanel preview={guard.preview} loading={guard.loading} error={guard.error} includeReplied={includeReplied} onIncludeReplied={setIncludeReplied} hideProjection />
              {guard.error && <Button variant="secondary" size="sm" onClick={guard.refresh}>Try again</Button>}
              {eligible > 0 && (projection?.loading ? <Spinner /> : projection?.error ? <ErrorBox message={projection.error} /> : projection?.row ? <ProjectionView row={projection.row} leadCount={eligible} /> : null)}
              {guard.preview && eligible > 0 && <EnrollOptions sequence={s} value={opts} onChange={setOptions} ai={ai} disabled={!!enrolling} />}
              {enrolling && (
                <div role="status" aria-live="polite">
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden"><div className="h-full bg-indigo-600 transition-all" style={{ width: `${Math.round((enrolling.done / Math.max(1, enrolling.total)) * 100)}%` }} /></div>
                  <div className="text-xs text-gray-500 mt-1">Enrolling {enrolling.done.toLocaleString()} / {enrolling.total.toLocaleString()}…</div>
                </div>
              )}
              <div className="flex justify-between pt-2">
                <Button variant="secondary" disabled={!!enrolling} onClick={() => setStep(2)}><ArrowLeft className="w-4 h-4" /> Back</Button>
                <Button loading={!!enrolling} disabled={poolEmpty || guard.loading || !guard.preview || eligible === 0} onClick={enroll}><UserPlus className="w-4 h-4" /> Enrol {eligible.toLocaleString()} lead{eligible === 1 ? '' : 's'}</Button>
              </div>
            </div>
          )}

          {step === 4 && result && (
            <div className="space-y-4">
              <EnrollResultPanel result={result} aiBatches={aiBatches} aiError={aiError} partialError={partialError} />
              <div className="flex flex-wrap gap-2">
                <Link href={`/outreach/sequences/${id}`}><Button variant="secondary"><ArrowLeft className="w-4 h-4" /> Back to builder</Button></Link>
                <Button onClick={reset}><UserPlus className="w-4 h-4" /> Enrol more</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <EnrollmentsTable sequence={s} canWrite={canWrite} />
      {toast.node}
    </div>
  );
}
