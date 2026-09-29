'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { CompanyAbout, ContactAbout, PastOrg } from '@/lib/crm/types';
import { Badge, Input, Textarea } from './ui';

// The optional `about` profiles on companies and contacts (crm_companies.about / crm_contacts.about).
// Display-only JSON: only the documented keys get their own layout. Any other key can appear or change shape at any time,
// so it is never special-cased by name: its label is the key, capitalised, and its layout comes from the type of its value
// (short value -> fact row, list of short words -> chips, list of longer text or objects -> list, long text -> paragraph).

type AnyAbout = Record<string, unknown> | null | undefined;
const COMPANY_KEYS = ['description', 'company_industry'];
const CONTACT_KEYS = ['summary', 'past_orgs'];

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const isUrl = (s: string) => /^https?:\/\//i.test(s);
const humanize = (k: string) => { const t = k.replace(/[_-]+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
const isEmpty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

export function hasAbout(a: AnyAbout): boolean { return !!a && Object.keys(a).length > 0; }

// ---------------------------------------------------------------- display

export function IndustryBadge({ industry, className }: { industry: unknown; className?: string }) {
  const s = str(industry);
  if (!s) return null;
  return <Badge className={cn('bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-200', className)} title="Industry">{s}</Badge>;
}

export function pastOrgText(o: PastOrg): string {
  if (typeof o === 'string') return o;
  const extra = [o.role, o.years].map(str).filter(Boolean).join(', ');
  return extra ? `${o.org} (${extra})` : String(o.org ?? '');
}

/** "Before: Nykaa (Brand lead, 2019–2023) · Myntra" */
export function PastOrgs({ orgs, className, label = 'Before' }: { orgs: unknown; className?: string; label?: string }) {
  const list = Array.isArray(orgs) ? (orgs as PastOrg[]).filter((o) => (typeof o === 'string' ? o.trim() : o && typeof o === 'object' && o.org)) : [];
  if (!list.length) return null;
  return (
    <div className={cn('text-xs text-gray-600', className)}>
      <span className="text-gray-400">{label}: </span>
      {list.map((o, i) => (
        <span key={i}>
          {i > 0 && <span className="text-gray-300"> · </span>}
          <span className="font-medium text-gray-700">{typeof o === 'string' ? o : o.org}</span>
          {typeof o !== 'string' && [o.role, o.years].map(str).filter(Boolean).length > 0 && <span className="text-gray-500"> ({[o.role, o.years].map(str).filter(Boolean).join(', ')})</span>}
        </span>
      ))}
    </div>
  );
}

const flat = (o: Record<string, unknown>) => Object.entries(o).filter(([, x]) => x != null && x !== '').map(([k, x]) => `${k.replace(/_/g, ' ')}: ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`).join('; ');

/** Company header block: the one-line description, then any extra keys. The industry badge is placed by the caller. */
export function CompanyAboutBlock({ about, full, className }: { about: CompanyAbout | null | undefined; full?: boolean; className?: string }) {
  if (!hasAbout(about)) return null;
  const desc = str(about!.description);
  return (
    <div className={cn('space-y-1', className)}>
      {desc && <p className="text-sm text-gray-800">{desc}</p>}
      <ProfileExtras about={about} skip={COMPANY_KEYS} full={full} className="pt-1" />
    </div>
  );
}

/** Text clamped to a few lines, with a More/Less toggle that only appears when it actually overflows. */
export function ExpandableText({ text, lines = 3, className }: { text: string; lines?: 2 | 3 | 4; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure); // the width (and so the line count) changes with the layout
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  const clamp = { 2: 'line-clamp-2', 3: 'line-clamp-3', 4: 'line-clamp-4' }[lines];
  return (
    <div className={className}>
      <p ref={ref} className={cn('text-xs text-gray-700 leading-relaxed', !open && clamp)}>{text}</p>
      {(overflows || open) && <button type="button" onClick={() => setOpen(!open)} className="mt-0.5 text-[11px] font-medium text-indigo-600 hover:underline">{open ? 'Less' : 'More'}</button>}
    </div>
  );
}

const FullText = ({ text }: { text: string }) => <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-line">{text}</p>;

// "2021–" / "2021-" reads as an open range: "2021–now"
const fmtYears = (y: string | null) => (y ? y.replace(/\s*[–-]\s*$/, '–now') : null);

const SectionLabel = ({ children }: { children: React.ReactNode }) => <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">{children}</div>;

type Entry = { title: string; sub?: string | null; when?: string | null };

/** A titled vertical list: title + dates on one line, a muted line underneath. Long lists collapse to `limit`. */
export function Timeline({ label, items, limit = 3, className }: { label: string; items: Entry[]; limit?: number; className?: string }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, limit);
  return (
    <div className={className}>
      <SectionLabel>{label}</SectionLabel>
      <ol className="ml-[3px] border-l border-gray-300 space-y-1.5">
        {shown.map((e, i) => (
          <li key={i} className="relative pl-3">
            <span className="absolute -left-[3.5px] top-[5px] w-1.5 h-1.5 rounded-full bg-gray-400 ring-2 ring-white" />
            <div className="flex items-baseline justify-between gap-2 text-xs leading-snug">
              <span className="font-medium text-gray-800 min-w-0">{e.title}</span>
              {e.when && <span className="shrink-0 text-[11px] text-gray-400 tabular-nums">{e.when}</span>}
            </div>
            {e.sub && <div className="text-[11px] text-gray-500 leading-snug">{e.sub}</div>}
          </li>
        ))}
      </ol>
      {items.length > limit && <button type="button" onClick={() => setAll(!all)} className="mt-1 ml-3 text-[11px] font-medium text-indigo-600 hover:underline">{all ? 'Show less' : `+${items.length - limit} more`}</button>}
    </div>
  );
}

const pastOrgEntries = (orgs: unknown): Entry[] =>
  (Array.isArray(orgs) ? (orgs as PastOrg[]) : []).flatMap((o) => {
    if (typeof o === 'string') return o.trim() ? [{ title: o.trim() }] : [];
    if (!o || typeof o !== 'object' || !str(o.org)) return [];
    return [{ title: str(o.org)!, sub: str(o.role), when: fmtYears(str(o.years)) }];
  });

/** Past organisations as a small vertical timeline: org + years on one line, role underneath. */
export function Experience({ orgs, limit = 3, className }: { orgs: unknown; limit?: number; className?: string }) {
  return <Timeline label="Experience" items={pastOrgEntries(orgs)} limit={limit} className={className} />;
}

// ---- any other key, laid out by the shape of its value

// An object in a list, read by its values, not its key names: the first date-like value ("2019", "2019–2023", "Jan 2020 – now")
// goes on the right, the first other text is the title, everything else is the muted line underneath.
const DATE_LIKE = /^(\w{3,9}\.?\s+)?\d{4}(\s*[–-]\s*((\w{3,9}\.?\s+)?\d{4}|present|now|current)?)?$/i;
function objectEntry(o: Record<string, unknown>): Entry | null {
  const vals = Object.values(o).filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => String(v).trim()).filter(Boolean);
  const when = vals.find((v) => DATE_LIKE.test(v)) ?? null;
  const rest = vals.filter((v) => v !== when);
  if (!rest.length) return when ? { title: when } : null;
  return { title: rest[0], sub: rest.slice(1).join(' · ') || null, when: fmtYears(when) };
}

type Shape =
  | { kind: 'fact'; key: string; value: React.ReactNode }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'chips'; key: string; items: string[] }
  | { kind: 'list'; key: string; items: Entry[] };

function shapeOf(key: string, v: unknown): Shape | null {
  if (isEmpty(v)) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return { kind: 'fact', key, value: typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v) };
  if (typeof v === 'string') {
    const t = v.trim();
    if (isUrl(t)) return { kind: 'fact', key, value: <a href={t} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline break-all">{t.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')}</a> };
    return t.length > 90 || t.includes('\n') ? { kind: 'text', key, text: t } : { kind: 'fact', key, value: t };
  }
  if (Array.isArray(v)) {
    const strs = v.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter(Boolean);
    const objs = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown>[];
    if (!objs.length && strs.every((x) => x.length <= 28 && !x.includes(','))) return { kind: 'chips', key, items: strs }; // languages, skills, interests
    return { kind: 'list', key, items: [...strs.map((t) => ({ title: t })), ...objs.map(objectEntry).filter((x): x is Entry => !!x)] };
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => !isEmpty(x));
  return { kind: 'list', key, items: entries.map(([k, x]) => ({ title: typeof x === 'object' ? flat(x as Record<string, unknown>) || JSON.stringify(x) : String(x), sub: humanize(k) })) };
}

/** Every key the layout does not know, grouped: lists and long text as their own sections, short values as a fact table at the end. */
export function ProfileExtras({ about, skip, full, className }: { about: AnyAbout; skip: string[]; full?: boolean; className?: string }) {
  const shapes = Object.entries(about ?? {}).filter(([k]) => !skip.includes(k)).map(([k, v]) => shapeOf(k, v)).filter((x): x is Shape => !!x);
  if (!shapes.length) return null;
  const facts = shapes.filter((x): x is Extract<Shape, { kind: 'fact' }> => x.kind === 'fact');
  return (
    <div className={cn('space-y-2.5', className)}>
      {shapes.map((x) => {
        if (x.kind === 'list') return <Timeline key={x.key} label={humanize(x.key)} items={x.items} limit={full ? Infinity : undefined} />;
        if (x.kind === 'text') return <div key={x.key}><SectionLabel>{humanize(x.key)}</SectionLabel>{full ? <FullText text={x.text} /> : <ExpandableText text={x.text} lines={2} />}</div>;
        if (x.kind === 'chips') return (
          <div key={x.key}>
            <SectionLabel>{humanize(x.key)}</SectionLabel>
            <div className="flex flex-wrap gap-1">{x.items.map((t, i) => <span key={i} className="px-1.5 py-0.5 rounded bg-gray-100 text-[11px] text-gray-700">{t}</span>)}</div>
          </div>
        );
        return null;
      })}
      {facts.length > 0 && (
        <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-3 gap-y-0.5 text-xs">
          {facts.map((f) => <div key={f.key} className="contents"><dt className="text-gray-400 whitespace-nowrap">{humanize(f.key)}</dt><dd className="text-gray-700 min-w-0 break-words">{f.value}</dd></div>)}
        </dl>
      )}
    </div>
  );
}

/** A person's profile: summary, experience, then any other key. `compact` = clamped lines (full summary on hover), no extras;
 *  `full` = everything spelled out, no More / +N more toggles (an expanded view). */
export function ContactAboutBlock({ about, compact, full, className }: { about: ContactAbout | null | undefined; compact?: boolean; full?: boolean; className?: string }) {
  if (!hasAbout(about)) return null;
  const summary = str(about!.summary);
  if (compact) {
    return (
      <div className={cn('space-y-0.5', className)}>
        {summary && <p className="text-xs text-gray-700 leading-relaxed line-clamp-2" title={summary}>{summary}</p>}
        <PastOrgs orgs={about!.past_orgs} className="line-clamp-1" />
      </div>
    );
  }
  return (
    <div className={cn('space-y-2.5', className)}>
      {summary && (full ? <FullText text={summary} /> : <ExpandableText text={summary} />)}
      <Experience orgs={about!.past_orgs} limit={full ? Infinity : undefined} />
      <ProfileExtras about={about} skip={CONTACT_KEYS} full={full} />
    </div>
  );
}

// ---------------------------------------------------------------- editing

/** Form state for the known keys + the rest as editable JSON. */
export interface CompanyAboutDraft { description: string; company_industry: string; extra: string }
export interface ContactAboutDraft { summary: string; past_orgs: string; extra: string }

const extrasOf = (a: AnyAbout, known: string[]) => {
  const rest = Object.fromEntries(Object.entries(a ?? {}).filter(([k]) => !known.includes(k)));
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
};

export const companyAboutDraft = (a: CompanyAbout | null | undefined): CompanyAboutDraft => ({ description: str(a?.description) ?? '', company_industry: str(a?.company_industry) ?? '', extra: extrasOf(a, COMPANY_KEYS) });

// One past organisation per line: "Org — Role — Years" (role and years optional).
const pastOrgLine = (o: PastOrg) => (typeof o === 'string' ? o : [o.org, o.role, o.years].map(str).filter(Boolean).join(' — '));
export const contactAboutDraft = (a: ContactAbout | null | undefined): ContactAboutDraft => ({
  summary: str(a?.summary) ?? '',
  past_orgs: Array.isArray(a?.past_orgs) ? (a!.past_orgs as PastOrg[]).map(pastOrgLine).join('\n') : '',
  extra: extrasOf(a, CONTACT_KEYS),
});

function parseExtra(s: string): Record<string, unknown> {
  if (!s.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(s); } catch { throw new Error('Other details must be valid JSON, e.g. {"location": "Mumbai"}'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Other details must be a JSON object, e.g. {"location": "Mumbai"}');
  return v as Record<string, unknown>;
}

function parsePastOrgs(text: string, prev: unknown): PastOrg[] {
  const old = Array.isArray(prev) ? (prev as PastOrg[]) : [];
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [org, role, ...rest] = line.split(/\s+[—–-]\s+|\s*\|\s*/).map((x) => x.trim());
    const years = rest.join('–'); // "2019 – 2023" splits too; put it back together
    // keep any extra fields an assistant stored on the same organisation
    const before = old.find((o) => typeof o !== 'string' && o.org?.toLowerCase() === org.toLowerCase());
    const base = before && typeof before !== 'string' ? { ...before } : {};
    if (!role && !years && Object.keys(base).length <= 1) return org;
    return { ...base, org, role: role || undefined, years: years || undefined };
  });
}

/** Turn the edited profile into the `about` patch for upsert_*: undefined = leave alone, null = clear, else keys to merge (removed keys sent as null). */
function toPatch(prev: AnyAbout, next: Record<string, unknown>): Record<string, unknown> | null | undefined {
  const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)));
  if (!Object.keys(clean).length) return hasAbout(prev) ? null : undefined;
  for (const k of Object.keys(prev ?? {})) if (!(k in clean)) clean[k] = null;
  return clean;
}

export function companyAboutPatch(prev: CompanyAbout | null | undefined, d: CompanyAboutDraft) {
  return toPatch(prev, { ...parseExtra(d.extra), description: d.description.trim(), company_industry: d.company_industry.trim() });
}
export function contactAboutPatch(prev: ContactAbout | null | undefined, d: ContactAboutDraft) {
  return toPatch(prev, { ...parseExtra(d.extra), summary: d.summary.trim(), past_orgs: parsePastOrgs(d.past_orgs, prev?.past_orgs) });
}

const countHint = (s: string, max: number, what: string) => { const n = words(s); return n ? `${n} word${n === 1 ? '' : 's'}${n >= max ? ` — keep it under ${max}` : ''}` : what; };

export function CompanyAboutFields({ value, onChange }: { value: CompanyAboutDraft; onChange: (v: CompanyAboutDraft) => void }) {
  return (
    <>
      <Input label="What they do" value={value.description} onChange={(e) => onChange({ ...value, description: e.target.value })} placeholder="Handmade silver jewelry for Gen Z" hint={countHint(value.description, 10, 'Precise, under 10 words')} maxLength={120} />
      <Input label="Industry" value={value.company_industry} onChange={(e) => onChange({ ...value, company_industry: e.target.value })} placeholder="jewelry, skincare, SaaS, AI, agency…" hint={countHint(value.company_industry, 4, 'Specific, under 4 words')} maxLength={60} />
      <div className="col-span-2"><Textarea label="Other details (JSON, optional)" value={value.extra} onChange={(e) => onChange({ ...value, extra: e.target.value })} placeholder='{"founded": 2019, "hq": "Mumbai"}' className="font-mono text-xs min-h-[56px]" /></div>
    </>
  );
}

export function ContactAboutFields({ value, onChange }: { value: ContactAboutDraft; onChange: (v: ContactAboutDraft) => void }) {
  return (
    <>
      <div className="col-span-2"><Textarea label="About them" value={value.summary} onChange={(e) => onChange({ ...value, summary: e.target.value })} placeholder="Second-time founder; ran brand at Nykaa before starting the company." hint="Who they are in 1–3 sentences" className="min-h-[56px]" /></div>
      <div className="col-span-2"><Textarea label="Past organisations" value={value.past_orgs} onChange={(e) => onChange({ ...value, past_orgs: e.target.value })} placeholder={'Nykaa — Brand lead — 2019–2023\nMyntra'} hint="One per line: organisation — role — years (role and years optional)" className="min-h-[56px]" /></div>
      <div className="col-span-2"><Textarea label="Other details (JSON, optional)" value={value.extra} onChange={(e) => onChange({ ...value, extra: e.target.value })} placeholder='{"location": "Mumbai", "languages": ["Hindi", "English"]}' className="font-mono text-xs min-h-[48px]" /></div>
    </>
  );
}
