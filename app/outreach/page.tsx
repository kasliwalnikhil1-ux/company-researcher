'use client';

import Link from 'next/link';
import React, { useMemo } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Circle, Contact, FileWarning, GitBranch, Hand, Inbox, MessageSquare, PauseCircle, Plus, Sparkles, Upload, CheckSquare, UserMinus, Wand2, XCircle } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSequences } from '@/lib/outreach/queries';
import { fmtInt, fmtRate, useAlertsRealtime, useDashboardV2, type AttentionItem, type DashboardV2 } from '@/lib/outreach/reports';
import { MetricLabel } from '@/components/outreach/reports/primitives';
import { Badge, Button, Card, EmptyState, ErrorBox, PageHeader, PageLoader, Stat, StatusPill } from '@/components/outreach/ui';
import { healthTileClasses, healthTextClass, PROVIDER_LABELS } from '@/components/outreach/senders/helpers';
import { cn } from '@/lib/utils';

type DashSender = DashboardV2['senders'][number];
const TILE_TYPES: Array<{ key: string; label: string }> = [{ key: 'invite', label: 'Invites' }, { key: 'message', label: 'Messages' }, { key: 'profile_view', label: 'Views' }];

function HealthTile({ s }: { s: DashSender }) {
  return (
    <Link href={`/outreach/senders/${s.id}`} className={cn('block rounded-xl border p-4 hover:shadow-sm transition-shadow', healthTileClasses(s.health_score))}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 truncate">{s.display_name ?? 'Unnamed sender'}</div>
          <div className="text-xs text-gray-500">{PROVIDER_LABELS[s.provider] ?? s.provider} · Level {s.warmup_level}</div>
        </div>
        <div className={cn('text-2xl font-bold tabular-nums', healthTextClass(s.health_score))}>{s.health_score}</div>
      </div>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <StatusPill status={s.status} reason={s.status_reason} />
        {s.paused_until && new Date(s.paused_until).getTime() > Date.now() && <Badge tone="amber">auto-paused</Badge>}
        {s.running_dry && <Badge tone="amber">running out of leads</Badge>}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {TILE_TYPES.map((t) => {
          const b = s.today?.[t.key];
          const used = (b?.used ?? 0) + (b?.reserved ?? 0);
          const cap = b?.cap ?? 0;
          const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
          return (
            <div key={t.key} className="bg-white/70 rounded-lg px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">{t.label}</div>
              <div className="text-xs font-semibold text-gray-900 tabular-nums">{b ? `${used}/${cap}` : '—'}</div>
              <div className="h-1 mt-1 bg-gray-200 rounded-full overflow-hidden"><div className="h-full bg-indigo-500" style={{ width: `${pct}%` }} /></div>
            </div>
          );
        })}
      </div>
    </Link>
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
      return { icon: <Wand2 className={cn(cls, 'text-purple-500')} />, title: `AI lines for “${a.label ?? 'a variable'}” are ready`, actions: [{ label: 'Review AI lines', href: `/outreach/ai-review?batch=${a.id}` }] };
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
      <PageHeader title="Dashboard" subtitle={`${workspace?.name ?? ''} · live overview of senders, budgets and replies`} actions={quickActions} />

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
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">{d.senders.map((s) => <HealthTile key={s.id} s={s} />)}</div>
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
                        <span className="flex items-center gap-2 text-sm text-gray-700"><Sparkles className="w-4 h-4 text-purple-600" /> AI drafts awaiting review</span>
                        <Badge tone={d.drafts_awaiting > 0 ? 'purple' : 'gray'}>{d.drafts_awaiting}</Badge>
                      </Link>
                      <Link href="/outreach/ai-review" className="flex items-center justify-between py-2.5 hover:bg-gray-50 -mx-2 px-2 rounded-lg">
                        <span className="flex items-center gap-2 text-sm text-gray-700"><Wand2 className="w-4 h-4 text-purple-600" /> AI lines awaiting review</span>
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
