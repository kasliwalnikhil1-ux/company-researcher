// Local editable copy of a sequence (everything save_sequence accepts).
import type { Graph, Sequence } from '@/lib/outreach/types';

export interface Draft {
  name: string;
  graph: Graph;
  pool: string[];
  assignment: Sequence['assignment'];
  useSenderSchedule: boolean;
  settings: Sequence['settings'];
  brief: string;
  clientId: string | null;
}

export function draftFromSequence(s: Sequence): Draft {
  return {
    name: s.name,
    graph: JSON.parse(JSON.stringify(s.graph)) as Graph,
    pool: [...(s.sender_pool ?? [])],
    assignment: s.assignment ?? 'round_robin',
    useSenderSchedule: s.use_sender_schedule ?? true,
    settings: { ...(s.settings ?? {}) },
    brief: s.brief ?? '',
    clientId: s.client_id ?? null,
  };
}

/** Stable serialization used to detect unsaved changes. */
export function serializeDraft(d: Draft): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(stable(d));
}

export function saveArgs(id: string, d: Draft): Record<string, unknown> {
  return {
    p_id: id,
    p_graph: d.graph,
    p_pool: d.pool,
    p_settings: d.settings,
    p_name: d.name.trim() || null,
    p_assignment: d.assignment,
    p_use_sender_schedule: d.useSenderSchedule,
    p_client_id: d.clientId,
    p_brief: d.brief ?? '',
  };
}
