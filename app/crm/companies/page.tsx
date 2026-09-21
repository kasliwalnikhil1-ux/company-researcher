'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useCrm } from '@/contexts/CrmContext';
import { useCompanies, type CompanyFilters } from '@/lib/crm/queries';
import { fmtMoney } from '@/lib/crm/types';
import { Button, CompanyLogo, EmptyState, ErrorBox, Input, PageHeader, Pagination, Select, Spinner, StageBadge, Table, Td, Th, DayTag, TimeRangeFilter, calendarDaysAgo, fmtDate, logoDomain, timeWindow, type TimeFilter } from '@/components/crm/ui';
import { CompanyModal } from '@/components/crm/forms';
import { Plus } from 'lucide-react';

export default function CompaniesPage() {
  const router = useRouter();
  const { lookups, lookupLabel } = useCrm();
  const [q, setQ] = useState('');
  const [seg, setSeg] = useState('');
  const [ch, setCh] = useState('');
  const [create, setCreate] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [created, setCreated] = useState<TimeFilter>({ range: '' });
  const [activity, setActivity] = useState<TimeFilter>({ range: '' });
  const [sort, setSort] = useState<NonNullable<CompanyFilters['sort']>>('created');
  const cw = timeWindow(created), aw = timeWindow(activity);
  const list = useCompanies({ q: q || undefined, icp_segment_id: seg || undefined, source_channel_id: ch || undefined, created_from: cw.from, created_to: cw.to, activity_from: aw.from, activity_to: aw.to, sort, page, pageSize });
  const rows = list.data?.rows;
  const total = list.data?.total ?? 0;
  const filtered = !!(q || seg || ch || created.range || activity.range);

  // Any filter change restarts from page 1; a page left past the end (rows deleted elsewhere) snaps back in range.
  const refilter = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  useEffect(() => {
    if (!list.data || list.isPlaceholderData || page === 1) return;
    if (list.data.outOfRange) setPage(1);
    else if (list.data.rows.length === 0) setPage(Math.max(1, Math.ceil(list.data.total / pageSize)));
  }, [list.data, list.isPlaceholderData, page, pageSize]);

  return (
    <div>
      <PageHeader title="Companies" subtitle={list.data ? `${total} account${total === 1 ? '' : 's'}` : undefined}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Input placeholder="Search name, domain, country…" value={q} onChange={(e) => refilter(setQ)(e.target.value)} className="w-56" autoFocus />
            <Select value={seg} onChange={(e) => refilter(setSeg)(e.target.value)}><option value="">All segments</option>{lookups('icp_segment', true).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
            <Select value={ch} onChange={(e) => refilter(setCh)(e.target.value)}><option value="">All channels</option>{lookups('source_channel', true).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
            <TimeRangeFilter label="Created" value={created} onChange={refilter(setCreated)} title="When the company was added" />
            <TimeRangeFilter label="Activity" value={activity} onChange={refilter(setActivity)} title="Latest activity on any of its deals" />
            <Select value={sort} onChange={(e) => refilter(setSort)(e.target.value as NonNullable<CompanyFilters['sort']>)}><option value="created">Sort: newest created</option><option value="activity">Sort: latest activity</option><option value="name">Sort: name A–Z</option></Select>
            <Button size="sm" onClick={() => setCreate(true)}><Plus className="w-3.5 h-3.5" /> New company</Button>
          </div>
        } />
      {list.isLoading && <Spinner />}
      {list.isError && <ErrorBox message={(list.error as Error).message} />}
      {rows && total === 0 && !list.isPlaceholderData && (filtered
        ? <EmptyState title="No matching companies" description="Try a different search or clear the filters." />
        : <EmptyState title="No companies" description="Add the first account." action={<Button size="sm" onClick={() => setCreate(true)}>New company</Button>} />)}
      {rows && rows.length > 0 && (
        <>
        <Table className={list.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
          <thead><tr><Th>Company</Th><Th>Country</Th><Th>Segment</Th><Th>Channel</Th><Th>Primary contact</Th><Th>Open deals</Th><Th>Next step</Th><Th>Created</Th><Th>Last activity</Th></tr></thead>
          <tbody>
            {rows.map((c) => {
              const open = c.crm_deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost');
              const primary = c.crm_contacts.find((x) => x.is_primary) ?? c.crm_contacts[0];
              const next = open.find((d) => d.next_step);
              return (
                <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => router.push(`/crm/companies/${c.id}`)}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <CompanyLogo name={c.name} domain={logoDomain(c.domain ?? c.website, [primary?.email, ...c.crm_contacts.map((x) => x.email)])} />
                      <div className="min-w-0"><Link href={`/crm/companies/${c.id}`} className="font-medium text-gray-900 hover:text-indigo-700">{c.name}</Link>{c.domain && <div className="text-xs text-gray-400">{c.domain}</div>}</div>
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap">{c.country ?? '—'}</Td>
                  <Td className="whitespace-nowrap">{lookupLabel('icp_segment', c.icp_segment_id)}</Td>
                  <Td className="whitespace-nowrap">{lookupLabel('source_channel', c.source_channel_id)}</Td>
                  <Td>{primary ? <>{primary.name}{primary.role && <span className="text-gray-400 text-xs"> · {primary.role}</span>}</> : '—'}</Td>
                  <Td>{open.length === 0 ? (c.crm_deals.length ? <span className="text-gray-400">{c.crm_deals.map((d) => d.stage).join(', ')}</span> : '—') : open.map((d) => <div key={d.id} className="flex items-center gap-1.5 whitespace-nowrap"><StageBadge stage={d.stage} /><span className="tabular-nums">{fmtMoney(d.value_monthly, d.currency)}</span></div>)}</Td>
                  <Td className="max-w-[240px] truncate text-gray-600">{next?.next_step ?? (open.length ? <span className="text-amber-700">stuck</span> : '—')}</Td>
                  <Td className="whitespace-nowrap"><DayTag days={calendarDaysAgo(c.created_at)} suffix=" ago" title={fmtDate(c.created_at, { time: true })} /></Td>
                  <Td className="whitespace-nowrap"><DayTag days={calendarDaysAgo(c.crm_last_activity_at)} suffix=" ago" title={c.crm_last_activity_at ? fmtDate(c.crm_last_activity_at, { time: true }) : 'No activity logged'} /></Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <Pagination page={page} pageSize={pageSize} total={total} loading={list.isFetching} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
        </>
      )}
      <CompanyModal open={create} onClose={() => setCreate(false)} onSaved={(c) => router.push(`/crm/companies/${c.id}`)} />
    </div>
  );
}
