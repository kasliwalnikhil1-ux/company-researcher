'use client';

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError } from './api';

// Prospect-research runs (migrations/crm/006_research.sql): the "what changed" table the prospect-research skill
// reports after every run, kept per row with a fixed vocabulary so the Calendar screen can show it — as a tab and
// inside each event whose guests were researched. The skill also reads these rows back (research_lookup) so a
// person it could not confirm last time is not researched again from scratch.

export type ResearchKind = 'company' | 'contact' | 'meeting';
export type ResearchVerdict = 'confirmed' | 'work_email' | 'unconfirmed' | 'shared_inbox' | 'filtered';
export type ResearchAction = 'created' | 'updated' | 'skipped' | 'not_added';

/** Row of crm_research_items_v */
export interface ResearchItem {
  id: string; run_id: string; kind: ResearchKind; label: string; email: string | null; domain: string | null;
  company_id: string | null; contact_id: string | null; meeting_id: string | null;
  verdict: ResearchVerdict | null; action: ResearchAction; needs_review: boolean; researched: boolean;
  detail: string | null; review_reason: string | null; best_match_url: string | null; created_at: string;
  run_at: string; run_by: string | null; run_by_name: string | null; run_source: string | null; run_note: string | null;
  company_name: string | null; company_domain: string | null; contact_name: string | null;
  /** The linked contact's LinkedIn column and `about.links` (008) — shown as chips under the contact row. */
  contact_linkedin_url?: string | null; contact_links?: unknown;
}

export type Tone = 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo' | 'purple' | 'pink';

/** What the research established about who this is. The same five words the skill and the connector use. */
export const VERDICTS: Record<ResearchVerdict, { label: string; tone: Tone; help: string }> = {
  confirmed: { label: 'Confirmed', tone: 'green', help: 'Identified with evidence: a page shows the email, the profile matches the company, or the company\'s own website.' },
  work_email: { label: 'Work email only', tone: 'amber', help: 'The email proves the company; the person\'s profile could not be confirmed, so only the company and what the CRM already knew were saved.' },
  unconfirmed: { label: 'Not confirmed', tone: 'red', help: 'Nothing ties the email to a page or a company. Name-only matches never count. Nothing was saved.' },
  shared_inbox: { label: 'Shared inbox', tone: 'blue', help: 'A brand or team inbox (info@, a gmail listed as the site\'s contact), not a person. Saved as a contact named after the brand.' },
  filtered: { label: 'Filtered out', tone: 'gray', help: 'Internal, personal or a birthday — left out before any research.' },
};

/** What the run did to the CRM record. Meetings use booking words. */
export function actionLabel(kind: ResearchKind, action: ResearchAction): string {
  if (kind === 'meeting') return { created: 'Booked', updated: 'Moved', skipped: 'Already on file', not_added: 'Not booked' }[action];
  return { created: 'Created', updated: 'Updated', skipped: 'Exists, same', not_added: 'Not added' }[action];
}
export const ACTION_TONE: Record<ResearchAction, Tone> = { created: 'green', updated: 'indigo', skipped: 'gray', not_added: 'amber' };
export const ACTION_HELP: Record<ResearchAction, string> = {
  created: 'A new record was written (a meeting: booked).',
  updated: 'The record existed; only the keys that changed were written (a meeting: moved).',
  skipped: 'The record existed and already matched — nothing to change.',
  not_added: 'Nothing was written: the person could not be confirmed, it was filtered out, or it was a near-duplicate folded into an existing record.',
};
export const KIND_LABEL: Record<ResearchKind, string> = { company: 'Company', contact: 'Contact', meeting: 'Meeting' };

export const researchKeys = {
  all: ['crm', 'research'] as const,
  list: (p: unknown) => ['crm', 'research', 'list', p] as const,
  event: (p: unknown) => ['crm', 'research', 'event', p] as const,
};

const COLS = '*';

/** Latest research rows, newest run first (the Calendar → Research tab). */
export function useResearchItems(p: { needsReview?: boolean; limit?: number } = {}) {
  return useQuery({
    queryKey: researchKeys.list(p),
    queryFn: async () => {
      let q = supabase.from('crm_research_items_v').select(COLS).order('run_at', { ascending: false }).order('needs_review', { ascending: false }).order('kind').order('created_at').limit(p.limit ?? 400);
      if (p.needsReview) q = q.eq('needs_review', true);
      const { data, error } = await q;
      if (error) throw parseError(error);
      return (data ?? []) as ResearchItem[];
    },
    staleTime: 30_000,
  });
}

/** Research rows about one calendar event: its guests' emails, or the CRM meeting it is linked to. */
export function useResearchForEvent(emails: string[], meetingId?: string | null, enabled = true) {
  const list = Array.from(new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))).sort();
  return useQuery({
    queryKey: researchKeys.event({ list, meetingId: meetingId ?? null }),
    enabled: enabled && (list.length > 0 || !!meetingId),
    queryFn: async () => {
      const parts: string[] = [];
      if (list.length) parts.push(`email.in.(${list.map((e) => `"${e.replace(/"/g, '')}"`).join(',')})`);
      if (meetingId) parts.push(`meeting_id.eq.${meetingId}`);
      const { data, error } = await supabase.from('crm_research_items_v').select(COLS).or(parts.join(',')).order('run_at', { ascending: false }).order('created_at').limit(50);
      if (error) throw parseError(error);
      // one row per record: the latest run's verdict for each email / meeting / domain
      const seen = new Set<string>();
      return ((data ?? []) as ResearchItem[]).filter((r) => { const k = `${r.kind}:${r.email ?? r.meeting_id ?? r.domain ?? r.label}`; if (seen.has(k)) return false; seen.add(k); return true; });
    },
    staleTime: 30_000,
  });
}
