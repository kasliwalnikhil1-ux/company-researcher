'use client';

import { ChevronDown, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Member } from '@/lib/outreach/types';
import { memberLabel } from './hooks';

/** The thread header's assignee: a quiet pill (person icon + name) over a native select, so phones get their own picker. */
export default function AssigneeSelect({ value, members, disabled, onChange, excludeClientViewers = false }: {
  value: string | null | undefined; members: Member[] | undefined; disabled?: boolean; onChange: (userId: string | null) => void;
  /** web chat: client viewers never answer visitors */
  excludeClientViewers?: boolean;
}) {
  const list = (members ?? []).filter((m) => !excludeClientViewers || m.role !== 'client_viewer');
  const current = list.find((m) => m.user_id === value);
  return (
    <span className={cn('relative inline-flex items-center min-w-0 max-w-[150px] rounded-full border text-xs', value ? 'border-gray-200 bg-white text-gray-800' : 'border-dashed border-gray-300 bg-white text-gray-500')}>
      <UserRound className="pointer-events-none absolute left-2 w-3.5 h-3.5 text-gray-400" aria-hidden />
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} title="Assign conversation" aria-label="Assign conversation"
        className="appearance-none bg-transparent pl-6 pr-6 py-1 rounded-full truncate min-w-0 max-w-full cursor-pointer disabled:cursor-default focus:outline-none focus:ring-2 focus:ring-indigo-500">
        <option value="">Unassigned</option>
        {list.map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
        {value && !current && <option value={value}>Former member</option>}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 w-3 h-3 text-gray-400" aria-hidden />
    </span>
  );
}
