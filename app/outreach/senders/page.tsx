'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Contact, Lock, Plus } from 'lucide-react';
import { RunningDryBadge } from '@/components/outreach/senders/RunningDry';
import { useRunningDryAlerts, type SenderV2 } from '@/components/outreach/senders/insights';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients, useDashboard, useSenders } from '@/lib/outreach/queries';
import { Avatar, Badge, Button, EmptyState, ErrorBox, fmtDate, HealthBar, PageHeader, Select, Spinner, StatusPill, Table, Td, Th, timeAgo } from '@/components/outreach/ui';
import { PROVIDER_LABELS, STATUS_OPTIONS, isFuture, scheduleSummary } from '@/components/outreach/senders/helpers';
import type { Provider, Sender } from '@/lib/outreach/types';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { cn } from '@/lib/utils';
import { QaScoreBadge } from '@/components/outreach/profile/QaCard';
import { SendersSubnav } from '@/components/outreach/senders/SendersSubnav';
import { sanitizeLike, usePersistedFilters } from '@/lib/outreach/persistedFilters';
import { useSenderScopes } from '@/lib/outreach/channels';

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
  if (s.provider_warning) return 'Paused after an Instagram warning';
  if (isFuture(s.paused_until)) return `Resting until ${fmtDate(s.paused_until)}`;
  if (s.health_score < 50) return 'Health is below 50: sending is paused';
  if (isFuture(s.outreach_allowed_from)) return `Outreach starts ${fmtDate(s.outreach_allowed_from)}`;
  if (isFuture(s.invite_blocked_until)) return `LinkedIn blocked invitations until ${fmtDate(s.invite_blocked_until, false)}`;
  return null;
}

/** Instagram: what is left of this hour's allowance (one RPC per Instagram row, refreshed every minute). */
function HourRemaining({ senderId }: { senderId: string }) {
  const scopes = useSenderScopes(senderId);
  const h = scopes.data?.hour;
  if (!h) return null;
  const left = Math.max(0, h.remaining);
  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap" title={left === 0 ? 'This hour’s allowance is used; it resumes next hour' : `${left} of ${h.cap} actions left this hour`}>
      <span className="text-xs text-gray-500">This hour</span>
      <span className={left === 0 ? 'text-amber-700 font-medium tabular-nums' : 'tabular-nums'}>{left} left</span>
    </div>
  );
}

export default function SendersPage() {
  const router = useRouter();
  const { workspace, isManager, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const senders = useSenders(ws);
  const clients = useClients(ws);
  const dash = useDashboard(ws);
  const dry = useRunningDryAlerts(ws);
  // Status and client filters are remembered per workspace in this browser.
  const { filters: listFilters, patch: patchListFilters } = usePersistedFilters('senders', ws, { status: '', client: '', channel: '' }, {
    sanitize: (raw, d) => { const v = sanitizeLike(raw, d); if (v.status && !STATUS_OPTIONS.some((o) => o.value === v.status)) v.status = ''; if (v.channel && !(v.channel in PROVIDER_LABELS)) v.channel = ''; return v; },
  });
  const { status, client, channel } = listFilters;
  const setStatus = (v: string) => patchListFilters({ status: v });
  const setClient = (v: string) => patchListFilters({ client: v });
  const setChannel = (v: string) => patchListFilters({ channel: v });

  const todayById = useMemo(() => {
    const m = new Map<string, Record<string, { used: number; reserved: number; cap: number }>>();
    for (const s of dash.data?.senders ?? []) m.set(s.id, s.today ?? {});
    return m;
  }, [dash.data]);
  const clientName = useMemo(() => new Map((clients.data ?? []).map((c) => [c.id, c.name])), [clients.data]);

  const rows = useMemo(() => ((senders.data ?? []) as SenderV2[]).filter((s: Sender) => (!channel || s.provider === channel) && (!status || s.status === status) && (!client || (client === '__none' ? !s.client_id : s.client_id === client))), [senders.data, status, client, channel]);
  // Only channels this workspace actually has senders on are offered, plus the one selected (so it can be cleared).
  const channelCounts = useMemo(() => {
    const m = new Map<Provider, number>();
    for (const s of senders.data ?? []) m.set(s.provider, (m.get(s.provider) ?? 0) + 1);
    return m;
  }, [senders.data]);
  const channels = (Object.keys(PROVIDER_LABELS) as Provider[]).filter((p) => channelCounts.has(p) || p === channel);

  return (
    <div>
      <PageHeader title="Senders" subtitle="LinkedIn, Instagram and WhatsApp accounts and mailboxes that run your outreach"
        actions={isManager && canWrite ? <Link href="/outreach/senders/new"><Button><Plus className="w-4 h-4" /> Connect sender</Button></Link> : null} />
      <SendersSubnav />

      {channels.length > 1 || channel ? (
        <div className="flex flex-wrap items-center gap-2 mb-3" role="group" aria-label="Channel">
          <button type="button" onClick={() => setChannel('')} aria-pressed={!channel}
            className={cn('px-3 py-1.5 rounded-full text-xs font-medium border', !channel ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50')}>
            All channels <span className="opacity-60 tabular-nums">{senders.data?.length ?? 0}</span>
          </button>
          {channels.map((p) => (
            <button key={p} type="button" onClick={() => setChannel(channel === p ? '' : p)} aria-pressed={channel === p}
              className={cn('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border', channel === p ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50')}>
              <ProviderLogo provider={p} className="w-3.5 h-3.5" /> {PROVIDER_LABELS[p]} <span className="opacity-60 tabular-nums">{channelCounts.get(p) ?? 0}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="w-full sm:w-48"><Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></div>
        <div className="w-full sm:w-56"><Select label="Client" value={client} onChange={(e) => setClient(e.target.value)}><option value="">All clients</option><option value="__none">No client</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
        <div className="text-xs text-gray-500 pb-2 ml-auto">{rows.length} of {senders.data?.length ?? 0} senders</div>
      </div>

      {senders.isLoading ? <Spinner className="min-h-[50vh]" /> : senders.isError ? <ErrorBox message={(senders.error as Error).message} /> : rows.length === 0 ? (
        <EmptyState icon={<Contact className="w-6 h-6" />} title={senders.data?.length ? 'No senders match these filters' : 'No senders connected'}
          description={senders.data?.length ? 'Try clearing the channel, status or client filter.' : 'Connect a LinkedIn, Instagram or WhatsApp account, or a mailbox, to start sending. The account owner signs in through a hosted page; you never handle their password.'}
          action={isManager && canWrite && !senders.data?.length ? <Link href="/outreach/senders/new"><Button>Connect sender</Button></Link> : undefined} />
      ) : (
        <Table>
          <thead><tr>
            <Th>Sender</Th><Th>Status</Th><Th>Health</Th><Th>Profile</Th><Th>Level</Th><Th>Proxy</Th><Th>Client</Th><Th>Schedule</Th><Th>Last sync</Th><Th className="text-right">Used today</Th>
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
                      <div className="relative shrink-0">
                        <Avatar src={s.picture_url} name={s.display_name} />
                        <span className="absolute -bottom-0.5 -right-0.5 rounded bg-white p-px ring-1 ring-white" title={PROVIDER_LABELS[s.provider]}><ProviderLogo provider={s.provider} className="w-3.5 h-3.5" /></span>
                      </div>
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
                  <Td>{s.provider === 'LINKEDIN' ? <QaScoreBadge score={s.profile_qa_score} /> : <span className="text-gray-300">—</span>}</Td>
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
                      : s.provider === 'INSTAGRAM'
                        ? <><Budget label="New conversations" b={today.new_chat} /><Budget label="Follows" b={today.follow} /><HourRemaining senderId={s.id} /></>
                        : s.provider === 'WHATSAPP'
                          ? <><Budget label="New conversations" b={today.new_chat} /><Budget label="Messages" b={today.message} /></>
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
