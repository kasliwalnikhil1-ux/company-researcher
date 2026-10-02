'use client';

import { Undo2 } from 'lucide-react';
import type { PendingUndo } from './useCardActions';

/** "Skipped. Undo": one row per action that has not reached the server yet. It goes away by itself after 5 seconds. */
export default function UndoBar({ pending, onUndo }: { pending: PendingUndo[]; onUndo: (id: number) => void }) {
  if (pending.length === 0) return null;
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-1.5">
      {pending.map((p) => (
        <div key={p.id} className="inline-flex items-center gap-3 rounded-lg bg-gray-900 text-white text-sm pl-4 pr-2 py-1.5 shadow-lg max-w-full">
          <span className="truncate">{p.label}.</span>
          <button type="button" onClick={() => onUndo(p.id)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-indigo-200 hover:text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">
            <Undo2 className="w-3.5 h-3.5" aria-hidden="true" /> Undo
          </button>
        </div>
      ))}
    </div>
  );
}
