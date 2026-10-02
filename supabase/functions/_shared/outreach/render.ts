// Template rendering for the executor, the planner and the workers (Deno).
// Everything below this header is IDENTICAL to lib/outreach/render.ts (the builder preview). Edit both together;
// scripts/outreach-render-test.sh fails when the two drift apart.

/*
 * Syntax
 *   {{first_name|fallback}}             variable with an optional fallback
 *   {{ first_name }} {{ position }}     the Insert Variables names (VARIABLE_ALIASES maps each one to a path below)
 *   {{company}} {{lead.company}}        lead fields (bare names, or with the lead. prefix)
 *   {{custom.x}}                        lead custom fields
 *   {{sender.first_name}} {{sender.signature}} {{sender.booking_link}}
 *   {{enrich.about}} {{ai.icebreaker}}  stored enrichment / APPROVED AI text (the render context only carries approved text)
 *   {{ai.research.pain}}                one field of an AI variable whose output is Fields (text, number, yes/no, choice)
 *   {{account.industry}} {{now.month}}  the lead's current company / today's date in the lead's timezone
 *   {{unsubscribe_link}} {{booking_link}}
 *   {{ position | lowercase }}          filters: lowercase, uppercase, capitalize_each_word, plural. They apply left to
 *                                       right to the text that is used: the value, or the fallback
 *   {Hi|Hello|Hey}                      spintax: single braces with at least one pipe, never {{…}}
 *   {{ "Hey|Hello" | spintax }}         the same spintax, written as a quoted list
 *   {{#if company}}at {{company}}{{else}}…{{/if}}   conditional text; truthy = the path resolves to a non-empty value that is
 *                                       not `false`; nesting is allowed
 *   {{#if title == "CEO"}}…{{/if}}      true when the value equals the text (trimmed, case-insensitive)
 *   {% if x %}…{% else %}…{% endif %}   the same conditionals, written as tags (also {% if x == "y" %})
 *
 * Order of evaluation (this order is load-bearing):
 *   0. normalize     {% … %} tags and quoted spintax are rewritten into the native syntax, on the TEMPLATE only.
 *   1. spintax       on the normalized template. Groups are numbered by their position in it and the option is
 *                    picked with hash(seed + ':' + index), so the builder preview (same seed = the enrollment id) is
 *                    exactly what gets sent, and the pick does not move when a conditional flips. No seed → first option.
 *   2. conditionals  on the template text, against the context.
 *   3. variables     last, in ONE pass whose output is never scanned again. A VALUE such as "{a|b}", "{{#if x}}" or
 *                    "{% if x %}" is therefore always literal text: it can never turn into spintax, a conditional or
 *                    another variable.
 * A spintax option cannot contain braces (same rule as SQL outreach_spintax_info), so "{Hi {{first_name}}|Hello}" is not
 * spintax; write "{Hi|Hello} {{first_name}}" instead.
 */

export interface RenderContext {
  lead: Record<string, any>;
  sender?: Record<string, any> | null;
  enrich?: Record<string, any> | null;
  ai?: Record<string, any> | null;
  /** The lead's current company (outreach_companies), when one is stored. */
  account?: Record<string, unknown> | null;
  /** Today's date parts ({day, month, weekday, year, time_of_day}) in the lead's timezone, else the sender's. */
  now?: Record<string, unknown> | null;
  /** Spintax seed: the enrollment id (outreach_render_context returns it). */
  seed?: string | null;
  unsubscribe_link?: string | null;
  booking_link?: string | null;
}

/**
 * The Insert Variables names. Each maps to one path, or to a list where the first non-empty value wins.
 * The company prefix is `account`, not `company`: bare {{company}} already means the lead's company text.
 * `tags` and `work_email_domain` are keys of the lead object itself, so they need no alias.
 */
export const VARIABLE_ALIASES: Record<string, string | string[]> = {
  // AI (the built-ins fall back to the raw field when there is no approved value)
  ai_contact_first_name: ['ai.contact_first_name', 'first_name'],
  ai_company_conversation: ['ai.company_conversation', 'enrich.current_company', 'company'],
  ai_position_conversational: ['ai.position_conversational', 'enrich.current_title', 'title'],
  // Contact
  position: 'title', about: 'enrich.about', work_email: 'email_work', personal_email: 'email_personal',
  mobile_phone: ['phone', 'enrich.phone'], work_phone: 'custom.work_phone', contact_uuid: 'id',
  linkedin_nickname: 'public_identifier', ln_id: 'provider_id', sn_id: 'enrich.sn_id',
  last_enrich_at: 'enrich.last_enrich_at', twitter_url: 'enrich.twitter_url', facebook_url: 'enrich.facebook_url',
  location_city: 'enrich.location_city', location_country: 'enrich.location_country', location_address_string: 'location',
  location_region: 'enrich.location_region', location_timezone: 'enrich.location_timezone',
  primary_language: 'enrich.language', connections_number: 'enrich.connections_count', followers_number: 'enrich.follower_count',
  skills: 'enrich.skills', current_company: ['enrich.current_company', 'company'],
  current_position: ['enrich.current_title', 'title'], current_company_start_date: 'enrich.current_started_on',
  current_company_duration: 'enrich.current_duration', previous_company: 'enrich.previous_company',
  previous_position: 'enrich.previous_title', experience_summary: 'enrich.experience_summary',
  education_school: 'enrich.school', education_degree: 'enrich.degree', education_field: 'enrich.education_field',
  education_summary: 'enrich.education_summary', latest_post: 'enrich.recent_post',
  latest_post_date: 'enrich.recent_post_date', last_3_posts: 'enrich.last_3_posts',
  // Account
  company_name: ['account.name', 'company'], company_domain: ['account.domain', 'company_domain'],
  company_website: 'account.website', company_uuid: 'account.id', company_linkedin: 'account.linkedin_url',
  company_ln_id: ['account.linkedin_id', 'company_id'], company_phone: 'account.phone',
  company_industry: 'account.industry', company_size: 'account.size', company_year_established: 'account.founded_year',
  company_tagline: 'account.tagline', company_about: 'account.about', company_specialties: 'account.specialties',
  company_hashtags: 'account.hashtags', company_followers: 'account.followers',
  company_employees_on_linkedin: 'account.employees_on_linkedin', company_deal_size: 'custom.company_deal_size',
  company_location_city: 'account.hq.city', company_location_country: 'account.hq.country',
  company_location_address_string: 'account.hq.address', company_location_region: 'account.hq.region',
  // Sender
  sender_first_name: 'sender.first_name', sender_last_name: 'sender.last_name', sender_full_name: 'sender.full_name',
  sender_email: 'sender.email', sender_label: ['sender.label', 'sender.full_name'],
  sender_booking_link: 'sender.booking_link', sender_signature: 'sender.signature',
  // Advanced
  now_day: 'now.day', now_month: 'now.month', now_time_of_day: 'now.time_of_day', now_weekday: 'now.weekday', now_year: 'now.year',
};

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/g;
// Same pattern as SQL outreach_spintax_info (migrations/outreach/011_engine_v2.sql).
const SPIN_RE = /(?<!\{)\{(?!\{)([^{}|]*(?:\|[^{}]*)+)\}(?!\})/g;
const COND_RE = /\{\{\s*#if\s+([a-zA-Z0-9_.]+)(?:\s*==\s*"([^"{}]*)")?\s*\}\}|\{\{\s*else\s*\}\}|\{\{\s*\/if\s*\}\}/g;
const COND_TAG_RE = /\{\{\s*[#/]if[^}]*\}\}/g;
const RESERVED = new Set(['else']);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim() === '');
}

/** Empty for {{#if}}: also `false` (a Yes/No AI field) and an empty list. Used only by applyConditionals. */
function isFalsy(v: unknown): boolean {
  return isEmpty(v) || v === false || (Array.isArray(v) && v.length === 0);
}

function resolvePath(path: string, ctx: RenderContext): unknown {
  if (path === 'unsubscribe_link') return ctx.unsubscribe_link ?? undefined;
  if (path === 'booking_link') return ctx.booking_link ?? ctx.sender?.booking_link ?? undefined;
  const parts = path.split('.');
  let cur: any;
  if (parts[0] === 'sender') { cur = ctx.sender ?? {}; parts.shift(); }
  else if (parts[0] === 'custom') { cur = ctx.lead?.custom ?? {}; parts.shift(); }
  else if (parts[0] === 'enrich') { cur = ctx.enrich ?? {}; parts.shift(); }
  else if (parts[0] === 'ai') { cur = ctx.ai ?? {}; parts.shift(); }
  else if (parts[0] === 'account') { cur = ctx.account ?? {}; parts.shift(); }
  else if (parts[0] === 'now') { cur = ctx.now ?? {}; parts.shift(); }
  else if (parts[0] === 'lead') { cur = ctx.lead ?? {}; parts.shift(); }
  else cur = ctx.lead ?? {};
  if (parts.length === 0) return undefined;
  for (const p of parts) {
    // own keys of objects only: {{constructor}} or {{title.length}} is not a field
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = own(cur, p) ? cur[p] : undefined;
  }
  if (cur === undefined || cur === null) {
    const bare = path.startsWith('lead.') ? path.slice(5) : path;
    if (bare === 'first_name' && ctx.lead?.full_name) return String(ctx.lead.full_name).split(' ')[0];
    if (path === 'sender.first_name' && ctx.sender?.display_name) return String(ctx.sender.display_name).split(' ')[0];
    if (path === 'sender.full_name' && ctx.sender?.display_name) return ctx.sender.display_name;
  }
  return cur;
}

/** A name from VARIABLE_ALIASES resolves to its first non-empty path. Aliases are never resolved twice. */
function resolve(path: string, ctx: RenderContext): unknown {
  if (!own(VARIABLE_ALIASES, path)) return resolvePath(path, ctx);
  const alias = VARIABLE_ALIASES[path];
  let v: unknown;
  for (const p of typeof alias === 'string' ? [alias] : alias) {
    v = resolvePath(p, ctx);
    if (!isEmpty(v)) return v;
  }
  return v;
}

function stringify(v: unknown): string {
  if (Array.isArray(v)) return v.filter((x) => !isEmpty(x)).join(', ');
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
function pluralWord(w: string): string {
  if (!w || /s$/i.test(w)) return w;                                     // Sales, Ops, Partners: leave alone
  if (/^[A-Z0-9]{2,5}$/.test(w)) return w + 's';                          // CEO → CEOs, VP → VPs
  const up = w.length > 1 && w === w.toUpperCase();
  if (/(x|z|ch|sh)$/i.test(w)) return w + (up ? 'ES' : 'es');
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + (up ? 'IES' : 'ies');
  return w + (up ? 'S' : 's');
}

/** "Head of Growth" → "Heads of Growth": the word before of / at / for / in is the one made plural, else the last word. */
function pluralize(s: string): string {
  const m = /^(.*?)(\S+)(\s+(?:of|at|for|in)\s.*)$/i.exec(s);
  return m ? m[1] + pluralWord(m[2]) + m[3] : s.replace(/(\S+)(\s*)$/, (_x, w: string, sp: string) => pluralWord(w) + sp);
}

const FILTERS: Record<string, (s: string) => string> = {
  lowercase: (s) => s.toLowerCase(),
  uppercase: (s) => s.toUpperCase(),
  capitalize_each_word: (s) => s.replace(/(^|[\s\-/(&])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase()),
  plural: pluralize,
};

/** The filter names, for the builder's "did you mean" check. */
export const TEMPLATE_FILTERS: string[] = Object.keys(FILTERS);

/**
 * What follows the name in {{name | … }}: every segment that is exactly a filter name is a filter, the rest is the
 * fallback. Without a filter the fallback is the text as written, so templates from before filters render the same.
 */
function splitPipes(rest?: string): { filters: string[]; fallback: string } {
  const raw = rest ?? '';
  const filters: string[] = [];
  const other: string[] = [];
  for (const seg of raw.split('|')) {
    const t = seg.trim();
    if (own(FILTERS, t)) filters.push(t);
    else if (t) other.push(t);
  }
  return { filters, fallback: filters.length ? other.join('|') : raw.trim() };
}

// ---------------------------------------------------------------------------
// Tags → native syntax
// ---------------------------------------------------------------------------
/** Mirrors SQL outreach_template_normalize: the same five replacements in the same order. */
export function normalizeTemplate(t: string): string {
  if (t.indexOf('{%') === -1 && t.indexOf('spintax') === -1) return t;
  return t
    .replace(/\{\{\s*"([^"{}]*\|[^"{}]*)"\s*\|\s*spintax\s*\}\}/g, '{$1}')                         // {{ "a|b" | spintax }} → {a|b}
    .replace(/\{%-?\s*if\s+([a-zA-Z0-9_.]+)\s*==\s*"([^"{}%]*)"\s*-?%\}/g, '{{#if $1 == "$2"}}')
    .replace(/\{%-?\s*if\s+([a-zA-Z0-9_.]+)\s*-?%\}/g, '{{#if $1}}')
    .replace(/\{%-?\s*else\s*-?%\}/g, '{{else}}')
    .replace(/\{%-?\s*endif\s*-?%\}/g, '{{/if}}');
}

/** FNV-1a (32 bit). Small, stable, and the same in every JS runtime. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function applySpintax(template: string, seed: string | null | undefined): string {
  let index = 0;
  return template.replace(new RegExp(SPIN_RE.source, 'g'), (_m, body: string) => {
    const options = body.split('|');
    const i = index++;
    if (isEmpty(seed)) return options[0];
    return options[hash32(`${seed}:${i}`) % options.length];
  });
}

interface CondNode { path: string | null; equals: string | null; yes: Array<string | CondNode>; no: Array<string | CondNode>; inElse: boolean }

function condHolds(node: CondNode, ctx: RenderContext): boolean {
  const v = resolve(node.path as string, ctx);
  if (node.equals === null) return !isFalsy(v);
  // the same comparison as a Condition step: trimmed, case-insensitive; an empty value equals ""
  return (isEmpty(v) ? '' : stringify(v)).trim().toLowerCase() === node.equals.trim().toLowerCase();
}

function applyConditionals(template: string, ctx: RenderContext): string {
  if (template.indexOf('{{') === -1) return template;
  const root: CondNode = { path: null, equals: null, yes: [], no: [], inElse: false };
  const stack: CondNode[] = [root];
  const push = (x: string | CondNode) => { const top = stack[stack.length - 1]; (top.inElse ? top.no : top.yes).push(x); };
  const re = new RegExp(COND_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    if (m.index > last) push(template.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) { const node: CondNode = { path: m[1], equals: m[2] ?? null, yes: [], no: [], inElse: false }; push(node); stack.push(node); }
    else if (/else/.test(m[0])) { if (stack.length > 1) stack[stack.length - 1].inElse = true; }   // a stray {{else}} is dropped
    else if (stack.length > 1) stack.pop();                                                       // a stray {{/if}} is dropped
  }
  if (last < template.length) push(template.slice(last));
  const out = (parts: Array<string | CondNode>): string =>
    parts.map((p) => (typeof p === 'string' ? p : out(condHolds(p, ctx) ? p.yes : p.no))).join('');
  return out(root.yes);
}

/** The value a {{name}} prints, or undefined when it prints nothing of its own (the fallback is used). */
function printable(name: string, ctx: RenderContext): unknown {
  const v = resolve(name, ctx);
  // {{ai.research}} of a Fields variable is an object: there is no text to print, so it never sends raw JSON
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && name.startsWith('ai.')) return undefined;
  return v;
}

function applyVariables(template: string, ctx: RenderContext): string {
  return template.replace(new RegExp(VAR_RE.source, 'g'), (_m, name: string, rest?: string) => {
    const { filters, fallback } = splitPipes(rest);
    const v = printable(name, ctx);
    const text = isEmpty(v) ? fallback : stringify(v);
    return filters.reduce((s, f) => FILTERS[f](s), text);
  });
}

export function renderTemplate(template: string | null | undefined, ctx: RenderContext): string {
  if (!template) return '';
  const c = ctx ?? { lead: {} };
  return applyVariables(applyConditionals(applySpintax(normalizeTemplate(template), c.seed), c), c);
}

/** Variables used as {{name}} (conditions in {{#if name}} are optional by definition and are not listed). */
export function templateVariables(template: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(VAR_RE.source, 'g');
  const text = normalizeTemplate(template ?? '');
  while ((m = re.exec(text))) if (!RESERVED.has(m[1])) out.add(m[1]);
  return [...out];
}

/** Variables that would render as nothing for this context: empty value and no fallback. Untaken conditional branches do not count. */
export function missingVariables(template: string, ctx: RenderContext): string[] {
  const missing: string[] = [];
  const text = applyConditionals(normalizeTemplate(template ?? ''), ctx);
  const re = new RegExp(VAR_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (RESERVED.has(m[1])) continue;
    if (isEmpty(printable(m[1], ctx)) && !splitPipes(m[2]).fallback && !missing.includes(m[1])) missing.push(m[1]);
  }
  return missing;
}

/**
 * Longest possible text and the number of spintax combinations. Mirrors SQL outreach_spintax_info step by step:
 * the template is normalized first, identical groups are replaced together and counted once, combinations are capped
 * at 1e9, the {{#if}} / {{/if}} tags are stripped (every branch counts at full length), and length is in characters,
 * not UTF-16 units.
 */
export function spintaxInfo(text: string | null | undefined): { maxLen: number; combinations: number } {
  let t = normalizeTemplate(text ?? '');
  let combinations = 1;
  for (let guard = 0; guard < 200; guard++) {
    const m = new RegExp(SPIN_RE.source).exec(t);
    if (!m) break;
    const options = m[1].split('|');
    let longest = '';
    for (const o of options) if ([...o].length > [...longest].length) longest = o;
    combinations = Math.min(combinations * options.length, 1000000000);
    t = t.split('{' + m[1] + '}').join(longest);
  }
  t = t.replace(new RegExp(COND_TAG_RE.source, 'g'), '');
  return { maxLen: [...t].length, combinations };
}

/** Add one query parameter without touching the rest of the URL. Invalid URLs come back unchanged. */
function withParam(url: string, key: string, value: string): string {
  if (!url || !value) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const frag = hashAt === -1 ? '' : url.slice(hashAt);
  const k = encodeURIComponent(key);
  if (base.indexOf('?' + k + '=') !== -1 || base.indexOf('&' + k + '=') !== -1) return url;
  return base + (base.indexOf('?') === -1 ? '?' : '&') + k + '=' + encodeURIComponent(value) + frag;
}

/**
 * {day, month, weekday, year, time_of_day} for an instant in a timezone: the shape outreach_render_context returns as
 * `now`. time_of_day: 05–11 morning, 12–16 afternoon, otherwise evening. An unknown timezone counts as UTC.
 */
export function nowParts(timeZone?: string | null, at: Date = new Date()): { day: string; month: string; weekday: string; year: string; time_of_day: string } {
  const parts = (tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric', month: 'long', weekday: 'long', year: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  let list: Intl.DateTimeFormatPart[];
  try { list = parts(timeZone || 'UTC'); } catch { list = parts('UTC'); }
  const get = (type: string) => list.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  return { day: get('day'), month: get('month'), weekday: get('weekday'), year: get('year'), time_of_day: hour >= 5 && hour <= 11 ? 'morning' : hour >= 12 && hour <= 16 ? 'afternoon' : 'evening' };
}

/**
 * Turn the JSON returned by the RPC outreach_render_context into a render context.
 * extras: unsubscribe_link (built by the executor from the signed token), booking_link (overrides the sender's),
 * seed (overrides the one from the RPC), lead / sender (shallow patches, e.g. the post text for comment steps).
 * The booking link carries the lead id as utm_content so the booking webhook can find the lead.
 * `now` comes from the RPC (the lead's timezone, else the sender's); without it, it is the clock in the sender's timezone.
 */
export function buildContext(
  renderCtxJson: Record<string, any> | null | undefined,
  extras: { unsubscribe_link?: string | null; booking_link?: string | null; seed?: string | null; lead?: Record<string, any>; sender?: Record<string, any> } = {},
): RenderContext {
  const j = renderCtxJson ?? {};
  const lead: Record<string, any> = { ...(j.lead ?? {}), ...(extras.lead ?? {}) };
  const sender: Record<string, any> = { ...(j.sender ?? {}), ...(extras.sender ?? {}) };
  const rawBooking = extras.booking_link ?? sender.booking_link ?? null;
  let booking = rawBooking ? withParam(String(rawBooking), 'utm_content', lead.id ? String(lead.id) : '') : null;
  // Cal.com does not echo utm parameters to its webhook, only metadata[...]: give it both so the booking finds the lead.
  if (booking && lead.id && /^https:\/\/([a-z0-9-]+\.)*cal\.(com|eu|dev)\//i.test(booking)) booking = withParam(booking, 'metadata[lead_id]', String(lead.id));
  if (booking) sender.booking_link = booking;
  return {
    lead,
    sender,
    enrich: j.enrich ?? {},
    ai: j.ai ?? {},
    account: j.account ?? {},
    now: j.now ?? nowParts(typeof sender.timezone === 'string' ? sender.timezone : null),
    seed: extras.seed ?? j.seed ?? null,
    unsubscribe_link: extras.unsubscribe_link ?? null,
    booking_link: booking,
  };
}
