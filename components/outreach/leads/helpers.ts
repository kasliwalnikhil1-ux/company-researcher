// Shared helpers for the leads area (table, import wizard, detail page).
import type { CSSProperties } from 'react';
import type { Lead, Stage, Tag } from '@/lib/outreach/types';

export type ToastFn = (message: string, type?: 'success' | 'error') => void;

export const BULK_CAP = 10000;

export function leadName(l: Partial<Lead> | null | undefined): string {
  if (!l) return 'Unknown';
  return l.full_name || [l.first_name, l.last_name].filter(Boolean).join(' ') || l.public_identifier || l.email_work || l.email_personal || 'Unknown';
}

export function leadLinkedInUrl(l: Partial<Lead> | null | undefined): string | null {
  if (!l) return null;
  if (l.profile_url) return l.profile_url;
  if (l.public_identifier) return linkedInProfileUrl(l.public_identifier);
  return null;
}

const decodeId = (id: string): string => { try { return decodeURIComponent(id); } catch { return id; } };

/** Extract the public identifier from a LinkedIn profile URL (lowercased), or null. */
export function pubIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /linkedin\.com\/(?:mwlite\/)?in\/([^/?#\s]+)/i.exec(url);
  return m ? decodeId(m[1]).toLowerCase() : null;
}

/**
 * Every way a person's LinkedIn profile gets written, resolved to the lowercased public identifier: a profile URL (with or without
 * a trailing slash or a query such as `?isSelfProfile=true`), `in/<id>` (same extras) or the bare identifier. Anything else gives null:
 * another kind of link (a company page, a search), a name with spaces, an email. The import worker applies the same rule
 * (csvPublicIdentifier in supabase/functions/_shared/outreach/workers.ts); both are tested on the same values.
 */
export function normalizePublicIdentifier(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  const fromUrl = pubIdFromUrl(s);
  if (fromUrl) return fromUrl;
  if (/^https?:\/\//i.test(s) || /linkedin\.com/i.test(s)) return null;
  const id = s.replace(/^@/, '').replace(/^\/?in\//i, '').replace(/[/?#].*$/, '');
  if (!id || /[\s@.]/.test(id)) return null;
  return decodeId(id).toLowerCase() || null;
}

/** The person's LinkedIn URL for a public identifier, the one form every input resolves to. */
export function linkedInProfileUrl(publicIdentifier: string): string {
  return `https://www.linkedin.com/in/${publicIdentifier}`;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Inline style for a coloured chip (stage / tag). Falls back to gray for missing/invalid colours. */
export function chipStyle(color: string | null | undefined): CSSProperties {
  const c = color && HEX.test(color) ? color : '#6b7280';
  return { backgroundColor: `${c}1f`, color: c, borderColor: `${c}55` };
}

export const PALETTE = ['#6b7280', '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899'];

export function stageById(stages: Stage[] | undefined, id: string | null | undefined): Stage | undefined {
  return id ? stages?.find((s) => s.id === id) : undefined;
}
export function tagById(tags: Tag[] | undefined, id: string): Tag | undefined {
  return tags?.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// CSV mapping
// ---------------------------------------------------------------------------
/** Most data rows one CSV import takes. The import worker enforces the same number (CSV_MAX_ROWS in supabase/functions/_shared/outreach/workers.ts). */
export const CSV_MAX_ROWS = 25000;

/** The one mapping field for a person's LinkedIn profile. Only one column of a file can carry it. */
export const LINKEDIN_FIELD = 'linkedin_url';

/** `group` is the heading a field sits under in the column-mapping picker; "Skip column" and "Custom field…" have none. */
export const LEAD_FIELDS: Array<{ value: string; label: string; group?: string; hint?: string }> = [
  { value: '', label: 'Skip column' },
  // One field for the person's LinkedIn profile, however the file writes it (full URL, in/<id> or the bare identifier).
  { value: LINKEDIN_FIELD, label: 'LinkedIn URL / identifier', group: 'Matched on', hint: 'Full link, in/name or just name' },
  { value: 'email_work', label: 'Work email', group: 'Matched on' },
  { value: 'email_personal', label: 'Personal email', group: 'Matched on' },
  { value: 'first_name', label: 'First name', group: 'Person' },
  { value: 'last_name', label: 'Last name', group: 'Person' },
  { value: 'full_name', label: 'Full name', group: 'Person' },
  { value: 'headline', label: 'Headline', group: 'Person' },
  { value: 'title', label: 'Title', group: 'Person' },
  { value: 'location', label: 'Location', group: 'Person' },
  { value: 'phone', label: 'Phone', group: 'Person' },
  { value: 'company', label: 'Company', group: 'Company' },
  { value: 'company_domain', label: 'Company website / domain', group: 'Company' },
  // Channels: become identities ({provider, identifier}) on the lead; the engine normalises them (E.164, lower-case handle).
  { value: 'instagram_handle', label: 'Instagram handle', group: 'Other channels' },
  { value: 'whatsapp_phone', label: 'WhatsApp number', group: 'Other channels', hint: 'With country code' },
  { value: 'custom', label: 'Custom field…' },
];

/** CSV mapping fields that are identities, and the channel each one belongs to. */
export const IDENTITY_FIELDS: Record<string, 'INSTAGRAM' | 'WHATSAPP'> = { instagram_handle: 'INSTAGRAM', whatsapp_phone: 'WHATSAPP' };

const GUESSES: Array<[RegExp, string]> = [
  [/linkedin|profile.?url|li.?url|public.?id|slug|vanity/i, LINKEDIN_FIELD],
  [/^(first|given).?name$|^first$/i, 'first_name'],
  [/^(last|family|sur).?name$|^last$/i, 'last_name'],
  [/^(full.?)?name$|^contact$/i, 'full_name'],
  [/headline|tagline/i, 'headline'],
  [/^(company|organi[sz]ation|employer|account)(.?name)?$/i, 'company'],
  [/^(job.?)?title$|^position$|^role$/i, 'title'],
  [/location|city|country|region/i, 'location'],
  [/^(company.?)?(domain|web.?site)$/i, 'company_domain'],
  [/work.?e-?mail|business.?e-?mail|^e-?mails?$|^e-?mail.?address(es)?$/i, 'email_work'],
  [/personal.?e-?mail|private.?e-?mail|home.?e-?mail/i, 'email_personal'],
  [/insta|ig.?handle/i, 'instagram_handle'],
  [/whatsapp|wa.?number/i, 'whatsapp_phone'],
  [/^(phone|mobile|cell|tel)s?(.?(number|no))?$|telephone/i, 'phone'],
];

// The fields a lead is matched on. A column that describes somebody else (the rep who owns the row, the lead's company) must never be
// guessed into one of these: every row would carry the same value and the whole file would merge into a handful of leads.
const KEY_FIELDS = new Set([LINKEDIN_FIELD, 'email_work', 'email_personal']);
const SOMEBODY_ELSE = /\b(account|owner|sender|assigned|assignee|rep|sdr|user|agent|recruiter|manager|company|organi[sz]ation|employer)\b/;
const LEAD_PREFIX = /^(lead|prospect|contact|person|candidate)s? /;

/** Guess the lead field for a CSV header. Returns '' when unsure. */
export function guessField(header: string): string {
  const words = header.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!words) return '';
  const h = words.replace(LEAD_PREFIX, '');   // "prospect_name" is the lead's name, "lead email" the lead's email
  for (const [re, field] of GUESSES) {
    if (!re.test(h)) continue;
    if (KEY_FIELDS.has(field) && SOMEBODY_ELSE.test(words)) return '';
    return field;
  }
  return '';
}

export function toCustomKey(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
}

/** Compute the dedupe key of a CSV row given a header→field mapping (FR-LD-01). */
export function dedupeKey(row: Record<string, string>, mapping: Record<string, string>): { kind: 'public_identifier' | 'email'; value: string } | null {
  let pub: string | null = null; let email: string | null = null;
  for (const [col, field] of Object.entries(mapping)) {
    const v = (row[col] ?? '').trim();
    if (!v) continue;
    if (field === LINKEDIN_FIELD && !pub) pub = normalizePublicIdentifier(v);
    if ((field === 'email_work' || field === 'email_personal') && !email) email = v.toLowerCase();
  }
  if (pub) return { kind: 'public_identifier', value: pub };
  if (email) return { kind: 'email', value: email };
  return null;
}

/**
 * How many different people a CSV holds under a mapping, counted over every row. Rows that share a LinkedIn URL or email become ONE lead,
 * so `people` is the most leads this file can create or update. `collapsing` flags a file where most rows share their key: nearly always
 * the wrong column (for example the account owner's profile) mapped to LinkedIn URL or email.
 */
export function csvKeyStats(rows: Record<string, string>[], mapping: Record<string, string>): { keyed: number; unkeyed: number; people: number; repeated: number; collapsing: boolean } {
  const seen = new Set<string>(); let keyed = 0; let unkeyed = 0;
  for (const row of rows) {
    const k = dedupeKey(row, mapping);
    if (!k) { unkeyed++; continue; }
    keyed++; seen.add(`${k.kind}:${k.value}`);
  }
  return { keyed, unkeyed, people: seen.size, repeated: keyed - seen.size, collapsing: keyed >= 10 && seen.size * 2 < keyed };
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString();
}
