'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowRight, ExternalLink, Settings2, X } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { MOVE_LABEL, STATUS_LABEL } from '@/lib/outreach/aiReplies';
import { MODE_LABEL_V2, SESSION_LABEL, useAiRunV2, warningText } from '@/lib/outreach/aiRepliesSequence';
import { Badge, ErrorBox, Spinner, fmtDate } from '@/components/outreach/ui';
import { cancelReasonLabel, fmtSeconds, inboundToDraft, inboundToSent, reasonLabel, runReasons, stageLabel } from '../format';
import { DECISION_LABEL, STATUS_TONE } from './RunsTable';
import { Checks, ContextThread, FactsUsed, PolicySnapshot, Section, SideEffects, TextBlock } from './RunDetailSections';

/** Right-side drawer with everything about one AI reply run. */
export default function RunDrawer({ runId, stageLabels, onClose }: { runId: string; stageLabels: Record<string, string>; onClose: () => void }) {
  const q = useAiRunV2(runId);
  const r = q.data;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const edited = !!r?.draft_text && !!r.final_text && r.draft_text.trim() !== r.final_text.trim();
  const reasons = r ? runReasons(r) : [];
  const warnings = (r?.warnings ?? []).map(warningText).filter(Boolean);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-2xl h-full bg-white shadow-xl flex flex-col" role="dialog" aria-modal="true" aria-label="AI reply details">
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-gray-200">
          <div className="min-w-0">
            {r && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={STATUS_TONE[r.status] ?? 'gray'}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                {r.mode && <Badge>{MODE_LABEL_V2[r.mode]}</Badge>}
                <Badge tone={r.trigger === 'manual' ? 'purple' : 'gray'}>{r.trigger === 'manual' ? 'Draft with AI' : 'Automatic'}</Badge>
                {r.decision && <Badge tone="indigo">{DECISION_LABEL[r.decision]}</Badge>}
                {r.scenario_title && <Badge tone="blue">Handled by: {r.scenario_title}</Badge>}
              </div>
            )}
            <h2 className="text-base font-semibold text-gray-900 mt-1 truncate">{r?.lead_name ?? 'AI reply'}</h2>
            {r && (
              <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-3">
                <span>{r.sender_name ?? 'Sender'}</span>
                {r.sequence_name && <span>{r.sequence_name}</span>}
                <span>{fmtDate(r.created_at)}</span>
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-md hover:bg-gray-100 text-gray-500" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {q.isLoading && <Spinner />}
          {q.error && <ErrorBox message={parseError(q.error).message} />}
          {r && (
            <>
              <div className="flex flex-wrap gap-2">
                <Link href={`/outreach/inbox/${r.chat_id}`} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                  <ExternalLink className="w-3.5 h-3.5" />Open thread
                </Link>
                {r.sequence_id && (
                  <Link href={`/outreach/sequences/${r.sequence_id}?tab=ai`} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                    <Settings2 className="w-3.5 h-3.5" />Sequence AI Auto Replies
                  </Link>
                )}
              </div>

              {r.stop_after_send && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Ends the AI conversation when sent{r.stop_rule ? `: ${r.stop_rule}` : ''}.</div>
              )}
              {warnings.length > 0 && (
                <Section title="Warnings shown to the person">
                  <ul className="list-disc ml-5 space-y-0.5 text-sm text-gray-700">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </Section>
              )}

              <Section title="Their message"><TextBlock text={r.inbound_text} /></Section>
              {r.guidance && <Section title="Instruction from the person"><TextBlock text={r.guidance} tone="indigo" /></Section>}

              <div className="grid sm:grid-cols-2 gap-3">
                <Section title="AI draft"><TextBlock text={r.draft_text} tone="indigo" /></Section>
                <Section title={edited ? 'Sent (edited)' : 'Sent'}><TextBlock text={r.final_text} tone="green" /></Section>
              </div>

              <Section title="What it decided">
                <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-gray-500">Stage</dt>
                  <dd className="inline-flex items-center gap-1">{stageLabel(r.stage_before, stageLabels)}{r.stage_after && r.stage_after !== r.stage_before && <><ArrowRight className="w-3 h-3 text-gray-400" aria-label="to" />{stageLabel(r.stage_after, stageLabels)}</>}</dd>
                  <dt className="text-gray-500">Move</dt><dd>{r.move ? MOVE_LABEL[r.move] ?? r.move : '—'}</dd>
                  <dt className="text-gray-500">Scenario</dt><dd>{r.scenario_title ?? 'None (a stage rule drove the reply)'}</dd>
                  <dt className="text-gray-500">Rule followed</dt><dd>{r.rule_applied ?? '—'}</dd>
                  <dt className="text-gray-500">Session</dt><dd>{r.session_kind ? SESSION_LABEL[r.session_kind] ?? r.session_kind : 'Normal'}{r.gap_days != null && r.gap_days > 0 ? ` · came back after ${r.gap_days} days` : ''}</dd>
                  <dt className="text-gray-500">Trigger</dt><dd>{r.trigger === 'manual' ? 'A person pressed Draft with AI' : 'Their message'}</dd>
                  <dt className="text-gray-500">Confidence</dt><dd>{r.draft_confidence != null ? `${Math.round((r.draft_confidence <= 1 ? r.draft_confidence * 100 : r.draft_confidence))}%` : '—'}</dd>
                  <dt className="text-gray-500">Prompt version</dt><dd>{r.master_prompt?.version ?? r.master_prompt_version ?? '—'}</dd>
                  {r.cancel_reason && <><dt className="text-gray-500">Cancelled</dt><dd>{cancelReasonLabel(r.cancel_reason)}{r.cancel_note ? `: ${r.cancel_note}` : ''}</dd></>}
                  <dt className="text-gray-500">Timing</dt>
                  <dd>Draft ready {fmtSeconds(inboundToDraft(r))} after their message{r.timings?.sent_at ? `, sent after ${fmtSeconds(inboundToSent(r))}` : ''}{r.scheduled_send_at && !r.timings?.sent_at ? ` · scheduled ${fmtDate(r.scheduled_send_at)}` : ''}</dd>
                </dl>
              </Section>

              {reasons.length > 0 && (
                <Section title="Why it was held back">
                  <ul className="list-disc ml-5 space-y-0.5 text-sm text-gray-700">{reasons.map((x) => <li key={x}>{reasonLabel(x)}</li>)}</ul>
                </Section>
              )}

              <Section title="Checks"><Checks run={r} /></Section>
              <Section title="Facts used"><FactsUsed run={r} /></Section>
              <Section title="Other actions"><SideEffects run={r} /></Section>
              <Section title="Conversation it saw"><ContextThread run={r} /></Section>
              <Section title="Settings at the time"><PolicySnapshot run={r} /></Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
