'use client';

// WEB-INBOX-LEADS: types + hooks for thread attribution, queued actions, enrichment, AI review and import sources.
// Every number and rule comes from an outreach_* RPC or an RLS-protected table; nothing is re-computed here.

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from './api';
import type { ChatFilters, LeadFilters } from './queries';
import type { ActionType, Chat, Enrollment, JobStatus, Lead, Sender } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ThreadAttributionRow {
  message_id: string;
  kind: 'automated' | 'manual' | 'inbound';
  sequence_id: string | null;
  sequence_name: string | null;
  node_id: string | null;
  step_number: number | null;
  step_label: string | null;
  node_type: string | null;
  variant_id: string | null;
  variant_label: string | null;
  sender_name: string | null;
  sent_by_name: string | null;
  replying_to_message_id: string | null;
}

export type ChatRowWithJoins = Chat & { outreach_leads: Partial<Lead> | null; outreach_senders: Partial<Sender> | null };

export interface QueuedAction {
  action_id: string;
  enrollment_id: string | null;
  sequence_id: string | null;
  sequence_name: string | null;
  node_id: string | null;
  node_label: string | null;
  action_type: ActionType | string;
  sender_id: string;
  sender_name: string | null;
  scheduled_for: string;
  body: string | null;
  subject: string | null;
  variant_id: string | null;
  editable: boolean;
}

export type EnrichStatus = 'none' | 'waiting' | 'done' | 'failed';

/** Columns added to outreach_leads by 010 that lib/outreach/types.ts may not carry yet. */
export interface LeadIntelFields {
  last_replied_at?: string | null;
  last_replied_channel?: string | null;
  phone?: string | null;
  enrich_status?: EnrichStatus | null;
  enriched_at?: string | null;
  email_status?: 'verified' | 'unverified' | 'invalid' | null;
}
export type LeadWithIntel = Lead & LeadIntelFields;

/** Columns added to outreach_enrollments by 010. */
export type EnrollmentWithHold = Enrollment & { held_at?: string | null; hold_reason?: string | null; wait_reason?: string | null };

export interface ProfileExperience { company?: string | null; company_id?: string | null; title?: string | null; start?: string | null; end?: string | null; current?: boolean | null; location?: string | null; description?: string | null }
export interface ProfileEducation { school?: string | null; degree?: string | null; field?: string | null; start?: string | null; end?: string | null }
export interface ProfilePost { id?: string | null; text?: string | null; date?: string | null; reactions?: number | null; comments?: number | null; url?: string | null }

export interface LeadProfile {
  lead_id: string;
  workspace_id: string;
  about: string | null;
  current_title: string | null;
  current_company: string | null;
  current_started_on: string | null;
  experience: ProfileExperience[] | null;
  education: ProfileEducation[] | null;
  skills: string[] | null;
  languages: string[] | null;
  profile_language: string | null;
  follower_count: number | null;
  connections_count: number | null;
  posts: ProfilePost[] | null;
  posts_fetched_at: string | null;
  last_posted_at: string | null;
  enriched_at: string | null;
  enriched_by_sender: string | null;
  source: string | null;
  empty_sections: string[];
  updated_at: string;
}

export interface EnrichResult { queued: number; skipped_fresh?: number; skipped_no_linkedin_id?: number; note?: string }

export interface AiVariable { id: string; workspace_id: string; key: string; name: string; prompt: string; fallback: string; needs_posts: boolean; max_chars: number; created_at: string; updated_at: string }
export type AiBatchStatus = 'generating' | 'review' | 'done' | 'cancelled';
export interface AiBatch {
  id: string; workspace_id: string; variable_id: string; sequence_id: string | null; requested_by: string | null; total: number; status: AiBatchStatus;
  created_at: string; finished_at: string | null;
  outreach_ai_variables: { key: string; name: string } | null;
  /** Filled for batches that are still generating or waiting for review. */
  pending?: number; awaiting_review?: number;
}
export type AiValueStatus = 'pending' | 'generated' | 'approved' | 'skipped' | 'blank' | 'failed';
export interface AiReviewRow {
  value_id: string; lead_id: string; lead_name: string | null; company: string | null; title: string | null; variable_key: string; variable_name: string;
  body: string | null; facts: unknown; status: AiValueStatus; edited: boolean; fallback: string | null; updated_at: string; total: number;
}
export type AiReviewAction = 'approve' | 'skip' | 'edit' | 'regenerate';
export interface AiGenerateResult { batch_id: string; to_generate: number; kept_existing: number; note?: string }
/** Assumed response of `outreach-ai-variables` with action `preview_variable` (nothing is stored). */
export interface AiPreviewResult { text?: string | null; line?: string | null; facts?: unknown; blank?: boolean; fallback?: string | null; model?: string | null }

export type ImportKindV2 = 'search_url' | 'csv' | 'relations' | 'post_engagement' | 'conversations' | 'sn_saved_search' | 'sn_lead_list' | 'company_people';
export type ImportCadence = 'daily' | 'weekly' | 'monthly';
export const REPEATABLE_KINDS: ImportKindV2[] = ['search_url', 'post_engagement', 'sn_saved_search', 'sn_lead_list', 'relations', 'company_people'];
export const IMPORT_KIND_LABEL: Record<ImportKindV2, string> = {
  search_url: 'Search URL', csv: 'CSV', relations: 'Connections', post_engagement: 'Post engagement', conversations: 'Conversations',
  sn_saved_search: 'Sales Navigator saved search', sn_lead_list: 'Sales Navigator lead list', company_people: 'People in companies',
};
export function importKindLabel(kind: string): string { return (IMPORT_KIND_LABEL as Record<string, string>)[kind] ?? kind.replace(/_/g, ' '); }

export interface ImportSchedule {
  id: string; workspace_id: string; client_id: string | null; sender_id: string | null; name: string; kind: ImportKindV2; params: Record<string, unknown>;
  list_id: string | null; tag_ids: string[]; enrich: boolean; cadence: ImportCadence; active: boolean; next_run_at: string; last_job_id: string | null;
  last_run_at: string | null; runs: number; created_at: string;
  last_job?: { id: string; status: JobStatus; error: string | null } | null;
}
export interface SnOption { id: string; name: string; count?: number | null }
/** Assumed response of `outreach-imports-create` with `action: 'sn_options'`. */
export interface SnOptions { saved_searches: SnOption[]; lead_lists: SnOption[] }

export type TimeInRole = '' | 'lt6' | '6to12' | '1to3' | 'gt3';
export interface IntelLeadFilters {
  enriched?: boolean | null;
  replied?: boolean | null;
  posted_30d?: boolean | null;
  min_followers?: number | null;
  time_in_role?: TimeInRole | null;
  past_company?: string | null;
  skill?: string | null;
  language?: string | null;
}
export type LeadListFilters = LeadFilters & IntelLeadFilters;
export type LeadProfileSummary = Pick<LeadProfile, 'follower_count' | 'connections_count' | 'last_posted_at' | 'current_started_on' | 'profile_language' | 'enriched_at'>;
export type LeadListRow = LeadWithIntel & { outreach_lead_tags: { tag_id: string }[]; outreach_lead_profiles: LeadProfileSummary | LeadProfileSummary[] | null };

export function profileOf(row: { outreach_lead_profiles?: LeadProfileSummary | LeadProfileSummary[] | null }): LeadProfileSummary | null {
  const p = row.outreach_lead_profiles;
  if (!p) return null;
  return Array.isArray(p) ? p[0] ?? null : p;
}

export function needsProfileJoin(f: IntelLeadFilters): boolean {
  return !!(f.posted_30d || (f.min_followers != null && f.min_followers > 0) || f.time_in_role || f.past_company?.trim() || f.skill?.trim() || f.language?.trim());
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------
export const ik = {
  attribution: (chatId: string) => ['outreach', 'chat', chatId, 'attribution'] as const,
  sequenceChats: (sequenceId: string) => ['outreach', 'sequence', sequenceId, 'chat-ids'] as const,
  queued: (leadId: string) => ['outreach', 'lead', leadId, 'queued-actions'] as const,
  profile: (leadId: string) => ['outreach', 'lead', leadId, 'profile'] as const,
  timeline: (leadId: string) => ['outreach', 'lead', leadId, 'timeline'] as const,
  aiVariables: (ws: string) => ['outreach', ws, 'ai-variables'] as const,
  aiBatches: (ws: string) => ['outreach', ws, 'ai-batches'] as const,
  aiReview: (ws: string, f: unknown) => ['outreach', ws, 'ai-review', f] as const,
  importSchedules: (ws: string) => ['outreach', ws, 'import-schedules'] as const,
  snOptions: (senderId: string) => ['outreach', 'sender', senderId, 'sn-options'] as const,
};

async function sel<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await q;
  if (error) throw parseError(error);
  return data as T;
}

// ---------------------------------------------------------------------------
// Item 4: attribution
// ---------------------------------------------------------------------------
/**
 * One call per thread. `lastMessageId` is the id of the newest stored message (ignore optimistic `temp-` ids):
 * when it changes, the attribution is fetched again while the previous rows stay on screen.
 */
export function useThreadAttribution(chatId: string | null | undefined, lastMessageId: string | null | undefined) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ik.attribution(chatId ?? ''), enabled: !!chatId, staleTime: 5 * 60_000,
    queryFn: async () => {
      const rows = await rpc<ThreadAttributionRow[]>('thread_attribution', { p_chat: chatId });
      const map: Record<string, ThreadAttributionRow> = {};
      for (const r of rows ?? []) map[r.message_id] = r;
      return map;
    },
  });
  const known = q.data;
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!chatId || !lastMessageId || !known || known[lastMessageId]) return;
    const token = `${chatId}:${lastMessageId}`;
    if (asked.current === token) return;   // ask once per new message, never in a loop
    asked.current = token;
    qc.invalidateQueries({ queryKey: ik.attribution(chatId) });
  }, [chatId, lastMessageId, known, qc]);
  return q;
}

export function useSequenceChatIds(sequenceId: string | null | undefined) {
  return useQuery({
    queryKey: ik.sequenceChats(sequenceId ?? ''), enabled: !!sequenceId, staleTime: 60_000,
    queryFn: async () => new Set<string>((await rpc<string[]>('sequence_chat_ids', { p_sequence: sequenceId })) ?? []),
  });
}

/** Above this many ids the inbox filters the loaded list in the browser instead of asking for the threads by id. */
export const CHAT_IDS_FETCH_LIMIT = 900;

/**
 * Threads by id (reports drill-down `?chats=`, filter by sequence). Same filters and row shape as `useChats`;
 * the key sits under ['outreach', ws, 'chats'] so realtime and optimistic updates reach it too.
 */
export function useChatsByIds(ws: string | null | undefined, ids: string[] | null, f: ChatFilters) {
  return useQuery({
    queryKey: ['outreach', ws ?? '', 'chats', 'by-ids', ids, f] as const, enabled: !!ws && !!ids, placeholderData: (prev) => prev,
    queryFn: async () => {
      const all: ChatRowWithJoins[] = [];
      const list = (ids ?? []).slice(0, CHAT_IDS_FETCH_LIMIT);
      for (let i = 0; i < list.length; i += 150) {
        let q = supabase.from('outreach_chats').select('*, outreach_leads(id, full_name, company, headline, picture_url), outreach_senders(id, display_name, provider)').eq('workspace_id', ws!).in('id', list.slice(i, i + 150));
        if (f.archived != null) q = q.eq('archived', !!f.archived);
        if (f.sender_id) q = q.eq('sender_id', f.sender_id);
        if (f.client_id) q = q.eq('client_id', f.client_id);
        if (f.intent) q = q.eq('intent', f.intent);
        if (f.unread) q = q.eq('unread', true);
        if (f.assigned_to) q = q.eq('assigned_to', f.assigned_to);
        if (f.provider) q = q.eq('provider', f.provider);
        const search = f.search ? cleanSearch(f.search) : '';
        if (search) q = q.or(`attendee_name.ilike.%${search}%,subject.ilike.%${search}%,last_message_preview.ilike.%${search}%`);
        all.push(...((await sel<ChatRowWithJoins[]>(q)) ?? []));
      }
      return all.sort((a, b) => new Date(b.last_message_at ?? 0).getTime() - new Date(a.last_message_at ?? 0).getTime());
    },
  });
}

// ---------------------------------------------------------------------------
// Item 7: the lead's next queued actions
// ---------------------------------------------------------------------------
export function useLeadQueuedActions(leadId: string | null | undefined) {
  return useQuery({
    queryKey: ik.queued(leadId ?? ''), enabled: !!leadId, refetchInterval: 60_000,
    queryFn: async () => (await rpc<QueuedAction[]>('lead_queued_actions', { p_lead: leadId })) ?? [],
  });
}

// ---------------------------------------------------------------------------
// Item 13: enrichment
// ---------------------------------------------------------------------------
export function useLeadProfile(leadId: string | null | undefined, waiting = false) {
  return useQuery({
    queryKey: ik.profile(leadId ?? ''), enabled: !!leadId, refetchInterval: waiting ? 30_000 : false,
    queryFn: () => sel<LeadProfile | null>(supabase.from('outreach_lead_profiles').select('*').eq('lead_id', leadId!).maybeSingle()),
  });
}

/** `request_enrichment` takes at most 5000 ids per call; larger selections are sent in chunks and summed. */
export async function requestEnrichment(ws: string, leadIds: string[], opts: { wantPosts?: boolean; force?: boolean; reason?: string } = {}): Promise<EnrichResult> {
  const total: EnrichResult = { queued: 0, skipped_fresh: 0, skipped_no_linkedin_id: 0 };
  for (let i = 0; i < leadIds.length; i += 5000) {
    const r = await rpc<EnrichResult>('request_enrichment', { p_ws: ws, p_lead_ids: leadIds.slice(i, i + 5000), p_want_posts: !!opts.wantPosts, p_force: !!opts.force, p_reason: opts.reason ?? 'manual' });
    total.queued += r?.queued ?? 0;
    total.skipped_fresh = (total.skipped_fresh ?? 0) + (r?.skipped_fresh ?? 0);
    total.skipped_no_linkedin_id = (total.skipped_no_linkedin_id ?? 0) + (r?.skipped_no_linkedin_id ?? 0);
    if (r?.note) total.note = r.note;
  }
  return total;
}

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

/** Characters that would break a PostgREST `or=(…)` expression. */
function cleanSearch(s: string): string { return s.replace(/[,()"\\]/g, ' ').trim(); }

const PROFILE_COLS = 'follower_count, connections_count, last_posted_at, current_started_on, profile_language, enriched_at';

/** The leads list with the item-13 filters (join on outreach_lead_profiles, inner only when a profile filter is set). */
export function useLeadsIntel(ws: string | null | undefined, f: LeadListFilters) {
  return useQuery({
    queryKey: ['outreach', ws ?? '', 'leads', 'intel', f] as const, enabled: !!ws, placeholderData: (prev) => prev,
    queryFn: async () => {
      const page = f.page ?? 0; const size = f.pageSize ?? 50;
      const inner = needsProfileJoin(f);
      const P = 'outreach_lead_profiles';
      let q = supabase.from('outreach_leads').select(`*, outreach_lead_tags(tag_id), ${P}${inner ? '!inner' : ''}(${PROFILE_COLS})`, { count: 'exact' }).eq('workspace_id', ws!);
      const search = f.search ? cleanSearch(f.search) : '';
      if (search) q = q.or(`full_name.ilike.%${search}%,company.ilike.%${search}%,headline.ilike.%${search}%,public_identifier.ilike.%${search}%,email_work.ilike.%${search}%`);
      if (f.client_id) q = q.eq('client_id', f.client_id);
      if (f.list_id) q = q.eq('list_id', f.list_id);
      if (f.stage_id) q = q.eq('stage_id', f.stage_id);
      if (f.dnc != null) q = q.eq('do_not_contact', f.dnc);
      if (f.tag_id) q = q.not('outreach_lead_tags', 'is', null).eq('outreach_lead_tags.tag_id', f.tag_id);
      if (f.enriched === true) q = q.not('enriched_at', 'is', null);
      if (f.enriched === false) q = q.is('enriched_at', null);
      if (f.replied === true) q = q.not('last_replied_at', 'is', null);
      if (f.replied === false) q = q.is('last_replied_at', null);
      if (f.posted_30d) q = q.gte(`${P}.last_posted_at`, new Date(Date.now() - 30 * 86_400_000).toISOString());
      if (f.min_followers != null && f.min_followers > 0) q = q.gte(`${P}.follower_count`, f.min_followers);
      if (f.time_in_role === 'lt6') q = q.gt(`${P}.current_started_on`, monthsAgo(6));
      if (f.time_in_role === '6to12') q = q.lte(`${P}.current_started_on`, monthsAgo(6)).gt(`${P}.current_started_on`, monthsAgo(12));
      if (f.time_in_role === '1to3') q = q.lte(`${P}.current_started_on`, monthsAgo(12)).gt(`${P}.current_started_on`, monthsAgo(36));
      if (f.time_in_role === 'gt3') q = q.lte(`${P}.current_started_on`, monthsAgo(36));
      // companies_text / skills_text are lower-cased search columns kept by a trigger: matching is case-insensitive and partial.
      const like = (v: string) => `%${v.trim().toLowerCase().replace(/[%_,()]/g, ' ')}%`;
      if (f.past_company?.trim()) q = q.ilike(`${P}.companies_text`, like(f.past_company));
      if (f.skill?.trim()) q = q.ilike(`${P}.skills_text`, like(f.skill));
      if (f.language?.trim()) q = q.ilike(`${P}.profile_language`, `${f.language.trim().replace(/[%_]/g, '')}%`);
      q = q.order('created_at', { ascending: false }).range(page * size, page * size + size - 1);
      const { data, error, count } = await q;
      if (error) throw parseError(error);
      return { rows: (data ?? []) as unknown as LeadListRow[], count: count ?? 0 };
    },
  });
}

/** Lead ids of a list or a tag (paged: PostgREST returns at most 1000 rows per request). */
export async function fetchLeadIds(ws: string, src: { list_id?: string | null; tag_id?: string | null }, cap = 2000): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const to = Math.min(cap, from + 1000) - 1;
    let rows: string[] = [];
    if (src.tag_id) {
      const data = await sel<{ lead_id: string }[]>(supabase.from('outreach_lead_tags').select('lead_id, outreach_leads!inner(workspace_id)').eq('tag_id', src.tag_id).eq('outreach_leads.workspace_id', ws).order('lead_id').range(from, to));
      rows = (data ?? []).map((r) => r.lead_id);
    } else if (src.list_id) {
      const data = await sel<{ id: string }[]>(supabase.from('outreach_leads').select('id').eq('workspace_id', ws).eq('list_id', src.list_id).order('id').range(from, to));
      rows = (data ?? []).map((r) => r.id);
    }
    ids.push(...rows);
    if (rows.length < to - from + 1) break;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Item 14: AI variables and the review table
// ---------------------------------------------------------------------------
export function useAiVariables(ws: string | null | undefined) {
  return useQuery({ queryKey: ik.aiVariables(ws ?? ''), enabled: !!ws, queryFn: () => sel<AiVariable[]>(supabase.from('outreach_ai_variables').select('*').eq('workspace_id', ws!).order('name')) });
}

export function useAiBatches(ws: string | null | undefined) {
  return useQuery({
    queryKey: ik.aiBatches(ws ?? ''), enabled: !!ws,
    queryFn: async () => {
      const batches = await sel<AiBatch[]>(supabase.from('outreach_ai_batches').select('*, outreach_ai_variables(key, name)').eq('workspace_id', ws!).order('created_at', { ascending: false }).limit(40));
      const count = async (batchId: string, status: AiValueStatus) => {
        const { count: n, error } = await supabase.from('outreach_ai_values').select('id', { count: 'exact', head: true }).eq('batch_id', batchId).eq('status', status);
        if (error) throw parseError(error);
        return n ?? 0;
      };
      return Promise.all((batches ?? []).map(async (b) => {
        if (b.status !== 'generating' && b.status !== 'review') return b;
        const [pending, awaiting_review] = await Promise.all([count(b.id, 'pending'), count(b.id, 'generated')]);
        return { ...b, pending, awaiting_review };
      }));
    },
  });
}

export function useAiReviewList(ws: string | null | undefined, f: { batch: string | null; status: string; page: number; pageSize: number }) {
  return useQuery({
    queryKey: ik.aiReview(ws ?? '', f), enabled: !!ws, placeholderData: (prev) => prev,
    queryFn: async () => {
      const rows = (await rpc<AiReviewRow[]>('ai_review_list', { p_ws: ws, p_batch: f.batch, p_status: f.status, p_limit: f.pageSize, p_offset: f.page * f.pageSize })) ?? [];
      return { rows, total: Number(rows[0]?.total ?? 0) };
    },
  });
}

/** Realtime: batches and values are in the publication. Bursts (hundreds of lines finishing) are folded into one refetch. */
export function useAiRealtime(ws: string | null | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!ws) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        qc.invalidateQueries({ queryKey: ik.aiBatches(ws) });
        qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-review'] });
      }, 1000);
    };
    const ch = supabase.channel(`outreach-ai:${ws}`);
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_ai_batches', filter: `workspace_id=eq.${ws}` }, bump);
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_ai_values', filter: `workspace_id=eq.${ws}` }, bump);
    ch.subscribe();
    return () => { if (timer) clearTimeout(timer); supabase.removeChannel(ch); };
  }, [ws, qc]);
}

/** Facts come back as a JSON array of strings or small objects; turn each into one readable line. */
export function factLines(facts: unknown): string[] {
  if (facts == null) return [];
  const arr = Array.isArray(facts) ? facts : [facts];
  const out: string[] = [];
  for (const f of arr) {
    if (f == null || f === '') continue;
    if (typeof f === 'string' || typeof f === 'number' || typeof f === 'boolean') { out.push(String(f)); continue; }
    if (typeof f === 'object') {
      const o = f as Record<string, unknown>;
      const label = o.label ?? o.field ?? o.source ?? o.key;
      const value = o.value ?? o.text ?? o.fact;
      if (value != null && value !== '') out.push(label ? `${String(label)}: ${String(value)}` : String(value));
      else out.push(Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · '));
    }
  }
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Item 18: repeating imports
// ---------------------------------------------------------------------------
export function useImportSchedules(ws: string | null | undefined) {
  return useQuery({
    queryKey: ik.importSchedules(ws ?? ''), enabled: !!ws, refetchInterval: 60_000,
    queryFn: async () => {
      const rows = await sel<ImportSchedule[]>(supabase.from('outreach_import_schedules').select('*').eq('workspace_id', ws!).order('created_at', { ascending: false }));
      const jobIds = (rows ?? []).map((r) => r.last_job_id).filter((x): x is string => !!x);
      if (!jobIds.length) return rows ?? [];
      const jobs = await sel<{ id: string; status: JobStatus; error: string | null }[]>(supabase.from('outreach_import_jobs').select('id, status, error').in('id', jobIds));
      const byId = new Map((jobs ?? []).map((j) => [j.id, j]));
      return (rows ?? []).map((r) => ({ ...r, last_job: r.last_job_id ? byId.get(r.last_job_id) ?? null : null }));
    },
  });
}

export interface SaveScheduleInput {
  workspace_id: string; sender_id: string; kind: ImportKindV2; params: Record<string, unknown>; list_id: string | null; tag_ids: string[];
  client_id: string | null; enrich: boolean; cadence: ImportCadence; name?: string;
}
export function saveImportSchedule(p: SaveScheduleInput): Promise<string> {
  return rpc<string>('save_import_schedule', { p });
}

// ---------------------------------------------------------------------------
// Selections handed from the leads list to /outreach/ai-review (too long for a URL beyond a few dozen ids)
// ---------------------------------------------------------------------------
const SELECTION_PREFIX = 'outreach-selection:';
export function stashSelection(ids: string[]): string {
  const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try { sessionStorage.setItem(SELECTION_PREFIX + key, JSON.stringify(ids)); } catch { /* storage unavailable */ }
  return key;
}
export function readSelection(key: string | null | undefined): string[] {
  if (!key) return [];
  try {
    const raw = sessionStorage.getItem(SELECTION_PREFIX + key);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
