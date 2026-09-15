'use client';

import { useMemo, useState, type DragEvent } from 'react';
import { Search, X, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NodeType } from '@/lib/outreach/types';
import { NODE_CATALOG, NODE_GROUPS } from '@/lib/outreach/nodes';

export default function NodePalette({ onAdd, readOnly, onClose, className }: { onAdd: (type: NodeType) => void; readOnly: boolean; onClose?: () => void; className?: string }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return NODE_GROUPS.map((g) => ({
      group: g,
      items: Object.values(NODE_CATALOG).filter((m) => m.group === g && m.type !== 'start' && (!needle || m.label.toLowerCase().includes(needle) || m.description.toLowerCase().includes(needle) || m.type.includes(needle))),
    })).filter((g) => g.items.length > 0);
  }, [q]);

  const onDragStart = (e: DragEvent, type: NodeType) => {
    e.dataTransfer.setData('application/outreach-node', type);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <aside className={cn('flex flex-col bg-white border-r border-gray-200 h-full', className)} aria-label="Node palette">
      <div className="p-3 border-b border-gray-100 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-2.5" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search steps" aria-label="Search steps" className="w-full pl-8 pr-2 py-2 text-sm rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        {onClose && <button onClick={onClose} className="md:hidden p-1.5 rounded-md hover:bg-gray-100 text-gray-500" aria-label="Close palette"><X className="w-4 h-4" /></button>}
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {readOnly && <p className="text-xs text-gray-500 px-2 pt-1">Read-only: you do not have permission to edit this sequence.</p>}
        {groups.length === 0 && <p className="text-xs text-gray-500 px-2 py-4 text-center">No steps match “{q}”.</p>}
        {groups.map((g) => (
          <div key={g.group}>
            <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{g.group}</div>
            <div className="space-y-1">
              {g.items.map((m) => (
                <div
                  key={m.type}
                  role="button"
                  tabIndex={readOnly ? -1 : 0}
                  draggable={!readOnly}
                  onDragStart={(e) => onDragStart(e, m.type)}
                  onClick={() => { if (!readOnly) onAdd(m.type); }}
                  onKeyDown={(e) => { if (!readOnly && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onAdd(m.type); } }}
                  title={readOnly ? m.description : `${m.description}\nClick to add, or drag onto the canvas`}
                  className={cn('group flex items-start gap-2 px-2 py-1.5 rounded-lg border border-transparent', readOnly ? 'opacity-60 cursor-default' : 'cursor-grab hover:bg-gray-50 hover:border-gray-200 active:cursor-grabbing')}
                >
                  <span className={cn('mt-1 w-2.5 h-2.5 rounded-full flex-shrink-0', m.color)} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-gray-800 leading-5">{m.label}</span>
                    <span className="block text-[11px] text-gray-500 leading-4 truncate">{m.description}</span>
                  </span>
                  {!readOnly && <Plus className="w-4 h-4 text-gray-300 group-hover:text-indigo-500 mt-0.5 flex-shrink-0" />}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
