'use client';

// Pool change on a sequence that has leads (plan item 9): rpc rebalance_preview → choice → rpc set_pool.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { parseError, rpc } from '@/lib/outreach/api';
import type { Sender } from '@/lib/outreach/types';
import { Badge, Button, ErrorBox, Modal, Spinner, Table, Td, Th } from '@/components/outreach/ui';
import { senderName } from './helpers';
import { fmtInt, plural, type RebalancePreview, type SetPoolResult } from './publishTypes';

function Option({ name, checked, onSelect, title, children }: { name: string; checked: boolean; onSelect: () => void; title: string; children?: React.ReactNode }) {
  return (
    <label className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer ${checked ? 'border-indigo-500 bg-indigo-50/50' : 'border-gray-200 hover:bg-gray-50'}`}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="mt-0.5 text-indigo-600 focus:ring-indigo-500" />
      <span className="min-w-0"><span className="block text-sm font-medium text-gray-900">{title}</span>{children && <span className="block text-xs text-gray-600 mt-0.5">{children}</span>}</span>
    </label>
  );
}

export default function RebalanceDialog({ open, onClose, sequenceId, pool, senders, onApplied }: {
  open: boolean; onClose: () => void; sequenceId: string; pool: string[]; senders: Sender[]; onApplied: (pool: string[], result: SetPoolResult) => void;
}) {
  const poolKey = [...pool].sort().join(',');
  const q = useQuery({
    queryKey: ['outreach', 'sequence', sequenceId, 'rebalance_preview', poolKey],
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    queryFn: () => rpc<RebalancePreview>('rebalance_preview', { p_sequence: sequenceId, p_pool: pool }),
  });
  const [rebalance, setRebalance] = useState(true);
  const [contacted, setContacted] = useState<'keep' | 'exit'>('keep');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setRebalance(true); setContacted('keep'); setError(null); } }, [open, poolKey]);

  if (!open) return null;
  const p = q.data;
  const nameOf = (id: string, fallback?: string | null) => { const s = senders.find((x) => x.id === id); return s ? senderName(s) : fallback || 'Sender'; };
  const added = p?.added ?? [];
  const removed = p?.removed ?? [];
  const onRemoved = (p?.senders ?? []).filter((s) => !s.in_pool).reduce((a, s) => a + s.untouched, 0);
  const evenOut = Math.max((p?.would_move ?? 0) - onRemoved, 0);
  const list = (ids: string[]) => ids.map((id) => nameOf(id)).join(', ');

  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const r = await rpc<SetPoolResult>('set_pool', { p_sequence: sequenceId, p_pool: pool, p_rebalance: rebalance && evenOut > 0, p_contacted: removed.length > 0 ? contacted : 'keep' });
      onApplied(pool, r);
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  const headline = !p ? 'Change the sender pool'
    : added.length > 0 && evenOut > 0 ? `Move ${fmtInt(p.would_move)} waiting ${plural(p.would_move, 'lead')} to the new ${plural(added.length, 'sender')}?`
    : removed.length > 0 ? `Remove ${list(removed)} from the pool?`
    : 'Change the sender pool';

  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} title={headline} size="lg" footer={
      <>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button loading={busy} disabled={!p} onClick={apply} autoFocus>
          {p && ((rebalance && evenOut > 0) || onRemoved > 0) ? `Save pool and move ${fmtInt((rebalance ? evenOut : 0) + onRemoved)} ${plural((rebalance ? evenOut : 0) + onRemoved, 'lead')}` : 'Save pool'}
        </Button>
      </>
    }>
      {q.isLoading ? (
        <div className="py-8 text-center"><Spinner className="py-2" /><p className="text-sm text-gray-600">Counting the leads that can move…</p></div>
      ) : q.error ? (
        <div className="space-y-3"><ErrorBox message={parseError(q.error).message} /><Button size="sm" variant="secondary" onClick={() => q.refetch()}>Try again</Button></div>
      ) : p ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            {added.length > 0 && <>Adding <span className="font-medium">{list(added)}</span>. </>}
            {removed.length > 0 && <>Removing <span className="font-medium">{list(removed)}</span>. </>}
            {fmtInt(p.untouched_total)} {plural(p.untouched_total, 'lead')} in this sequence {p.untouched_total === 1 ? 'has' : 'have'} nothing sent yet.
          </p>

          <Table>
            <thead><tr><Th>Sender</Th><Th className="text-right">Nothing sent yet</Th><Th className="text-right">Already contacted</Th><Th className="text-right">Waiting after the move</Th></tr></thead>
            <tbody>
              {p.senders.map((s) => (
                <tr key={s.sender_id}>
                  <Td>
                    <span className="font-medium text-gray-900">{nameOf(s.sender_id, s.name)}</span>
                    {added.includes(s.sender_id) && <Badge tone="green" className="ml-2">New</Badge>}
                    {!s.in_pool && <Badge tone="red" className="ml-2">Removed</Badge>}
                    {s.status !== 'ok' && <Badge tone="amber" className="ml-2">Not connected</Badge>}
                  </Td>
                  <Td className="text-right tabular-nums">{fmtInt(s.untouched)}</Td>
                  <Td className="text-right tabular-nums">{fmtInt(s.contacted)}</Td>
                  <Td className="text-right tabular-nums">{rebalance || !s.in_pool ? fmtInt(s.after) : <span className="text-gray-400">{fmtInt(s.untouched)}</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="text-xs text-gray-500">{p.note} A lead never sees two senders.{rebalance && evenOut > 0 ? ` The target is about ${fmtInt(p.target_per_sender)} waiting ${plural(p.target_per_sender, 'lead')} per sender.` : ''}</p>

          {evenOut > 0 && (
            <fieldset disabled={busy} className="space-y-2">
              <legend className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Waiting leads</legend>
              <Option name="rebalance" checked={rebalance} onSelect={() => setRebalance(true)} title={`Move ${fmtInt(evenOut)} waiting ${plural(evenOut, 'lead')} so the pool is even`}>Their queued actions are planned again for the new sender, inside its daily limits.</Option>
              <Option name="rebalance" checked={!rebalance} onSelect={() => setRebalance(false)} title="Leave them where they are">Only leads enrolled from now on use the new pool.</Option>
            </fieldset>
          )}
          {removed.length > 0 && onRemoved > 0 && <p className="text-sm text-gray-700">{fmtInt(onRemoved)} {plural(onRemoved, 'lead')} of the removed {plural(removed.length, 'sender')} {onRemoved === 1 ? 'has' : 'have'} nothing sent yet and {onRemoved === 1 ? 'moves' : 'move'} to the other senders.</p>}
          {removed.length > 0 && p.contacted_on_removed > 0 && (
            <fieldset disabled={busy} className="space-y-2">
              <legend className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{fmtInt(p.contacted_on_removed)} {plural(p.contacted_on_removed, 'lead')} the removed {plural(removed.length, 'sender')} already contacted</legend>
              <Option name="contacted" checked={contacted === 'keep'} onSelect={() => setContacted('keep')} title={`Keep ${p.contacted_on_removed === 1 ? 'it' : 'them'} with this sender`}>The conversation stays in one place and the {plural(p.contacted_on_removed, 'lead')} {p.contacted_on_removed === 1 ? 'finishes' : 'finish'} the sequence with the same sender.</Option>
              <Option name="contacted" checked={contacted === 'exit'} onSelect={() => setContacted('exit')} title={`Exit ${p.contacted_on_removed === 1 ? 'it' : 'them'}`}>{fmtInt(p.contacted_on_removed)} {plural(p.contacted_on_removed, 'lead')} {p.contacted_on_removed === 1 ? 'leaves' : 'leave'} the sequence. History and chats are kept.</Option>
            </fieldset>
          )}
          {p.would_move === 0 && p.contacted_on_removed === 0 && <p className="text-sm text-gray-600">No waiting leads need to move. The new pool applies to leads enrolled from now on.</p>}
          {p.pool_size === 0 && <ErrorBox message="The pool would be empty. An active sequence needs at least one sender." />}
          {error && <ErrorBox message={error} />}
        </div>
      ) : null}
    </Modal>
  );
}
