'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { X, ExternalLink, Linkedin, MapPin, Building2, Plus, UserPlus, Ban, CheckSquare, Repeat, Pause, Play, LogOut, Loader2 } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { rpc, parseError } from '@/lib/outreach/api';
import { qk, useLead, useLists, useSequences, useSenders, useStages, useTags, useTasks } from '@/lib/outreach/queries';
import { NODE_CATALOG } from '@/lib/outreach/nodes';
import { LIVE_ENROLLMENT_STATUSES, type Enrollment, type Member, type Relation, type Tag } from '@/lib/outreach/types';
import { Avatar, Badge, Button, EnrollmentBadge, ErrorBox, Spinner, Toggle, fmtDate, timeAgo } from '@/components/outreach/ui';
import type { ChatDetail, ConvertKind } from './Thread';
import { CreateTaskModal, ReenrolModal, ConfirmModal, type CreateTaskInput } from './LeadActions';
import { memberLabel } from './hooks';

export interface LeadPanelProps {
  chat: ChatDetail;
  workspaceId: string;
  canWrite: boolean;
  members: Member[] | undefined;
  currentUserId: string | null;
  requestedAction: ConvertKind | null;
  onActionHandled: () => void;
  onClose?: () => void;
  toast: (msg: string, type?: 'success' | 'error') => void;
}

const RELATION_TONE: Record<Relation, 'gray' | 'green' | 'blue' | 'amber' | 'red'> = { none: 'gray', pending_out: 'blue', pending_in: 'amber', first: 'green', blocked: 'red', invalid: 'red' };
const RELATION_LABEL: Record<Relation, string> = { none: 'Not connected', pending_out: 'Invite pending', pending_in: 'They invited', first: '1st degree', blocked: 'Blocked', invalid: 'Invalid' };

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="px-4 py-3 border-b border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function LeadPanel({ chat, workspaceId, canWrite, members, currentUserId, requestedAction, onActionHandled, onClose, toast }: LeadPanelProps) {
  const qc = useQueryClient();
  const leadId = chat.lead_id;
  const leadQ = useLead(leadId);
  const tagsQ = useTags(workspaceId);
  const stagesQ = useStages(workspaceId);
  const listsQ = useLists(workspaceId);
  const seqQ = useSequences(workspaceId);
  const sendersQ = useSenders(workspaceId);
  const tasksQ = useTasks(workspaceId, { lead_id: leadId ?? null, open: true });

  const [taskOpen, setTaskOpen] = useState(false);
  const [reenrolOpen, setReenrolOpen] = useState(false);
  const [dncOpen, setDncOpen] = useState(false);
  const [exitTarget, setExitTarget] = useState<Enrollment | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLSelectElement>(null);

  const lead = leadQ.data?.lead ?? null;
  const senderName = chat.outreach_senders?.display_name ?? 'this sender';

  const invalidate = () => {
    if (leadId) qc.invalidateQueries({ queryKey: qk.lead(leadId) });
    qc.invalidateQueries({ queryKey: ['outreach', workspaceId, 'tasks'] });
    qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
    qc.invalidateQueries({ queryKey: ['outreach', workspaceId, 'leads'] });
    qc.invalidateQueries({ queryKey: qk.chat(chat.id) });
    qc.invalidateQueries({ queryKey: ['outreach', workspaceId, 'chats'] });
  };

  const run = async (label: string, fn: () => Promise<void>, success?: string) => {
    setBusy(label);
    try { await fn(); invalidate(); if (success) toast(success); }
    catch (e) { toast(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  };

  // "Convert reply into…" requests coming from the thread header.
  useEffect(() => {
    if (!requestedAction) return;
    if (leadId && leadQ.isLoading) return; // wait for the lead to load
    if (!lead) { toast('Create a lead from this conversation first.', 'error'); onActionHandled(); return; }
    if (requestedAction === 'task') setTaskOpen(true);
    else if (requestedAction === 'reenrol') setReenrolOpen(true);
    else if (requestedAction === 'tag') { tagInputRef.current?.scrollIntoView({ block: 'center' }); tagInputRef.current?.focus(); }
    else if (requestedAction === 'stage') { stageRef.current?.scrollIntoView({ block: 'center' }); stageRef.current?.focus(); }
    onActionHandled();
  }, [requestedAction, lead, leadId, leadQ.isLoading, onActionHandled, toast]);

  const createLead = () => run('create-lead', async () => {
    const attendee = chat.attendee_provider_id ?? '';
    const looksEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(attendee);
    const p_lead: Record<string, unknown> = { full_name: chat.attendee_name, picture_url: chat.attendee_picture_url, client_id: chat.client_id };
    if (chat.provider === 'LINKEDIN') {
      p_lead.public_identifier = chat.attendee_public_identifier ?? chat.attendee_provider_id;
      p_lead.provider_id = chat.attendee_provider_id;
      if (chat.attendee_public_identifier) p_lead.profile_url = `https://www.linkedin.com/in/${chat.attendee_public_identifier}/`;
    } else if (looksEmail) {
      p_lead.email_work = attendee;
    } else {
      p_lead.public_identifier = chat.attendee_public_identifier ?? attendee;
    }
    const res = await rpc<Array<{ id: string; created: boolean }> | { id: string; created: boolean }>('upsert_lead', { p_ws: workspaceId, p_lead, p_source: 'inbox' });
    const row = Array.isArray(res) ? res[0] : res;
    if (!row?.id) throw new Error('Lead was not created');
    const { error } = await supabase.from('outreach_chats').update({ lead_id: row.id }).eq('id', chat.id);
    if (error) throw parseError(error);
  }, 'Lead created and linked to this conversation');

  const state = leadQ.data?.states.find((s) => s.sender_id === chat.sender_id);
  const otherStates = (leadQ.data?.states ?? []).filter((s) => s.sender_id !== chat.sender_id);
  const activeEnrollment = leadQ.data?.enrollments.find((e) => LIVE_ENROLLMENT_STATUSES.includes(e.status)) ?? null;
  const activeSeq = activeEnrollment ? seqQ.data?.find((s) => s.id === activeEnrollment.sequence_id) : undefined;
  const currentNode = activeEnrollment?.current_node_id && activeSeq ? activeSeq.graph.nodes[activeEnrollment.current_node_id] : undefined;
  const nodeLabel = currentNode ? (currentNode.label || NODE_CATALOG[currentNode.type]?.label || currentNode.type) : activeEnrollment?.current_node_id ?? '—';

  const leadTags = useMemo(() => {
    const ids = new Set(leadQ.data?.tagIds ?? []);
    return (tagsQ.data ?? []).filter((t) => ids.has(t.id));
  }, [leadQ.data?.tagIds, tagsQ.data]);
  const availableTags = useMemo(() => {
    const ids = new Set(leadQ.data?.tagIds ?? []);
    return (tagsQ.data ?? []).filter((t) => !ids.has(t.id));
  }, [leadQ.data?.tagIds, tagsQ.data]);

  const addTag = async () => {
    const name = tagInput.trim();
    if (!name || !lead) return;
    await run('tag', async () => {
      let tag: Tag | undefined = tagsQ.data?.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (!tag) {
        const { data, error } = await supabase.from('outreach_tags').insert({ workspace_id: workspaceId, name }).select('*').single();
        if (error) throw parseError(error);
        tag = data as Tag;
        qc.invalidateQueries({ queryKey: qk.tags(workspaceId) });
      }
      if (leadQ.data?.tagIds.includes(tag.id)) return;
      const { error } = await supabase.from('outreach_lead_tags').insert({ lead_id: lead.id, tag_id: tag.id });
      if (error) throw parseError(error);
    });
    setTagInput('');
  };
  const removeTag = (tagId: string) => lead && run(`untag-${tagId}`, async () => {
    const { error } = await supabase.from('outreach_lead_tags').delete().eq('lead_id', lead.id).eq('tag_id', tagId);
    if (error) throw parseError(error);
  });
  const updateLead = (patch: Record<string, unknown>, success?: string) => lead && run('lead', async () => {
    const { error } = await supabase.from('outreach_leads').update(patch).eq('id', lead.id);
    if (error) throw parseError(error);
  }, success);

  const createTask = async (t: CreateTaskInput) => {
    if (!lead) return;
    await run('task', async () => {
      const { error } = await supabase.from('outreach_tasks').insert({
        workspace_id: workspaceId, client_id: lead.client_id ?? chat.client_id, kind: 'follow_up', lead_id: lead.id, sender_id: chat.sender_id, chat_id: chat.id,
        title: t.title, body: t.body, due_at: t.due_at, assigned_to: t.assigned_to,
      });
      if (error) throw parseError(error);
    }, 'Task created');
  };

  const enrol = async (sequenceId: string, withSender: boolean) => {
    if (!lead) return;
    await run('enrol', async () => {
      const res = await rpc<Array<{ enrolled: number; skipped_active: number; skipped_suppressed: number; skipped_other: number }>>('enroll_leads', { p_sequence: sequenceId, p_lead_ids: [lead.id], p_sender: withSender ? chat.sender_id : null, p_priority: 100 });
      const r = Array.isArray(res) ? res[0] : (res as any);
      if (!r || r.enrolled < 1) {
        const why = r?.skipped_active ? 'the lead already has a live enrollment in this sequence' : r?.skipped_suppressed ? 'the lead is suppressed or marked do-not-contact' : 'the lead was skipped';
        throw new Error(`Not enrolled: ${why}.`);
      }
    }, 'Lead enrolled');
  };

  const dnc = !!lead?.do_not_contact;

  return (
    <div className="flex flex-col h-full min-h-0 bg-white">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
        <h3 className="text-sm font-semibold text-gray-900">Lead</h3>
        <div className="flex items-center gap-1">
          {lead && <Link href={`/outreach/leads/${lead.id}`} className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-1">Open <ExternalLink className="w-3 h-3" /></Link>}
          {onClose && <button type="button" onClick={onClose} className="p-1 rounded-md hover:bg-gray-100 text-gray-500 xl:hidden" aria-label="Close lead panel"><X className="w-4 h-4" /></button>}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {leadId && leadQ.isLoading && <Spinner />}
        {leadQ.error && <ErrorBox message={parseError(leadQ.error).message} className="m-3" />}

        {!leadId && (
          <div className="px-4 py-5">
            <div className="flex items-center gap-3">
              <Avatar src={chat.attendee_picture_url} name={chat.attendee_name} size={12} />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-900 truncate">{chat.attendee_name ?? 'Unknown'}</div>
                <div className="text-xs text-gray-500 truncate">{chat.attendee_public_identifier ?? chat.attendee_provider_id ?? '—'}</div>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-3">This conversation is not linked to a lead yet. Create one to track relation state, enrol in sequences and add tags or tasks.</p>
            {canWrite && <Button className="mt-3 w-full" size="sm" loading={busy === 'create-lead'} onClick={createLead}><UserPlus className="w-4 h-4" /> Create lead from this conversation</Button>}
          </div>
        )}

        {lead && (
          <>
            <div className="px-4 py-4 border-b border-gray-100">
              <div className="flex items-start gap-3">
                <Avatar src={lead.picture_url ?? chat.attendee_picture_url} name={lead.full_name} size={12} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-gray-900 truncate">{lead.full_name ?? chat.attendee_name ?? 'Unknown'}</div>
                  {lead.headline && <div className="text-xs text-gray-600 mt-0.5 line-clamp-2">{lead.headline}</div>}
                  {(lead.company || lead.title) && <div className="text-xs text-gray-500 mt-1 inline-flex items-center gap-1"><Building2 className="w-3 h-3" />{[lead.title, lead.company].filter(Boolean).join(' @ ')}</div>}
                  {lead.location && <div className="text-xs text-gray-500 mt-0.5 inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{lead.location}</div>}
                  {(lead.email_work || lead.email_personal) && <div className="text-xs text-gray-500 mt-0.5 truncate">{lead.email_work ?? lead.email_personal}</div>}
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {lead.profile_url && <a href={lead.profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-[#0a66c2] hover:underline inline-flex items-center gap-1"><Linkedin className="w-3 h-3" /> LinkedIn</a>}
                    {dnc && <Badge tone="red">Do not contact</Badge>}
                    {lead.unsubscribed && <Badge tone="amber">Unsubscribed</Badge>}
                  </div>
                </div>
              </div>
            </div>

            <Section title={`Relation · ${senderName}`}>
              {state ? (
                <div className="space-y-1 text-xs text-gray-600">
                  <div className="flex items-center gap-2"><Badge tone={RELATION_TONE[state.relation]}>{RELATION_LABEL[state.relation]}</Badge>{state.replied && <Badge tone="purple">Replied</Badge>}{state.email_bounced && <Badge tone="red">Email bounced</Badge>}</div>
                  {state.invite_sent_at && <div>Invite sent {fmtDate(state.invite_sent_at)}{state.invite_had_note ? ' (with note)' : ''}</div>}
                  {state.invite_accepted_at && <div>Accepted {fmtDate(state.invite_accepted_at)}</div>}
                  {state.invite_withdrawn_at && <div>Withdrawn {fmtDate(state.invite_withdrawn_at)}</div>}
                  {state.last_inbound_at && <div>Last reply {timeAgo(state.last_inbound_at)}</div>}
                </div>
              ) : <p className="text-xs text-gray-500">No relation tracked with this sender yet.</p>}
              {otherStates.length > 0 && (
                <div className="mt-2 space-y-1">
                  {otherStates.map((s) => (
                    <div key={s.sender_id} className="flex items-center justify-between text-xs text-gray-500">
                      <span className="truncate">{sendersQ.data?.find((x) => x.id === s.sender_id)?.display_name ?? 'Other sender'}</span>
                      <Badge tone={RELATION_TONE[s.relation]}>{RELATION_LABEL[s.relation]}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Sequence" action={canWrite && !dnc && <button type="button" onClick={() => setReenrolOpen(true)} className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-1"><Repeat className="w-3 h-3" />{activeEnrollment ? 'Enrol in another' : 'Enrol'}</button>}>
              {activeEnrollment ? (
                <div className="text-xs text-gray-600 space-y-1.5">
                  <div className="font-medium text-gray-900 truncate">{activeSeq?.name ?? 'Sequence'}</div>
                  <div className="flex items-center gap-2 flex-wrap"><EnrollmentBadge status={activeEnrollment.status} /><span className="truncate">Step: {nodeLabel}</span></div>
                  {activeEnrollment.wait_until && <div>Next at {fmtDate(activeEnrollment.wait_until)}</div>}
                  {canWrite && (
                    <div className="flex items-center gap-1.5 pt-1">
                      {activeEnrollment.status === 'paused'
                        ? <Button size="sm" variant="secondary" loading={busy === 'resume'} onClick={() => run('resume', () => rpc('resume_enrollment', { p_id: activeEnrollment.id }), 'Enrollment resumed')}><Play className="w-3 h-3" /> Resume</Button>
                        : <Button size="sm" variant="secondary" loading={busy === 'pause'} onClick={() => run('pause', () => rpc('pause_enrollment', { p_id: activeEnrollment.id }), 'Enrollment paused')}><Pause className="w-3 h-3" /> Pause</Button>}
                      <Button size="sm" variant="secondary" className="text-red-600" onClick={() => setExitTarget(activeEnrollment)}><LogOut className="w-3 h-3" /> Exit</Button>
                    </div>
                  )}
                </div>
              ) : <p className="text-xs text-gray-500">{dnc ? 'Lead is marked do-not-contact.' : 'Not enrolled in any sequence.'}</p>}
            </Section>

            <Section title="Tags">
              <div className="flex flex-wrap gap-1.5 mb-2">
                {leadTags.length === 0 && <span className="text-xs text-gray-400">No tags</span>}
                {leadTags.map((t) => (
                  <span key={t.id} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.color ?? '#6366f1' }} />{t.name}
                    {canWrite && <button type="button" onClick={() => removeTag(t.id)} className="text-indigo-400 hover:text-red-600" aria-label={`Remove tag ${t.name}`}>{busy === `untag-${t.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}</button>}
                  </span>
                ))}
              </div>
              {canWrite && (
                <div className="flex items-center gap-1.5">
                  <input ref={tagInputRef} list="outreach-inbox-tags" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} placeholder="Add or create tag" aria-label="Add tag" className="flex-1 text-xs px-2 py-1.5 rounded-md border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <datalist id="outreach-inbox-tags">{availableTags.map((t) => <option key={t.id} value={t.name} />)}</datalist>
                  <Button size="sm" variant="secondary" disabled={!tagInput.trim()} loading={busy === 'tag'} onClick={addTag} title="Add tag"><Plus className="w-3 h-3" /></Button>
                </div>
              )}
            </Section>

            <Section title="Pipeline">
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="block text-[11px] text-gray-500 mb-1">Stage</span>
                  <select ref={stageRef} value={lead.stage_id ?? ''} disabled={!canWrite} onChange={(e) => updateLead({ stage_id: e.target.value || null }, 'Stage updated')} className="w-full text-xs px-2 py-1.5 rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="">No stage</option>
                    {stagesQ.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-[11px] text-gray-500 mb-1">List</span>
                  <select value={lead.list_id ?? ''} disabled={!canWrite} onChange={(e) => updateLead({ list_id: e.target.value || null }, 'List updated')} className="w-full text-xs px-2 py-1.5 rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                    <option value="">No list</option>
                    {listsQ.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-gray-600 inline-flex items-center gap-1"><Ban className="w-3 h-3 text-gray-400" /> Do not contact</span>
                <Toggle checked={dnc} disabled={!canWrite} onChange={(v) => { if (v) setDncOpen(true); else updateLead({ do_not_contact: false }, 'Lead can be contacted again'); }} />
              </div>
            </Section>

            <Section title="Tasks" action={canWrite && <button type="button" onClick={() => setTaskOpen(true)} className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-1"><Plus className="w-3 h-3" /> Create task</button>}>
              {tasksQ.isLoading && <div className="text-xs text-gray-400">Loading…</div>}
              {tasksQ.data && tasksQ.data.length === 0 && <p className="text-xs text-gray-500">No open tasks.</p>}
              <ul className="space-y-1.5">
                {tasksQ.data?.map((t) => {
                  const overdue = t.due_at && new Date(t.due_at).getTime() < Date.now();
                  return (
                    <li key={t.id} className="text-xs">
                      <Link href={`/outreach/tasks?task=${t.id}`} className="flex items-start gap-1.5 hover:bg-gray-50 rounded-md -mx-1 px-1 py-1">
                        <CheckSquare className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-gray-800 truncate">{t.title}</span>
                          <span className={`block ${overdue ? 'text-red-600' : 'text-gray-400'}`}>{t.kind.replace(/_/g, ' ')}{t.due_at ? ` · due ${fmtDate(t.due_at)}` : ''}{t.assigned_to ? ` · ${memberLabel(members?.find((m) => m.user_id === t.assigned_to), 'member')}` : ''}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Section>
          </>
        )}
      </div>

      {lead && (
        <>
          <CreateTaskModal open={taskOpen} onClose={() => setTaskOpen(false)} onCreate={createTask} members={members} currentUserId={currentUserId} defaultTitle={`Follow up with ${lead.full_name ?? chat.attendee_name ?? 'lead'}`} />
          <ReenrolModal open={reenrolOpen} onClose={() => setReenrolOpen(false)} sequences={seqQ.data} senderId={chat.sender_id} senderName={senderName} onEnrol={enrol} />
          <ConfirmModal open={dncOpen} onClose={() => setDncOpen(false)} title="Mark as do-not-contact?" danger confirmLabel="Mark do-not-contact" onConfirm={async () => { await updateLead({ do_not_contact: true }, 'Lead marked do-not-contact'); }} message={<>No sender will contact <span className="font-medium">{lead.full_name ?? 'this lead'}</span> again. Live enrollments are exited by the engine. You can still reply manually here.</>} />
          <ConfirmModal open={!!exitTarget} onClose={() => setExitTarget(null)} title="Exit enrollment?" danger confirmLabel="Exit" onConfirm={async () => { if (exitTarget) await run('exit', () => rpc('exit_enrollment', { p_id: exitTarget.id, p_reason: 'manual' }), 'Enrollment exited'); }} message={<>The lead leaves <span className="font-medium">{activeSeq?.name ?? 'the sequence'}</span> now. Queued actions for this enrollment are cancelled.</>} />
        </>
      )}
    </div>
  );
}
