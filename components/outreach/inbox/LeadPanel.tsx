'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from '@/lib/outreach/nav';
import { X, ExternalLink, Linkedin, MapPin, Building2, Plus, UserPlus, Ban, CheckSquare, Repeat, Pause, Play, LogOut, Loader2, Phone } from 'lucide-react';
import { db } from '@/lib/outreach/backend';
import { rpc, parseError } from '@/lib/outreach/api';
import { qk, useLead, useSequences, useSenders, useStages, useTags, useTasks } from '@/lib/outreach/queries';
import { ListPicker } from '@/components/outreach/leads/ListPicker';
import { NODE_CATALOG } from '@/lib/outreach/nodes';
import { LIVE_ENROLLMENT_STATUSES, type Enrollment, type Member, type Relation, type Tag } from '@/lib/outreach/types';
import { ik, type EnrollmentWithHold, type LeadWithIntel } from '@/lib/outreach/intel';
import { QueuedActions } from '@/components/outreach/leads/detail/QueuedActions';
import { HeldNotice } from '@/components/outreach/leads/detail/HeldNotice';
import { Avatar, Badge, Button, EnrollmentBadge, ErrorBox, Spinner, Toggle, fmtDate, timeAgo } from '@/components/outreach/ui';
import type { ChatDetail, ConvertKind } from './Thread';
import { CreateTaskModal, ReenrolModal, ConfirmModal, type CreateTaskInput } from './LeadActions';
import { memberLabel } from './hooks';
import { activeConsentByChannel, chatTitle, useLeadConsent, useLeadIdentities, visibleName } from '@/lib/outreach/channels';
import { IdentityList } from '@/components/outreach/leads/detail/LeadIdentitiesCard';
import { ConsentBadge, ConsentGrantModal, ConsentRevokeModal } from '@/components/outreach/leads/detail/LeadConsentCard';
import type { LeadConsent } from '@/lib/outreach/types';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import LeadNotesPanel from './ai/LeadNotesPanel';
import { kv } from '@/lib/outreach/storage';

export interface LeadPanelProps {
  chat: ChatDetail;
  workspaceId: string;
  canWrite: boolean;
  members: Member[] | undefined;
  currentUserId: string | null;
  requestedAction: ConvertKind | null;
  /** "Make task" from a private note: pre-fills the task form (title, body, first mentioned person) */
  taskPrefill?: { title: string; body: string; assigned_to: string | null } | null;
  onActionHandled: () => void;
  onClose?: () => void;
  toast: (msg: string, type?: 'success' | 'error') => void;
}

const RELATION_TONE: Record<Relation, 'gray' | 'green' | 'blue' | 'amber' | 'red'> = { none: 'gray', pending_out: 'blue', pending_in: 'amber', first: 'green', blocked: 'red', invalid: 'red' };
const RELATION_LABEL: Record<Relation, string> = { none: 'Not connected', pending_out: 'Invite pending', pending_in: 'They invited', first: '1st degree', blocked: 'Blocked', invalid: 'Invalid' };

type PanelTab = 'contact' | 'sequence' | 'organise' | 'tasks' | 'notes';
// Each tab opens with a one-line guide to what can be done there, like the Leads page tabs.
const PANEL_TABS: { key: PanelTab; label: string; guide: string }[] = [
  { key: 'contact', label: 'Contact', guide: 'How to reach this lead, and where each of your senders stands with them.' },
  { key: 'notes', label: 'Notes', guide: 'Key facts the AI picked up from their messages: budget, timeline, objections. Edit or add your own; every AI draft uses them.' },
  { key: 'tasks', label: 'Tasks', guide: 'Follow-ups for you or a teammate. They also show on the Tasks page.' },
  { key: 'organise', label: 'Organise', guide: 'Tag the lead, set its stage and list, or stop all outreach to them.' },
  { key: 'sequence', label: 'Sequence', guide: 'Enrol, pause or exit automation, and see what goes out next.' },
];
const TAB_STORAGE_KEY = 'outreach.inbox.leadPanelTab';

function readStoredTab(): PanelTab {
  try {
    const v = kv.getItem(TAB_STORAGE_KEY);
    if (PANEL_TABS.some((t) => t.key === v)) return v as PanelTab;
  } catch { /* storage blocked */ }
  return 'contact';
}

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

export default function LeadPanel({ chat, workspaceId, canWrite, members, currentUserId, requestedAction, taskPrefill, onActionHandled, onClose, toast }: LeadPanelProps) {
  const qc = useQueryClient();
  const { canReply } = useWorkspace();
  const leadId = chat.lead_id;
  const leadQ = useLead(leadId);
  const tagsQ = useTags(workspaceId);
  const stagesQ = useStages(workspaceId);
  const seqQ = useSequences(workspaceId);
  const sendersQ = useSenders(workspaceId);
  const tasksQ = useTasks(workspaceId, { lead_id: leadId ?? null, open: true });
  const identitiesQ = useLeadIdentities(leadId);
  const consentQ = useLeadConsent(leadId, workspaceId);
  const activeConsent = useMemo(() => activeConsentByChannel(consentQ.data), [consentQ.data]);
  const [consentOpen, setConsentOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<LeadConsent | null>(null);

  const [taskOpen, setTaskOpen] = useState(false);
  const [reenrolOpen, setReenrolOpen] = useState(false);
  const [dncOpen, setDncOpen] = useState(false);
  const [exitTarget, setExitTarget] = useState<Enrollment | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const isGroup = /@g\.us$/i.test(chat.attendee_provider_id ?? '');
  const tagInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLSelectElement>(null);
  // The chosen tab carries over from one conversation to the next in this browser.
  const [tab, setTabState] = useState<PanelTab>(readStoredTab);
  const setTab = (t: PanelTab) => {
    setTabState(t);
    try { kv.setItem(TAB_STORAGE_KEY, t); } catch { /* storage blocked */ }
  };
  const pendingFocus = useRef<'tag' | 'stage' | null>(null);
  const focusField = (target: 'tag' | 'stage') => {
    const el = target === 'tag' ? tagInputRef.current : stageRef.current;
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
  };

  const lead: LeadWithIntel | null = leadQ.data?.lead ?? null;
  const senderName = chat.outreach_senders?.display_name ?? 'this sender';

  const invalidate = () => {
    if (leadId) { qc.invalidateQueries({ queryKey: qk.lead(leadId) }); qc.invalidateQueries({ queryKey: ik.queued(leadId) }); }
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
    if (requestedAction === 'task') { setTab('tasks'); setTaskOpen(true); }
    else if (requestedAction === 'notes') setTab('notes');
    else if (requestedAction === 'reenrol') { setTab('sequence'); setReenrolOpen(true); }
    else if (requestedAction === 'tag' || requestedAction === 'stage') {
      if (tab === 'organise') focusField(requestedAction);
      else { pendingFocus.current = requestedAction; setTab('organise'); }
    }
    onActionHandled();
  }, [requestedAction, lead, leadId, leadQ.isLoading, onActionHandled, toast, tab]);

  // Focus the tag input / stage picker once the Organise tab has rendered.
  useEffect(() => {
    if (tab !== 'organise' || !pendingFocus.current) return;
    focusField(pendingFocus.current);
    pendingFocus.current = null;
  }, [tab]);

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
    const { error } = await db.from('outreach_chats').update({ lead_id: row.id }).eq('id', chat.id);
    if (error) throw parseError(error);
  }, 'Lead created and linked to this conversation');

  const state = leadQ.data?.states.find((s) => s.sender_id === chat.sender_id);
  const otherStates = (leadQ.data?.states ?? []).filter((s) => s.sender_id !== chat.sender_id);
  const activeEnrollment = leadQ.data?.enrollments.find((e) => LIVE_ENROLLMENT_STATUSES.includes(e.status)) ?? null;
  const heldEnrollment = ((leadQ.data?.enrollments ?? []) as EnrollmentWithHold[]).find((e) => !!e.held_at && e.status === 'paused') ?? null;
  const heldSeq = heldEnrollment ? seqQ.data?.find((s) => s.id === heldEnrollment.sequence_id) : undefined;
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
        const { data, error } = await db.from('outreach_tags').insert({ workspace_id: workspaceId, name }).select('*').single();
        if (error) throw parseError(error);
        tag = data as Tag;
        qc.invalidateQueries({ queryKey: qk.tags(workspaceId) });
      }
      if (leadQ.data?.tagIds.includes(tag.id)) return;
      const { error } = await db.from('outreach_lead_tags').insert({ lead_id: lead.id, tag_id: tag.id });
      if (error) throw parseError(error);
    });
    setTagInput('');
  };
  const removeTag = (tagId: string) => lead && run(`untag-${tagId}`, async () => {
    const { error } = await db.from('outreach_lead_tags').delete().eq('lead_id', lead.id).eq('tag_id', tagId);
    if (error) throw parseError(error);
  });
  const updateLead = (patch: Record<string, unknown>, success?: string) => lead && run('lead', async () => {
    const { error } = await db.from('outreach_leads').update(patch).eq('id', lead.id);
    if (error) throw parseError(error);
  }, success);

  const createTask = async (t: CreateTaskInput) => {
    if (!lead) return;
    await run('task', async () => {
      const { error } = await db.from('outreach_tasks').insert({
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
              <Avatar src={chat.attendee_picture_url} name={chatTitle(chat)} size={12} />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-900 truncate">{chatTitle(chat)}</div>
                {/* WhatsApp "@lid" / group ids are opaque: only a phone or handle is worth showing */}
                <div className="text-xs text-gray-500 truncate">{isGroup ? 'WhatsApp group' : (chat.attendee_public_identifier ?? (/@(lid|g\.us)$/i.test(chat.attendee_provider_id ?? '') ? null : chat.attendee_provider_id) ?? '—')}</div>
              </div>
            </div>
            {isGroup ? (
              <p className="text-xs text-gray-500 mt-3">Group chats are not linked to a lead. Each message shows which member wrote it.</p>
            ) : (
              <>
                <p className="text-xs text-gray-500 mt-3">This conversation is not linked to a lead yet. Create one to track relation state, enrol in sequences and add tags or tasks.</p>
                {canWrite && <Button className="mt-3 w-full" size="sm" loading={busy === 'create-lead'} onClick={createLead}><UserPlus className="w-4 h-4" /> Create lead from this conversation</Button>}
              </>
            )}
          </div>
        )}

        {lead && (
          <>
            <div className="px-4 py-4 border-b border-gray-100">
              <div className="flex items-start gap-3">
                <Avatar src={lead.picture_url ?? chat.attendee_picture_url} name={lead.full_name} size={12} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-gray-900 truncate">{visibleName(lead.full_name) ?? chatTitle(chat)}</div>
                  {lead.headline && <div className="text-xs text-gray-600 mt-0.5 line-clamp-2">{lead.headline}</div>}
                  {(lead.company || lead.title) && <div className="text-xs text-gray-500 mt-1 inline-flex items-center gap-1"><Building2 className="w-3 h-3" />{[lead.title, lead.company].filter(Boolean).join(' @ ')}</div>}
                  {lead.location && <div className="text-xs text-gray-500 mt-0.5 inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{lead.location}</div>}
                  {(lead.email_work || lead.email_personal) && <div className="text-xs text-gray-500 mt-0.5 truncate">{lead.email_work ?? lead.email_personal}</div>}
                  {lead.phone && <a href={`tel:${lead.phone}`} className="text-xs text-gray-500 mt-0.5 inline-flex items-center gap-1 hover:text-indigo-600"><Phone className="w-3 h-3" />{lead.phone}</a>}
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {lead.profile_url && <a href={lead.profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-[#0a66c2] hover:underline inline-flex items-center gap-1"><Linkedin className="w-3 h-3" /> LinkedIn</a>}
                    {dnc && <Badge tone="red">Do not contact</Badge>}
                    {lead.unsubscribed && <Badge tone="amber">Unsubscribed</Badge>}
                  </div>
                </div>
              </div>
            </div>

            {heldEnrollment && (
              <div className="px-4 py-3 border-b border-gray-100">
                <HeldNotice enrollment={heldEnrollment} sequenceName={heldSeq?.name} canWrite={canWrite} compact onDone={invalidate} toast={toast} />
              </div>
            )}

            <div role="tablist" aria-label="Lead panel sections" className="sticky top-0 z-10 flex bg-white border-b border-gray-200 px-2">
              {PANEL_TABS.map((t) => (
                <button key={t.key} role="tab" type="button" id={`lead-tab-${t.key}`} aria-selected={tab === t.key} aria-controls="lead-tabpanel" onClick={() => setTab(t.key)}
                  className={cn('flex-1 inline-flex items-center justify-center gap-1 px-2 py-2.5 text-xs font-medium whitespace-nowrap border-b-2 -mb-px transition-colors', tab === t.key ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800')}>
                  {t.label}
                  {t.key === 'tasks' && !!tasksQ.data?.length && <span className="min-w-[16px] px-1 rounded-full bg-gray-100 text-[10px] text-gray-600 tabular-nums">{tasksQ.data.length}</span>}
                </button>
              ))}
            </div>

            <div role="tabpanel" id="lead-tabpanel" aria-labelledby={`lead-tab-${tab}`}>
            <p className="px-4 pt-3 text-xs text-gray-500">{PANEL_TABS.find((t) => t.key === tab)?.guide}</p>

            {tab === 'contact' && <>
            <Section title="Handles and numbers">
              {identitiesQ.isLoading ? <div className="text-xs text-gray-400">Loading…</div> : <IdentityList identities={identitiesQ.data} />}
            </Section>

            {(chat.provider === 'WHATSAPP' || activeConsent.WHATSAPP || activeConsent.INSTAGRAM) && (
              <Section title="Consent" action={canWrite && <button type="button" onClick={() => setConsentOpen(true)} className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-1"><Plus className="w-3 h-3" /> Record consent</button>}>
                {consentQ.isLoading ? <div className="text-xs text-gray-400">Loading…</div> : (
                  <div className="space-y-1.5">
                    {(['WHATSAPP', 'INSTAGRAM'] as const).map((ch) => {
                      const c = activeConsent[ch];
                      if (!c && ch !== chat.provider) return null;
                      return (
                        <div key={ch} className="flex items-center justify-between gap-2">
                          {c ? <ConsentBadge consent={c} /> : <Badge tone="gray">No WhatsApp consent recorded</Badge>}
                          {c && canWrite && <button type="button" onClick={() => setRevokeTarget(c)} className="text-[11px] text-red-600 hover:underline">Revoke</button>}
                        </div>
                      );
                    })}
                    {chat.provider === 'WHATSAPP' && !activeConsent.WHATSAPP && <p className="text-[11px] text-gray-500">Replying here is always allowed. A sequence cannot start a new WhatsApp conversation until a basis is recorded.</p>}
                  </div>
                )}
              </Section>
            )}

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
            </>}

            {tab === 'sequence' && <>
            <Section title="Sequence" action={canWrite && !dnc && <button type="button" onClick={() => setReenrolOpen(true)} className="text-xs text-indigo-600 hover:underline inline-flex items-center gap-1"><Repeat className="w-3 h-3" />{activeEnrollment ? 'Enrol in another' : 'Enrol'}</button>}>
              {activeEnrollment ? (
                <div className="text-xs text-gray-600 space-y-1.5">
                  <div className="font-medium text-gray-900 truncate">{activeSeq?.name ?? 'Sequence'}</div>
                  <div className="flex items-center gap-2 flex-wrap"><EnrollmentBadge status={activeEnrollment.status} /><span className="truncate">Step: {nodeLabel}</span></div>
                  {activeEnrollment.wait_until && <div>Next at {fmtDate(activeEnrollment.wait_until)}</div>}
                  {canWrite && (
                    <div className="flex items-center gap-1.5 pt-1">
                      {heldEnrollment?.id === activeEnrollment.id ? null : activeEnrollment.status === 'paused'
                        ? <Button size="sm" variant="secondary" loading={busy === 'resume'} onClick={() => run('resume', () => rpc('resume_enrollment', { p_id: activeEnrollment.id }), 'Enrollment resumed')}><Play className="w-3 h-3" /> Resume</Button>
                        : <Button size="sm" variant="secondary" loading={busy === 'pause'} onClick={() => run('pause', () => rpc('pause_enrollment', { p_id: activeEnrollment.id }), 'Enrollment paused')}><Pause className="w-3 h-3" /> Pause</Button>}
                      <Button size="sm" variant="secondary" className="text-red-600" onClick={() => setExitTarget(activeEnrollment)}><LogOut className="w-3 h-3" /> Exit</Button>
                    </div>
                  )}
                </div>
              ) : <p className="text-xs text-gray-500">{dnc ? 'Lead is marked do-not-contact.' : 'Not enrolled in any sequence.'}</p>}
            </Section>

            <Section title="Next scheduled actions">
              <QueuedActions leadId={lead.id} leadName={lead.full_name ?? chat.attendee_name} compact toast={toast} />
            </Section>
            </>}

            {tab === 'organise' && <>
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
                <ListPicker compact label="List" emptyLabel="No list" value={lead.list_id ?? ''} disabled={!canWrite} onChange={(id) => updateLead({ list_id: id || null }, 'List updated')} />
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-gray-600 inline-flex items-center gap-1"><Ban className="w-3 h-3 text-gray-400" /> Do not contact</span>
                <Toggle checked={dnc} disabled={!canWrite} onChange={(v) => { if (v) setDncOpen(true); else updateLead({ do_not_contact: false }, 'Lead can be contacted again'); }} />
              </div>
            </Section>
            </>}

            {tab === 'tasks' && (
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
            )}

            {tab === 'notes' && (
            <Section title="Lead notes">
              <LeadNotesPanel key={lead.id} leadId={lead.id} chatId={chat.id} canWrite={canWrite && canReply} personName={lead.full_name ?? chat.attendee_name} onError={(m) => toast(m, 'error')} onNotice={(m) => toast(m)} />
            </Section>
            )}
            </div>
          </>
        )}
      </div>

      {lead && (
        <>
          <CreateTaskModal open={taskOpen} onClose={() => setTaskOpen(false)} onCreate={createTask} members={members} currentUserId={currentUserId}
            defaultTitle={taskPrefill?.title ?? `Follow up with ${lead.full_name ?? chat.attendee_name ?? 'lead'}`} defaultBody={taskPrefill?.body ?? null} defaultAssignee={taskPrefill?.assigned_to ?? null} />
          <ReenrolModal open={reenrolOpen} onClose={() => setReenrolOpen(false)} sequences={seqQ.data} senderId={chat.sender_id} senderName={senderName} onEnrol={enrol} />
          <ConfirmModal open={dncOpen} onClose={() => setDncOpen(false)} title="Mark as do-not-contact?" danger confirmLabel="Mark do-not-contact" onConfirm={async () => { await updateLead({ do_not_contact: true }, 'Lead marked do-not-contact'); }} message={<>No sender will contact <span className="font-medium">{lead.full_name ?? 'this lead'}</span> again. Live enrollments are exited by the engine. You can still reply manually here.</>} />
          <ConfirmModal open={!!exitTarget} onClose={() => setExitTarget(null)} title="Exit enrollment?" danger confirmLabel="Exit" onConfirm={async () => { if (exitTarget) await run('exit', () => rpc('exit_enrollment', { p_id: exitTarget.id, p_reason: 'manual' }), 'Enrollment exited'); }} message={<>The lead leaves <span className="font-medium">{activeSeq?.name ?? 'the sequence'}</span> now. Queued actions for this enrollment are cancelled.</>} />
          <ConsentGrantModal open={consentOpen} onClose={() => setConsentOpen(false)} leadId={lead.id} ws={workspaceId} defaultChannel={chat.provider === 'INSTAGRAM' ? 'INSTAGRAM' : 'WHATSAPP'} toast={toast} />
          <ConsentRevokeModal consent={revokeTarget} onClose={() => setRevokeTarget(null)} leadId={lead.id} ws={workspaceId} toast={toast} />
        </>
      )}
    </div>
  );
}
