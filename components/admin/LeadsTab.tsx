'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, RefreshCw, ChevronLeft, ChevronRight, Inbox, Globe, UserPlus, CalendarCheck, MapPin, Sparkles } from 'lucide-react';
import { Badge, Button, Input, Select, Table, Th, Td, ErrorBox, timeAgo } from '@/components/outreach/ui';
import { LEAD_STATUSES, SOURCE_LABEL, answerLabel, answerText, flag, leadsApi, placeOf, type Lead, type LeadFilter, type LeadStatus } from '@/lib/platform/leads';
import { StatusBadge, errMsg, fmtNum, useAdminToast, useDebounced } from './shared';
import LeadDrawer from './LeadDrawer';

const PAGE = 50;

export function SourceBadge({ source }: { source: Lead['source'] }) {
  const tone = source === 'app_signup' ? 'indigo' : source === 'website_demo' ? 'purple' : source === 'website_waitlist' ? 'blue' : source === 'website_integration' ? 'pink' : 'gray';
  return <Badge tone={tone}>{SOURCE_LABEL[source] ?? source}</Badge>;
}

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const tone = status === 'new' ? 'amber' : status === 'contacted' ? 'blue' : status === 'booked' ? 'indigo' : status === 'converted' ? 'green' : 'gray';
  return <Badge tone={tone} className="capitalize">{status}</Badge>;
}

/** The form's answers as short "Label: value" chips (sign-ups only show the provider). */
export function AnswerChips({ answers, max = 4, className }: { answers: Record<string, unknown>; max?: number; className?: string }) {
  const entries = Object.entries(answers ?? {}).filter(([, v]) => answerText(v) !== '');
  if (entries.length === 0) return <span className="text-gray-400">—</span>;
  return (
    <div className={`flex flex-wrap gap-1 ${className ?? ''}`}>
      {entries.slice(0, max).map(([k, v]) => (
        <span key={k} className="inline-flex items-center rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-700 max-w-[220px] truncate" title={`${answerLabel(k)}: ${answerText(v)}`}>
          <span className="text-gray-400 mr-1">{answerLabel(k)}</span>{answerText(v)}
        </span>
      ))}
      {entries.length > max && <span className="text-[11px] text-gray-400">+{entries.length - max}</span>}
    </div>
  );
}

function StatCard({ label, value, hint, icon: Icon, tone = 'indigo', onClick, active }: { label: string; value: React.ReactNode; hint?: string; icon: React.ElementType; tone?: string; onClick?: () => void; active?: boolean }) {
  const tones: Record<string, string> = { indigo: 'bg-indigo-100 text-indigo-700', amber: 'bg-amber-100 text-amber-700', emerald: 'bg-emerald-100 text-emerald-700', purple: 'bg-purple-100 text-purple-700', gray: 'bg-gray-100 text-gray-700', sky: 'bg-sky-100 text-sky-700' };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={`text-left bg-white border rounded-xl px-4 py-3 flex items-center gap-3 ${active ? 'border-indigo-400 ring-1 ring-indigo-200' : 'border-gray-200'} ${onClick ? 'hover:border-indigo-300' : ''}`}>
      <div className={`rounded-lg p-2 ${tones[tone] ?? tones.indigo}`}><Icon className="w-4 h-4" /></div>
      <div className="min-w-0">
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-lg font-semibold text-gray-900 leading-tight">{value}</div>
        {hint && <div className="text-[11px] text-gray-400">{hint}</div>}
      </div>
    </Tag>
  );
}

export default function LeadsTab({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useAdminToast();
  const [search, setSearch] = useState('');
  const dsearch = useDebounced(search);
  const [filter, setFilter] = useState<LeadFilter>({});
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const overview = useQuery({ queryKey: ['admin', 'leads', 'overview'], queryFn: leadsApi.overview });
  const leads = useQuery({
    queryKey: ['admin', 'leads', 'list', dsearch, filter, page],
    queryFn: () => leadsApi.list(dsearch, filter, PAGE, page * PAGE),
    placeholderData: (prev) => prev,
  });

  const rows = leads.data?.rows ?? [];
  const total = leads.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const o = overview.data;

  const set = (patch: Partial<LeadFilter>) => { setFilter((f) => ({ ...f, ...patch })); setPage(0); };
  const toggle = (patch: Partial<LeadFilter>, active: boolean) => (active ? set(Object.fromEntries(Object.keys(patch).map((k) => [k, ''])) as LeadFilter) : set(patch));

  const countries = useMemo(() => o?.by_country ?? [], [o]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'leads'] });

  const quickStatus = async (l: Lead, status: LeadStatus) => {
    try {
      await leadsApi.set(l.id, { status });
      toast('Lead updated');
      refresh();
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">
        Everyone who filled a form on growthxai.com (waitlist, demo, integration request) and everyone who signed up in the app, with their answers and, when the request carried it, where they were. A form fill and a sign-up with the same email are linked.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard label="All leads" value={fmtNum(o?.total)} icon={Inbox} tone="gray" onClick={() => set({ source: '', status: '', account: '', days: '', country: '' })} active={!filter.source && !filter.status && !filter.account && !filter.days && !filter.country} />
        <StatCard label="Website forms" value={fmtNum(o?.forms)} hint={`${fmtNum(o?.forms_7d)} in 7 days`} icon={Globe} tone="purple" onClick={() => toggle({ source: 'website' }, filter.source === 'website')} active={filter.source === 'website'} />
        <StatCard label="App sign-ups" value={fmtNum(o?.signups)} hint={`${fmtNum(o?.signups_7d)} in 7 days`} icon={UserPlus} tone="indigo" onClick={() => toggle({ source: 'app_signup' }, filter.source === 'app_signup')} active={filter.source === 'app_signup'} />
        <StatCard label="New (untouched)" value={fmtNum(o?.new)} icon={Sparkles} tone="amber" onClick={() => toggle({ status: 'new' }, filter.status === 'new')} active={filter.status === 'new'} />
        <StatCard label="Booked a call" value={fmtNum(o?.booked)} icon={CalendarCheck} tone="emerald" onClick={() => toggle({ status: 'booked' }, filter.status === 'booked')} active={filter.status === 'booked'} />
        <StatCard label="With location" value={fmtNum(o?.located)} hint={o && o.total ? `${Math.round((o.located / o.total) * 100)}% of leads` : undefined} icon={MapPin} tone="sky" />
      </div>

      {countries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-gray-400 mr-1">Top countries:</span>
          {countries.map((c) => (
            <button key={c.country} type="button" onClick={() => toggle({ country: c.country }, filter.country === c.country)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${filter.country === c.country ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-white text-gray-600 hover:border-indigo-300'}`}>
              <span>{flag(c.country)}</span>{c.country} <span className="text-gray-400">{fmtNum(c.n)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input className="pl-9" placeholder="Search email, name, company, city or an answer…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
        </div>
        <Select value={filter.source ?? ''} onChange={(e) => set({ source: e.target.value as LeadFilter['source'] })} aria-label="Source">
          <option value="">All sources</option>
          <option value="website">Every website form</option>
          {(Object.keys(SOURCE_LABEL) as Lead['source'][]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
        </Select>
        <Select value={filter.status ?? ''} onChange={(e) => set({ status: e.target.value as LeadFilter['status'] })} aria-label="Status">
          <option value="">Any status</option>
          {LEAD_STATUSES.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
        </Select>
        <Select value={filter.account ?? ''} onChange={(e) => set({ account: e.target.value as LeadFilter['account'] })} aria-label="Account">
          <option value="">Account: any</option>
          <option value="yes">Has an account</option>
          <option value="no">No account yet</option>
        </Select>
        <Select value={String(filter.days ?? '')} onChange={(e) => set({ days: e.target.value ? Number(e.target.value) : '' })} aria-label="Period">
          <option value="">All time</option>
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </Select>
        <Button variant="secondary" size="sm" onClick={refresh} title="Refresh"><RefreshCw className={`w-4 h-4 ${leads.isFetching ? 'animate-spin' : ''}`} /></Button>
      </div>

      {(leads.error || overview.error) && <ErrorBox message={errMsg(leads.error ?? overview.error)} />}

      <Table>
        <thead>
          <tr><Th>When</Th><Th>Who</Th><Th>Source</Th><Th>Answers</Th><Th>Location</Th><Th>Account</Th><Th>Status</Th></tr>
        </thead>
        <tbody>
          {leads.isLoading && <tr><Td colSpan={7} className="text-center text-gray-500 py-8">Loading…</Td></tr>}
          {!leads.isLoading && rows.length === 0 && (
            <tr><Td colSpan={7} className="text-center text-gray-500 py-10">
              {total === 0 && !dsearch && !filter.source && !filter.status ? 'No leads yet. Website forms and app sign-ups appear here as they happen.' : 'Nothing matches these filters.'}
            </Td></tr>
          )}
          {rows.map((l) => (
            <tr key={l.id} className="hover:bg-gray-50 align-top cursor-pointer" onClick={() => setOpenId(l.id)}>
              <Td className="whitespace-nowrap text-gray-500" title={new Date(l.created_at).toLocaleString()}>{timeAgo(l.created_at)}</Td>
              <Td>
                <div className="font-medium text-gray-900">{l.name ?? <span className="text-gray-400 font-normal">no name</span>}</div>
                <div className="text-xs text-gray-600">{l.email ?? '—'}</div>
                {l.company && <div className="text-xs text-gray-400">{l.company}</div>}
              </Td>
              <Td>
                <SourceBadge source={l.source} />
                {l.page && l.source !== 'app_signup' && <div className="text-[11px] text-gray-400 mt-1 truncate max-w-[160px]" title={l.page}>{l.page}</div>}
                {l.related > 0 && <div className="text-[11px] text-indigo-600 mt-1">+{l.related} more from this email</div>}
              </Td>
              <Td className="max-w-[300px]"><AnswerChips answers={l.answers} /></Td>
              <Td className="whitespace-nowrap">
                {l.country ? (
                  <span title={[l.timezone, l.ip].filter(Boolean).join(' · ')}>
                    <span className="mr-1">{flag(l.country)}</span>{placeOf(l)}
                  </span>
                ) : <span className="text-gray-400" title={l.timezone ?? undefined}>{l.timezone ? `tz ${l.timezone}` : 'unknown'}</span>}
              </Td>
              <Td className="whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                {l.account ? (
                  <button type="button" className="text-left" onClick={() => onOpenUser(l.account!.id)}>
                    <StatusBadge status={l.account.status} />
                    <div className="text-[11px] text-gray-400 mt-1">signed up {timeAgo(l.account.created_at)}</div>
                  </button>
                ) : <span className="text-xs text-gray-400">no account</span>}
              </Td>
              <Td className="whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                <div className="flex flex-col gap-1">
                  <LeadStatusBadge status={l.status} />
                  {l.booked_at && <span className="text-[11px] text-emerald-700">call booked {timeAgo(l.booked_at)}</span>}
                  {l.status === 'new' && <button type="button" className="text-[11px] text-indigo-600 hover:underline text-left" onClick={() => quickStatus(l, 'contacted')}>mark contacted</button>}
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>{total === 0 ? 'No leads' : `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${fmtNum(total)}`}</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="w-4 h-4" /></Button>
          <span className="px-2">Page {page + 1} / {pages}</span>
          <Button size="sm" variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="w-4 h-4" /></Button>
        </div>
      </div>

      <LeadDrawer leadId={openId} onClose={() => setOpenId(null)} onOpenUser={onOpenUser} onOpenLead={setOpenId} />
    </div>
  );
}
