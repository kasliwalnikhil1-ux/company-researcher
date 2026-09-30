'use client';

// Activity tab: filter model (persisted per workspace), the paged runs query and the CSV export.
import { useInfiniteQuery } from '@tanstack/react-query';
import { rpc } from '@/lib/outreach/api';
import { downloadCsv, type CsvColumn } from '@/lib/outreach/reports';
import { STATUS_LABEL, type RunStatus } from '@/lib/outreach/aiReplies';
import { aisqk, MODE_LABEL_V2, type RunListItemV2 as RunListItem } from '@/lib/outreach/aiRepliesSequence';
import { inboundToDraft, inboundToSent, isoDaysAgo, localIsoDate, reasonLabel, runReasons, stageLabel } from '../format';

/** Primitives only, so `usePersistedFilters` can store them. `status` is a comma list; `since` is a number of days. */
export interface RunFilterState {
  status: string; decision: string; mode: string; trigger: string; sender_id: string; sequence_id: string; stage: string; reason: string; since: string;
  /** Free text over the loaded rows. Never stored. */
  q: string;
}
export const RUN_FILTER_DEFAULTS: RunFilterState = { status: '', decision: '', mode: '', trigger: '', sender_id: '', sequence_id: '', stage: '', reason: '', since: '30', q: '' };
export const SINCE_OPTIONS = [{ v: '1', label: 'Last 24 hours' }, { v: '7', label: 'Last 7 days' }, { v: '30', label: 'Last 30 days' }, { v: '90', label: 'Last 90 days' }, { v: '', label: 'All time' }];

export const statusList = (s: string): RunStatus[] => s.split(',').filter((x): x is RunStatus => x in STATUS_LABEL);

/** The `p_filters` payload of ai_reply_runs_list. Empty values are left out. */
export function toRpcFilters(f: RunFilterState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const st = statusList(f.status);
  if (st.length) out.status = st;
  for (const k of ['decision', 'mode', 'trigger', 'sender_id', 'sequence_id', 'stage', 'reason'] as const) if (f[k]) out[k] = f[k];
  const days = Number(f.since);
  if (f.since && Number.isFinite(days) && days > 0) out.since = isoDaysAgo(days);
  return out;
}

export function matchesText(r: RunListItem, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [r.lead_name, r.sender_name, r.sequence_name, r.inbound_text, r.draft_text, r.final_text, r.scenario_title].some((v) => v?.toLowerCase().includes(s));
}

type Page = { items: RunListItem[]; next_before: string | null };

/** ai_reply_runs_list with "Load more" (keyset on `next_before`). */
export function useRunsPaged(ws: string | null, filters: Record<string, unknown>, limit = 50) {
  return useInfiniteQuery({
    queryKey: [...aisqk.runs(ws ?? '', { ...filters, limit }), 'paged'],
    enabled: !!ws,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => rpc<Page>('ai_reply_runs_list', { p_ws: ws, p_filters: filters, p_limit: limit, p_before: pageParam }),
    getNextPageParam: (last) => last.next_before ?? undefined,
  });
}

export function exportRunsCsv(rows: RunListItem[], stageLabels: Record<string, string>) {
  const cols: Array<CsvColumn<RunListItem>> = [
    { header: 'Created', value: (r) => r.created_at },
    { header: 'Lead', value: (r) => r.lead_name },
    { header: 'Sender', value: (r) => r.sender_name },
    { header: 'Sequence', value: (r) => r.sequence_name },
    { header: 'Mode', value: (r) => (r.mode ? MODE_LABEL_V2[r.mode] : '') },
    { header: 'Trigger', value: (r) => (r.trigger === 'manual' ? 'Draft with AI' : 'Automatic') },
    { header: 'Status', value: (r) => STATUS_LABEL[r.status] ?? r.status },
    { header: 'Decision', value: (r) => r.decision },
    { header: 'Stage before', value: (r) => (r.stage_before ? stageLabel(r.stage_before, stageLabels) : '') },
    { header: 'Stage after', value: (r) => (r.stage_after ? stageLabel(r.stage_after, stageLabels) : '') },
    { header: 'Move', value: (r) => r.move },
    { header: 'Rule applied', value: (r) => r.rule_applied },
    { header: 'Scenario', value: (r) => r.scenario_title ?? '' },
    { header: 'Stops the conversation', value: (r) => (r.stop_after_send ? r.stop_rule ?? 'yes' : '') },
    { header: 'Reasons', value: (r) => runReasons(r).map(reasonLabel).join('; ') },
    { header: 'Cancel reason', value: (r) => r.cancel_reason },
    { header: 'Inbound to draft (s)', value: (r) => roundOrNull(inboundToDraft(r)) },
    { header: 'Inbound to sent (s)', value: (r) => roundOrNull(inboundToSent(r)) },
    { header: 'Their message', value: (r) => r.inbound_text },
    { header: 'Draft', value: (r) => r.draft_text },
    { header: 'Sent text', value: (r) => r.final_text },
    { header: 'Prompt version', value: (r) => r.master_prompt_version },
    { header: 'Run id', value: (r) => r.id },
    { header: 'Chat id', value: (r) => r.chat_id },
  ];
  downloadCsv(`ai-replies_activity_${localIsoDate(new Date())}.csv`, cols, rows);
}

const roundOrNull = (n: number | null) => (n == null ? null : Math.round(n));
