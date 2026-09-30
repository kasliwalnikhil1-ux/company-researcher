'use client';

// @mention picker for the note composer (private-notes-PRD.md §4.3): members who can read this conversation, grouped
// Team / Client, searchable by name or email, arrow keys + Enter / Tab, Escape closes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { Member } from '@/lib/outreach/types';
import { Avatar } from '@/components/outreach/ui';
import { groupMembersForPicker, memberDisplayName } from '@/lib/outreach/notes';

export interface MentionPickerProps {
  members: Member[];
  currentUserId: string | null;
  query: string;
  onPick: (m: Member) => void;
  onClose: () => void;
  /** anchor: the picker sits above the composer, aligned left */
  className?: string;
}

export default function MentionPicker({ members, currentUserId, query, onPick, onClose, className }: MentionPickerProps) {
  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const filtered = members.filter((m) => !q || memberDisplayName(m).toLowerCase().includes(q) || (m.email ?? '').toLowerCase().includes(q));
    return groupMembersForPicker(filtered, currentUserId);
  }, [members, q, currentUserId]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // the highlighted row is keyed on the query: a new query starts at the top without an effect
  const [sel, setSel] = useState<{ q: string; i: number }>({ q, i: 0 });
  const idx = Math.max(0, Math.min(sel.q === q ? sel.i : 0, flat.length - 1));
  const setIdx = (f: (i: number) => number) => setSel((s) => ({ q, i: f(s.q === q ? s.i : 0) }));
  const indexOf = useMemo(() => new Map(flat.map((m, i) => [m.user_id, i])), [flat]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(flat.length - 1, i + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
      else if (e.key === 'Enter' || e.key === 'Tab') { if (flat[idx]) { e.preventDefault(); onPick(flat[idx]); } }
      else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [flat, idx, onPick, onClose]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  return (
    <div ref={listRef} role="listbox" aria-label="Mention a teammate" className={cn('absolute z-30 w-72 max-h-64 overflow-y-auto rounded-lg border border-amber-200 bg-white shadow-lg py-1', className)}>
      {flat.length === 0 && <div className="px-3 py-2 text-xs text-gray-500">{members.length === 0 ? 'Nobody else can see this conversation.' : 'No teammate matches.'}</div>}
      {groups.map((g) => (
        <div key={g.label}>
          <div className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-gray-400">{g.label}</div>
          {g.items.map((m) => {
            const i = indexOf.get(m.user_id) ?? 0;
            const name = memberDisplayName(m);
            return (
              <button key={m.user_id} type="button" role="option" aria-selected={i === idx} data-idx={i}
                onMouseDown={(e) => { e.preventDefault(); onPick(m); }} onMouseEnter={() => setIdx(() => i)}
                className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm', i === idx ? 'bg-amber-50 text-amber-950' : 'text-gray-800 hover:bg-gray-50')}>
                <Avatar name={name} size={6} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{name}</span>
                  {m.email && m.email !== name && <span className="block truncate text-[11px] text-gray-400">{m.email}</span>}
                </span>
                <span className="text-[10px] text-gray-400 capitalize">{m.role.replace('_', ' ')}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
