'use client';

import { Gauge } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { usePoolV2 } from '@/lib/outreach/aiRepliesSequence';
import { Card, ErrorBox, Spinner } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { nextMonthStart } from '@/components/outreach/settings/ai-replies/format';
import { cn } from '@/lib/utils';
import { plural } from './parts';

/** AI usage this month against the plan's allowance. On an own key there is no allowance: the provider bills the usage. */
export default function UsageCard({ ws }: { ws: string }) {
  const q = usePoolV2(ws);
  const p = q.data;
  const used = p?.used ?? 0;
  const limit = p?.limit ?? null;
  const share = limit == null ? 0 : limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  const full = !!p && p.ok === false;

  return (
    <Card title={<span className="flex items-center gap-2"><Gauge className="w-4 h-4" aria-hidden="true" /> AI usage this month</span>}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox message={parseError(q.error).message} /> : p && (
        <div className="space-y-3">
          {p.own_key || limit == null ? (
            <>
              <p className="text-sm text-gray-800"><span className="text-xl font-semibold text-gray-900 tabular-nums">{used.toLocaleString()}</span> AI {plural(used, 'action')} used this month</p>
              <p className="text-xs text-gray-500">{p.own_key ? 'This workspace uses its own AI key, so there is no limit. The provider bills the usage to your account.' : 'There is no monthly limit for this workspace.'}</p>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-800">
                <span className="text-xl font-semibold text-gray-900 tabular-nums">{used.toLocaleString()}</span> of <span className="font-semibold text-gray-900 tabular-nums">{limit.toLocaleString()}</span> AI actions used this month
              </p>
              <div role="progressbar" aria-label="AI actions used this month" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)} className="h-2 rounded-full bg-gray-100 overflow-hidden">
                <div className={cn('h-full rounded-full', full ? 'bg-red-500' : share >= 80 ? 'bg-amber-500' : 'bg-indigo-500')} style={{ width: `${share}%` }} />
              </div>
              {full && <Note tone="amber">This month&apos;s allowance is used up. The AI writes no replies and no website answers until {nextMonthStart(p.month)}. With your own AI key (above) there is no limit.</Note>}
            </>
          )}
          <p className="text-xs text-gray-500">One AI action is one reply or one website answer the AI writes. The count starts again on {nextMonthStart(p.month)}.</p>
        </div>
      )}
    </Card>
  );
}
