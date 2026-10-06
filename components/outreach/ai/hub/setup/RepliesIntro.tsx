'use client';

import { AlertTriangle, Sparkles } from 'lucide-react';
import { usePoolV2 } from '@/lib/outreach/aiRepliesSequence';
import { nextMonthStart } from '@/components/outreach/settings/ai-replies/format';

/** Top of AI → Setup → AI replies: where AI replies are set, and the alert when the month's AI allowance is used up. */
export default function RepliesIntro({ ws }: { ws: string }) {
  const pool = usePoolV2(ws);
  const p = pool.data;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3">
        <Sparkles className="w-4 h-4 text-indigo-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <div className="text-sm text-gray-700 space-y-1">
          <p>AI replies are set per sequence. This page lists every sequence with its mode. The prompt and the limits are on each sequence&apos;s <strong className="text-gray-900">AI</strong> tab: click a sequence to open it.</p>
        </div>
      </div>
      {p && !p.ok && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>
            This month&apos;s AI allowance is used up. The AI writes no replies until {nextMonthStart(p.month)}.
            {p.limit != null && <> ({(p.used ?? 0).toLocaleString()} of {p.limit.toLocaleString()} used.)</>}
          </span>
        </div>
      )}
    </div>
  );
}
