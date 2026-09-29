'use client';

import { useMemo } from 'react';
import { SearchableSelect } from '@/components/outreach/ui';
import type { SelectOption } from '@/components/outreach/ui';
import type { PromptListRow, PromptScope } from '@/lib/outreach/aiReplies';
import type { Client, Sequence } from '@/lib/outreach/types';
import type { PromptScopeRef } from './draftContext';

export const scopeValue = (s: PromptScopeRef) => (s.scope === 'workspace' ? 'workspace' : `${s.scope}:${s.scopeId}`);
export function parseScopeValue(v: string): PromptScopeRef {
  if (v === 'workspace' || !v.includes(':')) return { scope: 'workspace', scopeId: null };
  const [scope, id] = v.split(':');
  return { scope: scope as PromptScope, scopeId: id || null };
}

/** Plain label for a scope: "Workspace", "Client · Acme", "Sequence · Founders Q4". */
export function scopeLabel(s: PromptScopeRef, clients: Client[] | undefined, sequences: Sequence[] | undefined, rows?: PromptListRow[]): string {
  if (s.scope === 'workspace') return 'Workspace';
  const row = rows?.find((r) => r.scope === s.scope && r.scope_id === s.scopeId);
  const name = s.scope === 'client' ? clients?.find((c) => c.id === s.scopeId)?.name : sequences?.find((q) => q.id === s.scopeId)?.name;
  return `${s.scope === 'client' ? 'Client' : 'Sequence'} · ${name ?? row?.scope_label ?? 'Unknown'}`;
}

export default function ScopePicker({ value, onChange, rows, clients, sequences, disabled }: {
  value: PromptScopeRef;
  onChange: (s: PromptScopeRef) => void;
  rows: PromptListRow[];
  clients: Client[];
  sequences: Sequence[];
  disabled?: boolean;
}) {
  const current = scopeValue(value);
  const options = useMemo<SelectOption[]>(() => {
    const has = (scope: PromptScope, id: string) => rows.some((r) => r.scope === scope && r.scope_id === id);
    const ws = rows.find((r) => r.scope === 'workspace');
    return [
      { value: 'workspace', label: 'Workspace (default)', hint: ws ? `Version ${ws.version}` : 'Not saved yet' },
      ...clients.map((c) => ({ value: `client:${c.id}`, label: `Client · ${c.name}`, hint: has('client', c.id) ? 'Own prompt' : 'Inherits', keywords: 'client' })),
      ...sequences.filter((q) => q.status !== 'archived' || has('sequence', q.id) || current === `sequence:${q.id}`).map((q) => ({ value: `sequence:${q.id}`, label: `Sequence · ${q.name}`, hint: has('sequence', q.id) ? 'Own prompt' : 'Inherits', keywords: 'sequence' })),
    ];
  }, [rows, clients, sequences, current]);

  return (
    <SearchableSelect aria-label="Which prompt to edit" value={current} onChange={(v) => onChange(parseScopeValue(v))} options={options}
      searchPlaceholder="Search clients and sequences…" disabled={disabled} className="w-72" />
  );
}
