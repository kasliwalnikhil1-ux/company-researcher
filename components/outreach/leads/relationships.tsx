'use client';

/**
 * Leads page pieces for migration 094 (leads-relationships-PRD.md): the Status column, the Connected via avatars with
 * their hover, the Channels marks, the enrichment cell, the totals line and the By account panel.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from '@/lib/outreach/nav';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSenders } from '@/lib/outreach/queries';
import { CHANNEL_META, CHANNEL_ORDER, SOURCE_LABEL, STATUS_META, channelOf, enrichWaitText, relationshipStateText, statusLabel, useLeadRelationships, useLeadsByAccount, useLeadsTotals, type LeadTab } from '@/lib/outreach/leadsRelationships';
import type { Lead, LeadChannel, LeadRelationshipRow, LeadStatus, LeadSummary, LeadsByAccountRow, LeadsTotals, Provider, Sender } from '@/lib/outreach/types';
import { Avatar, Badge, Spinner, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { cn } from '@/lib/utils';
import { Mail, Sparkles, Users, X } from 'lucide-react';

const DASH = <span className="text-gray-300">—</span>;

/** The channel's brand mark (same logos as Senders): the channel a status was reached on, or the channels a lead can be reached on. `light` = reachable but nothing sent yet. */
export function ChannelMark({ channel, tone = 'dark', dot, title }: { channel: LeadChannel; tone?: 'dark' | 'light'; dot?: boolean; title?: string }) {
  const m = CHANNEL_META[channel];
  const provider: Provider | null = channel === 'linkedin' ? 'LINKEDIN' : channel === 'instagram' ? 'INSTAGRAM' : channel === 'whatsapp' ? 'WHATSAPP' : null;
  return (
    <span title={title ?? m.label} className={cn('relative inline-flex items-center justify-center align-middle', tone === 'light' && 'opacity-40 grayscale')}>
      {provider
        ? <ProviderLogo provider={provider} className="w-4 h-4" />
        : <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-gray-700 text-white"><Mail className="w-2.5 h-2.5" aria-label={m.label} /></span>}
      {dot && <span aria-hidden className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-purple-500 ring-1 ring-white" />}
    </span>
  );
}

/** §4.1: the furthest point reached on any channel, with the channel it was reached on. */
export function LeadStatusBadge({ summary, size = 'xs' }: { summary: Pick<LeadSummary, 'status' | 'status_channel' | 'status_at'> | null | undefined; size?: 'xs' | 'sm' }) {
  const status: LeadStatus = summary?.status ?? 'not_contacted';
  const meta = STATUS_META[status];
  const title = `${meta.help}${summary?.status_at ? ` ${fmtDate(summary.status_at, false)}.` : ''}`;
  return (
    <span title={title} className="inline-flex items-center gap-1 cursor-help max-w-full">
      {summary?.status_channel && status !== 'do_not_contact' && <ChannelMark channel={summary.status_channel} />}
      <Badge tone={meta.tone} className={size === 'sm' ? 'text-xs' : undefined}>{meta.label}</Badge>
    </span>
  );
}

/** §4.3: hidden when the lead has no identity on the channel; light = reachable; dark = we sent something; dot = they answered. */
export function ChannelsCell({ summary, lead }: { summary: LeadSummary | null | undefined; lead?: Partial<Lead> }) {
  const reachable = new Set<LeadChannel>(summary?.identity_channels ?? []);
  if (!summary && lead) {
    if (lead.public_identifier || lead.provider_id) reachable.add('linkedin');
    if (lead.email_work || lead.email_personal) reachable.add('email');
  }
  const used = new Set<LeadChannel>(summary?.used_channels ?? []);
  const replied = new Set<LeadChannel>(summary?.replied_channels ?? []);
  const bounced = new Set<LeadChannel>(summary?.bounced_channels ?? []);
  const shown = CHANNEL_ORDER.filter((c) => reachable.has(c) || used.has(c));
  if (shown.length === 0) return DASH;
  return (
    <span className="inline-flex items-center gap-1">
      {shown.map((c) => {
        const label = CHANNEL_META[c].label;
        const title = bounced.has(c) ? `${label}: bounced` : replied.has(c) ? `${label}: they answered` : used.has(c) ? `${label}: we sent something` : `${label}: reachable`;
        return <ChannelMark key={c} channel={c} tone={used.has(c) ? 'dark' : 'light'} dot={replied.has(c)} title={title} />;
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Connected via: avatars of the connected accounts (solid), pending invites (hollow), "+N" beyond; hover lists every account
// ---------------------------------------------------------------------------
function HoverCard({ anchor, children }: { anchor: HTMLElement; children: React.ReactNode }) {
  const r = anchor.getBoundingClientRect();
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const left = Math.max(8, Math.min(r.left, vw - 360));
  return createPortal(
    <div role="tooltip" style={{ position: 'fixed', top: r.bottom + 6, left, zIndex: 60 }} className="w-[22rem] max-w-[calc(100vw-1rem)] rounded-xl border border-gray-200 bg-white shadow-xl p-3 text-xs text-gray-700">
      {children}
    </div>, document.body);
}

function RelationshipLines({ rows, includeRemoved }: { rows: LeadRelationshipRow[]; includeRemoved: boolean }) {
  const groups = useMemo(() => {
    const by = new Map<LeadChannel, LeadRelationshipRow[]>();
    for (const r of rows) { if (r.removed && !includeRemoved) continue; const list = by.get(r.channel) ?? []; list.push(r); by.set(r.channel, list); }
    return CHANNEL_ORDER.filter((c) => by.has(c)).map((c) => ({ channel: c, rows: by.get(c)! }));
  }, [rows, includeRemoved]);
  if (groups.length === 0) return <p className="text-gray-500">No account has a relationship with this person yet.</p>;
  return (
    <div className="space-y-2">
      {groups.map((g) => (
        <div key={g.channel}>
          <div className="font-semibold text-gray-900 mb-0.5">{CHANNEL_META[g.channel].label}</div>
          <ul className="space-y-0.5">
            {g.rows.map((r) => {
              const s = relationshipStateText(r, fmtDate);
              return (
                <li key={r.sender_id} className="flex items-start gap-1.5">
                  <Avatar src={r.picture_url} name={r.name} size={4} />
                  <span className="min-w-0">
                    <span className="font-medium text-gray-900">{r.name}</span>{r.removed && <span className="text-gray-400"> (removed)</span>}
                    <span className="text-gray-500"> · {s.label}</span>
                    {s.detail && <span className="text-gray-500"> · {s.detail}</span>}
                    {r.state === 'connected' && r.checked_at && <span className="text-gray-400"> · checked {fmtDate(r.checked_at, false)}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function ConnectedViaCell({ leadId, summary, senders, includeRemoved = false }: { leadId: string; summary: LeadSummary | null | undefined; senders: Sender[] | undefined; includeRemoved?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const rels = useLeadRelationships(open ? leadId : null, true);
  const byId = useMemo(() => new Map((senders ?? []).map((s) => [s.id, s])), [senders]);
  const live = (id: string) => includeRemoved || byId.has(id);   // senders RLS hides deleted rows; the lifecycle statuses are filtered by the SQL
  const connected = (summary?.connected_sender_ids ?? []).filter(live);
  const pending = (summary?.pending_sender_ids ?? []).filter(live);
  const ours = new Set(summary?.connected_via_our_invite_ids ?? []);
  if (connected.length === 0 && pending.length === 0) return DASH;
  const items = [...connected.map((id) => ({ id, pending: false })), ...pending.map((id) => ({ id, pending: true }))];
  const shown = items.slice(0, 3); const more = items.length - shown.length;
  return (
    <span ref={ref} className="inline-flex items-center -space-x-1.5 cursor-help" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} tabIndex={0}
      aria-label={`${connected.length} connected, ${pending.length} pending`}>
      {shown.map(({ id, pending: p }) => {
        const s = byId.get(id);
        const name = s?.display_name ?? s?.public_identifier ?? 'Removed account';
        return (
          <span key={id} className={cn('relative inline-flex rounded-full ring-2 ring-white', p && 'opacity-90')} title={`${name}${p ? ' · invite pending' : ours.has(id) ? ' · accepted our invite' : ' · connected'}`}>
            {p
              ? <span className="w-6 h-6 rounded-full border-2 border-dashed border-indigo-400 bg-white flex items-center justify-center text-[10px] font-semibold text-indigo-600">{(name[0] ?? '?').toUpperCase()}</span>
              : <Avatar src={s?.picture_url} name={name} size={6} />}
            {!p && !ours.has(id) && <span aria-hidden title="already connected before outreach" className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-gray-400 ring-1 ring-white" />}
          </span>
        );
      })}
      {more > 0 && <span className="ml-2 pl-1 text-[11px] text-gray-500 tabular-nums">+{more}</span>}
      {open && ref.current && (
        <HoverCard anchor={ref.current}>
          {rels.isLoading ? <Spinner className="py-2" /> : <RelationshipLines rows={rels.data ?? []} includeRemoved={includeRemoved} />}
          <p className="mt-2 text-[10px] text-gray-400">Solid = connected · dashed = invite pending · grey dot = already connected before outreach.</p>
        </HoverCard>
      )}
    </span>
  );
}

/** The enrichment column: Enriched / Waiting · why / Failed. */
export function EnrichmentCell({ lead }: { lead: Pick<Lead, 'enrich_status' | 'enriched_at' | 'enrich_wait_reason' | 'kind' | 'hidden_at'> }) {
  if (lead.kind && lead.kind !== 'person') return <span className="text-xs text-gray-400">Never (not a person)</span>;
  if (lead.enrich_status === 'done' || lead.enriched_at) return <Badge tone="green"><span title={lead.enriched_at ? `Enriched ${fmtDate(lead.enriched_at)}` : 'Enriched'} className="inline-flex items-center"><Sparkles className="w-3 h-3 mr-1" />Enriched</span></Badge>;
  if (lead.enrich_status === 'waiting') {
    const text = enrichWaitText(lead.enrich_wait_reason ?? null, (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    return <span className="block truncate text-xs text-blue-700" title={text}>{text}</span>;
  }
  if (lead.enrich_status === 'failed') return <Badge tone="red">Enrichment failed</Badge>;
  return DASH;
}

// ---------------------------------------------------------------------------
// §5.4 totals line
// ---------------------------------------------------------------------------
export function TotalsLine({ ws, tab, filters, onPick, includeRemoved }: { ws: string | undefined; tab: LeadTab; filters: Record<string, unknown>; includeRemoved: boolean; onPick: (patch: Record<string, unknown>) => void }) {
  const q = useLeadsTotals(ws, { ...filters, tab, include_removed: includeRemoved });
  const t = q.data;
  if (!t) return <div className="h-5" aria-hidden />;
  const noun = tab === 'inbox' ? 'inbound leads' : tab === 'all' ? 'people' : 'outbound leads';
  const item = (n: number, label: string, patch: Record<string, unknown> | null, title: string) => (
    <span key={label} title={title} className="inline-flex items-baseline gap-1">
      {patch ? <button type="button" onClick={() => onPick(patch)} className="font-semibold text-gray-900 tabular-nums hover:text-indigo-700 hover:underline">{n.toLocaleString()}</button> : <span className="font-semibold text-gray-900 tabular-nums">{n.toLocaleString()}</span>}
      <span>{label}</span>
    </span>
  );
  const parts = [
    item(t.people, noun, null, 'Leads in this tab under the current filters, counted in people.'),
    item(t.contacted, 'contacted', { status: ['invited', 'connected', 'messaged', 'replied', 'interested', 'meeting'] }, 'Status Invited or further: at least one invite, message or email went out.'),
    <span key="connected" title="At least one current LinkedIn or Instagram connection with one of your accounts. A lead connected to two accounts counts once. In brackets: connections that came from an invite of ours." className="inline-flex items-baseline gap-1">
      <button type="button" onClick={() => onPick({ status: ['connected', 'messaged', 'replied', 'interested', 'meeting'], not_connected: null })} className="font-semibold text-gray-900 tabular-nums hover:text-indigo-700 hover:underline">{t.connected.toLocaleString()}</button>
      <span>connected</span>
      <button type="button" onClick={() => onPick({ connection_source: 'our_invite' })} className="text-gray-500 hover:text-indigo-700 hover:underline tabular-nums">({t.connected_via_our_invites.toLocaleString()} via our invites)</button>
    </span>,
    item(t.replied, 'replied', { status: ['replied', 'interested', 'meeting'] }, 'A human reply after one of your touches. Out-of-office and automatic replies do not count.'),
    item(t.interested, 'interested', { status: ['interested', 'meeting'] }, 'A reply classified interested or as a question.'),
    item(t.meetings, t.meetings === 1 ? 'meeting' : 'meetings', { status: ['meeting'] }, 'Reached a stage marked as a meeting.'),
  ];
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-gray-600', q.isFetching && 'opacity-70')} data-tour="leads-totals">
      {parts.map((p, i) => <span key={i} className="inline-flex items-baseline gap-2">{i > 0 && <span className="text-gray-300">·</span>}{p}</span>)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// §5.5 By account panel
// ---------------------------------------------------------------------------
export function ByAccountPanel({ open, onClose, ws, tab, filters, includeRemoved, onIncludeRemoved, onPick }: {
  open: boolean; onClose: () => void; ws: string | undefined; tab: LeadTab; filters: Record<string, unknown>;
  includeRemoved: boolean; onIncludeRemoved: (v: boolean) => void; onPick: (patch: Record<string, unknown>) => void;
}) {
  const q = useLeadsByAccount(ws, { ...filters, tab, include_removed: includeRemoved }, open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const rows: LeadsByAccountRow[] = q.data?.rows ?? [];
  const num = (v: number | null, patch: Record<string, unknown> | null) => (v == null ? <span className="text-gray-300">—</span>
    : patch && v > 0 ? <button type="button" onClick={() => onPick(patch)} className="tabular-nums text-gray-900 hover:text-indigo-700 hover:underline">{v.toLocaleString()}</button> : <span className="tabular-nums text-gray-900">{v.toLocaleString()}</span>);
  return createPortal(
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Leads by account">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <aside className="absolute right-0 top-0 h-full w-full max-w-2xl bg-white shadow-2xl flex flex-col">
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-base font-semibold text-gray-900 inline-flex items-center gap-2"><Users className="w-4 h-4 text-gray-400" /> By account</h2>
            <p className="text-xs text-gray-500 mt-0.5">For the leads in the current view. Click a number to filter the table.</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
              <input type="checkbox" checked={includeRemoved} onChange={(e) => onIncludeRemoved(e.target.checked)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /> Include removed accounts
            </label>
            <button type="button" onClick={onClose} className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100" aria-label="Close"><X className="w-4 h-4" /></button>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-5">
          {q.isLoading ? <Spinner className="min-h-[30vh]" /> : rows.length === 0 ? <p className="text-sm text-gray-500">No account has touched the leads in this view yet.</p> : (
            <Table>
              <thead>
                <tr>
                  <Th>Account</Th><Th>Channel</Th>
                  <Th title="Current LinkedIn 1st-degree / Instagram follow-back connections among the leads in view">Connected</Th>
                  <Th title="Of those, connections that came from an invite or follow of this account">via our invite</Th>
                  <Th title="Invites / follows from this account still unanswered">Pending</Th>
                  <Th title="Leads this account sent an invite, message or email to">Contacted</Th>
                  <Th title="Leads whose human reply this account received">Replied</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sender_id} className={r.removed ? 'opacity-60' : undefined}>
                    <Td><span className="inline-flex items-center gap-2 min-w-0"><Avatar src={r.picture_url} name={r.name} size={6} /><span className="truncate font-medium text-gray-900">{r.name}{r.removed && <span className="text-gray-400 font-normal"> (removed)</span>}</span></span></Td>
                    <Td><ChannelMark channel={r.channel} /></Td>
                    <Td>{num(r.connected, { connected_via: [r.sender_id] })}</Td>
                    <Td>{num(r.via_our_invite, { connected_via: [r.sender_id], connection_source: 'our_invite' })}</Td>
                    <Td>{num(r.pending, { pending_with: [r.sender_id] })}</Td>
                    <Td>{num(r.contacted, null)}</Td>
                    <Td>{num(r.replied, null)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
        <footer className="px-5 py-3 border-t border-gray-200 text-xs text-gray-500">A lead connected to two accounts counts once in each account&apos;s row and once in the totals line. Contacted and Replied use the account that sent the touch or received the reply.</footer>
      </aside>
    </div>, document.body);
}

// ---------------------------------------------------------------------------
// Lead page: Relationships card (§6)
// ---------------------------------------------------------------------------
export function LeadRelationshipsCard({ leadId }: { leadId: string }) {
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const q = useLeadRelationships(leadId, includeRemoved);
  const rows = q.data ?? [];
  const groups = CHANNEL_ORDER.map((c) => ({ channel: c, rows: rows.filter((r) => r.channel === c) })).filter((g) => g.rows.length);
  return (
    <div className="bg-white border border-gray-200 rounded-xl">
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900">Relationships</h2>
        <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <input type="checkbox" checked={includeRemoved} onChange={(e) => setIncludeRemoved(e.target.checked)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /> Include removed accounts
        </label>
      </div>
      {q.isLoading ? <Spinner className="py-8" /> : groups.length === 0 ? (
        <p className="px-5 py-6 text-sm text-gray-500">No account has a relationship with this person yet. One appears once an account invites, follows, messages or emails them, or they write to you.</p>
      ) : (
        <Table className="border-0 rounded-none rounded-b-xl">
          <thead>
            <tr><Th>Account</Th><Th>State</Th><Th className="hidden md:table-cell">Since</Th><Th className="hidden md:table-cell">Source</Th><Th className="hidden lg:table-cell">Last touch</Th><Th className="hidden lg:table-cell">Last reply</Th><Th className="hidden lg:table-cell">Checked</Th></tr>
          </thead>
          <tbody>
            {groups.map((g) => [
              <tr key={`h-${g.channel}`} className="bg-gray-50"><Td className="text-[11px] font-semibold uppercase tracking-wide text-gray-500" colSpan={7}><span className="inline-flex items-center gap-1.5"><ChannelMark channel={g.channel} /> {CHANNEL_META[g.channel].label}</span></Td></tr>,
              ...g.rows.map((r) => {
                const s = relationshipStateText(r, fmtDate);
                return (
                  <tr key={r.sender_id}>
                    <Td><span className="inline-flex items-center gap-2 min-w-0"><Avatar src={r.picture_url} name={r.name} size={6} />{r.removed ? <span className="text-gray-500 truncate">{r.name} (removed)</span> : <Link href={`/outreach/senders/${r.sender_id}`} className="font-medium text-gray-900 hover:text-indigo-700 truncate">{r.name}</Link>}</span></Td>
                    <Td><Badge tone={s.tone}>{s.label}</Badge>{s.detail && r.state !== 'connected' && <span className="block text-[11px] text-gray-500 mt-0.5">{s.detail}</span>}</Td>
                    <Td className="hidden md:table-cell text-xs text-gray-600 whitespace-nowrap">{fmtDate(r.since, false)}</Td>
                    <Td className="hidden md:table-cell text-xs text-gray-600">{r.source ? SOURCE_LABEL[r.source] : r.consent ? `consent: ${r.consent.replace(/_/g, ' ')}` : '—'}</Td>
                    <Td className="hidden lg:table-cell text-xs text-gray-600 whitespace-nowrap">{fmtDate(r.last_touch_at)}</Td>
                    <Td className="hidden lg:table-cell text-xs text-gray-600 whitespace-nowrap">{fmtDate(r.last_reply_at)}</Td>
                    <Td className="hidden lg:table-cell text-xs text-gray-600 whitespace-nowrap">{fmtDate(r.checked_at)}</Td>
                  </tr>
                );
              }),
            ])}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/** The sender list for the Connected via cells (one query per page, shared by every row). */
export function useSendersForCells() {
  const { workspace } = useWorkspace();
  return useSenders(workspace?.id);
}

export { statusLabel, channelOf, type LeadsTotals };
