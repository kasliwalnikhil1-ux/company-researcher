'use client';

import { useId } from 'react';
import { ArrowRight, Plus, RotateCcw, X } from 'lucide-react';
import { Badge, Button } from '@/components/outreach/ui';

export type Pair = { key: string; value: string };
export const toPairs = (m: Record<string, string> | null | undefined): Pair[] => Object.entries(m ?? {}).map(([key, value]) => ({ key, value: String(value ?? '') }));
export const fromPairs = (p: Pair[]): Record<string, string> => Object.fromEntries(p.filter((x) => x.key.trim() && x.value.trim()).map((x) => [x.key.trim(), x.value.trim()]));

export function pairProblems(pairs: Pair[]): string | null {
  const keys = pairs.map((p) => p.key.trim()).filter(Boolean);
  if (new Set(keys).size !== keys.length) return 'Each row on the left can only be mapped once.';
  if (pairs.some((p) => (p.key.trim() && !p.value.trim()) || (!p.key.trim() && p.value.trim()))) return 'Fill in both sides of every row, or remove the row.';
  if (pairs.some((p) => p.value.length > 120 || p.key.length > 80)) return 'A value is too long.';
  return null;
}

const inputCls = 'w-full px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50';

/**
 * JSON-backed key → value editor. The left side picks from `options` (free text is allowed, for `custom.<field>`),
 * the right side is the CRM's own property or stage name. Rows that equal the built-in default carry a "default" tag.
 */
export default function MappingEditor({ pairs, onChange, options, defaults, leftLabel, rightLabel, rightPlaceholder, disabled, allowCustom }: {
  pairs: Pair[]; onChange: (p: Pair[]) => void; options: Array<{ value: string; label: string }>; defaults: Record<string, string>;
  leftLabel: string; rightLabel: string; rightPlaceholder?: string; disabled?: boolean; allowCustom?: boolean;
}) {
  const listId = useId();
  const set = (i: number, patch: Partial<Pair>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const unused = options.filter((o) => !pairs.some((p) => p.key === o.value));
  const isDefault = JSON.stringify(fromPairs(pairs)) === JSON.stringify(defaults);

  return (
    <div>
      <div className="hidden sm:grid grid-cols-[1fr_20px_1fr_32px] gap-2 text-[11px] uppercase tracking-wide text-gray-400 mb-1 px-0.5"><span>{leftLabel}</span><span /><span>{rightLabel}</span><span /></div>
      {pairs.length === 0 && <div className="text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg px-3 py-4 text-center">Nothing is mapped. Add a row, or go back to the defaults.</div>}
      <ul className="space-y-1.5">
        {pairs.map((p, i) => (
          <li key={i} className="grid grid-cols-[1fr_20px_1fr_32px] gap-2 items-center">
            <div>
              <input className={inputCls} list={listId} value={p.key} disabled={disabled} aria-label={`${leftLabel}, row ${i + 1}`} placeholder={allowCustom ? 'first_name or custom.field' : 'Choose…'} onChange={(e) => set(i, { key: e.target.value })} spellCheck={false} />
            </div>
            <ArrowRight className="w-4 h-4 text-gray-300 justify-self-center" aria-hidden />
            <div className="relative">
              <input className={`${inputCls}${defaults[p.key] && defaults[p.key] === p.value.trim() ? ' pr-16' : ''}`} value={p.value} disabled={disabled} aria-label={`${rightLabel}, row ${i + 1}`} placeholder={defaults[p.key] ?? rightPlaceholder} onChange={(e) => set(i, { value: e.target.value })} spellCheck={false} />
              {defaults[p.key] && defaults[p.key] === p.value.trim() && <Badge className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none">default</Badge>}
            </div>
            <button type="button" disabled={disabled} onClick={() => onChange(pairs.filter((_x, j) => j !== i))} aria-label={`Remove row ${i + 1}`} className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"><X className="w-4 h-4" /></button>
          </li>
        ))}
      </ul>
      <datalist id={listId}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</datalist>
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...pairs, { key: unused[0]?.value ?? '', value: unused[0] ? defaults[unused[0].value] ?? '' : '' }])}><Plus className="w-3.5 h-3.5" /> Add row</Button>
          {!isDefault && <Button type="button" size="sm" variant="ghost" onClick={() => onChange(toPairs(defaults))}><RotateCcw className="w-3.5 h-3.5" /> Back to defaults</Button>}
        </div>
      )}
    </div>
  );
}
