'use client';

import { useMemo } from 'react';
import { ReactFlow, ReactFlowProvider, Background, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Graph } from '@/lib/outreach/types';
import { deriveEdges, deriveNodes, nodeTypes, type OutreachRFNode } from './Canvas';
import type { Lookup } from './helpers';
import { cn } from '@/lib/utils';

/** Read-only, non-interactive rendering of a graph (used for version previews). */
export default function MiniCanvas({ graph, lookup = {}, className }: { graph: Graph; lookup?: Lookup; className?: string }) {
  const nodes = useMemo<OutreachRFNode[]>(() => deriveNodes(graph, { stats: {}, issues: {}, selectedId: null, readOnly: true, lookup }, []), [graph, lookup]);
  const edges = useMemo<Edge[]>(() => deriveEdges(graph, true), [graph]);
  return (
    <div className={cn('h-full w-full', className)}>
      <ReactFlowProvider>
        <ReactFlow<OutreachRFNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.1}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll
          panOnDrag
          proOptions={{ hideAttribution: true }}
          className="bg-gray-50"
        >
          <Background gap={20} size={1} color="#e5e7eb" />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
