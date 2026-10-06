'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import Link from '@/lib/outreach/nav';
import { AlertTriangle, Braces, Globe, Loader2, Sparkles, User, Workflow } from 'lucide-react';
import { needsYouReason, whoHref, type NeedsYouRow } from '@/lib/outreach/aiHub';
import { Avatar, fmtDate, timeAgo } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { cardKey } from './types';

/** The photos of the cards on screen, keyed by `cardKey` (filled by the view from `useNeedsYouPictures`). */
export const NeedsYouPictures = createContext<Record<string, string>>({});

/** A link that looks like the small secondary button, for actions that open another page. */
export const linkButton = 'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap px-2.5 py-1.5 text-xs bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';

const WHERE_ICON: Record<NonNullable<NeedsYouRow['where_kind']>, typeof Globe> = { sequence: Workflow, variable: Braces, website: Globe, sender: User };

/** A card waits for a plain review when nothing but "a person approves this" holds it. */
const plainReview = (row: NeedsYouRow) => row.state === 'review' && (!row.reason || row.reason === 'review');
/** Types whose worded reason only repeats what the card already shows (a line waits for approval, a question's count is in its header). */
const QUIET: ReadonlySet<NeedsYouRow['type']> = new Set(['line', 'question', 'profile']);

/**
 * The one card layout of Needs you, the same for every type:
 *   who · where ··· time → what triggered it (their bubble) → what the AI wrote (AI bubble) → a warning, if any → actions
 * The type is the section the card sits in, so the card does not repeat it. The reason line only shows when it says
 * something the person should know (an escalation, a warm-up hold, the AI still writing); a plain review says nothing.
 * `hidden` keeps the card mounted while it is optimistically removed, so an edit survives a failed call.
 */
export default function NeedCard({ row, hidden, lead, title, trigger, ai, extra, reason, busy, actions }: {
  row: NeedsYouRow; hidden: boolean;
  /** In front of the card: the checkbox of a line card. */
  lead?: ReactNode;
  /** Replaces the who in the header (a question has no who: it shows how often it was asked). */
  title?: ReactNode;
  trigger?: ReactNode; ai?: ReactNode;
  /** Small print under the AI text: facts, sources, examples. */
  extra?: ReactNode;
  /** Overrides the worded reason (`needsYouReason`) and always shows it. */
  reason?: string;
  /** The AI is still working on this card: a spinner instead of the warning icon. */
  busy?: boolean;
  actions?: ReactNode;
}) {
  const href = whoHref(row);
  const picture = useContext(NeedsYouPictures)[cardKey(row)];
  const warn = !busy && !plainReview(row) && !QUIET.has(row.type);
  const showReason = busy || reason !== undefined || warn;
  const WhereIcon = row.where_kind ? WHERE_ICON[row.where_kind] ?? Workflow : Workflow;
  const name = row.who_name ? (
    <span className="min-w-0 truncate">
      {href
        ? <Link href={href} className="font-semibold text-gray-900 hover:text-indigo-700 hover:underline">{row.who_name}</Link>
        : <span className="font-semibold text-gray-900">{row.who_name}</span>}
      {row.who_detail && <span className="text-gray-500"> · {row.who_detail}</span>}
    </span>
  ) : null;

  return (
    <li hidden={hidden} className="rounded-xl border border-gray-200 bg-white px-4 py-3.5 sm:px-5 sm:py-4 transition-shadow hover:shadow-sm">
      <div className="flex items-start gap-3">
        {lead && <div className="pt-0.5">{lead}</div>}
        {!title && row.who_name && <Avatar src={picture} name={row.who_name} size={9} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2.5 text-sm">
              {title ?? name}
              {row.where_name && (
                <span className="inline-flex min-w-0 items-center gap-1 text-xs text-gray-500" title={row.where_name}>
                  <WhereIcon className="h-3 w-3 flex-shrink-0 text-gray-400" aria-hidden="true" />
                  <span className="truncate max-w-[18rem]">{row.where_name}</span>
                </span>
              )}
            </div>
            <time dateTime={row.created_at} title={fmtDate(row.created_at)} className="pt-0.5 text-xs text-gray-400 whitespace-nowrap tabular-nums">{timeAgo(row.created_at)}</time>
          </div>

          <div className="mt-3 max-w-3xl space-y-2">
            {trigger}
            {ai}
            {extra}
            {showReason && (
              <p className={cn('flex items-start gap-1.5 text-xs', warn || busy ? 'text-amber-800' : 'text-gray-500')}>
                {busy ? <Loader2 className="w-3.5 h-3.5 mt-px flex-shrink-0 animate-spin text-indigo-500" aria-hidden="true" /> : warn ? <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" aria-hidden="true" /> : null}
                <span>{reason ?? needsYouReason(row)}</span>
              </p>
            )}
          </div>
          {actions && <div className="mt-3 flex flex-wrap items-center gap-1.5">{actions}</div>}
        </div>
      </div>
    </li>
  );
}

/**
 * One labelled part of a card. `them` is what the prospect or visitor wrote (a gray bubble), `ai` is what the AI wrote
 * (an indigo bubble with a sparkle), `plain` is text without a bubble.
 */
export function Part({ label, tone = 'plain', children }: { label?: string; tone?: 'them' | 'ai' | 'plain'; children: ReactNode }) {
  if (tone === 'plain') {
    return (
      <div className="text-sm">
        {label && <div className="mb-0.5 text-xs text-gray-500">{label}</div>}
        <div className="min-w-0 text-gray-900">{children}</div>
      </div>
    );
  }
  const ai = tone === 'ai';
  return (
    <div className={cn('rounded-lg border px-3 py-2 text-sm', ai ? 'border-indigo-100 bg-indigo-50/60' : 'border-gray-100 bg-gray-50')}>
      {label && (
        <div className={cn('mb-0.5 flex items-center gap-1 text-xs font-medium', ai ? 'text-indigo-700' : 'text-gray-500')}>
          {ai && <Sparkles className="h-3 w-3" aria-hidden="true" />}
          {label}
        </div>
      )}
      <div className={cn('min-w-0', ai ? 'text-gray-900' : 'text-gray-700')}>{children}</div>
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
