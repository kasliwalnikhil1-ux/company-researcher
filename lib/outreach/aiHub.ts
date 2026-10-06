'use client';

// AI hub (ai-hub-unified-ui-changes.md, as built: docs/outreach/AI-HUB.md): one home for every AI feature.
// This file is the shared layer of the hub: the feature names, the three modes, the two views (Needs you, Activity)
// and one hook per outreach_hub_* RPC of migration 063.
//
//   Names   AI replies · Personalized lines · Step drafts · Website agents · Profile drafts
//   Modes   Off · Review · Auto, the same three words everywhere. Storage is unchanged underneath:
//           AI replies      off | draft (= Review) | autopilot (= Auto)            outreach_sequence_reply_settings.mode
//           Lines           off | review                                           outreach_ai_variables.mode
//           Website         ai_enabled false (= Off) | ai.mode 'review' | 'first' (= Auto · Always) | 'offline_only' (= Auto · Outside hours)
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { db } from '@/lib/outreach/backend';
import { callFn, parseError, rpc } from './api';
import { ESCALATION_LABEL, GATE_LABEL, type ReplyMode } from './aiReplies';
import type { AiFieldValue } from './types';
import type { CatalogueState, ProductCard } from './catalogue';

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------
export const AI_HUB_PATH = '/outreach/ai';
/** `blurb` is the one line shown under the tab bar while that tab is open (as on Settings). */
export const HUB_TABS = [
  { key: 'needs-you', label: 'Needs you', href: `${AI_HUB_PATH}/needs-you`, blurb: 'What the AI wrote that a person has to approve before it goes out.' },
  { key: 'activity', label: 'Activity', href: `${AI_HUB_PATH}/activity`, blurb: 'Everything the AI wrote, including what went out on its own.' },
  { key: 'knowledge', label: 'Knowledge', href: `${AI_HUB_PATH}/knowledge`, blurb: 'The websites, documents, Q&A and product catalogues the AI answers from.' },
  { key: 'setup', label: 'Setup', href: `${AI_HUB_PATH}/setup`, blurb: 'Switch each AI feature Off, to Review or to Auto, and see what it wrote this week.' },
] as const;
export type HubTab = typeof HUB_TABS[number]['key'];

const qs = (o: Record<string, string | null | undefined | false>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
export const hubHref = {
  needsYou: (f: { type?: NeedsYouType | null; where?: string | null; mine?: boolean } = {}) => `${AI_HUB_PATH}/needs-you${qs({ type: f.type, where: f.where, mine: f.mine === false ? 'all' : null })}`,
  activity: (f: { feature?: AiFeature | null; where?: string | null } = {}) => `${AI_HUB_PATH}/activity${qs({ feature: f.feature, where: f.where })}`,
  knowledge: (view?: 'sources' | 'qa' | null) => `${AI_HUB_PATH}/knowledge${qs({ view: view === 'sources' ? null : view })}`,
  setup: () => `${AI_HUB_PATH}/setup`,
  setupReplies: (tab?: 'sequences' | 'reports' | null) => `${AI_HUB_PATH}/setup/replies${qs({ tab: tab === 'sequences' ? null : tab })}`,
  setupLines: (view?: 'variables' | 'lines' | null) => `${AI_HUB_PATH}/setup/lines${qs({ view: view === 'variables' ? null : view })}`,
  setupLine: (variableId: string) => `${AI_HUB_PATH}/setup/lines/${variableId}`,
  setupWebsite: () => `${AI_HUB_PATH}/setup/website`,
  setupGeneral: () => `${AI_HUB_PATH}/setup/general`,
};

// ---------------------------------------------------------------------------------------------------------------
// Names and modes
// ---------------------------------------------------------------------------------------------------------------
export type AiFeature = 'reply' | 'line' | 'draft' | 'website' | 'profile';
export const AI_FEATURES: AiFeature[] = ['reply', 'line', 'draft', 'website', 'profile'];
/** The feature's name (cards, filters, settings). */
export const FEATURE_LABEL: Record<AiFeature, string> = { reply: 'AI replies', line: 'Personalized lines', draft: 'Step drafts', website: 'Website Agents', profile: 'Profile drafts' };
/** One output of the feature (the Feature column of Activity, the type on a card). */
export const FEATURE_ONE: Record<AiFeature, string> = { reply: 'AI reply', line: 'Personalization', draft: 'Step draft', website: 'Website', profile: 'Profile' };
export const FEATURE_HELP: Record<AiFeature, string> = {
  reply: 'Answers prospects who reply to a sequence.',
  line: 'One AI-written line per lead, used in a message as {{ai.key|fallback}}.',
  draft: 'A sequence step whose message the AI writes and a person approves.',
  website: 'Answers visitors in the chat on your website.',
  profile: 'Headline and About drafts for a sender’s LinkedIn profile.',
};

export type HubMode = 'off' | 'review' | 'auto';
export const HUB_MODES: HubMode[] = ['off', 'review', 'auto'];
export const HUB_MODE_LABEL: Record<HubMode, string> = { off: 'Off', review: 'Review', auto: 'Auto' };

export const MODE_LINE: Record<'reply' | 'line' | 'website', Record<HubMode, string>> = {
  reply: {
    off: 'Nothing happens when a prospect replies.',
    review: 'The AI drafts every reply. A person sends it.',
    auto: 'The AI sends its reply after a short hold. Anything it should not answer comes to Needs you.',
  },
  line: {
    off: 'No new lines are written. Lines already approved keep being used.',
    review: 'A person approves each line before a message can use it.',
    auto: 'Not available yet: a person approves every line.',
  },
  website: {
    off: 'Visitors chat with your team only.',
    review: 'The AI suggests an answer to your agent. The visitor waits for a person.',
    auto: 'The AI answers the visitor and hands over to a person when it should.',
  },
};

export const replyToHubMode = (m: ReplyMode | null | undefined): HubMode => (m === 'autopilot' ? 'auto' : m === 'off' ? 'off' : 'review');
export const hubToReplyMode = (m: HubMode): ReplyMode => (m === 'auto' ? 'autopilot' : m === 'off' ? 'off' : 'draft');

export type WebsiteWhen = 'always' | 'outside_hours';
export const WEBSITE_WHEN_LABEL: Record<WebsiteWhen, string> = { always: 'Always', outside_hours: 'Outside business hours' };
/** Stored website settings → the hub's mode. `mode` is settings.ai.mode: off | first | offline_only | review. */
export function websiteHubMode(w: { ai_enabled: boolean; mode: string | null | undefined }): { mode: HubMode; when: WebsiteWhen } {
  const when: WebsiteWhen = w.mode === 'offline_only' ? 'outside_hours' : 'always';
  if (!w.ai_enabled || !w.mode || w.mode === 'off') return { mode: 'off', when };
  return { mode: w.mode === 'review' ? 'review' : 'auto', when };
}
export function websiteModeText(w: { ai_enabled: boolean; mode: string | null | undefined }): string {
  const m = websiteHubMode(w);
  return m.mode === 'auto' ? `Auto · ${WEBSITE_WHEN_LABEL[m.when].toLowerCase()}` : HUB_MODE_LABEL[m.mode];
}

// ---------------------------------------------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------------------------------------------
export type NeedsYouType = 'reply' | 'line' | 'draft' | 'website' | 'question' | 'profile';
export const NEEDS_YOU_TYPES: NeedsYouType[] = ['reply', 'line', 'draft', 'website', 'question', 'profile'];
export const NEEDS_YOU_TYPE_LABEL: Record<NeedsYouType, string> = { reply: 'AI replies', line: 'Personalizations', draft: 'Step drafts', website: 'Website', question: 'Questions', profile: 'Profile' };
export const NEEDS_YOU_TYPE_ONE: Record<NeedsYouType, string> = { reply: 'AI reply', line: 'Personalization', draft: 'Step draft', website: 'Website', question: 'Question', profile: 'Profile' };
export const isNeedsYouType = (v: unknown): v is NeedsYouType => typeof v === 'string' && (NEEDS_YOU_TYPES as string[]).includes(v);
export const isAiFeature = (v: unknown): v is AiFeature => typeof v === 'string' && (AI_FEATURES as string[]).includes(v);

export interface NeedsYouRow {
  id: string; workspace_id: string; type: NeedsYouType;
  /** reply: review | escalated | no_reply | warmup · draft: review | drafting | no_draft · the rest: review / open */
  state: string;
  where_kind: 'sequence' | 'variable' | 'website' | 'sender' | null; where_id: string | null; where_name: string | null;
  who_kind: 'lead' | 'visitor' | 'sender' | null; who_id: string | null; who_name: string | null; who_detail: string | null;
  trigger_text: string | null; ai_text: string | null;
  /** A code: review | warmup | no_reply | low_confidence | drafting | no_draft | unanswered | an escalation reason | a gate. */
  reason: string | null;
  assignee_id: string | null; created_at: string;
  chat_id: string | null; lead_id: string | null; send_at: string | null; priority: number;
  meta: Record<string, unknown>;
}
export interface NeedsYouCounts { total: number; reply: number; line: number; draft: number; website: number; question: number; profile: number }
export const EMPTY_COUNTS: NeedsYouCounts = { total: 0, reply: 0, line: 0, draft: 0, website: 0, question: 0, profile: 0 };
export interface NeedsYouFilters { type: NeedsYouType | null; where: string | null; mine: boolean }

/** The rule shown in the empty state of Needs you and of Tasks. */
export const NEEDS_YOU_RULE = 'Needs you = approve something the AI wrote. Tasks = something you do yourself.';

// Why a card waits. The states of the hub are worded here; a reply's escalation reason or gate uses the reply engine's
// own labels (the same words the inbox shows).
const REASON_TEXT: Record<string, string> = {
  review: 'Review mode: a person sends every reply',
  warmup: 'Warm-up: the AI sends this by itself unless you step in',
  no_reply: 'The AI suggests not replying',
  escalated: 'The AI thinks a person should answer this one',
  low_confidence: 'The AI is not sure: your knowledge does not cover this',
  drafting: 'The AI is still writing this draft',
  no_draft: 'No draft arrived. Write the message yourself',
  unanswered: 'The AI could not answer this',
  taken_manual: 'A teammate took this reply over to edit it',
  human_sending: 'A teammate is sending this reply',
};
const humanizeCode = (code: string) => { const s = code.replace(/_/g, ' ').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; };
const replyReasonText = (code: string) => ESCALATION_LABEL[code] ?? GATE_LABEL[code] ?? REASON_TEXT[code] ?? humanizeCode(code);

/** One line saying why a card is waiting. */
export function needsYouReason(row: Pick<NeedsYouRow, 'type' | 'state' | 'reason' | 'meta' | 'send_at'>): string {
  const code = row.reason ?? '';
  if (row.type === 'line') return 'Waiting for someone to approve it';
  if (row.type === 'question') {
    const n = Number(row.meta?.count_total ?? 1);
    return `Asked ${n === 1 ? 'once' : `${n.toLocaleString()} times`} · ${originsText(row.meta?.origins)}`;
  }
  if (row.type === 'profile') return `AI draft of the ${row.meta?.field === 'headline' ? 'headline' : 'About section'}, not applied yet`;
  if (row.type === 'website') return code === 'low_confidence' ? REASON_TEXT.low_confidence : 'Review mode: the visitor is waiting for a person';
  if (row.type === 'draft') return code === 'review' ? 'The lead waits at this step until someone approves the message' : REASON_TEXT[code] ?? humanizeCode(code);
  if (row.state === 'warmup' && row.send_at) {
    const t = new Date(row.send_at);
    if (!Number.isNaN(t.getTime())) return `Warm-up: the AI sends this at ${t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} unless you step in`;
  }
  if (row.state === 'review' && code && code !== 'review') return `${replyReasonText(code)}: a person sends this reply`;
  if (row.state === 'escalated') return code && code !== 'escalated' ? replyReasonText(code) : REASON_TEXT.escalated;
  return REASON_TEXT[code] ?? (code ? replyReasonText(code) : REASON_TEXT.review);
}
export function originsText(origins: unknown): string {
  const o = Array.isArray(origins) ? origins.map(String) : [];
  const names = [o.includes('reply') ? 'AI replies' : null, o.includes('website') ? 'Website' : null].filter(Boolean);
  return names.length ? names.join(' + ') : 'AI replies';
}
/** "Priya Nair (Razorpay)", "Visitor (Mumbai)". */
export const whoText = (r: { who_name: string | null; who_detail: string | null }) => (r.who_name ? `${r.who_name}${r.who_detail ? ` (${r.who_detail})` : ''}` : '');
/** Where a card's "who" opens: the lead, the web chat, or the sender's profile. */
export function whoHref(r: { who_kind: string | null; who_id: string | null; chat_id: string | null }): string | null {
  if (r.who_kind === 'lead' && r.who_id) return `/outreach/leads/${r.who_id}`;
  if (r.who_kind === 'visitor' && r.chat_id) return `/outreach/inbox/${r.chat_id}`;
  if (r.who_kind === 'sender' && r.who_id) return `/outreach/senders/${r.who_id}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------------------------
export interface AiOutputRow {
  id: string; workspace_id: string; feature: AiFeature; created_at: string;
  where_kind: 'sequence' | 'variable' | 'website' | 'sender' | null; where_id: string | null; where_name: string | null;
  who_kind: 'lead' | 'visitor' | 'sender' | null; who_id: string | null; who_name: string | null; who_detail: string | null;
  text: string; chat_id: string | null;
}
export type ActivityRange = 'today' | '7' | '30' | '90' | 'custom';
export const ACTIVITY_RANGES: Array<{ id: ActivityRange; label: string }> = [
  { id: 'today', label: 'Today' }, { id: '7', label: 'Last 7 days' }, { id: '30', label: 'Last 30 days' }, { id: '90', label: 'Last 90 days' }, { id: 'custom', label: 'Custom dates' },
];
export interface ActivityFilters { feature: AiFeature | null; where: string | null; range: ActivityRange; from: string; to: string; q: string }
export const ACTIVITY_DEFAULTS: ActivityFilters = { feature: null, where: null, range: '7', from: '', to: '', q: '' };

/** Start / end instants of a filter (local days). `null` end = up to now. */
export function activityWindow(f: Pick<ActivityFilters, 'range' | 'from' | 'to'>): { from: string | null; to: string | null } {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  if (f.range === 'custom') {
    const a = /^\d{4}-\d{2}-\d{2}$/.test(f.from) ? new Date(`${f.from}T00:00:00`) : null;
    const b = /^\d{4}-\d{2}-\d{2}$/.test(f.to) ? new Date(`${f.to}T00:00:00`) : null;
    if (b) b.setDate(b.getDate() + 1);   // the end day is included
    return { from: a && !Number.isNaN(a.getTime()) ? a.toISOString() : null, to: b && !Number.isNaN(b.getTime()) ? b.toISOString() : null };
  }
  const start = day(now);
  if (f.range !== 'today') start.setDate(start.getDate() - (Number(f.range) - 1));
  return { from: start.toISOString(), to: null };
}
/** A search string as an ILIKE pattern: the user's % and _ are literal. */
export const likePattern = (q: string) => `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---------------------------------------------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------------------------------------------
export const hk = {
  all: (ws: string) => ['outreach', ws, 'ai-hub'] as const,
  counts: (ws: string, mine: boolean) => ['outreach', ws, 'ai-hub', 'counts', mine] as const,
  needsYou: (ws: string, f: unknown) => ['outreach', ws, 'ai-hub', 'needs-you', f] as const,
  activity: (ws: string, f: unknown) => ['outreach', ws, 'ai-hub', 'activity', f] as const,
  setup: (ws: string) => ['outreach', ws, 'ai-hub', 'setup'] as const,
  knowledge: (ws: string) => ['outreach', ws, 'ai-hub', 'knowledge'] as const,
  qa: (ws: string) => ['outreach', ws, 'ai-hub', 'qa'] as const,
  suggestion: (chatId: string) => ['outreach', 'chat', chatId, 'webchat-suggestion'] as const,
};

/** Everything of the hub is stale after an action on a card: lists, counts and the Setup numbers. */
export function useInvalidateHub(ws: string | null | undefined) {
  const qc = useQueryClient();
  return () => {
    if (!ws) return;
    qc.invalidateQueries({ queryKey: hk.all(ws) });
    qc.invalidateQueries({ queryKey: ['outreach', ws, 'dashboard'] });
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Needs you: counts (page header + sidebar badge) and the list
// ---------------------------------------------------------------------------------------------------------------
/** Refetched every 60 s and when the window gets focus (PRD §4.2); no Realtime channel. */
export function useNeedsYouCounts(ws: string | null | undefined, mine = true, enabled = true) {
  return useQuery({
    queryKey: hk.counts(ws ?? '', mine), enabled: !!ws && enabled, refetchInterval: 60_000, refetchOnWindowFocus: true, retry: 0,
    queryFn: async () => ({ ...EMPTY_COUNTS, ...((await rpc<Partial<NeedsYouCounts>>('hub_needs_you_counts', { p_ws: ws, p_mine: mine })) ?? {}) }) as NeedsYouCounts,
  });
}

export const NEEDS_YOU_PAGE = 50;
/** Cards, oldest first within the filter; a live website suggestion always on top (the view's `priority`). */
export function useNeedsYou(ws: string | null | undefined, f: NeedsYouFilters, userId: string | null | undefined, enabled = true) {
  return useInfiniteQuery({
    queryKey: hk.needsYou(ws ?? '', { ...f, userId: f.mine ? userId : null }), enabled: !!ws && enabled && (!f.mine || !!userId),
    initialPageParam: 0, refetchInterval: 60_000, refetchOnWindowFocus: true,
    queryFn: async ({ pageParam }) => {
      let q = db.from('outreach_ai_needs_you').select('*').eq('workspace_id', ws!);
      if (f.type) q = q.eq('type', f.type);
      if (f.where) q = q.eq('where_id', f.where);
      if (f.mine && userId) q = q.or(`assignee_id.is.null,assignee_id.eq.${userId}`);
      const from = Number(pageParam) * NEEDS_YOU_PAGE;
      const { data, error } = await q.order('priority').order('created_at').order('id').range(from, from + NEEDS_YOU_PAGE - 1);
      if (error) throw parseError(error);
      return (data ?? []) as NeedsYouRow[];
    },
    getNextPageParam: (last, pages) => (last.length === NEEDS_YOU_PAGE ? pages.length : undefined),
  });
}

/**
 * The photos of the "who" on a page of cards (the view carries none): the lead's picture, else the chat's attendee
 * picture, and the sender's picture on a Profile card. Keyed by `cardKey`; a card without a photo is left out.
 */
export function useNeedsYouPictures(ws: string | null | undefined, rows: NeedsYouRow[]) {
  const ids = (pick: (r: NeedsYouRow) => string | null) => [...new Set(rows.map(pick).filter((v): v is string => !!v))].sort();
  const leadIds = ids((r) => (r.who_kind === 'lead' ? r.who_id : null));
  const senderIds = ids((r) => (r.who_kind === 'sender' ? r.who_id : null));
  const chatIds = ids((r) => (r.who_kind === 'lead' ? r.chat_id : null));
  return useQuery({
    queryKey: [...hk.all(ws ?? ''), 'pictures', leadIds, senderIds, chatIds] as const,
    enabled: !!ws && leadIds.length + senderIds.length + chatIds.length > 0,
    staleTime: 5 * 60_000, placeholderData: keepPreviousData,
    queryFn: async () => {
      const fetchAll = async (table: 'outreach_leads' | 'outreach_senders' | 'outreach_chats', col: string, list: string[]) => {
        const out = new Map<string, string>();
        for (let i = 0; i < list.length; i += 150) {
          const { data, error } = await db.from(table).select(`id, ${col}`).in('id', list.slice(i, i + 150));
          if (error) throw parseError(error);
          for (const r of (data ?? []) as unknown as Array<Record<string, string | null>>) if (r.id && r[col]) out.set(r.id, r[col]!);
        }
        return out;
      };
      const [leads, senders, chats] = await Promise.all([
        fetchAll('outreach_leads', 'picture_url', leadIds),
        fetchAll('outreach_senders', 'picture_url', senderIds),
        fetchAll('outreach_chats', 'attendee_picture_url', chatIds),
      ]);
      const out: Record<string, string> = {};
      for (const r of rows) {
        const src = r.who_kind === 'lead' ? (r.who_id && leads.get(r.who_id)) || (r.chat_id && chats.get(r.chat_id))
          : r.who_kind === 'sender' && r.who_id ? senders.get(r.who_id) : null;
        if (src) out[`${r.type}:${r.id}`] = src;
      }
      return out;
    },
  });
}

/** How many cards of one type wait in one place (a sequence, a variable, a website): the "5 replies need you" lines. */
export function useNeedsYouCount(ws: string | null | undefined, type: NeedsYouType, whereId: string | null | undefined) {
  return useQuery({
    queryKey: hk.needsYou(ws ?? '', { count: true, type, where: whereId }), enabled: !!ws && !!whereId, staleTime: 30_000,
    queryFn: async () => {
      const { count, error } = await db.from('outreach_ai_needs_you').select('id', { count: 'exact', head: true }).eq('workspace_id', ws!).eq('type', type).eq('where_id', whereId!);
      if (error) throw parseError(error);
      return count ?? 0;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Activity: what the AI wrote (the view reads nothing else)
// ---------------------------------------------------------------------------------------------------------------
export const ACTIVITY_PAGE = 50;
function activityQuery(ws: string, f: ActivityFilters, head = false) {
  const w = activityWindow(f);
  let q = db.from('outreach_ai_outputs').select('*', head ? { count: 'exact', head: true } : { count: 'exact' }).eq('workspace_id', ws);
  if (f.feature) q = q.eq('feature', f.feature);
  if (f.where) q = q.eq('where_id', f.where);
  if (w.from) q = q.gte('created_at', w.from);
  if (w.to) q = q.lt('created_at', w.to);
  if (f.q.trim()) q = q.ilike('text', likePattern(f.q));
  return q;
}
export function useAiActivity(ws: string | null | undefined, f: ActivityFilters, page: number, pageSize = ACTIVITY_PAGE) {
  return useQuery({
    queryKey: hk.activity(ws ?? '', { ...f, page, pageSize }), enabled: !!ws && (f.range !== 'custom' || !!f.from), placeholderData: keepPreviousData,
    queryFn: async () => {
      const from = page * pageSize;
      const { data, error, count } = await activityQuery(ws!, f).order('created_at', { ascending: false }).order('id').range(from, from + pageSize - 1);
      if (error) throw parseError(error);
      return { rows: (data ?? []) as AiOutputRow[], total: count ?? 0 };
    },
  });
}
/** Every row of the current filter for the CSV export (up to `cap`). */
export async function fetchAiActivityAll(ws: string, f: ActivityFilters, cap = 5000): Promise<AiOutputRow[]> {
  const out: AiOutputRow[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await activityQuery(ws, f).order('created_at', { ascending: false }).order('id').range(from, Math.min(cap, from + 1000) - 1);
    if (error) throw parseError(error);
    out.push(...((data ?? []) as AiOutputRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------------------------
export interface HubSetupSequence { id: string; name: string; status: 'draft' | 'active' | 'paused' | 'archived'; mode: ReplyMode; warmup_remaining: number | null; downgraded_at: string | null; downgrade_reason: string | null; waiting: number }
export interface HubSetupVariable { id: string; key: string; name: string; mode: 'off' | 'review'; needs_posts: boolean; waiting: number; approved: number }
export interface HubSetupWebsite { id: string; name: string; is_active: boolean; ai_enabled: boolean; mode: string; review_timeout_min: number; waiting: number }
export interface HubSetup {
  written_7d: Partial<Record<AiFeature, number>>;
  sequences: HubSetupSequence[]; variables: HubSetupVariable[]; websites: HubSetupWebsite[];
  drafts: { open: number }; profile: { open: number }; questions_open: number;
}
export function useHubSetup(ws: string | null | undefined) {
  return useQuery({ queryKey: hk.setup(ws ?? ''), enabled: !!ws, queryFn: () => rpc<HubSetup>('hub_setup', { p_ws: ws }) });
}

/** Off / Review for one variable. Switching off stops lines that are still to be written (their leads use the fallback). */
export function useVariableSetMode(ws: string | null | undefined) {
  const invalidate = useInvalidateHub(ws);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { variableId: string; mode: 'off' | 'review' }) => rpc<{ id: string; mode: string; was: string }>('hub_variable_set_mode', { p_variable: a.variableId, p_mode: a.mode }),
    onSuccess: () => { invalidate(); if (ws) { qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-variables'] }); qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-batches'] }); qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-review'] }); } },
  });
}

/** Off / Review / Auto (+ When, + the review timeout) for one website. Managers; saved as a settings version. */
export function useWebsiteSetMode(ws: string | null | undefined) {
  const invalidate = useInvalidateHub(ws);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { inboxId: string; mode: HubMode; when?: WebsiteWhen | null; reviewTimeoutMin?: number | null }) =>
      rpc('hub_website_set_mode', { p_inbox: a.inboxId, p_mode: a.mode, p_when: a.when ?? null, p_review_timeout_min: a.reviewTimeoutMin ?? null }),
    onSuccess: (_r, a) => { invalidate(); if (ws) qc.invalidateQueries({ queryKey: ['outreach', ws, 'webchat', 'inboxes'] }); qc.invalidateQueries({ queryKey: ['outreach', 'webchat', 'inbox', a.inboxId] }); },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Knowledge: sources, Q&A, unanswered questions
// ---------------------------------------------------------------------------------------------------------------
export type KnowledgeTargetKind = 'sequence' | 'website';
export interface KnowledgeTarget { kind: KnowledgeTargetKind; id: string; name: string | null }
export interface HubKnowledgeSource {
  id: string; kind: 'website' | 'document' | 'text' | 'catalogue'; title: string; url: string | null; storage_path: string | null; content_type: string | null;
  /** Product catalogues (migration 068): a catalogue's state; a website source that also finds products; how many it holds. */
  detect_products?: boolean; catalogue?: CatalogueState | null; products?: number | null;
  status: 'pending' | 'crawling' | 'ready' | 'error'; error: string | null; pages: number; chunks: number; crawled_at: string | null; refresh_days: number | null;
  created_at: string; updated_at: string; used_by: number; used_in: KnowledgeTarget[];
}
export interface HubKnowledge {
  sources: HubKnowledgeSource[]; qa_total: number; questions_open: number;
  targets: { sequences: Array<{ id: string; name: string; status: string }>; websites: Array<{ id: string; name: string }> };
}
export function useHubKnowledge(ws: string | null | undefined) {
  return useQuery({
    queryKey: hk.knowledge(ws ?? ''), enabled: !!ws,
    queryFn: () => rpc<HubKnowledge>('hub_knowledge', { p_ws: ws }),
    // a crawl in progress finishes within minutes: keep the status fresh while one is running
    refetchInterval: (q) => (q.state.data?.sources.some((s) => s.status === 'pending' || s.status === 'crawling' || s.catalogue?.syncing) ? 10_000 : false),
  });
}
export function useKnowledgeLink(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { sourceId: string; kind: KnowledgeTargetKind; targetId: string; on: boolean }) => rpc('hub_knowledge_link', { p_source: a.sourceId, p_kind: a.kind, p_target: a.targetId, p_on: a.on }),
    onSuccess: (_r, a) => {
      if (ws) { qc.invalidateQueries({ queryKey: hk.knowledge(ws) }); qc.invalidateQueries({ queryKey: ['outreach', ws, 'knowledge-sources'] }); qc.invalidateQueries({ queryKey: ['outreach', ws, 'webchat', 'inboxes'] }); }
      if (a.kind === 'sequence') qc.invalidateQueries({ queryKey: ['outreach', 'sequence', a.targetId, 'ai-replies'] });
      else qc.invalidateQueries({ queryKey: ['outreach', 'webchat', 'inbox', a.targetId] });
    },
  });
}

export interface QaPair {
  id: string; question: string; answer: string; enabled: boolean; source: 'manual' | 'unanswered' | 'import'; created_at: string; updated_at: string;
  /** 'sequence' = kept on that sequence's prompt; 'library' = shared. */
  owner: 'library' | 'sequence';
  /** [] = everywhere. */
  targets: KnowledgeTarget[];
}
export const qaScopeText = (p: Pick<QaPair, 'targets'>) => (p.targets.length === 0 ? 'All' : p.targets.map((t) => t.name ?? (t.kind === 'sequence' ? 'A sequence' : 'A website')).join(' · '));
export function useQaList(ws: string | null | undefined, enabled = true) {
  return useQuery({ queryKey: hk.qa(ws ?? ''), enabled: !!ws && enabled, queryFn: async () => (await rpc<QaPair[]>('hub_qa_list', { p_ws: ws })) ?? [] });
}
/** targets: undefined = leave as it is (a new pair: everywhere); [] = everywhere; a list = only those. */
export function useQaSave(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id?: string | null; question: string; answer: string; enabled?: boolean; targets?: Array<{ kind: KnowledgeTargetKind; id: string }> }) =>
      rpc<{ id: string; owner: string }>('hub_qa_save', { p_ws: ws, p_id: a.id ?? null, p_question: a.question, p_answer: a.answer, p_enabled: a.enabled ?? true, p_targets: a.targets ?? null }),
    onSuccess: () => { if (ws) { qc.invalidateQueries({ queryKey: hk.qa(ws) }); qc.invalidateQueries({ queryKey: hk.knowledge(ws) }); } qc.invalidateQueries({ queryKey: ['outreach', 'sequence'] }); },
  });
}
export function useQaDelete(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string }) => rpc('hub_qa_delete', { p_id: a.id }),
    onSuccess: () => { if (ws) qc.invalidateQueries({ queryKey: hk.all(ws) }); qc.invalidateQueries({ queryKey: ['outreach', 'sequence'] }); },
  });
}
/** "Add answer" on a Question card: a shared Q&A pair, so AI replies and the Website agent both answer it next time. */
export function useQuestionAnswer(ws: string | null | undefined) {
  const invalidate = useInvalidateHub(ws);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { groupId: string; answer: string; targets?: Array<{ kind: KnowledgeTargetKind; id: string }> }) =>
      rpc<{ group_id: string; qa_id: string }>('hub_question_answer', { p_group: a.groupId, p_answer: a.answer, p_targets: a.targets ?? null }),
    onSuccess: () => { invalidate(); qc.invalidateQueries({ queryKey: ['outreach', 'sequence'] }); },
  });
}
export const dismissQuestion = (groupId: string, reason?: string | null) => rpc('hub_question_dismiss', { p_group: groupId, p_reason: reason ?? null });

// ---------------------------------------------------------------------------------------------------------------
// Card actions. Every send goes through the path the inbox uses, so handoff, origin and counts behave the same.
// ---------------------------------------------------------------------------------------------------------------
/** Reply: send the AI draft (as is or edited). `ai_run_id` makes it an AI-drafted send (origin ai_draft_sent / ai_edited). */
export const sendReplyDraft = (a: { chatId: string; runId: string; text: string }) => callFn<{ ok: boolean }>('send-reply', { chat_id: a.chatId, text: a.text, ai_run_id: a.runId });
/** Reply on warm-up hold: send it now (same checks as the scheduled send, working hours ignored). */
export const sendReplyNow = (runId: string) => callFn<{ ok: boolean; status: string }>('ai-reply', { action: 'send_now', run_id: runId });
/** Reply on warm-up hold: cancel it. A reason is required for a scheduled reply. */
export const cancelReply = (runId: string, reason: string, note?: string | null) => rpc('ai_reply_cancel', { p_run: runId, p_reason: reason, p_note: note ?? null });
/** Reply: the AI suggested not replying: apply that (archive / mark read / tag, as the run says). */
export const applyNoReply = (runId: string) => rpc('ai_reply_apply_no_reply', { p_run: runId });
/** Reply: Skip (a draft, a no-reply suggestion or an escalated reply): nothing is sent, the card closes. */
export const dismissReply = (runId: string) => rpc('hub_reply_dismiss', { p_run: runId });

/** Line: approve · skip (the fallback is used) · edit (= approve with your text) · regenerate. Up to 2000 ids a call. */
export async function reviewLines(ids: string[], action: 'approve' | 'skip' | 'edit' | 'regenerate', text?: string): Promise<number> {
  let updated = 0;
  for (let i = 0; i < ids.length; i += 2000) {
    const r = await rpc<{ updated: number }>('ai_review', { p_value_ids: ids.slice(i, i + 2000), p_action: action, p_text: action === 'edit' ? text : null });
    updated += r?.updated ?? 0;
  }
  return updated;
}
/**
 * Line of a Fields variable: save the typed fields (= approve with these values, like editing a line). The database
 * checks every value against its field and answers E_PAYLOAD_INVALID naming the field that does not fit.
 */
export const editLineFields = (valueId: string, data: Record<string, AiFieldValue>) =>
  rpc<{ updated: number; data: Record<string, AiFieldValue>; text: string }>('hub_line_fields_edit', { p_value: valueId, p_data: data });

/** Step draft: approve (the text is queued for sending) or skip the step (the lead moves on without this message). */
export const approveStepDraft = (taskId: string, text: string) => rpc('complete_task', { p_id: taskId, p_text: text.trim(), p_result: null });
export const skipStepDraft = (taskId: string) => rpc('complete_task', { p_id: taskId, p_text: null, p_result: { decision: 'reject' } });
export const regenerateStepDraft = (taskId: string) => callFn<{ text?: string }>('ai-draft', { task_id: taskId });

/** Website (Review mode): send the suggestion (as is or edited) as the agent's answer. The id marks the suggestion used. */
/** `productIds`: the product cards of the suggestion the agent kept; they are sent under the text (migration 068). */
export const sendWebsiteSuggestion = (a: { chatId: string; suggestionId: string; text: string; productIds?: string[] }) =>
  (a.productIds?.length
    ? rpc('hub_webchat_send_products', { p_chat: a.chatId, p_product_ids: a.productIds, p_text: a.text, p_suggestion: a.suggestionId })
    : rpc('webchat_agent_send', { p_chat: a.chatId, p_text: a.text, p_content_type: 'text', p_attrs: { internal: { suggestion_id: a.suggestionId } }, p_attachments: [] }));

/** Profile draft: discard it. Applying it happens in Profile Studio (the owner's approval lives there). */
export const discardProfileDraft = (changeId: string) => rpc('profile_cancel_change', { p_change: changeId, p_reason: 'discarded in AI → Needs you' });

// ---------------------------------------------------------------------------------------------------------------
// Inbox: the suggestion waiting for a web chat in Review mode (pre-fills the composer)
// ---------------------------------------------------------------------------------------------------------------
export interface WebchatSuggestion {
  id: string; chat_id: string; message_id: string; text: string; confidence: string | null; sources: Array<{ url: string | null; title: string }>; status: string; created_at: string;
  /** Product cards the assistant recommends with this answer (catalogue snapshots; migration 068). */
  products?: ProductCard[];
}
const SUGGESTION_COLUMNS = 'id, chat_id, message_id, text, confidence, sources, status, created_at';
/** The suggestion's cards, for a card in Needs you (the view does not carry them). Empty before migration 068. */
export function useSuggestionProducts(suggestionId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['outreach', 'webchat-suggestion-products', suggestionId ?? ''], enabled: !!suggestionId && enabled, staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await db.from('outreach_webchat_ai_suggestions').select('products').eq('id', suggestionId!).maybeSingle();
      if (error) return [] as ProductCard[];
      return (Array.isArray((data as { products?: unknown } | null)?.products) ? (data as { products: ProductCard[] }).products : []) as ProductCard[];
    },
  });
}
/** Polled while the chat is open: the suggestion arrives a few seconds after the visitor's message. */
export function useWebchatSuggestion(chatId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: hk.suggestion(chatId ?? ''), enabled: !!chatId && enabled, refetchInterval: 5000,
    queryFn: async () => {
      const read = (cols: string) => db.from('outreach_webchat_ai_suggestions').select(cols).eq('chat_id', chatId!).in('status', ['pending', 'waiting']).order('created_at', { ascending: false }).limit(1);
      let { data, error } = await read(`${SUGGESTION_COLUMNS}, products`);
      if (error && /products/.test(error.message ?? '')) ({ data, error } = await read(SUGGESTION_COLUMNS));   // a database from before migration 068
      if (error) throw parseError(error);
      return ((data ?? [])[0] ?? null) as unknown as WebchatSuggestion | null;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Knowledge page: what the library shares with the pickers on a sequence and on a website
// ---------------------------------------------------------------------------------------------------------------
/** File types the knowledge reader extracts. The same list for the library's upload and the one on a sequence's AI tab. */
export const KNOWLEDGE_FILE_ACCEPT = '.txt,.md,.markdown,.html,.htm,text/plain,text/markdown,text/html';

/** "Website agent (kaptured.ai)" for a website, the sequence's name for a sequence: the Used by column. */
export const knowledgeTargetText = (t: Pick<KnowledgeTarget, 'kind' | 'name'>) => (t.kind === 'website' ? `Website agent (${t.name ?? 'a website'})` : t.name ?? 'A sequence');
/** Where a place that uses knowledge is set up: the sequence's AI tab, the website's assistant tab. */
export const knowledgeTargetHref = (t: Pick<KnowledgeTarget, 'kind' | 'id'>) => (t.kind === 'website' ? `/outreach/websites/${t.id}?tab=ai` : `/outreach/sequences/${t.id}?tab=ai`);

/**
 * A source was added or removed (knowledge_source_add / knowledge_source_delete keep their own hooks in
 * aiRepliesSequence.ts and only refresh the sequence picker): refresh the library, both pickers and what they cached.
 */
export function useInvalidateKnowledge(ws: string | null | undefined) {
  const qc = useQueryClient();
  return () => {
    if (ws) {
      qc.invalidateQueries({ queryKey: hk.knowledge(ws) });
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-knowledge'] });
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'knowledge-sources'] });
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'webchat', 'inboxes'] });
    }
    qc.invalidateQueries({ queryKey: ['outreach', 'webchat', 'inbox'] });
    qc.invalidateQueries({ queryKey: ['outreach', 'sequence'] });
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Personalized lines: the "All lines" view of Setup (every status, batches, Generate lines)
// ---------------------------------------------------------------------------------------------------------------
/** /outreach/ai/setup/lines?view=lines, optionally opened on one batch. */
export const linesHref = (batchId?: string | null) => `${AI_HUB_PATH}/setup/lines${qs({ view: 'lines', batch: batchId })}`;
/** A variable's mode as stored. A row read before migration 063 has no mode: it counts as Review. */
export const variableMode = (v: { mode?: string | null } | null | undefined): 'off' | 'review' => (v?.mode === 'off' ? 'off' : 'review');
