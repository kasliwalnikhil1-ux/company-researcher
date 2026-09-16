'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useCrm } from '@/contexts/CrmContext';
import { useCompanies } from '@/lib/crm/queries';
import { fmtMoney } from '@/lib/crm/types';
import { Button, EmptyState, ErrorBox, Input, PageHeader, Select, Spinner, StageBadge, Table, Td, Th, daysAgo } from '@/components/crm/ui';
import { CompanyModal } from '@/components/crm/forms';
import { Plus } from 'lucide-react';

export default function CompaniesPage() {
  const router = useRouter();
  const { lookups, lookupLabel } = useCrm();
  const [q, setQ] = useState('');
  const [seg, setSeg] = useState('');
  const [ch, setCh] = useState('');
  const [create, setCreate] = useState(false);
  const list = useCompanies({ q: q || undefined, icp_segment_id: seg || undefined, source_channel_id: ch || undefined });

  return (
    <div>
      <PageHeader title="Companies" subtitle={list.data ? `${list.data.length} accounts` : undefined}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Input placeholder="Search name, domain, country…" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" autoFocus />
            <Select value={seg} onChange={(e) => setSeg(e.target.value)}><option value="">All segments</option>{lookups('icp_segment', true).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
            <Select value={ch} onChange={(e) => setCh(e.target.value)}><option value="">All channels</option>{lookups('source_channel', true).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
            <Button size="sm" onClick={() => setCreate(true)}><Plus className="w-3.5 h-3.5" /> New company</Button>
          </div>
        } />
      {list.isLoading && <Spinner />}
      {list.isError && <ErrorBox message={(list.error as Error).message} />}
      {list.data && list.data.length === 0 && <EmptyState title="No companies" description="Add the first account." action={<Button size="sm" onClick={() => setCreate(true)}>New company</Button>} />}
      {list.data && list.data.length > 0 && (
        <Table>
          <thead><tr><Th>Company</Th><Th>Country</Th><Th>Segment</Th><Th>Channel</Th><Th>Primary contact</Th><Th>Open deals</Th><Th>Next step</Th><Th>Last activity</Th></tr></thead>
          <tbody>
            {list.data.map((c) => {
              const open = c.crm_deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost');
              const primary = c.crm_contacts.find((x) => x.is_primary) ?? c.crm_contacts[0];
              const last = c.crm_deals.map((d) => d.last_activity_at).filter(Boolean).sort().pop() ?? null;
              const next = open.find((d) => d.next_step);
              return (
                <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => router.push(`/crm/companies/${c.id}`)}>
                  <Td><Link href={`/crm/companies/${c.id}`} className="font-medium text-gray-900 hover:text-indigo-700">{c.name}</Link>{c.domain && <div className="text-xs text-gray-400">{c.domain}</div>}</Td>
                  <Td className="whitespace-nowrap">{c.country ?? '—'}</Td>
                  <Td className="whitespace-nowrap">{lookupLabel('icp_segment', c.icp_segment_id)}</Td>
                  <Td className="whitespace-nowrap">{lookupLabel('source_channel', c.source_channel_id)}</Td>
                  <Td>{primary ? <>{primary.name}{primary.role && <span className="text-gray-400 text-xs"> · {primary.role}</span>}</> : '—'}</Td>
                  <Td>{open.length === 0 ? (c.crm_deals.length ? <span className="text-gray-400">{c.crm_deals.map((d) => d.stage).join(', ')}</span> : '—') : open.map((d) => <div key={d.id} className="flex items-center gap-1.5 whitespace-nowrap"><StageBadge stage={d.stage} /><span className="tabular-nums">{fmtMoney(d.value_monthly, d.currency)}</span></div>)}</Td>
                  <Td className="max-w-[240px] truncate text-gray-600">{next?.next_step ?? (open.length ? <span className="text-amber-700">stuck</span> : '—')}</Td>
                  <Td className="whitespace-nowrap text-gray-500">{daysAgo(last)}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <CompanyModal open={create} onClose={() => setCreate(false)} onSaved={(c) => router.push(`/crm/companies/${c.id}`)} />
    </div>
  );
}
