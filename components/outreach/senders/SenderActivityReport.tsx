'use client';

import { useMemo, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Spinner, Stat, fmtDate } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { localDate } from './helpers';
import { addDays, fmtDay, isMailbox, num, pct, useSenderReport, type ReportTotals, type SenderRestriction, type SenderV2 } from './insights';

const PRESETS = [{ key: '7', label: 'Last 7 days', days: 7 }, { key: '30', label: 'Last 30 days', days: 30 }, { key: '90', label: 'Last 90 days', days: 90 }] as const;

const STATUS_WORDS: Record<string, string> = { credentials: 'disconnected from LinkedIn', error: 'reported a provider error', paused: 'was paused' };

function restrictionText(r: SenderRestriction): { title: string; detail: string | null; tone: 'red' | 'amber' } {
  const d = r.data ?? {};
  const s = (k: string) => (d[k] == null ? null : String(d[k]));
  if (r.kind === 'checkpoint') return { title: d.solved ? 'LinkedIn verification completed' : 'LinkedIn asked for verification', detail: null, tone: 'amber' };
  if (r.kind === 'reject') return { title: 'LinkedIn rejected an action', detail: [s('action_type')?.replace(/_/g, ' '), s('reason') ?? s('message') ?? s('code')].filter(Boolean).join(' · ') || null, tone: 'red' };
  if (d.paused_until) return { title: `Rested until ${fmtDate(s('paused_until'))}`, detail: s('reason') ?? s('status_reason'), tone: 'amber' };
  const to = s('to') ?? s('status');
  return { title: `Sender ${STATUS_WORDS[to ?? ''] ?? `changed to ${to ?? 'another status'}`}`, detail: s('reason') ?? s('status_reason'), tone: to === 'paused' ? 'amber' : 'red' };
}

function volumeRows(t: ReportTotals, mailbox: boolean): Array<{ label: string; value: number }> {
  const rows = mailbox
    ? [{ label: 'Emails', value: t.emails }]
    : [
        { label: 'Invitations', value: t.invites }, { label: 'Messages', value: t.messages }, { label: 'InMails', value: t.inmails }, { label: 'Profile views', value: t.profile_views },
        { label: 'Likes', value: t.likes }, { label: 'Comments', value: t.comments }, { label: 'Endorsements', value: t.endorsements }, { label: 'Follows', value: t.follows },
        { label: 'Withdrawn invitations', value: t.withdrawn }, { label: 'Emails', value: t.emails },
      ];
  // always keep the main types; hide the minor ones while they are zero
  return rows.filter((r, i) => i < (mailbox ? 1 : 3) || Number(r.value) > 0);
}

export default function SenderActivityReport({ sender, workspaceTimezone }: { sender: SenderV2; workspaceTimezone?: string | null }) {
  const today = useMemo(() => localDate(workspaceTimezone || 'UTC'), [workspaceTimezone]);
  const [preset, setPreset] = useState<string>('30');
  const [from, setFrom] = useState(() => addDays(today, -29));
  const [to, setTo] = useState(today);
  const mailbox = isMailbox(sender);

  const rangeError = !from || !to ? 'Pick both dates.' : from > to ? 'The start date must be on or before the end date.' : to > today ? 'The end date cannot be in the future.' : null;
  const q = useSenderReport(rangeError ? null : sender.id, from, to);

  const pick = (p: (typeof PRESETS)[number]) => { setPreset(p.key); setTo(today); setFrom(addDays(today, -(p.days - 1))); };
  const t = q.data?.totals;
  const vol = t ? volumeRows(t, mailbox) : [];
  const maxVol = Math.max(1, ...vol.map((r) => Number(r.value) || 0));
  const failures = Object.entries(q.data?.failures_by_reason ?? {}).sort((a, b) => b[1] - a[1]);
  const failuresTotal = failures.reduce((a, [, c]) => a + c, 0);
  const restrictions = q.data?.restrictions ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Date range" className="inline-flex rounded-lg border border-gray-300 bg-white overflow-hidden">
          {PRESETS.map((p) => (
            <button key={p.key} type="button" onClick={() => pick(p)} aria-pressed={preset === p.key} className={cn('px-3 py-[11px] text-xs font-medium border-r border-gray-200 last:border-r-0', preset === p.key ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>{p.label}</button>
          ))}
        </div>
        <div className="w-40"><Input label="From" type="date" value={from} max={to || today} onChange={(e) => { setFrom(e.target.value); setPreset('custom'); }} /></div>
        <div className="w-40"><Input label="To" type="date" value={to} min={from} max={today} onChange={(e) => { setTo(e.target.value); setPreset('custom'); }} /></div>
        {q.data && !rangeError && <div className="text-xs text-gray-500 pb-2.5 sm:ml-auto">{fmtDay(q.data.period.from)} to {fmtDay(q.data.period.to)} · days in {q.data.period.timezone}{q.isFetching ? ' · updating…' : ''}</div>}
      </div>

      {rangeError ? <ErrorBox message={rangeError} /> : q.isLoading ? <Spinner /> : q.isError ? (
        <div className="space-y-3"><ErrorBox message={parseError(q.error).message} /><Button size="sm" variant="secondary" onClick={() => q.refetch()}>Try again</Button></div>
      ) : !t ? null : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {!mailbox && <Stat label="Acceptance rate" value={pct(t.acceptance_rate)} hint={`${num(t.accepted)} accepted of ${num(t.invites)} invitations`} />}
            <Stat label="Replies" value={num(t.replies)} hint={t.reply_rate == null ? 'No reply rate yet' : `${pct(t.reply_rate)} reply rate`} />
            <Stat label="Interested replies" value={num(t.interested)} hint={t.positive_reply_rate == null ? undefined : `${pct(t.positive_reply_rate)} positive reply rate`} />
            <Stat label="Meetings booked" value={num(t.meetings)} />
            {mailbox && <Stat label="Bounce rate" value={pct(t.bounce_rate)} hint={`${num(t.email_bounced)} bounced`} />}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <Card title="Volume by type" actions={<span className="text-xs text-gray-500">{num(t.touches)} touches</span>}>
              <ul className="space-y-3">
                {vol.map((r) => (
                  <li key={r.label}>
                    <div className="flex justify-between text-sm"><span className="text-gray-700">{r.label}</span><span className="tabular-nums font-medium text-gray-900">{num(r.value)}</span></div>
                    <div className="h-1.5 mt-1 bg-gray-100 rounded-full overflow-hidden" role="presentation"><div className="h-full bg-indigo-600 rounded-full" style={{ width: `${(100 * (Number(r.value) || 0)) / maxVol}%` }} /></div>
                  </li>
                ))}
              </ul>
              <dl className="mt-4 pt-3 border-t border-gray-100 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                {!mailbox && <div><dt className="text-gray-500">With a note</dt><dd className="text-gray-900 tabular-nums">{num(t.invites_with_note)}</dd></div>}
                <div><dt className="text-gray-500">Skipped</dt><dd className="text-gray-900 tabular-nums">{num(t.skipped)}</dd></div>
                <div><dt className="text-gray-500">Failed</dt><dd className={cn('tabular-nums', Number(t.failed) > 0 ? 'text-red-700 font-medium' : 'text-gray-900')}>{num(t.failed)}</dd></div>
                {!mailbox && <div><dt className="text-gray-500">LinkedIn limit hits</dt><dd className="text-gray-900 tabular-nums">{num(t.limit_hits)}</dd></div>}
                {mailbox && <div><dt className="text-gray-500">Open rate</dt><dd className="text-gray-900 tabular-nums">{pct(t.open_rate)}</dd></div>}
                {mailbox && <div><dt className="text-gray-500">Click rate</dt><dd className="text-gray-900 tabular-nums">{pct(t.click_rate)}</dd></div>}
              </dl>
            </Card>

            <Card title="Failures by reason" actions={failuresTotal > 0 ? <span className="text-xs text-gray-500">{num(failuresTotal)} in total</span> : undefined}>
              {failures.length === 0 ? <div className="[&>div]:py-8"><EmptyState title="Nothing failed in this range" description="Every planned action either went out or was skipped on purpose." /></div> : (
                <ul className="divide-y divide-gray-100">
                  {failures.map(([reason, count]) => (
                    <li key={reason} className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                      <span className="text-sm text-gray-800">{reason}</span>
                      <span className="text-sm tabular-nums font-medium text-gray-900">{num(count)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {failures.length > 0 && <p className="text-xs text-gray-500 mt-3">Open a sequence to retry or skip the failed leads.</p>}
            </Card>
          </div>

          <Card title="Restrictions" actions={<span className="text-xs text-gray-500">from {fmtDay(q.data!.period.from)}</span>}>
            {restrictions.length === 0 ? <div className="[&>div]:py-8"><EmptyState icon={<ShieldAlert className="w-6 h-6" />} title="No restrictions in this range" description="No rejected actions, verification requests, disconnects or pauses." /></div> : (
              <ol className="relative border-l border-gray-200 ml-2">
                {restrictions.map((r, i) => {
                  const x = restrictionText(r);
                  return (
                    <li key={`${r.at}-${i}`} className="ml-4 pb-4 last:pb-0">
                      <span className={cn('absolute -left-1.5 mt-1.5 w-3 h-3 rounded-full border-2 border-white', x.tone === 'red' ? 'bg-red-400' : 'bg-amber-400')} aria-hidden />
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={x.tone}>{r.kind === 'reject' ? 'Rejected' : r.kind === 'checkpoint' ? 'Verification' : 'Status'}</Badge>
                        <span className="text-sm text-gray-800">{x.title}</span>
                        <span className="text-xs text-gray-500 ml-auto">{fmtDate(r.at)}</span>
                      </div>
                      {x.detail && <div className="text-xs text-gray-500 mt-0.5">{x.detail}</div>}
                    </li>
                  );
                })}
              </ol>
            )}
            {restrictions.length >= 50 && <p className="text-xs text-gray-500 mt-3">Showing the latest 50. The Events tab has the full history.</p>}
          </Card>
        </>
      )}
    </div>
  );
}
