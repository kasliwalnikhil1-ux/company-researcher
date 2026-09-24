'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpCircle, Code2, Eye, History, LayoutGrid, RotateCcw } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { normalizeGraph } from '@/lib/outreach/graph';
import { qk, useLists, useMembers, useSenders, useSequence, useSequenceVersions, useStages, useTags, useWebhooks, useSequences } from '@/lib/outreach/queries';
import type { SequenceVersion } from '@/lib/outreach/types';
import { Badge, Button, EmptyState, ErrorBox, fmtDate, Modal, PageHeader, PageLoader, Table, Td, Th, useToast } from '@/components/outreach/ui';
import MiniCanvas from '@/components/outreach/sequences/MiniCanvas';
import { ConfirmModal } from '@/components/outreach/sequences/Modals';
import { diffGraphs, formatGraphError, nodeCount, nodeTitle, type Lookup } from '@/components/outreach/sequences/helpers';
import { sqk, useVersionUsage } from '@/components/outreach/sequences/hooks';
import { clearLocalDraft } from '@/components/outreach/sequences/DraftAutosave';
import { fmtInt, plural, type MoveToLatestResult, type SaveDraftResult, type SequenceExt } from '@/components/outreach/sequences/publishTypes';

function DiffSummary({ diff, version, head }: { diff: ReturnType<typeof diffGraphs>; version: SequenceVersion; head: SequenceVersion['graph'] }) {
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  if (total === 0) return <span className="text-xs text-gray-400">Same steps as current</span>;
  const name = (id: string) => nodeTitle(version.graph.nodes[id] ?? head.nodes[id]);
  return (
    <div className="flex flex-wrap gap-1">
      {diff.added.length > 0 && <Badge tone="green" className="cursor-help"><span title={`Only in this version: ${diff.added.map(name).join(', ')}`}>+{diff.added.length} step{diff.added.length === 1 ? '' : 's'}</span></Badge>}
      {diff.removed.length > 0 && <Badge tone="red" className="cursor-help"><span title={`Only in current: ${diff.removed.map(name).join(', ')}`}>−{diff.removed.length} step{diff.removed.length === 1 ? '' : 's'}</span></Badge>}
      {diff.changed.length > 0 && <Badge tone="amber" className="cursor-help"><span title={`Different config: ${diff.changed.map(name).join(', ')}`}>~{diff.changed.length} changed</span></Badge>}
    </div>
  );
}

export default function SequenceVersionsPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  const { workspace, isManager, suspended } = useWorkspace();
  const ws = workspace?.id ?? null;
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const seq = useSequence(id);
  const versions = useSequenceVersions(id);
  const usage = useVersionUsage(id);
  const members = useMembers(ws);
  const tags = useTags(ws), lists = useLists(ws), stages = useStages(ws), senders = useSenders(ws), webhooks = useWebhooks(ws), sequences = useSequences(ws);
  const lookup = useMemo<Lookup>(() => ({ tags: tags.data, lists: lists.data, stages: stages.data, senders: senders.data, webhooks: webhooks.data, sequences: sequences.data }), [tags.data, lists.data, stages.data, senders.data, webhooks.data, sequences.data]);
  const [preview, setPreview] = useState<SequenceVersion | null>(null);
  const [mode, setMode] = useState<'canvas' | 'json'>('canvas');
  const [restore, setRestore] = useState<SequenceVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [move, setMove] = useState<{ version: number; leads: number } | null>(null);
  const [moved, setMoved] = useState<{ version: number; result: MoveToLatestResult } | null>(null);
  const canManage = isManager && !suspended;
  const usageMap = useMemo(() => Object.fromEntries((usage.data ?? []).map((u) => [u.version, u])), [usage.data]);

  const who = (uid: string | null) => {
    if (!uid) return 'system';
    const m = members.data?.find((x) => x.user_id === uid);
    return m?.display_name || m?.email || `${uid.slice(0, 8)}…`;
  };

  // Restoring never touches live leads: the old graph is loaded into the draft, and the builder publishes (or saves) it.
  const doRestore = async () => {
    if (!restore || !seq.data) return;
    setBusy(true);
    try {
      const graph = normalizeGraph(restore.graph);
      const r = await rpc<SaveDraftResult>('save_draft', { p_id: id, p_graph: graph });
      clearLocalDraft(id);
      qc.setQueryData(qk.sequence(id), (old: SequenceExt | undefined) => (old ? { ...old, draft_graph: graph, draft_updated_at: r.saved_at, draft_base_version: r.base_version } : old));
      await qc.invalidateQueries({ queryKey: qk.sequence(id) });
      toast.show(`Version ${restore.version} is loaded into the draft. Nothing is live yet.`);
      setRestore(null);
      router.push(`/outreach/sequences/${id}`);
    } catch (e) { toast.show(formatGraphError(e), 'error'); }
    finally { setBusy(false); }
  };

  const doMove = async () => {
    if (!move) return;
    setBusy(true);
    try {
      const result = await rpc<MoveToLatestResult>('move_to_latest', { p_sequence: id, p_version: move.version });
      setMoved({ version: move.version, result });
      setMove(null);
      qc.invalidateQueries({ queryKey: sqk.versionUsage(id) });
      qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(false); }
  };

  if (seq.isLoading || versions.isLoading) return <PageLoader />;
  if (seq.error) return <ErrorBox message={parseError(seq.error).message} />;
  if (!seq.data) return <EmptyState title="Sequence not found" action={<Link href="/outreach/sequences"><Button variant="secondary">Back to sequences</Button></Link>} />;
  const head = seq.data.graph;
  const list = versions.data ?? [];

  return (
    <div>
      <Link href={`/outreach/sequences/${id}`} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 mb-3"><ArrowLeft className="w-4 h-4" /> Back to builder</Link>
      <PageHeader title={<span className="flex items-center gap-2"><History className="w-6 h-6 text-gray-400" /> Version history</span>} subtitle={<>{seq.data.name} · live version v{seq.data.head_version}. Every publish that changes the steps creates a version. Restoring loads a version into the draft, so nothing changes for live leads until you publish.</>} />
      {(seq.data as SequenceExt).draft_graph && <p className="mb-3 text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2">This sequence has an unpublished draft. Restoring a version replaces that draft.</p>}
      {usage.error && <ErrorBox className="mb-3" message={`Lead counts per version could not be loaded: ${parseError(usage.error).message}`} />}
      {moved && (
        <div role="status" className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
          <p><span className="font-medium">{fmtInt(moved.result.moved)} {plural(moved.result.moved, 'lead')}</span> moved from version {moved.version} to the latest version.</p>
          {moved.result.kept_on_old_version > 0 && <p className="text-xs mt-0.5">{fmtInt(moved.result.kept_on_old_version)} stayed on version {moved.version}: the step they are on does not exist in the latest version, so they finish on the old one.</p>}
          <button type="button" onClick={() => setMoved(null)} className="text-xs underline underline-offset-2 mt-1">Dismiss</button>
        </div>
      )}
      {versions.error ? <ErrorBox message={parseError(versions.error).message} /> : list.length === 0 ? <EmptyState title="No versions yet" description="Save the sequence to create the first version." /> : (
        <Table>
          <thead><tr><Th>Version</Th><Th>Published</Th><Th>By</Th><Th>Note</Th><Th className="text-right">Steps</Th><Th className="text-right">Leads running</Th><Th>Compared to live</Th><Th className="text-right">Actions</Th></tr></thead>
          <tbody>
            {list.map((v) => {
              const isHead = v.version === seq.data!.head_version;
              const diff = diffGraphs(head, v.graph);
              const u = usageMap[v.version];
              const leads = u?.live_leads ?? 0;
              return (
                <tr key={v.version} className="hover:bg-gray-50">
                  <Td><span className="font-medium text-gray-900">v{v.version}</span>{isHead && <Badge tone="indigo" className="ml-2">live</Badge>}</Td>
                  <Td className="whitespace-nowrap">{fmtDate(v.created_at)}</Td>
                  <Td className="text-gray-600">{who(v.created_by)}</Td>
                  <Td className="max-w-[16rem]">
                    {u?.note ? <span className="block text-gray-700 truncate" title={u.note}>{u.note}</span> : <span className="text-gray-400">—</span>}
                    {u?.publish_mode && <span className="block text-[11px] text-gray-500">{u.publish_mode === 'new_only' ? 'Published for new leads only' : 'Published for everyone not yet at the changed steps'}</span>}
                  </Td>
                  <Td className="text-right tabular-nums">{nodeCount(v.graph)}</Td>
                  <Td className="text-right tabular-nums">{usage.isLoading ? <span className="text-gray-300">…</span> : leads > 0 ? <span className="font-medium text-gray-900">{fmtInt(leads)}</span> : <span className="text-gray-400">0</span>}</Td>
                  <Td>{isHead ? <span className="text-xs text-gray-400">—</span> : <DiffSummary diff={diff} version={v} head={head} />}</Td>
                  <Td>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => { setPreview(v); setMode('canvas'); }}><Eye className="w-4 h-4" /> Preview</Button>
                      {canManage && !isHead && leads > 0 && <Button variant="secondary" size="sm" onClick={() => setMove({ version: v.version, leads })} title="Move these leads to the latest version"><ArrowUpCircle className="w-4 h-4" /> Move {fmtInt(leads)} to latest</Button>}
                      {canManage && !isHead && <Button variant="secondary" size="sm" onClick={() => setRestore(v)}><RotateCcw className="w-4 h-4" /> Restore</Button>}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview ? `Version ${preview.version} · ${fmtDate(preview.created_at)}` : ''} size="xl"
        footer={<>
          <div className="mr-auto inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs">
            <button type="button" onClick={() => setMode('canvas')} className={`px-3 py-1.5 inline-flex items-center gap-1 ${mode === 'canvas' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700'}`}><LayoutGrid className="w-3.5 h-3.5" /> Canvas</button>
            <button type="button" onClick={() => setMode('json')} className={`px-3 py-1.5 inline-flex items-center gap-1 ${mode === 'json' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700'}`}><Code2 className="w-3.5 h-3.5" /> JSON</button>
          </div>
          {canManage && preview && preview.version !== seq.data.head_version && <Button variant="secondary" onClick={() => { setRestore(preview); setPreview(null); }}><RotateCcw className="w-4 h-4" /> Restore this version</Button>}
          <Button onClick={() => setPreview(null)}>Close</Button>
        </>}>
        {preview && (mode === 'canvas'
          ? <div className="h-[60vh] rounded-lg border border-gray-200 overflow-hidden"><MiniCanvas graph={preview.graph} lookup={lookup} /></div>
          : <pre className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-auto max-h-[60vh]">{JSON.stringify(preview.graph, null, 2)}</pre>)}
      </Modal>

      <ConfirmModal open={!!restore} title={`Restore version ${restore?.version}`} confirmLabel="Load into draft" busy={busy} onClose={() => setRestore(null)} onConfirm={doRestore}
        body={<><p>The steps of version {restore?.version} are loaded into the draft and the builder opens. Nothing is live until you publish there. Pool, settings and name stay as they are.</p>{(seq.data as SequenceExt).draft_graph && <p className="text-xs text-amber-700">The current unpublished draft is replaced.</p>}</>} />
      <ConfirmModal open={!!move} title="Move these leads to the latest version" confirmLabel={`Move ${fmtInt(move?.leads ?? 0)} ${plural(move?.leads ?? 0, 'lead')}`} busy={busy} onClose={() => setMove(null)} onConfirm={doMove}
        body={<><p>{fmtInt(move?.leads ?? 0)} {plural(move?.leads ?? 0, 'lead')} on version {move?.version} will follow version {seq.data.head_version} from the step they are on. Queued messages are written again from the latest text.</p><p className="text-xs text-gray-500">A lead whose current step does not exist in the latest version stays on version {move?.version} and finishes there.</p></>} />
      {toast.node}
    </div>
  );
}
