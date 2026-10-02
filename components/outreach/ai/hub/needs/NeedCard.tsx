'use client';

import { useState, type ReactNode } from 'react';
import Link from '@/lib/outreach/nav';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { NEEDS_YOU_TYPE_ONE, needsYouReason, whoHref, whoText, type NeedsYouRow, type NeedsYouType } from '@/lib/outreach/aiHub';
import { Badge, fmtDate, timeAgo } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';

const TYPE_TONE: Record<NeedsYouType, 'indigo' | 'purple' | 'pink' | 'blue' | 'amber' | 'gray'> = { reply: 'indigo', line: 'purple', draft: 'pink', website: 'blue', question: 'amber', profile: 'gray' };

/** A link that looks like the small secondary button, for actions that open another page. */
export const linkButton = 'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap px-2.5 py-1.5 text-xs bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';

/** A card waits for a plain review when nothing but "a person approves this" holds it. */
const plainReview = (row: NeedsYouRow) => row.state === 'review' && (!row.reason || row.reason === 'review');

/**
 * The one card layout of Needs you, the same for every type:
 *   header (type · where · who ··· time) → what triggered it → what the AI wrote → why it is waiting → actions
 * `hidden` keeps the card mounted while it is optimistically removed, so an edit survives a failed call.
 */
export default function NeedCard({ row, hidden, lead, trigger, ai, extra, reason, busy, actions }: {
  row: NeedsYouRow; hidden: boolean;
  /** In front of the header: the checkbox of a line card. */
  lead?: ReactNode;
  trigger?: ReactNode; ai?: ReactNode;
  /** Small print between the AI text and the reason: facts, sources, examples. */
  extra?: ReactNode;
  /** Overrides the worded reason (`needsYouReason`). */
  reason?: string;
  /** The AI is still working on this card: a spinner instead of the warning icon. */
  busy?: boolean;
  actions?: ReactNode;
}) {
  const who = whoText(row);
  const href = whoHref(row);
  const warn = !busy && !plainReview(row);
  const dot = <span className="text-gray-300" aria-hidden="true">·</span>;
  return (
    <li hidden={hidden} className="px-4 py-3.5">
      <div className="flex items-center gap-2 min-w-0 text-sm">
        {lead}
        <Badge tone={TYPE_TONE[row.type] ?? 'gray'}>{NEEDS_YOU_TYPE_ONE[row.type] ?? row.type}</Badge>
        {row.where_name && <>{dot}<span className="truncate min-w-0 text-gray-700 max-w-[16rem]" title={row.where_name}>{row.where_name}</span></>}
        {who && <>{dot}{href
          ? <Link href={href} className="truncate min-w-0 font-medium text-gray-900 hover:text-indigo-700 hover:underline max-w-[20rem]" title={who}>{who}</Link>
          : <span className="truncate min-w-0 font-medium text-gray-900 max-w-[20rem]" title={who}>{who}</span>}</>}
        <span className="flex-1 min-w-[0.75rem] self-end mb-1.5 border-b border-dotted border-gray-300" aria-hidden="true" />
        <time dateTime={row.created_at} title={fmtDate(row.created_at)} className="text-xs text-gray-500 whitespace-nowrap tabular-nums">{timeAgo(row.created_at)}</time>
      </div>
      <div className="mt-2 space-y-1.5">
        {trigger}
        {ai}
        {extra}
        <p className={cn('flex items-start gap-1.5 text-xs', warn ? 'text-amber-800' : 'text-gray-500')}>
          {busy ? <Loader2 className="w-3.5 h-3.5 mt-px flex-shrink-0 animate-spin text-indigo-500" aria-hidden="true" /> : warn ? <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" aria-hidden="true" /> : null}
          <span>{reason ?? needsYouReason(row)}</span>
        </p>
      </div>
      {actions && <div className="mt-2.5 flex flex-wrap items-center gap-1.5">{actions}</div>}
    </li>
  );
}

/** One labelled part of a card: "They wrote:", "AI draft:". The label sits beside the text on wide screens, above it on a phone. */
export function Part({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:gap-3 text-sm">
      {label && <span className="sm:w-24 flex-shrink-0 text-xs sm:text-sm text-gray-500">{label}</span>}
      <div className="min-w-0 flex-1 text-gray-900">{children}</div>
    </div>
  );
}

/** Text as written, four lines at most until it is opened. */
export function ClampText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 320 || text.split('\n').length > 4;
  return (
    <div>
      <p className={cn('whitespace-pre-wrap break-words [overflow-wrap:anywhere]', long && !open && 'line-clamp-4', className)}>{text}</p>
      {long && <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="mt-0.5 text-xs text-indigo-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded">{open ? 'Show less' : 'Show all'}</button>}
    </div>
  );
}

/** A small amber or gray line under the AI text (a note about the send, a missing right). */
export function Hint({ tone = 'gray', children }: { tone?: 'gray' | 'amber'; children: ReactNode }) {
  return <p className={cn('text-xs', tone === 'amber' ? 'text-amber-800' : 'text-gray-500')}>{children}</p>;
}
