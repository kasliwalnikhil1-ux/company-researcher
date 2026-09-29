'use client';

import { useMemo } from 'react';
import { ArrowRight } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { useCancelReport } from '@/lib/outreach/aiReplies';
import { Badge, Card, ErrorBox, Spinner } from '@/components/outreach/ui';
import { cancelReasonLabel } from '../format';

/** Which master-prompt section a cancel reason usually points at. */
const REASON_SECTION: Record<string, string> = {
  too_early_to_pitch: 'How a conversation goes — stages and when to pitch',
  wrong_facts: 'Facts I can use',
  wrong_tone: 'Style',
  shouldnt_reply: 'Situations',
  answer_myself: 'Hand to a person when',
};

/** Cancelled AI replies grouped by the master-prompt rule the AI followed, so each points at the section to fix. */
export default function CancelReport({ ws, days, onOpenPrompt, onOpenRun }: { ws: string; days: number; onOpenPrompt: () => void; onOpenRun: (id: string) => void }) {
  const q = useCancelReport(ws, days);
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
      <p className="text-sm text-gray-600 mb-4">When someone cancels a held reply, the reason is tied to the rule the AI was following. Fix the section it points at, then re-run the simulator.</p>
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
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                {section && (
                  <button type="button" onClick={onOpenPrompt} className="inline-flex items-center gap-1 text-indigo-600 hover:underline">
                    Review “{section}” in the master prompt<ArrowRight className="w-3 h-3" aria-hidden="true" />
                  </button>
                )}
                {g.runIds.slice(0, 5).map((id, i) => (
                  <button key={id} type="button" onClick={() => onOpenRun(id)} className="text-gray-600 hover:text-gray-900 hover:underline">Example {i + 1}</button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
