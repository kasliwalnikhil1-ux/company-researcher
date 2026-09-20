'use client';

// A/B results for one step (RPC ab_results) with "Promote winner" (RPC promote_variant). Used by message variants and the A/B split step.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown, Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import type { AbResults, AbVariantResult } from '@/lib/outreach/types';
import { Button, ErrorBox, Modal } from '@/components/outreach/ui';
import { useBuilder } from './context';

export function useAbResults(sequenceId: string | null | undefined, nodeId: string, enabled = true) {
  return useQuery<AbResults | null>({
    queryKey: ['outreach', 'sequence', sequenceId ?? '', 'ab_results', nodeId], enabled: !!sequenceId && enabled, staleTime: 60000, retry: false,
    queryFn: async () => {
      try { return await rpc<AbResults>('ab_results', { p_sequence: sequenceId, p_node_id: nodeId }); }
      catch (e) {
        if (parseError(e).code === 'E_NOT_FOUND') return null;   // a step that has not been saved yet has no results
        throw e;
      }
    },
  });
}

function pct(v: number | null | undefined): string { return v == null ? '—' : `${v}%`; }

function verdictTone(v: AbVariantResult): string {
  if (v.is_leading) return 'text-green-700';
  if (v.verdict_vs_leader === 'Very confident' || v.verdict_vs_leader === 'Confident') return 'text-red-700';
  if (v.verdict_vs_leader === 'Likely') return 'text-amber-700';
  return 'text-gray-500';
}

interface Props {
  nodeId: string;
  /** Called after a promote so the open draft takes the new weights (variant id → 100, the rest → 0). */
  onPromoted?: (variantId: string) => void;
}

export default function VariantResults({ nodeId, onPromoted }: Props) {
  const { sequenceId, sequence, readOnly } = useBuilder();
  const qc = useQueryClient();
  // a sequence that was never activated has sent nothing, so there is nothing to ask for
  const results = useAbResults(sequenceId, nodeId, sequence.status !== 'draft');
  const [confirm, setConfirm] = useState<AbVariantResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (results.isLoading) return <p className="text-xs text-gray-400">Loading results…</p>;
  if (results.error) return <ErrorBox message={parseError(results.error).message} className="!text-xs !p-2" />;
  const data = results.data;
  const rows = (data?.variants ?? []).filter((v) => v.sent > 0 || v.variant_id !== '');
  if (!data || rows.every((v) => v.sent === 0)) return null;

  const isInvite = data.node_type === 'send_invite';
  const isSplit = data.node_type === 'ab_split';
  const judged = data.judged_on === 'accepted' ? 'acceptance rate' : 'interested replies';

  const promote = async () => {
    if (!confirm) return;
    setBusy(true); setError(null);
    try {
      await rpc('promote_variant', { p_sequence: sequenceId, p_node_id: nodeId, p_variant: confirm.variant_id });
      onPromoted?.(confirm.variant_id);
      qc.invalidateQueries({ queryKey: qk.sequence(sequenceId) });
      qc.invalidateQueries({ queryKey: qk.sequenceVersions(sequenceId) });
      qc.invalidateQueries({ queryKey: ['outreach', 'sequence', sequenceId, 'ab_results', nodeId] });
      setConfirm(null);
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-gray-700 flex items-center gap-1"><Trophy className="w-3.5 h-3.5 text-amber-500" aria-hidden /> Results so far</h4>
        <span className="text-[11px] text-gray-400">{data.period.from} to {data.period.to}</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-[11px]">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              <th scope="col" className="text-left font-medium px-2 py-1.5">{isSplit ? 'Branch' : 'Variant'}</th>
              <th scope="col" className="text-right font-medium px-2 py-1.5">{isSplit ? 'Leads' : 'Sent'}</th>
              {(isInvite || isSplit) && <th scope="col" className="text-right font-medium px-2 py-1.5">Accepted</th>}
              <th scope="col" className="text-right font-medium px-2 py-1.5">Replies</th>
              <th scope="col" className="text-right font-medium px-2 py-1.5">Interested</th>
              <th scope="col" className="text-left font-medium px-2 py-1.5">Against the leader</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.variant_id || 'none'} className={cn('border-t border-gray-100', v.is_leading && 'bg-green-50/50')}>
                <th scope="row" className="text-left font-medium text-gray-800 px-2 py-1.5 whitespace-nowrap">
                  {v.is_leading && data.enough_data && <Crown className="w-3 h-3 text-amber-500 inline mr-1 -mt-0.5" aria-label="Leading" />}
                  {v.label}
                </th>
                <td className="text-right tabular-nums px-2 py-1.5">{v.sent.toLocaleString()}</td>
                {(isInvite || isSplit) && <td className="text-right tabular-nums px-2 py-1.5">{v.accepted.toLocaleString()} <span className="text-gray-400">({pct(v.acceptance_rate)})</span></td>}
                <td className="text-right tabular-nums px-2 py-1.5">{v.replies.toLocaleString()} <span className="text-gray-400">({pct(v.reply_rate)})</span></td>
                <td className="text-right tabular-nums px-2 py-1.5">{v.interested.toLocaleString()} <span className="text-gray-400">({pct(v.interested_rate)})</span></td>
                <td className={cn('px-2 py-1.5', verdictTone(v))}>
                  {v.is_leading ? (data.enough_data ? 'Leading' : 'Ahead so far') : v.verdict_vs_leader ?? '—'}
                  {!v.is_leading && v.confidence_vs_leader != null && data.enough_data && <span className="text-gray-400"> · {v.confidence_vs_leader}%</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-500 leading-4">
        Judged on {judged}. {data.enough_data ? 'Every variant has enough sends to compare.' : `No winner is declared under ${data.min_sends_per_variant} sends per ${isSplit ? 'branch' : 'variant'}.`}
      </p>
      {!isSplit && !readOnly && (() => {
        const leader = rows.find((v) => v.is_leading && v.variant_id !== '');
        if (!leader) return null;
        return (
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={!data.can_promote} onClick={() => { setError(null); setConfirm(leader); }}>
              <Crown className="w-3.5 h-3.5" aria-hidden /> Promote winner
            </Button>
            {!data.can_promote && <span className="text-[11px] text-gray-500">Available once the leader is clearly ahead of every other variant.</span>}
          </div>
        );
      })()}

      <Modal open={!!confirm} onClose={() => { if (!busy) setConfirm(null); }} title={`Promote ${confirm?.label ?? 'variant'}?`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setConfirm(null)} disabled={busy}>Cancel</Button><Button onClick={promote} loading={busy}>Promote and publish</Button></>}>
        <div className="space-y-2 text-sm text-gray-700">
          <p><span className="font-medium">{confirm?.label}</span> goes to 100% and the other variants to 0%. This publishes a new version of the sequence right away.</p>
          <p className="text-xs text-gray-500">Messages already queued for this step are updated to the winning text. The other variants stay in the step, so you can turn them back on later.</p>
          {error && <ErrorBox message={error} />}
        </div>
      </Modal>
    </div>
  );
}
