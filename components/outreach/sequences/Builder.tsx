'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { validateGraph, type GraphIssue } from '@/lib/outreach/graph';
import { qk, useClients, useLeads, useLists, useNodeStats, useSenders, useSequence, useSequences, useStages, useTags, useWebhooks } from '@/lib/outreach/queries';
import type { Graph, GraphNode, NodeStats, NodeType, Tag } from '@/lib/outreach/types';
import { Button, EmptyState, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import Canvas, { type CanvasHandle, type IssueLevel } from './Canvas';
import NodePalette from './NodePalette';
import NodeConfigPanel from './NodeConfigPanel';
import TopBar, { type StatusAction } from './TopBar';
import ValidationBar from './ValidationBar';
import { ConfirmModal, InflightDeleteModal, QaModal, UnsavedModal, type QaState } from './Modals';
import { BuilderContext, type BuilderCtx } from './context';
import { draftFromSequence, saveArgs, serializeDraft, type Draft } from './draft';
import { countInflight, useInflightCount } from './hooks';
import { addNode, autoLayout, connectNodes, disconnectNodes, duplicateNode, formatGraphError, LAYOUT_X, moveNodes, nodeTitle, removeNode, updateNode, type Lookup } from './helpers';

const EMPTY: never[] = [];

export default function Builder({ id }: { id: string }) {
  const { workspace, isManager, suspended } = useWorkspace();
  const ws = workspace?.id ?? null;
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();

  const seqQ = useSequence(id);
  const sendersQ = useSenders(ws);
  const clientsQ = useClients(ws);
  const tagsQ = useTags(ws);
  const listsQ = useLists(ws);
  const stagesQ = useStages(ws);
  const webhooksQ = useWebhooks(ws);
  const sequencesQ = useSequences(ws);
  const statsQ = useNodeStats(id);
  const leadsQ = useLeads(ws, { pageSize: 1 });
  const inflightQ = useInflightCount(id);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [qa, setQa] = useState<QaState | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'pause' | 'resume' | 'archive'; busy?: boolean } | null>(null);
  const [inflightReq, setInflightReq] = useState<{ nodeId: string; label: string; count: number; resolve: (m: 'skip' | 'cancel' | null) => void } | null>(null);
  const [inflightBusy, setInflightBusy] = useState(false);
  const [unsaved, setUnsaved] = useState<{ href: string; busy?: boolean } | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const loadedKey = useRef<string | null>(null);

  const sequence = seqQ.data ?? null;
  const dirty = useMemo(() => (draft ? serializeDraft(draft) !== baseline : false), [draft, baseline]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Load / reload the local draft from the server row (never clobber unsaved edits).
  useEffect(() => {
    if (!sequence) return;
    const key = `${sequence.id}:${sequence.updated_at}:${sequence.head_version}`;
    if (loadedKey.current === key) return;
    if (draft && dirtyRef.current && loadedKey.current?.startsWith(`${sequence.id}:`)) return;
    const d = draftFromSequence(sequence);
    setDraft(d);
    setBaseline(serializeDraft(d));
    loadedKey.current = key;
  }, [sequence, draft]);

  const canManage = isManager && !suspended;
  const readOnly = !canManage || sequence?.status === 'archived';
  const senders = sendersQ.data ?? EMPTY;
  const lookup = useMemo<Lookup>(() => ({ tags: tagsQ.data ?? EMPTY, lists: listsQ.data ?? EMPTY, stages: stagesQ.data ?? EMPTY, senders, webhooks: webhooksQ.data ?? EMPTY, sequences: sequencesQ.data ?? EMPTY }), [tagsQ.data, listsQ.data, stagesQ.data, senders, webhooksQ.data, sequencesQ.data]);
  const poolSenders = useMemo(() => (draft?.pool ?? []).map((pid) => senders.find((s) => s.id === pid)).filter(Boolean) as typeof senders, [draft?.pool, senders]);
  const hasFreeSender = poolSenders.some((s) => s.provider === 'LINKEDIN' && !s.is_premium);
  const hasMailbox = poolSenders.some((s) => s.provider !== 'LINKEDIN');

  const validation = useMemo(() => (draft ? validateGraph(draft.graph, { hasFreeSender, hasMailbox, strict: true }) : { errors: [] as GraphIssue[], warnings: [] as GraphIssue[] }), [draft, hasFreeSender, hasMailbox]);
  const issues = useMemo(() => {
    const m: Record<string, IssueLevel> = {};
    for (const w of validation.warnings) if (w.node_id) m[w.node_id] = 'warning';
    for (const e of validation.errors) if (e.node_id) m[e.node_id] = 'error';
    return m;
  }, [validation]);
  const stats = useMemo(() => {
    const m: Record<string, NodeStats> = {};
    for (const s of statsQ.data ?? []) m[s.node_id] = s;
    return m;
  }, [statsQ.data]);

  const sampleLead = leadsQ.data?.rows[0] ?? null;
  const customKeys = useMemo(() => Object.keys((sampleLead?.custom as Record<string, unknown> | undefined) ?? {}), [sampleLead]);

  const updateGraph = useCallback((fn: (g: Graph) => Graph) => setDraft((d) => (d ? { ...d, graph: fn(d.graph) } : d)), []);
  const patchDraft = useCallback((patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d)), []);
  const onSelect = useCallback((nid: string | null) => setSelectedId(nid), []);
  const focusNode = useCallback((nid: string) => { setSelectedId(nid); canvasRef.current?.focusNode(nid); }, []);
  const onMoveNodes = useCallback((positions: Record<string, { x: number; y: number }>) => updateGraph((g) => moveNodes(g, positions)), [updateGraph]);
  const onConnect = useCallback((s: string, h: string, t: string) => updateGraph((g) => connectNodes(g, s, h, t)), [updateGraph]);
  const onDisconnect = useCallback((s: string, h: string) => updateGraph((g) => disconnectNodes(g, s, h)), [updateGraph]);

  const onAddNode = useCallback((type: NodeType, position?: { x: number; y: number }) => {
    const d = draftRef.current;
    if (!d) return;
    let pos = position;
    if (!pos) {
      const sel = selectedId ? d.graph.nodes[selectedId] : null;
      pos = sel ? { x: sel.position.x + LAYOUT_X, y: sel.position.y } : canvasRef.current?.centerPosition() ?? { x: 200, y: 200 };
    }
    const { graph, node } = addNode(d.graph, type, pos);
    setDraft({ ...d, graph });
    setSelectedId(node.id);
    setPaletteOpen(false);
  }, [selectedId]);

  const onNodeChange = useCallback((next: GraphNode) => updateGraph((g) => updateNode(g, next)), [updateGraph]);
  const onDuplicate = useCallback((nid: string) => {
    const d = draftRef.current;
    if (!d) return;
    const r = duplicateNode(d.graph, nid);
    if (!r) return;
    setDraft({ ...d, graph: r.graph });
    setSelectedId(r.node.id);
  }, []);

  const askInflight = useCallback((nodeId: string, label: string, count: number) => new Promise<'skip' | 'cancel' | null>((resolve) => setInflightReq({ nodeId, label, count, resolve })), []);

  const requestDelete = useCallback(async (ids: string[]) => {
    if (!draft || readOnly || !sequence) return;
    const live = sequence.status === 'active' || sequence.status === 'paused';
    for (const nid of ids) {
      const node = draft.graph.nodes[nid];
      if (!node || nid === draft.graph.start) continue;
      if (live) {
        let count = 0;
        try { count = await countInflight(sequence.id, nid); } catch (e) { toast.show(parseError(e).message, 'error'); continue; }
        if (count > 0) {
          const mode = await askInflight(nid, nodeTitle(node), count);
          if (!mode) continue;
          setInflightBusy(true);
          try {
            const n = await rpc<number>('delete_node_inflight', { p_sequence: sequence.id, p_node_id: nid, p_mode: mode });
            toast.show(`${n} enrollment${n === 1 ? '' : 's'} ${mode === 'skip' ? 'moved past' : 'exited at'} “${nodeTitle(node)}”`);
            qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
            qc.invalidateQueries({ queryKey: qk.nodeStats(sequence.id) });
          } catch (e) { toast.show(parseError(e).message, 'error'); continue; }
          finally { setInflightBusy(false); setInflightReq(null); }
        }
      }
      updateGraph((g) => removeNode(g, nid));
      setSelectedId((cur) => (cur === nid ? null : cur));
    }
  }, [draft, readOnly, sequence, askInflight, toast, qc, updateGraph]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft || readOnly || !sequence) return false;
    if (!draft.name.trim()) { toast.show('Give the sequence a name first', 'error'); return false; }
    setSaving(true);
    try {
      const version = await rpc<number>('save_sequence', saveArgs(sequence.id, draft));
      setBaseline(serializeDraft(draft));
      toast.show(`Saved as version ${version}`);
      qc.invalidateQueries({ queryKey: qk.sequence(sequence.id) });
      qc.invalidateQueries({ queryKey: qk.sequences(sequence.workspace_id) });
      qc.invalidateQueries({ queryKey: qk.sequenceVersions(sequence.id) });
      return true;
    } catch (e) {
      toast.show(formatGraphError(e), 'error');
      return false;
    } finally { setSaving(false); }
  }, [draft, readOnly, sequence, toast, qc]);

  const setStatus = useCallback(async (status: 'active' | 'paused' | 'archived' | 'draft') => {
    if (!sequence) return false;
    try {
      await rpc('set_sequence_status', { p_id: sequence.id, p_status: status });
      qc.invalidateQueries({ queryKey: qk.sequence(sequence.id) });
      qc.invalidateQueries({ queryKey: qk.sequences(sequence.workspace_id) });
      qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
      return true;
    } catch (e) { toast.show(formatGraphError(e), 'error'); return false; }
  }, [sequence, qc, toast]);

  const onStatus = useCallback(async (action: StatusAction) => {
    if (!sequence || !canManage) return;
    if (action === 'activate') {
      if (dirty && !(await save())) return;
      setQa({ loading: true, errors: [], warnings: [], ai_available: false });
      try {
        const r = await callFn<{ errors: GraphIssue[]; warnings: GraphIssue[]; ai_available: boolean }>('ai-sequence-qa', { sequence_id: sequence.id });
        setQa({ loading: false, errors: r.errors ?? [], warnings: r.warnings ?? [], ai_available: !!r.ai_available });
      } catch (e) {
        setQa({ loading: false, errors: [], warnings: [], ai_available: false, failed: parseError(e).message });
      }
      return;
    }
    if (action === 'draft') { if (await setStatus('draft')) toast.show('Sequence moved back to draft'); return; }
    setConfirm({ kind: action });
  }, [sequence, canManage, dirty, save, setStatus, toast]);

  const confirmActivate = useCallback(async () => {
    setQa((q) => (q ? { ...q, activating: true } : q));
    const ok = await setStatus('active');
    if (ok) { toast.show('Sequence activated'); setQa(null); } else setQa((q) => (q ? { ...q, activating: false } : q));
  }, [setStatus, toast]);

  const runConfirm = useCallback(async () => {
    if (!confirm) return;
    setConfirm({ ...confirm, busy: true });
    const target = confirm.kind === 'pause' ? 'paused' : confirm.kind === 'resume' ? 'active' : 'archived';
    const ok = await setStatus(target);
    setConfirm(null);
    if (!ok) return;
    if (confirm.kind === 'archive') { toast.show('Sequence archived'); router.push('/outreach/sequences'); }
    else toast.show(confirm.kind === 'pause' ? 'Sequence paused' : 'Sequence resumed');
  }, [confirm, setStatus, toast, router]);

  const navigate = useCallback((href: string) => {
    if (dirty && !readOnly) setUnsaved({ href }); else router.push(href);
  }, [dirty, readOnly, router]);

  // Unsaved-changes guard + keyboard shortcuts.
  useEffect(() => {
    if (!dirty || readOnly) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, readOnly]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirtyRef.current && !saving) save(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save, saving]);

  const createTag = useCallback(async (name: string): Promise<Tag> => {
    if (!ws) throw new Error('No workspace');
    const { data, error } = await supabase.from('outreach_tags').insert({ workspace_id: ws, name }).select('*').single();
    if (error) throw parseError(error);
    qc.invalidateQueries({ queryKey: qk.tags(ws) });
    return data as Tag;
  }, [ws, qc]);

  const ctx = useMemo<BuilderCtx | null>(() => (draft && sequence && ws ? {
    workspaceId: ws, sequenceId: sequence.id, sequence, graph: draft.graph, readOnly, senders, poolSenders,
    tags: lookup.tags ?? [], lists: lookup.lists ?? [], stages: lookup.stages ?? [], webhooks: lookup.webhooks ?? [], sequences: lookup.sequences ?? [],
    sampleLead, customKeys, createTag, focusNode,
  } : null), [draft, sequence, ws, readOnly, senders, poolSenders, lookup, sampleLead, customKeys, createTag, focusNode]);

  if (seqQ.isLoading || (sequence && !draft)) return <Spinner className="py-24" />;
  if (seqQ.error) return <div className="p-6"><ErrorBox message={parseError(seqQ.error).message} /></div>;
  if (!sequence || !draft || !ctx) return <EmptyState title="Sequence not found" description="It may have been deleted or belongs to another workspace." action={<Link href="/outreach/sequences"><Button variant="secondary">Back to sequences</Button></Link>} />;
  if (ws && sequence.workspace_id !== ws) return <EmptyState title="Sequence belongs to another workspace" description="Switch workspace to edit it." action={<Link href="/outreach/sequences"><Button variant="secondary">Back to sequences</Button></Link>} />;

  const selectedNode = selectedId ? draft.graph.nodes[selectedId] ?? null : null;
  const selectedIssues = selectedId ? [...validation.errors, ...validation.warnings].filter((i) => i.node_id === selectedId) : [];

  return (
    <BuilderContext.Provider value={ctx}>
      <div className="flex flex-col -mx-4 md:-mx-6 -my-6 h-[calc(100vh-6.5rem)] md:h-[calc(100vh-3rem)] min-h-[560px] bg-gray-50">
        <TopBar
          sequence={sequence} draft={draft} dirty={dirty} saving={saving} version={sequence.head_version} readOnly={readOnly} canManage={canManage}
          senders={senders} clients={clientsQ.data ?? []} inflight={inflightQ.data}
          onChange={patchDraft} onSave={save} onStatus={onStatus}
          onAutoLayout={() => { updateGraph(autoLayout); setTimeout(() => canvasRef.current?.fitView(), 50); }}
          onFit={() => canvasRef.current?.fitView()}
          onNavigate={navigate}
          onOpenPalette={() => setPaletteOpen(true)}
        />
        <div className="flex-1 flex min-h-0 relative">
          {paletteOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setPaletteOpen(false)} />}
          <NodePalette
            onAdd={(t) => onAddNode(t)}
            readOnly={readOnly}
            onClose={() => setPaletteOpen(false)}
            className={cn(paletteOpen ? 'fixed inset-y-0 left-0 z-40 w-72 shadow-xl md:static md:w-60 md:shadow-none md:z-auto' : 'hidden md:flex md:w-60', 'flex-shrink-0')}
          />
          <div className="flex-1 min-w-0 relative">
            <Canvas
              ref={canvasRef}
              graph={draft.graph} stats={stats} issues={issues} selectedId={selectedId} readOnly={readOnly} lookup={lookup}
              onSelect={onSelect} onMoveNodes={onMoveNodes} onConnect={onConnect} onDisconnect={onDisconnect}
              onRequestDelete={requestDelete} onAddNode={onAddNode}
            />
            {Object.keys(draft.graph.nodes).length <= 2 && !readOnly && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-600 shadow-sm pointer-events-none">Click or drag steps from the palette, then connect the handles.</div>
            )}
          </div>
          {selectedNode && (
            <NodeConfigPanel
              node={selectedNode} issues={selectedIssues} readOnly={readOnly}
              onChange={onNodeChange} onDelete={(nid) => requestDelete([nid])} onDuplicate={onDuplicate} onClose={() => setSelectedId(null)}
              className="fixed inset-x-0 bottom-0 z-30 h-[62vh] rounded-t-2xl shadow-2xl md:static md:h-full md:w-80 md:flex-shrink-0 md:rounded-none md:shadow-none md:z-auto"
            />
          )}
        </div>
        <ValidationBar errors={validation.errors} warnings={validation.warnings} graph={draft.graph} onFocus={focusNode} />

        <QaModal qa={qa} graph={draft.graph} onClose={() => setQa(null)} onActivate={confirmActivate} onFocus={focusNode} />
        <InflightDeleteModal req={inflightReq} busy={inflightBusy} onChoose={(m) => { inflightReq?.resolve(m); if (!m) setInflightReq(null); }} />
        <ConfirmModal
          open={confirm?.kind === 'pause'} title="Pause sequence" confirmLabel="Pause" busy={confirm?.busy} onClose={() => setConfirm(null)} onConfirm={runConfirm}
          body={<><p><span className="font-semibold">{(inflightQ.data ?? 0).toLocaleString()}</span> live enrollment{inflightQ.data === 1 ? '' : 's'} will be paused: queued actions are cancelled and nothing is sent until you resume.</p><p className="text-xs text-gray-500">Waits and delays keep counting; resuming re-plans the current steps.</p></>}
        />
        <ConfirmModal
          open={confirm?.kind === 'resume'} title="Resume sequence" confirmLabel="Resume" busy={confirm?.busy} onClose={() => setConfirm(null)} onConfirm={runConfirm}
          body={<p>Paused enrollments return to their previous state and the planner picks them up in the next sender windows. All pool senders must be connected.</p>}
        />
        <ConfirmModal
          open={confirm?.kind === 'archive'} title="Archive sequence" confirmLabel="Archive" danger busy={confirm?.busy} onClose={() => setConfirm(null)} onConfirm={runConfirm}
          body={<><p>Archiving exits <span className="font-semibold">all {(inflightQ.data ?? 0).toLocaleString()}</span> live enrollment{inflightQ.data === 1 ? '' : 's'} (reason “sequence archived”) and cancels their queued actions.</p><p className="text-xs text-gray-500">The graph and history are kept; you can move it back to draft later.</p></>}
        />
        <UnsavedModal
          open={!!unsaved} busy={!!unsaved?.busy} onCancel={() => setUnsaved(null)}
          onDiscard={() => { const href = unsaved!.href; setBaseline(serializeDraft(draft)); setUnsaved(null); router.push(href); }}
          onSaveAndGo={async () => { const href = unsaved!.href; setUnsaved({ href, busy: true }); const ok = await save(); setUnsaved(null); if (ok) router.push(href); }}
        />
        {toast.node}
      </div>
    </BuilderContext.Provider>
  );
}
