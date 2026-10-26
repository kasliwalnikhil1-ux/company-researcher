'use client';

// One block per channel the sequence uses (PRD §7.2): a horizontal funnel with only the stages that channel has,
// "Seen" marked "at least", the LinkedIn "of people who accepted, N% replied" line, and "from an earlier version".
import React from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChannelGlyph } from './ChannelGlyphs';
import {
  channelStages, fmtInt, fmtPct, repliedOfAcceptedText, SEEN_TIP, seenSinceText, STATS_CHANNEL_LABEL, type ChannelBlock,
} from '@/lib/outreach/sequenceStats';

function Block({ b, seenSince, seenPartial }: { b: ChannelBlock; seenSince: string | null; seenPartial: boolean }) {
  const stages = channelStages(b);
  const main = stages.filter((s) => !s.aside);
  const aside = stages.filter((s) => s.aside);
  const top = Math.max(1, ...main.map((s) => s.value));
  const line = repliedOfAcceptedText(b);
  const seenNote = seenPartial ? seenSinceText(seenSince) : null;
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <ChannelGlyph channel={b.channel} className="w-4 h-4" />
        <span className="text-sm font-semibold text-gray-900">{STATS_CHANNEL_LABEL[b.channel]}</span>
        {b.from_earlier_version && <span className="text-xs text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">from an earlier version</span>}
      </div>
      <ol className="flex flex-wrap items-stretch gap-x-1 gap-y-3">
        {main.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1 min-w-[88px]">
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-gray-500 inline-flex items-center gap-1">
                {s.label}
                {s.atLeast && <span className="inline-flex cursor-help text-gray-400" title={[SEEN_TIP, seenNote].filter(Boolean).join(' ')}><Info className="w-3 h-3" aria-hidden /><span className="sr-only">{SEEN_TIP}</span></span>}
              </div>
              <div className="text-base font-semibold text-gray-900 tabular-nums leading-tight">
                {s.atLeast && s.value > 0 && <span className="text-gray-400 font-normal">≥ </span>}{fmtInt(s.value)}
                {s.rate !== undefined && <span className="text-xs font-normal text-gray-500"> · {fmtPct(s.rate)}</span>}
              </div>
              <div className="mt-1 h-1 rounded-full bg-gray-100 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${Math.max(2, (100 * s.value) / top)}%`, background: 'var(--outreach-accent, #4f46e5)' }} /></div>
            </div>
            {i < main.length - 1 && <span className="text-gray-300 px-0.5 self-center" aria-hidden>→</span>}
          </li>
        ))}
      </ol>
      {(line || aside.length > 0) && (
        <div className={cn('mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600')}>
          {line && <span>{line}</span>}
          {aside.map((s) => <span key={s.key}>{s.label}: <span className="tabular-nums text-gray-900">{fmtInt(s.value)}</span></span>)}
        </div>
      )}
    </div>
  );
}

export default function ChannelBlocks({ channels, seenSince, seenPartial }: { channels: ChannelBlock[]; seenSince: string | null; seenPartial: boolean }) {
  if (!channels?.length) return <p className="text-sm text-gray-500">No channel has been used yet.</p>;
  return <div className="grid grid-cols-1 gap-3">{channels.map((b) => <Block key={b.channel} b={b} seenSince={seenSince} seenPartial={seenPartial} />)}</div>;
}
