'use client';

// Query hooks and fetch helpers specific to the sequences area (kept out of lib/outreach/queries.ts to avoid
// concurrent edits to the shared file). Query keys start with ['outreach', ws] so the shell's invalidation applies.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from '@/lib/outreach/api';
import { LIVE_ENROLLMENT_STATUSES, type ActionType } from '@/lib/outreach/types';
import type { LeadFilters } from '@/lib/outreach/queries';

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
