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
  if (l.public_identifier) return `https://www.linkedin.com/in/${l.public_identifier}`;
  return null;
}

/** Extract the public identifier from a LinkedIn profile URL (lowercased), or null. */
export function pubIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

/** Accepts either a LinkedIn URL, `in/<id>` or a bare public identifier and returns the lowercased identifier. */
export function normalizePublicIdentifier(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  const fromUrl = pubIdFromUrl(s);
  if (fromUrl) return fromUrl;
  if (/^https?:\/\//i.test(s)) return null;
  return s.replace(/^\/?in\//i, '').replace(/[/?#].*$/, '').toLowerCase() || null;
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
export const LEAD_FIELDS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Skip column' },
  { value: 'linkedin_url', label: 'LinkedIn URL' },
  { value: 'public_identifier', label: 'LinkedIn public identifier' },
  { value: 'first_name', label: 'First name' },
  { value: 'last_name', label: 'Last name' },
  { value: 'full_name', label: 'Full name' },
  { value: 'headline', label: 'Headline' },
  { value: 'company', label: 'Company' },
  { value: 'title', label: 'Title' },
  { value: 'location', label: 'Location' },
  { value: 'email_work', label: 'Work email' },
  { value: 'email_personal', label: 'Personal email' },
  { value: 'custom', label: 'Custom field…' },
];

const GUESSES: Array<[RegExp, string]> = [
  [/linkedin|profile.?url|li.?url/i, 'linkedin_url'],
  [/public.?id|slug|vanity/i, 'public_identifier'],
  [/^(first|given).?name$|^first$/i, 'first_name'],
  [/^(last|family|sur).?name$|^last$/i, 'last_name'],
  [/^(full.?)?name$|^contact$/i, 'full_name'],
  [/headline|tagline/i, 'headline'],
  [/^(company|organi[sz]ation|employer|account)(.?name)?$/i, 'company'],
  [/^(job.?)?title$|^position$|^role$/i, 'title'],
  [/location|city|country|region/i, 'location'],
  [/work.?e-?mail|business.?e-?mail|^e-?mail$|^email.?address$/i, 'email_work'],
  [/personal.?e-?mail|private.?e-?mail|home.?e-?mail/i, 'email_personal'],
];

/** Guess the lead field for a CSV header. Returns '' when unsure. */
export function guessField(header: string): string {
  const h = header.trim();
  if (!h) return '';
  for (const [re, field] of GUESSES) if (re.test(h)) return field;
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
    if ((field === 'linkedin_url' || field === 'public_identifier') && !pub) pub = normalizePublicIdentifier(v);
    if ((field === 'email_work' || field === 'email_personal') && !email) email = v.toLowerCase();
  }
  if (pub) return { kind: 'public_identifier', value: pub };
  if (email) return { kind: 'email', value: email };
  return null;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString();
}
