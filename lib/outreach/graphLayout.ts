// Sequence graph layout and copy helpers. Pure (no data access), so the builder and the product-tour seed share them.
import type { Graph, GraphNode } from './types';
import { NODE_CATALOG, nodeExits } from './nodes';

export const NODE_W = 240;
/** Tree layout: one column per branch, one row per step (HeyReach-style, top to bottom). */
export const COL_W = NODE_W + 72;
export const ROW_H = 200;

export function usesNext(n: GraphNode): boolean {
  return nodeExits(n).length === 1 && !NODE_CATALOG[n.type]?.dynamicExits;
}

export function cloneGraph(g: Graph): Graph {
  return JSON.parse(JSON.stringify(g)) as Graph;
}

// ---------------------------------------------------------------------------
// Layout: a top-to-bottom tree (start at the top, every branch fans out below its step)
// ---------------------------------------------------------------------------
/** Steps this one leads to, in exit order, each once. */
function childrenOf(n: GraphNode): string[] {
  const out: string[] = [];
  const push = (t: string | null | undefined) => { if (t && !out.includes(t)) out.push(t); };
  if (usesNext(n)) push(n.next);
  else for (const e of nodeExits(n)) push(n.branches && e in n.branches ? n.branches[e] : e === 'next' ? n.next : null);
  return out;
}

/**
 * Where every step sits. Columns come from a depth-first walk (each step is centred over the steps under it,
 * branches side by side in exit order), rows from the longest path down from the start, so a step two branches
 * join into sits below both. Steps not reachable from the start line up in a row at the bottom.
 */
export function layoutPositions(g: Graph): Record<string, { x: number; y: number }> {
  const nodes = g.nodes;
  const kids = new Map<string, string[]>();
  const treeDepth = new Map<string, number>();
  const visit = (id: string, d: number) => {
    treeDepth.set(id, d);
    const own: string[] = [];
    for (const c of childrenOf(nodes[id])) if (nodes[c] && !treeDepth.has(c)) { own.push(c); visit(c, d + 1); }
    kids.set(id, own);
  };
  if (nodes[g.start]) visit(g.start, 0);

  // rows: longest path from the start; steps caught in a loop keep their walk depth
  const reach = Array.from(treeDepth.keys());
  const indeg = new Map<string, number>(reach.map((id) => [id, 0]));
  for (const u of reach) for (const v of childrenOf(nodes[u])) if (indeg.has(v)) indeg.set(v, (indeg.get(v) ?? 0) + 1);
  const depth = new Map<string, number>();
  const queue = reach.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (const id of queue) depth.set(id, treeDepth.get(id) ?? 0);
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of childrenOf(nodes[u])) {
      if (!indeg.has(v)) continue;
      depth.set(v, Math.max(depth.get(v) ?? 0, (depth.get(u) ?? 0) + 1));
      indeg.set(v, (indeg.get(v) ?? 0) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  for (const id of reach) if (!depth.has(id)) depth.set(id, treeDepth.get(id) ?? 0);

  // columns: a step is as wide as everything under it
  const width = new Map<string, number>();
  const measure = (id: string): number => {
    const w = Math.max(1, (kids.get(id) ?? []).reduce((s, c) => s + measure(c), 0));
    width.set(id, w);
    return w;
  };
  if (nodes[g.start]) measure(g.start);

  const pos: Record<string, { x: number; y: number }> = {};
  const place = (id: string, left: number) => {
    const w = width.get(id) ?? 1;
    pos[id] = { x: Math.round(left + (w * COL_W) / 2 - NODE_W / 2), y: (depth.get(id) ?? 0) * ROW_H };
    let cursor = left;
    for (const c of kids.get(id) ?? []) { place(c, cursor); cursor += (width.get(c) ?? 1) * COL_W; }
  };
  if (nodes[g.start]) place(g.start, 0);

  let maxDepth = 0;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
  const loose = Object.keys(nodes).filter((id) => !pos[id]).sort();
  loose.forEach((id, i) => { pos[id] = { x: i * COL_W, y: (maxDepth + 2) * ROW_H }; });
  return pos;
}

/** Store the tree layout in the graph (positions travel with the saved draft). */
export function autoLayout(g: Graph): Graph {
  const pos = layoutPositions(g);
  const next = cloneGraph(g);
  for (const [id, p] of Object.entries(pos)) if (next.nodes[id]) next.nodes[id].position = p;
  return next;
}
