'use client';

import type { ReactNode } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { RunDetail } from '@/lib/outreach/aiReplies';
import { fmtDate } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';

export function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">{title}</h3>
      {children}
    </section>
  );
}

export function TextBlock({ text, tone = 'gray' }: { text: string | null | undefined; tone?: 'gray' | 'indigo' | 'green' }) {
  const tones = { gray: 'bg-gray-50 border-gray-200', indigo: 'bg-indigo-50 border-indigo-100', green: 'bg-green-50 border-green-100' };
  if (!text) return <p className="text-sm text-gray-400">—</p>;
  return <div className={cn('rounded-lg border px-3 py-2 text-sm text-gray-800 whitespace-pre-wrap break-words', tones[tone])}>{text}</div>;
}

const Check = ({ ok, children }: { ok: boolean; children: ReactNode }) => (
  <li className="flex items-start gap-1.5 text-sm text-gray-700">
    {ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-green-600 flex-shrink-0" aria-label="Pass" /> : <XCircle className="w-4 h-4 mt-0.5 text-red-600 flex-shrink-0" aria-label="Fail" />}
    <span>{children}</span>
  </li>
);

/** Code checks (links, numbers, contact details, length) and the model check of every claim. */
export function Checks({ run }: { run: RunDetail }) {
  const v = run.validator; const vf = run.verifier;
  if (!v && !vf) return <p className="text-sm text-gray-400">Not checked.</p>;
  return (
    <ul className="space-y-1">
      {v && <Check ok={v.ok}>Rule check {v.ok ? 'passed' : 'failed'}</Check>}
      {v?.failures?.map((f, i) => <li key={i} className="ml-6 text-xs text-red-700">{f.rule}: {f.detail}</li>)}
      {vf && (
        <>
          <Check ok={vf.supported}>Every claim is backed by the prompt</Check>
          {vf.unsupported_claims?.map((c, i) => <li key={i} className="ml-6 text-xs text-red-700">Not backed: “{c}”</li>)}
          <Check ok={vf.follows_rule}>Follows the rule it applied</Check>
          <Check ok={vf.answers_their_questions}>Answers their questions</Check>
          {vf.note && <li className="ml-6 text-xs text-gray-600">{vf.note}</li>}
        </>
      )}
    </ul>
  );
}

export function FactsUsed({ run }: { run: RunDetail }) {
  if (!run.facts_used?.length) return <p className="text-sm text-gray-400">No facts used.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {run.facts_used.map((f, i) => <li key={i}><span className="text-gray-800">{f.claim}</span> <span className="text-xs text-gray-500">— {f.source}</span></li>)}
    </ul>
  );
}

export function SideEffects({ run }: { run: RunDetail }) {
  if (!run.side_effects?.length) return <p className="text-sm text-gray-400">None.</p>;
  const text = (s: NonNullable<RunDetail['side_effects']>[number]) => {
    if (s.type === 'task') return `Task: ${s.kind === 'contact_referral' ? `contact ${s.name ?? 'the referral'}${s.contact ? ` (${s.contact})` : ''}` : 'follow up'}${s.due ? ` · due ${fmtDate(s.due, false)}` : ''}${s.note ? ` — ${s.note}` : ''}`;
    if (s.type === 'archive') return 'Archive the chat';
    if (s.type === 'mark_read') return 'Mark as read';
    if (s.type === 'set_tag') return `Tag: ${s.tag ?? ''}`;
    return s.type;
  };
  return <ul className="list-disc ml-5 space-y-0.5 text-sm text-gray-700">{run.side_effects.map((s, i) => <li key={i}>{text(s)}</li>)}</ul>;
}

const FROM_LABEL: Record<string, string> = { prospect: 'Them', us: 'Us', teammate: 'Teammate', ai: 'AI' };

/** The conversation the draft was written from. */
export function ContextThread({ run }: { run: RunDetail }) {
  const thread = run.context?.thread ?? [];
  const state = run.context?.state;
  return (
    <div className="space-y-2">
      {state && (
        <p className="text-xs text-gray-500">
          At the time: stage {state.stage ?? 'not set'}{state.stage_stale ? ' (re-inferred)' : ''} · {state.exchanges} exchanges · {state.ai_replies_count} AI replies{state.last_move ? ` · last move ${state.last_move}` : ''}
        </p>
      )}
      {thread.length === 0 ? <p className="text-sm text-gray-400">No thread saved.</p> : (
        <ol className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
          {thread.map((m, i) => (
            <li key={i} className={cn('rounded-lg px-3 py-1.5 text-sm max-w-[90%] whitespace-pre-wrap break-words', m.from === 'prospect' ? 'bg-gray-100 text-gray-800' : 'bg-indigo-50 text-indigo-900 ml-auto')}>
              <div className="text-[10px] uppercase tracking-wide opacity-60">{FROM_LABEL[m.from] ?? m.from}{m.at ? ` · ${fmtDate(m.at)}` : ''}</div>
              {m.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The policy values the run was decided with, as a key/value list. */
export function PolicySnapshot({ run }: { run: RunDetail }) {
  const entries = Object.entries(run.policy_snapshot ?? {});
  if (!entries.length) return <p className="text-sm text-gray-400">Not recorded.</p>;
  const show = (v: unknown) => (v == null ? '—' : Array.isArray(v) ? v.join(', ') || 'none' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-0.5 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-gray-500">{k.replace(/_/g, ' ')}</dt><dd className="text-gray-800 break-words">{show(v)}</dd></div>
      ))}
    </dl>
  );
}
