'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, History as HistoryIcon } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { normalizeGraph, sumNodeStats, validateGraph, type GraphIssue } from '@/lib/outreach/graph';
import { qk, useClients, useLeads, useLists, useNodeStats, useSenders, useSequence, useSequences, useStages, useTags, useWebhooks } from '@/lib/outreach/queries';
import type { Graph, GraphNode, NodeType, Tag } from '@/lib/outreach/types';
import { Button, EmptyState, ErrorBox, PageLoader, useToast } from '@/components/outreach/ui';
import Canvas, { type CanvasHandle, type IssueLevel, type StatKind } from './Canvas';
import StepPicker, { type StepPickerTarget } from './StepPicker';
import { allowedNext } from './allowedNext';
import NodeConfigPanel from './NodeConfigPanel';
import TopBar, { BUILDER_TABS, type BuilderTab, type DraftIndicator, type StatusAction } from './TopBar';
import { SendersTab, SettingsTab, TabPage } from './TabPanels';
import EnrolPanel from './EnrolPanel';
import VersionsPanel from './VersionsPanel';
import ValidationBar from './ValidationBar';
import { ConfirmModal, QaModal, UnsavedModal, type QaState } from './Modals';
import { BuilderContext, type BuilderCtx } from './context';
import { draftFromSequence, saveArgs, type Draft } from './draft';
import { clearLocalDraft, readLocalDraft, stableStringify, useDraftAutosave, writeLocalDraft, type LocalDraftCopy } from './DraftAutosave';
import { sqk, useEverEnrolled, useFailedCount, useInflightCount } from './hooks';
import { autoLayout, connectNodes, disconnectNodes, duplicateNode, formatGraphError, insertNode, nodeTitle, removeNode, updateNode, type Lookup } from './helpers';
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
const isTab = (v: string | null): v is BuilderTab => !!v && (BUILDER_TABS as string[]).includes(v);
/** The tab survives a reload through `?tab=`; Steps is the default and keeps the address clean. */

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
  const [qa, setQa] = useState<QaState | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'pause' | 'resume' | 'archive' | 'discard'; busy?: boolean } | null>(null);
  const [unsaved, setUnsaved] = useState<{ href: string; draftFailed: boolean; busy?: boolean } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  // `?tab=` picks the section, so a reload and the old /enroll and /versions links land on the right tab.
  const urlTab = useSearchParams().get('tab');
  const [tab, setTabState] = useState<BuilderTab>(() => (isTab(urlTab) ? urlTab : 'steps'));
  const [seenUrlTab, setSeenUrlTab] = useState(urlTab);
  if (urlTab !== seenUrlTab) { setSeenUrlTab(urlTab); if (isTab(urlTab)) setTabState(urlTab); }
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
  overlayOpen.current = !!(qa || confirm || unsaved || publishOpen || whyOpen || failedView);

  const setTab = useCallback((t: BuilderTab) => {
    setTabState(t);
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (t === 'steps') params.delete('tab'); else params.set('tab', t);
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  }, []);

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
  // the providers in the pool: channel steps need an account of their channel, messages take their channel from it
  const poolProviders = useMemo(() => Array.from(new Set(poolSenders.map((s) => s.provider))), [poolSenders]);
  const channelIndependent = draft?.settings?.channel_independent_continuation === true;

  const validation = useMemo(() => (draft ? validateGraph(draft.graph, { hasFreeSender, hasMailbox, strict: true, poolProviders, channelIndependent }) : { errors: [] as GraphIssue[], warnings: [] as GraphIssue[] }), [draft, hasFreeSender, hasMailbox, poolProviders, channelIndependent]);
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
  // A step can be focused from any tab (publish dialog, QA): the canvas is shown first and gets a moment to mount.
  const focusNode = useCallback((nid: string) => {
    setSelectedId(nid);
    if (canvasRef.current) { canvasRef.current.focusNode(nid); return; }
    setTab('steps');
    setTimeout(() => canvasRef.current?.focusNode(nid), 350);
  }, [setTab]);
  // The tree is laid out again after every change to the wiring, so steps always sit under the step they follow.
  const onConnect = useCallback((s: string, h: string, t: string) => updateGraph((g) => autoLayout(connectNodes(g, s, h, t))), [updateGraph]);
  const onDisconnect = useCallback((s: string, h: string) => updateGraph((g) => autoLayout(disconnectNodes(g, s, h))), [updateGraph]);

  // "+" on a line or a dangling branch: remember the spot, let the picker choose the step, then wire it in.
  const [picker, setPicker] = useState<StepPickerTarget | null>(null);
  const onAddHere = useCallback((source: string, handle: string, target: string | null) => { if (!readOnly) setPicker({ source, handle, target }); }, [readOnly]);
  const closePicker = useCallback(() => setPicker(null), []);
  const pickerAllowed = useMemo(() => (picker && draft ? allowedNext(draft.graph, picker.source, picker.handle, poolProviders) : null), [picker, draft, poolProviders]);
  const onPickStep = useCallback((type: NodeType) => {
    const d = draftRef.current;
    if (!d || !picker) return;
    const r = insertNode(d.graph, type, picker.source, picker.handle, picker.target);
    setPicker(null);
    if (!r) return;
    setDraft({ ...d, graph: r.graph });
    setSelectedId(r.node.id);
    setTimeout(() => canvasRef.current?.focusNode(r.node.id), 60);
  }, [picker]);

  const onNodeChange = useCallback((next: GraphNode) => updateGraph((g) => updateNode(g, next)), [updateGraph]);
  const onDuplicate = useCallback((nid: string) => {
    const d = draftRef.current;
    if (!d) return;
    const r = duplicateNode(d.graph, nid);
    if (!r) return;
    setDraft({ ...d, graph: autoLayout(r.graph) });
    setSelectedId(r.node.id);
  }, []);

  // Deleting a step only edits the draft. Leads sitting on it are handled in the publish dialog (skip or exit).
  const requestDelete = useCallback((ids: string[]) => {
    const d = draftRef.current;
    if (!d || readOnly || overlayOpen.current) return;
    const removable = ids.filter((nid) => d.graph.nodes[nid] && nid !== d.graph.start);
    if (removable.length === 0) return;
    updateGraph((g) => autoLayout(removable.reduce((acc, nid) => removeNode(acc, nid), g)));
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
      toast.show(formatGraphError(e, draftRef.current?.graph), 'error');
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
    } catch (e) { toast.show(formatGraphError(e, draftRef.current?.graph), 'error'); return false; }
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
    if (known) { setTabState('steps'); params.delete('tab'); setSelectedId(node); setTimeout(() => canvasRef.current?.focusNode(node!), 350); }
    for (const k of ['why', 'failed', 'node']) params.delete(k);
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  }, [hasDraft]);

  const ctx = useMemo<BuilderCtx | null>(() => (draft && sequence && ws ? {
    workspaceId: ws, sequenceId: sequence.id, sequence, graph: draft.graph, readOnly, senders, poolSenders,
    tags: lookup.tags ?? [], lists: lookup.lists ?? [], stages: lookup.stages ?? [], webhooks: lookup.webhooks ?? [], sequences: lookup.sequences ?? [],
    sampleLead, customKeys, createTag, focusNode,
  } : null), [draft, sequence, ws, readOnly, senders, poolSenders, lookup, sampleLead, customKeys, createTag, focusNode]);

  if (seqQ.isLoading || (sequence && !draft)) return <PageLoader />;
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
      <div className="flex flex-col -mx-4 md:-mx-6 -my-6 h-[calc(100dvh-3.5rem)] md:h-[100dvh] min-h-[560px] bg-gray-50">
        <TopBar
          sequence={sequence} draft={draft} dirty={dirty} saving={saving} version={sequence.head_version} readOnly={readOnly} canManage={canManage}
          publishMode={publishMode} modeKnown={modeKnown} canDiscard={dirty || !!autosave.savedAt} indicator={indicator}
          inflight={inflightQ.data} failedCount={failedQ.data} tab={tab} onTab={setTab}
          onChange={patchDraft} onSave={save} onPublish={openPublish} onDiscard={() => setConfirm({ kind: 'discard' })} onStatus={onStatus}
          onWhy={() => setWhyOpen(true)} onFailed={() => setFailedView({ nodeId: null, kind: 'failed' })}
          onNavigate={navigate}
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

        {tab === 'senders' && (
          <SendersTab sequenceId={sequence.id} draft={draft} senders={senders} readOnly={readOnly} publishMode={publishMode} dirty={dirty} onChange={patchDraft} onPoolApplied={onPoolApplied} onSave={save} />
        )}
        {tab === 'settings' && <SettingsTab draft={draft} clients={clientsQ.data ?? []} readOnly={readOnly} publishMode={publishMode} onChange={patchDraft} />}
        {tab === 'leads' && (
          <TabPage title="Leads" subtitle="Who is in this sequence, where each lead has got to, and add more leads by hand." wide>
            <EnrolPanel id={sequence.id} onOpenBuilder={() => setTab('steps')} />
          </TabPage>
        )}
        {tab === 'versions' && (
          <TabPage title="Versions" wide>
            {/* a restored version replaces the server draft: the next refetch loads it, even over local edits */}
            <VersionsPanel id={sequence.id} onRestored={() => { loadedKey.current = null; setTab('steps'); }} />
          </TabPage>
        )}
        {tab === 'auto' && (
          <TabPage title="Auto-enrol" subtitle="Rules that add new matching leads to this sequence on their own, every day." wide>
            {ws && <AutoEnrolRules sequenceId={sequence.id} workspaceId={ws} canManage={canManage && sequence.status !== 'archived'} sequenceActive={sequence.status === 'active'} />}
          </TabPage>
        )}
        {tab === 'steps' && <div className="flex-1 flex min-h-0 relative" role="tabpanel">
          <div className="flex-1 min-w-0 relative">
            <Canvas
              ref={canvasRef}
              graph={draft.graph} stats={stats} issues={issues} selectedId={selectedId} readOnly={readOnly} lookup={lookup}
              onSelect={onSelect} onConnect={onConnect} onDisconnect={onDisconnect}
              onRequestDelete={requestDelete} onAddHere={onAddHere} onOpenStat={onOpenStat}
            />
            {Object.keys(draft.graph.nodes).length <= 2 && !readOnly && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-600 shadow-sm pointer-events-none">Click the <span className="inline-flex items-center justify-center w-4 h-4 rounded border border-gray-300 text-[10px] font-semibold align-middle">+</span> under a step to add what happens next. Every branch gets its own.</div>
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
        </div>}
        {tab === 'steps' && <ValidationBar errors={validation.errors} warnings={validation.warnings} graph={draft.graph} onFocus={focusNode} />}

        <StepPicker open={!!picker && !readOnly} target={picker} nodes={draft.graph.nodes} allowed={pickerAllowed} onPick={onPickStep} onClose={closePicker} />
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

        <ConfirmModal
          open={confirm?.kind === 'discard'} title="Discard draft" confirmLabel="Discard draft" danger busy={confirm?.busy} onClose={() => setConfirm(null)} onConfirm={discardDraft}
          body={<><p>Every change since the last {publishMode ? 'publish' : 'save'} is thrown away{metaLabels.length ? `, including the ${metaLabels.join(', ')}` : ''}. This cannot be undone.</p>{publishMode && <p className="text-xs text-gray-500">Live leads are not affected. They never saw the draft.</p>}</>}
        />
        <ConfirmModal
          open={confirm?.kind === 'pause'} title="Pause sequence" confirmLabel="Pause" busy={confirm?.busy} onClose={() => setConfirm(null)} onConfirm={runConfirm}
          body={<><p><span className="font-semibold">{(inflightQ.data ?? 0).toLocaleString()}</span> lead{inflightQ.data === 1 ? ' is' : 's are'} currently in this sequence. Pausing stops everything: nothing queued goes out until you resume.</p><p className="text-xs text-gray-500">Waits and delays keep counting. On resume, each lead picks up from the step they were on.</p></>}
        />
        <ConfirmModal
          open={confirm?.kind === 'resume'} title="Resume sequence" confirmLabel="Resume" busy={confirm?.busy} onClose={() => setConfirm(null)} onConfirm={runConfirm}
          body={<p>Paused leads carry on from the step they were on, in the senders’ next working hours. Every sender in the pool must be connected.</p>}
        />
        <ConfirmModal
          open={confirm?.kind === 'archive'} title="Archive sequence" confirmLabel="Archive" danger busy={confirm?.busy} onClose={() => setConfirm(null)} onConfirm={runConfirm}
          body={<><p>Archiving takes <span className="font-semibold">all {(inflightQ.data ?? 0).toLocaleString()}</span> lead{inflightQ.data === 1 ? '' : 's'} out of this sequence and cancels anything waiting to send.</p><p className="text-xs text-gray-500">The steps and history are kept. You can move it back to draft later.</p></>}
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
