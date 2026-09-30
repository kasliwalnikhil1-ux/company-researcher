'use client';

import { useState } from 'react';
import { Bot, Check, ChevronDown, OctagonX, X } from 'lucide-react';
import { ESCALATION_LABEL, FLAG_LABEL, GATE_LABEL, MOVE_LABEL } from '@/lib/outreach/aiReplies';
import type { SideEffect, SimulateResult } from '@/lib/outreach/aiReplies';
import type { SimulateResultV2 } from '@/lib/outreach/aiRepliesSequence';
import { Badge } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { DECISION_LABEL, aiSent, flagsOf } from './simModel';

function sideEffectText(s: SideEffect): string {
  if (s.type === 'archive') return 'Archive the chat';
  if (s.type === 'mark_read') return 'Mark as read';
  if (s.type === 'set_tag') return `Tag the lead${s.tag ? `: ${s.tag}` : ''}`;
  if (s.kind === 'contact_referral') return `Task: reach out to ${[s.name, s.contact].filter(Boolean).join(', ') || 'the person they named'}`;
  return `Task: follow up${s.due ? ` on ${s.due}` : ''}${s.note ? `: ${s.note}` : ''}`;
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex gap-3 py-1"><dt className="w-32 flex-shrink-0 text-gray-500">{label}</dt><dd className="min-w-0 text-gray-800">{children}</dd></div>
);

const Ok = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <span className="inline-flex items-center gap-1">{ok ? <Check className="w-3.5 h-3.5 text-green-600" aria-label="Passed" /> : <X className="w-3.5 h-3.5 text-red-600" aria-label="Failed" />}{children}</span>
);

/** One AI turn in the test conversation: the reply (or what it decided instead), the stage, the scenario, what it used and why. */
export default function TurnResult({ r: raw, stageLabel }: { r: SimulateResult; stageLabel: (k: string | null | undefined) => string }) {
  const r = raw as SimulateResultV2;
  const [open, setOpen] = useState(false);
  const sent = aiSent(r);
  const flags = flagsOf(r.classification);
  const failedGates = r.gates.filter((g) => !g.ok);
  const vFails = r.validator?.failures ?? [];
  const tone = r.final_decision === 'send' ? 'green' : r.final_decision === 'escalate' ? 'amber' : 'gray';
  const knowledge = r.knowledge_used ?? [];
  const faqs = r.faqs_used ?? [];

  return (
    <div className="flex gap-2 justify-end">
      <div className="max-w-[85%] w-full sm:w-auto sm:min-w-[320px] space-y-1.5">
        {sent ? (
          <div className="rounded-2xl rounded-br-sm bg-indigo-600 text-white px-3.5 py-2 text-sm whitespace-pre-wrap break-words">{r.text}</div>
        ) : (
          <div className="rounded-2xl rounded-br-sm border border-dashed border-gray-300 bg-white px-3.5 py-2 text-sm text-gray-600">
            <span className="font-medium text-gray-900">{DECISION_LABEL[r.final_decision]}</span>
            {r.final_decision === 'escalate' && r.escalation_reasons.length > 0 && <>: {r.escalation_reasons.map((x) => ESCALATION_LABEL[x] ?? x).join('; ')}</>}
            {r.text && <div className="mt-1.5 text-xs text-gray-500 whitespace-pre-wrap break-words"><span className="font-medium">Draft that was held back:</span> {r.text}</div>}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-1.5 text-xs">
          <Badge tone={tone}>{DECISION_LABEL[r.final_decision]}</Badge>
          {r.decision !== r.final_decision && <Badge tone="amber" className="cursor-help"><span title="What the AI wanted before the checks">AI wanted: {DECISION_LABEL[r.decision]}</span></Badge>}
          {r.redrafted && <Badge tone="purple">Redrafted</Badge>}
          {r.scenario_title && <Badge tone="indigo">Handled by: {r.scenario_title}</Badge>}
          <span className="text-gray-500">Stage {stageLabel(r.stage_before)} → {stageLabel(r.stage_after)}</span>
          {r.move && <span className="text-gray-500">· {MOVE_LABEL[r.move] ?? r.move}</span>}
          <span className="text-gray-500">· {Math.round((r.confidence ?? 0) * 100)}% sure</span>
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-center gap-0.5 text-indigo-700 hover:text-indigo-900">
            Why <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        </div>
        {r.would_stop && (
          <div className="flex items-center justify-end gap-1 text-xs text-amber-800"><OctagonX className="w-3.5 h-3.5" aria-hidden="true" />Would stop here: {r.stop_rule || 'a Stop rule was met'}</div>
        )}
        {r.rule_applied && <div className="text-right text-xs text-gray-500">Followed: <span className="text-gray-800">{r.rule_applied}</span></div>}
        {open && (
          <dl className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs divide-y divide-gray-50">
            <Row label="Their message">{flags.length ? <span className="flex flex-wrap gap-1">{flags.map((f) => <Badge key={f} tone="blue">{FLAG_LABEL[f] ?? f}</Badge>)}</span> : 'Nothing special detected'}</Row>
            {r.session && r.session !== 'normal' && <Row label="Session">{r.session === 'dormant' ? 'Dormant, Re-engage' : 'Returning after a gap'}</Row>}
            <Row label="Checks before drafting">{failedGates.length ? failedGates.map((g) => <div key={g.gate}><Ok ok={false}>{GATE_LABEL[g.gate] ?? g.gate}{g.detail ? ` (${g.detail})` : ''}</Ok></div>) : <Ok ok>All passed{r.gates.length ? ` (${r.gates.length})` : ''}</Ok>}</Row>
            <Row label="Rule check">{!r.validator ? 'Not run' : r.validator.ok ? <Ok ok>Passed</Ok> : vFails.map((f, i) => <div key={i}><Ok ok={false}>{f.detail || f.rule}</Ok></div>)}</Row>
            <Row label="Fact check">{!r.verifier ? 'Not run' : (
              <div className="space-y-0.5">
                <Ok ok={r.verifier.supported}>Claims backed by the prompt or knowledge</Ok>
                {r.verifier.unsupported_claims.length > 0 && <div className="text-red-700 pl-4">Not backed: {r.verifier.unsupported_claims.join('; ')}</div>}
                <div><Ok ok={r.verifier.follows_rule}>Follows the rule it named</Ok></div>
                <div><Ok ok={r.verifier.answers_their_questions}>Answers their questions</Ok></div>
                {r.verifier.note && <div className="text-gray-500 pl-4">{r.verifier.note}</div>}
              </div>
            )}</Row>
            {r.escalation_reasons.length > 0 && <Row label="Handed over because">{r.escalation_reasons.map((x) => ESCALATION_LABEL[x] ?? x).join('; ')}</Row>}
            {r.facts_used.length > 0 && <Row label="Facts used">{r.facts_used.map((f, i) => <div key={i}>{f.claim} <span className="text-gray-400">({f.source})</span></div>)}</Row>}
            {(knowledge.length > 0 || faqs.length > 0) && (
              <Row label="Knowledge used">
                {knowledge.map((k, i) => <div key={`k${i}`} title={k.text}>{k.title ?? k.url ?? 'Source'}{k.heading ? ` · ${k.heading}` : ''}</div>)}
                {faqs.map((q, i) => <div key={`f${i}`}>Q&amp;A: {q}</div>)}
              </Row>
            )}
            {r.unanswered_question && <Row label="Could not answer">{r.unanswered_question}</Row>}
            {r.side_effects.length > 0 && <Row label="Would also">{r.side_effects.map((s, i) => <div key={i}>{sideEffectText(s)}</div>)}</Row>}
            <Row label="Model">{r.model ?? 'n/a'} · {(r.ms / 1000).toFixed(1)} s</Row>
          </dl>
        )}
      </div>
      <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center flex-shrink-0 mt-0.5" aria-hidden="true"><Bot className="w-4 h-4" /></div>
    </div>
  );
}
