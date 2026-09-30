'use client';

import { ArrowRight } from 'lucide-react';
import { STATUS_LABEL, type Decision, type RunStatus } from '@/lib/outreach/aiReplies';
import { MODE_LABEL_V2, type RunListItemV2 as RunListItem } from '@/lib/outreach/aiRepliesSequence';
import { Badge, Table, Td, Th, fmtDate, timeAgo } from '@/components/outreach/ui';
import { fmtSeconds, inboundToDraft, inboundToSent, reasonLabel, runReasons, stageLabel } from '../format';

type Tone = 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo' | 'purple';
export const STATUS_TONE: Record<RunStatus, Tone> = {
  debouncing: 'blue', drafting: 'blue', draft_ready: 'indigo', scheduled: 'purple', sending: 'purple', sent: 'green',
  escalated: 'amber', no_reply: 'gray', superseded: 'gray', cancelled: 'gray', failed: 'red', expired: 'gray',
};
export const DECISION_LABEL: Record<Decision, string> = { send: 'Reply', escalate: 'Hand to a person', no_reply: 'No reply' };

/** The runs list. Rows open the run drawer. */
export default function RunsTable({ rows, stageLabels, onOpen }: { rows: RunListItem[]; stageLabels: Record<string, string>; onOpen: (id: string) => void }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>When</Th><Th>Lead</Th><Th>Sender</Th><Th>Sequence</Th><Th>Stage</Th><Th>Status</Th><Th>Decision</Th><Th>Scenario</Th><Th>Reasons</Th>
          <Th title="Their message → draft ready / → sent">Timing</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const reasons = runReasons(r);
          const toDraft = inboundToDraft(r);
          const toSent = inboundToSent(r);
          return (
            <tr key={r.id} tabIndex={0} role="button" aria-label={`Open run for ${r.lead_name ?? 'lead'}`}
              onClick={() => onOpen(r.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r.id); } }}
              className="cursor-pointer hover:bg-gray-50 focus:outline-none focus-visible:bg-indigo-50 align-top">
              <Td className="whitespace-nowrap text-xs" title={fmtDate(r.created_at)}>{timeAgo(r.created_at)}</Td>
              <Td><span className="font-medium text-gray-900">{r.lead_name ?? 'Unknown lead'}</span></Td>
              <Td className="text-xs">{r.sender_name ?? '—'}</Td>
              <Td className="text-xs max-w-[10rem] truncate" title={r.sequence_name ?? undefined}>{r.sequence_name ?? '—'}</Td>
              <Td className="text-xs whitespace-nowrap">
                {r.stage_before || r.stage_after ? (
                  <span className="inline-flex items-center gap-1">
                    {stageLabel(r.stage_before, stageLabels)}
                    {r.stage_after && r.stage_after !== r.stage_before && <><ArrowRight className="w-3 h-3 text-gray-400" aria-label="to" />{stageLabel(r.stage_after, stageLabels)}</>}
                  </span>
                ) : '—'}
              </Td>
              <Td>
                <Badge tone={STATUS_TONE[r.status] ?? 'gray'}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                <div className="text-[11px] text-gray-500 mt-0.5">{r.mode ? MODE_LABEL_V2[r.mode] : ''}{r.trigger === 'manual' ? (r.mode ? ' · ' : '') + 'Draft with AI' : ''}</div>
              </Td>
              <Td className="text-xs">
                {r.decision ? DECISION_LABEL[r.decision] : '—'}
                {r.stop_after_send && <div className="text-[11px] text-amber-700" title={r.stop_rule ?? undefined}>Stops here</div>}
              </Td>
              <Td className="text-xs max-w-[10rem] truncate" title={r.scenario_title ?? undefined}>{r.scenario_title ?? <span className="text-gray-400">—</span>}</Td>
              <Td className="text-xs max-w-[16rem]">
                {reasons.length ? <span className="line-clamp-2" title={reasons.map(reasonLabel).join('\n')}>{reasons.map(reasonLabel).join('; ')}</span> : <span className="text-gray-400">—</span>}
              </Td>
              <Td className="text-xs whitespace-nowrap">
                <div>Draft {fmtSeconds(toDraft)}</div>
                <div className="text-gray-500">Sent {fmtSeconds(toSent)}</div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
