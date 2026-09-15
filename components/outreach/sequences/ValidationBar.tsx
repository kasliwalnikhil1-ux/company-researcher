'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GraphIssue } from '@/lib/outreach/graph';
import type { Graph } from '@/lib/outreach/types';
import { nodeTitle } from './helpers';

export default function ValidationBar({ errors, warnings, graph, onFocus }: { errors: GraphIssue[]; warnings: GraphIssue[]; graph: Graph; onFocus: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const total = errors.length + warnings.length;
  const clean = total === 0;
  return (
    <div className="border-t border-gray-200 bg-white text-xs">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-3 px-3 py-1.5 text-left hover:bg-gray-50" aria-expanded={open}>
        {clean ? (
          <span className="inline-flex items-center gap-1 text-green-700"><CheckCircle2 className="w-3.5 h-3.5" /> Graph is valid</span>
        ) : (
          <>
            {errors.length > 0 && <span className="inline-flex items-center gap-1 text-red-700 font-medium"><XCircle className="w-3.5 h-3.5" /> {errors.length} error{errors.length === 1 ? '' : 's'}</span>}
            {warnings.length > 0 && <span className="inline-flex items-center gap-1 text-amber-700 font-medium"><AlertTriangle className="w-3.5 h-3.5" /> {warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
            {!open && <span className="text-gray-500 truncate hidden sm:inline">— {(errors[0] ?? warnings[0]).message}</span>}
          </>
        )}
        <span className="ml-auto text-gray-400">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}</span>
      </button>
      {open && !clean && (
        <ul className="max-h-40 overflow-y-auto border-t border-gray-100 divide-y divide-gray-50">
          {[...errors.map((i) => ({ ...i, level: 'error' as const })), ...warnings.map((i) => ({ ...i, level: 'warning' as const }))].map((i, idx) => (
            <li key={idx}>
              <button
                type="button"
                disabled={!i.node_id}
                onClick={() => i.node_id && onFocus(i.node_id)}
                className={cn('w-full text-left px-3 py-1.5 flex items-start gap-2', i.node_id ? 'hover:bg-gray-50' : 'cursor-default')}
              >
                {i.level === 'error' ? <XCircle className="w-3.5 h-3.5 text-red-500 mt-0.5 flex-shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />}
                <span className="text-gray-700">
                  {i.node_id && <span className="font-medium text-gray-900">{nodeTitle(graph.nodes[i.node_id])}: </span>}
                  {i.message}
                  <span className="text-gray-400 ml-1">({i.code})</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
