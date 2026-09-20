'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Bookmark, CalendarDays, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/outreach/ui';
import { parseError } from '@/lib/outreach/api';
import { PRESETS, fmtRange, isPresetKey, matchPreset, presetRange, useDeleteRange, useSaveRange, useSavedRanges, validRange, type DateRange, type SavedRange } from '@/lib/outreach/reports';

const dateInput = 'px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500';

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return { open, setOpen, ref };
}

/**
 * Date range: presets, a custom range, and (with a workspace id) the member's saved ranges.
 * Dates are calendar days in the workspace timezone.
 */
export default function RangePicker({ value, onChange, timezone, workspaceId, onNotice }: {
  value: DateRange; onChange: (r: DateRange) => void; timezone: string; workspaceId?: string | null; onNotice?: (message: string, type?: 'success' | 'error') => void;
}) {
  const active = matchPreset(value, timezone);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState<DateRange>(value);
  useEffect(() => { setDraft(value); }, [value.from, value.to]);   // eslint-disable-line react-hooks/exhaustive-deps
  const showCustom = custom || !active;
  const draftError = validRange(draft);

  const saved = useSavedRanges(workspaceId ?? null);
  const saveRange = useSaveRange(workspaceId ?? null);
  const deleteRange = useDeleteRange(workspaceId ?? null);
  const pop = usePopover();
  const [name, setName] = useState('');

  function applySaved(r: SavedRange) {
    if (isPresetKey(r.preset)) onChange(presetRange(r.preset, timezone));
    else if (r.from_date && r.to_date) onChange({ from: r.from_date, to: r.to_date });
    setCustom(false); pop.setOpen(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try { await saveRange.mutateAsync({ name: n, preset: active, range: value }); setName(''); onNotice?.('Range saved.'); }
    catch (er) { onNotice?.(parseError(er).message, 'error'); }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg border border-gray-300 bg-white p-0.5" role="group" aria-label="Date range">
        {PRESETS.map((p) => (
          <button key={p.key} type="button" aria-pressed={!showCustom && active === p.key} onClick={() => { setCustom(false); onChange(presetRange(p.key, timezone)); }}
            className={cn('px-2.5 py-1 text-sm rounded-md whitespace-nowrap transition-colors', !showCustom && active === p.key ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}>{p.label}</button>
        ))}
        <button type="button" aria-pressed={showCustom} onClick={() => setCustom(true)}
          className={cn('px-2.5 py-1 text-sm rounded-md whitespace-nowrap transition-colors inline-flex items-center gap-1', showCustom ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}><CalendarDays className="w-3.5 h-3.5" /> Custom</button>
      </div>

      {showCustom ? (
        <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (!draftError) onChange(draft); }}>
          <input type="date" aria-label="From" className={dateInput} value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          <span className="text-gray-400 text-sm">to</span>
          <input type="date" aria-label="To" className={dateInput} value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          <Button type="submit" size="sm" variant="secondary" disabled={!!draftError || (draft.from === value.from && draft.to === value.to)}>Apply</Button>
          {draftError && <span className="text-xs text-red-600">{draftError}</span>}
        </form>
      ) : <span className="text-sm text-gray-500">{fmtRange(value)}</span>}

      {workspaceId && (
        <div className="relative" ref={pop.ref}>
          <Button size="sm" variant="ghost" onClick={() => pop.setOpen(!pop.open)} aria-expanded={pop.open} aria-haspopup="dialog"><Bookmark className="w-3.5 h-3.5" /> Saved ranges</Button>
          {pop.open && (
            <div role="dialog" aria-label="Saved ranges" className="absolute z-40 mt-1 left-0 w-80 rounded-xl border border-gray-200 bg-white shadow-xl p-3">
              {saved.isLoading ? <div className="text-sm text-gray-400 py-2">Loading…</div> : saved.isError ? <div className="text-sm text-red-600 py-2">{(saved.error as Error).message}</div> : !saved.data?.length ? (
                <p className="text-sm text-gray-500 py-1">No saved ranges yet. Save the range you are looking at to come back to it in one click.</p>
              ) : (
                <ul className="max-h-56 overflow-y-auto -mx-1 mb-1">
                  {saved.data.map((r) => (
                    <li key={r.id} className="flex items-center gap-1 rounded-lg hover:bg-gray-50">
                      <button type="button" onClick={() => applySaved(r)} className="flex-1 min-w-0 text-left px-2 py-1.5">
                        <span className="block text-sm text-gray-900 truncate">{r.name}</span>
                        <span className="block text-xs text-gray-500">{isPresetKey(r.preset) ? `${PRESETS.find((p) => p.key === r.preset)?.label}, always up to date` : r.from_date && r.to_date ? fmtRange({ from: r.from_date, to: r.to_date }) : ''}</span>
                      </button>
                      <button type="button" aria-label={`Delete saved range ${r.name}`} disabled={deleteRange.isPending} onClick={() => deleteRange.mutate(r.id, { onError: (er) => onNotice?.(parseError(er).message, 'error') })} className="p-1.5 mr-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-3.5 h-3.5" /></button>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={save} className="flex items-center gap-2 pt-2 border-t border-gray-100">
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={active ? PRESETS.find((p) => p.key === active)?.label : fmtRange(value)} aria-label="Name for this range"
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                <Button type="submit" size="sm" loading={saveRange.isPending} disabled={!name.trim()}>Save this range</Button>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
