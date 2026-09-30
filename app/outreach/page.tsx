'use client';

import Link from 'next/link';
import React, { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Circle, Contact, FileWarning, GitBranch, Hand, Inbox, MessageSquare, PauseCircle, Plus, Sparkles, Upload, CheckSquare, UserMinus, Wand2, XCircle } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSequences } from '@/lib/outreach/queries';
import { fmtInt, fmtRate, useAlertsRealtime, useDashboardV2, type AttentionItem, type DashboardV2 } from '@/lib/outreach/reports';
import { MetricLabel } from '@/components/outreach/reports/primitives';
import { PaginationBar, usePagedRows } from '@/components/outreach/Pagination';
import { Avatar, Badge, Button, Card, EmptyState, ErrorBox, PageHeader, PageLoader, Stat, StatusPill } from '@/components/outreach/ui';
import { healthTextClass, isAbandonedSignIn, PROVIDER_LABELS, statusReasonText } from '@/components/outreach/senders/helpers';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { cn } from '@/lib/utils';

type DashSender = DashboardV2['senders'][number];

// The dashboard card: counts by group, every sender that needs a look (worst first, 20 per page),
// and today's capacity summed over every sender. The full, filterable list is /outreach/senders.
const ATTENTION_PAGE_SIZE = 20;
const LOW_HEALTH = 50; // below this healthTone() is red

type HealthGroup = 'attention' | 'paused' | 'dry' | 'connecting' | 'healthy';
const GROUPS: Array<{ key: HealthGroup; label: string; color: string }> = [
  { key: 'attention', label: 'Needs attention', color: 'bg-red-500' },
  { key: 'paused', label: 'Paused', color: 'bg-amber-400' },
  { key: 'dry', label: 'Running dry', color: 'bg-yellow-300' },
  { key: 'connecting', label: 'Connecting', color: 'bg-blue-400' },
  { key: 'healthy', label: 'Healthy', color: 'bg-green-500' },
];
const GROUP_ORDER: Record<HealthGroup, number> = { attention: 0, paused: 1, dry: 2, connecting: 3, healthy: 4 };
const CAPACITY_LABELS: Array<{ key: string; label: string }> = [
  { key: 'invite', label: 'Invites' }, { key: 'message', label: 'Messages' }, { key: 'new_chat', label: 'New conversations' },
  { key: 'email', label: 'Emails' }, { key: 'follow', label: 'Follows' }, { key: 'profile_view', label: 'Profile views' },
];

const isAutoPaused = (s: DashSender) => !!s.paused_until && new Date(s.paused_until).getTime() > Date.now();
function healthGroup(s: DashSender): HealthGroup {
  // A first sign-in that never finished (page closed, link expired, or the hosted page reported a failure) is not "connecting":
  // nothing will change until a manager sends a fresh link.
  if (s.status === 'credentials' || s.status === 'error' || isAbandonedSignIn(s) || (s.status === 'ok' && s.health_score < LOW_HEALTH)) return 'attention';
  if (s.status === 'paused' || s.status === 'disabled' || isAutoPaused(s)) return 'paused';
  if (s.running_dry) return 'dry';
  if (s.status === 'connecting') return 'connecting';
  return 'healthy';
}

function flagReason(s: DashSender, g: HealthGroup): React.ReactNode {
  if (isAbandonedSignIn(s)) return <Badge tone="red">{statusReasonText(s.status_reason) ?? 'Sign-in not completed'}</Badge>;
  if (s.status !== 'ok') return <StatusPill status={s.status} reason={statusReasonText(s.status_reason)} />;
  if (g === 'attention') return <Badge tone="red">Low health</Badge>;
  if (g === 'paused') return <Badge tone="amber">Auto-paused</Badge>;
  if (g === 'dry') return <Badge tone="amber">Running out of leads</Badge>;
  return <Badge tone="green">Healthy</Badge>;
}

function SenderHealthSummary({ senders }: { senders: DashSender[] }) {
  // Clicking a legend chip narrows the list to that group (click again to go back to "needs a look").
  const [filter, setFilter] = useState<HealthGroup | null>(null);
  const { counts, grouped, flagged, capacity } = useMemo(() => {
    const counts: Record<HealthGroup, number> = { attention: 0, paused: 0, dry: 0, connecting: 0, healthy: 0 };
    const grouped: Array<{ s: DashSender; g: HealthGroup }> = [];
    const sums = new Map<string, { used: number; cap: number }>();
    for (const s of senders) {
      const g = healthGroup(s);
      counts[g]++;
      grouped.push({ s, g });
      for (const [k, b] of Object.entries(s.today ?? {})) {
        const c = sums.get(k) ?? { used: 0, cap: 0 };
        c.used += (b?.used ?? 0) + (b?.reserved ?? 0);
        c.cap += b?.cap ?? 0;
        sums.set(k, c);
      }
    }
    // Within a group, senders that stopped (re-login needed, error, sign-in not completed) come before low health.
    const stopped = (s: DashSender) => (s.status === 'ok' ? 1 : 0);
    grouped.sort((a, b) => GROUP_ORDER[a.g] - GROUP_ORDER[b.g] || stopped(a.s) - stopped(b.s) || a.s.health_score - b.s.health_score || (a.s.display_name ?? '').localeCompare(b.s.display_name ?? ''));
    const flagged = grouped.filter(({ g }) => g === 'attention' || g === 'paused' || g === 'dry');
    const capacity = CAPACITY_LABELS.map((c) => ({ ...c, ...(sums.get(c.key) ?? { used: 0, cap: 0 }) })).filter((c) => c.cap > 0).slice(0, 4);
    return { counts, grouped, flagged, capacity };
  }, [senders]);

  const total = senders.length;
  const listed = filter ? grouped.filter(({ g }) => g === filter) : flagged;
  const { pageRows: shown, ...pager } = usePagedRows(listed, filter ?? '', ATTENTION_PAGE_SIZE);
  const legend = GROUPS.filter((g) => counts[g.key] > 0 || g.key === 'attention' || g.key === 'healthy');
  const filterLabel = GROUPS.find((g) => g.key === filter)?.label;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <div className="text-sm text-gray-600"><span className="text-lg font-semibold text-gray-900 tabular-nums">{fmtInt(total)}</span> {total === 1 ? 'sender' : 'senders'}</div>
          {counts.healthy === total && <div className="text-xs text-green-700 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> All healthy</div>}
        </div>
        <div className="flex h-2 rounded-full overflow-hidden bg-gray-100" role="img" aria-label={legend.map((g) => `${counts[g.key]} ${g.label.toLowerCase()}`).join(', ')}>
          {GROUPS.map((g) => counts[g.key] > 0 && <div key={g.key} className={cn(g.color, filter && filter !== g.key && 'opacity-30')} style={{ width: `${(counts[g.key] / total) * 100}%` }} />)}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1" role="group" aria-label="Show senders by state">
          {legend.map((g) => (
            <button key={g.key} type="button" onClick={() => setFilter(filter === g.key ? null : g.key)} aria-pressed={filter === g.key} disabled={counts[g.key] === 0}
              className={cn('inline-flex items-center gap-1.5 text-xs rounded-full px-2 py-0.5 border transition-colors', filter === g.key ? 'border-gray-900 bg-gray-900 text-white' : 'border-transparent text-gray-600 hover:bg-gray-100 disabled:hover:bg-transparent disabled:cursor-default')}>
              <span className={cn('w-2 h-2 rounded-full', g.color)} />{g.label} <span className={cn('font-semibold tabular-nums', filter === g.key ? 'text-white' : 'text-gray-900')}>{fmtInt(counts[g.key])}</span>
            </button>
          ))}
        </div>
      </div>

      {(shown.length > 0 || filter) && (
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">{filter ? filterLabel : 'Needs a look'}</div>
            {filter && <button type="button" onClick={() => setFilter(null)} className="text-xs text-indigo-600 hover:underline">Show what needs a look</button>}
          </div>
          {shown.length === 0 ? (
            <div className="text-sm text-gray-500 border border-dashed border-gray-200 rounded-lg px-3 py-4 text-center">No senders in this group.</div>
          ) : (
          <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
            {shown.map(({ s, g }) => (
              <li key={s.id}>
                <Link href={`/outreach/senders/${s.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50">
                  <Avatar src={s.picture_url} name={s.display_name} size={8} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">{s.display_name ?? 'Unnamed sender'}</div>
                    <div className="text-xs text-gray-500 flex items-center gap-1"><ProviderLogo provider={s.provider} className="w-3 h-3" /> {PROVIDER_LABELS[s.provider] ?? s.provider} · Level {s.warmup_level}</div>
                  </div>
                  <div className="shrink-0">{flagReason(s, g)}</div>
                  <div className={cn('w-8 text-right text-sm font-semibold tabular-nums', healthTextClass(s.health_score))} title="Health score">{s.health_score}</div>
                </Link>
              </li>
            ))}
          </ul>
          )}
          {pager.pageCount > 1 && <PaginationBar {...pager} className="mt-2 text-xs" />}
        </div>
      )}

      {capacity.length > 0 && (
        <div>
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Today, all senders</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {capacity.map((c) => {
              const pct = Math.min(100, Math.round((c.used / c.cap) * 100));
              return (
                <div key={c.key} className="bg-gray-50 rounded-lg px-3 py-2">
                  <div className="text-xs text-gray-500 truncate">{c.label}</div>
                  <div className="text-sm font-semibold text-gray-900 tabular-nums">{fmtInt(c.used)} <span className="text-gray-400 font-normal">/ {fmtInt(c.cap)}</span></div>
                  <div className="h-1 mt-1 bg-gray-200 rounded-full overflow-hidden"><div className="h-full bg-indigo-500" style={{ width: `${pct}%` }} /></div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// What each attention kind means and what to do about it. The sentence itself comes from the database.
interface AttentionAction { label: string; href: string }
function attentionView(a: AttentionItem): { icon: React.ReactNode; title: string; actions: AttentionAction[] } {
  const cls = 'w-4 h-4 flex-shrink-0';
  switch (a.kind) {
    case 'sequence_stalled':
      return { icon: <PauseCircle className={cn(cls, 'text-red-500')} />, title: `${a.label ?? 'A sequence'} has stopped sending`, actions: [{ label: 'Why isn’t this sending?', href: `/outreach/sequences/${a.id}?why=1` }] };
    case 'sender_running_dry':
      return { icon: <UserMinus className={cn(cls, 'text-amber-500')} />, title: `${a.label ?? 'A sender'} is running out of leads`, actions: [{ label: 'Enrol more leads', href: '/outreach/leads' }, { label: 'Add an auto-enrol rule', href: '/outreach/sequences' }] };
    case 'import_failed':
      return { icon: <FileWarning className={cn(cls, 'text-red-500')} />, title: `An import failed${a.label ? ` (${a.label.replace(/_/g, ' ')})` : ''}`, actions: [{ label: 'Open imports', href: '/outreach/leads/import' }] };
    case 'held_leads':
      return { icon: <Hand className={cn(cls, 'text-amber-500')} />, title: `${a.label ?? 'A sequence'}: replies waiting for a decision`, actions: [{ label: 'Review held leads', href: '/outreach/tasks?kind=reply_hold' }] };
    case 'failed_leads':
      return { icon: <XCircle className={cn(cls, 'text-red-500')} />, title: `${a.label ?? 'A sequence'}: failed leads`, actions: [{ label: 'Open failed leads', href: `/outreach/sequences/${a.id}?failed=1` }] };
    case 'ai_review':
      return { icon: <Wand2 className={cn(cls, 'text-purple-500')} />, title: `AI Personalization lines for “${a.label ?? 'a variable'}” are ready`, actions: [{ label: 'Open AI Personalization', href: `/outreach/ai-review?batch=${a.id}` }] };
    case 'sequence':
      return { icon: <GitBranch className={cn(cls, 'text-gray-400')} />, title: a.label ?? 'Sequence', actions: [{ label: 'Open sequence', href: `/outreach/sequences/${a.id}` }] };
    default:
      return { icon: <Contact className={cn(cls, 'text-gray-400')} />, title: a.label ?? 'Sender', actions: [{ label: 'Open sender', href: `/outreach/senders/${a.id}` }] };
  }
}

function AttentionRow({ a }: { a: AttentionItem }) {
  const v = attentionView(a);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="flex items-start gap-2.5 min-w-0 flex-1">
        <span className="mt-0.5">{v.icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900">{v.title}</div>
          {a.reason && <div className="text-sm text-gray-600 mt-0.5">{a.reason}</div>}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap pl-6">
        {v.actions.map((x, i) => <Link key={x.href + x.label} href={x.href}><Button size="sm" variant={i === 0 ? 'secondary' : 'ghost'}>{x.label}</Button></Link>)}
      </div>
    </li>
  );
}

function ChecklistItem({ done, title, description, href, cta }: { done: boolean; title: string; description: string; href: string; cta: string }) {
  return (
    <div className={cn('flex items-start gap-3 p-4 rounded-xl border', done ? 'border-green-200 bg-green-50/50' : 'border-gray-200 bg-white')}>
      {done ? <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" /> : <Circle className="w-5 h-5 text-gray-300 mt-0.5 flex-shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className={cn('text-sm font-semibold', done ? 'text-green-800 line-through decoration-green-400' : 'text-gray-900')}>{title}</div>
        <div className="text-sm text-gray-500 mt-0.5">{description}</div>
      </div>
      {!done && <Link href={href}><Button size="sm">{cta} <ArrowRight className="w-3.5 h-3.5" /></Button></Link>}
    </div>
  );
}

export default function OutreachDashboardPage() {
  const { workspace, isManager, canWrite, role } = useWorkspace();
  const ws = workspace?.id;
  const dash = useDashboardV2(ws);
  useAlertsRealtime(ws);
  const sequences = useSequences(ws);
  const d = dash.data;

  const steps = useMemo(() => ({
    sender: (d?.senders.length ?? 0) > 0,
    leads: (d?.leads_total ?? 0) > 0,
    sequence: (sequences.data?.length ?? 0) > 0,
  }), [d, sequences.data]);
  const allDone = steps.sender && steps.leads && steps.sequence;
  const isViewer = role === 'client_viewer';

  if (dash.isLoading) return <PageLoader />;
  if (dash.isError) return <ErrorBox message={(dash.error as Error).message} />;
  if (!d) return <EmptyState title="No dashboard data" />;
  const w = d.last_7_days;

  const quickActions = canWrite && !isViewer ? (
    <>
      {isManager && <Link href="/outreach/senders/new"><Button variant="secondary"><Contact className="w-4 h-4" /> Connect sender</Button></Link>}
      <Link href="/outreach/leads/import"><Button variant="secondary"><Upload className="w-4 h-4" /> Import leads</Button></Link>
      {isManager && <Link href="/outreach/sequences/new"><Button><Plus className="w-4 h-4" /> New sequence</Button></Link>}
    </>
  ) : null;

  const emptyWorkspace = !steps.sender && !steps.leads;

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={`${workspace?.name ?? ''} · live overview of senders, daily limits and replies`} actions={quickActions} />

      {!allDone && !isViewer && (
        <Card className="mb-6" title={emptyWorkspace ? 'Welcome — let’s get you set up' : 'Finish setting up'}>
          <p className="text-sm text-gray-500 mb-4">Three steps take you from an empty workspace to a live campaign. Senders warm up gradually, so connecting them early pays off.</p>
          <div className="grid gap-3">
            <ChecklistItem done={steps.sender} title="1. Connect a sender" description="Link a LinkedIn account (or a Gmail/Outlook mailbox) through a secure hosted login. The account owner logs in themselves." href="/outreach/senders/new" cta={isManager ? 'Connect' : 'View'} />
            <ChecklistItem done={steps.leads} title="2. Import leads" description="Paste a LinkedIn search URL, upload a CSV, or pull a sender's existing connections." href="/outreach/leads/import" cta="Import" />
            <ChecklistItem done={steps.sequence} title="3. Build a sequence" description="Design the steps (profile view → invite → message) on the canvas, pick a sender pool, and activate." href="/outreach/sequences/new" cta={isManager ? 'Build' : 'View'} />
          </div>
        </Card>
      )}

      {emptyWorkspace ? null : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <Stat label="Sent today" value={fmtInt(d.sent_today)} hint="All senders, today in the workspace timezone" />
            <Stat label="Queued (next 24h)" value={fmtInt(d.queued_today)} />
            <Stat label="Live enrollments" value={fmtInt(d.enrollments_live)} />
            <Stat label="Leads" value={d.leads_total.toLocaleString()} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            <div className="lg:col-span-2">
              <Card title="Sender health" actions={<Link href="/outreach/senders" className="text-xs text-indigo-600 hover:underline">All senders</Link>}>
                {d.senders.length === 0 ? (
                  <EmptyState title="No senders yet" description="Connect a LinkedIn account to start." icon={<Contact className="w-6 h-6" />} action={isManager ? <Link href="/outreach/senders/new"><Button size="sm">Connect sender</Button></Link> : undefined} />
                ) : (
                  <SenderHealthSummary senders={d.senders} />
                )}
              </Card>
            </div>
            <div className="space-y-6">
              <Card title="Last 7 days" actions={<Link href="/outreach/reports" className="text-xs text-indigo-600 hover:underline">Open reports</Link>}>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { metric: 'touches', label: 'Sent touches', value: fmtInt(w.touches), sub: `${fmtInt(w.invites)} invites` },
                    { metric: 'accepted', label: 'Accepted', value: fmtInt(w.accepted), sub: `${fmtRate(w.acceptance_rate)} acceptance rate` },
                    { metric: 'replies', label: 'Replies', value: fmtInt(w.replies), sub: `${fmtRate(w.reply_rate)} reply rate` },
                    { metric: 'positive_reply_rate', label: 'Interested', value: fmtInt(w.interested), sub: `${fmtRate(w.positive_reply_rate)} positive reply rate` },
                  ]).map((x) => (
                    <div key={x.label} className="bg-gray-50 rounded-lg px-3 py-2">
                      <div className="text-xs text-gray-500"><MetricLabel metric={x.metric}>{x.label}</MetricLabel></div>
                      <div className="text-lg font-semibold text-gray-900 tabular-nums">{x.value}</div>
                      <div className="text-xs text-gray-500">{x.sub}</div>
                    </div>
                  ))}
                </div>
                <div className="text-xs text-gray-500 mt-3">{fmtInt(w.meetings)} {w.meetings === 1 ? 'meeting' : 'meetings'} booked. The reports page shows the same numbers.</div>
              </Card>
              <Card title="Waiting on you">
                <div className="divide-y divide-gray-100">
                  <Link href="/outreach/inbox?intent=interested&unread=1" className="flex items-center justify-between py-2.5 hover:bg-gray-50 -mx-2 px-2 rounded-lg">
                    <span className="flex items-center gap-2 text-sm text-gray-700"><MessageSquare className="w-4 h-4 text-green-600" /> Replies awaiting action</span>
                    <Badge tone={d.replies_awaiting > 0 ? 'green' : 'gray'}>{d.replies_awaiting}</Badge>
                  </Link>
                  <Link href="/outreach/inbox?unread=1" className="flex items-center justify-between py-2.5 hover:bg-gray-50 -mx-2 px-2 rounded-lg">
                    <span className="flex items-center gap-2 text-sm text-gray-700"><Inbox className="w-4 h-4 text-indigo-600" /> Unread conversations</span>
                    <Badge tone={d.unread > 0 ? 'indigo' : 'gray'}>{d.unread}</Badge>
                  </Link>
                  {!isViewer && (
                    <>
                      <Link href="/outreach/tasks" className="flex items-center justify-between py-2.5 hover:bg-gray-50 -mx-2 px-2 rounded-lg">
                        <span className="flex items-center gap-2 text-sm text-gray-700"><CheckSquare className="w-4 h-4 text-amber-600" /> Open tasks</span>
                        <Badge tone={d.tasks_open > 0 ? 'amber' : 'gray'}>{d.tasks_open}</Badge>
                      </Link>
                      <Link href="/outreach/tasks?kind=review_ai_draft" className="flex items-center justify-between py-2.5 hover:bg-gray-50 -mx-2 px-2 rounded-lg">
                        <span className="flex items-center gap-2 text-sm text-gray-700"><Sparkles className="w-4 h-4 text-purple-600" /> Review AI Personalization tasks</span>
                        <Badge tone={d.drafts_awaiting > 0 ? 'purple' : 'gray'}>{d.drafts_awaiting}</Badge>
                      </Link>
                      <Link href="/outreach/ai-review" className="flex items-center justify-between py-2.5 hover:bg-gray-50 -mx-2 px-2 rounded-lg">
                        <span className="flex items-center gap-2 text-sm text-gray-700"><Wand2 className="w-4 h-4 text-purple-600" /> AI Personalization lines to review</span>
                        <Badge tone={(d.ai_lines_awaiting ?? 0) > 0 ? 'purple' : 'gray'}>{d.ai_lines_awaiting ?? 0}</Badge>
                      </Link>
                    </>
                  )}
                </div>
              </Card>
            </div>
          </div>

          <Card title={<span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-500" /> Needs attention</span>}>
            {d.attention.length === 0 ? (
              <div className="text-sm text-gray-500 py-2">Nothing needs you right now. No sender is disconnected, no sequence is stalled and no lead is waiting on a decision.</div>
            ) : (
              <ul className="divide-y divide-gray-100">{d.attention.map((a, i) => <AttentionRow key={`${a.kind}-${a.id}-${i}`} a={a} />)}</ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
