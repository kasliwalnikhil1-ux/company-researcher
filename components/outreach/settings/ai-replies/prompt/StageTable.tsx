'use client';

import { ArrowDown, ArrowUp, Lock, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/outreach/ui';
import type { StageDef } from '@/lib/outreach/aiReplies';
import { MAX_STAGES, slugKey } from './promptModel';

/**
 * The conversation stages the engine keeps track of (PRD §8.4). Keys of stages that already exist in the saved
 * prompt are locked: past runs and chats refer to them.
 */
export default function StageTable({ stages, lockedKeys, disabled, onChange }: {
  stages: StageDef[];
  lockedKeys: Set<string>;
  disabled?: boolean;
  onChange: (next: StageDef[]) => void;
}) {
  const set = (i: number, patch: Partial<StageDef>) => onChange(stages.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= stages.length) return;
    const next = [...stages];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const onLabel = (i: number, label: string) => {
    const s = stages[i];
    const locked = lockedKeys.has(s.key);
    // a new stage's key follows its name until someone edits the key by hand
    const follow = !locked && (s.key === '' || s.key === slugKey(s.label));
    set(i, follow ? { label, key: slugKey(label) } : { label });
  };

  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {stages.map((s, i) => {
          const locked = lockedKeys.has(s.key);
          const n = i + 1;
          return (
            <li key={i} className="rounded-lg border border-gray-200 p-3 space-y-2">
              <div className="flex flex-wrap items-end gap-2">
                <span className="text-xs font-semibold text-gray-500 w-14 pb-2">Stage {n}</span>
                <label className="flex-1 min-w-[140px]">
                  <span className="block text-xs font-medium text-gray-600 mb-1">Name</span>
                  <input value={s.label} disabled={disabled} maxLength={40} onChange={(e) => onLabel(i, e.target.value)} aria-label={`Stage ${n} name`}
                    className="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50" />
                </label>
                <label className="w-44">
                  <span className="flex items-center gap-1 text-xs font-medium text-gray-600 mb-1">Key {locked && <Lock className="w-3 h-3" aria-label="Locked" />}</span>
                  <input value={s.key} disabled={disabled || locked} maxLength={30} aria-label={`Stage ${n} key`}
                    title={locked ? 'Saved stages keep their key. Past chats refer to it.' : 'Lowercase letters, digits and underscores'}
                    onChange={(e) => set(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
                    className="w-full px-3 py-1.5 text-sm font-mono rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 disabled:text-gray-500" />
                </label>
                <label className="flex items-center gap-1.5 text-sm text-gray-700 pb-2" title="Early stages: no pitch, vary the approach, one question at most">
                  <input type="checkbox" checked={!!s.early} disabled={disabled} onChange={(e) => set(i, { early: e.target.checked })} className="rounded border-gray-300" />
                  Early
                </label>
                <label className="flex items-center gap-1.5 text-sm text-gray-700 pb-2" title="The stage where the AI explains how you help">
                  <input type="checkbox" checked={!!s.pitch} disabled={disabled} onChange={(e) => set(i, { pitch: e.target.checked })} className="rounded border-gray-300" />
                  Pitch
                </label>
                {!disabled && (
                  <div className="flex items-center gap-0.5 pb-1 ml-auto">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move stage ${n} up`} className="p-1.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30"><ArrowUp className="w-4 h-4" /></button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === stages.length - 1} aria-label={`Move stage ${n} down`} className="p-1.5 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30"><ArrowDown className="w-4 h-4" /></button>
                    <button type="button" onClick={() => onChange(stages.filter((_, k) => k !== i))} disabled={stages.length <= 1} aria-label={`Remove stage ${n}`} className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30"><Trash2 className="w-4 h-4" /></button>
                  </div>
                )}
              </div>
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 mb-1">What to do in this stage</span>
                <textarea value={s.instructions ?? ''} disabled={disabled} rows={3} onChange={(e) => set(i, { instructions: e.target.value })} aria-label={`Stage ${n} instructions`}
                  placeholder="e.g. Respond to what they said. Ask one question about their situation. No pitch, no link, no prices."
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50" />
              </label>
            </li>
          );
        })}
      </ol>
      {!disabled && (
        <div className="flex items-center gap-3">
          <Button type="button" size="sm" variant="secondary" disabled={stages.length >= MAX_STAGES}
            onClick={() => onChange([...stages, { key: '', label: '', instructions: '', early: false, pitch: false }])}>
            <Plus className="w-3.5 h-3.5" />Add stage
          </Button>
          <span className="text-xs text-gray-500">{stages.length}/{MAX_STAGES} stages. &ldquo;Closing&rdquo; is always available as the last stage.</span>
        </div>
      )}
    </div>
  );
}
