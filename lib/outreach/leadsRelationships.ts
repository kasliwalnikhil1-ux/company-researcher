/**
 * Leads page vocabulary and reads for migration 094 (leads-relationships-PRD.md): the status ladder, the channels a
 * lead can be reached on, who is connected through which account, the totals line and the By account panel.
 *
 * Everything here is a thin layer over the SQL: outreach_lead_summary (embedded on the list), outreach_leads_totals,
 * outreach_leads_by_account, outreach_lead_relationships, outreach_lead_promote and outreach_lead_hide. The filter
 * vocabulary sent to the RPCs is the same one the PostgREST list query applies (intel.ts leadsQuery), key for key.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from './backend';
import { parseError, rpc } from './api';
import type { LeadChannel, LeadKind, LeadOrigin, LeadRelationshipRow, LeadStatus, LeadSummary, LeadsByAccountRow, LeadsTotals, Provider, RelationSource } from './types';

export type LeadTab = 'prospects' | 'inbox' | 'all';
export const LEAD_TABS: Array<{ key: LeadTab; label: string; help: string }> = [
  { key: 'prospects', label: 'Outbound', help: 'People you reach out to: imported, added, found by search, created by API, enrolled or promoted.' },
  { key: 'inbox', label: 'Inbound', help: 'People who wrote to one of your accounts and haven\'t been added to outreach yet.' },
  { key: 'all', label: 'All', help: 'Outbound and inbound together. Hidden leads (newsletters, company pages) show only with the Hidden filter.' },
];

export const LEAD_STATUSES: LeadStatus[] = ['not_contacted', 'invited', 'connected', 'messaged', 'replied', 'interested', 'meeting', 'do_not_contact', 'bounced', 'wrote_to_us'];
type Tone = 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo' | 'purple';
export const STATUS_META: Record<LeadStatus, { label: string; tone: Tone; help: string }> = {
  not_contacted: { label: 'Not contacted', tone: 'gray', help: 'No invite, message or email has gone to this person from any account.' },
  invited: { label: 'Invited', tone: 'blue', help: 'A LinkedIn invite or Instagram follow was sent and has not been accepted yet.' },
  connected: { label: 'Connected', tone: 'green', help: 'A LinkedIn connection or Instagram follow-back with one of your accounts, however it came about.' },
  messaged: { label: 'Messaged', tone: 'indigo', help: 'A message, InMail, DM, WhatsApp message or email was sent.' },
  replied: { label: 'Replied', tone: 'purple', help: 'A human reply after one of your touches. Out-of-office and automatic replies do not count.' },
  interested: { label: 'Interested', tone: 'green', help: 'A reply classified interested or as a question.' },
  meeting: { label: 'Meeting', tone: 'green', help: 'Reached a stage marked as a meeting.' },
  do_not_contact: { label: 'Do not contact', tone: 'red', help: 'Suppressed: do-not-contact, unsubscribed or on a blacklist. History stays in the hover.' },
  bounced: { label: 'Bounced', tone: 'amber', help: 'The email bounced or the WhatsApp number is invalid, and no other channel got anywhere.' },
  wrote_to_us: { label: 'Wrote to us', tone: 'blue', help: 'They wrote first and nothing has gone to them from any account yet.' },
};
export const statusLabel = (s: LeadStatus | null | undefined) => STATUS_META[s ?? 'not_contacted']?.label ?? 'Not contacted';

export const CHANNEL_META: Record<LeadChannel, { mark: string; label: string }> = {
  linkedin: { mark: 'in', label: 'LinkedIn' },
  instagram: { mark: 'ig', label: 'Instagram' },
  whatsapp: { mark: 'wa', label: 'WhatsApp' },
  email: { mark: '✉', label: 'Email' },
};
export const CHANNEL_ORDER: LeadChannel[] = ['linkedin', 'instagram', 'whatsapp', 'email'];
/** Provider (sender / filter value) → summary channel. */
export function channelOf(provider: Provider | string | null | undefined): LeadChannel {
  const p = String(provider ?? '').toUpperCase();
  if (p === 'INSTAGRAM') return 'instagram';
  if (p === 'WHATSAPP') return 'whatsapp';
  if (p === 'LINKEDIN' || p === '') return 'linkedin';
  return 'email';
}

export const ORIGIN_LABEL: Record<LeadOrigin, string> = { import: 'Imported', manual: 'Added', api: 'API', search: 'Search', inbound: 'Wrote to us' };
export const KIND_LABEL: Record<LeadKind, string> = { person: 'Person', company_page: 'Company page', automated: 'Automated sender' };
export const SOURCE_LABEL: Record<RelationSource, string> = { our_invite: 'accepted our invite', their_invite: 'they invited us', pre_existing: 'already connected before outreach', unknown: 'source unknown, from before 26 Oct 2026' };
export const SOURCE_FILTER_LABEL: Record<RelationSource, string> = { our_invite: 'Via our invite', their_invite: 'Their invite', pre_existing: 'Already connected', unknown: 'Unknown (before 26 Oct 2026)' };

/** Where a lead came from, as the lead page says it: "Wrote to us on LinkedIn, 19 Oct" / "Imported 3 Sep". */
export function originLine(l: { origin?: LeadOrigin | null; created_at: string; source?: string | null }, summary?: Pick<LeadSummary, 'wrote_first_at' | 'status_channel'> | null, fmt: (iso: string | null | undefined, withTime?: boolean) => string = (v) => v ?? ''): string {
  const o = l.origin ?? 'import';
  if (o === 'inbound') {
    const ch = summary?.status_channel ? CHANNEL_META[summary.status_channel].label : null;
    return `Wrote to us${ch ? ` on ${ch}` : ''}, ${fmt(summary?.wrote_first_at ?? l.created_at, false)}`;
  }
  return `${ORIGIN_LABEL[o]} ${fmt(l.created_at, false)}${o === 'import' && l.source && l.source !== 'csv' ? ` (${l.source.replace(/_/g, ' ')})` : ''}`;
}

/** The relationship state of one account with the lead, in words (094 §4.2, §6). */
export function relationshipStateText(r: LeadRelationshipRow, fmt: (iso: string | null | undefined, withTime?: boolean) => string): { label: string; tone: Tone; detail: string } {
  const since = r.since ? fmt(r.since, false) : null;
  switch (r.state) {
    case 'connected': return { label: `Connected${since ? ` ${since}` : ''}`, tone: 'green', detail: r.source ? SOURCE_LABEL[r.source] : '' };
    case 'pending': return { label: `Invite pending${since ? ` since ${since}` : ''}`, tone: 'blue', detail: r.invite_had_note === true ? 'with a note' : r.invite_had_note === false ? 'no note' : '' };
    case 'pending_in': return { label: 'They invited us', tone: 'purple', detail: '' };
    case 'follows_us': return { label: 'They follow us', tone: 'blue', detail: 'Not followed back yet' };
    case 'disconnected': return { label: 'No longer connected', tone: 'gray', detail: r.connected_at ? `Connected ${fmt(r.connected_at, false)}, gone at the last check` : '' };
    case 'blocked': return { label: 'Blocked', tone: 'red', detail: '' };
    case 'invalid': return { label: 'Invalid profile', tone: 'red', detail: '' };
    case 'number_invalid': return { label: 'Number invalid', tone: 'red', detail: '' };
    case 'chat': return { label: `Chat${since ? ` since ${since}` : ''}`, tone: 'green', detail: r.consent ? `consent: ${r.consent.replace(/_/g, ' ')}` : 'consent: none' };
    case 'has_number': return { label: 'Has number', tone: 'gray', detail: r.consent ? `consent: ${r.consent.replace(/_/g, ' ')}` : 'consent: none' };
    case 'bounced': return { label: 'Bounced', tone: 'amber', detail: '' };
    case 'emailed': return { label: 'Emailed', tone: 'indigo', detail: r.last_touch_at ? `last ${fmt(r.last_touch_at, false)}` : '' };
    case 'has_address': return { label: 'Has address', tone: 'gray', detail: '' };
    default: return { label: 'Not connected', tone: 'gray', detail: '' };
  }
}

/** The enrichment cell text while a lead waits (094 §5.2). */
export function enrichWaitText(reason: { kind: string; position?: number; sender?: string; resets_at?: string | null } | null | undefined, fmtTime: (iso: string) => string): string {
  if (!reason) return 'Waiting';
  if (reason.kind === 'budget') return `Waiting · daily profile views used${reason.sender ? ` (${reason.sender}${reason.resets_at ? `, resets ${fmtTime(reason.resets_at)}` : ''})` : ''}`;
  if (reason.kind === 'no_sender') return 'Waiting · no connected LinkedIn account';
  if (reason.kind === 'queue' && reason.position != null) return `Waiting · queued behind ${Math.max(0, reason.position - 1).toLocaleString()} ${reason.position - 1 === 1 ? 'lead' : 'leads'}`;
  return 'Waiting';
}

// ---------------------------------------------------------------------------
// Filters → the RPC vocabulary (outreach__leads_matching). Same keys as intel.ts leadsQuery applies on PostgREST.
// ---------------------------------------------------------------------------
export interface RelationshipFilters {
  tab?: LeadTab | null;
  hidden?: boolean | null;
  status?: LeadStatus[] | null;
  connected_via?: string[] | null;
  pending_with?: string[] | null;
  not_connected?: boolean | null;
  connection_source?: RelationSource | null;
  channel_used?: Provider | null;
  channel_replied?: Provider | null;
  origin?: LeadOrigin[] | null;
  kind?: LeadKind[] | null;
  include_removed?: boolean | null;
}

type AnyFilters = Record<string, unknown>;
const KEEP = ['search', 'client_id', 'list_id', 'stage_id', 'tag_id', 'dnc', 'enriched', 'replied', 'posted_30d', 'min_followers', 'time_in_role', 'past_company', 'skill', 'language',
  'tab', 'hidden', 'status', 'connected_via', 'pending_with', 'not_connected', 'connection_source', 'channel', 'channel_used', 'channel_replied', 'origin', 'kind', 'include_removed'];
/** Drops empty values so the SQL side only sees what was asked for. `channel` (reachable) keeps its provider value. */
export function matchingFilters(f: AnyFilters): AnyFilters {
  const out: AnyFilters = {};
  for (const k of KEEP) {
    const v = f[k];
    if (v == null || v === '' || v === false || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  if (!out.tab) out.tab = 'prospects';
  return out;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export const rk = {
  totals: (ws: string, f: unknown) => ['outreach', ws, 'leads', 'totals', f] as const,
  byAccount: (ws: string, f: unknown) => ['outreach', ws, 'leads', 'by-account', f] as const,
  relationships: (leadId: string, removed: boolean) => ['outreach', 'lead', leadId, 'relationships', removed] as const,
  summary: (leadId: string) => ['outreach', 'lead', leadId, 'summary'] as const,
};

export function useLeadsTotals(ws: string | null | undefined, f: AnyFilters, enabled = true) {
  const filters = matchingFilters(f);
  return useQuery({
    queryKey: rk.totals(ws ?? '', filters), enabled: !!ws && enabled, placeholderData: (prev) => prev, staleTime: 15_000,
    queryFn: () => rpc<LeadsTotals>('leads_totals', { p_ws: ws, p_f: filters, p_include_removed: !!filters.include_removed }),
  });
}

export function useLeadsByAccount(ws: string | null | undefined, f: AnyFilters, enabled: boolean) {
  const filters = matchingFilters(f);
  return useQuery({
    queryKey: rk.byAccount(ws ?? '', filters), enabled: !!ws && enabled, staleTime: 15_000,
    queryFn: async () => (await rpc<{ rows: LeadsByAccountRow[]; include_removed: boolean; note: string }>('leads_by_account', { p_ws: ws, p_f: filters, p_include_removed: !!filters.include_removed })),
  });
}

export function useLeadRelationships(leadId: string | null | undefined, includeRemoved = false) {
  return useQuery({
    queryKey: rk.relationships(leadId ?? '', includeRemoved), enabled: !!leadId, staleTime: 15_000,
    queryFn: async () => (await rpc<LeadRelationshipRow[]>('lead_relationships', { p_lead: leadId, p_include_removed: includeRemoved })) ?? [],
  });
}

export function useLeadSummary(leadId: string | null | undefined) {
  return useQuery({
    queryKey: rk.summary(leadId ?? ''), enabled: !!leadId, staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await db.from('outreach_lead_summary').select('*').eq('lead_id', leadId!).maybeSingle();
      if (error) throw parseError(error);
      return (data ?? null) as LeadSummary | null;
    },
  });
}

/** Add to prospects / hide / unhide. Invalidates the lists, totals and the touched lead pages. */
export function useLeadRelationshipActions(ws: string | null | undefined) {
  const qc = useQueryClient();
  const done = (ids: string[]) => {
    if (ws) qc.invalidateQueries({ queryKey: ['outreach', ws, 'leads'] });
    for (const id of ids.slice(0, 50)) qc.invalidateQueries({ queryKey: ['outreach', 'lead', id] });
  };
  const promote = useMutation({ mutationFn: (ids: string[]) => rpc<number>('lead_promote', { p_ws: ws, p_lead_ids: ids }), onSuccess: (_n, ids) => done(ids) });
  const hide = useMutation({ mutationFn: (ids: string[]) => rpc<number>('lead_hide', { p_ws: ws, p_lead_ids: ids, p_hide: true }), onSuccess: (_n, ids) => done(ids) });
  const unhide = useMutation({ mutationFn: (ids: string[]) => rpc<number>('lead_hide', { p_ws: ws, p_lead_ids: ids, p_hide: false }), onSuccess: (_n, ids) => done(ids) });
  return { promote, hide, unhide };
}

/** Workspace setting `create_leads_from_inbound` as the UI reads it (the old boolean still maps). */
export type InboundLeadMode = 'people_only' | 'all' | 'none';
export function inboundLeadMode(settings: Record<string, unknown> | null | undefined): InboundLeadMode {
  const v = settings?.create_leads_from_inbound;
  if (v === false || v === 'none') return 'none';
  if (v === 'all') return 'all';
  return 'people_only';
}
export const INBOUND_LEAD_MODES: Array<{ value: InboundLeadMode; label: string; help: string }> = [
  { value: 'people_only', label: 'People only', help: 'A person who writes to one of your accounts becomes an inbound lead (Inbound tab). Newsletters, notifications and company pages stay in the inbox only.' },
  { value: 'all', label: 'Everyone', help: 'Every new sender becomes a lead. Automated senders and company pages are created hidden.' },
  { value: 'none', label: 'Nobody', help: 'No lead is created from an inbound message. Conversations still land in the inbox.' },
];
