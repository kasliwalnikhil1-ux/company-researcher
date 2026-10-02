'use client';

import { useMemo } from 'react';
import { parseError } from '@/lib/outreach/api';
import { useCancelReportV2 } from '@/lib/outreach/aiRepliesSequence';
import { Badge, Card, ErrorBox, Spinner } from '@/components/outreach/ui';
import { cancelReasonLabel } from '../format';

/** Which prompt section a cancel reason usually points at. */
const REASON_SECTION: Record<string, string> = {
  too_early_to_pitch: 'How a conversation goes (stages and when to pitch)',
  wrong_facts: 'Facts I can use',
  wrong_tone: 'Style',
  shouldnt_reply: 'Scenarios',
  answer_myself: 'Hand to a person when',
};

/** Cancelled AI replies grouped by the prompt rule the AI followed, so each points at the section to fix. */
export default function CancelReport({ ws, days, onOpenRun }: { ws: string; days: number; onOpenRun?: (id: string) => void }) {
  const q = useCancelReportV2(ws, days);
  const groups = useMemo(() => {
    const map = new Map<string, { rule: string | null; total: number; reasons: Array<{ reason: string; n: number }>; runIds: string[] }>();
    for (const r of q.data ?? []) {
      const k = r.rule_applied ?? '';
      const g = map.get(k) ?? { rule: r.rule_applied, total: 0, reasons: [], runIds: [] };
      g.total += r.n; g.reasons.push({ reason: r.reason, n: r.n }); g.runIds.push(...(r.run_ids ?? []));
      map.set(k, g);
    }
    return [...map.values()].map((g) => ({ ...g, reasons: g.reasons.sort((a, b) => b.n - a.n) })).sort((a, b) => b.total - a.total);
  }, [q.data]);

  return (
    <Card title={`Cancelled replies by prompt rule · last ${days} days`}>
      <p className="text-sm text-gray-600 mb-4">When someone cancels a held reply, the reason is tied to the rule the AI was following. Fix the section it points at in the sequence&apos;s prompt, then test a conversation.</p>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox message={parseError(q.error).message} />}
      {!q.isLoading && !q.error && groups.length === 0 && <p className="text-sm text-gray-400">No cancelled replies in this period.</p>}
      <ul className="divide-y divide-gray-100">
        {groups.map((g) => {
          const section = REASON_SECTION[g.reasons[0]?.reason ?? ''];
          return (
            <li key={g.rule ?? '__none'} className="py-3 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-sm font-medium text-gray-900 min-w-0">{g.rule ?? <span className="text-gray-500 font-normal">No rule recorded</span>}</div>
                <span className="text-xs text-gray-500 tabular-nums">{g.total} cancelled</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {g.reasons.map((r) => <Badge key={r.reason} tone={r.reason === 'wrong_facts' || r.reason === 'too_early_to_pitch' ? 'amber' : 'gray'}>{cancelReasonLabel(r.reason)} · {r.n}</Badge>)}
              </div>
              {/* Without a place to open a run, its examples are left out: "Example 1" as plain text says nothing. */}
              {(section || (onOpenRun && g.runIds.length > 0)) && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  {section && <span className="text-gray-600">Review &ldquo;{section}&rdquo; in the sequence&apos;s prompt</span>}
                  {onOpenRun && g.runIds.slice(0, 5).map((id, i) => (
                    <button key={id} type="button" onClick={() => onOpenRun(id)} className="text-gray-600 hover:text-gray-900 hover:underline">Example {i + 1}</button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
