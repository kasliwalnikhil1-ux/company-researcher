'use client';

// Settings → Email & booking → Email log (custom-sending-domain-PRD.md §8.2): every platform email of the workspace with
// its delivery events. Bodies are never shown (they carry links). Owners and managers.
import { useState } from 'react';
import { ChevronDown, ChevronRight, ListChecks, Search } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { STATUS_LABEL, STATUS_TONE, typeLabel, useEmailLog, useEmailTypes, type DeliveryStatus, type EmailLogFilters, type EmailLogRow } from '@/lib/outreach/emailSending';
import { Badge, Card, EmptyState, ErrorBox, Input, Select, Spinner, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import { LIST_PAGE_SIZE, PaginationBar } from '@/components/outreach/Pagination';
import { cn } from '@/lib/utils';

const PLATFORM = 'GrowthxAI';
const STATUSES: Array<DeliveryStatus | ''> = ['', 'sent', 'delivered', 'delayed', 'bounced', 'complained', 'failed', 'suppressed'];
const EVENT_LABEL: Record<string, string> = { 'email.sent': 'Sent', 'email.delivered': 'Delivered', 'email.delivery_delayed': 'Delayed', 'email.bounced': 'Bounced', 'email.complained': 'Marked as spam', 'email.failed': 'Failed', 'email.suppressed': 'Suppressed' };

function fromText(r: EmailLogRow): string {
  if (!r.fell_back) return r.from;
  const why = r.fallback_reason === 'dns' ? 'DNS' : r.fallback_reason === 'send_error' ? 'send error' : r.fallback_reason === 'warmup_cap' ? 'warm-up cap' : r.fallback_reason === 'plan' ? 'plan' : r.fallback_reason ?? 'domain';
  return `${PLATFORM} (fallback: ${why})`;
}

function Row({ r }: { r: EmailLogRow }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="cursor-pointer hover:bg-gray-50" onClick={() => setOpen((o) => !o)}>
        <Td className="whitespace-nowrap text-gray-600">{fmtDate(r.at)}</Td>
        <Td><div className="text-gray-900">{typeLabel(r.type)}</div><div className="text-xs text-gray-400 truncate max-w-[320px]" title={r.subject}>{r.subject}</div></Td>
        <Td className="font-mono text-xs">{r.to}</Td>
        <Td className={cn('text-xs', r.fell_back ? 'text-amber-700' : 'text-gray-600')}>{fromText(r)}</Td>
        <Td><Badge tone={STATUS_TONE[r.status] ?? 'gray'}>{STATUS_LABEL[r.status] ?? r.status}</Badge>{r.bounce_type && <span className="ml-1 text-xs text-gray-400">{r.bounce_type}</span>}</Td>
        <Td className="text-gray-400">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</Td>
      </tr>
      {open && (
        <tr><td colSpan={6} className="px-4 pb-3 bg-gray-50">
          <ol className="text-xs text-gray-700 space-y-1 py-2 pl-2 border-l-2 border-gray-200">
            <li><span className="text-gray-400 mr-2">{fmtDate(r.at)}</span>Queued and handed to our email provider</li>
            {r.events.map((e, i) => <li key={`${e.event}-${i}`}><span className="text-gray-400 mr-2">{fmtDate(String(e.at))}</span>{EVENT_LABEL[e.event] ?? e.event}{e.detail && typeof e.detail === 'object' && Object.keys(e.detail as object).length ? <span className="text-gray-400"> · {JSON.stringify(e.detail).slice(0, 160)}</span> : null}</li>)}
            {!r.events.length && <li className="text-gray-400">No delivery event yet.</li>}
          </ol>
        </td></tr>
      )}
    </>
  );
}

function Log() {
  const { workspace } = useWorkspace();
  const ws = workspace?.id;
  const [f, setF] = useState<EmailLogFilters>({ to: '', type: '', status: '', since: '', until: '' });
  // the page is remembered together with the filters it was turned on: a filter change starts again from the first
  // page, and a log that shrank under the open page clamps to its last page (same idea as usePagedRows)
  const filterKey = JSON.stringify(f);
  const [paging, setPaging] = useState({ key: filterKey, page: 0 });
  const wanted = paging.key === filterKey ? paging.page : 0;
  const q = useEmailLog(ws, { ...f, limit: LIST_PAGE_SIZE, offset: wanted * LIST_PAGE_SIZE });
  const total = q.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const page = q.data ? Math.min(wanted, pageCount - 1) : wanted;
  const setPage = (p: number) => setPaging({ key: filterKey, page: Math.max(0, Math.min(pageCount - 1, p)) });
  const from = total === 0 ? 0 : page * LIST_PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * LIST_PAGE_SIZE);
  const [toDraft, setToDraft] = useState('');
  const types = useEmailTypes(!!ws);
  const keys = [...(types.data?.brand ?? []), ...(types.data?.platform ?? [])].map((t) => t.key).sort();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setF({ ...f, to: toDraft.trim() }); }}>
          <Input label="Recipient" value={toDraft} onChange={(e) => setToDraft(e.target.value)} placeholder="priya@client.com" className="w-56" />
          <button type="submit" className="px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1"><Search className="w-4 h-4" /> Search</button>
        </form>
        <Select label="Type" value={f.type ?? ''} onChange={(e) => setF({ ...f, type: e.target.value })} className="w-56">
          <option value="">Every type</option>
          {keys.map((k) => <option key={k} value={k}>{typeLabel(k)}</option>)}
        </Select>
        <div>
          <div className="text-sm font-medium text-gray-700 mb-1">Status</div>
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="group" aria-label="Delivery status">
            {STATUSES.map((s) => (
              <button key={s || 'all'} type="button" onClick={() => setF({ ...f, status: s })} className={cn('px-2.5 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors', (f.status ?? '') === s ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>{s ? STATUS_LABEL[s] : 'All'}</button>
            ))}
          </div>
        </div>
        <Input label="From" type="date" value={f.since ?? ''} onChange={(e) => setF({ ...f, since: e.target.value })} className="w-40" />
        <Input label="To" type="date" value={f.until ?? ''} onChange={(e) => setF({ ...f, until: e.target.value })} className="w-40" />
      </div>
      {q.isLoading && !q.data ? <Spinner /> : q.isError ? <ErrorBox message={parseError(q.error).message} /> : !q.data?.rows.length ? (
        <EmptyState title="No emails match" description="Emails show up here as soon as the platform sends one for this workspace: sign-in links, permission requests, reports, billing and alerts." />
      ) : (
        <>
          <div className="text-xs text-gray-500">Newest first. Click a row for its delivery events.</div>
          <Table>
            <thead><tr><Th>When</Th><Th>Type</Th><Th>To</Th><Th>From</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>{q.data.rows.map((r) => <Row key={r.id} r={r} />)}</tbody>
          </Table>
          <PaginationBar page={page} pageCount={pageCount} setPage={setPage} total={total} from={from} to={to} />
        </>
      )}
    </div>
  );
}

export default function EmailLogCard() {
  return (
    <div>
      <Card title={<span className="flex items-center gap-2"><ListChecks className="w-4 h-4" /> Email log</span>}>
        <p className="text-sm text-gray-700 mb-4">Every email the platform sent for this workspace, with its delivery status. Click a row for the delivery events.</p>
        <Log />
      </Card>
    </div>
  );
}
