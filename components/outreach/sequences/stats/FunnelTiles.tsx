'use client';

// The header funnel of the sequence page (PRD §7.1): Contacted · Accepted · Replied · Positive as four tiles with the
// same numbers, rates and NA rules as the list, and the "Replied on another channel" line underneath.
import React from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MetricLabel } from '@/components/outreach/reports/primitives';
import {
  acceptedTip, contactedTip, fmtInt, fmtPct, isSmallBase, positiveTip, repliedOtherChannelText, repliedTip, SMALL_BASE_TIP, type SequenceStatsBlock,
} from '@/lib/outreach/sequenceStats';

function Tile({ label, metric, value, sub, tip, na, muted }: { label: string; metric: string; value: string; sub?: React.ReactNode; tip: string; na?: string; muted?: boolean }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3.5 min-w-0" title={na ?? tip}>
      <div className="text-xs font-medium text-gray-500"><MetricLabel metric={metric}>{label}</MetricLabel></div>
      {na ? (
        <div className="mt-1 text-2xl font-semibold text-gray-400 inline-flex items-center gap-1.5">NA <Info className="w-4 h-4" aria-hidden /><span className="sr-only">{na}</span></div>
      ) : (
        <div className={cn('mt-1 text-2xl font-semibold leading-tight', muted ? 'text-gray-400' : 'text-gray-900')}>{value}</div>
      )}
      {!na && sub && <div className="mt-0.5 text-xs text-gray-600">{sub}</div>}
      {na && <div className="mt-0.5 text-xs text-gray-500">{na}</div>}
    </div>
  );
}

export default function FunnelTiles({ f, draft, other }: { f: SequenceStatsBlock; draft?: boolean; other?: Record<string, number> | null }) {
  const dash = draft || f.contacted === 0;
  const v = (n: number) => (dash ? '—' : fmtInt(n));
  const rate = (r: number | null, den: number, early?: boolean) => (dash ? null : (
    <span className={cn((early || isSmallBase(den)) && 'text-gray-400')} title={early ? 'Most requests are still pending, so this rate will change.' : isSmallBase(den) ? SMALL_BASE_TIP : undefined}>{fmtPct(r)}</span>
  ));
  const otherText = repliedOtherChannelText(other);
  return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Contacted" metric="contacted" value={v(f.contacted)} tip={contactedTip(f)} muted={dash}
          sub={!dash && <>{f.progress?.enrolled ? `${Math.round((100 * f.contacted) / f.progress.enrolled)}% of ${fmtInt(f.progress.enrolled)} enrolled` : null}</>} />
        <Tile label="Accepted" metric="accepted" value={v(f.accepted)} tip={acceptedTip(f)} na={dash ? undefined : f.na?.accepted} muted={dash}
          sub={!dash && <>{rate(f.accepted_rate, f.invited, f.accepted_early)}{f.pending > 0 && <> · {fmtInt(f.pending)} pending</>}</>} />
        <Tile label="Replied" metric="replied" value={v(f.replied)} tip={repliedTip(f)} muted={dash} sub={!dash && rate(f.replied_rate, f.contacted)} />
        <Tile label="Positive" metric="positive" value={v(f.positive)} tip={positiveTip(f)} muted={dash}
          sub={!dash && <>{rate(f.positive_rate, f.replied)}{f.meetings > 0 && <> · {fmtInt(f.meetings)} {f.meetings === 1 ? 'meeting' : 'meetings'}</>}</>} />
      </div>
      {otherText && <p className="mt-2 text-xs text-gray-600">{otherText}</p>}
    </div>
  );
}
