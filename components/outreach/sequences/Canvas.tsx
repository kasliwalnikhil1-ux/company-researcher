'use client';

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState, type DragEvent } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, useReactFlow, MarkerType, applyNodeChanges, applyEdgeChanges,
  type Node, type Edge, type Connection, type NodeProps, type NodeChange, type EdgeChange, type NodeTypes, type OnSelectionChangeParams, type IsValidConnection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Clock, Hand } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Graph, GraphNode, NodeStats, NodeType } from '@/lib/outreach/types';
import { NODE_CATALOG } from '@/lib/outreach/nodes';
import { formatDelay, nodeSummary, NODE_W, type Lookup } from './helpers';

export type IssueLevel = 'error' | 'warning';
export type OutreachNodeData = { node: GraphNode; summary: string; stats: NodeStats | null; issue: IssueLevel | null };
export type OutreachRFNode = Node<OutreachNodeData, 'outreach'>;

const STAT_CHIPS: Array<{ key: keyof NodeStats; label: string; cls: string }> = [
  { key: 'queued', label: 'queued', cls: 'bg-gray-100 text-gray-700' },
  { key: 'sent', label: 'sent', cls: 'bg-blue-100 text-blue-800' },
  { key: 'accepted', label: 'accepted', cls: 'bg-green-100 text-green-800' },
  { key: 'replied', label: 'replied', cls: 'bg-purple-100 text-purple-800' },
  { key: 'failed', label: 'failed', cls: 'bg-red-100 text-red-800' },
];

const HANDLE_CLS = '!w-3 !h-3 !border-2 !border-white';

export const OutreachNode = memo(function OutreachNode({ data, selected }: NodeProps<OutreachRFNode>) {
  const { node, summary, stats, issue } = data;
  const meta = NODE_CATALOG[node.type];
  const exits = meta.exits;
  const hasDelay = !!node.delay && node.delay.amount > 0;
  return (
    <div
      className={cn(
        'rounded-xl border bg-white shadow-sm text-left transition-shadow',
        selected ? 'border-indigo-500 ring-2 ring-indigo-200 shadow-md' : issue === 'error' ? 'border-red-400' : issue === 'warning' ? 'border-amber-400' : 'border-gray-200',
      )}
      style={{ width: NODE_W }}
    >
      {node.type !== 'start' && <Handle type="target" position={Position.Left} className={cn(HANDLE_CLS, '!bg-gray-400')} />}
      <div className={cn('px-3 py-1.5 rounded-t-xl text-white text-xs font-semibold flex items-center justify-between gap-2', meta.color)}>
        <span className="truncate">{node.label || meta.label}</span>
        <span className="flex items-center gap-1 flex-shrink-0">
          {hasDelay && <span title={`Waits ${formatDelay(node.delay)} before this step`} className="inline-flex items-center gap-0.5 text-[10px] bg-white/25 rounded px-1"><Clock className="w-3 h-3" />{formatDelay(node.delay)}</span>}
          {node.mode === 'manual' && <span title="Manual: creates a task and waits for completion" className="inline-flex items-center gap-0.5 text-[10px] bg-white/25 rounded px-1"><Hand className="w-3 h-3" />manual</span>}
        </span>
      </div>
      <div className="px-3 py-2 text-xs text-gray-600 min-h-[34px] break-words">{summary || <span className="text-gray-400">{meta.description}</span>}</div>
      {stats && STAT_CHIPS.some((c) => (stats[c.key] as number) > 0) && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {STAT_CHIPS.filter((c) => (stats[c.key] as number) > 0).map((c) => (
            <span key={c.key} className={cn('text-[10px] font-medium rounded-full px-1.5 py-0.5 tabular-nums', c.cls)}>{stats[c.key] as number} {c.label}</span>
          ))}
        </div>
      )}
      {exits.length === 1 && <Handle type="source" position={Position.Right} id={exits[0]} className={cn(HANDLE_CLS, '!bg-indigo-500')} />}
      {exits.length > 1 && (
        <div className="border-t border-gray-100 py-1">
          {exits.map((e) => (
            <div key={e} className="relative px-3 py-0.5 text-[11px] text-gray-500 text-right leading-4">
              {e.replace(/_/g, ' ')}
              <Handle type="source" position={Position.Right} id={e} className={cn(HANDLE_CLS, e === 'error' || e === 'bounced' || e === 'no_credit' || e === 'no_email' ? '!bg-red-400' : e === 'false' || e === 'no_connect' ? '!bg-amber-400' : '!bg-indigo-500')} style={{ top: '50%' }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export const nodeTypes: NodeTypes = { outreach: OutreachNode };

export function deriveEdges(graph: Graph, readOnly: boolean): Edge[] {
  const edges: Edge[] = [];
  for (const n of Object.values(graph.nodes)) {
    const exits = NODE_CATALOG[n.type]?.exits ?? [];
    if (exits.length === 1 && n.next && graph.nodes[n.next]) {
      edges.push({ id: `${n.id}::${exits[0]}::${n.next}`, source: n.id, sourceHandle: exits[0], target: n.next, type: 'smoothstep', deletable: !readOnly, data: { handle: exits[0] }, markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: '#6366f1' }, style: { stroke: '#6366f1', strokeWidth: 1.5 } });
    } else if (exits.length > 1) {
      for (const [b, t] of Object.entries(n.branches ?? {})) {
        if (!t || !graph.nodes[t] || !exits.includes(b)) continue;
        const negative = ['false', 'no_connect', 'error', 'bounced', 'no_credit', 'no_email'].includes(b);
        const color = negative ? '#f59e0b' : '#6366f1';
        edges.push({ id: `${n.id}::${b}::${t}`, source: n.id, sourceHandle: b, target: t, type: 'smoothstep', label: b.replace(/_/g, ' '), labelStyle: { fontSize: 10, fill: '#6b7280' }, labelBgStyle: { fill: '#fff' }, labelBgPadding: [4, 2], deletable: !readOnly, data: { handle: b }, markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color }, style: { stroke: color, strokeWidth: 1.5 } });
      }
    }
  }
  return edges;
}

/** Edges are fully derived from the graph, so identity only has to change when the wiring does. */
function sameEdges(a: Edge[], b: Edge[]): boolean {
  return a.length === b.length && a.every((e, i) => e.id === b[i].id && e.deletable === b[i].deletable);
}

export function deriveNodes(graph: Graph, opts: { stats: Record<string, NodeStats>; issues: Record<string, IssueLevel>; selectedId: string | null; readOnly: boolean; lookup: Lookup }, prev: OutreachRFNode[]): OutreachRFNode[] {
  const prevMap = new Map(prev.map((n) => [n.id, n]));
  return Object.values(graph.nodes).map((gn) => {
    const old = prevMap.get(gn.id);
    const position = old?.dragging ? old.position : gn.position;
    return {
      id: gn.id,
      type: 'outreach',
      position,
      dragging: old?.dragging,
      measured: old?.measured,
      selected: gn.id === opts.selectedId,
      deletable: gn.type !== 'start' && !opts.readOnly,
      draggable: !opts.readOnly,
      connectable: !opts.readOnly,
      data: { node: gn, summary: nodeSummary(gn, opts.lookup, graph.nodes), stats: opts.stats[gn.id] ?? null, issue: opts.issues[gn.id] ?? null },
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
const SNAP_GRID: [number, number] = [20, 20];
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
  centerPosition: () => { x: number; y: number };
}

export interface CanvasProps {
  graph: Graph;
  stats: Record<string, NodeStats>;
  issues: Record<string, IssueLevel>;
  selectedId: string | null;
  readOnly: boolean;
  lookup: Lookup;
  onSelect: (id: string | null) => void;
  onMoveNodes: (positions: Record<string, { x: number; y: number }>) => void;
  onConnect: (source: string, handle: string, target: string) => void;
  onDisconnect: (source: string, handle: string) => void;
  onRequestDelete: (ids: string[]) => void;
  onAddNode: (type: NodeType, position: { x: number; y: number }) => void;
  className?: string;
}

const CanvasInner = forwardRef<CanvasHandle, CanvasProps>(function CanvasInner(props, ref) {
  const { graph, stats, issues, selectedId, readOnly, lookup, onSelect, onMoveNodes, onConnect, onDisconnect, onRequestDelete, onAddNode } = props;
  const rf = useReactFlow<OutreachRFNode, Edge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<OutreachRFNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  edgesRef.current = edges;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => { setNodes((prev) => deriveNodes(graph, { stats, issues, selectedId, readOnly, lookup }, prev)); }, [graph, stats, issues, selectedId, readOnly, lookup]);
  useEffect(() => { setEdges((prev) => { const next = deriveEdges(graph, readOnly); return sameEdges(prev, next) ? prev : next; }); }, [graph, readOnly]);

  const select = useEvent((id: string | null) => onSelect(id));
  useImperativeHandle(ref, () => ({
    focusNode: (id) => { select(id); rf.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.1, padding: 0.6 }); },
    fitView: () => { rf.fitView({ duration: 300, padding: 0.2 }); },
    centerPosition: () => {
      const r = wrapper.current?.getBoundingClientRect();
      if (!r) return { x: 200, y: 200 };
      const p = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      return { x: p.x - NODE_W / 2, y: p.y - 40 };
    },
  }), [rf, select]);

  const onNodesChange = useEvent((changes: NodeChange<OutreachRFNode>[]) => {
    const removes = changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id);
    const rest = changes.filter((c) => c.type !== 'remove');
    if (rest.length) setNodes((ns) => applyNodeChanges(rest, ns));
    if (removes.length && !readOnly) onRequestDelete(removes);
  });

  const onEdgesChange = useEvent((changes: EdgeChange<Edge>[]) => {
    const removes = changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id);
    const rest = changes.filter((c) => c.type !== 'remove');
    if (rest.length) setEdges((es) => applyEdgeChanges(rest, es));
    if (readOnly) return;
    for (const id of removes) {
      const e = edgesRef.current.find((x) => x.id === id);
      if (e) onDisconnect(e.source, (e.data?.handle as string) ?? e.sourceHandle ?? 'next');
    }
  });

  const handleConnect = useEvent((c: Connection) => {
    if (readOnly || !c.source || !c.target || c.source === c.target) return;
    onConnect(c.source, c.sourceHandle ?? 'next', c.target);
  });

  const isValidConnection = useEvent<IsValidConnection<Edge>>((c) => !!c.source && !!c.target && c.source !== c.target && c.target !== graph.start);

  // Node deletion may need a confirmation (in-flight enrollments), so take it over from React Flow: returning false
  // stops the built-in removal (which would also drop the node's edges before the user has decided).
  const onBeforeDelete = useEvent(async ({ nodes: delNodes }: { nodes: OutreachRFNode[]; edges: Edge[] }) => {
    if (readOnly) return false;
    if (delNodes.length > 0) { onRequestDelete(delNodes.map((n) => n.id)); return false; }
    return true; // pure edge deletion → handled by onEdgesChange remove
  });

  const onSelectionChange = useEvent(({ nodes: sel }: OnSelectionChangeParams<OutreachRFNode, Edge>) => {
    const id = sel[0]?.id ?? null;
    if (id !== selectedIdRef.current) onSelect(id);
  });

  const onNodeDragStop = useEvent((_e: unknown, _node: OutreachRFNode, dragged: OutreachRFNode[]) => {
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of dragged.length ? dragged : [_node]) positions[n.id] = n.position;
    onMoveNodes(positions);
  });

  const onDragOver = useEvent((e: DragEvent) => { if (readOnly) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  const onDrop = useEvent((e: DragEvent) => {
    if (readOnly) return;
    e.preventDefault();
    const type = e.dataTransfer.getData('application/outreach-node') as NodeType;
    if (!type || !NODE_CATALOG[type]) return;
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    onAddNode(type, { x: p.x - NODE_W / 2, y: p.y - 20 });
  });

  return (
    <div ref={wrapper} className={cn('h-full w-full', props.className)} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow<OutreachRFNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        onBeforeDelete={onBeforeDelete}
        onSelectionChange={onSelectionChange}
        onNodeDragStop={onNodeDragStop}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.15}
        maxZoom={1.75}
        snapToGrid
        snapGrid={SNAP_GRID}
        deleteKeyCode={readOnly ? null : DELETE_KEYS}
        nodesDraggable={!readOnly}
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