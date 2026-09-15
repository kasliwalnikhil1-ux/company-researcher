'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from './api';
import type {
  Action, AuditRow, Chat, Client, DashboardData, Enrollment, ImportJob, Invitation, Lead, LeadSenderState, List, Member, Message,
  NodeStats, OutboundWebhook, PlatformCeiling, Sender, SenderBudget, SenderEvent, Sequence, SequenceVersion, Stage, Suppression, Tag, Task, WarmupCap,
} from './types';

export const qk = {
  dashboard: (ws: string) => ['outreach', ws, 'dashboard'] as const,
  senders: (ws: string) => ['outreach', ws, 'senders'] as const,
  sender: (id: string) => ['outreach', 'sender', id] as const,
  senderBudgets: (id: string) => ['outreach', 'sender', id, 'budgets'] as const,
  senderEvents: (id: string) => ['outreach', 'sender', id, 'events'] as const,
  clients: (ws: string) => ['outreach', ws, 'clients'] as const,
  members: (ws: string) => ['outreach', ws, 'members'] as const,
  invitations: (ws: string) => ['outreach', ws, 'invitations'] as const,
  lists: (ws: string) => ['outreach', ws, 'lists'] as const,
  stages: (ws: string) => ['outreach', ws, 'stages'] as const,
  tags: (ws: string) => ['outreach', ws, 'tags'] as const,
  leads: (ws: string, f: unknown) => ['outreach', ws, 'leads', f] as const,
  lead: (id: string) => ['outreach', 'lead', id] as const,
  sequences: (ws: string) => ['outreach', ws, 'sequences'] as const,
  sequence: (id: string) => ['outreach', 'sequence', id] as const,
  sequenceVersions: (id: string) => ['outreach', 'sequence', id, 'versions'] as const,
  nodeStats: (id: string) => ['outreach', 'sequence', id, 'stats'] as const,
  enrollments: (f: unknown) => ['outreach', 'enrollments', f] as const,
  chats: (ws: string, f: unknown) => ['outreach', ws, 'chats', f] as const,
  chat: (id: string) => ['outreach', 'chat', id] as const,
  messages: (chatId: string) => ['outreach', 'chat', chatId, 'messages'] as const,
  tasks: (ws: string, f: unknown) => ['outreach', ws, 'tasks', f] as const,
  imports: (ws: string) => ['outreach', ws, 'imports'] as const,
  suppressions: (ws: string) => ['outreach', ws, 'suppressions'] as const,
  webhooks: (ws: string) => ['outreach', ws, 'webhooks'] as const,
  audit: (ws: string) => ['outreach', ws, 'audit'] as const,
  ceilings: () => ['outreach', 'ceilings'] as const,
  warmup: () => ['outreach', 'warmup'] as const,
  actions: (f: unknown) => ['outreach', 'actions', f] as const,
};

async function sel<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await q;
  if (error) throw parseError(error);
  return data as T;
}

const opts = <T,>(o?: Partial<UseQueryOptions<T>>) => o ?? {};

// ---------------------------------------------------------------------------
export function useDashboard(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.dashboard(ws ?? ''), enabled: !!ws, refetchInterval: 30000, queryFn: () => rpc<DashboardData>('dashboard', { p_ws: ws }) });
}

export function useSenders(ws: string | null | undefined) {
  return useQuery({
    queryKey: qk.senders(ws ?? ''), enabled: !!ws,
    queryFn: () => sel<Sender[]>(supabase.from('outreach_senders').select('*').eq('workspace_id', ws!).is('deleted_at', null).order('created_at')),
  });
}

export function useSender(id: string | null | undefined) {
  return useQuery({ queryKey: qk.sender(id ?? ''), enabled: !!id, queryFn: () => sel<Sender>(supabase.from('outreach_senders').select('*').eq('id', id!).single()) });
}

export function useSenderBudgets(id: string | null | undefined) {
  return useQuery({
    queryKey: qk.senderBudgets(id ?? ''), enabled: !!id, refetchInterval: 60000,
    queryFn: () => sel<SenderBudget[]>(supabase.from('outreach_sender_budgets').select('*').eq('sender_id', id!).order('day', { ascending: false }).limit(200)),
  });
}

export function useSenderEvents(id: string | null | undefined) {
  return useQuery({
    queryKey: qk.senderEvents(id ?? ''), enabled: !!id,
    queryFn: () => sel<SenderEvent[]>(supabase.from('outreach_sender_events').select('*').eq('sender_id', id!).order('at', { ascending: false }).limit(200)),
  });
}

export function useClients(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.clients(ws ?? ''), enabled: !!ws, queryFn: () => sel<Client[]>(supabase.from('outreach_clients').select('*').eq('workspace_id', ws!).order('name')) });
}

export function useMembers(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.members(ws ?? ''), enabled: !!ws, queryFn: () => rpc<Member[]>('workspace_members', { p_ws: ws }) });
}

export function useInvitations(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.invitations(ws ?? ''), enabled: !!ws, queryFn: () => sel<Invitation[]>(supabase.from('outreach_invitations').select('*').eq('workspace_id', ws!).order('created_at', { ascending: false })) });
}

export function useLists(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.lists(ws ?? ''), enabled: !!ws, queryFn: () => sel<List[]>(supabase.from('outreach_lists').select('*').eq('workspace_id', ws!).order('name')) });
}
export function useStages(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.stages(ws ?? ''), enabled: !!ws, queryFn: () => sel<Stage[]>(supabase.from('outreach_stages').select('*').eq('workspace_id', ws!).order('position')) });
}
export function useTags(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.tags(ws ?? ''), enabled: !!ws, queryFn: () => sel<Tag[]>(supabase.from('outreach_tags').select('*').eq('workspace_id', ws!).order('name')) });
}

export interface LeadFilters {
  search?: string;
  client_id?: string | null;
  list_id?: string | null;
  stage_id?: string | null;
  tag_id?: string | null;
  dnc?: boolean | null;
  page?: number;
  pageSize?: number;
}

export function useLeads(ws: string | null | undefined, f: LeadFilters) {
  return useQuery({
    queryKey: qk.leads(ws ?? '', f), enabled: !!ws, placeholderData: (prev) => prev,
    queryFn: async () => {
      const page = f.page ?? 0; const size = f.pageSize ?? 50;
      let q = supabase.from('outreach_leads').select('*, outreach_lead_tags(tag_id)', { count: 'exact' }).eq('workspace_id', ws!);
      if (f.search) q = q.or(`full_name.ilike.%${f.search}%,company.ilike.%${f.search}%,headline.ilike.%${f.search}%,public_identifier.ilike.%${f.search}%,email_work.ilike.%${f.search}%`);
      if (f.client_id) q = q.eq('client_id', f.client_id);
      if (f.list_id) q = q.eq('list_id', f.list_id);
      if (f.stage_id) q = q.eq('stage_id', f.stage_id);
      if (f.dnc != null) q = q.eq('do_not_contact', f.dnc);
      if (f.tag_id) q = q.not('outreach_lead_tags', 'is', null).eq('outreach_lead_tags.tag_id', f.tag_id);
      q = q.order('created_at', { ascending: false }).range(page * size, page * size + size - 1);
      const { data, error, count } = await q;
      if (error) throw parseError(error);
      return { rows: (data ?? []) as (Lead & { outreach_lead_tags: { tag_id: string }[] })[], count: count ?? 0 };
    },
  });
}

export function useLead(id: string | null | undefined) {
  return useQuery({
    queryKey: qk.lead(id ?? ''), enabled: !!id,
    queryFn: async () => {
      const lead = await sel<Lead>(supabase.from('outreach_leads').select('*').eq('id', id!).single());
      const [tags, states, enrollments, chats, actions, tasks] = await Promise.all([
        sel<{ tag_id: string }[]>(supabase.from('outreach_lead_tags').select('tag_id').eq('lead_id', id!)),
        sel<LeadSenderState[]>(supabase.from('outreach_lead_sender_state').select('*').eq('lead_id', id!)),
        sel<Enrollment[]>(supabase.from('outreach_enrollments').select('*').eq('lead_id', id!).order('created_at', { ascending: false })),
        sel<Chat[]>(supabase.from('outreach_chats').select('*').eq('lead_id', id!).order('last_message_at', { ascending: false })),
        sel<Action[]>(supabase.from('outreach_actions').select('*').eq('lead_id', id!).order('scheduled_for', { ascending: false }).limit(100)),
        sel<Task[]>(supabase.from('outreach_tasks').select('*').eq('lead_id', id!).order('created_at', { ascending: false })),
      ]);
      return { lead, tagIds: tags.map((t) => t.tag_id), states, enrollments, chats, actions, tasks };
    },
  });
}

export function useSequences(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.sequences(ws ?? ''), enabled: !!ws, queryFn: () => sel<Sequence[]>(supabase.from('outreach_sequences').select('*').eq('workspace_id', ws!).order('updated_at', { ascending: false })) });
}
export function useSequence(id: string | null | undefined) {
  return useQuery({ queryKey: qk.sequence(id ?? ''), enabled: !!id, queryFn: () => sel<Sequence>(supabase.from('outreach_sequences').select('*').eq('id', id!).single()) });
}
export function useSequenceVersions(id: string | null | undefined) {
  return useQuery({ queryKey: qk.sequenceVersions(id ?? ''), enabled: !!id, queryFn: () => sel<SequenceVersion[]>(supabase.from('outreach_sequence_versions').select('*').eq('sequence_id', id!).order('version', { ascending: false })) });
}
export function useNodeStats(id: string | null | undefined) {
  return useQuery({ queryKey: qk.nodeStats(id ?? ''), enabled: !!id, refetchInterval: 30000, queryFn: () => sel<NodeStats[]>(supabase.from('outreach_node_stats').select('*').eq('sequence_id', id!)) });
}

export function useEnrollments(f: { sequence_id?: string; lead_id?: string; sender_id?: string; status?: string[]; limit?: number }) {
  return useQuery({
    queryKey: qk.enrollments(f), enabled: !!(f.sequence_id || f.lead_id || f.sender_id),
    queryFn: () => {
      let q = supabase.from('outreach_enrollments').select('*, outreach_leads(id, full_name, company, headline, public_identifier, picture_url), outreach_senders(id, display_name)').order('created_at', { ascending: false }).limit(f.limit ?? 200);
      if (f.sequence_id) q = q.eq('sequence_id', f.sequence_id);
      if (f.lead_id) q = q.eq('lead_id', f.lead_id);
      if (f.sender_id) q = q.eq('sender_id', f.sender_id);
      if (f.status?.length) q = q.in('status', f.status);
      return sel<(Enrollment & { outreach_leads: Partial<Lead> | null; outreach_senders: Partial<Sender> | null })[]>(q);
    },
  });
}

export interface ChatFilters { sender_id?: string | null; client_id?: string | null; intent?: string | null; unread?: boolean | null; assigned_to?: string | null; provider?: string | null; archived?: boolean; search?: string }

export function useChats(ws: string | null | undefined, f: ChatFilters) {
  return useQuery({
    queryKey: qk.chats(ws ?? '', f), enabled: !!ws, placeholderData: (prev) => prev,
    queryFn: () => {
      let q = supabase.from('outreach_chats').select('*, outreach_leads(id, full_name, company, headline, picture_url), outreach_senders(id, display_name, provider)').eq('workspace_id', ws!).eq('archived', !!f.archived);
      if (f.sender_id) q = q.eq('sender_id', f.sender_id);
      if (f.client_id) q = q.eq('client_id', f.client_id);
      if (f.intent) q = q.eq('intent', f.intent);
      if (f.unread) q = q.eq('unread', true);
      if (f.assigned_to) q = q.eq('assigned_to', f.assigned_to);
      if (f.provider) q = q.eq('provider', f.provider);
      if (f.search) q = q.or(`attendee_name.ilike.%${f.search}%,subject.ilike.%${f.search}%,last_message_preview.ilike.%${f.search}%`);
      return sel<(Chat & { outreach_leads: Partial<Lead> | null; outreach_senders: Partial<Sender> | null })[]>(q.order('last_message_at', { ascending: false, nullsFirst: false }).limit(300));
    },
  });
}

export function useChat(id: string | null | undefined) {
  return useQuery({ queryKey: qk.chat(id ?? ''), enabled: !!id, queryFn: () => sel<Chat & { outreach_leads: Lead | null; outreach_senders: Sender | null }>(supabase.from('outreach_chats').select('*, outreach_leads(*), outreach_senders(*)').eq('id', id!).single()) });
}

export function useMessages(chatId: string | null | undefined) {
  return useQuery({ queryKey: qk.messages(chatId ?? ''), enabled: !!chatId, queryFn: () => sel<Message[]>(supabase.from('outreach_messages').select('*').eq('chat_id', chatId!).order('sent_at').limit(500)) });
}

export function useTasks(ws: string | null | undefined, f: { open?: boolean; kind?: string | null; assigned_to?: string | null; lead_id?: string | null }) {
  return useQuery({
    queryKey: qk.tasks(ws ?? '', f), enabled: !!ws,
    queryFn: () => {
      let q = supabase.from('outreach_tasks').select('*, outreach_leads(id, full_name, company, public_identifier, picture_url), outreach_senders(id, display_name)').eq('workspace_id', ws!);
      if (f.open !== false) q = q.is('completed_at', null); else q = q.not('completed_at', 'is', null);
      if (f.kind) q = q.eq('kind', f.kind);
      if (f.assigned_to) q = q.eq('assigned_to', f.assigned_to);
      if (f.lead_id) q = q.eq('lead_id', f.lead_id);
      return sel<(Task & { outreach_leads: Partial<Lead> | null; outreach_senders: Partial<Sender> | null })[]>(q.order('due_at', { ascending: true, nullsFirst: false }).limit(300));
    },
  });
}

export function useImportJobs(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.imports(ws ?? ''), enabled: !!ws, refetchInterval: 15000, queryFn: () => sel<ImportJob[]>(supabase.from('outreach_import_jobs').select('*').eq('workspace_id', ws!).order('created_at', { ascending: false }).limit(100)) });
}
export function useSuppressions(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.suppressions(ws ?? ''), enabled: !!ws, queryFn: () => sel<Suppression[]>(supabase.from('outreach_suppressions').select('*').eq('workspace_id', ws!).order('created_at', { ascending: false })) });
}
export function useWebhooks(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.webhooks(ws ?? ''), enabled: !!ws, queryFn: () => sel<OutboundWebhook[]>(supabase.from('outreach_outbound_webhooks').select('*').eq('workspace_id', ws!).order('created_at')) });
}
export function useAudit(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.audit(ws ?? ''), enabled: !!ws, queryFn: () => sel<AuditRow[]>(supabase.from('outreach_audit_log').select('*').eq('workspace_id', ws!).order('at', { ascending: false }).limit(300)) });
}
export function useCeilings() {
  return useQuery({ queryKey: qk.ceilings(), staleTime: Infinity, queryFn: () => sel<PlatformCeiling[]>(supabase.from('outreach_platform_ceilings').select('*')) });
}
export function useWarmupCaps() {
  return useQuery({ queryKey: qk.warmup(), staleTime: Infinity, queryFn: () => sel<WarmupCap[]>(supabase.from('outreach_warmup_caps').select('*').order('level')) });
}
export function useActions(f: { sender_id?: string; enrollment_id?: string; status?: string[]; limit?: number; upcoming?: boolean }) {
  return useQuery({
    queryKey: qk.actions(f), enabled: !!(f.sender_id || f.enrollment_id), refetchInterval: 30000,
    queryFn: () => {
      let q = supabase.from('outreach_actions').select('*, outreach_leads(id, full_name, public_identifier)').limit(f.limit ?? 100);
      if (f.sender_id) q = q.eq('sender_id', f.sender_id);
      if (f.enrollment_id) q = q.eq('enrollment_id', f.enrollment_id);
      if (f.status?.length) q = q.in('status', f.status);
      q = f.upcoming ? q.order('scheduled_for', { ascending: true }) : q.order('scheduled_for', { ascending: false });
      return sel<(Action & { outreach_leads: Partial<Lead> | null })[]>(q);
    },
  });
}

/** Generic mutation helper that invalidates the given query keys on success. */
export function useInvalidatingMutation<TArgs, TRes = unknown>(fn: (a: TArgs) => Promise<TRes>, keys: (a: TArgs) => readonly unknown[][]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_r, a) => { for (const k of keys(a)) qc.invalidateQueries({ queryKey: k }); },
  });
}

// ---------------------------------------------------------------------------
// Realtime: one channel per workspace, invalidates relevant queries.
// ---------------------------------------------------------------------------
export function useOutreachRealtime(ws: string | null | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!ws) return;
    const ch = supabase.channel(`outreach:${ws}`);
    const inv = (keys: readonly unknown[]) => qc.invalidateQueries({ queryKey: keys });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_messages', filter: `workspace_id=eq.${ws}` }, (p: any) => {
      const chatId = p.new?.chat_id ?? p.old?.chat_id;
      if (chatId) inv(qk.messages(chatId));
      inv(['outreach', ws, 'chats']);
      inv(qk.dashboard(ws));
    });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_chats', filter: `workspace_id=eq.${ws}` }, (p: any) => {
      inv(['outreach', ws, 'chats']);
      if (p.new?.id) inv(qk.chat(p.new.id));
    });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_senders', filter: `workspace_id=eq.${ws}` }, (p: any) => {
      inv(qk.senders(ws));
      if (p.new?.id) { inv(qk.sender(p.new.id)); inv(qk.senderEvents(p.new.id)); }
      inv(qk.dashboard(ws));
    });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_node_stats' }, (p: any) => {
      const sid = p.new?.sequence_id ?? p.old?.sequence_id;
      if (sid) inv(qk.nodeStats(sid));
    });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_tasks', filter: `workspace_id=eq.${ws}` }, () => {
      inv(['outreach', ws, 'tasks']);
      inv(qk.dashboard(ws));
    });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_enrollments', filter: `workspace_id=eq.${ws}` }, () => {
      inv(['outreach', 'enrollments']);
    });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_import_jobs', filter: `workspace_id=eq.${ws}` }, () => inv(qk.imports(ws)));
    ch.subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [ws, qc]);
}
