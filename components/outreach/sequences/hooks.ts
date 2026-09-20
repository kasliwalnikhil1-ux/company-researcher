'use client';

// Query hooks and fetch helpers specific to the sequences area (kept out of lib/outreach/queries.ts to avoid
// concurrent edits to the shared file). Query keys start with ['outreach', ws] so the shell's invalidation applies.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from '@/lib/outreach/api';
import { LIVE_ENROLLMENT_STATUSES, type ActionType } from '@/lib/outreach/types';
import type { LeadFilters } from '@/lib/outreach/queries';
import type { AutoEnrolLogRow, AutoEnrolRule, FailedKind, FailedLeadRow, QueuedActionRow, VersionUsageRow, WhyNotSendingResult } from './publishTypes';

export interface SequenceSummaryRow { sequence_id: string; live: number; completed: number; replied: number; sent: number; queued: number }

export function useSequenceSummary(ws: string | null | undefined) {
  return useQuery({
    queryKey: ['outreach', ws ?? '', 'sequence_summary'],
    enabled: !!ws,
    refetchInterval: 30000,
    queryFn: () => rpc<SequenceSummaryRow[]>('sequence_summary', { p_ws: ws }),
  });
}

/** Count live enrollments for a sequence (optionally only those sitting at one node). */
export async function countInflight(sequenceId: string, nodeId?: string): Promise<number> {
  let q = supabase.from('outreach_enrollments').select('id', { count: 'exact', head: true }).eq('sequence_id', sequenceId).in('status', LIVE_ENROLLMENT_STATUSES);
  if (nodeId) q = q.eq('current_node_id', nodeId);
  const { count, error } = await q;
  if (error) throw parseError(error);
  return count ?? 0;
}

export function useInflightCount(sequenceId: string | null | undefined) {
  return useQuery({
    queryKey: ['outreach', 'enrollments', 'inflight', sequenceId ?? ''],
    enabled: !!sequenceId,
    refetchInterval: 30000,
    queryFn: () => countInflight(sequenceId!),
  });
}

export interface ProjectionRow { estimated_days: number; bottleneck: ActionType | null; details: Record<string, any> }

export async function projectSequence(sequenceId: string, leadCount: number): Promise<ProjectionRow | null> {
  const rows = await rpc<ProjectionRow[] | ProjectionRow | null>('project_sequence', { p_sequence: sequenceId, p_lead_count: leadCount });
  if (!rows) return null;
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}

/** Effective daily cap per sender for one action type (rpc effective_cap). */
export function useEffectiveCaps(senderIds: string[], type: ActionType = 'invite') {
  const key = [...senderIds].sort().join(',');
  return useQuery({
    queryKey: ['outreach', 'effective_cap', type, key],
    enabled: senderIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(senderIds.map(async (id) => {
        try { return [id, await rpc<number>('effective_cap', { p_sender: id, p_type: type })] as const; }
        catch { return [id, null] as const; }
      }));
      return Object.fromEntries(entries) as Record<string, number | null>;
    },
  });
}

/** Fetch every lead id matching the filters, paging 1000 at a time (hard cap `max`). */
export async function fetchLeadIds(ws: string, f: LeadFilters, max = 10000, onProgress?: (n: number) => void): Promise<string[]> {
  const ids: string[] = [];
  const page = 1000;
  for (let from = 0; from < max; from += page) {
    const to = Math.min(from + page, max) - 1;
    let q = supabase.from('outreach_leads').select(f.tag_id ? 'id, outreach_lead_tags!inner(tag_id)' : 'id').eq('workspace_id', ws);
    if (f.search) q = q.or(`full_name.ilike.%${f.search}%,company.ilike.%${f.search}%,headline.ilike.%${f.search}%,public_identifier.ilike.%${f.search}%,email_work.ilike.%${f.search}%`);
    if (f.client_id) q = q.eq('client_id', f.client_id);
    if (f.list_id) q = q.eq('list_id', f.list_id);
    if (f.stage_id) q = q.eq('stage_id', f.stage_id);
    if (f.dnc != null) q = q.eq('do_not_contact', f.dnc);
    if (f.tag_id) q = q.eq('outreach_lead_tags.tag_id', f.tag_id);
    const { data, error } = await q.order('created_at', { ascending: false }).range(from, to);
    if (error) throw parseError(error);
    const rows = (data ?? []) as unknown as { id: string }[];
    for (const r of rows) ids.push(r.id);
    onProgress?.(ids.length);
    if (rows.length < to - from + 1) break;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Draft / publish / recovery (migrations 012 + 013)
// ---------------------------------------------------------------------------
export const sqk = {
  everEnrolled: (id: string) => ['outreach', 'enrollments', 'ever', id] as const,
  queued: (id: string, node: string) => ['outreach', 'sequence', id, 'queued', node] as const,
  waitingDelay: (id: string, node: string) => ['outreach', 'enrollments', 'waiting_delay', id, node] as const,
  failedLeads: (id: string, node: string | null, kind: FailedKind) => ['outreach', 'enrollments', 'failed_leads', id, node ?? '', kind] as const,
  failedCounts: (ws: string) => ['outreach', 'enrollments', 'failed_counts', ws] as const,
  versionUsage: (id: string) => ['outreach', 'sequence', id, 'version_usage'] as const,
  autoRules: (id: string) => ['outreach', 'sequence', id, 'auto_rules'] as const,
  autoLog: (id: string) => ['outreach', 'sequence', id, 'auto_log'] as const,
  ruleMatch: (rule: string) => ['outreach', 'auto_rule', rule, 'match'] as const,
  why: (k: string) => ['outreach', 'why_not_sending', k] as const,
};

/** True once the sequence has had any enrolment, live or finished. Such sequences publish instead of save. */
export function useEverEnrolled(sequenceId: string | null | undefined) {
  return useQuery({
    queryKey: sqk.everEnrolled(sequenceId ?? ''),
    enabled: !!sequenceId,
    queryFn: async () => {
      const { count, error } = await supabase.from('outreach_enrollments').select('id', { count: 'exact', head: true }).eq('sequence_id', sequenceId!);
      if (error) throw parseError(error);
      return (count ?? 0) > 0;
    },
  });
}

export function useQueuedActions(sequenceId: string, nodeId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: sqk.queued(sequenceId, nodeId ?? ''),
    enabled: enabled && !!nodeId,
    refetchInterval: 30000,
    queryFn: () => rpc<QueuedActionRow[]>('node_queued_actions', { p_sequence: sequenceId, p_node_id: nodeId }).then((r) => r ?? []),
  });
}

export function useWaitingInDelay(sequenceId: string, nodeId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: sqk.waitingDelay(sequenceId, nodeId ?? ''),
    enabled: enabled && !!nodeId,
    refetchInterval: 30000,
    queryFn: async () => {
      const { count, error } = await supabase.from('outreach_enrollments').select('id', { count: 'exact', head: true })
        .eq('sequence_id', sequenceId).eq('current_node_id', nodeId!).eq('status', 'waiting_delay');
      if (error) throw parseError(error);
      return count ?? 0;
    },
  });
}

/** Failed enrolments of one sequence (the chip on the builder top bar). */
export function useFailedCount(sequenceId: string | null | undefined) {
  return useQuery({
    queryKey: ['outreach', 'enrollments', 'failed_count', sequenceId ?? ''],
    enabled: !!sequenceId,
    refetchInterval: 60000,
    queryFn: async () => {
      const { count, error } = await supabase.from('outreach_enrollments').select('id', { count: 'exact', head: true }).eq('sequence_id', sequenceId!).eq('status', 'failed');
      if (error) throw parseError(error);
      return count ?? 0;
    },
  });
}

export const FAILED_PAGE = 200;

export function useFailedLeads(sequenceId: string, nodeId: string | null, kind: FailedKind, page: number, enabled = true) {
  return useQuery({
    queryKey: [...sqk.failedLeads(sequenceId, nodeId, kind), page],
    enabled: enabled && !!sequenceId,
    queryFn: () => rpc<FailedLeadRow[]>('failed_leads', { p_sequence: sequenceId, p_node_id: nodeId, p_kind: kind, p_limit: FAILED_PAGE, p_offset: page * FAILED_PAGE }).then((r) => r ?? []),
  });
}

/** Failed enrolments per sequence for the list page (one light query for the workspace). */
export function useFailedCounts(ws: string | null | undefined) {
  return useQuery({
    queryKey: sqk.failedCounts(ws ?? ''),
    enabled: !!ws,
    refetchInterval: 60000,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_enrollments').select('sequence_id').eq('workspace_id', ws!).eq('status', 'failed').limit(5000);
      if (error) throw parseError(error);
      const out: Record<string, number> = {};
      for (const r of (data ?? []) as { sequence_id: string }[]) out[r.sequence_id] = (out[r.sequence_id] ?? 0) + 1;
      return out;
    },
  });
}

export function useVersionUsage(sequenceId: string | null | undefined) {
  return useQuery({
    queryKey: sqk.versionUsage(sequenceId ?? ''),
    enabled: !!sequenceId,
    queryFn: () => rpc<VersionUsageRow[]>('version_usage', { p_sequence: sequenceId }).then((r) => r ?? []),
  });
}

export function useAutoEnrolRules(sequenceId: string | null | undefined) {
  return useQuery({
    queryKey: sqk.autoRules(sequenceId ?? ''),
    enabled: !!sequenceId,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_auto_enroll_rules').select('*').eq('sequence_id', sequenceId!).order('created_at');
      if (error) throw parseError(error);
      return (data ?? []) as AutoEnrolRule[];
    },
  });
}

export function useAutoEnrolLog(sequenceId: string | null | undefined, ruleIds: string[]) {
  const key = [...ruleIds].sort().join(',');
  return useQuery({
    queryKey: [...sqk.autoLog(sequenceId ?? ''), key],
    enabled: !!sequenceId && ruleIds.length > 0,
    refetchInterval: 60000,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_auto_enroll_log').select('*').in('rule_id', ruleIds).order('at', { ascending: false }).limit(60);
      if (error) throw parseError(error);
      return (data ?? []) as AutoEnrolLogRow[];
    },
  });
}

export function useRuleMatchCount(ruleId: string | null | undefined) {
  return useQuery({
    queryKey: sqk.ruleMatch(ruleId ?? ''),
    enabled: !!ruleId,
    staleTime: 30000,
    queryFn: () => rpc<number>('rule_match_count', { p_rule: ruleId }),
  });
}

export function useWhyNotSending(target: { sequenceId?: string | null; senderId?: string | null; enrollmentId?: string | null }, enabled: boolean) {
  const k = `${target.enrollmentId ?? ''}:${target.sequenceId ?? ''}:${target.senderId ?? ''}`;
  return useQuery({
    queryKey: sqk.why(k),
    enabled: enabled && !!(target.sequenceId || target.senderId || target.enrollmentId),
    staleTime: 0,
    gcTime: 0,
    queryFn: () => rpc<WhyNotSendingResult>('why_not_sending', { p_sequence: target.sequenceId ?? null, p_sender: target.senderId ?? null, p_enrollment: target.enrollmentId ?? null }),
  });
}
