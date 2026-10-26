'use client';

// Period selector of the sequence stats (sequence-stats-PRD.md §3.5 / §6.2): All time · 7d · 14d · 30d · 90d · Custom,
// in the Reports toggle style, with the cohort sentence underneath.
import React, { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/outreach/ui';
import { validRange, type DateRange } from '@/lib/outreach/reports';
import { cohortText, periodRange, STATS_PRESETS, type StatsPeriod } from '@/lib/outreach/sequenceStats';

const dateInput = 'min-w-0 px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500';

export default function StatsPeriodPicker({ value, onChange, timezone, compact, caption }: { value: StatsPeriod; onChange: (p: StatsPeriod) => void; timezone: string; compact?: boolean; /** Replaces the cohort sentence (the Analytics tab counts enrolments, not first contacts). */ caption?: string }) {
  const [custom, setCustom] = useState(value.kind === 'custom');
  const range = periodRange(value, timezone);
  const [draft, setDraft] = useState<DateRange>(range ?? { from: '', to: '' });
  // a custom period set from outside (restored filters) fills the date inputs; no effect needed
  const [seen, setSeen] = useState<StatsPeriod>(value);
  if (seen !== value) { setSeen(value); if (value.kind === 'custom') setDraft({ from: value.from, to: value.to }); }
  const showCustom = custom || value.kind === 'custom';
  const draftError = validRange(draft);
  const btn = (active: boolean) => cn('px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors', active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50');

  return (
    <div className={cn('min-w-0', compact ? 'space-y-1' : 'space-y-1.5')}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex max-w-full overflow-x-auto [scrollbar-width:none] rounded-lg border border-gray-200 bg-white p-0.5" role="group" aria-label="Period">
          {STATS_PRESETS.map((p) => (
            <button key={p.key} type="button" aria-pressed={!showCustom && value.kind === p.key} onClick={() => { setCustom(false); onChange({ kind: p.key }); }} className={btn(!showCustom && value.kind === p.key)}>{p.label}</button>
          ))}
          <button type="button" aria-pressed={showCustom} onClick={() => setCustom(true)} className={cn(btn(showCustom), 'inline-flex items-center gap-1')}><CalendarDays className="w-3.5 h-3.5" /> Custom</button>
        </div>
        {showCustom && (
          <form className="flex flex-wrap items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (!draftError) onChange({ kind: 'custom', from: draft.from, to: draft.to }); }}>
            <input type="date" aria-label="From" className={dateInput} value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            <span className="text-gray-400 text-sm">to</span>
            <input type="date" aria-label="To" className={dateInput} value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            <Button type="submit" size="sm" variant="secondary" disabled={!!draftError || (value.kind === 'custom' && draft.from === value.from && draft.to === value.to)}>Apply</Button>
            {draftError && draft.from && draft.to && <span className="text-xs text-red-600">{draftError}</span>}
          </form>
        )}
      </div>
      <p className="text-xs text-gray-500">{caption ?? cohortText(range)}</p>
    </div>
  );
}
