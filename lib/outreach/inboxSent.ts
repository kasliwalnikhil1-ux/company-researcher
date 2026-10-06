'use client';

/**
 * Replies / Sent in the inbox (inbox-replies-sent-PRD.md, migration 075).
 *
 * - Replies = conversations where the other person has written (`outreach_chats.first_inbound_at` set), with the chips
 *   All · Needs reply · Waiting on them. The list itself stays the PostgREST query in queries.ts (useChats).
 * - Sent = one row per thing we sent (`outreach_inbox_sent_list`), in three segments: Sent · Scheduled · Failed.
 * - Counts: `outreach_inbox_counts` → { replies_unread, needs_reply, scheduled, failed }, refetched every 60 s and on focus.
 *
 * Vocabulary (D5): Replies / Sent in the UI, direction in / out in data. Never "inbox" / "outbox".
 */
import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { callFn, rpc } from './api';
import { kv } from './storage';
import { downloadCsv, type CsvColumn } from './reports';
import type { Provider } from './types';

// --------------------------------------------------------------------------------------------- types
export type InboxView = 'replies' | 'sent';
export type ReplyChip = 'all' | 'needs_reply' | 'waiting_on_them';
export type SentSegment = 'sent' | 'scheduled' | 'failed';
export type SentChannel = 'LINKEDIN' | 'EMAIL' | 'WHATSAPP' | 'INSTAGRAM';
export type SentSource = 'sequence' | 'teammate' | 'ai' | 'outside_app';
export type SentType = 'connection_request' | 'message' | 'inmail' | 'email';
export type SentStatus = 'scheduled' | 'held' | 'sending' | 'sent' | 'delivered' | 'read' | 'accepted' | 'replied' | 'failed' | 'bounced';
/** Which source table query the row came from (see the view's comment in 075). */
export type SentSrc = 'message' | 'invite' | 'queued' | 'ai_hold' | 'failed' | 'bounce';

export interface SentItem {
  id: string;
  src: SentSrc;
  segment: SentSegment;
  /** Sent time, planned time or failure time. */
  at: string;
  status: SentStatus;
  /** Error code or hold cause (sender_reconnect | sender_paused | sequence_paused | allowance_used | hourly_allowance | waiting_slot | warmup_hold). */
  status_reason: string | null;
  /** Held / failed: the same wording as "Why isn't it sending" and the failed-leads list. */
  status_text: string | null;
  channel: SentChannel;
  type: SentType;
  action_type: string;
  source: SentSource;
  from_ai_draft: boolean;
  subject: string | null;
  /** First 140 characters. */
  preview: string;
  /** Full text (up to 8,000 characters): Copy text, Edit text. */
  body: string | null;
  deleted: boolean;
  edited: boolean;
  replied_at: string | null;
  chat_id: string | null;
  message_id: string | null;
  action_id: string | null;
  ai_reply_run_id: string | null;
  enrollment_id: string | null;
  enrollment_status: string | null;
  /** Failed sequence step whose lead is in the failed state: Retry / Skip / Remove apply. */
  recoverable: boolean | null;
  lead: { id: string | null; name: string | null; company: string | null; headline: string | null; picture_url: string | null } | null;
  sender: { id: string; name: string | null; provider: Provider | null; picture_url: string | null; status: string | null; identifier: string | null };
  sequence: { id: string; name: string | null; status: string | null } | null;
  step: { node_id: string; number: number | null; label: string | null; variant: string | null; variant_label: string | null } | null;
  sent_by: { id: string; name: string | null } | null;
}

export interface SentFilters {
  sender_ids: string[];
  my_senders: boolean;
  client_id: string | null;
  channel: SentChannel | null;
  source: SentSource | null;
  sequence_id: string | null;
  type: SentType | null;
  /** Sent only: got a reply yes / no. */
  replied: boolean | null;
  /** Date range preset (Sent and Failed). Scheduled always lists everything upcoming. */
  range: SentRange;
  /** custom range (ISO dates, inclusive) */
  from: string | null;
  to: string | null;
}
export type SentRange = '24h' | '7d' | '30d' | '90d' | 'custom';
export const SENT_RANGE_LABEL: Record<SentRange, string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', custom: 'Custom range' };

export const SENT_FILTER_DEFAULTS: SentFilters = {
  sender_ids: [], my_senders: false, client_id: null, channel: null, source: null, sequence_id: null, type: null, replied: null, range: '7d', from: null, to: null,
};

export interface InboxCounts { replies_unread: number; needs_reply: number; scheduled: number; failed: number; show_sent: boolean }
type SentPage = { items: SentItem[]; next_cursor: { at: string; id: string } | null; range?: { from: string; to: string } | null };

// --------------------------------------------------------------------------------------------- wording (§4.7)
export const VIEW_TOOLTIP: Record<InboxView, string> = {
  replies: 'Conversations where the other person has written.',
  sent: "Everything that went out from your senders, and what's about to.",
};
export const CHIP_LABEL: Record<ReplyChip, string> = { all: 'All', needs_reply: 'Needs reply', waiting_on_them: 'Waiting on them' };
export const CHIP_TOOLTIP: Record<ReplyChip, string> = {
  all: 'Every conversation where they have written, latest message first',
  needs_reply: 'Their message is the latest, the conversation is open and the AI is not answering it. Longest waiting first.',
  waiting_on_them: 'Our message is the latest',
};
export const SEGMENT_LABEL: Record<SentSegment, string> = { sent: 'Sent', scheduled: 'Scheduled', failed: 'Failed' };
export const SEGMENT_TOOLTIP: Record<SentSegment, string> = {
  sent: 'Everything that went out, newest first',
  scheduled: 'Sends with a planned time that have not gone out yet, soonest first',
  failed: "Sends that didn't go out, and emails that bounced",
};
export const SENT_EMPTY: Record<SentSegment, string> = {
  sent: 'Nothing sent in this period.',
  scheduled: 'Nothing is scheduled to go out.',
  failed: 'No failed sends.',
};
export const TYPE_LABEL: Record<SentType, string> = { connection_request: 'Connection request', message: 'Message', inmail: 'InMail', email: 'Email' };
export const SOURCE_LABEL: Record<SentSource, string> = { sequence: 'Sequence', teammate: 'Teammate', ai: 'AI reply', outside_app: 'Outside the app' };
export const CHANNEL_LABEL: Record<SentChannel, string> = { LINKEDIN: 'LinkedIn', EMAIL: 'Email', WHATSAPP: 'WhatsApp', INSTAGRAM: 'Instagram' };

/** One status per row, the furthest reached. */
export function statusLabel(it: Pick<SentItem, 'status' | 'at'>, tz?: string | null): string {
  switch (it.status) {
    case 'scheduled': return `Scheduled · ${fmtTime(it.at, tz)}`;
    case 'held': return 'Held';
    case 'sending': return 'Sending';
    case 'sent': return 'Sent';
    case 'delivered': return 'Delivered';
    case 'read': return 'Read';
    case 'accepted': return 'Accepted';
    case 'replied': return 'Replied';
    case 'failed': return 'Failed';
    case 'bounced': return 'Bounced';
  }
}

export const STATUS_TONE: Record<SentStatus, string> = {
  scheduled: 'bg-sky-50 text-sky-700 border-sky-100',
  held: 'bg-amber-50 text-amber-800 border-amber-200',
  sending: 'bg-indigo-50 text-indigo-700 border-indigo-100',
  sent: 'bg-gray-50 text-gray-600 border-gray-200',
  delivered: 'bg-gray-50 text-gray-700 border-gray-200',
  read: 'bg-gray-50 text-gray-800 border-gray-200',
  accepted: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  replied: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  failed: 'bg-rose-50 text-rose-700 border-rose-200',
  bounced: 'bg-rose-50 text-rose-700 border-rose-200',
};

/** "Fintech CFOs · Step 2 · B" / "Sent by Naman" / "AI reply" / "Sent from LinkedIn" (§4.3, where it came from). */
export function sourceLine(it: SentItem): string {
  if (it.source === 'sequence') {
    const parts = [it.sequence?.name ?? 'Sequence'];
    if (it.step?.number) parts.push(`Step ${it.step.number}`);
    else if (it.step?.label) parts.push(it.step.label);
    const v = it.step?.variant_label ?? it.step?.variant;
    if (v) parts.push(v.length <= 3 ? v.toUpperCase() : v);
    return parts.join(' · ');
  }
  if (it.source === 'teammate') return it.sent_by?.name ? `Sent by ${it.sent_by.name}` : 'Sent by a teammate';
  if (it.source === 'ai') return 'AI reply';
  if (it.channel === 'LINKEDIN') return 'Sent from LinkedIn';
  if (it.channel === 'EMAIL') return 'Sent from the mailbox';
  return 'Sent from phone or another app';
}

/** Type label shown before the text when it isn't a plain message. */
export function typePrefix(it: SentItem): string | null {
  if (it.type === 'connection_request') return 'Connection request';
  if (it.type === 'inmail') return 'InMail';
  return null;
}

export function fmtTime(iso: string | null | undefined, tz?: string | null): string {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) }); } catch { return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
}

/** Day key in the workspace timezone (YYYY-MM-DD) for the day groups. */
export function dayKey(iso: string, tz?: string | null): string {
  try { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(tz ? { timeZone: tz } : {}) }).format(new Date(iso)); } catch { return iso.slice(0, 10); }
}

export function dayLabel(key: string, tz?: string | null): string {
  const today = dayKey(new Date().toISOString(), tz);
  const tomorrow = dayKey(new Date(Date.now() + 86_400_000).toISOString(), tz);
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString(), tz);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  if (key === tomorrow) return 'Tomorrow';
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(y !== new Date().getFullYear() ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

export function waitingFor(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const mins = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (mins < 60) return `waiting ${Math.max(1, mins)} min`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `waiting ${h} h`;
  return `waiting ${Math.floor(h / 24)} d`;
}

// --------------------------------------------------------------------------------------------- filters → RPC args
export function rangeBounds(f: Pick<SentFilters, 'range' | 'from' | 'to'>, now = Date.now()): { from: string; to: string } {
  const to = new Date(now + 60_000);
  if (f.range === 'custom' && f.from) {
    const from = new Date(`${f.from}T00:00:00`);
    const end = f.to ? new Date(`${f.to}T00:00:00`) : new Date(now);
    end.setDate(end.getDate() + 1);
    return { from: from.toISOString(), to: (end.getTime() > to.getTime() ? to : end).toISOString() };
  }
  const days = f.range === '24h' ? 1 : f.range === '30d' ? 30 : f.range === '90d' ? 90 : 7;
  return { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() };
}

/** Rounded to the minute so the query key (and the cache) stays put between renders. */
function rpcFilters(segment: SentSegment, f: SentFilters, search: string, leadId?: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.sender_ids.length) out.sender_ids = f.sender_ids;
  if (f.my_senders) out.my_senders = true;
  if (f.client_id) out.client_id = f.client_id;
  if (f.channel) out.channel = f.channel;
  if (f.source) out.source = f.source;
  if (f.sequence_id) out.sequence_id = f.sequence_id;
  if (f.type) out.type = f.type;
  if (segment === 'sent' && f.replied != null) out.replied = f.replied;
  if (segment !== 'scheduled') {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    Object.assign(out, rangeBounds(f, minute));
  }
  if (search.trim().length >= 2) out.search = search.trim();
  if (leadId) out.lead_id = leadId;
  return out;
}

export function sentFiltersActive(f: SentFilters): number {
  return [f.sender_ids.length > 0, f.my_senders, f.client_id, f.channel, f.source, f.sequence_id, f.type, f.replied != null].filter(Boolean).length;
}

export function sanitizeSentFilters(raw: unknown, d: SentFilters): SentFilters {
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const oneOf = <T extends string>(v: unknown, xs: readonly T[]) => (typeof v === 'string' && (xs as readonly string[]).includes(v) ? (v as T) : null);
  // the app's Sender filter is one dropdown, like Replies: one sender or all. "My senders" and multi-pick stay API-only,
  // so a saved state from the older picker keeps its first sender and drops "My senders"
  const ids = Array.isArray(r.sender_ids) ? r.sender_ids.filter((x): x is string => typeof x === 'string') : [];
  return {
    sender_ids: ids.slice(0, 1),
    my_senders: false,
    client_id: str(r.client_id),
    channel: oneOf(r.channel, ['LINKEDIN', 'EMAIL', 'WHATSAPP', 'INSTAGRAM'] as const),
    source: oneOf(r.source, ['sequence', 'teammate', 'ai', 'outside_app'] as const),
    sequence_id: str(r.sequence_id),
    type: oneOf(r.type, ['connection_request', 'message', 'inmail', 'email'] as const),
    replied: typeof r.replied === 'boolean' ? r.replied : null,
    range: oneOf(r.range, ['24h', '7d', '30d', '90d', 'custom'] as const) ?? '7d',
    from: str(r.from), to: str(r.to),
  };
}

// --------------------------------------------------------------------------------------------- queries
export const sentKeys = {
  all: (ws: string) => ['outreach', ws, 'sent'] as const,
  list: (ws: string, segment: SentSegment, f: unknown) => ['outreach', ws, 'sent', segment, f] as const,
  counts: (ws: string, f: unknown) => ['outreach', ws, 'inbox-counts', f] as const,
};

/** Sent list, page by page (keyset cursor). Refetched every 60 s and on window focus (§6). */
export function useSentList(ws: string | null | undefined, segment: SentSegment, f: SentFilters, search: string, opts?: { enabled?: boolean; leadId?: string | null; limit?: number }) {
  const args = rpcFilters(segment, f, search, opts?.leadId);
  const limit = opts?.limit ?? 50;
  return useInfiniteQuery({
    queryKey: sentKeys.list(ws ?? '', segment, { args, limit }),
    enabled: !!ws && (opts?.enabled ?? true),
    placeholderData: (prev) => prev,
    initialPageParam: null as SentPage['next_cursor'],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: ({ pageParam }) => rpc<SentPage>('inbox_sent_list', { p_ws: ws, p_segment: segment, p_filters: args, p_cursor: pageParam, p_limit: limit }),
    getNextPageParam: (last: SentPage) => last.next_cursor ?? undefined,
    select: (d: InfiniteData<SentPage, SentPage['next_cursor']>) => {
      const seen = new Set<string>();
      const out: SentItem[] = [];
      for (const p of d.pages) for (const r of p.items ?? []) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
      return out;
    },
  });
}

/** Top sends matching the search box (the "Sent" group under the conversation results, §4.6). */
export function useSentSearch(ws: string | null | undefined, search: string, enabled = true) {
  const q = search.trim();
  return useQuery({
    queryKey: sentKeys.list(ws ?? '', 'sent', { search: q, top: 5 }),
    enabled: !!ws && enabled && q.length >= 2,
    staleTime: 30_000,
    queryFn: () => rpc<SentPage>('inbox_sent_list', { p_ws: ws, p_segment: 'sent', p_filters: { search: q, ...rangeBounds({ range: '90d', from: null, to: null }, Math.floor(Date.now() / 60_000) * 60_000) }, p_cursor: null, p_limit: 6 }),
  });
}

export function useInboxCounts(ws: string | null | undefined, f: { assigned_to?: string | null; sender_id?: string | null; client_id?: string | null; provider?: string | null }) {
  const args = { assigned_to: f.assigned_to ?? null, sender_id: f.sender_id ?? null, client_id: f.client_id ?? null, provider: f.provider ?? null };
  return useQuery({
    queryKey: sentKeys.counts(ws ?? '', args), enabled: !!ws,
    refetchInterval: 60_000, refetchOnWindowFocus: true, staleTime: 15_000,
    queryFn: () => rpc<InboxCounts>('inbox_counts', { p_ws: ws, p_filters: args }),
  });
}

/** After any Sent action: the lists, the counts and the conversation lists refresh. */
export function useInvalidateSent(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useCallback(() => {
    if (!ws) return;
    qc.invalidateQueries({ queryKey: sentKeys.all(ws) });
    qc.invalidateQueries({ queryKey: ['outreach', ws, 'inbox-counts'] });
    qc.invalidateQueries({ queryKey: ['outreach', ws, 'chats'] });
  }, [qc, ws]);
}

// --------------------------------------------------------------------------------------------- row actions
// Every action calls the function that already exists for it (§4.3): Sent adds no new way to change a send.
export type SentAction =
  | { kind: 'edit_text'; item: SentItem; text: string; subject?: string | null }
  | { kind: 'pause_lead'; items: SentItem[] }
  | { kind: 'remove_from_sequence'; items: SentItem[] }
  | { kind: 'retry' | 'skip' | 'remove_failed'; items: SentItem[] }
  | { kind: 'ai_send_now'; item: SentItem }
  | { kind: 'ai_cancel'; item: SentItem; reason: string; note?: string | null };

export type SentActionResult = { done: number; refused: Array<{ id: string; reason: string }> };

export function useSentAction(ws: string | null | undefined) {
  const invalidate = useInvalidateSent(ws);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: SentAction): Promise<SentActionResult> => {
      if (a.kind === 'edit_text') {
        if (!a.item.action_id) throw new Error('Nothing to edit');
        const ok = await rpc<boolean>('set_action_text', { p_action: a.item.action_id, p_text: a.text, p_subject: a.subject ?? null });
        if (!ok) throw new Error('This step is already going out, so its text can no longer change.');
        return { done: 1, refused: [] };
      }
      if (a.kind === 'ai_send_now') {
        if (!a.item.ai_reply_run_id) throw new Error('Nothing to send');
        await callFn('ai-reply', { action: 'send_now', run_id: a.item.ai_reply_run_id });
        return { done: 1, refused: [] };
      }
      if (a.kind === 'ai_cancel') {
        if (!a.item.ai_reply_run_id) throw new Error('Nothing to cancel');
        await rpc('ai_reply_cancel', { p_run: a.item.ai_reply_run_id, p_reason: a.reason, p_note: a.note ?? null });
        return { done: 1, refused: [] };
      }
      const enrollments = uniqueEnrollments(a.items);
      if (!enrollments.length) throw new Error('None of these rows belongs to a sequence lead');
      if (a.kind === 'pause_lead' || a.kind === 'remove_from_sequence') {
        const refused: SentActionResult['refused'] = [];
        let done = 0;
        for (const id of enrollments) {
          try {
            await rpc(a.kind === 'pause_lead' ? 'pause_enrollment' : 'exit_enrollment', a.kind === 'pause_lead' ? { p_id: id } : { p_id: id, p_reason: 'manual' });
            done++;
          } catch (e) { refused.push({ id, reason: e instanceof Error ? e.message : String(e) }); }
        }
        return { done, refused };
      }
      const action = a.kind === 'retry' ? 'retry' : a.kind === 'skip' ? 'skip' : 'exit';
      const r = await rpc<{ done: number; refused: Array<{ id: string; reason: string }> }>('enrollment_recover', { p_enrollment_ids: enrollments, p_action: action });
      return { done: r?.done ?? 0, refused: r?.refused ?? [] };
    },
    onSettled: (_r, _e, a) => {
      invalidate();
      if ('item' in a && a.item.chat_id) { qc.invalidateQueries({ queryKey: ['outreach', 'chat', a.item.chat_id] }); }
      qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
    },
  });
}

export function uniqueEnrollments(items: SentItem[]): string[] {
  return [...new Set(items.map((i) => i.enrollment_id).filter((x): x is string => !!x))];
}

/** Why a recovery refused a lead, in plain words (outreach_enrollment_recover reasons). */
export const REFUSED_LABEL: Record<string, string> = {
  not_found: 'not visible to you',
  not_failed: 'no longer failed',
  lead_suppressed: 'on a do-not-contact list',
  profile_invalid: 'profile cannot be reached',
  already_enrolled_again: 'already in a sequence again',
  sender_gone: 'its sender was removed',
};

// --------------------------------------------------------------------------------------------- remembered view
/** The person's last view / chip / segment, per workspace in this browser (§4.1). */
export interface InboxViewState { view: InboxView; chip: ReplyChip; segment: SentSegment }
const VIEW_DEFAULTS: InboxViewState = { view: 'replies', chip: 'all', segment: 'sent' };
const viewKey = (ws: string) => `outreach-inbox-view:${ws}`;

export function readInboxViewState(ws: string | null | undefined): InboxViewState {
  if (!ws || typeof window === 'undefined') return VIEW_DEFAULTS;
  try {
    const raw = JSON.parse(kv.getItem(viewKey(ws)) ?? 'null') as Partial<InboxViewState> | null;
    if (!raw) return VIEW_DEFAULTS;
    return {
      view: raw.view === 'sent' ? 'sent' : 'replies',
      chip: raw.chip === 'needs_reply' || raw.chip === 'waiting_on_them' ? raw.chip : 'all',
      segment: raw.segment === 'scheduled' || raw.segment === 'failed' ? raw.segment : 'sent',
    };
  } catch { return VIEW_DEFAULTS; }
}

export function writeInboxViewState(ws: string | null | undefined, patch: Partial<InboxViewState>): void {
  if (!ws) return;
  try { kv.setItem(viewKey(ws), JSON.stringify({ ...readInboxViewState(ws), ...patch })); } catch { /* storage unavailable */ }
}

// --------------------------------------------------------------------------------------------- CSV export (managers)
export async function exportSentCsv(ws: string, segment: SentSegment, f: SentFilters, search: string, tz?: string | null, maxRows = 10_000): Promise<number> {
  const args = rpcFilters(segment, f, search);
  const rows: SentItem[] = [];
  let cursor: SentPage['next_cursor'] = null;
  do {
    const page: SentPage = await rpc<SentPage>('inbox_sent_list', { p_ws: ws, p_segment: segment, p_filters: args, p_cursor: cursor, p_limit: 100 });
    rows.push(...(page.items ?? []));
    cursor = page.next_cursor;
  } while (cursor && rows.length < maxRows);
  const when = (iso: string) => { try { return new Date(iso).toLocaleString('sv-SE', tz ? { timeZone: tz } : {}); } catch { return iso; } };
  const columns: Array<CsvColumn<SentItem>> = [
    { header: 'To', value: (r) => r.lead?.name ?? '' },
    { header: 'Company', value: (r) => r.lead?.company ?? '' },
    { header: 'Type', value: (r) => TYPE_LABEL[r.type] },
    { header: 'Subject', value: (r) => r.subject ?? '' },
    { header: 'What', value: (r) => r.preview },
    { header: 'Where it came from', value: (r) => sourceLine(r) },
    { header: 'From', value: (r) => r.sender.name ?? '' },
    { header: 'Channel', value: (r) => CHANNEL_LABEL[r.channel] ?? r.channel },
    { header: 'Status', value: (r) => statusLabel(r, tz) },
    { header: 'Reason', value: (r) => r.status_text ?? '' },
    { header: segment === 'scheduled' ? 'Planned for' : segment === 'failed' ? 'Failed at' : 'Sent at', value: (r) => when(r.at) },
  ];
  const stamp = new Date().toISOString().slice(0, 10);
  downloadCsv(`outreach_sent_${segment}_${stamp}.csv`, columns, rows.slice(0, maxRows));
  return Math.min(rows.length, maxRows);
}
