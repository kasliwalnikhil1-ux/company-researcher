'use client';

// The people behind one day of the "Activity by day" chart: the same right-side drawer as a step chip's leads
// (FailedLeadsPanel), filtered to one workspace day (migration 106), with a date field and prev / next day arrows so
// the day can be changed from inside the drawer instead of clicking another bar. The day and the tab are the
// caller's state (the chart click seeds both).
import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fmtDay } from '@/lib/outreach/reports';
import type { AnalyticsDay } from '@/lib/outreach/sequenceLeads';
import type { Graph } from '@/lib/outreach/types';
import { FailedLeadsPanel } from '../FailedLeadsDrawer';
import { Drawer } from '../Modals';
import type { FailedKind } from '../publishTypes';

/** The series of the chart, in its order: the tabs of the drawer. */
export type DayKind = Extract<FailedKind, 'sent' | 'accepted' | 'replied' | 'interested' | 'meetings'>;
export const DAY_KINDS: DayKind[] = ['sent', 'accepted', 'replied', 'interested', 'meetings'];
const DAY_KIND_SET: ReadonlySet<string> = new Set(DAY_KINDS);

function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function DayLeadsDrawer({ open, onClose, sequenceId, day, onDayChange, kind, onKindChange, days, graph }: {
  open: boolean; onClose: () => void; sequenceId: string;
  /** The workspace day shown (ISO). */
  day: string | null; onDayChange: (day: string) => void;
  /** The tab shown. */
  kind: DayKind; onKindChange: (kind: DayKind) => void;
  /** The chart's days: the tab counts and the first / last day the arrows can reach. */
  days: AnalyticsDay[]; graph?: Graph | null;
}) {
  const first = days[0]?.day; const last = days[days.length - 1]?.day;
  const point = useMemo(() => days.find((d) => d.day === day), [days, day]);
  // the chart's own numbers on the tabs (an older payload has no outcome keys: 0 hides the tab)
  const counts = useMemo(() => point ? { sent: point.sent, accepted: point.accepted ?? 0, replied: point.replied ?? 0, interested: point.interested ?? 0, meetings: point.meetings ?? 0 } : undefined, [point]);
  const range = useMemo(() => (day ? { from: day, to: day } : null), [day]);
  const canPrev = !!day && !!first && day > first; const canNext = !!day && !!last && day < last;
  const arrow = 'p-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:hover:bg-white';
  return (
    <Drawer open={open} onClose={onClose} width="max-w-3xl" title={day ? `Activity on ${fmtDay(day, true)}` : 'Activity'} subtitle="The people behind this day: what went out and what came back.">
      {open && day && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500">Day</span>
            <button type="button" className={arrow} disabled={!canPrev} onClick={() => canPrev && onDayChange(shiftDay(day, -1))} aria-label="Previous day" title="Previous day"><ChevronLeft className="w-3.5 h-3.5" /></button>
            <input type="date" aria-label="Day" value={day} min={first} max={last} onChange={(e) => { const v = e.target.value; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) onDayChange(v); }}
              className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <button type="button" className={arrow} disabled={!canNext} onClick={() => canNext && onDayChange(shiftDay(day, 1))} aria-label="Next day" title="Next day"><ChevronRight className="w-3.5 h-3.5" /></button>
            {first && last && <span className="text-xs text-gray-400">Chart range: {fmtDay(first)} – {fmtDay(last, true)}</span>}
          </div>
          <FailedLeadsPanel sequenceId={sequenceId} nodeId={null} kind={kind} onKindChange={(k) => { if (DAY_KIND_SET.has(k)) onKindChange(k as DayKind); }} kinds={DAY_KINDS} counts={counts} range={range} graph={graph} canWrite={false} />
        </div>
      )}
    </Drawer>
  );
}
