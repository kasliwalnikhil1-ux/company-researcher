'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSenders } from '@/lib/outreach/queries';
import { parseError, rpc } from '@/lib/outreach/api';
import type { Action, Chat, Task } from '@/lib/outreach/types';
import { Badge, Card, EmptyState, ErrorBox, IntentBadge, Spinner, fmtDate, timeAgo } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { Activity, CheckSquare, GitBranch, MessageSquare, Zap, ArrowDownLeft, ArrowUpRight } from 'lucide-react';

interface TimelineRow { at: string | null; kind: 'action' | 'message' | 'enrollment' | 'task' | string; title: string; data: Record<string, unknown> | null }

const ACTION_TONE: Record<Action['status'], 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo'> = { queued: 'blue', reserved: 'indigo', sent: 'green', skipped: 'amber', failed: 'red', cancelled: 'gray' };

export function LeadChats({ chats }: { chats: Chat[] }) {
  return (
    <Card title="Conversations" className="[&>div:last-child]:p-0">
      {chats.length === 0 ? <EmptyState title="No conversations yet" description="Chats with this lead appear here once a message is exchanged." /> : (
        <ul className="divide-y divide-gray-100">
          {chats.map((c) => (
            <li key={c.id}>
              <Link href={`/outreach/inbox/${c.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-gray-50">
                <span className={cn('mt-0.5 w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0', c.unread ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500')}><MessageSquare className="w-3.5 h-3.5" /></span>
                <span className="flex-1 min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">{c.provider === 'LINKEDIN' ? 'LinkedIn' : 'Email'}{c.subject ? ` · ${c.subject}` : ''}</span>
                    <IntentBadge intent={c.intent} />
                    {c.unread && <Badge tone="indigo">{c.unread_count > 1 ? `${c.unread_count} unread` : 'unread'}</Badge>}
                    {c.archived && <Badge tone="gray">archived</Badge>}
                  </span>
                  <span className="block text-xs text-gray-600 truncate mt-0.5">{c.last_direction === 'in' ? '← ' : c.last_direction === 'out' ? '→ ' : ''}{c.last_message_preview ?? 'No messages'}</span>
                </span>
                <span className="text-xs text-gray-400 whitespace-nowrap">{timeAgo(c.last_message_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function LeadTasks({ tasks }: { tasks: Task[] }) {
  const open = tasks.filter((t) => !t.completed_at);
  const done = tasks.length - open.length;
  return (
    <Card title={<span>Tasks {done > 0 && <span className="text-xs font-normal text-gray-400">· {done} completed</span>}</span>} actions={<Link href="/outreach/tasks" className="text-xs text-indigo-600 hover:underline">All tasks</Link>}>
      {open.length === 0 ? <p className="text-sm text-gray-400">No open tasks for this lead.</p> : (
        <ul className="space-y-2">
          {open.map((t) => (
            <li key={t.id}>
              <Link href="/outreach/tasks" className="flex items-start gap-2 group">
                <CheckSquare className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm text-gray-900 group-hover:text-indigo-700 truncate">{t.title}</span>
                  <span className="block text-xs text-gray-500">{t.kind.replace(/_/g, ' ')}{t.due_at ? ` · due ${fmtDate(t.due_at)}` : ''}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TimelineIcon({ kind }: { kind: string }) {
  const cls = 'w-3.5 h-3.5';
  if (kind === 'message') return <MessageSquare className={cls} />;
  if (kind === 'enrollment') return <GitBranch className={cls} />;
  if (kind === 'task') return <CheckSquare className={cls} />;
  return <Zap className={cls} />;
}

export function LeadTimeline({ leadId }: { leadId: string }) {
  const q = useQuery({ queryKey: ['outreach', 'lead', leadId, 'timeline'], queryFn: () => rpc<TimelineRow[]>('lead_timeline', { p_lead: leadId }), refetchInterval: 60000 });
  return (
    <Card title="Timeline">
      {q.isLoading ? <Spinner className="py-6" /> : q.error ? <ErrorBox message={parseError(q.error).message} /> : !q.data?.length ? <p className="text-sm text-gray-400">Nothing has happened yet.</p> : (
        <ol className="relative border-l border-gray-200 ml-2 space-y-4">
          {q.data.map((row, i) => {
            const d = row.data ?? {};
            const isMsg = row.kind === 'message';
            const tone = row.kind === 'message' ? 'bg-indigo-100 text-indigo-700' : row.kind === 'enrollment' ? 'bg-purple-100 text-purple-700' : row.kind === 'task' ? 'bg-amber-100 text-amber-700' : String(d.error_code ?? '') ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600';
            return (
              <li key={`${row.kind}-${row.at}-${i}`} className="ml-4">
                <span className={cn('absolute -left-[11px] w-[22px] h-[22px] rounded-full flex items-center justify-center ring-4 ring-white', tone)}><TimelineIcon kind={row.kind} /></span>
                <div className="text-sm text-gray-900">{row.title}{isMsg && d.intent ? <span className="ml-2 inline-block align-middle"><IntentBadge intent={d.intent as Chat['intent']} /></span> : null}</div>
                {isMsg && typeof d.text === 'string' && d.text && <p className="text-xs text-gray-600 mt-0.5 line-clamp-2">{d.text}</p>}
                {row.kind === 'action' && (d.decision || d.error_code) ? <p className="text-xs text-gray-500 mt-0.5">{[d.decision, d.error_code].filter(Boolean).join(' · ')}</p> : null}
                {row.kind === 'enrollment' && typeof d.reason === 'string' && d.reason ? <p className="text-xs text-gray-500 mt-0.5">{d.reason}</p> : null}
                <div className="text-xs text-gray-400 mt-0.5">{fmtDate(row.at)}{isMsg && typeof d.chat_id === 'string' ? <> · <Link href={`/outreach/inbox/${d.chat_id}`} className="text-indigo-600 hover:underline">open chat</Link></> : null}</div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

export function LeadRecentActions({ actions }: { actions: Action[] }) {
  const { workspace } = useWorkspace();
  const senders = useSenders(workspace?.id);
  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><Activity className="w-4 h-4 text-gray-400" /> Recent actions</span>}>
      {actions.length === 0 ? <p className="text-sm text-gray-400">No actions scheduled or executed for this lead.</p> : (
        <ul className="divide-y divide-gray-100 -my-2">
          {actions.slice(0, 30).map((a) => {
            const sender = senders.data?.find((s) => s.id === a.sender_id);
            const upcoming = a.status === 'queued' || a.status === 'reserved';
            return (
              <li key={a.id} className="py-2 flex items-center gap-3 text-sm">
                <span className={cn('w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0', upcoming ? 'bg-blue-50 text-blue-600' : a.status === 'sent' ? 'bg-green-50 text-green-600' : a.status === 'failed' ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-500')}>
                  {a.action_type === 'reply' ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="text-gray-900">{a.action_type.replace(/_/g, ' ')}</span>
                  <span className="text-xs text-gray-500"> · {sender ? (sender.display_name ?? sender.public_identifier ?? 'Sender') : '—'}{a.attempt > 1 ? ` · attempt ${a.attempt}` : ''}{a.error_code ? ` · ${a.error_code}` : ''}{a.decision ? ` · ${a.decision}` : ''}</span>
                </span>
                <Badge tone={ACTION_TONE[a.status]}>{a.status}</Badge>
                <span className="text-xs text-gray-400 whitespace-nowrap hidden sm:inline">{upcoming ? `for ${fmtDate(a.scheduled_for)}` : fmtDate(a.executed_at ?? a.scheduled_for)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
