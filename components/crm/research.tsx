'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ACTION_HELP, ACTION_TONE, KIND_LABEL, VERDICTS, actionLabel, useResearchForEvent, useResearchItems, type ResearchItem } from '@/lib/crm/research';
import { Badge, CompanyLogo, EmptyState, ErrorBox, Spinner, fmtDate, logoDomain } from '@/components/crm/ui';
import { LinkChips, contactLinks } from '@/components/crm/about';
import { cn } from '@/lib/utils';
import { ExternalLink, Search, User, CalendarDays, AlertTriangle } from 'lucide-react';

// What the prospect-research skill found and did, as the team reads it: the Research tab on the Calendar screen
// (every run, newest first) and a short block inside an event whose guests were researched.


export function VerdictBadge({ verdict }: { verdict: ResearchItem['verdict'] }) {
  if (!verdict) return <span className="text-gray-300">—</span>;
  const v = VERDICTS[verdict];
  return <Badge tone={v.tone} title={v.help}>{v.label}</Badge>;
}

export function ActionBadge({ item }: { item: Pick<ResearchItem, 'kind' | 'action' | 'researched'> }) {
  return <span className="inline-flex items-center gap-1"><Badge tone={ACTION_TONE[item.action]} title={ACTION_HELP[item.action]}>{actionLabel(item.kind, item.action)}</Badge>{!item.researched && <span className="text-[10px] text-gray-400" title="Reused from an earlier run — not researched again">carried</span>}</span>;
}

/** The company's website, clickable, opening in a new tab. */
function Website({ domain }: { domain: string | null }) {
  if (!domain) return null;
  return <a href={`https://${domain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline break-all"><ExternalLink className="w-3 h-3 shrink-0" />{domain}</a>;
}

type Group = { key: string; companyId: string | null; name: string | null; domain: string | null; items: ResearchItem[] };

/** Rows clubbed by company: the company's own row first, then its contacts, then its meetings. Rows tied to no
 *  company (an unconfirmed gmail) come last under "No company". */
function groupByCompany(items: ResearchItem[]): Group[] {
  const map = new Map<string, Group>();
  for (const it of items) {
    const domain = it.company_domain ?? it.domain;
    const key = it.company_id ?? (domain ? `d:${domain}` : '');
    const name = it.company_name ?? (it.kind === 'company' ? it.label.replace(/\s*\([^)]*\)\s*$/, '') : null);
    let g = map.get(key);
    if (!g) { g = { key, companyId: it.company_id, name, domain, items: [] }; map.set(key, g); }
    g.name = g.name ?? name; g.domain = g.domain ?? domain; g.companyId = g.companyId ?? it.company_id;
    g.items.push(it);
  }
  const order = { company: 0, contact: 1, meeting: 2 } as const;
  const groups = Array.from(map.values());
  groups.forEach((g) => g.items.sort((x, y) => order[x.kind] - order[y.kind]));
  return groups.sort((x, y) => (x.key === '' ? 1 : 0) - (y.key === '' ? 1 : 0));
}

function GroupHeader({ g, cols }: { g: Group; cols: number }) {
  const review = g.items.filter((i) => i.needs_review).length;
  return (
    <tr className="bg-gray-50/80">
      <td colSpan={cols} className="px-3 py-1.5">
        {g.key === '' ? <span className="text-xs font-medium text-gray-500">No company</span> : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {g.companyId
              ? <Link href={`/crm/companies/${g.companyId}`} className="inline-flex items-center gap-1.5 font-semibold text-gray-900 hover:underline"><CompanyLogo name={g.name ?? g.domain ?? '?'} domain={logoDomain(g.domain)} size="sm" />{g.name ?? g.domain}</Link>
              : <span className="inline-flex items-center gap-1.5 font-semibold text-gray-900"><CompanyLogo name={g.name ?? g.domain ?? '?'} domain={logoDomain(g.domain)} size="sm" />{g.name ?? g.domain}</span>}
            <Website domain={g.domain} />
            {review > 0 && <Badge tone="amber">{review} to review</Badge>}
          </div>
        )}
      </td>
    </tr>
  );
}

function RecordCell({ it }: { it: ResearchItem }) {
  if (it.kind === 'company') return <span className="text-gray-700">Company profile</span>;
  const Icon = it.kind === 'contact' ? User : CalendarDays;
  // the contact's links (LinkedIn column + about.links), the same chips the company page shows
  const links = it.kind === 'contact' ? contactLinks({ linkedin_url: it.contact_linkedin_url, about: it.contact_links ? { links: it.contact_links } : null }) : [];
  return (
    <>
      <span className="inline-flex items-center gap-1.5"><Icon className="w-3.5 h-3.5 text-gray-400 shrink-0" /><span className="font-medium text-gray-900">{it.label}</span></span>
      {it.email && <div className="text-xs text-gray-400 break-all pl-5">{it.email}</div>}
      <LinkChips links={links} className="pl-5 mt-1" />
    </>
  );
}

/** One run's rows as a table, clubbed by company. */
export function ResearchTable({ items, compact }: { items: ResearchItem[]; compact?: boolean }) {
  const groups = groupByCompany(items);
  const cols = compact ? 5 : 6;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-[11px] uppercase tracking-wide text-gray-500 text-left">
          <th className="px-3 py-1.5 font-medium">Record</th>
          {!compact && <th className="px-3 py-1.5 font-medium">Type</th>}
          <th className="px-3 py-1.5 font-medium">Who it is</th>
          <th className="px-3 py-1.5 font-medium">Action</th>
          <th className="px-3 py-1.5 font-medium">What changed</th>
          <th className="px-3 py-1.5 font-medium">Review</th>
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.key || 'none'} className="divide-y divide-gray-100 border-t border-gray-200">
          <GroupHeader g={g} cols={cols} />
          {g.items.map((it) => (
            <tr key={it.id} className={cn('align-top', it.needs_review && 'bg-amber-50/40')}>
              <td className="px-3 py-2 pl-5 min-w-[170px]"><RecordCell it={it} /></td>
              {!compact && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{KIND_LABEL[it.kind]}</td>}
              <td className="px-3 py-2 whitespace-nowrap"><VerdictBadge verdict={it.verdict} /></td>
              <td className="px-3 py-2 whitespace-nowrap"><ActionBadge item={it} /></td>
              <td className="px-3 py-2 text-gray-700 max-w-[480px]">{it.detail ?? <span className="text-gray-300">—</span>}</td>
              <td className="px-3 py-2 max-w-[320px]">
                {it.needs_review ? (
                  <div className="text-xs text-amber-800">
                    <div className="inline-flex items-center gap-1 font-medium"><AlertTriangle className="w-3 h-3" /> Needs review</div>
                    {it.review_reason && <div className="text-gray-700 mt-0.5">{it.review_reason}</div>}
                    {it.best_match_url && <a href={it.best_match_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-600 hover:underline mt-0.5 break-all"><ExternalLink className="w-3 h-3 shrink-0" /> closest match</a>}
                  </div>
                ) : <span className="text-gray-300">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}

/** Legend: the fixed words and what each means. */
export function ResearchLegend({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('text-xs', className)}>
      <button type="button" onClick={() => setOpen(!open)} className="text-indigo-600 hover:underline">{open ? 'Hide' : 'What the words mean'}</button>
      {open && (
        <div className="mt-2 grid md:grid-cols-2 gap-x-6 gap-y-1 text-gray-600 border border-gray-200 rounded-md bg-white p-3">
          <div className="font-semibold text-gray-800 md:col-span-2">Who it is — what the research established</div>
          {(Object.keys(VERDICTS) as Array<keyof typeof VERDICTS>).map((k) => <div key={k}><Badge tone={VERDICTS[k].tone}>{VERDICTS[k].label}</Badge> <span>{VERDICTS[k].help}</span></div>)}
          <div className="font-semibold text-gray-800 md:col-span-2 mt-2">Action — what the run did to the CRM record</div>
          <div><Badge tone="green">Created</Badge> / <Badge tone="green">Booked</Badge> <span>{ACTION_HELP.created}</span></div>
          <div><Badge tone="indigo">Updated</Badge> / <Badge tone="indigo">Moved</Badge> <span>{ACTION_HELP.updated}</span></div>
          <div><Badge tone="gray">Exists, same</Badge> / <Badge tone="gray">Already on file</Badge> <span>{ACTION_HELP.skipped}</span></div>
          <div><Badge tone="amber">Not added</Badge> / <Badge tone="amber">Not booked</Badge> <span>{ACTION_HELP.not_added}</span></div>
          <div className="md:col-span-2 mt-1"><span className="font-semibold text-gray-800">Needs review</span> — a person should confirm it: an unconfirmed person, a work email whose profile is unconfirmed, a near-duplicate that was merged, or a meeting booked at a placeholder time. The closest profile found is linked. <span className="text-gray-400">carried</span> = reused from an earlier run; say “refresh” to the research skill to redo it.</div>
        </div>
      )}
    </div>
  );
}

/** The Calendar → Research tab: every run, newest first, each a table of rows. */
export function ResearchPanel({ className }: { className?: string }) {
  const [needsReview, setNeedsReview] = useState(false);
  const [q, setQ] = useState('');
  const query = useResearchItems({ needsReview });
  const runs = useMemo(() => {
    const term = q.trim().toLowerCase();
    const rows = (query.data ?? []).filter((r) => !term || [r.label, r.email, r.domain, r.company_name, r.detail, r.review_reason].some((s) => s && s.toLowerCase().includes(term)));
    const map = new Map<string, ResearchItem[]>();
    for (const r of rows) { const l = map.get(r.run_id); if (l) l.push(r); else map.set(r.run_id, [r]); }
    return Array.from(map.entries());
  }, [query.data, q]);
  const reviewCount = (query.data ?? []).filter((r) => r.needs_review).length;

  return (
    <div className={cn('flex flex-col gap-3 min-h-0', className)}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="relative"><Search className="w-3.5 h-3.5 absolute left-2 top-2 text-gray-400" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a name, email, company…" className="pl-7 pr-2 py-1 text-sm rounded-md border border-gray-300 w-64" /></div>
        <button type="button" onClick={() => setNeedsReview(!needsReview)} className={cn('px-2.5 py-1 rounded-md border text-xs', needsReview ? 'bg-indigo-50 text-indigo-700 border-indigo-200 font-medium' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50')}>Needs review only{reviewCount ? ` · ${reviewCount}` : ''}</button>
        <ResearchLegend className="ml-auto" />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
        {query.isLoading ? <div className="py-10 flex justify-center"><Spinner /></div>
          : query.error ? <ErrorBox message={(query.error as Error).message} />
          : runs.length === 0 ? <EmptyState compact icon={<Search className="w-6 h-6" />} title={needsReview ? 'Nothing needs review' : 'No research runs yet'} description={needsReview ? undefined : 'Run /prospect-research in Claude on a meeting invite or a few emails; its “what changed” table lands here and inside the matching calendar events.'} />
          : runs.map(([runId, items]) => (
            <div key={runId}>
              <div className="px-1 pb-1 text-xs text-gray-500">{fmtDate(items[0].run_at, { time: true })}{items[0].run_by_name ? ` · ${items[0].run_by_name}` : ''}</div>
              <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto"><ResearchTable items={items} /></div>
            </div>
          ))}
      </div>
    </div>
  );
}

/** Inside an event: the latest research row for each guest (by email) and for the linked CRM meeting. Renders nothing when there is none. */
export function ResearchForEvent({ emails, meetingId }: { emails: string[]; meetingId?: string | null }) {
  const q = useResearchForEvent(emails, meetingId);
  const items = q.data ?? [];
  if (q.isLoading || items.length === 0) return null;
  const latest = items.reduce((a, b) => (a.run_at > b.run_at ? a : b));
  const review = items.filter((i) => i.needs_review).length;
  return (
    <div className="rounded-md border border-gray-200 bg-white overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-50/80 border-b border-gray-100 flex items-center gap-2 text-[11px] uppercase tracking-wide text-gray-500">
        <Search className="w-3.5 h-3.5" /> Research · {fmtDate(latest.run_at)}
        {review > 0 && <Badge tone="amber">{review} to review</Badge>}
        <Link href="/crm/calendar?view=research" className="ml-auto normal-case tracking-normal text-indigo-600 hover:underline">all runs</Link>
      </div>
      <div className="overflow-x-auto"><ResearchTable items={items} compact /></div>
    </div>
  );
}
