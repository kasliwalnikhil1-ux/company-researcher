'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Search, Users, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, StatusPill } from '@/components/outreach/ui';
import type { Provider, Sender, SenderLabel } from '@/lib/outreach/types';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { PROVIDER_LABELS } from '@/components/outreach/senders/helpers';
import { senderName } from '@/components/outreach/sequences/helpers';
import { channelLabel, senderAccountLabel } from '@/lib/outreach/channels';
import AnchoredMenu, { FieldButton, MenuFooter } from './AnchoredMenu';

const CHANNEL_ORDER = Object.keys(PROVIDER_LABELS) as Provider[];
const subtitle = (s: Sender) => s.provider === 'LINKEDIN'
  ? `${s.is_premium ? 'LinkedIn Premium' : 'LinkedIn Free'} · level ${s.warmup_level}`
  : s.provider === 'INSTAGRAM' || s.provider === 'WHATSAPP' ? (s.public_identifier || PROVIDER_LABELS[s.provider])
    : s.owner_email || `${PROVIDER_LABELS[s.provider]} mailbox`;

/** One row of the menu: a live sender, or an account that was removed from Senders (its conversations stay). */
type Row = { id: string; provider: Provider; name: string; sub: string; picture: string | null; sender: Sender | null; removed: boolean; haystack: string };

/**
 * The inbox's Sender filter: pick any number of accounts, with a search box and a channel switch, the same menu as the
 * sender pool of a sequence. Removed accounts are listed last so a conversation on one can still be found.
 */
export default function SenderMultiSelect({ senders, removed, value, onChange, label = 'Sender', allLabel = 'All senders', title }: {
  senders: Sender[]; removed: SenderLabel[]; value: string[]; onChange: (ids: string[]) => void;
  /** The leads page reuses this menu for Connected via / Pending with. */
  label?: string; allLabel?: string; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // closing (Done, Escape, backdrop, the field) also drops the search, so the menu reopens on the full list
  const close = useCallback(() => { setOpen(false); setQ(''); }, []);
  const anchor = useRef<HTMLDivElement>(null);
  // '' = every channel; kept between openings so the menu reopens on the channel last worked on.
  const [channel, setChannel] = useState<Provider | ''>('');

  const rows = useMemo<Row[]>(() => [
    ...senders.map((s) => ({ id: s.id, provider: s.provider, name: senderName(s), sub: subtitle(s), picture: s.picture_url ?? null, sender: s, removed: false,
      haystack: [s.display_name, s.owner_email, s.public_identifier, s.provider, s.is_premium ? 'premium' : 'free'].filter(Boolean).join(' ').toLowerCase() })),
    ...removed.map((l) => ({ id: l.id, provider: l.provider, name: senderAccountLabel(l), sub: [l.public_identifier, l.owner_email].filter((v): v is string => !!v).join(' · ') || channelLabel(l.provider), picture: l.picture_url, sender: null, removed: true,
      haystack: [l.display_name, l.owner_email, l.public_identifier, l.provider, 'removed'].filter(Boolean).join(' ').toLowerCase() })),
  ], [senders, removed]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r] as const)), [rows]);
  const selected = value.map((id) => byId.get(id)).filter((r): r is Row => !!r);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  // Only channels the workspace has accounts on get a chip; the switch hides itself when there is just one.
  const channels = CHANNEL_ORDER.filter((p) => rows.some((r) => r.provider === p));
  const active = channel && channels.includes(channel) ? channel : '';
  const countOf = (p: Provider | '', ids?: string[]) => rows.filter((r) => (!p || r.provider === p) && (!ids || ids.includes(r.id))).length;
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!active || r.provider === active) && (!needle || r.haystack.includes(needle)));
  const live = shown.filter((r) => !r.removed);
  const gone = shown.filter((r) => r.removed);
  // "All" lists live senders under a header per channel; a single channel is one flat list. Removed accounts close the menu.
  const groups = (active ? [active] : channels).map((p) => ({ provider: p, rows: live.filter((r) => r.provider === p) })).filter((g) => g.rows.length > 0);
  const selectedByChannel = channels.map((p) => ({ provider: p, n: selected.filter((r) => r.provider === p).length })).filter((c) => c.n > 0);

  const summary = selected.length === 0 ? allLabel : (
    <>
      <span className="flex -space-x-2 flex-shrink-0">
        {selected.slice(0, 4).map((r) => <span key={r.id} className="ring-2 ring-white rounded-full"><Avatar src={r.picture} name={r.name} size={5} /></span>)}
      </span>
      <span className="truncate">{selected.length === 1 ? selected[0].name : `${selected.length} senders`}</span>
      {selectedByChannel.length > 1 && (
        <span className="flex items-center gap-1.5 pl-1.5 border-l border-gray-200 flex-shrink-0" aria-label={selectedByChannel.map((c) => `${PROVIDER_LABELS[c.provider]} ${c.n}`).join(', ')}>
          {selectedByChannel.map((c) => (
            <span key={c.provider} className="inline-flex items-center gap-0.5 text-xs text-gray-600 tabular-nums" title={`${c.n} ${PROVIDER_LABELS[c.provider]} sender${c.n === 1 ? '' : 's'}`}>
              <ProviderLogo provider={c.provider} className="w-3.5 h-3.5" />{c.n}
            </span>
          ))}
        </span>
      )}
    </>
  );

  return (
    <div>
      <span className="block text-[11px] font-medium text-gray-500 mb-1">{label}</span>
      {/* menus open from the field box, not the label above it */}
      <div ref={anchor}><FieldButton label={label} title={title} summary={summary} picked={selected.length > 0} icon={<Users className="w-4 h-4 text-gray-400 flex-shrink-0" />} open={open} onOpen={() => { if (open) close(); else setOpen(true); }} onClear={() => onChange([])} /></div>
      {open && (
        <AnchoredMenu anchorRef={anchor} onClose={close} label={label} width={416}>
          {rows.length > 0 && (
            <div className="p-2 border-b border-gray-100 space-y-2">
              <label className="relative block">
                <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={active ? `Search ${PROVIDER_LABELS[active]} senders` : 'Search senders'} aria-label="Search senders" className="w-full pl-8 pr-7 py-1.5 text-sm rounded-lg border border-gray-200 bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                {q && <button type="button" onClick={() => setQ('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600" aria-label="Clear search" title="Clear search"><X className="w-3.5 h-3.5" /></button>}
              </label>
              {channels.length > 1 && (
                <div role="radiogroup" aria-label="Channel" className="flex flex-wrap gap-1.5">
                  {(['', ...channels] as Array<Provider | ''>).map((p) => {
                    const on = active === p;
                    const picked = countOf(p, value);
                    const total = countOf(p);
                    const name = p ? PROVIDER_LABELS[p] : 'All channels';
                    return (
                      <button key={p || 'all'} type="button" role="radio" aria-checked={on} onClick={() => setChannel(p)} title={`${name}: ${picked} of ${total} picked`}
                        className={cn('inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                          on ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50')}>
                        {p ? <ProviderLogo provider={p} className="w-3.5 h-3.5" /> : <span>All</span>}
                        {p && <span>{PROVIDER_LABELS[p]}</span>}
                        <span className={cn('tabular-nums', on ? 'text-indigo-700' : 'text-gray-400')}>{picked > 0 ? `${picked}/${total}` : total}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <div className="py-1 overflow-y-auto min-h-0" role="listbox" aria-multiselectable="true">
            {rows.length === 0 && <p className="px-3 py-3 text-xs text-gray-500">No senders connected yet. Connect one under Senders.</p>}
            {rows.length > 0 && shown.length === 0 && <p className="px-3 py-3 text-xs text-gray-500">No {active ? `${PROVIDER_LABELS[active]} ` : ''}senders match “{q.trim()}”.</p>}
            {groups.map((g) => (
              <div key={g.provider} role="group" aria-label={PROVIDER_LABELS[g.provider]}>
                {(!active && channels.length > 1) && (
                  <div className="sticky top-0 z-[1] flex items-center gap-1.5 px-3 pt-2 pb-1 bg-white text-[11px] font-medium uppercase tracking-wide text-gray-500">
                    <ProviderLogo provider={g.provider} className="w-3 h-3" />
                    <span className="flex-1">{PROVIDER_LABELS[g.provider]}</span>
                    <span className="normal-case tracking-normal font-normal tabular-nums">{countOf(g.provider, value)} of {countOf(g.provider)} picked</span>
                  </div>
                )}
                {g.rows.map((r) => <RowItem key={r.id} row={r} checked={value.includes(r.id)} onToggle={() => toggle(r.id)} />)}
              </div>
            ))}
            {gone.length > 0 && (
              <div role="group" aria-label="Removed accounts">
                <div className="sticky top-0 z-[1] px-3 pt-2 pb-1 bg-white text-[11px] font-medium uppercase tracking-wide text-gray-500">Removed accounts</div>
                {gone.map((r) => <RowItem key={r.id} row={r} checked={value.includes(r.id)} onToggle={() => toggle(r.id)} />)}
              </div>
            )}
          </div>
          <MenuFooter picked={value.length} total={rows.length} noun="sender" onClear={() => onChange([])} onDone={close} />
        </AnchoredMenu>
      )}
    </div>
  );
}

function RowItem({ row, checked, onToggle }: { row: Row; checked: boolean; onToggle: () => void }) {
  return (
    <label className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer" title={row.removed ? `${channelLabel(row.provider)} account "${row.name}" was removed from Senders. Its conversations stay.` : undefined}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
      <span className={cn('relative shrink-0', row.removed && 'opacity-60')}>
        <Avatar src={row.picture} name={row.name} size={8} />
        <span className="absolute -bottom-0.5 -right-0.5 rounded bg-white p-px ring-1 ring-white" title={PROVIDER_LABELS[row.provider]}><ProviderLogo provider={row.provider} className="w-3 h-3" /></span>
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', row.removed ? 'text-gray-500' : 'text-gray-800')}>{row.name}</span>
        <span className="block text-[11px] text-gray-500 truncate">{row.sub}</span>
      </span>
      {row.sender ? <StatusPill status={row.sender.status} reason={row.sender.status_reason} /> : <span className="text-[10px] px-1.5 py-0.5 rounded border border-dashed border-gray-300 text-gray-400 whitespace-nowrap">Removed</span>}
    </label>
  );
}
