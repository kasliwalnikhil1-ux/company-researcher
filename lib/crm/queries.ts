'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc, compact } from './api';
import type { Activity, Company, CompanyBrief, Contact, Deal, Meeting, Pipeline, Standup, StageHistory, Capture } from './types';

export const qk = {
  standup: (date?: string) => ['crm', 'standup', date ?? 'today'] as const,
  pipeline: (f: unknown) => ['crm', 'pipeline', f] as const,
  companies: (f: unknown) => ['crm', 'companies', f] as const,
  company: (id: string) => ['crm', 'company', id] as const,
  meetings: (f: unknown) => ['crm', 'meetings', f] as const,
  meeting: (id: string) => ['crm', 'meeting', id] as const,
  deal: (id: string) => ['crm', 'deal', id] as const,
  commitments: (from: string, to?: string) => ['crm', 'commitments', from, to] as const,
  channelCosts: () => ['crm', 'channel_costs'] as const,
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

export function useCompanies(f: { q?: string; icp_segment_id?: string; source_channel_id?: string }) {
  return useQuery({
    queryKey: qk.companies(f),
    queryFn: async () => {
      let q = supabase.from('crm_companies').select('*, crm_deals(id, stage, value_monthly, currency, value_monthly_usd, last_activity_at, next_step, next_step_date), crm_contacts(id, name, role, is_primary)').order('name');
      if (f.icp_segment_id) q = q.eq('icp_segment_id', f.icp_segment_id);
      if (f.source_channel_id) q = q.eq('source_channel_id', f.source_channel_id);
      if (f.q) q = q.or(`name.ilike.%${f.q}%,domain.ilike.%${f.q}%,country.ilike.%${f.q}%`);
      return sel<Array<Company & { crm_deals: Array<Pick<Deal, 'id' | 'stage' | 'value_monthly' | 'currency' | 'value_monthly_usd' | 'last_activity_at' | 'next_step' | 'next_step_date'>>; crm_contacts: Array<Pick<Contact, 'id' | 'name' | 'role' | 'is_primary'>> }>>(q);
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
