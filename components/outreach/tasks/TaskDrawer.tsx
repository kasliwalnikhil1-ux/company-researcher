'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, ExternalLink, RefreshCw, Sparkles, Check, XCircle, MessageSquare, Contact, Loader2, Building2 } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { useLead, useMessages, useSender } from '@/lib/outreach/queries';
import { NODE_CATALOG, TEXT_LIMITS } from '@/lib/outreach/nodes';
import { renderTemplate } from '@/lib/outreach/render';
import type { Graph, Member, Task, TaskKind } from '@/lib/outreach/types';
import { Avatar, Badge, Button, ErrorBox, Spinner, Textarea, fmtDate } from '@/components/outreach/ui';

export const TASK_KIND_LABEL: Record<TaskKind, string> = { manual_node: 'Manual step', follow_up: 'Follow-up', review_ai_draft: 'Review AI draft', reconnect: 'Reconnect sender' };
export const TASK_KIND_TONE: Record<TaskKind, 'blue' | 'amber' | 'purple' | 'red'> = { manual_node: 'blue', follow_up: 'amber', review_ai_draft: 'purple', reconnect: 'red' };

const OUTREACH_TEXT_TYPES = new Set(['send_invite', 'send_message', 'send_inmail', 'send_email', 'comment_latest_post']);
const DRAFT_WAIT_MS = 60_000;

export function memberName(members: Member[] | undefined, id: string | null | undefined, fallback = 'Unassigned') {
  if (!id) return fallback;
  const m = members?.find((x) => x.user_id === id);
  return m ? (m.display_name || m.email || `${id.slice(0, 8)}…`) : 'Former member';
}

export function draftLimit(kind: string | null | undefined, isPremium: boolean | undefined): number {
  if (kind === 'invite_note') return isPremium ? TEXT_LIMITS.invite_note : TEXT_LIMITS.invite_note_free;
  if (kind === 'comment') return TEXT_LIMITS.comment;
  return TEXT_LIMITS.message;
}

export interface TaskDrawerProps {
  taskId: string;
  onClose: () => void;
  members: Member[] | undefined;
  workspaceId: string;
  canWrite: boolean;
  toast: (msg: string, type?: 'success' | 'error') => void;
}

export default function TaskDrawer({ taskId, onClose, members, workspaceId, canWrite, toast }: TaskDrawerProps) {
  const qc = useQueryClient();
  const [openedAt] = useState(() => Date.now());
  const taskQ = useQuery({
    queryKey: ['outreach', 'task', taskId],
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_tasks').select('*').eq('id', taskId).single();
      if (error) throw parseError(error);
      return data as Task;
    },
    refetchInterval: (q) => { const t = q.state.data; return t && t.kind === 'review_ai_draft' && !t.ai_draft && !t.completed_at ? 5000 : false; },
  });
  const task = taskQ.data;
  const senderQ = useSender(task?.sender_id);
  const leadQ = useLead(task?.lead_id);
  const lead = leadQ.data?.lead;
  const enrollmentQ = useQuery({
    queryKey: ['outreach', 'task', taskId, 'enrollment', task?.enrollment_id ?? ''],
    enabled: !!task?.enrollment_id,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_enrollments').select('id, sequence_id, status, outreach_sequences(id, name, graph)').eq('id', task!.enrollment_id!).single();
      if (error) throw parseError(error);
      return data as unknown as { id: string; sequence_id: string; status: string; outreach_sequences: { id: string; name: string; graph: Graph } | null };
    },
  });
  const messagesQ = useMessages(task?.kind === 'follow_up' ? task.chat_id : null);

  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (task?.kind === 'review_ai_draft' && !task.ai_draft) { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); } }, [task?.kind, task?.ai_draft]);

  const node = useMemo(() => {
    const g = enrollmentQ.data?.outreach_sequences?.graph;
    return g && task?.node_id ? g.nodes[task.node_id] : undefined;
  }, [enrollmentQ.data, task?.node_id]);
  const isOutreachNode = !!node && OUTREACH_TEXT_TYPES.has(node.type);

  // Seed the editable text: AI draft for review tasks, rendered node template for outreach manual nodes.
  useEffect(() => {
    if (!task || dirty) return;
    if (task.kind === 'review_ai_draft') { if (task.ai_draft) setText(task.ai_draft); return; }
    if (task.kind === 'manual_node' && isOutreachNode && node) {
      const tpl = node.config?.text ?? node.config?.note ?? node.config?.html ?? '';
      setText(renderTemplate(String(tpl), { lead: lead ?? {}, sender: senderQ.data ?? null }));
    }
  }, [task, dirty, isOutreachNode, node, lead, senderQ.data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['outreach', 'task', taskId] });
    qc.invalidateQueries({ queryKey: ['outreach', workspaceId, 'tasks'] });
    qc.invalidateQueries({ queryKey: ['outreach', workspaceId, 'dashboard'] });
    if (task?.lead_id) qc.invalidateQueries({ queryKey: ['outreach', 'lead', task.lead_id] });
  };
  const run = async (label: string, fn: () => Promise<void>, success?: string, close = false) => {
    setBusy(label);
    try { await fn(); invalidate(); if (success) toast(success); if (close) onClose(); }
    catch (e) { toast(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  };

  const assign = (assigned_to: string | null) => run('assign', async () => {
    const { error } = await supabase.from('outreach_tasks').update({ assigned_to }).eq('id', taskId);
    if (error) throw parseError(error);
  });
  const regenerate = () => run('regen', async () => {
    const r = await callFn<{ text?: string }>('ai-draft', { task_id: taskId });
    if (r?.text) { setText(r.text); setDirty(false); }
  }, 'Draft regenerated');
  const approve = () => run('approve', () => rpc('complete_task', { p_id: taskId, p_text: text.trim(), p_result: null }), 'Approved — queued for sending', true);
  const reject = () => run('reject', () => rpc('complete_task', { p_id: taskId, p_text: null, p_result: { decision: 'reject' } }), 'Draft rejected', true);
  const done = (withText: boolean) => run('done', () => rpc('complete_task', { p_id: taskId, p_text: withText && text.trim() ? text.trim() : null, p_result: null }), 'Task completed', true);

  const limit = draftLimit(task?.draft_kind ?? node?.config?.kind, senderQ.data?.is_premium);
  const over = text.length > limit;
  const draftPending = task?.kind === 'review_ai_draft' && !task.ai_draft && !task.completed_at;
  const draftTimedOut = draftPending && now - openedAt > DRAFT_WAIT_MS;
  const completed = !!task?.completed_at;
  const lastInbound = useMemo(() => [...(messagesQ.data ?? [])].reverse().find((m) => m.direction === 'in'), [messagesQ.data]);
  const overdue = task?.due_at && !completed && new Date(task.due_at).getTime() < Date.now();

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-xl h-full bg-white shadow-xl flex flex-col" role="dialog" aria-label="Task details">
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-gray-200">
          <div className="min-w-0">
            {task && <Badge tone={TASK_KIND_TONE[task.kind]}>{TASK_KIND_LABEL[task.kind]}</Badge>}
            <h2 className="text-base font-semibold text-gray-900 mt-1 truncate">{task?.title ?? 'Task'}</h2>
            {task && (
              <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-3">
                <span className={overdue ? 'text-red-600 font-medium' : ''}>{task.due_at ? `Due ${fmtDate(task.due_at)}` : 'No due date'}</span>
                <span>Created {fmtDate(task.created_at)}</span>
                {completed && <span className="text-green-700">Completed {fmtDate(task.completed_at)} by {memberName(members, task.completed_by, 'system')}</span>}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-md hover:bg-gray-100 text-gray-500" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {taskQ.isLoading && <Spinner />}
          {taskQ.error && <ErrorBox message={parseError(taskQ.error).message} />}
          {task && (
            <>
              {/* Lead + sender context */}
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="border border-gray-200 rounded-xl p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">Lead</div>
                  {lead ? (
                    <div className="flex items-start gap-2">
                      <Avatar src={lead.picture_url} name={lead.full_name} size={9} />
                      <div className="min-w-0 text-xs">
                        <Link href={`/outreach/leads/${lead.id}`} className="text-sm font-medium text-gray-900 hover:text-indigo-600 inline-flex items-center gap-1 truncate">{lead.full_name ?? 'Lead'}<ExternalLink className="w-3 h-3 text-gray-400" /></Link>
                        {lead.headline && <div className="text-gray-600 line-clamp-2">{lead.headline}</div>}
                        {lead.company && <div className="text-gray-500 inline-flex items-center gap-1"><Building2 className="w-3 h-3" />{[lead.title, lead.company].filter(Boolean).join(' @ ')}</div>}
                        {lead.profile_url && <a href={lead.profile_url} target="_blank" rel="noopener noreferrer" className="block text-[#0a66c2] hover:underline">LinkedIn profile</a>}
                      </div>
                    </div>
                  ) : task.lead_id && leadQ.isLoading ? <div className="text-xs text-gray-400">Loading…</div> : <div className="text-xs text-gray-400">No lead attached</div>}
                </div>
                <div className="border border-gray-200 rounded-xl p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">Sender</div>
                  {senderQ.data ? (
                    <div className="flex items-center gap-2 text-xs">
                      <Avatar src={senderQ.data.picture_url} name={senderQ.data.display_name} size={8} />
                      <div className="min-w-0">
                        <Link href={`/outreach/senders/${senderQ.data.id}`} className="text-sm font-medium text-gray-900 hover:text-indigo-600 inline-flex items-center gap-1 truncate">{senderQ.data.display_name ?? senderQ.data.provider}<ExternalLink className="w-3 h-3 text-gray-400" /></Link>
                        <div className="text-gray-500">{senderQ.data.status}{senderQ.data.is_premium ? ' · Premium' : ''}</div>
                      </div>
                    </div>
                  ) : <div className="text-xs text-gray-400">{task.sender_id ? 'Loading…' : 'No sender'}</div>}
                  <label className="block mt-3">
                    <span className="block text-[11px] text-gray-500 mb-1">Assigned to</span>
                    <select value={task.assigned_to ?? ''} disabled={!canWrite || completed || busy === 'assign'} onChange={(e) => assign(e.target.value || null)} className="w-full text-xs px-2 py-1.5 rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" aria-label="Assign task">
                      <option value="">Unassigned</option>
                      {members?.map((m) => <option key={m.user_id} value={m.user_id}>{memberName(members, m.user_id)}</option>)}
                    </select>
                  </label>
                </div>
              </div>

              {/* Kind-specific body */}
              {task.kind === 'review_ai_draft' && (
                <div className="space-y-3">
                  {task.body && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Brief</div>
                      <p className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded-lg p-3">{task.body}</p>
                    </div>
                  )}
                  {completed ? (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Outcome</div>
                      {task.result?.decision === 'reject' ? <Badge tone="red">Rejected</Badge> : <p className="text-sm text-gray-800 whitespace-pre-wrap bg-indigo-50 border border-indigo-100 rounded-lg p-3">{task.ai_draft}</p>}
                    </div>
                  ) : (
                    <>
                      {draftPending && !draftTimedOut && (
                        <div className="flex items-center gap-2 text-sm text-gray-600 bg-fuchsia-50 border border-fuchsia-100 rounded-lg p-3"><Loader2 className="w-4 h-4 animate-spin text-fuchsia-500" /> Drafting with AI… this usually takes under a minute.</div>
                      )}
                      {draftTimedOut && (
                        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">No draft arrived yet. AI drafting may not be configured for this workspace (an owner can check Settings → Integrations). You can write the text yourself below and approve it.</div>
                      )}
                      <Textarea label={`Draft (${task.draft_kind?.replace(/_/g, ' ') ?? node?.config?.kind ?? 'message'})`} value={text} onChange={(e) => { setText(e.target.value); setDirty(true); }} counter={{ max: limit, value: text.length }} className="min-h-[160px]" hint={task.draft_kind === 'invite_note' ? `Invitation notes are limited to ${limit} characters for this sender${senderQ.data?.is_premium ? '' : ' (free LinkedIn account)'}.` : undefined} />
                      {canWrite && (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button variant="secondary" size="sm" loading={busy === 'regen'} onClick={regenerate}><RefreshCw className="w-3.5 h-3.5" /> Regenerate</Button>
                          <div className="flex-1" />
                          <Button variant="secondary" size="sm" className="text-red-600" loading={busy === 'reject'} onClick={reject}><XCircle className="w-3.5 h-3.5" /> Reject</Button>
                          <Button size="sm" loading={busy === 'approve'} disabled={!text.trim() || over} onClick={approve} title={over ? 'Text exceeds the limit' : undefined}><Sparkles className="w-3.5 h-3.5" /> Approve & send</Button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {task.kind === 'manual_node' && (
                <div className="space-y-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Instructions</div>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded-lg p-3">{task.body || 'Complete this step manually, then mark it done to let the sequence continue.'}</p>
                  </div>
                  {enrollmentQ.data && (
                    <div className="text-xs text-gray-500">
                      Sequence <Link href={`/outreach/sequences/${enrollmentQ.data.sequence_id}`} className="text-indigo-600 hover:underline">{enrollmentQ.data.outreach_sequences?.name ?? 'sequence'}</Link>
                      {node && <> · step <span className="text-gray-700">{node.label || NODE_CATALOG[node.type]?.label || node.type}</span></>}
                      {enrollmentQ.data.status !== 'waiting_task' && <> · enrollment is <span className="text-gray-700">{enrollmentQ.data.status.replace(/_/g, ' ')}</span></>}
                    </div>
                  )}
                  {completed ? (
                    task.result?.text ? <div><div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Sent copy</div><p className="text-sm text-gray-800 whitespace-pre-wrap bg-indigo-50 border border-indigo-100 rounded-lg p-3">{String(task.result.text)}</p></div> : null
                  ) : (
                    <>
                      {isOutreachNode && (
                        <Textarea label="Text to send (optional — overrides the node copy)" value={text} onChange={(e) => { setText(e.target.value); setDirty(true); }} counter={{ max: limit, value: text.length }} className="min-h-[140px]" hint="When you mark this done, the sequence queues the step with this text on the sender." />
                      )}
                      {canWrite && <div className="flex justify-end"><Button size="sm" loading={busy === 'done'} disabled={isOutreachNode && over} onClick={() => done(isOutreachNode)}><Check className="w-3.5 h-3.5" /> Mark done</Button></div>}
                    </>
                  )}
                </div>
              )}

              {task.kind === 'follow_up' && (
                <div className="space-y-3">
                  {(task.body || lastInbound?.summary) && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Summary</div>
                      {task.body && <p className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded-lg p-3">{task.body}</p>}
                      {lastInbound?.summary && <p className="text-sm text-gray-600 italic mt-2 inline-flex items-start gap-1"><Sparkles className="w-3.5 h-3.5 mt-0.5 text-fuchsia-500 flex-shrink-0" />{lastInbound.summary}</p>}
                    </div>
                  )}
                  {lastInbound?.text && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Latest reply</div>
                      <p className="text-sm text-gray-800 whitespace-pre-wrap bg-white border border-gray-200 rounded-lg p-3 line-clamp-6">{lastInbound.text}</p>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {task.chat_id && <Link href={`/outreach/inbox/${task.chat_id}`} className="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:underline"><MessageSquare className="w-4 h-4" /> Open conversation</Link>}
                    <div className="flex-1" />
                    {!completed && canWrite && <Button size="sm" loading={busy === 'done'} onClick={() => done(false)}><Check className="w-3.5 h-3.5" /> Done</Button>}
                  </div>
                </div>
              )}

              {task.kind === 'reconnect' && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-700 whitespace-pre-wrap bg-red-50 border border-red-100 rounded-lg p-3">{task.body || 'The sender lost its session. Open the sender page to send a new login link or re-sync the extension cookie.'}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {task.sender_id && <Link href={`/outreach/senders/${task.sender_id}`} className="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:underline"><Contact className="w-4 h-4" /> Open sender page</Link>}
                    <div className="flex-1" />
                    {!completed && canWrite && <Button size="sm" loading={busy === 'done'} onClick={() => done(false)}><Check className="w-3.5 h-3.5" /> Done</Button>}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
