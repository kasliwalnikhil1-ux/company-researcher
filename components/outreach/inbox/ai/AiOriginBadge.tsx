'use client';

import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { Bot, Loader2, Smartphone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import { MOVE_LABEL, ORIGIN_LABEL, useAiRun } from '@/lib/outreach/aiReplies';
import type { MessageOrigin } from '@/lib/outreach/types';
import { humanizeKey } from './useAiInbox';

const AI_ORIGINS: MessageOrigin[] = ['ai_autopilot', 'ai_draft_sent', 'ai_edited'];

/** True for outbound origins that get a badge ("AI — autopilot", "Sent from phone" …). */
export function hasOriginBadge(origin: MessageOrigin | undefined | null): boolean {
  return !!origin && (AI_ORIGINS.includes(origin) || origin === 'external_device');
}
export function isAiOrigin(origin: MessageOrigin | undefined | null): boolean {
  return !!origin && AI_ORIGINS.includes(origin);
}

/** "AI draft — sent by Naman", "AI draft — edited by Naman", "AI — autopilot", "Sent from phone". */
export function originText(origin: MessageOrigin, sentByName: string | null | undefined): string {
  if (origin === 'ai_draft_sent' && sentByName) return `AI draft — sent by ${sentByName}`;
  if (origin === 'ai_edited' && sentByName) return `AI draft — edited by ${sentByName}`;
  return ORIGIN_LABEL[origin] ?? humanizeKey(origin);
}

function RunDetails({ runId }: { runId: string }) {
  const q = useAiRun(runId);
  if (q.isLoading) return <div className="flex items-center gap-1.5 text-xs text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>;
  if (q.error) return <div className="text-xs text-red-600">{parseError(q.error).message}</div>;
  const r = q.data;
  if (!r) return null;
  const stage = [r.stage_before, r.stage_after].filter(Boolean).map((k) => humanizeKey(k as string));
  const rows: Array<[string, React.ReactNode]> = [];
  if (r.master_prompt_version != null) rows.push(['Master prompt', `v${r.master_prompt_version}`]);
  if (r.rule_applied) rows.push(['Rule followed', r.rule_applied]);
  if (stage.length) rows.push(['Stage', stage[0] === stage[1] || stage.length === 1 ? stage[0] : `${stage[0]} → ${stage[1]}`]);
  if (r.move) rows.push(['Move', MOVE_LABEL[r.move] ?? r.move]);
  if (r.draft_confidence != null) rows.push(['Confidence', `${Math.round(r.draft_confidence * 100)}%`]);
  const v = r.verifier;
  return (
    <div className="space-y-2 text-xs">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, val]) => <div key={k} className="contents"><dt className="text-gray-500">{k}</dt><dd className="text-gray-800 break-words">{val}</dd></div>)}
      </dl>
      {!!r.facts_used?.length && (
        <div>
          <div className="text-gray-500 mb-0.5">Facts used</div>
          <ul className="space-y-0.5">{r.facts_used.map((f, i) => <li key={i} className="text-gray-800">“{f.claim}” <span className="text-gray-400">· {humanizeKey(f.source.replace(/^master_prompt\./, ''))}</span></li>)}</ul>
        </div>
      )}
      {v && (
        <div className={cn('rounded-md px-2 py-1', v.supported && v.follows_rule && v.answers_their_questions ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800')}>
          <div className="font-medium">{v.supported && v.follows_rule && v.answers_their_questions ? 'Checked: every claim is backed by your prompt' : 'Check found issues'}</div>
          {!v.supported && !!v.unsupported_claims?.length && <div>Not backed: {v.unsupported_claims.join('; ')}</div>}
          {!v.follows_rule && <div>Did not follow the stage rule</div>}
          {!v.answers_their_questions && <div>Did not answer all their questions</div>}
          {v.note && <div className="opacity-80">{v.note}</div>}
        </div>
      )}
      {r.validator && !r.validator.ok && !!r.validator.failures?.length && (
        <div className="text-amber-800">Rule checks: {r.validator.failures.map((f) => f.detail || f.rule).join('; ')}</div>
      )}
    </div>
  );
}

/**
 * Who produced an outbound message, under the bubble. AI badges open the run's details (master prompt version, rule
 * followed, facts used, check result) on click; the details are fetched only then.
 */
export default function AiOriginBadge({ origin, runId, sentByName, align = 'right' }: { origin: MessageOrigin; runId: string | null | undefined; sentByName?: string | null; align?: 'left' | 'right' }) {
  const { canWrite } = useWorkspace();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const label = originText(origin, sentByName);
  // run details are for members and up (ai_reply_run_get); client viewers see the plain chip
  const canOpen = !!runId && canWrite;
  if (!isAiOrigin(origin)) {
    return <div className="flex items-center gap-1 mt-1 text-[11px] text-gray-500"><Smartphone className="w-3 h-3 text-gray-400" aria-hidden />{label}</div>;
  }
  const chip = 'inline-flex items-center gap-1 text-[11px] px-1.5 py-px rounded bg-violet-50 text-violet-700 border border-violet-100';
  return (
    <div ref={ref} className="relative mt-1">
      {canOpen
        ? <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Why the AI wrote this" className={cn(chip, 'hover:bg-violet-100')}><Bot className="w-3 h-3" aria-hidden />{label}</button>
        : <span className={chip}><Bot className="w-3 h-3" aria-hidden />{label}</span>}
      {open && canOpen && (
        <div className={cn('absolute z-20 top-full mt-1 w-80 max-w-[80vw] rounded-lg border border-gray-200 bg-white shadow-lg p-3', align === 'right' ? 'right-0' : 'left-0')} role="dialog" aria-label="AI reply details">
          <RunDetails runId={runId} />
        </div>
      )}
    </div>
  );
}
