// The Insert Variables catalogue (ai-fields-json-changes.md Part B; docs/outreach/AI-FIELDS.md): the single source of
// what the popup in a message box lists. Every token here renders at send time: a name is either an alias in
// lib/outreach/render.ts (VARIABLE_ALIASES) or a path the renderer resolves itself. The workspace's own AI variables,
// their fields and the custom field keys are added at runtime (workspaceRows).
import { renderTemplate, type RenderContext } from './render';
import { fieldPath, variableFields } from './aiFields';
import type { AiField } from './types';

export type VariableTab = 'ai' | 'contact' | 'account' | 'sender' | 'advanced';
export const VARIABLE_TABS: Array<{ id: VariableTab; label: string; footer: string }> = [
  { id: 'ai', label: 'AI Variables', footer: 'Only approved lines are used. Add a fallback after a pipe for everything else.' },
  { id: 'contact', label: 'Contact', footer: 'Add a fallback after a pipe: {{ first_name | there }}' },
  { id: 'account', label: 'Account', footer: 'Add a fallback: not every company has every field.' },
  { id: 'sender', label: 'Sender Profile', footer: 'Add a fallback after a pipe: {{ sender_label | our team }}' },
  { id: 'advanced', label: 'Advanced', footer: 'Filters go after a pipe and can be chained: {{ position | capitalize_each_word | plural }}' },
];

/** How a click on the row edits the message. */
export type VariableInsert =
  | 'token'      // the token is inserted at the cursor, replacing the selection
  | 'if'         // a conditional: the selection is wrapped by the opening tag and what follows; the cursor lands inside the if
  | 'spintax';   // inserted like a token (kept apart so plain fields can hide it)

export interface CatalogVariable {
  tab: VariableTab;
  /** The text shown in the Variable Name column and inserted, exactly as written. */
  token: string;
  /** For 'if' rows: the opening tag. The rest of `token` goes after the selection. */
  open?: string;
  insert: VariableInsert;
  /** The Example column: what EXAMPLE_LEAD (a made-up lead) would get. Not shown on the AI Variables tab. */
  sample: string;
  /** A description shown instead of a rendered example (conditionals). */
  describe?: string;
  /** Email steps only (the unsubscribe link, the signature). */
  emailOnly?: boolean;
  /** Hidden in URL and JSON fields (`plain`): conditionals and spintax. */
  plainHidden?: boolean;
  /** A small heading the row sits under ("Your variables", "Custom fields"). */
  section?: string;
}

const row = (tab: VariableTab, name: string, sample: string, extra: Partial<CatalogVariable> = {}): CatalogVariable =>
  ({ tab, token: `{{ ${name} }}`, insert: 'token', sample, ...extra });
const ifRow = (tab: VariableTab, open: string, rest: string, describe: string, extra: Partial<CatalogVariable> = {}): CatalogVariable =>
  ({ tab, token: open + rest, open, insert: 'if', sample: '', describe, plainHidden: true, ...extra });

/** The made-up lead every Example is written for (Contact, Account, Advanced); Rohan Mehta is the made-up sender. */
export const EXAMPLE_LEAD = 'Priya Sharma';

export const VARIABLE_CATALOG: CatalogVariable[] = [
  // ---------------------------------------------------------------- AI Variables: the three built-ins
  row('ai', 'ai_contact_first_name', 'Priya'),
  row('ai', 'ai_company_conversation', 'Acme'),
  row('ai', 'ai_position_conversational', 'VP of Sales'),

  // ---------------------------------------------------------------- Contact
  row('contact', 'full_name', 'Priya Sharma'),
  row('contact', 'first_name', 'Priya'),
  row('contact', 'last_name', 'Sharma'),
  row('contact', 'position', 'Head of Growth'),
  row('contact', 'headline', 'Growth @ Acme Technologies · ex-Globex'),
  row('contact', 'about', 'I build growth teams for B2B SaaS companies…'),
  row('contact', 'work_email', 'priya@acme.com'),
  row('contact', 'personal_email', 'priya.sharma@gmail.com'),
  row('contact', 'mobile_phone', '+91 98450 12345'),
  row('contact', 'work_phone', '+91 80 4000 1234'),
  row('contact', 'contact_uuid', '3f1c9a6e-2b7d-4e0a-9c1d-5a8b7e6f4d21'),
  row('contact', 'linkedin_nickname', 'priya-sharma'),
  row('contact', 'ln_id', 'ACoAAB1x2yQBk…'),
  row('contact', 'sn_id', 'ACwAAB1x2yQBk…'),
  row('contact', 'last_enrich_at', 'Oct 1, 2026'),
  row('contact', 'twitter_url', 'https://x.com/priyasharma'),
  row('contact', 'facebook_url', 'https://facebook.com/priya.sharma'),
  row('contact', 'location_city', 'Bengaluru'),
  row('contact', 'location_country', 'India'),
  row('contact', 'location_address_string', 'Bengaluru, Karnataka, India'),
  row('contact', 'location_region', 'Karnataka'),
  row('contact', 'location_timezone', 'Asia/Kolkata'),
  row('contact', 'primary_language', 'en'),
  row('contact', 'connections_number', '500'),
  row('contact', 'followers_number', '1,240'),
  row('contact', 'skills', 'Growth, SEO, Paid social'),
  row('contact', 'tags', 'vip, q4-campaign'),
  row('contact', 'current_company', 'Acme Technologies'),
  row('contact', 'work_email_domain', 'acme.com'),
  row('contact', 'current_position', 'Head of Growth'),
  row('contact', 'current_company_start_date', 'Mar 2022'),
  row('contact', 'current_company_duration', '4 yrs 7 mos'),
  row('contact', 'previous_company', 'Globex'),
  row('contact', 'previous_position', 'Growth Manager'),
  row('contact', 'experience_summary', 'Head of Growth at Acme Technologies (2022–present); Growth Manager at Globex (2019–2022)'),
  row('contact', 'education_school', 'IIM Bangalore'),
  row('contact', 'education_degree', 'MBA'),
  row('contact', 'education_field', 'Marketing'),
  row('contact', 'education_summary', 'MBA, Marketing — IIM Bangalore'),
  row('contact', 'latest_post', 'We just opened our Berlin office…'),
  row('contact', 'latest_post_date', 'Sep 20'),
  row('contact', 'last_3_posts', 'We just opened our Berlin office…'),
  // kept from the picker this popup replaces, so no option is lost
  row('contact', 'enrich.years_in_role', '4', { section: 'More profile data' }),
  row('contact', 'enrich.months_in_role', '55', { section: 'More profile data' }),
  row('contact', 'enrich.top_skill', 'Growth', { section: 'More profile data' }),

  // ---------------------------------------------------------------- Account (the lead's current company)
  row('account', 'company_name', 'Acme Technologies'),
  row('account', 'company_domain', 'acme.com'),
  row('account', 'company_website', 'https://acme.com'),
  row('account', 'company_uuid', '8c2e41d7-6a90-4f3b-b1c5-0d9e7f2a6b34'),
  row('account', 'company_linkedin', 'https://www.linkedin.com/company/acme'),
  row('account', 'company_ln_id', '1441'),
  row('account', 'company_phone', '+91 80 1234 5678'),
  row('account', 'company_industry', 'Software Development'),
  row('account', 'company_size', '51-200'),
  row('account', 'company_year_established', '2015'),
  row('account', 'company_tagline', 'Outbound, simplified'),
  row('account', 'company_about', 'Acme builds outbound tools for B2B sales teams…'),
  row('account', 'company_specialties', 'Outbound, Sales engagement'),
  row('account', 'company_hashtags', '#outbound, #sales'),
  row('account', 'company_followers', '18,200'),
  row('account', 'company_employees_on_linkedin', '140'),
  row('account', 'company_deal_size', '50k'),
  row('account', 'company_location_city', 'Bengaluru'),
  row('account', 'company_location_country', 'India'),
  row('account', 'company_location_address_string', '12 MG Road, Bengaluru, Karnataka, India'),
  row('account', 'company_location_region', 'Karnataka'),

  // ---------------------------------------------------------------- Sender Profile
  row('sender', 'sender_first_name', 'Rohan'),
  row('sender', 'sender_last_name', 'Mehta'),
  row('sender', 'sender_full_name', 'Rohan Mehta'),
  row('sender', 'sender_email', 'rohan@brightwave.io'),
  row('sender', 'sender_label', 'Rohan from Brightwave'),
  row('sender', 'sender_booking_link', 'https://cal.com/rohan-mehta/intro'),
  row('sender', 'sender_signature', 'Rohan Mehta · Brightwave', { emailOnly: true }),

  // ---------------------------------------------------------------- Advanced
  row('advanced', 'now_day', '14'),
  row('advanced', 'now_month', 'October'),
  row('advanced', 'now_time_of_day', 'morning'),
  row('advanced', 'now_weekday', 'Wednesday'),
  row('advanced', 'now_year', '2026'),
  ifRow('advanced', '{% if first_name %}', '{% else %}{% endif %}', 'Hi Priya (only when first_name has a value)'),
  ifRow('advanced', '{% if first_name == "John" %}', '{% else %}{% endif %}', 'Shown only when first_name is John (not for Priya)'),
  { tab: 'advanced', token: '{{ "Hey|Hello|Bonjour" | spintax }}', insert: 'spintax', sample: 'Hey / Hello / Bonjour (one per lead)', plainHidden: true },
  row('advanced', 'position | lowercase', 'head of growth'),
  row('advanced', 'position | uppercase', 'HEAD OF GROWTH'),
  row('advanced', 'position | capitalize_each_word', 'Head Of Growth'),
  row('advanced', 'position | plural', 'Heads of Growth'),
  row('advanced', 'position | capitalize_each_word | plural', 'Heads Of Growth'),
  row('advanced', 'unsubscribe_link', 'https://example.com/unsubscribe/priya', { emailOnly: true }),
];

/** An AI variable as the popup needs it (a row of outreach_ai_variables). */
export interface PopupAiVariable { key: string; name: string; fallback?: string | null; output?: string | null; fields?: AiField[] | null; builtin?: boolean | null }

/**
 * The rows that depend on the workspace: its own AI variables (one row per one-line variable, one per field of a Fields
 * variable; a Yes/No field inserts the conditional, because printing it gives true / false) and its custom field keys.
 */
export function workspaceRows(aiVars: PopupAiVariable[] | null | undefined, customKeys: string[]): CatalogVariable[] {
  const out: CatalogVariable[] = [];
  for (const v of aiVars ?? []) {
    if (v.builtin) continue;
    const fields = variableFields(v);
    if (v.output === 'fields') {
      for (const f of fields) {
        const path = fieldPath(v.key, f.key);
        if (f.type === 'yes_no') out.push({ tab: 'ai', token: `{{#if ${path}}}{{/if}}`, open: `{{#if ${path}}}`, insert: 'if', sample: '', describe: `Text shown only when ${v.name} · ${f.name} is yes`, plainHidden: true, section: `Your variables · ${v.name}` });
        else out.push({ tab: 'ai', token: `{{ ${path} }}`, insert: 'token', sample: f.type === 'number' ? '40' : f.type === 'choice' ? f.options?.[0] ?? '' : f.name, section: `Your variables · ${v.name}` });
      }
    } else {
      const fb = (v.fallback ?? '').trim();
      out.push({ tab: 'ai', token: fb ? `{{ ai.${v.key} | ${fb} }}` : `{{ ai.${v.key} }}`, insert: 'token', sample: v.name, section: 'Your variables' });
    }
  }
  for (const k of customKeys) out.push({ tab: 'contact', token: `{{ custom.${k} }}`, insert: 'token', sample: `Priya's ${k.replace(/_/g, ' ')}`, section: 'Custom fields' });
  return out;
}

/**
 * The Example column: the token rendered by the real renderer for the preview lead, so it is what would be sent.
 * null = this row has no value of its own to show (a conditional). '' = the lead has no value for it.
 */
export function exampleFor(v: CatalogVariable, ctx: RenderContext | null | undefined): string | null {
  if (v.insert === 'if') return null;
  if (!ctx) return null;
  // a token with a fallback would show the fallback for an empty value: the example is the value itself
  const bare = v.tab === 'ai' && v.token.includes('|') && !v.token.includes('spintax') ? v.token.replace(/\s*\|[^}]*\}\}$/, ' }}') : v.token;
  return renderTemplate(bare, ctx).replace(/\s+/g, ' ').trim();
}

/** Rows a search matches: the variable name as written, case-insensitive. */
export function matchesSearch(v: CatalogVariable, q: string): boolean {
  const s = q.trim().toLowerCase();
  return !s || v.token.toLowerCase().includes(s);
}

/** Rows shown for a field: email-only rows on email steps only; conditionals and spintax not in URL / JSON fields. */
export function visibleRows(rows: CatalogVariable[], opts: { channel: 'linkedin' | 'email'; plain: boolean }): CatalogVariable[] {
  return rows.filter((v) => (opts.channel === 'email' || !v.emailOnly) && !(opts.plain && v.plainHidden));
}
