'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Contact, Lock, Plus } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients, useDashboard, useSenders } from '@/lib/outreach/queries';
import { Avatar, Badge, Button, EmptyState, ErrorBox, HealthBar, PageHeader, Select, Spinner, StatusPill, Table, Td, Th, timeAgo, fmtDate } from '@/components/outreach/ui';
import { PROVIDER_LABELS, STATUS_OPTIONS, isFuture, scheduleSummary } from '@/components/outreach/senders/helpers';
import type { Sender } from '@/lib/outreach/types';

function Budget({ b }: { b?: { used: number; reserved: number; cap: number } }) {
  if (!b) return <span className="text-gray-400">—</span>;
  const used = b.used + b.reserved;
  const full = b.cap > 0 && used >= b.cap;
  return <span className={full ? 'text-amber-700 font-medium tabular-nums' : 'tabular-nums'}>{used}/{b.cap}</span>;
}

export default function SendersPage() {
  const router = useRouter();
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const senders = useSenders(ws);
  const clients = useClients(ws);
  const dash = useDashboard(ws);
  const [status, setStatus] = useState('');
  const [client, setClient] = useState('');

  const todayById = useMemo(() => {
    const m = new Map<string, Record<string, { used: number; reserved: number; cap: number }>>();
    for (const s of dash.data?.senders ?? []) m.set(s.id, s.today ?? {});
    return m;
  }, [dash.data]);
  const clientName = useMemo(() => new Map((clients.data ?? []).map((c) => [c.id, c.name])), [clients.data]);

  const rows = useMemo(() => (senders.data ?? []).filter((s: Sender) => (!status || s.status === status) && (!client || (client === '__none' ? !s.client_id : s.client_id === client))), [senders.data, status, client]);

  return (
    <div>
      <PageHeader title="Senders" subtitle="LinkedIn accounts and mailboxes that run your outreach"
        actions={isManager && canWrite ? <Link href="/outreach/senders/new"><Button><Plus className="w-4 h-4" /> Connect sender</Button></Link> : null} />

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="w-full sm:w-48"><Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></div>
        <div className="w-full sm:w-56"><Select label="Client" value={client} onChange={(e) => setClient(e.target.value)}><option value="">All clients</option><option value="__none">No client</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
        <div className="text-xs text-gray-500 pb-2 ml-auto">{rows.length} of {senders.data?.length ?? 0} senders</div>
      </div>

      {senders.isLoading ? <Spinner /> : senders.isError ? <ErrorBox message={(senders.error as Error).message} /> : rows.length === 0 ? (
        <EmptyState icon={<Contact className="w-6 h-6" />} title={senders.data?.length ? 'No senders match these filters' : 'No senders connected'}
          description={senders.data?.length ? 'Try clearing the status or client filter.' : 'Connect a LinkedIn account or mailbox to start sending. The account owner logs in through a hosted page; you never handle their password.'}
          action={isManager && canWrite && !senders.data?.length ? <Link href="/outreach/senders/new"><Button>Connect sender</Button></Link> : undefined} />
      ) : (
        <Table>
          <thead><tr>
            <Th>Sender</Th><Th>Status</Th><Th>Health</Th><Th>Level</Th><Th>Proxy</Th><Th>Client</Th><Th>Schedule</Th><Th>Last sync</Th><Th className="text-right">Invites</Th><Th className="text-right">Messages</Th>
          </tr></thead>
          <tbody>
            {rows.map((s) => {
              const today = todayById.get(s.id);
              const locked = isFuture(s.warmup_locked_until);
              return (
                <tr key={s.id} onClick={() => router.push(`/outreach/senders/${s.id}`)} className="cursor-pointer hover:bg-gray-50" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') router.push(`/outreach/senders/${s.id}`); }}>
                  <Td>
                    <div className="flex items-center gap-3 min-w-[200px]">
                      <Avatar src={s.picture_url} name={s.display_name} />
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 truncate">{s.display_name ?? 'Unnamed sender'}</div>
                        <div className="text-xs text-gray-500 truncate">{PROVIDER_LABELS[s.provider]}{s.public_identifier ? ` · ${s.public_identifier}` : ''}{s.owner_email ? ` · ${s.owner_email}` : ''}</div>
                      </div>
                    </div>
                  </Td>
                  <Td><StatusPill status={s.status} reason={s.status_reason} /></Td>
                  <Td><HealthBar score={s.health_score} /></Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <Badge tone="indigo">L{s.warmup_level}</Badge>
                      {locked && <span className="inline-flex items-center gap-1 text-xs text-gray-500" title={`Level-up locked until ${fmtDate(s.warmup_locked_until, false)}`}><Lock className="w-3 h-3" /> {fmtDate(s.warmup_locked_until, false)}</span>}
                    </div>
                  </Td>
                  <Td>{s.proxy_country ?? <span className="text-gray-400">—</span>}</Td>
                  <Td>{s.client_id ? (clientName.get(s.client_id) ?? '…') : <span className="text-gray-400">—</span>}</Td>
                  <Td>
                    <div className="text-xs whitespace-nowrap">{scheduleSummary(s.schedule)}</div>
                    <div className="text-[11px] text-gray-400">{s.timezone}</div>
                  </Td>
                  <Td className="whitespace-nowrap" title={s.last_synced_at ? fmtDate(s.last_synced_at) : undefined}>{timeAgo(s.last_synced_at)}</Td>
                  <Td className="text-right"><Budget b={today?.invite} /></Td>
                  <Td className="text-right"><Budget b={today?.message} /></Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
