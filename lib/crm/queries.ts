'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc, compact } from './api';
import type { Activity, Company, CompanyBrief, Contact, Deal, Funnel, Meeting, Pipeline, Standup, StageHistory, Capture, Transcript } from './types';

export const qk = {
  standup: (date?: string) => ['crm', 'standup', date ?? 'today'] as const,
  pipeline: (f: unknown) => ['crm', 'pipeline', f] as const,
  companies: (f: unknown) => ['crm', 'companies', f] as const,
  company: (id: string) => ['crm', 'company', id] as const,
  meetings: (f: unknown) => ['crm', 'meetings', f] as const,
  meeting: (id: string) => ['crm', 'meeting', id] as const,
  deal: (id: string) => ['crm', 'deal', id] as const,
  transcript: (meetingId: string) => ['crm', 'transcript', meetingId] as const,
  recordingUrl: (meetingId: string) => ['crm', 'recording-url', meetingId] as const,
  commitments: (from: string, to?: string) => ['crm', 'commitments', from, to] as const,
  channelCosts: () => ['crm', 'channel_costs'] as const,
  funnel: (from: string, to?: string) => ['crm', 'funnel', from, to ?? 'today'] as const,
};

async function sel<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await q;
  if (error) throw parseError(error);
  return data as T;
}

/** Invalidate everything CRM after any write — the data set is small and the rules cascade (captures move deals, etc.). */
export function useCrmInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['crm'] });
}

// ---------------------------------------------------------------- reads
export function useStandup(date?: string) {
  return useQuery({ queryKey: qk.standup(date), refetchInterval: 60_000, queryFn: () => rpc<Standup>('standup', { p_date: date ?? null, p_tz: null }) });
}

export function usePipeline(filters: { owner?: string; icp_segment?: string; source_channel?: string; include_closed?: boolean }) {
  return useQuery({ queryKey: qk.pipeline(filters), queryFn: () => rpc<Pipeline>('pipeline', { p: compact(filters) }) });
}

export type CompanyRow = Company & { crm_deals: Array<Pick<Deal, 'id' | 'stage' | 'value_monthly' | 'currency' | 'value_monthly_usd' | 'last_activity_at' | 'next_step' | 'next_step_date'>>; crm_contacts: Array<Pick<Contact, 'id' | 'name' | 'role' | 'email' | 'is_primary'>> };

/** Server-side paginated (page is 1-based). `total` is the exact count for the current filters, not just this page. */
export function useCompanies(f: { q?: string; icp_segment_id?: string; source_channel_id?: string; page?: number; pageSize?: number }) {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = f.pageSize ?? 50;
  return useQuery({
    queryKey: qk.companies({ ...f, page, pageSize }),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase.from('crm_companies').select('*, crm_deals(id, stage, value_monthly, currency, value_monthly_usd, last_activity_at, next_step, next_step_date), crm_contacts(id, name, role, email, is_primary)', { count: 'exact' }).order('name').order('id');
      if (f.icp_segment_id) q = q.eq('icp_segment_id', f.icp_segment_id);
      if (f.source_channel_id) q = q.eq('source_channel_id', f.source_channel_id);
      if (f.q) q = q.or(`name.ilike.%${f.q}%,domain.ilike.%${f.q}%,country.ilike.%${f.q}%`);
      const { data, error, count } = await q.range((page - 1) * pageSize, page * pageSize - 1);
      // PGRST103 = offset past the last row (e.g. rows were deleted while on the last page) — the page clamps itself back.
      if (error && (error as { code?: string }).code === 'PGRST103') return { rows: [] as CompanyRow[], total: 0, outOfRange: true };
      if (error) throw parseError(error);
      return { rows: (data ?? []) as CompanyRow[], total: count ?? 0, outOfRange: false };
    },
  });
}

export function useCompanyBrief(id: string | undefined) {
  return useQuery({ queryKey: qk.company(id ?? ''), enabled: !!id, queryFn: () => rpc<CompanyBrief>('company_brief', { p_company: id }) });
}

export function useMeetings(f: { from?: string; to?: string; status?: string; uncapturedOnly?: boolean }) {
  return useQuery({
    queryKey: qk.meetings(f),
    queryFn: async () => {
      let q = supabase.from('crm_meetings_v').select('*').order('scheduled_at', { ascending: true });
      if (f.from) q = q.gte('scheduled_at', f.from);
      if (f.to) q = q.lte('scheduled_at', f.to);
      if (f.status) q = q.eq('status', f.status);
      if (f.uncapturedOnly) q = q.eq('status', 'scheduled');
      return sel<Meeting[]>(q);
    },
  });
}

export function useMeeting(id: string | undefined) {
  return useQuery({
    queryKey: qk.meeting(id ?? ''), enabled: !!id,
    queryFn: async () => {
      const [m, cap] = await Promise.all([
        sel<Meeting | null>(supabase.from('crm_meetings_v').select('*').eq('id', id!).maybeSingle()),
        sel<Capture | null>(supabase.from('crm_meeting_captures').select('*').eq('meeting_id', id!).maybeSingle()),
      ]);
      return { meeting: m, capture: cap };
    },
  });
}

/** The whole transcript in one read (a long call is a few hundred turns); search and the prospect-only filter run in the browser. */
export function useTranscript(meetingId: string | null | undefined) {
  return useQuery({ queryKey: qk.transcript(meetingId ?? ''), enabled: !!meetingId, queryFn: () => rpc<Transcript>('get_transcript', { p_meeting_id: meetingId, p: { limit: 6000 } }) });
}

export function useDeal(id: string | undefined) {
  return useQuery({
    queryKey: qk.deal(id ?? ''), enabled: !!id,
    queryFn: async () => {
      const [deal, history, activities, meetings] = await Promise.all([
        sel<Deal | null>(supabase.from('crm_deals_v').select('*').eq('id', id!).maybeSingle()),
        sel<StageHistory[]>(supabase.from('crm_stage_history').select('*').eq('deal_id', id!).order('changed_at')),
        sel<Activity[]>(supabase.from('crm_activities_v').select('*').eq('deal_id', id!).order('occurred_at', { ascending: false }).limit(200)),
        sel<Meeting[]>(supabase.from('crm_meetings_v').select('*').eq('deal_id', id!).order('scheduled_at')),
      ]);
      return { deal, history, activities, meetings };
    },
  });
}

export function useFunnel(from: string, to?: string) {
  return useQuery({ queryKey: qk.funnel(from, to), placeholderData: keepPreviousData, queryFn: () => rpc<Funnel>('funnel', { p_from: from, p_to: to ?? null, p_source_channel: null }) });
}

export function useChannelCosts() {
  return useQuery({ queryKey: qk.channelCosts(), queryFn: () => sel<Array<{ id: string; source_channel_id: string; month: string; cost: number; currency: string; notes: string | null }>>(supabase.from('crm_channel_costs').select('*').order('month', { ascending: false }).limit(200)) });
}

// ---------------------------------------------------------------- writes (all through crm_* RPCs, same as the MCP)
export function useCrmMutation<TArgs, TRes = unknown>(name: string, build: (a: TArgs) => Record<string, unknown>) {
  const invalidate = useCrmInvalidate();
  return useMutation<TRes, Error, TArgs>({
    mutationFn: async (a) => rpc<TRes>(name, build(a)),
    onSuccess: () => { invalidate(); },
    onError: () => { invalidate(); },
  });
}
