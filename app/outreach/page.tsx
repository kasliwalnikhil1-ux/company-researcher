'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Circle, Contact, GitBranch, Inbox, MessageSquare, Plus, Sparkles, Upload, CheckSquare } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useDashboard, useSequences } from '@/lib/outreach/queries';
import { Button, Card, EmptyState, ErrorBox, PageHeader, Spinner, Stat, StatusPill, Badge } from '@/components/outreach/ui';
import { healthTileClasses, healthTextClass, PROVIDER_LABELS } from '@/components/outreach/senders/helpers';
import { cn } from '@/lib/utils';
import type { DashboardData } from '@/lib/outreach/types';

type DashSender = DashboardData['senders'][number];
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
  const dash = useDashboard(ws);
  const sequences = useSequences(ws);
  const d = dash.data;

  const steps = useMemo(() => ({
    sender: (d?.senders.length ?? 0) > 0,
    leads: (d?.leads_total ?? 0) > 0,
    sequence: (sequences.data?.length ?? 0) > 0,
  }), [d, sequences.data]);
  const allDone = steps.sender && steps.leads && steps.sequence;
  const isViewer = role === 'client_viewer';

  if (dash.isLoading) return <Spinner />;
  if (dash.isError) return <ErrorBox message={(dash.error as Error).message} />;
  if (!d) return <EmptyState title="No dashboard data" />;

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
            <ChecklistItem done={steps.sender} title="1. Connect a sender" description="Link a LinkedIn account (or a Gmail/Outlook mailbox) through Unipile's hosted login. The account owner logs in themselves." href="/outreach/senders/new" cta={isManager ? 'Connect' : 'View'} />
            <ChecklistItem done={steps.leads} title="2. Import leads" description="Paste a LinkedIn search URL, upload a CSV, or pull a sender's existing connections." href="/outreach/leads/import" cta="Import" />
            <ChecklistItem done={steps.sequence} title="3. Build a sequence" description="Design the steps (profile view → invite → message) on the canvas, pick a sender pool, and activate." href="/outreach/sequences/new" cta={isManager ? 'Build' : 'View'} />
          </div>
        </Card>
      )}

      {emptyWorkspace ? null : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <Stat label="Sent today" value={d.sent_today} hint="all senders, last 24h" />
            <Stat label="Queued (next 24h)" value={d.queued_today} />
            <Stat label="Live enrollments" value={d.enrollments_live} />
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
              <Card title="Last 7 days">
                <div className="grid grid-cols-2 gap-3">
                  {[['Invites sent', d.stats_7d.invites], ['Accepted', d.stats_7d.accepted], ['Messages sent', d.stats_7d.messages], ['Replies', d.stats_7d.replies]].map(([l, v]) => (
                    <div key={String(l)} className="bg-gray-50 rounded-lg px-3 py-2">
                      <div className="text-xs text-gray-500">{l}</div>
                      <div className="text-lg font-semibold text-gray-900 tabular-nums">{v as number}</div>
                    </div>
                  ))}
                </div>
                {d.stats_7d.invites > 0 && (
                  <div className="text-xs text-gray-500 mt-3">Acceptance {Math.round((d.stats_7d.accepted / Math.max(1, d.stats_7d.invites)) * 100)}% · Reply {Math.round((d.stats_7d.replies / Math.max(1, d.stats_7d.messages)) * 100)}%</div>
                )}
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
                    </>
                  )}
                </div>
              </Card>
            </div>
          </div>

          <Card title={<span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-500" /> Needs attention</span>}>
            {d.attention.length === 0 ? (
              <div className="text-sm text-gray-500 py-2">Everything looks healthy. No senders need a re-login and no sequences are throttled.</div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {d.attention.map((a, i) => (
                  <li key={`${a.kind}-${a.id}-${i}`}>
                    <Link href={a.kind === 'sequence' ? `/outreach/sequences/${a.id}` : `/outreach/senders/${a.id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-gray-50 -mx-2 px-2 rounded-lg">
                      <span className="flex items-center gap-2 min-w-0">
                        {a.kind === 'sequence' ? <GitBranch className="w-4 h-4 text-gray-400 flex-shrink-0" /> : <Contact className="w-4 h-4 text-gray-400 flex-shrink-0" />}
                        <span className="text-sm font-medium text-gray-900 truncate">{a.label ?? (a.kind === 'sequence' ? 'Sequence' : 'Sender')}</span>
                        <span className="text-xs text-gray-500 truncate">{a.reason}</span>
                      </span>
                      <ArrowRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
