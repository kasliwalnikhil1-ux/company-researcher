'use client';

import React, { useId } from 'react';
import { X } from 'lucide-react';
import { SearchableSelect } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { COUNTRY_LIST, EU_EEA, countryName, isEuEea } from '../format';

/** A labelled box whose empty state means "inherit". The × button empties it. */
export function InheritField({ label, hint, value, onChange, placeholder, unit, error, step }: {
  label: string; hint?: React.ReactNode; value: string; onChange: (v: string) => void;
  placeholder: string; unit?: string; error?: string; step?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <input id={id} type="number" inputMode="decimal" step={step ?? '1'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
            aria-invalid={!!error} aria-describedby={error || hint ? `${id}-d` : undefined}
            className={cn('w-full px-3 py-2 text-sm rounded-lg border bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-50',
              unit && 'pr-12', error ? 'border-red-400' : 'border-gray-300')} />
          {unit && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">{unit}</span>}
        </div>
        <ClearButton show={value !== ''} onClick={() => onChange('')} label={`Inherit ${label.toLowerCase()}`} />
      </div>
      {(error || hint) && <p id={`${id}-d`} className={cn('text-xs mt-1', error ? 'text-red-600' : 'text-gray-500')}>{error ?? hint}</p>}
    </div>
  );
}

export function ClearButton({ show, onClick, label }: { show: boolean; onClick: () => void; label: string }) {
  if (!show) return <span className="w-8 flex-shrink-0" aria-hidden="true" />;
  return (
    <button type="button" onClick={onClick} title="Clear — inherit this value" aria-label={label}
      className="w-8 h-8 flex-shrink-0 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent">
      <X className="w-4 h-4" />
    </button>
  );
}

/**
 * Blocked countries. `null` = inherit (the effective list is shown greyed), `[]` = block none.
 * Codes are ISO-2; the list only applies to autopilot while no disclosure text is set.
 */
export function CountryChips({ value, inherited, onChange, error, disabled }: {
  value: string[] | null; inherited: string[] | null; onChange: (v: string[] | null) => void; error?: string; disabled?: boolean;
}) {
  const list = value ?? inherited ?? [];
  const inheriting = value == null;
  const add = (code: string) => { if (!code) return; const base = value ?? inherited ?? []; if (!base.includes(code)) onChange([...base, code]); };
  const remove = (code: string) => onChange((value ?? inherited ?? []).filter((c) => c !== code));
  const options = COUNTRY_LIST.filter((c) => !list.includes(c.code)).map((c) => ({ value: c.code, label: c.name, hint: c.code }));
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="block text-xs font-medium text-gray-600">Blocked countries for autopilot</span>
        {inheriting ? <span className="text-xs text-gray-400">Inherited</span>
          : <button type="button" disabled={disabled} onClick={() => onChange(null)} className="text-xs text-indigo-600 hover:underline disabled:opacity-40 disabled:no-underline">Inherit instead</button>}
      </div>
      <div className={cn('rounded-lg border px-2 py-2 min-h-[42px] flex flex-wrap gap-1.5', error ? 'border-red-400' : 'border-gray-300', inheriting && 'bg-gray-50')}>
        {list.length === 0 && <span className="text-xs text-gray-500 px-1 py-0.5">No countries blocked</span>}
        {isEuEea(list) ? (
          <Chip label="EU/EEA (30 countries)" muted={inheriting} onRemove={disabled ? undefined : () => onChange([])} />
        ) : list.map((c) => (
          <Chip key={c} label={`${countryName(c)} (${c})`} muted={inheriting} onRemove={disabled ? undefined : () => remove(c)} />
        ))}
      </div>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <SearchableSelect className="w-56" aria-label="Add a country" value="" onChange={add} options={options} placeholder="Add a country…" disabled={disabled} />
        {!isEuEea(list) && <button type="button" disabled={disabled} onClick={() => onChange([...new Set([...list, ...EU_EEA])])} className="text-xs text-indigo-600 hover:underline disabled:opacity-40">Add all EU/EEA</button>}
        {list.length > 0 && <button type="button" disabled={disabled} onClick={() => onChange([])} className="text-xs text-gray-600 hover:underline disabled:opacity-40">Block none</button>}
      </div>
    </div>
  );
}

function Chip({ label, muted, onRemove }: { label: string; muted?: boolean; onRemove?: () => void }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs', muted ? 'bg-gray-200 text-gray-600' : 'bg-indigo-100 text-indigo-800')}>
      {label}
      {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove ${label}`} className="rounded-full hover:bg-black/10 p-0.5"><X className="w-3 h-3" /></button>}
    </span>
  );
}
