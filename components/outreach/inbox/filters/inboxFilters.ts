import type { AiChatFilter, ChatFilters } from '@/lib/outreach/queries';
import { AI_FILTERS } from '../ai/useAiInbox';
import { INTENTS } from '../hooks';

/** The inbox list filters, remembered per workspace in this browser (the search is never stored). */
export type InboxFilters = ChatFilters & { sequence_id?: string | null };

export const INBOX_FILTER_DEFAULTS: InboxFilters = {
  sender_ids: [], client_id: null, intents: [], unread: null, assigned_to: null, providers: [], archived: false, sequence_id: null,
  ai: [], stages: [], has_notes: null, replied_from: null, replied_to: null, chip: 'all',
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const INTENT_SET = new Set<string>(INTENTS);
const AI_SET = new Set<string>(AI_FILTERS);

/**
 * Restores a stored filter state. Lists keep only strings (and only known values for intents and AI filters); the
 * single-value keys of the older inbox (`sender_id`, `intent`, `provider`, `ai`, `stage`) are carried into their lists so
 * a remembered filter survives the change to multi-select.
 */
export function sanitizeInboxFilters(raw: unknown, d: InboxFilters): InboxFilters {
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const list = (key: string, legacy: string, keep?: Set<string>) => {
    const xs = Array.isArray(r[key]) ? (r[key] as unknown[]) : [];
    const one = str(r[legacy]);
    if (one) xs.push(one);
    return Array.from(new Set(xs.filter((x): x is string => typeof x === 'string' && !!x && (!keep || keep.has(x)))));
  };
  const day = (v: unknown) => (typeof v === 'string' && DAY_RE.test(v) ? v : null);
  const chip = r.chip;
  return {
    ...d,
    sender_ids: list('sender_ids', 'sender_id'),
    client_id: str(r.client_id),
    intents: list('intents', 'intent', INTENT_SET),
    unread: r.unread === true ? true : null,
    assigned_to: str(r.assigned_to),
    providers: list('providers', 'provider'),
    archived: r.archived === true,
    sequence_id: str(r.sequence_id),
    ai: list('ai', 'ai', AI_SET) as AiChatFilter[],
    stages: list('stages', 'stage'),
    has_notes: r.has_notes === true ? true : null,
    replied_from: day(r.replied_from),
    replied_to: day(r.replied_to),
    chip: chip === 'needs_reply' || chip === 'waiting_on_them' || chip === 'all' ? chip : 'all',
  };
}

/** The filters the "Clear all" button resets (the view, chip and archive state are not filters). */
export const INBOX_FILTERS_CLEARED: Partial<InboxFilters> = {
  sender_ids: [], client_id: null, intents: [], providers: [], ai: [], stages: [], has_notes: null, replied_from: null, replied_to: null, sequence_id: null,
};

/** True when any list / value filter is set (used by the empty state's "Try clearing some filters" hint). */
export function anyInboxFilter(f: ChatFilters): boolean {
  return !!(f.sender_ids?.length || f.intents?.length || f.providers?.length || f.ai?.length || f.stages?.length || f.client_id || f.has_notes || f.replied_from || f.replied_to || f.unread || f.assigned_to);
}
