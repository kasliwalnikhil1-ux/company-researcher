'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useLists } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import type { List } from '@/lib/outreach/types';
import { Button } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';

const NEW = '__new__';

/**
 * Every place a lead's list is chosen uses this picker, so a new list can always be made on the spot ("+ New list…") without leaving
 * the screen.
 *
 * Without `emptyLabel` a list has to be chosen (imports): there is no "no list" answer, and a workspace without lists starts on the
 * name of a new one. With `emptyLabel` the empty choice is a real answer shown under that label ("No list", "Any list", "None (clear)").
 */
export function ListPicker({ value, onChange, label = 'Add to list', emptyLabel, disabled, compact, onNaming }: {
  value: string; onChange: (listId: string) => void; label?: string;
  /** Makes the empty choice selectable under this label. Leave out where a list is required. */
  emptyLabel?: string;
  disabled?: boolean;
  /** The small style of side panels. */
  compact?: boolean;
  /** Told when the name field of a new list opens and closes, so a dialog can hold its own button until the list exists. */
  onNaming?: (naming: boolean) => void;
}) {
  const { workspace } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const lists = useLists(ws);
  const [wantNew, setWant] = useState(false);
  const setWantNew = (v: boolean) => { setWant(v); onNaming?.(v); };
  const [before, setBefore] = useState('');   // the list that was chosen when "+ New list…" was opened
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const required = emptyLabel === undefined;
  const rows = lists.data ?? [];
  const none = lists.isSuccess && rows.length === 0;
  const creating = wantNew || (required && none && !disabled);
  const canCancel = !(required && none);
  const cancel = () => { setWantNew(false); setName(''); setError(null); if (required && before) onChange(before); };

  const create = async () => {
    const n = name.trim();
    if (!ws || !n || busy) return;
    // a name that exists already is that list, not a second one with the same name
    const same = rows.find((l) => l.name.trim().toLowerCase() === n.toLowerCase());
    if (same) { onChange(same.id); setWantNew(false); setName(''); setError(null); return; }
    setBusy(true); setError(null);
    try {
      const { data, error: err } = await supabase.from('outreach_lists').insert({ workspace_id: ws, name: n }).select('*').single();
      if (err) throw err;
      const row = data as List;
      qc.setQueryData<List[]>(qk.lists(ws), (old) => [...(old ?? []).filter((l) => l.id !== row.id), row].sort((a, b) => a.name.localeCompare(b.name)));
      qc.invalidateQueries({ queryKey: qk.lists(ws) });
      onChange(row.id); setWantNew(false); setName('');
    } catch (e) {
      setError(parseError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const labelCls = compact ? 'block text-[11px] text-gray-500 mb-1' : 'block text-xs font-medium text-gray-600 mb-1';
  const fieldCls = compact
    ? 'text-xs px-2 py-1.5 rounded-md border border-gray-200 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500'
    : 'text-sm px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';

  if (!creating) {
    const missing = required && !value && !lists.isLoading && !disabled;
    return (
      <div>
        <label className="block">
          {label && <span className={labelCls}>{label}</span>}
          <select value={value} disabled={disabled || lists.isLoading} aria-required={required} className={cn('w-full disabled:opacity-60', fieldCls, missing && 'border-amber-400')}
            onChange={(e) => {
              if (e.target.value !== NEW) { onChange(e.target.value); return; }
              // where a list is required, nothing is chosen while the new one is being named (an import cannot start into the list picked before); Cancel brings it back
              setBefore(value); if (required) onChange('');
              setWantNew(true); setError(null);
            }}>
            {required ? <option value="" disabled>{lists.isLoading ? 'Loading lists…' : 'Choose a list…'}</option> : <option value="">{emptyLabel}</option>}
            {rows.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            {!disabled && <option value={NEW}>+ New list…</option>}
          </select>
        </label>
        {lists.error ? <span className="block text-xs text-red-600 mt-1">{parseError(lists.error).message}</span> : missing ? <span className="block text-xs text-amber-700 mt-1">Choose a list, or make a new one.</span> : null}
      </div>
    );
  }

  return (
    <div>
      {label && <span className={labelCls}>{label}: new list</span>}
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="New list name" value={name} onChange={(e) => setName(e.target.value)} disabled={disabled || busy} autoFocus={wantNew} maxLength={120} placeholder="Q3 SaaS founders"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } if (e.key === 'Escape' && canCancel) { e.stopPropagation(); cancel(); } }}
          className={cn('flex-1 min-w-[140px] placeholder:text-gray-400', fieldCls)} />
        <Button type="button" size={compact ? 'sm' : 'md'} onClick={create} loading={busy} disabled={disabled || !name.trim()}><Plus className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} /> Create list</Button>
        {canCancel && <Button type="button" size={compact ? 'sm' : 'md'} variant="ghost" onClick={cancel} disabled={busy}>Cancel</Button>}
      </div>
      {error ? <span className="block text-xs text-red-600 mt-1">{error}</span> : <span className="block text-xs text-gray-500 mt-1">{canCancel ? 'The list is created and chosen right here.' : 'This workspace has no list yet. Name one: it is created and chosen right here.'}</span>}
    </div>
  );
}
