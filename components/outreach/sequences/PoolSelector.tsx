'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, Search, Users, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, Button, StatusPill } from '@/components/outreach/ui';
import type { Provider, Sender } from '@/lib/outreach/types';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { PROVIDER_LABELS } from '@/components/outreach/senders/helpers';
import { senderName } from './helpers';
import RebalanceDialog from './RebalanceDialog';
import type { SetPoolResult } from './publishTypes';

const STATUS_REASON: Record<Sender['status'], string> = {
  ok: '', connecting: 'still connecting', credentials: 'needs re-login', error: 'in error', paused: 'paused', disabled: 'disabled', disconnected: 'disconnected',
};

const samePool = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
const CHANNEL_ORDER = Object.keys(PROVIDER_LABELS) as Provider[];
const subtitle = (s: Sender) => s.provider === 'LINKEDIN'
  ? `${s.is_premium ? 'LinkedIn Premium' : 'LinkedIn Free'} · level ${s.warmup_level}`
  : s.provider === 'INSTAGRAM' || s.provider === 'WHATSAPP' ? (s.public_identifier || PROVIDER_LABELS[s.provider])
    : s.owner_email || `${PROVIDER_LABELS[s.provider]} mailbox`;

interface Props {
  pool: string[];
  senders: Sender[];
  onChange: (pool: string[]) => void;
  disabled?: boolean;
  /**
   * Set for sequences that have (or had) leads. The change is then staged in the menu, previewed with
   * rebalance_preview and applied at once with set_pool, because a pool change is not part of the draft.
   */
  live?: { sequenceId: string; onApplied: (pool: string[], result: SetPoolResult) => void };
}

export default function PoolSelector({ pool, senders, onChange, disabled, live }: Props) {
  const [open, setOpen] = useState(false);
  const [staged, setStaged] = useState<string[]>(pool);
  const [review, setReview] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  // '' = every channel; kept between openings so the menu reopens on the channel last worked on.
  const [channel, setChannel] = useState<Provider | ''>('');
  useEffect(() => { if (!open) { setStaged(pool); setQ(''); } }, [pool, open]);

  const current = live ? staged : pool;
  const selected = pool.map((id) => senders.find((s) => s.id === id)).filter(Boolean) as Sender[];
  const notOk = selected.filter((s) => s.status !== 'ok').length;
  const changed = !!live && !samePool(staged, pool);
  const toggle = (id: string) => {
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    if (live) setStaged(next); else onChange(next);
  };
  const close = () => setOpen(false);
  // Only channels the workspace has senders on get a tab; the filter hides itself when there is just one.
  const channels = CHANNEL_ORDER.filter((p) => senders.some((s) => s.provider === p));
  const active = channel && channels.includes(channel) ? channel : '';
  const countOf = (p: Provider | '', ids?: string[]) => (p ? senders.filter((s) => s.provider === p) : senders).filter((s) => !ids || ids.includes(s.id)).length;
  const needle = q.trim().toLowerCase();
  const shown = senders.filter((s) => (!active || s.provider === active) && (!needle
    || [s.display_name, s.owner_email, s.public_identifier, s.provider, s.is_premium ? 'premium' : 'free'].some((v) => v?.toLowerCase().includes(needle))));
  // "All" lists senders under a header per channel; a single channel is one flat list.
  const groups = (active ? [active] : channels)
    .map((p) => ({ provider: p, rows: shown.filter((s) => s.provider === p) }))
    .filter((g) => g.rows.length > 0);
  // Pool size per channel for the closed button, e.g. LinkedIn 2 · Gmail 1.
  const selectedByChannel = channels.map((p) => ({ provider: p, n: selected.filter((s) => s.provider === p).length })).filter((c) => c.n > 0);

  return (
    <div className="relative">
      <button type="button" disabled={disabled} onClick={() => setOpen((o) => !o)} title="Sender pool" className={cn('inline-flex items-center gap-2 h-9 px-3 rounded-lg border text-sm bg-white hover:bg-gray-50 disabled:opacity-60', notOk ? 'border-amber-400' : 'border-gray-300')} aria-haspopup="listbox" aria-expanded={open}>
        <Users className="w-4 h-4 text-gray-500" />
        {selected.length === 0 ? (
          <span className="text-gray-500">No senders in pool</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="flex -space-x-2">
              {selected.slice(0, 4).map((s) => <span key={s.id} className="ring-2 ring-white rounded-full"><Avatar src={s.picture_url} name={senderName(s)} size={6} /></span>)}
            </span>
            <span className="text-gray-700">{selected.length} sender{selected.length === 1 ? '' : 's'}</span>
            {selectedByChannel.length > 1 && (
              <span className="flex items-center gap-1.5 pl-1.5 border-l border-gray-200" aria-label={selectedByChannel.map((c) => `${PROVIDER_LABELS[c.provider]} ${c.n}`).join(', ')}>
                {selectedByChannel.map((c) => (
                  <span key={c.provider} className="inline-flex items-center gap-0.5 text-xs text-gray-600 tabular-nums" title={`${c.n} ${PROVIDER_LABELS[c.provider]} sender${c.n === 1 ? '' : 's'}`}>
                    <ProviderLogo provider={c.provider} className="w-3.5 h-3.5" />{c.n}
                  </span>
                ))}
              </span>
            )}
            {notOk > 0 && <span className="text-xs text-amber-700">({notOk} not ready)</span>}
          </span>
        )}
        <ChevronDown className="w-4 h-4 text-gray-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={close} />
          <div className="absolute z-30 mt-1 w-[30rem] max-w-[90vw] bg-white border border-gray-200 rounded-lg shadow-lg flex flex-col max-h-[28rem]" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
            {senders.length > 0 && (
              <div className="p-2 border-b border-gray-100 space-y-2">
                <label className="relative block">
                  <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={active ? `Search ${PROVIDER_LABELS[active]} senders` : 'Search senders'} aria-label="Search senders" className="w-full pl-8 pr-7 py-1.5 text-sm rounded-lg border border-gray-200 bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  {q && <button type="button" onClick={() => setQ('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600" aria-label="Clear search" title="Clear search"><X className="w-3.5 h-3.5" /></button>}
                </label>
                {channels.length > 1 && (
                  // Chips wrap onto a second line rather than scroll, so no channel is ever hidden off the edge.
                  <div role="radiogroup" aria-label="Channel" className="flex flex-wrap gap-1.5">
                    {(['', ...channels] as Array<Provider | ''>).map((p) => {
                      const on = active === p;
                      const inPool = countOf(p, current);
                      const total = countOf(p);
                      const name = p ? PROVIDER_LABELS[p] : 'All channels';
                      return (
                        <button key={p || 'all'} type="button" role="radio" aria-checked={on} onClick={() => setChannel(p)}
                          title={`${name}: ${inPool} of ${total} in pool`}
                          className={cn('inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                            on ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50')}>
                          {p ? <ProviderLogo provider={p} className="w-3.5 h-3.5" /> : <span>All</span>}
                          {p && <span>{PROVIDER_LABELS[p]}</span>}
                          <span className={cn('tabular-nums', on ? 'text-indigo-700' : 'text-gray-400')}>{inPool > 0 ? `${inPool}/${total}` : total}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <div className="py-1 overflow-y-auto" role="listbox" aria-multiselectable="true">
              {senders.length === 0 && <p className="px-3 py-3 text-xs text-gray-500">No senders connected yet. Connect one under Senders.</p>}
              {senders.length > 0 && shown.length === 0 && <p className="px-3 py-3 text-xs text-gray-500">No {active ? `${PROVIDER_LABELS[active]} ` : ''}senders match “{q.trim()}”.</p>}
              {groups.map((g) => (
                <div key={g.provider} role="group" aria-label={PROVIDER_LABELS[g.provider]}>
                  {(!active && channels.length > 1) && (
                    <div className="sticky top-0 z-[1] flex items-center gap-1.5 px-3 pt-2 pb-1 bg-white text-[11px] font-medium uppercase tracking-wide text-gray-500">
                      <ProviderLogo provider={g.provider} className="w-3 h-3" />
                      <span className="flex-1">{PROVIDER_LABELS[g.provider]}</span>
                      <span className="normal-case tracking-normal font-normal tabular-nums">{countOf(g.provider, current)} of {countOf(g.provider)} in pool</span>
                    </div>
                  )}
                  {g.rows.map((s) => {
                    const selectable = s.status === 'ok';
                    const checked = current.includes(s.id);
                    const reason = s.status_reason || STATUS_REASON[s.status] || s.status;
                    return (
                      <label key={s.id} className={cn('flex items-center gap-2 px-3 py-2 text-sm', selectable || checked ? 'hover:bg-gray-50 cursor-pointer' : 'opacity-60 cursor-not-allowed')} title={selectable ? undefined : `Cannot add: ${reason}`}>
                        <input type="checkbox" checked={checked} disabled={!selectable && !checked} onChange={() => toggle(s.id)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                        <span className="relative shrink-0">
                          <Avatar src={s.picture_url} name={senderName(s)} size={8} />
                          <span className="absolute -bottom-0.5 -right-0.5 rounded bg-white p-px ring-1 ring-white" title={PROVIDER_LABELS[s.provider]}><ProviderLogo provider={s.provider} className="w-3 h-3" /></span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-gray-800">{senderName(s)}</span>
                          <span className="block text-[11px] text-gray-500 truncate">{subtitle(s)}</span>
                        </span>
                        <StatusPill status={s.status} reason={s.status_reason} />
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
            {live && (
              <div className="border-t border-gray-100 px-3 py-2 flex items-center gap-2">
                <p className="text-[11px] text-gray-500 flex-1">Pool changes apply right away. You first see which leads can move.</p>
                <Button size="sm" disabled={!changed} onClick={() => { setReview(staged); close(); }}>Review change</Button>
              </div>
            )}
          </div>
        </>
      )}
      {live && (
        <RebalanceDialog
          open={!!review} sequenceId={live.sequenceId} pool={review ?? pool} senders={senders}
          onClose={() => setReview(null)}
          onApplied={(next, result) => { setReview(null); setStaged(next); live.onApplied(next, result); }}
        />
      )}
    </div>
  );
}
