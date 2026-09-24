'use client';

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState, type MouseEvent } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, useReactFlow, MarkerType, applyNodeChanges, applyEdgeChanges, BaseEdge, EdgeLabelRenderer, getSmoothStepPath,
  type Node, type Edge, type Connection, type NodeProps, type EdgeProps, type NodeChange, type EdgeChange, type NodeTypes, type EdgeTypes, type OnSelectionChangeParams, type IsValidConnection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Check, Clock, Hand, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Graph, GraphNode, NodeStats } from '@/lib/outreach/types';
import { NODE_CATALOG, exitLabel, nodeExits } from '@/lib/outreach/nodes';
import { exitTone, formatDelay, layoutPositions, nodeSummary, NODE_W, openExits, usesNext, type ExitTone, type Lookup } from './helpers';
import { StepIcon } from './StepPicker';

export type IssueLevel = 'error' | 'warning';
export type StatKind = 'failed' | 'skipped';
/** One step's figures, summed over its variants (sumNodeStats in lib/outreach/graph.ts). */
export type StepStats = Omit<NodeStats, 'variant_id'>;
/** "Add a step here": on exit `handle` of `source`; `target` is set when the exit already leads to a step (insert between). */
export type AddHere = (source: string, handle: string, target: string | null) => void;
export type OutreachNodeData = {
  node: GraphNode; summary: string; stats: StepStats | null; issue: IssueLevel | null;
  /** Exits with nothing connected yet: each gets a "+" under the step. */
  open: string[];
  onStat?: (nodeId: string, kind: StatKind) => void;
  onAdd?: AddHere;
};
export type OutreachRFNode = Node<OutreachNodeData, 'outreach'>;
export type OutreachEdgeData = { handle: string; label: string | null; tone: ExitTone; onAdd?: AddHere };
export type OutreachRFEdge = Edge<OutreachEdgeData, 'outreach'>;

const STAT_CHIPS: Array<{ key: keyof StepStats; label: string; cls: string; open?: StatKind }> = [
  { key: 'queued', label: 'queued', cls: 'bg-gray-100 text-gray-700' },
  { key: 'sent', label: 'sent', cls: 'bg-blue-100 text-blue-800' },
  { key: 'accepted', label: 'accepted', cls: 'bg-green-100 text-green-800' },
  { key: 'replied', label: 'replied', cls: 'bg-purple-100 text-purple-800' },
  { key: 'failed', label: 'failed', cls: 'bg-red-100 text-red-800 hover:bg-red-200', open: 'failed' },
  { key: 'skipped', label: 'skipped', cls: 'bg-amber-100 text-amber-800 hover:bg-amber-200', open: 'skipped' },
];
const chipValue = (stats: StepStats, key: keyof StepStats): number => Number(stats[key] ?? 0) || 0;

const HANDLE_CLS = '!w-2.5 !h-2.5 !border-2 !border-white';
const EDGE_COLOR = '#9ca3af';
const handleColor = (exit: string): string => {
  const tone = exitTone(exit);
  return tone === 'negative' ? '!bg-rose-400' : tone === 'positive' ? '!bg-emerald-500' : '!bg-indigo-500';
};
/** Horizontal position of exit `i` of `k` along the bottom edge. */
const exitLeft = (i: number, k: number): string => `${((i + 0.5) / k) * 100}%`;

const PILL_CLS: Record<ExitTone, string> = {
  positive: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  negative: 'bg-rose-50 text-rose-600 border-rose-200',
  neutral: 'bg-white text-gray-600 border-gray-200',
};

function BranchPill({ label, tone, className }: { label: string; tone: ExitTone; className?: string }) {
  const Icon = tone === 'positive' ? Check : tone === 'negative' ? X : null;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 shadow-sm whitespace-nowrap', PILL_CLS[tone], className)}>
      {Icon && <Icon className="w-3 h-3" strokeWidth={2.5} />}
      {label}
    </span>
  );
}

/** The square "+" that sits on a line: the one way to add the next step (HeyReach-style). */
function AddButton({ title, onClick, className }: { title: string; onClick: (e: MouseEvent<HTMLButtonElement>) => void; className?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        'nodrag nopan inline-flex items-center justify-center w-7 h-7 rounded-lg border border-gray-300 bg-white text-gray-500 shadow-sm',
        'hover:border-indigo-500 hover:text-indigo-600 hover:bg-indigo-50 hover:scale-110 focus:outline-none focus:ring-2 focus:ring-indigo-400 transition-transform',
        className,
      )}
    >
      <Plus className="w-4 h-4" strokeWidth={2.25} />
    </button>
  );
}

/** A branch with nothing after it yet: a short line down from the step, its name, and a "+". */
function AddStub({ left, label, tone, title, onClick }: { left: string; label: string | null; tone: ExitTone; title: string; onClick: () => void }) {
  return (
    <div className="absolute flex flex-col items-center pointer-events-none" style={{ top: '100%', left, transform: 'translateX(-50%)' }}>
      <span className="block h-4 w-px bg-gray-300" />
      {label && <BranchPill label={label} tone={tone} className="mb-1.5 max-w-[120px] overflow-hidden text-ellipsis" />}
      <AddButton title={title} onClick={(e) => { e.stopPropagation(); onClick(); }} className="pointer-events-auto" />
    </div>
  );
}

export const OutreachNode = memo(function OutreachNode({ data, selected }: NodeProps<OutreachRFNode>) {
  const { node, summary, stats, issue, open, onStat, onAdd } = data;
  const meta = NODE_CATALOG[node.type];
  // ab_split and ai_route get their exits from the step config, so always ask the node
  const exits = nodeExits(node);
  const single = usesNext(node);
  const hasDelay = !!node.delay && node.delay.amount > 0;
  const title = node.label || meta.label;
  const isStart = node.type === 'start';
  return (
    <div
      className={cn(
        'relative rounded-xl border bg-white shadow-sm text-left transition-shadow',
        selected ? 'border-indigo-500 ring-2 ring-indigo-200 shadow-md' : issue === 'error' ? 'border-red-400' : issue === 'warning' ? 'border-amber-400' : 'border-gray-200',
      )}
      style={{ width: NODE_W }}
    >
      {!isStart && <Handle type="target" position={Position.Top} className={cn(HANDLE_CLS, '!bg-gray-400')} />}
      {/* delay strip: "Wait 3 days, then" */}
      <div className={cn('px-3 py-1.5 rounded-t-xl text-[11px] flex items-center gap-1.5 border-b', isStart ? 'bg-gray-900 text-white border-gray-900' : 'bg-gray-50 text-gray-500 border-gray-100')}>
        {isStart ? (
          <span className="font-semibold text-xs">Sequence start</span>
        ) : hasDelay ? (
          <><Clock className="w-3 h-3" /> Wait <span className="font-medium text-indigo-600">{formatDelay(node.delay)}</span>, then</>
        ) : (
          <><Clock className="w-3 h-3" /> No delay</>
        )}
        {node.mode === 'manual' && <span title="Manual: creates a task and waits for completion" className="ml-auto inline-flex items-center gap-0.5 text-[10px] bg-white rounded px-1 border border-gray-200"><Hand className="w-3 h-3" />manual</span>}
      </div>
      {!isStart && (
        <div className="flex items-center gap-3 px-3 py-2.5">
          <StepIcon type={node.type} className="w-9 h-9" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-gray-900 truncate">{title}</div>
            <div className="text-xs text-gray-500 leading-4 break-words line-clamp-2">{summary || meta.description}</div>
          </div>
        </div>
      )}
      {stats && STAT_CHIPS.some((c) => chipValue(stats, c.key) > 0) && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {STAT_CHIPS.filter((c) => chipValue(stats, c.key) > 0).map((c) => {
            const text = `${chipValue(stats, c.key).toLocaleString()} ${c.label}`;
            const cls = cn('text-[10px] font-medium rounded-full px-1.5 py-0.5 tabular-nums', c.cls);
            // failed / skipped open the recovery list; nodrag + nopan keep React Flow from treating the click as a drag
            return c.open && onStat
              ? <button key={c.key} type="button" title={`Show ${c.label} leads and why`} onClick={(e) => { e.stopPropagation(); onStat(node.id, c.open!); }} className={cn(cls, 'nodrag nopan cursor-pointer underline decoration-dotted underline-offset-2 focus:outline-none focus:ring-2 focus:ring-indigo-400')}>{text}</button>
              : <span key={c.key} className={cls}>{text}</span>;
          })}
        </div>
      )}
      {exits.map((e, i) => {
        const left = exitLeft(i, exits.length);
        const label = single ? null : exitLabel(node, e);
        return (
          <span key={e}>
            <Handle type="source" position={Position.Bottom} id={e} className={cn(HANDLE_CLS, single ? '!bg-indigo-500' : handleColor(e))} style={{ left }} />
            {onAdd && open.includes(e) && (
              <AddStub left={left} label={label} tone={exitTone(e)} title={label ? `Add a step on the “${label}” branch` : `Add a step after ${title}`} onClick={() => onAdd(node.id, e, null)} />
            )}
          </span>
        );
      })}
    </div>
  );
});

/** Smooth-step line down to the next step, with the branch name as a pill and a "+" to insert a step in between. */
export const OutreachEdge = memo(function OutreachEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd, style }: EdgeProps<OutreachRFEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 14 });
  const label = data?.label ?? null;
  const tone = data?.tone ?? 'neutral';
  const onAdd = data?.onAdd;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={selected ? { ...style, stroke: '#6366f1', strokeWidth: 2 } : style} />
      {(label || onAdd) && (
        <EdgeLabelRenderer>
          <div
            className="absolute flex flex-col items-center gap-1 nodrag nopan pointer-events-auto"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label && <BranchPill label={label} tone={tone} />}
            {onAdd && <AddButton title={label ? `Add a step on the “${label}” branch` : 'Add a step here'} onClick={(e) => { e.stopPropagation(); onAdd(source, data!.handle, target); }} />}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const nodeTypes: NodeTypes = { outreach: OutreachNode };
export const edgeTypes: EdgeTypes = { outreach: OutreachEdge };

const MARKER = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: EDGE_COLOR } as const;
const EDGE_STYLE = { stroke: EDGE_COLOR, strokeWidth: 1.5 } as const;

export function deriveEdges(graph: Graph, readOnly: boolean, onAdd?: AddHere): OutreachRFEdge[] {
  const edges: OutreachRFEdge[] = [];
  const add = readOnly ? undefined : onAdd;
  for (const n of Object.values(graph.nodes)) {
    const exits = nodeExits(n);
    if (usesNext(n)) {
      if (!n.next || !graph.nodes[n.next]) continue;
      edges.push({ id: `${n.id}::${exits[0]}::${n.next}`, source: n.id, sourceHandle: exits[0], target: n.next, type: 'outreach', deletable: !readOnly, data: { handle: exits[0], label: null, tone: 'neutral', onAdd: add }, markerEnd: MARKER, style: EDGE_STYLE });
    } else if (exits.length > 0) {
      // a call task made outside the builder (API, connector) keeps its fallback only in the top-level `next`
      const branches = exits.includes('next') && !('next' in (n.branches ?? {})) && n.next ? { ...(n.branches ?? {}), next: n.next } : n.branches ?? {};
      for (const [b, t] of Object.entries(branches)) {
        if (!t || !graph.nodes[t] || !exits.includes(b)) continue;
        edges.push({ id: `${n.id}::${b}::${t}`, source: n.id, sourceHandle: b, target: t, type: 'outreach', deletable: !readOnly, data: { handle: b, label: exitLabel(n, b), tone: exitTone(b), onAdd: add }, markerEnd: MARKER, style: EDGE_STYLE });
      }
    }
  }
  return edges;
}

/** Edges are derived from the graph, so identity only has to change when the wiring or a branch name does. */
function sameEdges(a: OutreachRFEdge[], b: OutreachRFEdge[]): boolean {
  return a.length === b.length && a.every((e, i) => e.id === b[i].id && e.deletable === b[i].deletable && e.data?.label === b[i].data?.label && !!e.data?.onAdd === !!b[i].data?.onAdd);
}

/**
 * Nodes for React Flow. Positions come from the tree layout, not from the graph: an older sequence laid out
 * left-to-right shows up as a tree straight away, without touching the draft.
 */
export function deriveNodes(graph: Graph, opts: { stats: Record<string, StepStats>; issues: Record<string, IssueLevel>; selectedId: string | null; readOnly: boolean; lookup: Lookup; onStat?: (nodeId: string, kind: StatKind) => void; onAdd?: AddHere }, prev: OutreachRFNode[]): OutreachRFNode[] {
  const prevMap = new Map(prev.map((n) => [n.id, n]));
  const positions = layoutPositions(graph);
  return Object.values(graph.nodes).map((gn) => {
    const old = prevMap.get(gn.id);
    return {
      id: gn.id,
      type: 'outreach',
      position: positions[gn.id] ?? gn.position,
      measured: old?.measured,
      selected: gn.id === opts.selectedId,
      deletable: gn.type !== 'start' && !opts.readOnly,
      draggable: false,
      connectable: !opts.readOnly,
      data: {
        node: gn, summary: nodeSummary(gn, opts.lookup, graph.nodes), stats: opts.stats[gn.id] ?? null, issue: opts.issues[gn.id] ?? null,
        open: opts.readOnly ? [] : openExits(gn, graph.nodes), onStat: opts.onStat, onAdd: opts.readOnly ? undefined : opts.onAdd,
      },
    };
  });
}

/*
 * React Flow copies every prop it tracks into its zustand store from an effect whose deps are those
 * props. Anything recreated during render (object/array literals, non-memoised callbacks) makes that
 * effect fire on every render, and its store writes re-render the flow, which re-renders us — an
 * update loop that trips React's "maximum update depth". So: constants live outside the component and
 * every handler we hand to React Flow keeps a stable identity (latest logic via ref).
 */
const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1 };
const PRO_OPTIONS = { hideAttribution: true };
const DELETE_KEYS = ['Backspace', 'Delete'];
const MINIMAP_CLS = '!bg-white !border !border-gray-200 !rounded-lg hidden md:block';
const minimapNodeColor = (n: { data?: unknown }) => {
  const t = (n.data as OutreachNodeData | undefined)?.node?.type;
  return t === 'start' ? '#1f2937' : t === 'end' ? '#6b7280' : '#a5b4fc';
};

/** Stable callback wrapper (always runs the latest closure). */
function useEvent<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback(((...args: Parameters<T>) => ref.current(...(args as never[]))) as T, []);
}

export interface CanvasHandle {
  focusNode: (id: string) => void;
  fitView: () => void;
}

export interface CanvasProps {
  graph: Graph;
  stats: Record<string, StepStats>;
  issues: Record<string, IssueLevel>;
  selectedId: string | null;
  readOnly: boolean;
  lookup: Lookup;
  onSelect: (id: string | null) => void;
  onConnect: (source: string, handle: string, target: string) => void;
  onDisconnect: (source: string, handle: string) => void;
  onRequestDelete: (ids: string[]) => void;
  /** A "+" on a line or under a step was clicked: open the step picker for that spot. */
  onAddHere?: AddHere;
  /** A Failed / Skipped badge on a step was clicked. */
  onOpenStat?: (nodeId: string, kind: StatKind) => void;
  className?: string;
}

const CanvasInner = forwardRef<CanvasHandle, CanvasProps>(function CanvasInner(props, ref) {
  const { graph, stats, issues, selectedId, readOnly, lookup, onSelect, onConnect, onDisconnect, onRequestDelete, onAddHere, onOpenStat } = props;
  const rf = useReactFlow<OutreachRFNode, OutreachRFEdge>();
  const [nodes, setNodes] = useState<OutreachRFNode[]>([]);
  const [edges, setEdges] = useState<OutreachRFEdge[]>([]);
  const edgesRef = useRef<OutreachRFEdge[]>([]);
  edgesRef.current = edges;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const openStat = useEvent((nodeId: string, kind: StatKind) => onOpenStat?.(nodeId, kind));
  const hasStatHandler = !!onOpenStat;
  const addHere = useEvent<AddHere>((source, handle, target) => onAddHere?.(source, handle, target));
  const hasAddHandler = !!onAddHere;
  useEffect(() => {
    setNodes((prev) => deriveNodes(graph, { stats, issues, selectedId, readOnly, lookup, onStat: hasStatHandler ? openStat : undefined, onAdd: hasAddHandler ? addHere : undefined }, prev));
  }, [graph, stats, issues, selectedId, readOnly, lookup, hasStatHandler, openStat, hasAddHandler, addHere]);
  useEffect(() => {
    setEdges((prev) => { const next = deriveEdges(graph, readOnly, hasAddHandler ? addHere : undefined); return sameEdges(prev, next) ? prev : next; });
  }, [graph, readOnly, hasAddHandler, addHere]);

  const select = useEvent((id: string | null) => onSelect(id));
  useImperativeHandle(ref, () => ({
    focusNode: (id) => { select(id); rf.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.1, padding: 0.6 }); },
    fitView: () => { rf.fitView({ duration: 300, padding: 0.2 }); },
  }), [rf, select]);

  const onNodesChange = useEvent((changes: NodeChange<OutreachRFNode>[]) => {
    const removes = changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id);
    const rest = changes.filter((c) => c.type !== 'remove');
    if (rest.length) setNodes((ns) => applyNodeChanges(rest, ns));
    if (removes.length && !readOnly) onRequestDelete(removes);
  });

  const onEdgesChange = useEvent((changes: EdgeChange<OutreachRFEdge>[]) => {
    const removes = changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id);
    const rest = changes.filter((c) => c.type !== 'remove');
    if (rest.length) setEdges((es) => applyEdgeChanges(rest, es));
    if (readOnly) return;
    for (const id of removes) {
      const e = edgesRef.current.find((x) => x.id === id);
      if (e) onDisconnect(e.source, e.data?.handle ?? e.sourceHandle ?? 'next');
    }
  });

  const handleConnect = useEvent((c: Connection) => {
    if (readOnly || !c.source || !c.target || c.source === c.target) return;
    onConnect(c.source, c.sourceHandle ?? 'next', c.target);
  });

  const isValidConnection = useEvent<IsValidConnection<OutreachRFEdge>>((c) => !!c.source && !!c.target && c.source !== c.target && c.target !== graph.start);

  // Node deletion may need a confirmation (in-flight leads), so take it over from React Flow: returning false
  // stops the built-in removal (which would also drop the node's edges before the user has decided).
  const onBeforeDelete = useEvent(async ({ nodes: delNodes }: { nodes: OutreachRFNode[]; edges: OutreachRFEdge[] }) => {
    if (readOnly) return false;
    if (delNodes.length > 0) { onRequestDelete(delNodes.map((n) => n.id)); return false; }
    return true; // pure edge deletion → handled by onEdgesChange remove
  });

  const onSelectionChange = useEvent(({ nodes: sel }: OnSelectionChangeParams<OutreachRFNode, OutreachRFEdge>) => {
    const id = sel[0]?.id ?? null;
    if (id !== selectedIdRef.current) onSelect(id);
  });

  return (
    <div className={cn('h-full w-full', props.className)}>
      <ReactFlow<OutreachRFNode, OutreachRFEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        onBeforeDelete={onBeforeDelete}
        onSelectionChange={onSelectionChange}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.15}
        maxZoom={1.75}
        deleteKeyCode={readOnly ? null : DELETE_KEYS}
        nodesDraggable={false}
        nodesConnectable={!readOnly}
        elementsSelectable
        selectNodesOnDrag={false}
        proOptions={PRO_OPTIONS}
        className="bg-gray-50"
      >
        <Background gap={20} size={1} color="#e5e7eb" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="bottom-right" nodeStrokeWidth={2} className={MINIMAP_CLS} nodeColor={minimapNodeColor} />
      </ReactFlow>
    </div>
  );
});

const Canvas = forwardRef<CanvasHandle, CanvasProps>(function Canvas(props, ref) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} ref={ref} />
    </ReactFlowProvider>
  );
});

export default Canvas;
