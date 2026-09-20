'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, History as HistoryIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { normalizeGraph, sumNodeStats, validateGraph, type GraphIssue } from '@/lib/outreach/graph';
import { qk, useClients, useLeads, useLists, useNodeStats, useSenders, useSequence, useSequences, useStages, useTags, useWebhooks } from '@/lib/outreach/queries';
import type { Graph, GraphNode, NodeType, Tag } from '@/lib/outreach/types';
import { Button, EmptyState, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import Canvas, { type CanvasHandle, type IssueLevel, type StatKind } from './Canvas';
import NodePalette from './NodePalette';
import NodeConfigPanel from './NodeConfigPanel';
import TopBar, { type DraftIndicator, type StatusAction } from './TopBar';
import ValidationBar from './ValidationBar';
import { ConfirmModal, Drawer, QaModal, UnsavedModal, type QaState } from './Modals';
import { BuilderContext, type BuilderCtx } from './context';
import { draftFromSequence, saveArgs, type Draft } from './draft';
import { clearLocalDraft, readLocalDraft, stableStringify, useDraftAutosave, writeLocalDraft, type LocalDraftCopy } from './DraftAutosave';
import { sqk, useEverEnrolled, useFailedCount, useInflightCount } from './hooks';
import { addNode, autoLayout, connectNodes, disconnectNodes, duplicateNode, formatGraphError, LAYOUT_X, moveNodes, nodeTitle, removeNode, updateNode, type Lookup } from './helpers';
import { fmtClock, fmtInt, isLiveStatus, plural, type PublishImpact, type SequenceExt, type SetPoolResult } from './publishTypes';
import PublishDialog, { type PublishOutcome } from './PublishDialog';
import QueuedNotice from './QueuedNotice';
import FailedLeadsDrawer from './FailedLeadsDrawer';
import { WhyNotSendingDialog } from './WhyNotSendingDialog';
import AutoEnrolRules from './AutoEnrolRules';

const EMPTY: never[] = [];

type Meta = Omit<Draft, 'graph'>;
const META_FIELDS: Array<[keyof Meta, string]> = [
  ['name', 'name'], ['pool', 'sender pool'], ['assignment', 'assignment rule'], ['useSenderSchedule', 'sender schedule'],
  ['settings', 'settings'], ['brief', 'AI brief'], ['clientId', 'client'],
];
const metaOf = (d: Draft): Meta => { const { graph: _g, ...meta } = d; return meta; };
const cloneGraph = (g: Graph): Graph => JSON.parse(JSON.stringify(g)) as Graph;
const validGraph = (g: unknown): g is Graph => !!g && typeof g === 'object' && typeof (g as Graph).nodes === 'object' && !!(g as Graph).start && !!(g as Graph).nodes[(g as Graph).start];

export default function Builder({ id }: { id: string }) {
  const { workspace, isManager, canWrite, suspended } = useWorkspace();
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
  const failedQ = useFailedCount(id);
  const everQ = useEverEnrolled(id);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [qa, setQa] = useState<QaState | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'pause' | 'resume' | 'archive' | 'discard'; busy?: boolean } | null>(null);
  const [unsaved, setUnsaved] = useState<{ href: string; draftFailed: boolean; busy?: boolean } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [failedView, setFailedView] = useState<{ nodeId: string | null; kind: StatKind } | null>(null);
  const [localOffer, setLocalOffer] = useState<LocalDraftCopy<Meta> | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const loadedKey = useRef<string | null>(null);
  const deleteHintShown = useRef(false);
  const localChecked = useRef(false);

  const sequence = (seqQ.data ?? null) as SequenceExt | null;
  const canManage = isManager && !suspended;
  const readOnly = !canManage || sequence?.status === 'archived';
  const liveStatus = !!sequence && isLiveStatus(sequence.status);
  // Sequences that are running, or ever had a lead, publish. A never-used sequence keeps the simple Save.
  const publishMode = liveStatus || everQ.data === true;
  const modeKnown = liveStatus || !everQ.isLoading;

  // What is live right now. The local draft is always compared against this.
  const live = useMemo(() => (sequence ? draftFromSequence(sequence) : null), [sequence]);
  // Everything that is compared, auto-saved, saved or published is the normalised graph (call-task fallback in the
  // top-level `next`, no empty outcome keys), which is what the engine reads.
  const liveGraphStr = useMemo(() => (live ? stableStringify(normalizeGraph(live.graph)) : ''), [live]);
  const normGraph = useMemo(() => (draft ? normalizeGraph(draft.graph) : null), [draft?.graph]); // eslint-disable-line react-hooks/exhaustive-deps
  const graphStr = useMemo(() => (normGraph ? stableStringify(normGraph) : ''), [normGraph]);
  const publishDraft = useMemo(() => (draft && normGraph ? { ...draft, graph: normGraph } : null), [draft, normGraph]);
  const metaLabels = useMemo(() => {
    if (!draft || !live) return [] as string[];
    return META_FIELDS.filter(([k]) => stableStringify(draft[k]) !== stableStringify(live[k])).map(([, label]) => label);
  }, [draft, live]);
  const graphDirty = !!draft && graphStr !== liveGraphStr;
  const dirty = !readOnly && (graphDirty || metaLabels.length > 0);
  const meta = useMemo(() => (draft ? metaOf(draft) : null), [draft]);

  const autosave = useDraftAutosave<Meta | null>({ sequenceId: id, graph: normGraph, graphStr, enabled: !readOnly && !!draft, meta, metaDirty: metaLabels.length > 0 });
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Delete / Backspace reach React Flow even while a dialog is open; a step must never vanish behind one.
  const overlayOpen = useRef(false);
  overlayOpen.current = !!(qa || confirm || unsaved || publishOpen || whyOpen || rulesOpen || failedView);

  // Load / reload the local draft from the server row. Local edits are never overwritten by a refetch.
  useEffect(() => {
    if (!sequence) return;
    const key = `${sequence.id}:${sequence.head_version}:${sequence.updated_at}:${sequence.draft_updated_at ?? ''}:${readOnly ? 'r' : 'w'}`;
    if (loadedKey.current === key) return;
    const first = loadedKey.current === null;
    loadedKey.current = key;
    if (!first && dirtyRef.current) return;

    const d = draftFromSequence(sequence);
    // People who cannot edit see the live flow; editors continue from the shared draft when there is one.
    const serverDraft = !readOnly && validGraph(sequence.draft_graph) ? sequence.draft_graph : null;
    if (serverDraft) d.graph = cloneGraph(serverDraft);
    // the browser copy is looked at once, the first time the builder opens for someone who can edit
    const local = !readOnly && !localChecked.current ? readLocalDraft<Meta>(sequence.id) : null;
    if (!readOnly) localChecked.current = true;
    autosaveRef.current.reset(normalizeGraph(d.graph), serverDraft ? {
      status: 'saved', savedAt: sequence.draft_updated_at ?? null, baseVersion: sequence.draft_base_version ?? null, headVersion: sequence.head_version,
      stale: sequence.draft_base_version != null && sequence.draft_base_version !== sequence.head_version,
    } : undefined);
    setDraft(d);

    if (serverDraft) {
      // the change count is the database's number, not a client-side diff
      rpc<PublishImpact>('publish_impact', { p_id: sequence.id })
        .then((r) => autosaveRef.current.seed({ unpublishedChanges: r.changes, stale: !!r.stale, headVersion: r.head_version }))
        .catch(() => { /* the count fills in with the next auto-save */ });
    }
    if (local) {
      const serverTs = Date.parse(sequence.draft_updated_at ?? sequence.updated_at ?? '') || 0;
      const differs = stableStringify(normalizeGraph(local.graph)) !== stableStringify(normalizeGraph(d.graph)) || (!!local.meta && stableStringify(local.meta) !== stableStringify(metaOf(d)));
      if (local.ts > serverTs && differs) { writeLocalDraft(sequence.id, local); setLocalOffer(local); }
      else clearLocalDraft(sequence.id);
    }
  }, [sequence, readOnly]);

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
  // one row per (node, variant) in the table: the canvas shows the sum per step
  const stats = useMemo(() => sumNodeStats(statsQ.data), [statsQ.data]);

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

  // Deleting a step only edits the draft. Leads sitting on it are handled in the publish dialog (skip or exit).
  const requestDelete = useCallback((ids: string[]) => {
    const d = draftRef.current;
    if (!d || readOnly || overlayOpen.current) return;
    const removable = ids.filter((nid) => d.graph.nodes[nid] && nid !== d.graph.start);
    if (removable.length === 0) return;
    updateGraph((g) => removable.reduce((acc, nid) => removeNode(acc, nid), g));
    setSelectedId((cur) => (cur && removable.includes(cur) ? null : cur));
    if (publishMode && !deleteHintShown.current) {
      deleteHintShown.current = true;
      toast.show('Removed from the draft. Live leads are not affected until you publish.');
    }
  }, [readOnly, publishMode, updateGraph, toast]);

  const patchCache = useCallback((patch: Partial<SequenceExt>) => {
    qc.setQueryData(qk.sequence(id), (old: SequenceExt | undefined) => (old ? { ...old, ...patch } : old));
  }, [qc, id]);

  const invalidateSequence = useCallback(() => {
    qc.invalidateQueries({ queryKey: qk.sequence(id) });
    if (sequence) qc.invalidateQueries({ queryKey: qk.sequences(sequence.workspace_id) });
    qc.invalidateQueries({ queryKey: qk.sequenceVersions(id) });
    qc.invalidateQueries({ queryKey: sqk.versionUsage(id) });
  }, [qc, id, sequence]);

  /** Simple save for sequences that never had a lead (rpc save_sequence). */
  const save = useCallback(async (): Promise<boolean> => {
    const d = draftRef.current;
    if (!d || readOnly || !sequence) return false;
    if (!d.name.trim()) { toast.show('Give the sequence a name first', 'error'); return false; }
    setSaving(true);
    try {
      await autosaveRef.current.settle();
      const graph = normalizeGraph(d.graph);
      // save_sequence also clears the server draft: the saved graph is the working version now
      const version = await rpc<number>('save_sequence', saveArgs(sequence.id, { ...d, graph }));
      autosaveRef.current.reset(graph);
      patchCache({ graph, head_version: version, name: d.name.trim(), sender_pool: d.pool, settings: d.settings, assignment: d.assignment, use_sender_schedule: d.useSenderSchedule, brief: d.brief, client_id: d.clientId ?? sequence.client_id, draft_graph: null, draft_updated_at: null, draft_base_version: null });
      toast.show(`Saved as version ${version}`);
      invalidateSequence();
      return true;
    } catch (e) {
      toast.show(formatGraphError(e), 'error');
      return false;
    } finally { setSaving(false); }
  }, [readOnly, sequence, toast, patchCache, invalidateSequence]);

  const openPublish = useCallback(async () => {
    const d = draftRef.current;
    if (!d || readOnly || !sequence) return;
    if (!d.name.trim()) { toast.show('Give the sequence a name first', 'error'); return; }
    setSaving(true);
    // the server draft carries the version the edit started from, which is what detects a second editor
    try { await autosaveRef.current.flush(); } finally { setSaving(false); }
    setPublishOpen(true);
  }, [readOnly, sequence, toast]);

  const onPublished = useCallback((r: PublishOutcome) => {
    const d = draftRef.current;
    if (!d || !sequence) return;
    const graph = normalizeGraph(d.graph);
    autosaveRef.current.reset(graph);
    patchCache({
      graph, head_version: r.version, name: d.name.trim() || sequence.name, settings: d.settings, assignment: d.assignment, brief: d.brief,
      use_sender_schedule: d.useSenderSchedule, client_id: d.clientId ?? sequence.client_id,
      draft_graph: null, draft_updated_at: null, draft_base_version: null,
    });
    invalidateSequence();
    qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
    qc.invalidateQueries({ queryKey: qk.nodeStats(id) });
    qc.invalidateQueries({ queryKey: ['outreach', 'sequence', id, 'queued'] });
  }, [sequence, patchCache, invalidateSequence, qc, id]);

  const discardDraft = useCallback(async () => {
    if (!sequence || readOnly) return;
    setConfirm({ kind: 'discard', busy: true });
    try {
      await autosaveRef.current.settle();
      await rpc('discard_draft', { p_id: sequence.id });
      const d = draftFromSequence(sequence);
      autosaveRef.current.reset(normalizeGraph(d.graph));
      setDraft(d);
      setLocalOffer(null);
      setSelectedId((cur) => (cur && d.graph.nodes[cur] ? cur : null));
      patchCache({ draft_graph: null, draft_updated_at: null, draft_base_version: null });
      toast.show(publishMode ? 'Draft discarded. The builder shows the live version.' : 'Draft discarded. The builder shows the last saved version.');
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setConfirm(null); }
  }, [sequence, readOnly, patchCache, toast, publishMode]);

  const restoreLocal = useCallback(() => {
    const d = draftRef.current;
    if (!localOffer || !d) return;
    const m = (localOffer.meta ?? {}) as Partial<Meta>;
    // a live pool is changed through the rebalance dialog only, never restored from a browser copy
    const { pool: localPool, ...rest } = m;
    setDraft({ ...d, ...rest, ...(publishMode || !localPool ? {} : { pool: localPool }), graph: cloneGraph(localOffer.graph) });
    setLocalOffer(null);
    setSelectedId(null);
    toast.show('Restored the changes kept in this browser');
  }, [localOffer, publishMode, toast]);

  const onPoolApplied = useCallback((pool: string[], r: SetPoolResult) => {
    patchDraft({ pool });
    patchCache({ sender_pool: pool });
    invalidateSequence();
    qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
    const parts = [r.moved > 0 ? `${fmtInt(r.moved)} ${plural(r.moved, 'lead')} moved` : '', r.exited > 0 ? `${fmtInt(r.exited)} exited` : ''].filter(Boolean);
    toast.show(`Pool saved${parts.length ? `. ${parts.join(', ')}.` : ''}`);
  }, [patchDraft, patchCache, invalidateSequence, qc, toast]);

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
      if (dirty && publishMode) { toast.show('Publish or discard your draft changes first, then activate.', 'error'); return; }
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
  }, [sequence, canManage, dirty, publishMode, save, setStatus, toast]);

  const confirmActivate = useCallback(async () => {
    setQa((q) => (q ? { ...q, activating: true } : q));
    const ok = await setStatus('active');
    if (ok) { toast.show('Sequence activated'); setQa(null); } else setQa((q) => (q ? { ...q, activating: false } : q));
  }, [setStatus, toast]);

  const runConfirm = useCallback(async () => {
    if (!confirm || confirm.kind === 'discard') return;
    setConfirm({ ...confirm, busy: true });
    const target = confirm.kind === 'pause' ? 'paused' : confirm.kind === 'resume' ? 'active' : 'archived';
    const ok = await setStatus(target);
    setConfirm(null);
    if (!ok) return;
    if (confirm.kind === 'archive') { toast.show('Sequence archived'); router.push('/outreach/sequences'); }
    else toast.show(confirm.kind === 'pause' ? 'Sequence paused' : 'Sequence resumed');
  }, [confirm, setStatus, toast, router]);

  // Leaving: the graph is auto-saved, so only a failed draft write or unsaved name / settings hold the user back.
  const navigate = useCallback(async (href: string) => {
    if (readOnly) { router.push(href); return; }
    const ok = await autosaveRef.current.flush();
    if (ok && metaLabels.length === 0) router.push(href);
    else setUnsaved({ href, draftFailed: !ok });
  }, [readOnly, router, metaLabels.length]);

  const needsGuard = !readOnly && (autosave.unsaved || autosave.status === 'error' || metaLabels.length > 0);
  useEffect(() => {
    if (!needsGuard) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [needsGuard]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's')) return;
      e.preventDefault();
      if (!dirtyRef.current || saving || !modeKnown || publishOpen) return;
      if (publishMode) void openPublish(); else void save();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save, openPublish, saving, publishMode, modeKnown, publishOpen]);

  // React Flow listens for Delete / Backspace on the document. While any dialog or drawer is up, those keys
  // belong to it (typing still works: events from form fields are left alone).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      if (!document.querySelector('.fixed.inset-0.z-50, [data-outreach-drawer]')) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      e.stopPropagation();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  const createTag = useCallback(async (name: string): Promise<Tag> => {
    if (!ws) throw new Error('No workspace');
    const { data, error } = await supabase.from('outreach_tags').insert({ workspace_id: ws, name }).select('*').single();
    if (error) throw parseError(error);
    qc.invalidateQueries({ queryKey: qk.tags(ws) });
    return data as Tag;
  }, [ws, qc]);

  const onOpenStat = useCallback((nodeId: string, kind: StatKind) => setFailedView({ nodeId, kind }), []);

  // Deep links from reports, the dashboard and the inbox:
  //   ?why=1 opens the diagnosis, ?failed=1[&node=<id>] opens the failed-leads list, ?node=<id> selects that step.
  // Read once the draft is on screen, then removed from the address bar so a reload does not reopen the dialog.
  const deepLinkDone = useRef(false);
  const hasDraft = !!draft;
  useEffect(() => {
    if (!hasDraft || deepLinkDone.current || typeof window === 'undefined') return;
    deepLinkDone.current = true;
    const params = new URLSearchParams(window.location.search);
    const on = (k: string) => { const v = params.get(k); return v !== null && v !== '0' && v !== 'false'; };
    const node = params.get('node');
    const g = draftRef.current?.graph;
    const known = !!node && !!g?.nodes[node];
    if (!on('why') && !on('failed') && !node) return;
    if (on('why')) setWhyOpen(true);
    if (on('failed')) setFailedView({ nodeId: node || null, kind: 'failed' });
    // focusNode also selects the step; the short wait lets React Flow measure the nodes first.
    // No cleanup on purpose: the ref is null-safe, and clearing here would drop the focus under React strict mode.
    if (known) { setSelectedId(node); setTimeout(() => canvasRef.current?.focusNode(node!), 350); }
    for (const k of ['why', 'failed', 'node']) params.delete(k);
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  }, [hasDraft]);

  const ctx = useMemo<BuilderCtx | null>(() => (draft && sequence && ws ? {
    workspaceId: ws, sequenceId: sequence.id, sequence, graph: draft.graph, readOnly, senders, poolSenders,
    tags: lookup.tags ?? [], lists: lookup.lists ?? [], stages: lookup.stages ?? [], webhooks: lookup.webhooks ?? [], sequences: lookup.sequences ?? [],
    sampleLead, customKeys, createTag, focusNode,
  } : null), [draft, sequence, ws, readOnly, senders, poolSenders, lookup, sampleLead, customKeys, createTag, focusNode]);

  if (seqQ.isLoading || (sequence && !draft)) return <Spinner className="py-24" />;
  if (seqQ.error) return <div className="p-6"><ErrorBox message={parseError(seqQ.error).message} /></div>;
  if (!sequence || !draft || !ctx || !live || !publishDraft) return <EmptyState title="Sequence not found" description="It may have been deleted or belongs to another workspace." action={<Link href="/outreach/sequences"><Button variant="secondary">Back to sequences</Button></Link>} />;
  if (ws && sequence.workspace_id !== ws) return <EmptyState title="Sequence belongs to another workspace" description="Switch workspace to edit it." action={<Link href="/outreach/sequences"><Button variant="secondary">Back to sequences</Button></Link>} />;

  const selectedNode = selectedId ? draft.graph.nodes[selectedId] ?? null : null;
  const selectedIssues = selectedId ? [...validation.errors, ...validation.warnings].filter((i) => i.node_id === selectedId) : [];

  const graphChanges = graphDirty ? autosave.unpublishedChanges : 0;
  const indicator: DraftIndicator = {
    status: autosave.status, savedAt: autosave.savedAt, error: autosave.error, retrying: autosave.retrying,
    unpublished: graphChanges === null ? null : graphChanges + metaLabels.length,
    layoutOnly: graphDirty && graphChanges === 0 && metaLabels.length === 0,
  };
  // the pool is applied at once through set_pool, everything else travels in the publish call
  const publishMeta = metaLabels.filter((l) => l !== 'sender pool');
  const failedNode = failedView?.nodeId ? draft.graph.nodes[failedView.nodeId] ?? live.graph.nodes[failedView.nodeId] : null;
  const failedStats = failedView?.nodeId ? stats[failedView.nodeId] : null;
  const stale = !readOnly && autosave.stale && dirty;

  return (
    <BuilderContext.Provider value={ctx}>
      <div className="flex flex-col -mx-4 md:-mx-6 -my-6 h-[calc(100vh-6.5rem)] md:h-[calc(100vh-3rem)] min-h-[560px] bg-gray-50">
        <TopBar
          sequence={sequence} draft={draft} dirty={dirty} saving={saving} version={sequence.head_version} readOnly={readOnly} canManage={canManage}
          publishMode={publishMode} modeKnown={modeKnown} canDiscard={dirty || !!autosave.savedAt} indicator={indicator}
          senders={senders} clients={clientsQ.data ?? []} inflight={inflightQ.data} failedCount={failedQ.data}
          onChange={patchDraft} onSave={save} onPublish={openPublish} onDiscard={() => setConfirm({ kind: 'discard' })} onPoolApplied={onPoolApplied} onStatus={onStatus}
          onWhy={() => setWhyOpen(true)} onAutoEnrol={() => setRulesOpen(true)} onFailed={() => setFailedView({ nodeId: null, kind: 'failed' })}
          onAutoLayout={() => { updateGraph(autoLayout); setTimeout(() => canvasRef.current?.fitView(), 50); }}
          onFit={() => canvasRef.current?.fitView()}
          onNavigate={navigate}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        {stale && (
          <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-sm text-amber-900">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1 min-w-[12rem]">Version {fmtInt(autosave.headVersion ?? sequence.head_version)} was published while you were editing. Review the difference before you publish over it.</span>
            <Button size="sm" variant="secondary" onClick={openPublish}>Review and publish</Button>
          </div>
        )}
        {localOffer && !readOnly && (
          <div role="status" className="flex flex-wrap items-center gap-2 px-4 py-2 bg-indigo-50 border-b border-indigo-200 text-sm text-indigo-900">
            <HistoryIcon className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1 min-w-[12rem]">This browser has changes from {fmtClock(localOffer.ts)} that never reached the server.</span>
            <Button size="sm" onClick={restoreLocal}>Restore unsaved changes from this browser</Button>
            <Button size="sm" variant="ghost" onClick={() => { clearLocalDraft(sequence.id); setLocalOffer(null); }}>Dismiss</Button>
          </div>
        )}

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
              onRequestDelete={requestDelete} onAddNode={onAddNode} onOpenStat={onOpenStat}
            />
            {Object.keys(draft.graph.nodes).length <= 2 && !readOnly && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-600 shadow-sm pointer-events-none">Click or drag steps from the palette, then connect the handles.</div>
            )}
          </div>
          {selectedNode && (
            <div className="fixed inset-x-0 bottom-0 z-30 h-[62vh] rounded-t-2xl shadow-2xl overflow-hidden flex flex-col md:static md:h-full md:w-80 md:flex-shrink-0 md:rounded-none md:shadow-none md:z-auto md:overflow-visible">
              <QueuedNotice sequenceId={sequence.id} node={selectedNode} live={liveStatus} canManage={canManage} senders={senders} />
              <NodeConfigPanel
                node={selectedNode} issues={selectedIssues} readOnly={readOnly}
                onChange={onNodeChange} onDelete={(nid) => requestDelete([nid])} onDuplicate={onDuplicate} onClose={() => setSelectedId(null)}
                className="flex-1 min-h-0 !h-auto"
              />
            </div>
          )}
        </div>
        <ValidationBar errors={validation.errors} warnings={validation.warnings} graph={draft.graph} onFocus={focusNode} />

        <QaModal qa={qa} graph={draft.graph} onClose={() => setQa(null)} onActivate={confirmActivate} onFocus={focusNode} />
        <PublishDialog
          open={publishOpen} onClose={() => setPublishOpen(false)} sequenceId={sequence.id} liveGraph={live.graph} draft={publishDraft}
          metaLabels={publishMeta} onFocusNode={focusNode} onPublished={onPublished}
        />
        <WhyNotSendingDialog open={whyOpen} onClose={() => setWhyOpen(false)} sequenceId={sequence.id} />
        <FailedLeadsDrawer
          open={!!failedView} onClose={() => setFailedView(null)} sequenceId={sequence.id} nodeId={failedView?.nodeId ?? null}
          nodeLabel={failedNode ? nodeTitle(failedNode) : undefined} initialKind={failedView?.kind ?? 'failed'} graph={live.graph} canWrite={canWrite}
          counts={failedStats ? { failed: Number(failedStats.failed ?? 0), skipped: Number(failedStats.skipped ?? 0) } : undefined}
        />
        <Drawer open={rulesOpen} onClose={() => setRulesOpen(false)} title="Auto-enrol rules" subtitle={sequence.name} width="max-w-3xl">
          {rulesOpen && ws && <AutoEnrolRules sequenceId={sequence.id} workspaceId={ws} canManage={canManage && sequence.status !== 'archived'} sequenceActive={sequence.status === 'active'} />}
        </Drawer>

        <ConfirmModal
          open={confirm?.kind === 'discard'} title="Discard draft" confirmLabel="Discard draft" danger busy={confirm?.busy} onClose={() => setConfirm(null)} onConfirm={discardDraft}
          body={<><p>Every change since the last {publishMode ? 'publish' : 'save'} is thrown away{metaLabels.length ? `, including the ${metaLabels.join(', ')}` : ''}. This cannot be undone.</p>{publishMode && <p className="text-xs text-gray-500">Live leads are not affected. They never saw the draft.</p>}</>}
        />
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
          open={!!unsaved} busy={!!unsaved?.busy} draftFailed={!!unsaved?.draftFailed} metaLabels={metaLabels}
          primaryLabel={publishMode ? 'Review and publish' : 'Save and continue'}
          onCancel={() => setUnsaved(null)}
          onLeave={() => { const href = unsaved!.href; setUnsaved(null); router.push(href); }}
          onPrimary={async () => {
            const href = unsaved!.href;
            if (publishMode) { setUnsaved(null); void openPublish(); return; }
            setUnsaved({ ...unsaved!, busy: true });
            const ok = await save();
            setUnsaved(null);
            if (ok) router.push(href);
          }}
        />
        {toast.node}
      </div>
    </BuilderContext.Provider>
  );
}
