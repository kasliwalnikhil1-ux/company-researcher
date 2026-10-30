'use client';

// One result cell of the Sequences list (PRD §6.1 / §6.3). Every cell uses the same two slots so a column reads as a
// column: the count (right-aligned) and the rate in a fixed-width slot beside it. "NA" and the draft "—" start in the
// count slot, so they line up with the numbers above and below; hovering NA says why. "Pending" (Accepted only) is a quiet second line.
// Tooltips use the native `title` (the app restyles every title through GlobalTooltips).
import React from 'react';
import { cn } from '@/lib/utils';
import type { Rate } from '@/lib/outreach/reports';
import { fmtInt, isSmallBase, SMALL_BASE_TIP } from '@/lib/outreach/sequenceStats';

export function NotApplicable({ reason }: { reason: string }) {
  return (
    <span className="text-sm font-medium text-gray-400 cursor-help" title={reason}>
      NA<span className="sr-only"> {reason}</span>
    </span>
  );
}

export function Dash({ title }: { title?: string }) {
  return <span className="text-gray-300" title={title}>—</span>;
}

/** "5.7%", "50%", "100%": one decimal only where it carries information. */
export function fmtRateShort(rate: Rate | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  if (rate > 0 && rate < 10) return `${Number(rate.toFixed(1))}%`;
  return `${Math.round(rate)}%`;
}

/** The two-slot frame every result cell shares: count | rate, and an optional line underneath. */
function Slots({ count, rate, below, withRate, align, title }: { count: React.ReactNode; rate?: React.ReactNode; below?: React.ReactNode; withRate: boolean; align: 'right' | 'left'; title?: string }) {
  return (
    <span className={cn('inline-grid items-baseline gap-x-2 gap-y-0.5 leading-tight', withRate ? 'grid-cols-[auto_2.75rem]' : 'grid-cols-[auto]', align === 'right' ? 'justify-items-end' : 'justify-items-start', title && 'cursor-help')} title={title}>
      {count}
      {withRate && <span className="justify-self-start">{rate}</span>}
      {below && <span className={cn(withRate && 'col-span-2', 'justify-self-end')}>{below}</span>}
    </span>
  );
}

export function MetricCell({ count, rate, denominator, pending, early, na, draft, tip, align = 'right' }: {
  count: number; rate?: Rate; denominator?: number; pending?: number; early?: boolean; na?: string | null; draft?: boolean; tip: string; align?: 'right' | 'left';
}) {
  const withRate = rate !== undefined;
  if (draft) return <Slots withRate={withRate} align={align} count={<Dash title="Not started" />} />;
  // With a rate slot, "NA" starts where a one-digit count starts (a 1ch count slot it overflows to the right),
  // so it lines up with the "0 —" / "1 50%" rows instead of sticking out to the left.
  if (na && withRate) return (
    <Slots
      withRate
      align={align}
      title={na}
      count={<span className="w-[1ch] text-sm font-semibold tabular-nums whitespace-nowrap"><NotApplicable reason={na} /></span>}
    />
  );
  if (na) return <Slots withRate={withRate} align={align} count={<NotApplicable reason={na} />} />;

  const small = withRate && isSmallBase(denominator);
  const shaky = !!early || small;
  const rateTitle = early ? 'Most requests are still pending, so this rate will change.' : small ? SMALL_BASE_TIP : undefined;
  const finiteRate = typeof rate === 'number' && Number.isFinite(rate);

  return (
    <Slots
      withRate={withRate}
      align={align}
      title={tip}
      count={<span className={cn('text-sm font-semibold tabular-nums', count > 0 ? 'text-gray-900' : 'text-gray-300')}>{fmtInt(count)}</span>}
      rate={
        <span
          title={rateTitle}
          className={cn(
            'text-xs whitespace-nowrap',
            !finiteRate || count === 0 ? 'text-gray-300' : shaky ? 'text-gray-400 underline decoration-dotted decoration-gray-300 underline-offset-[3px]' : 'text-gray-600 font-medium',
          )}
        >
          {fmtRateShort(rate)}
        </span>
      }
      below={pending !== undefined && pending > 0 ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 whitespace-nowrap" title="Requests sent and not yet accepted.">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" aria-hidden />{fmtInt(pending)} pending
        </span>
      ) : undefined}
    />
  );
}
