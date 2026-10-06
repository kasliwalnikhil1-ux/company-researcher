'use client';

import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from 'lucide-react';
import type { StageDef } from '@/lib/outreach/aiReplies';
import { cn } from '@/lib/utils';
import { useAutoGrowTextarea } from '@/components/outreach/ui';
import { MAX_STAGES, slugKey } from './promptModel';

/** A key made from the name that no other stage uses (keys are never shown; past chats refer to saved ones). */
function uniqueKey(label: string, taken: Set<string>): string {
  let base = slugKey(label);
  if (base.length === 1) base = `${base}_stage`;
  taken.add('closing');   // reserved for the built-in last stage
  if (!base || !taken.has(base)) return base;
  for (let n = 2; ; n++) { const k = `${base.slice(0, 27)}_${n}`; if (!taken.has(k)) return k; }
}

/**
 * The conversation stages the engine keeps track of (PRD §8.4): one line per stage, click to edit. A stage's early / pitch
 * flags are kept as saved but not shown or edited here (new stages are plain).
 * Keys of stages that already exist in the saved prompt are locked; a new stage's key follows its name.
 */
export default function StageTable({ stages, lockedKeys, disabled, onChange }: {
  stages: StageDef[];
  lockedKeys: Set<string>;
  disabled?: boolean;
  onChange: (next: StageDef[]) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const set = (i: number, patch: Partial<StageDef>) => onChange(stages.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= stages.length) return;
    const next = [...stages];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setOpen(j);
  };
  const onLabel = (i: number, label: string) => {
    const s = stages[i];
    if (lockedKeys.has(s.key)) { set(i, { label }); return; }
    const taken = new Set(stages.filter((_, k) => k !== i).map((x) => x.key));
    set(i, { label, key: uniqueKey(label, taken) });
  };
  const add = () => {
    onChange([...stages, { key: '', label: '', instructions: '', early: false, pitch: false }]);
    setOpen(stages.length);
  };
  const remove = (i: number) => { onChange(stages.filter((_, k) => k !== i)); setOpen(null); };

  return (
    <div className="space-y-2">
      <ol className="rounded-lg border border-gray-200 divide-y divide-gray-100 bg-white">
        {stages.map((s, i) => {
          const n = i + 1;
          const isOpen = open === i;
          return (
            <li key={i}>
              <button type="button" onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50">
                <span className="w-5 text-xs font-medium text-gray-400 tabular-nums">{n}</span>
                <span className={cn('text-sm font-medium', s.label ? 'text-gray-900' : 'text-gray-400')}>{s.label || 'New stage'}</span>
                <span className="flex-1 min-w-0 truncate text-xs text-gray-500">{isOpen ? '' : s.instructions?.trim()}</span>
                <ChevronDown className={cn('w-4 h-4 text-gray-400 flex-shrink-0 transition-transform', isOpen && 'rotate-180')} aria-hidden="true" />
              </button>

              {isOpen && (
                <div className="px-3 pb-3 pl-11 space-y-2.5">
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-600 mb-1">Name</span>
                    <input value={s.label} disabled={disabled} maxLength={40} autoFocus={!s.label} onChange={(e) => onLabel(i, e.target.value)}
                      className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50" />
                  </label>
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-600 mb-1">What to do in this stage</span>
                    <GrowingText value={s.instructions ?? ''} disabled={disabled} onChange={(v) => set(i, { instructions: v })} />
                  </label>
                  {!disabled && (
                    <div className="flex items-center gap-1 text-xs">
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="inline-flex items-center gap-1 px-2 py-1 rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30"><ArrowUp className="w-3.5 h-3.5" />Move up</button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === stages.length - 1} className="inline-flex items-center gap-1 px-2 py-1 rounded text-gray-600 hover:bg-gray-100 disabled:opacity-30"><ArrowDown className="w-3.5 h-3.5" />Move down</button>
                      <button type="button" onClick={() => remove(i)} disabled={stages.length <= 1} className="inline-flex items-center gap-1 px-2 py-1 rounded text-gray-500 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 ml-auto"><Trash2 className="w-3.5 h-3.5" />Remove</button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        {!disabled && stages.length < MAX_STAGES && (
          <button type="button" onClick={add} className="inline-flex items-center gap-1 text-sm font-medium text-indigo-700 hover:underline"><Plus className="w-4 h-4" />Add stage</button>
        )}
        <span className="text-xs text-gray-500">&ldquo;Closing&rdquo; is always available as the last stage.</span>
      </div>
    </div>
  );
}

function GrowingText({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrowTextarea(ref, value);
  return (
    <textarea ref={ref} value={value} disabled={disabled} rows={3} onChange={(e) => onChange(e.target.value)}
      placeholder="e.g. Respond to what they said. Ask one question about their situation. No pitch, no link, no prices."
      className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white resize-none overflow-hidden focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50" />
  );
}
