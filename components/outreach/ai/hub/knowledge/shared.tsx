'use client';

// Small pieces shared by the Knowledge page: the checkbox lists of sequences and websites ("Use in…", "Available to").
import { Loader2 } from 'lucide-react';
import type { HubKnowledge, KnowledgeTargetKind } from '@/lib/outreach/aiHub';
import { cn } from '@/lib/utils';

export type Notify = (m: string, t?: 'success' | 'error') => void;
export type KnowledgeTargets = HubKnowledge['targets'];
export const NO_TARGETS: KnowledgeTargets = { sequences: [], websites: [] };

/** One key per place: 'sequence:<id>' / 'website:<id>'. */
export const targetKey = (kind: KnowledgeTargetKind, id: string) => `${kind}:${id}`;
export function fromTargetKey(key: string): { kind: KnowledgeTargetKind; id: string } {
  const i = key.indexOf(':');
  return { kind: key.slice(0, i) === 'website' ? 'website' : 'sequence', id: key.slice(i + 1) };
}
export const allTargetKeys = (t: KnowledgeTargets) => [...(t.sequences ?? []).map((s) => targetKey('sequence', s.id)), ...(t.websites ?? []).map((w) => targetKey('website', w.id))];

const SEQUENCE_STATUS_NOTE: Record<string, string> = { draft: 'Draft', paused: 'Paused' };

function Group({ title, empty, kind, items, isChecked, isBusy, disabled, onToggle }: {
  title: string; empty: string; kind: KnowledgeTargetKind; items: Array<{ id: string; name: string; note?: string }>;
  isChecked: (key: string) => boolean; isBusy?: (key: string) => boolean; disabled?: boolean; onToggle: (kind: KnowledgeTargetKind, id: string, on: boolean) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-xs font-medium text-gray-600 mb-1">{title}</legend>
      {items.length === 0 ? <p className="text-xs text-gray-500">{empty}</p> : (
        <ul className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
          {items.map((it) => {
            const key = targetKey(kind, it.id);
            const wait = isBusy?.(key) ?? false;
            const off = !!disabled || wait;
            return (
              <li key={it.id}>
                <label aria-busy={wait || undefined} className={cn('flex items-center gap-2 px-3 py-2 text-sm', off ? 'cursor-default' : 'cursor-pointer hover:bg-gray-50')}>
                  <input type="checkbox" className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" checked={isChecked(key)} disabled={off} onChange={(e) => onToggle(kind, it.id, e.target.checked)} />
                  <span className="min-w-0 flex-1 truncate text-gray-900" title={it.name}>{it.name}</span>
                  {it.note && <span className="text-xs text-gray-400 flex-shrink-0">{it.note}</span>}
                  {wait && <><Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500 flex-shrink-0" aria-hidden="true" /><span className="sr-only" role="status">Saving</span></>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}

/** Two checkbox lists, sequences and websites. The caller owns what is checked and what a change does. */
export function TargetChecklist({ targets, isChecked, isBusy, disabled, websitesOnly, onToggle }: {
  targets: KnowledgeTargets; isChecked: (key: string) => boolean; isBusy?: (key: string) => boolean; disabled?: boolean;
  /** A product catalogue: sequences do not use one. */
  websitesOnly?: boolean;
  onToggle: (kind: KnowledgeTargetKind, id: string, on: boolean) => void;
}) {
  if (websitesOnly) {
    return (
      <Group title="Websites (Website agent)" empty="No websites yet." kind="website" isChecked={isChecked} isBusy={isBusy} disabled={disabled} onToggle={onToggle}
        items={(targets.websites ?? []).map((w) => ({ id: w.id, name: w.name }))} />
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Group title="Sequences (Replies)" empty="No sequences yet." kind="sequence" isChecked={isChecked} isBusy={isBusy} disabled={disabled} onToggle={onToggle}
        items={(targets.sequences ?? []).map((s) => ({ id: s.id, name: s.name, note: SEQUENCE_STATUS_NOTE[s.status] }))} />
      <Group title="Websites (Website agent)" empty="No websites yet." kind="website" isChecked={isChecked} isBusy={isBusy} disabled={disabled} onToggle={onToggle}
        items={(targets.websites ?? []).map((w) => ({ id: w.id, name: w.name }))} />
    </div>
  );
}
