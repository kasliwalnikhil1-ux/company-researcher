'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Crosshair, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { humanizeIssue, type GraphIssue } from '@/lib/outreach/graph';
import type { Graph } from '@/lib/outreach/types';
import { nodeTitle } from './helpers';

/**
 * The strip under the canvas that says what still needs fixing. Every item names the step in plain words and has a
 * "Show me" button that zooms the canvas onto it.
 */
export default function ValidationBar({ errors, warnings, graph, onFocus }: { errors: GraphIssue[]; warnings: GraphIssue[]; graph: Graph; onFocus: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const total = errors.length + warnings.length;
  const clean = total === 0;
  const first = errors[0] ?? warnings[0];
  const items = [...errors.map((i) => ({ ...i, level: 'error' as const })), ...warnings.map((i) => ({ ...i, level: 'warning' as const }))];
  return (
    <div className="border-t border-gray-200 bg-white text-xs">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-3 px-3 py-1.5 text-left hover:bg-gray-50" aria-expanded={open}>
        {clean ? (
          <span className="inline-flex items-center gap-1 text-green-700"><CheckCircle2 className="w-3.5 h-3.5" /> Everything looks good</span>
        ) : (
          <>
            {errors.length > 0 && <span className="inline-flex items-center gap-1 text-red-700 font-medium"><XCircle className="w-3.5 h-3.5" /> {errors.length} thing{errors.length === 1 ? '' : 's'} to fix</span>}
            {warnings.length > 0 && <span className="inline-flex items-center gap-1 text-amber-700 font-medium"><AlertTriangle className="w-3.5 h-3.5" /> {warnings.length} suggestion{warnings.length === 1 ? '' : 's'}</span>}
            {!open && first && (
              <span className="text-gray-500 truncate hidden sm:inline">
                — {first.node_id && <span className="font-medium text-gray-700">{nodeTitle(graph.nodes[first.node_id])}: </span>}{humanizeIssue(first.message)}
              </span>
            )}
          </>
        )}
        <span className="ml-auto text-gray-400">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}</span>
      </button>
      {open && !clean && (
        <ul className="max-h-48 overflow-y-auto border-t border-gray-100 divide-y divide-gray-50">
          {items.map((i, idx) => {
            const step = i.node_id ? graph.nodes[i.node_id] : null;
            return (
              <li key={idx} className="flex items-start gap-2 px-3 py-1.5">
                {i.level === 'error' ? <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />}
                <span className="text-gray-700 flex-1 min-w-0">
                  {step && <span className="font-medium text-gray-900">{nodeTitle(step)}: </span>}
                  {humanizeIssue(i.message)}
                </span>
                {i.node_id && step && (
                  <button
                    type="button"
                    onClick={() => onFocus(i.node_id!)}
                    className={cn('flex-shrink-0 inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-50 hover:border-indigo-300')}
                    title={`Zoom to “${nodeTitle(step)}”`}
                  >
                    <Crosshair className="w-3 h-3" /> Show me
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
