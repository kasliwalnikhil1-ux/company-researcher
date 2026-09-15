'use client';

import { useState } from 'react';
import { ChevronDown, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, StatusPill } from '@/components/outreach/ui';
import type { Sender } from '@/lib/outreach/types';
import { senderName } from './helpers';

const STATUS_REASON: Record<Sender['status'], string> = {
  ok: '', connecting: 'still connecting', credentials: 'needs re-login', error: 'in error', paused: 'paused', disabled: 'disabled',
};

export default function PoolSelector({ pool, senders, onChange, disabled }: { pool: string[]; senders: Sender[]; onChange: (pool: string[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const selected = pool.map((id) => senders.find((s) => s.id === id)).filter(Boolean) as Sender[];
  const notOk = selected.filter((s) => s.status !== 'ok').length;
  const toggle = (id: string) => onChange(pool.includes(id) ? pool.filter((x) => x !== id) : [...pool, id]);
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
            {notOk > 0 && <span className="text-xs text-amber-700">({notOk} not ready)</span>}
          </span>
        )}
        <ChevronDown className="w-4 h-4 text-gray-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute z-30 mt-1 w-80 max-w-[90vw] bg-white border border-gray-200 rounded-lg shadow-lg py-1 max-h-80 overflow-y-auto" role="listbox">
            {senders.length === 0 && <p className="px-3 py-3 text-xs text-gray-500">No senders connected yet. Connect one under Senders.</p>}
            {senders.map((s) => {
              const selectable = s.status === 'ok';
              const checked = pool.includes(s.id);
              const reason = s.status_reason || STATUS_REASON[s.status] || s.status;
              return (
                <label key={s.id} className={cn('flex items-center gap-2 px-3 py-2 text-sm', selectable || checked ? 'hover:bg-gray-50 cursor-pointer' : 'opacity-60 cursor-not-allowed')} title={selectable ? undefined : `Cannot add: ${reason}`}>
                  <input type="checkbox" checked={checked} disabled={!selectable && !checked} onChange={() => toggle(s.id)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                  <Avatar src={s.picture_url} name={senderName(s)} size={8} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-gray-800">{senderName(s)}</span>
                    <span className="block text-[11px] text-gray-500 truncate">{s.provider === 'LINKEDIN' ? (s.is_premium ? 'LinkedIn Premium' : 'LinkedIn Free') : `${s.provider} mailbox`}{s.provider === 'LINKEDIN' ? ` · level ${s.warmup_level}` : ''}</span>
                  </span>
                  <StatusPill status={s.status} reason={s.status_reason} />
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
