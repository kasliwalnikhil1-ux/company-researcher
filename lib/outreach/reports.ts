'use client';

// Reports workstream: types, hooks and formatting helpers for the numbers defined in
// migrations/outreach/013_reports.sql. Nothing here re-computes a metric; rates and totals
// come from the database as they are. The only arithmetic is presentational (period change).

import { useEffect } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from './api';
import { qk } from './queries';
import type { Provider, SenderStatus } from './types';

// ---------------------------------------------------------------------------
// Shapes returned by the report functions
// ---------------------------------------------------------------------------
export const INTENT_KEYS = ['interested', 'question', 'not_now', 'not_interested', 'wrong_person', 'ooo', 'unclear', 'unclassified'] as const;
export type IntentKey = (typeof INTENT_KEYS)[number];
export type IntentCounts = Record<IntentKey, number>;

export const INTENT_LABELS: Record<IntentKey, string> = {
  interested: 'Interested', question: 'Question', not_now: 'Not now', not_interested: 'Not interested',
  wrong_person: 'Wrong person', ooo: 'Out of office', unclear: 'Unclear', unclassified: 'Not classified',
};

export type Rate = number | null;

export interface Totals {
  enrolled: number; invites: number; invites_with_note: number; accepted: number; acceptance_rate: Rate;
  messages: number; inmails: number; emails: number; touches: number;
  replies: number; reply_rate: Rate; interested: number; interested_rate: Rate; positive_reply_rate: Rate; negative_reply_rate: Rate;
  intents: IntentCounts;
  meetings: number; won: number; lost: number; won_value: number; inbound_messages: number;
  profile_views: number; likes: number; comments: number; endorsements: number; follows: number; withdrawn: number; post_fetches: number;
  failed: number; skipped: number; limit_hits: number;
  email_opened: number; email_clicked: number; email_bounced: number; open_rate: Rate; click_rate: Rate; bounce_rate: Rate;
}
export type SeriesPoint = Totals & { day: string };

export interface Period { from: string; to: string; timezone: string; days?: number; previous_from?: string; previous_to?: string }

export interface OverviewReport {
  period: Required<Period>;
  totals: Totals;
  previous: Totals;
  by_channel: Partial<Record<'linkedin' | 'email', Totals>>;
  series: SeriesPoint[];
}

export const FUNNEL_STAGES = ['enrolled', 'invited', 'accepted', 'messaged', 'replied', 'interested', 'meeting', 'won'] as const;
export type FunnelStageKey = (typeof FUNNEL_STAGES)[number];
export const FUNNEL_LABELS: Record<FunnelStageKey, string> = {
  enrolled: 'Enrolled', invited: 'Invited', accepted: 'Accepted', messaged: 'Messaged', replied: 'Replied', interested: 'Interested', meeting: 'Meeting booked', won: 'Won',
};
export interface FunnelStage { stage: FunnelStageKey; count: number; pct_of_enrolled: Rate; pct_of_previous: Rate; median_hours_from_previous: number | null }
export interface FunnelReport { period: Period; cohort: number; stages: FunnelStage[] }
export interface FunnelFilters { sequence_id?: string; sender_id?: string; list_id?: string; tag_id?: string }

export type IntentGroup = 'day' | 'sequence' | 'step' | 'sender' | 'variant' | 'channel';
export interface IntentRow { key: string; label: string | null; replies: number; touches: number; reply_rate: Rate; positive_reply_rate: Rate; negative_reply_rate: Rate; intents: IntentCounts }
export interface IntentsReport {
  period: Period; group: string; replies: number; touches: number; reply_rate: Rate; positive_reply_rate: Rate; negative_reply_rate: Rate; intents: IntentCounts; rows: IntentRow[];
}
export interface ReportFilters { sequence_id?: string; sender_id?: string; node_id?: string; channel?: string; variant_id?: string }

export interface ReplyThread { chat_id: string; lead_id: string | null; lead_name: string | null; sender_id: string; intent: string; replied_at: string; sequence_id: string | null; node_id: string | null; variant_id: string | null; preview: string }

export interface SequenceRow {
  sequence_id: string; name: string; status: string; client_id: string | null; stalled: boolean; stalled_reason: string | null;
  live: number; failed_leads: number; has_ab_test: boolean; totals: Totals;
}
export interface StepRow {
  node_id: string; type: string; label: string; sent: number; failed: number; skipped: number; accepted: number; replies: number; interested: number;
  reply_rate: Rate; positive_reply_rate: Rate; acceptance_rate: Rate; leads_here: number; failed_here: number;
}
export interface AbVariant {
  variant_id: string; label: string; weight?: number | null; leads?: number; sent: number; accepted: number; replies: number; interested: number; meetings?: number;
  acceptance_rate: Rate; reply_rate: Rate; interested_rate: Rate; is_leading: boolean; confidence_vs_leader: number | null; verdict_vs_leader: string | null;
}
export interface AbTest {
  sequence_id: string; node_id: string; node_type: string; judged_on: 'accepted' | 'interested'; period: { from: string; to: string };
  enough_data: boolean; min_sends_per_variant: number; variants: AbVariant[]; leader: string | null; can_promote: boolean;
}
export interface SequenceReport {
  sequence: { id: string; name: string; status: string; head_version: number; stalled_reason: string | null };
  period: Period; totals: Totals; steps: StepRow[]; best_step: StepRow | null; worst_step: StepRow | null; ab_tests: AbTest[]; exits: Record<string, number>; live: number;
}

export interface SenderRow {
  sender_id: string; name: string | null; provider: Provider; status: SenderStatus; client_id: string | null; health: number; level: number;
  paused_until: string | null; invite_blocked_until: string | null; running_dry: boolean; totals: Totals;
}
export interface SenderReport {
  sender: { id: string; name: string | null; status: SenderStatus; health: number; level: number };
  period: Period; totals: Totals; series: SeriesPoint[];
  health_trend: Array<{ at: string; score: number | null }>;
  restrictions: Array<{ at: string; kind: string; data: Record<string, unknown> }>;
  failures_by_reason: Record<string, number>;
}

export interface ClientRow { client_id: string; name: string; senders: number; leads: number; live: number; totals: Totals }
export interface ClientReport extends OverviewReport {
  client: { id: string; name: string };
  leads: number;
  senders: Array<{ id: string; name: string | null; status: SenderStatus; health: number }>;
  live_enrollments: number;
}

export interface CostReport {
  period: Period; currency: string; default_sender_monthly_cost: number | null; senders: number; senders_without_cost: number; cost: number | null;
  per_sender: Array<{ sender_id: string; name: string | null; monthly_cost: number | null; days: number; cost: number | null }>;
  replies: number; interested: number; meetings: number; won: number;
  cost_per_reply: number | null; cost_per_interested: number | null; cost_per_meeting: number | null;
  won_value: number | null; return_multiple: number | null; note: string | null;
}

export type MetricDefinitions = Record<string, string>;

export interface AttentionItem { kind: string; id: string; label: string | null; reason: string | null }
export interface DashboardV2 {
  senders: Array<{ id: string; display_name: string | null; provider: Provider; status: SenderStatus; status_reason: string | null; health_score: number; warmup_level: number; client_id: string | null; paused_until: string | null; running_dry: boolean; today: Record<string, { used: number; reserved: number; cap: number }> }>;
  attention: AttentionItem[];
  replies_awaiting: number; unread: number; tasks_open: number; drafts_awaiting: number; ai_lines_awaiting: number;
  enrollments_live: number; sent_today: number; queued_today: number; leads_total: number;
  today: Totals; last_7_days: Totals;
}

export interface Branding {
  workspace_name?: string; product_name?: string | null; logo_url?: string | null; accent?: string | null;
  support_email?: string | null; help_url?: string | null; docs_url?: string | null; hide_platform_name?: boolean | null;
}

export interface SavedRange { id: string; workspace_id: string; user_id: string; name: string; preset: string | null; from_date: string | null; to_date: string | null; created_at: string }
export type ScheduleKind = 'digest' | 'client_report' | 'sender_report';
export interface ReportSchedule {
  id: string; workspace_id: string; client_id: string | null; kind: ScheduleKind; cadence: 'weekly' | 'monthly';
  recipients: string[]; include_client_viewers: boolean; active: boolean; last_sent_at: string | null; created_at: string;
}

// ---------------------------------------------------------------------------
// Date ranges. Dates are calendar days in the workspace timezone, inclusive.
// ---------------------------------------------------------------------------
export type PresetKey = '7d' | '30d' | '90d' | 'this_month' | 'last_month';
export const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }, { key: '90d', label: '90 days' },
  { key: 'this_month', label: 'This month' }, { key: 'last_month', label: 'Last month' },
];
export interface DateRange { from: string; to: string }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDay(v: string | null | undefined): v is string {
  return !!v && ISO_DAY.test(v) && !isNaN(Date.parse(`${v}T00:00:00Z`));
}

export function todayInTz(tz: string | null | undefined): string {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

export function presetRange(key: PresetKey, tz: string | null | undefined): DateRange {
  const today = todayInTz(tz);
  if (key === '7d') return { from: addDays(today, -6), to: today };
  if (key === '30d') return { from: addDays(today, -29), to: today };
  if (key === '90d') return { from: addDays(today, -89), to: today };
  const first = `${today.slice(0, 8)}01`;
  if (key === 'this_month') return { from: first, to: today };
  const lastPrev = addDays(first, -1);
  return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev };
}

export function matchPreset(r: DateRange, tz: string | null | undefined): PresetKey | null {
  for (const p of PRESETS) { const x = presetRange(p.key, tz); if (x.from === r.from && x.to === r.to) return p.key; }
  return null;
}

export function isPresetKey(v: string | null | undefined): v is PresetKey {
  return !!v && PRESETS.some((p) => p.key === v);
}

/** The report functions refuse ranges over two years and from > to. Keep the UI inside that. */
export function validRange(r: DateRange): string | null {
  if (!isIsoDay(r.from) || !isIsoDay(r.to)) return 'Pick a start and an end date.';
  if (r.from > r.to) return 'The start date is after the end date.';
  if (daysBetween(r.from, r.to) > 732) return 'A range can cover two years at most.';
  return null;
}

// ---------------------------------------------------------------------------
// Number formatting: one place, so tiles, tables, tooltips and CSV agree
// ---------------------------------------------------------------------------
const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const DASH = '—';

function finite(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n); }

export function fmtInt(n: number | null | undefined): string { return finite(n) ? INT.format(n) : DASH; }
export function fmtRate(n: number | null | undefined): string { return finite(n) ? `${n.toFixed(1)}%` : DASH; }
export function fmtMoney(n: number | null | undefined, currency = 'USD'): string {
  if (!finite(n)) return DASH;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(n); }
  catch { return `${INT.format(n)} ${currency}`; }
}
export function fmtMultiple(n: number | null | undefined): string { return finite(n) ? `${n.toFixed(1)}×` : DASH; }

/** "38 min", "5.2 hours", "2.4 days" */
export function fmtHours(h: number | null | undefined): string {
  if (!finite(h)) return DASH;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h.toFixed(1)} hours`;
  return `${(h / 24).toFixed(1)} days`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-09-14' → 'Sep 14' (no Date parsing in the local timezone, so the day never shifts) */
export function fmtDay(day: string | null | undefined, withYear = false): string {
  if (!isIsoDay(day)) return DASH;
  const [y, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}
export function fmtRange(r: DateRange): string {
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  return `${fmtDay(r.from, !sameYear)} – ${fmtDay(r.to, true)}`;
}

export interface Change { direction: 'up' | 'down' | 'flat' | 'none'; text: string }
/** Change of a count against the previous period. No base → no percentage, neutral colour. */
export function countChange(cur: number | null | undefined, prev: number | null | undefined): Change {
  if (!finite(cur) || !finite(prev) || prev === 0) return { direction: 'none', text: prev === 0 && finite(cur) && cur > 0 ? 'No activity in the previous period' : 'No change to compare' };
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.05) return { direction: 'flat', text: '0.0%' };
  return { direction: pct > 0 ? 'up' : 'down', text: `${Math.abs(pct).toFixed(1)}%` };
}
/** Change of a rate, in percentage points. */
export function rateChange(cur: Rate | undefined, prev: Rate | undefined): Change {
  if (!finite(cur) || !finite(prev)) return { direction: 'none', text: 'No rate to compare' };
  const d = cur - prev;
  if (Math.abs(d) < 0.05) return { direction: 'flat', text: '0.0 pts' };
  return { direction: d > 0 ? 'up' : 'down', text: `${Math.abs(d).toFixed(1)} pts` };
}

// ---------------------------------------------------------------------------
// CSV export (client-side). Cells that a spreadsheet would run as a formula are neutralised.
// ---------------------------------------------------------------------------
export interface CsvColumn<T> { header: string; value: (row: T) => string | number | null | undefined }

function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(columns: Array<CsvColumn<T>>, rows: T[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.value(r))).join(','));
  return lines.join('\r\n');
}

export function csvFileName(tab: string, range: DateRange, extra?: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return ['outreach', slug(tab), extra ? slug(extra) : null, range.from, 'to', range.to].filter(Boolean).join('_') + '.csv';
}

export function downloadCsv<T>(fileName: string, columns: Array<CsvColumn<T>>, rows: T[]): void {
  const blob = new Blob(['﻿', toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The standard totals columns, shared by the Sequences, Senders and Clients exports. */
export function totalsCsvColumns<T>(get: (row: T) => Totals): Array<CsvColumn<T>> {
  return [
    { header: 'Enrolled', value: (r) => get(r).enrolled }, { header: 'Invites', value: (r) => get(r).invites }, { header: 'Accepted', value: (r) => get(r).accepted },
    { header: 'Acceptance rate %', value: (r) => get(r).acceptance_rate }, { header: 'Touches', value: (r) => get(r).touches }, { header: 'Replies', value: (r) => get(r).replies },
    { header: 'Reply rate %', value: (r) => get(r).reply_rate }, { header: 'Interested', value: (r) => get(r).interested }, { header: 'Positive reply rate %', value: (r) => get(r).positive_reply_rate },
    { header: 'Negative reply rate %', value: (r) => get(r).negative_reply_rate }, { header: 'Meetings', value: (r) => get(r).meetings }, { header: 'Won', value: (r) => get(r).won },
  ];
}

// ---------------------------------------------------------------------------
// Hooks. Every hook maps to exactly one outreach_* function.
// ---------------------------------------------------------------------------
const rk = (ws: string, name: string, ...rest: unknown[]) => ['outreach', ws, 'reports', name, ...rest] as const;
const clean = (o: object | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));

interface Scope { ws: string | null | undefined; client?: string | null; range: DateRange; enabled?: boolean }
const base = (s: Scope) => ({ p_ws: s.ws, p_client: s.client || null, p_from: s.range.from, p_to: s.range.to });
const on = (s: Scope) => !!s.ws && s.enabled !== false && !validRange(s.range);

export function useMetricDefinitions() {
  return useQuery({ queryKey: ['outreach', 'metric-definitions'], staleTime: Infinity, queryFn: () => rpc<MetricDefinitions>('metric_definitions') });
}

export function useReportOverview(s: Scope, filters?: ReportFilters) {
  const f = clean(filters);
  return useQuery({ queryKey: rk(s.ws ?? '', 'overview', s.client ?? null, s.range, f), enabled: on(s), placeholderData: keepPreviousData, queryFn: () => rpc<OverviewReport>('report_overview', { ...base(s), p_filters: f }) });
}

export function useReportFunnel(s: Scope, filters?: FunnelFilters) {
  const f = clean(filters);
  return useQuery({ queryKey: rk(s.ws ?? '', 'funnel', s.client ?? null, s.range, f), enabled: on(s), placeholderData: keepPreviousData, queryFn: () => rpc<FunnelReport>('report_funnel', { ...base(s), p_filters: f }) });
}

export function useReportIntents(s: Scope, group: IntentGroup, filters?: ReportFilters) {
  const f = clean(filters);
  return useQuery({ queryKey: rk(s.ws ?? '', 'intents', s.client ?? null, s.range, group, f), enabled: on(s), placeholderData: keepPreviousData, queryFn: () => rpc<IntentsReport>('report_intents', { ...base(s), p_group: group, p_filters: f }) });
}

export function fetchReplyThreads(s: Scope, intent: IntentKey | null, filters?: ReportFilters): Promise<ReplyThread[]> {
  const f: Record<string, unknown> = clean(filters);
  if (filters?.variant_id === '') f.variant_id = '';   // '' means "the step's text without a variant", which is a real filter
  return rpc<ReplyThread[]>('report_reply_threads', { ...base(s), p_intent: intent, p_filters: f });
}

export function useReportSequences(s: Scope) {
  return useQuery({ queryKey: rk(s.ws ?? '', 'sequences', s.client ?? null, s.range), enabled: on(s), placeholderData: keepPreviousData, queryFn: () => rpc<SequenceRow[]>('report_sequences', base(s)) });
}

export function useReportSequence(sequenceId: string | null | undefined, range: DateRange) {
  return useQuery({ queryKey: ['outreach', 'reports', 'sequence', sequenceId ?? '', range], enabled: !!sequenceId && !validRange(range), queryFn: () => rpc<SequenceReport>('report_sequence', { p_sequence: sequenceId, p_from: range.from, p_to: range.to }) });
}

export function useReportSenders(s: Scope) {
  return useQuery({ queryKey: rk(s.ws ?? '', 'senders', s.client ?? null, s.range), enabled: on(s), placeholderData: keepPreviousData, queryFn: () => rpc<SenderRow[]>('report_senders', base(s)) });
}

export function useReportSender(senderId: string | null | undefined, range: DateRange) {
  return useQuery({ queryKey: ['outreach', 'reports', 'sender', senderId ?? '', range], enabled: !!senderId && !validRange(range), queryFn: () => rpc<SenderReport>('report_sender', { p_sender: senderId, p_from: range.from, p_to: range.to }) });
}

export function useReportClients(s: Omit<Scope, 'client'>) {
  return useQuery({ queryKey: rk(s.ws ?? '', 'clients', s.range), enabled: on(s), placeholderData: keepPreviousData, queryFn: () => rpc<ClientRow[]>('report_clients', { p_ws: s.ws, p_from: s.range.from, p_to: s.range.to }) });
}

export function useReportClient(clientId: string | null | undefined, range: DateRange) {
  return useQuery({ queryKey: ['outreach', 'reports', 'client', clientId ?? '', range], enabled: !!clientId && !validRange(range), placeholderData: keepPreviousData, refetchInterval: 60000, queryFn: () => rpc<ClientReport>('report_client', { p_client: clientId, p_from: range.from, p_to: range.to }) });
}

export function useReportCost(s: Scope) {
  return useQuery({ queryKey: rk(s.ws ?? '', 'cost', s.client ?? null, s.range), enabled: on(s), placeholderData: keepPreviousData, queryFn: () => rpc<CostReport>('report_cost', base(s)) });
}

export function usePromoteVariant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { sequenceId: string; nodeId: string; variantId: string }) => rpc<{ version: number; promoted: string }>('promote_variant', { p_sequence: v.sequenceId, p_node_id: v.nodeId, p_variant: v.variantId }),
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: ['outreach', 'reports', 'sequence', v.sequenceId] }); qc.invalidateQueries({ queryKey: qk.sequence(v.sequenceId) }); },
  });
}

export function useBranding(ws: string | null | undefined) {
  return useQuery({ queryKey: ['outreach', ws ?? '', 'branding'], enabled: !!ws, staleTime: 5 * 60_000, queryFn: async () => (await rpc<Branding | null>('branding', { p_ws: ws })) ?? {} });
}

/** Only values that are safe to put into a style attribute / an <img src>. */
export function safeAccent(v: string | null | undefined): string | null { return v && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : null; }
export function safeHttpsUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
}

// Dashboard: same RPC and query key as useDashboard() in queries.ts, typed with the keys 013 added.
export function useDashboardV2(ws: string | null | undefined) {
  return useQuery({ queryKey: qk.dashboard(ws ?? ''), enabled: !!ws, refetchInterval: 30000, queryFn: () => rpc<DashboardV2>('dashboard', { p_ws: ws }) });
}

/** Stall / running-dry / import alerts open and resolve in outreach_alerts; refresh the dashboard when they do. */
export function useAlertsRealtime(ws: string | null | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!ws) return;
    const ch = supabase.channel(`outreach-alerts:${ws}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'outreach_alerts', filter: `workspace_id=eq.${ws}` }, () => { qc.invalidateQueries({ queryKey: qk.dashboard(ws) }); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [ws, qc]);
}

// Saved ranges (own rows only, by RLS)
export function useSavedRanges(ws: string | null | undefined) {
  return useQuery({
    queryKey: rk(ws ?? '', 'saved-ranges'), enabled: !!ws,
    queryFn: async () => { const { data, error } = await supabase.from('outreach_saved_ranges').select('*').eq('workspace_id', ws!).order('created_at', { ascending: false }); if (error) throw parseError(error); return (data ?? []) as SavedRange[]; },
  });
}
export function useSaveRange(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; preset: PresetKey | null; range: DateRange }) => rpc<string>('save_range', { p_ws: ws, p_name: v.name, p_preset: v.preset, p_from: v.preset ? null : v.range.from, p_to: v.preset ? null : v.range.to }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rk(ws ?? '', 'saved-ranges') }),
  });
}
export function useDeleteRange(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => { const { error } = await supabase.from('outreach_saved_ranges').delete().eq('id', id); if (error) throw parseError(error); },
    onSuccess: () => qc.invalidateQueries({ queryKey: rk(ws ?? '', 'saved-ranges') }),
  });
}

// Report schedules (managers only, by RLS)
export function useReportSchedules(ws: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: rk(ws ?? '', 'schedules'), enabled: !!ws && enabled,
    queryFn: async () => { const { data, error } = await supabase.from('outreach_report_schedules').select('*').eq('workspace_id', ws!).order('created_at'); if (error) throw parseError(error); return (data ?? []) as ReportSchedule[]; },
  });
}
export type SchedulePatch = Partial<Pick<ReportSchedule, 'cadence' | 'recipients' | 'include_client_viewers' | 'active'>>;
export function useSaveSchedule(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    // The unique key is an expression index, so upsert is "update by id, else insert".
    mutationFn: async (v: { id?: string; kind: ScheduleKind; client_id: string | null; patch: SchedulePatch }) => {
      if (v.id) { const { error } = await supabase.from('outreach_report_schedules').update(v.patch).eq('id', v.id); if (error) throw parseError(error); return; }
      const { error } = await supabase.from('outreach_report_schedules').insert({ workspace_id: ws, kind: v.kind, client_id: v.client_id, ...v.patch });
      if (error) throw parseError(error);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: rk(ws ?? '', 'schedules') }),
  });
}
export function useDeleteSchedule(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => { const { error } = await supabase.from('outreach_report_schedules').delete().eq('id', id); if (error) throw parseError(error); },
    onSuccess: () => qc.invalidateQueries({ queryKey: rk(ws ?? '', 'schedules') }),
  });
}

export const MAX_INBOX_CHATS = 200;
/** The inbox honours `chats=` (comma separated ids) and shows `label` as the filter name. */
export function inboxThreadsHref(chatIds: string[], label: string): string {
  return `/outreach/inbox?chats=${chatIds.slice(0, MAX_INBOX_CHATS).join(',')}&label=${encodeURIComponent(label)}`;
}
