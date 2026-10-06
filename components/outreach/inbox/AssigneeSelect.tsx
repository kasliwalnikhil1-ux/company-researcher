'use client';

import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Member } from '@/lib/outreach/types';
import { MemberAvatar, UnassignedAvatar } from '@/components/outreach/members';
import { memberLabel } from './hooks';

const HELP = 'The teammate who owns this conversation and should answer it. Assigned chats show under "Mine" in their inbox.';

/** The thread header's assignee: a quiet pill (avatar + name) that opens a short menu with a header explaining it. */
export default function AssigneeSelect({ value, members, disabled, onChange, excludeClientViewers = false }: {
  value: string | null | undefined; members: Member[] | undefined; disabled?: boolean; onChange: (userId: string | null) => void;
  /** web chat: client viewers never answer visitors */
  excludeClientViewers?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const list = (members ?? []).filter((m) => !excludeClientViewers || m.role !== 'client_viewer');
  const current = list.find((m) => m.user_id === value);
  const label = current ? memberLabel(current) : value ? 'Former member' : 'Unassigned';
  const pick = (id: string | null) => { setOpen(false); if (id !== (value ?? null)) onChange(id); };
  const item = (id: string | null, text: string, m?: Member) => (
    <button key={id ?? 'none'} type="button" role="menuitemradio" aria-checked={(value ?? null) === id} onClick={() => pick(id)}
      className={cn('w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-gray-50', (value ?? null) === id ? 'text-indigo-700' : 'text-gray-700')}>
      {m ? <MemberAvatar member={m} size={6} /> : <UnassignedAvatar size={6} />}
      <span className="flex-1 truncate">{text}</span>{(value ?? null) === id && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
    </button>
  );
  return (
    <div className="relative min-w-0">
      <button type="button" onClick={() => setOpen((o) => !o)} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-label="Assign conversation"
        title={`Assigned to: ${label}\n${HELP}`}
        className={cn('relative inline-flex items-center gap-1.5 min-w-0 max-w-[160px] rounded-full border text-xs pl-0.5 pr-6 py-0.5 cursor-pointer disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
          value ? 'border-gray-200 bg-white text-gray-800' : 'border-dashed border-gray-300 bg-white text-gray-500')}>
        {current ? <MemberAvatar member={current} size={5} /> : <UnassignedAvatar size={5} />}
        <span className="truncate">{label}</span>
        <ChevronDown className="pointer-events-none absolute right-2 w-3 h-3 text-gray-400" aria-hidden />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute z-30 right-0 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg py-1" role="menu">
            <div className="px-3 py-2 border-b border-gray-100">
              <div className="text-xs font-semibold text-gray-900">Assigned to</div>
              <div className="text-[11px] text-gray-500 leading-snug">{HELP}</div>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {item(null, 'Unassigned')}
              {list.map((m) => item(m.user_id, memberLabel(m), m))}
              {value && !current && item(value, 'Former member')}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
