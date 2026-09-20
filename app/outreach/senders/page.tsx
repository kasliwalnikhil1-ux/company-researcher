'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Contact, Lock, Plus } from 'lucide-react';
import { RunningDryBadge } from '@/components/outreach/senders/RunningDry';
import { useRunningDryAlerts, type SenderV2 } from '@/components/outreach/senders/insights';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients, useDashboard, useSenders } from '@/lib/outreach/queries';
import { Avatar, Badge, Button, EmptyState, ErrorBox, HealthBar, PageHeader, Select, Spinner, StatusPill, Table, Td, Th, timeAgo, fmtDate } from '@/components/outreach/ui';
import { PROVIDER_LABELS, STATUS_OPTIONS, isFuture, scheduleSummary } from '@/components/outreach/senders/helpers';
import type { Sender } from '@/lib/outreach/types';

type Usage = { used: number; reserved: number; cap: number };

function Budget({ label, b }: { label: string; b?: Usage }) {
  if (!b) return null;
  const used = b.used + b.reserved;
  const full = b.cap > 0 && used >= b.cap;
  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap" title={b.cap === 0 ? `No ${label.toLowerCase()} allowance today` : full ? `Today's ${label.toLowerCase()} allowance is used` : undefined}>
      <span className="text-xs text-gray-500">{label}</span>
      <span className={full ? 'text-amber-700 font-medium tabular-nums' : b.cap === 0 ? 'text-gray-400 tabular-nums' : 'tabular-nums'}>{used}/{b.cap}</span>
    </div>
  );
}

/** Why a connected sender may still be sending little or nothing, from the sender row itself. */
function blockedHint(s: SenderV2): string | null {
  if (s.status !== 'ok') return null;   // the status pill already says it
  if (isFuture(s.paused_until)) return `Resting until ${fmtDate(s.paused_until)}`;
  if (s.health_score < 50) return 'Health is below 50: sending is paused';
  if (isFuture(s.invite_blocked_until)) return `LinkedIn blocked invitations until ${fmtDate(s.invite_blocked_until, false)}`;
  return null;
}

export default function SendersPage() {
  const router = useRouter();
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const senders = useSenders(ws);
  const clients = useClients(ws);
  const dash = useDashboard(ws);
  const dry = useRunningDryAlerts(ws);
  const [status, setStatus] = useState('');
  const [client, setClient] = useState('');

  const todayById = useMemo(() => {
    const m = new Map<string, Record<string, { used: number; reserved: number; cap: number }>>();
    for (const s of dash.data?.senders ?? []) m.set(s.id, s.today ?? {});
    return m;
  }, [dash.data]);
  const clientName = useMemo(() => new Map((clients.data ?? []).map((c) => [c.id, c.name])), [clients.data]);

  const rows = useMemo(() => ((senders.data ?? []) as SenderV2[]).filter((s: Sender) => (!status || s.status === status) && (!client || (client === '__none' ? !s.client_id : s.client_id === client))), [senders.data, status, client]);

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
            <Th>Sender</Th><Th>Status</Th><Th>Health</Th><Th>Level</Th><Th>Proxy</Th><Th>Client</Th><Th>Schedule</Th><Th>Last sync</Th><Th className="text-right">Used today</Th>
          </tr></thead>
          <tbody>
            {rows.map((s) => {
              const today = todayById.get(s.id);
              const locked = isFuture(s.warmup_locked_until);
              const dryAlert = dry.data?.get(s.id);
              const isDry = !!s.running_dry_at || !!dryAlert;
              const hint = blockedHint(s);
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
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusPill status={s.status} reason={s.status_reason} />
                      {isDry && <RunningDryBadge alert={dryAlert} />}
                    </div>
                    {hint && <div className="text-[11px] text-amber-700 mt-1 max-w-[220px]">{hint}</div>}
                  </Td>
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
                  <Td className="text-right">
                    {!today ? <span className="text-gray-400">—</span> : s.provider === 'LINKEDIN'
                      ? <><Budget label="Invites" b={today.invite} /><Budget label="Messages" b={today.message} /></>
                      : <Budget label="Emails" b={today.email} />}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
