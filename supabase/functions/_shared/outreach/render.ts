// Template rendering for the executor, the planner and the workers (Deno).
// Everything below this header is IDENTICAL to lib/outreach/render.ts (the builder preview). Edit both together;
// scripts/outreach-render-test.sh fails when the two drift apart.

/*
 * Syntax
 *   {{first_name|fallback}}             variable with an optional fallback
 *   {{company}} {{lead.company}}        lead fields (bare names, or with the lead. prefix)
 *   {{custom.x}}                        lead custom fields
 *   {{sender.first_name}} {{sender.signature}} {{sender.booking_link}}
 *   {{enrich.about}} {{ai.icebreaker}}  stored enrichment / APPROVED AI text (the render context only carries approved text)
 *   {{unsubscribe_link}} {{booking_link}}
 *   {Hi|Hello|Hey}                      spintax: single braces with at least one pipe, never {{…}}
 *   {{#if company}}at {{company}}{{else}}…{{/if}}   conditional text; truthy = the path resolves to a non-empty value; nesting is allowed
 *
 * Order of evaluation (this order is load-bearing):
 *   1. spintax       on the RAW template. Groups are numbered by their position in the raw template and the option is
 *                    picked with hash(seed + ':' + index), so the builder preview (same seed = the enrollment id) is
 *                    exactly what gets sent, and the pick does not move when a conditional flips. No seed → first option.
 *   2. conditionals  on the template text, against the context.
 *   3. variables     last, in ONE pass whose output is never scanned again. A VALUE such as "{a|b}" or "{{#if x}}"
 *                    is therefore always literal text: it can never turn into spintax, a conditional or another variable.
 * A spintax option cannot contain braces (same rule as SQL outreach_spintax_info), so "{Hi {{first_name}}|Hello}" is not
 * spintax; write "{Hi|Hello} {{first_name}}" instead.
 */

export interface RenderContext {
  lead: Record<string, any>;
  sender?: Record<string, any> | null;
  enrich?: Record<string, any> | null;
  ai?: Record<string, any> | null;
  /** Spintax seed: the enrollment id (outreach_render_context returns it). */
  seed?: string | null;
  unsubscribe_link?: string | null;
  booking_link?: string | null;
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/g;
// Same pattern as SQL outreach_spintax_info (migrations/outreach/011_engine_v2.sql).
const SPIN_RE = /(?<!\{)\{(?!\{)([^{}|]*(?:\|[^{}]*)+)\}(?!\})/g;
const COND_RE = /\{\{\s*#if\s+([a-zA-Z0-9_.]+)\s*\}\}|\{\{\s*else\s*\}\}|\{\{\s*\/if\s*\}\}/g;
const COND_TAG_RE = /\{\{\s*[#/]if[^}]*\}\}/g;
const RESERVED = new Set(['else']);

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim() === '');
}

function resolve(path: string, ctx: RenderContext): unknown {
  if (path === 'unsubscribe_link') return ctx.unsubscribe_link ?? undefined;
  if (path === 'booking_link') return ctx.booking_link ?? ctx.sender?.booking_link ?? undefined;
  const parts = path.split('.');
  let cur: any;
  if (parts[0] === 'sender') { cur = ctx.sender ?? {}; parts.shift(); }
  else if (parts[0] === 'custom') { cur = ctx.lead?.custom ?? {}; parts.shift(); }
  else if (parts[0] === 'enrich') { cur = ctx.enrich ?? {}; parts.shift(); }
  else if (parts[0] === 'ai') { cur = ctx.ai ?? {}; parts.shift(); }
  else if (parts[0] === 'lead') { cur = ctx.lead ?? {}; parts.shift(); }
  else cur = ctx.lead ?? {};
  if (parts.length === 0) return undefined;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  if (cur === undefined || cur === null) {
    const bare = path.startsWith('lead.') ? path.slice(5) : path;
    if (bare === 'first_name' && ctx.lead?.full_name) return String(ctx.lead.full_name).split(' ')[0];
    if (path === 'sender.first_name' && ctx.sender?.display_name) return String(ctx.sender.display_name).split(' ')[0];
    if (path === 'sender.full_name' && ctx.sender?.display_name) return ctx.sender.display_name;
  }
  return cur;
}

function stringify(v: unknown): string {
  if (Array.isArray(v)) return v.filter((x) => !isEmpty(x)).join(', ');
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
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

interface CondNode { path: string | null; yes: Array<string | CondNode>; no: Array<string | CondNode>; inElse: boolean }

function applyConditionals(template: string, ctx: RenderContext): string {
  if (template.indexOf('{{') === -1) return template;
  const root: CondNode = { path: null, yes: [], no: [], inElse: false };
  const stack: CondNode[] = [root];
  const push = (x: string | CondNode) => { const top = stack[stack.length - 1]; (top.inElse ? top.no : top.yes).push(x); };
  const re = new RegExp(COND_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    if (m.index > last) push(template.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) { const node: CondNode = { path: m[1], yes: [], no: [], inElse: false }; push(node); stack.push(node); }
    else if (/else/.test(m[0])) { if (stack.length > 1) stack[stack.length - 1].inElse = true; }   // a stray {{else}} is dropped
    else if (stack.length > 1) stack.pop();                                                       // a stray {{/if}} is dropped
  }
  if (last < template.length) push(template.slice(last));
  const out = (parts: Array<string | CondNode>): string =>
    parts.map((p) => (typeof p === 'string' ? p : out(isEmpty(resolve(p.path as string, ctx)) ? p.no : p.yes))).join('');
  return out(root.yes);
}

function applyVariables(template: string, ctx: RenderContext): string {
  return template.replace(new RegExp(VAR_RE.source, 'g'), (_m, name: string, fallback?: string) => {
    const v = resolve(name, ctx);
    if (isEmpty(v)) return (fallback ?? '').trim();
    return stringify(v);
  });
}

export function renderTemplate(template: string | null | undefined, ctx: RenderContext): string {
  if (!template) return '';
  return applyVariables(applyConditionals(applySpintax(template, ctx?.seed), ctx ?? { lead: {} }), ctx ?? { lead: {} });
}

/** Variables used as {{name}} (conditions in {{#if name}} are optional by definition and are not listed). */
export function templateVariables(template: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(VAR_RE.source, 'g');
  while ((m = re.exec(template ?? ''))) if (!RESERVED.has(m[1])) out.add(m[1]);
  return [...out];
}

/** Variables that would render as nothing for this context: empty value and no fallback. Untaken conditional branches do not count. */
export function missingVariables(template: string, ctx: RenderContext): string[] {
  const missing: string[] = [];
  const text = applyConditionals(template ?? '', ctx);
  const re = new RegExp(VAR_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (RESERVED.has(m[1])) continue;
    if (isEmpty(resolve(m[1], ctx)) && !m[2] && !missing.includes(m[1])) missing.push(m[1]);
  }
  return missing;
}

/**
 * Longest possible text and the number of spintax combinations. Mirrors SQL outreach_spintax_info step by step:
 * identical groups are replaced together and counted once, combinations are capped at 1e9, the {{#if}} / {{/if}} tags
 * are stripped (every branch counts at full length), and length is in characters, not UTF-16 units.
 */
export function spintaxInfo(text: string | null | undefined): { maxLen: number; combinations: number } {
  let t = text ?? '';
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
 * Turn the JSON returned by the RPC outreach_render_context into a render context.
 * extras: unsubscribe_link (built by the executor from the signed token), booking_link (overrides the sender's),
 * seed (overrides the one from the RPC), lead / sender (shallow patches, e.g. the post text for comment steps).
 * The booking link carries the lead id as utm_content so the booking webhook can find the lead.
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
    seed: extras.seed ?? j.seed ?? null,
    unsubscribe_link: extras.unsubscribe_link ?? null,
    booking_link: booking,
  };
}
