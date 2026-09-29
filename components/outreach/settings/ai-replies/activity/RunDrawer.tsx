'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowRight, ExternalLink, HelpCircle, X } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { MODE_LABEL, MOVE_LABEL, STATUS_LABEL, useAiRun } from '@/lib/outreach/aiReplies';
import { Badge, Button, ErrorBox, Spinner, fmtDate } from '@/components/outreach/ui';
import { cancelReasonLabel, fmtSeconds, inboundToDraft, inboundToSent, reasonLabel, runReasons, stageLabel } from '../format';
import { DECISION_LABEL, STATUS_TONE } from './RunsTable';
import { Checks, ContextThread, FactsUsed, PolicySnapshot, Section, SideEffects, TextBlock } from './RunDetailSections';

/** Right-side drawer with everything about one AI reply run. */
export default function RunDrawer({ runId, stageLabels, onClose, onWhy }: {
  runId: string; stageLabels: Record<string, string>; onClose: () => void; onWhy: (id: string) => void;
}) {
  const q = useAiRun(runId);
  const r = q.data;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const edited = !!r?.draft_text && !!r.final_text && r.draft_text.trim() !== r.final_text.trim();
  const reasons = r ? runReasons(r) : [];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-2xl h-full bg-white shadow-xl flex flex-col" role="dialog" aria-modal="true" aria-label="AI reply details">
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-gray-200">
          <div className="min-w-0">
            {r && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={STATUS_TONE[r.status] ?? 'gray'}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                {r.mode && <Badge>{MODE_LABEL[r.mode]}</Badge>}
                {r.decision && <Badge tone="indigo">{DECISION_LABEL[r.decision]}</Badge>}
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
                <Button size="sm" variant="secondary" onClick={() => onWhy(r.id)}><HelpCircle className="w-3.5 h-3.5" />Why did it say that?</Button>
              </div>

              <Section title="Their message"><TextBlock text={r.inbound_text} /></Section>

              <div className="grid sm:grid-cols-2 gap-3">
                <Section title="AI draft"><TextBlock text={r.draft_text} tone="indigo" /></Section>
                <Section title={edited ? 'Sent (edited)' : 'Sent'}><TextBlock text={r.final_text} tone="green" /></Section>
              </div>

              <Section title="What it decided">
                <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-gray-500">Stage</dt>
                  <dd className="inline-flex items-center gap-1">{stageLabel(r.stage_before, stageLabels)}{r.stage_after && r.stage_after !== r.stage_before && <><ArrowRight className="w-3 h-3 text-gray-400" aria-label="to" />{stageLabel(r.stage_after, stageLabels)}</>}</dd>
                  <dt className="text-gray-500">Move</dt><dd>{r.move ? MOVE_LABEL[r.move] ?? r.move : '—'}</dd>
                  <dt className="text-gray-500">Rule followed</dt><dd>{r.rule_applied ?? '—'}</dd>
                  <dt className="text-gray-500">Confidence</dt><dd>{r.draft_confidence != null ? `${Math.round((r.draft_confidence <= 1 ? r.draft_confidence * 100 : r.draft_confidence))}%` : '—'}</dd>
                  <dt className="text-gray-500">Prompt version</dt><dd>{r.master_prompt?.version ?? r.master_prompt_version ?? '—'}</dd>
                  {r.cancel_reason && <><dt className="text-gray-500">Cancelled</dt><dd>{cancelReasonLabel(r.cancel_reason)}{r.cancel_note ? ` — ${r.cancel_note}` : ''}</dd></>}
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
              <Section title="Policy at the time"><PolicySnapshot run={r} /></Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
