'use client';

import { useMemo, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useRouter } from '@/lib/outreach/nav';
import { AlertTriangle, Contact, Lock, Plus, Search, X } from 'lucide-react';
import { RunningDryBadge } from '@/components/outreach/senders/RunningDry';
import { useRunningDryAlerts, type SenderV2 } from '@/components/outreach/senders/insights';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients, useDashboard, useSenders } from '@/lib/outreach/queries';
import { Avatar, Badge, Button, EmptyState, ErrorBox, fmtDate, HealthBar, PageHeader, Spinner, StatusPill, Table, Td, Th, timeAgo } from '@/components/outreach/ui';
import { PROVIDER_LABELS, STATUS_OPTIONS, addAccountAction, disconnectedReasonText, isAbandonedSignIn, isFuture, scheduleSummary, statusReasonText } from '@/components/outreach/senders/helpers';
import { accountsMeter, changeHref, useBilling } from '@/lib/outreach/billing';
import type { Provider, Sender } from '@/lib/outreach/types';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { cn } from '@/lib/utils';
import { QaScoreBadge } from '@/components/outreach/profile/QaCard';
import { SendersSubnav } from '@/components/outreach/senders/SendersSubnav';
import { sanitizeLike, usePersistedFilters } from '@/lib/outreach/persistedFilters';
import { useSenderScopes } from '@/lib/outreach/channels';
import { PaginationBar, usePagedRows } from '@/components/outreach/Pagination';

/** Same compact control as the leads filter bar. */
const SEL = 'px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500';

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
  if (isAbandonedSignIn(s)) return `${statusReasonText(s.status_reason) ?? 'Sign-in not completed'}: open the sender and send a fresh link`;
  if (s.status === 'disconnected') return disconnectedReasonText(s.status_reason) ?? 'The connected account was removed';
  if (s.status !== 'ok') return s.status === 'connecting' || s.status === 'error' ? statusReasonText(s.status_reason) : null;   // the pill says the state; a sign-in reason goes under it
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
  const { workspace, isManager, isOwner, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const billing = useBilling(ws);
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
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();

  const todayById = useMemo(() => {
    const m = new Map<string, Record<string, { used: number; reserved: number; cap: number }>>();
    for (const s of dash.data?.senders ?? []) m.set(s.id, s.today ?? {});
    return m;
  }, [dash.data]);
  const clientName = useMemo(() => new Map((clients.data ?? []).map((c) => [c.id, c.name])), [clients.data]);

  // Newest additions first.
  const rows = useMemo(() => ((senders.data ?? []) as SenderV2[]).filter((s: Sender) => (!q || [s.display_name, s.public_identifier, s.owner_email].some((f) => f?.toLowerCase().includes(q))) && (!channel || s.provider === channel) && (!status || s.status === status) && (!client || (client === '__none' ? !s.client_id : s.client_id === client))).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')), [senders.data, status, client, channel, q]);
  // Paged on the client: the full sender list is already loaded; any filter change goes back to page 1.
  const { pageRows, ...pager } = usePagedRows(rows, [ws, q, status, client, channel].join('|'));
  const filtered = !!(q || status || client || channel);
  const clearFilters = () => { setSearch(''); patchListFilters({ status: '', client: '', channel: '' }); };
  // Only channels this workspace actually has senders on are offered, plus the one selected (so it can be cleared).
  const channelCounts = useMemo(() => {
    const m = new Map<Provider, number>();
    for (const s of senders.data ?? []) m.set(s.provider, (m.get(s.provider) ?? 0) + 1);
    return m;
  }, [senders.data]);
  const channels = (Object.keys(PROVIDER_LABELS) as Provider[]).filter((p) => channelCounts.has(p) || p === channel);

  // Accounts are bought up front: the meter, and what Connect turns into once every account on the plan is in use.
  const slots = billing.data?.accounts;
  const limit = accountsMeter(slots);
  const meter = limit && limit.billed > 0 ? limit : null;   // a lapsed plan has no accounts to show; the banner at the top covers it
  const atLimit = !!limit?.full;
  const addAccount = addAccountAction(billing.data);
  const connect = !isManager || !canWrite ? null
    : !atLimit ? <Link href="/outreach/senders/new"><Button><Plus className="w-4 h-4" /> Connect sender</Button></Link>
      : isOwner ? <Link href={addAccount.href}><Button><Plus className="w-4 h-4" /> {addAccount.label}</Button></Link>
        : <span title="Every account on the plan is in use. The workspace owner can add accounts on the Billing page."><Button disabled><Plus className="w-4 h-4" /> Connect sender</Button></span>;

  return (
    <div>
      <PageHeader title="Senders" subtitle="LinkedIn, Instagram and WhatsApp accounts and mailboxes that run your outreach"
        actions={meter || connect ? (
          <>
            {meter && (
              <div className="min-w-[150px]" title="An account is a LinkedIn account, a mailbox, an Instagram account or a WhatsApp number">
                <div className="text-xs text-gray-500 whitespace-nowrap"><span className="font-medium text-gray-900 tabular-nums">{meter.text}</span>{slots?.reserved ? ` · ${slots.reserved} being connected` : ''}</div>
                <div className="mt-1 h-1 bg-gray-100 rounded-full overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={meter.billed} aria-valuenow={meter.used} aria-label="Accounts used">
                  <div className={cn('h-full rounded-full', meter.used > meter.billed ? 'bg-red-500' : meter.full ? 'bg-amber-500' : 'bg-indigo-500')} style={{ width: `${meter.pct}%` }} />
                </div>
              </div>
            )}
            {connect}
          </>
        ) : null} />
      <SendersSubnav />

      {!!slots?.over_limit && limit && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 mb-4 rounded-xl border text-sm bg-amber-50 text-amber-800 border-amber-200">
          <div className="flex items-start gap-2 flex-1 min-w-0"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /><div className="min-w-0">{slots.over_limit} account{slots.over_limit === 1 ? ' is' : 's are'} paused because your plan has {limit.billed}. Add accounts or remove some.{!isOwner && ' The workspace owner can add accounts on the Billing page.'}</div></div>
          {isOwner && <Link href={changeHref({ accounts: Math.max(slots.used, limit.billed + 1) })} className="shrink-0"><Button size="sm">Add accounts</Button></Link>}
        </div>
      )}

      {channels.length > 1 || channel ? (
        <div className="flex flex-wrap items-center gap-2 mb-3" role="group" aria-label="Channel" data-tour="sender-channels">
          <button type="button" onClick={() => setChannel('')} aria-pressed={!channel}
            className={cn('px-3 py-1.5 rounded-full text-xs font-medium border', !channel ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50')}>
            All channels <span className="opacity-60 tabular-nums">{senders.data?.length ?? 0}</span>
          </button>
          {channels.map((p) => (
            <button key={p} type="button" onClick={() => setChannel(channel === p ? '' : p)} aria-pressed={channel === p}
              className={cn('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border', channel === p ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50')}>
              <ProviderLogo provider={p} className="w-3.5 h-3.5" /> {PROVIDER_LABELS[p]} <span className="opacity-60 tabular-nums">{channelCounts.get(p) ?? 0}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <label className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input aria-label="Search senders" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, handle, email…" className={cn(SEL, 'w-full pl-8')} />
        </label>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className={SEL}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)} className={SEL}>
          <option value="">All clients</option>
          <option value="__none">No client</option>
          {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {filtered && <Button variant="ghost" size="sm" onClick={clearFilters}><X className="w-3.5 h-3.5" /> Clear</Button>}
      </div>

      {senders.isLoading ? <Spinner className="min-h-[50vh]" /> : senders.isError ? <ErrorBox message={(senders.error as Error).message} /> : rows.length === 0 ? (
        <EmptyState icon={<Contact className="w-6 h-6" />} title={senders.data?.length ? 'No senders match these filters' : 'No senders connected'}
          description={senders.data?.length ? 'Try clearing the search, channel, status or client filter.' : 'Connect a LinkedIn, Instagram or WhatsApp account, or a mailbox, to start sending. The account owner signs in through a hosted page; you never handle their password.'}
          action={senders.data?.length ? <Button variant="secondary" onClick={clearFilters}>Clear filters</Button> : isManager && canWrite ? (atLimit ? connect : <Link href="/outreach/senders/new"><Button>Connect sender</Button></Link>) : undefined} />
      ) : (
        <>
        <Table>
          <thead><tr>
            <Th>Sender</Th><Th>Status</Th>
            <Th title="How safe this account is to send from, 0 to 100. It's the lowest of six checks and is updated every hour. A lower score cuts today's limits, and below 50 sending pauses.">Health</Th>
            <Th title="LinkedIn only: how complete and convincing the LinkedIn profile is. Click the score to open the Profile tab.">Profile</Th>
            <Th title="Warm-up level. New accounts start at L0 with low daily limits, and each level allows more. A lock date means the account can't move up before then.">Level</Th>
            <Th title="The country this account sends from. It's set when the account is connected and should match where the owner lives.">Proxy</Th>
            <Th title="The client this sender works for, if any.">Client</Th>
            <Th title="Working hours in the sender's own time zone. Actions are only sent during these hours.">Schedule</Th>
            <Th>Last sync</Th><Th className="text-right">Used today</Th>
          </tr></thead>
          <tbody>
            {pageRows.map((s) => {
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
                      <StatusPill status={s.status} reason={statusReasonText(s.status_reason)} />
                      {s.status === 'paused' && s.status_reason === 'over_plan_limit' && <Badge tone="amber" className="cursor-help"><span title="The plan has fewer accounts than are connected. It resumes once the plan has room for it.">Paused by plan</span></Badge>}
                      {isDry && <RunningDryBadge alert={dryAlert} />}
                    </div>
                    {hint && <div className="text-[11px] text-amber-700 mt-1 max-w-[220px]">{hint}</div>}
                    {s.status === 'disconnected' && isManager && <Link href={`/outreach/senders/${s.id}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="inline-block text-xs font-medium text-indigo-600 hover:underline mt-0.5">Reconnect</Link>}
                  </Td>
                  <Td><HealthBar score={s.health_score} /></Td>
                  <Td>{s.provider === 'LINKEDIN'
                    ? <Link href={`/outreach/senders/${s.id}?tab=Profile`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} title="Profile quality score. Open the Profile tab." className="inline-flex hover:opacity-80"><QaScoreBadge score={s.profile_qa_score} /></Link>
                    : <span className="text-gray-300">—</span>}</Td>
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
        <PaginationBar {...pager} />
        </>
      )}
    </div>
  );
}
