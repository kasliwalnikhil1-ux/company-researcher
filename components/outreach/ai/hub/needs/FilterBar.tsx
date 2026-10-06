'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Braces, Check, ChevronDown, CircleHelp, FileText, Globe, MapPin, MessageSquareReply, Quote, Search, User, UserPen, Users, Workflow, X } from 'lucide-react';
import { NEEDS_YOU_TYPES, NEEDS_YOU_TYPE_LABEL, type HubSetup, type NeedsYouCounts, type NeedsYouFilters, type NeedsYouType } from '@/lib/outreach/aiHub';
import { cn } from '@/lib/utils';

type PlaceKind = 'sequence' | 'variable' | 'website';
interface PlaceGroup { kind: PlaceKind; label: string; items: Array<{ id: string; name: string }> }

/** Which kinds of place a type's cards come from. null (All) = every kind; profile cards have none. */
const KINDS: Record<NeedsYouType, PlaceKind[]> = { reply: ['sequence'], draft: ['sequence'], line: ['variable'], website: ['website'], question: ['sequence', 'website'], profile: [] };
const ALL_KINDS: PlaceKind[] = ['sequence', 'variable', 'website'];
const KIND_WORD: Record<PlaceKind, string> = { sequence: 'sequences', variable: 'variables', website: 'websites' };
const KIND_ICON: Record<PlaceKind, typeof Globe> = { sequence: Workflow, variable: Braces, website: Globe };
/** The Where list gets a search box once it is longer than this. */
const SEARCH_FROM = 8;

function placeGroups(setup: HubSetup | undefined, type: NeedsYouType | null): PlaceGroup[] {
  if (!setup) return [];
  const all: Record<PlaceKind, PlaceGroup> = {
    sequence: { kind: 'sequence', label: 'Sequences', items: (setup.sequences ?? []).map((s) => ({ id: s.id, name: s.name })) },
    variable: { kind: 'variable', label: 'Variables', items: (setup.variables ?? []).map((v) => ({ id: v.id, name: v.key })) },
    website: { kind: 'website', label: 'Websites', items: (setup.websites ?? []).map((w) => ({ id: w.id, name: w.name })) },
  };
  return (type ? KINDS[type] : ALL_KINDS).map((k) => all[k]).filter((g) => g.items.length > 0);
}

/** A Where filter survives a change of type only when the new type has cards in that kind of place. */
export function whereFits(setup: HubSetup | undefined, type: NeedsYouType | null, where: string | null): boolean {
  if (!where) return true;
  if (!setup) return false;
  return placeGroups(setup, type).some((g) => g.items.some((o) => o.id === where));
}

/** "All sequences" when the type only has one kind of place, else "All places". */
const allPlaces = (groups: PlaceGroup[]) => groups.length === 1 ? `All ${KIND_WORD[groups[0].kind]}` : 'All places';

function WherePicker({ value, onChange, groups, whereName }: {
  value: string | null; onChange: (where: string | null) => void; groups: PlaceGroup[]; whereName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  /** The list lines up with the button's right edge, moved over as needed to stay inside the 16px page gutter. */
  const [left, setLeft] = useState(0);
  const toggle = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r && !open) {
      const w = Math.min(288, window.innerWidth - 32);
      setLeft(Math.min(Math.max(r.right - w, 16), window.innerWidth - 16 - w) - r.left);
    }
    setOpen((o) => !o);
  };
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => { if (!open) setQ(''); }, [open]);

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const selected = useMemo(() => {
    for (const g of groups) { const o = g.items.find((i) => i.id === value); if (o) return { kind: g.kind as PlaceKind | null, name: o.name }; }
    return value ? { kind: null, name: whereName ?? 'The selected place' } : null;
  }, [groups, value, whereName]);
  const needle = q.trim().toLowerCase();
  const shown = needle ? groups.map((g) => ({ ...g, items: g.items.filter((o) => o.name.toLowerCase().includes(needle)) })).filter((g) => g.items.length > 0) : groups;
  const pick = (where: string | null) => { onChange(where); setOpen(false); };
  const Icon = selected?.kind ? KIND_ICON[selected.kind] : MapPin;

  const row = (id: string | null, name: string, icon?: typeof Globe) => {
    const on = value === id;
    const RowIcon = icon;
    return (
      <button key={id ?? 'all'} type="button" role="option" aria-selected={on} onClick={() => pick(id)}
        className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors', on ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-700 hover:bg-gray-50')}>
        {RowIcon && <RowIcon className={cn('h-3.5 w-3.5 shrink-0', on ? 'text-indigo-500' : 'text-gray-400')} />}
        <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
        {on && <Check className="h-3.5 w-3.5 shrink-0 text-indigo-600" />}
      </button>
    );
  };

  return (
    <div ref={ref} className="relative">
      <div className={cn('inline-flex h-8 max-w-[260px] items-center rounded-lg border text-sm font-medium transition-colors',
        selected ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50')}>
        <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={toggle}
          title={selected ? `Only cards from ${selected.name}` : 'Only show cards from one sequence, variable or website'}
          className={cn('inline-flex h-full min-w-0 items-center gap-1.5 rounded-lg pl-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500', selected ? 'pr-1' : 'pr-2')}>
          <Icon className={cn('h-3.5 w-3.5 shrink-0', selected ? 'text-indigo-500' : 'text-gray-400')} />
          <span className="truncate">{selected ? selected.name : allPlaces(groups)}</span>
          {!selected && <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform', open && 'rotate-180')} />}
        </button>
        {selected && (
          <button type="button" aria-label="Clear Where" title="Show cards from everywhere" onClick={() => pick(null)}
            className="mr-1 rounded p-0.5 text-indigo-500 hover:bg-indigo-100 hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div style={{ left }} className="absolute top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
          {total > SEARCH_FROM && (
            <div className="border-b border-gray-100 p-2">
              <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-1.5 focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100">
                <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search places"
                  className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none" />
              </label>
            </div>
          )}
          <div role="listbox" aria-label="Where" className="max-h-80 overflow-y-auto p-1">
            {!needle && row(null, allPlaces(groups), MapPin)}
            {!needle && selected && !selected.kind && value && row(value, selected.name, MapPin)}
            {shown.map((g) => (
              <div key={g.kind} className="mt-1 first:mt-0">
                {(groups.length > 1 || needle) && (
                  <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{g.label}</div>
                )}
                {g.items.map((o) => row(o.id, o.name, KIND_ICON[g.kind]))}
              </div>
            ))}
            {needle && shown.length === 0 && <p className="px-2.5 py-3 text-sm text-gray-500">No matches</p>}
          </div>
        </div>
      )}
    </div>
  );
}

const TAB_ICON: Record<NeedsYouType, typeof Globe> = { reply: MessageSquareReply, line: Quote, draft: FileText, website: Globe, question: CircleHelp, profile: UserPen };

/** One line under the tabs: what the open tab holds and what to do with it. */
export const TAB_HINT: Record<NeedsYouType, string> = {
  reply: 'Replies the AI wrote to your prospects. Send, edit or skip each one.',
  line: 'Personalized lines. A message can only use a line once it is approved.',
  draft: 'Sequence messages the AI wrote. The lead waits at the step until you approve.',
  website: 'Answers the Website agent suggests. The visitor is waiting in the chat.',
  question: 'Questions the AI could not answer. Your answer is saved to Knowledge.',
  profile: 'LinkedIn profile drafts for your senders.',
};

/**
 * The header of Needs you: one tab per type with its count on the left, [Mine | All] + Where on the right.
 * The total is on the Needs you tab above. AI replies and Personalizations are always there; the other types appear when
 * something of that type waits (or it is the open tab).
 */
export default function FilterBar({ filters, onFilters, counts, setup, whereName }: {
  filters: NeedsYouFilters & { type: NeedsYouType }; onFilters: (f: NeedsYouFilters) => void;
  /** undefined while the counts load: the tabs show without numbers. */
  counts: NeedsYouCounts | undefined;
  setup: HubSetup | undefined;
  /** The name of the selected place as a card shows it, for a place the Where list does not have (an archived sequence). */
  whereName?: string | null;
}) {
  const types = NEEDS_YOU_TYPES.filter((t) => t === 'reply' || t === 'line' || t === filters.type || (counts?.[t] ?? 0) > 0);
  const groups = placeGroups(setup, filters.type);
  const showWhere = groups.length > 0 || !!filters.where;
  const setType = (type: NeedsYouType) => onFilters({ ...filters, type, where: whereFits(setup, type, filters.where) ? filters.where : null });

  const tab = (type: NeedsYouType) => {
    const on = filters.type === type;
    const n = counts?.[type];
    const TabIcon = TAB_ICON[type];
    return (
      <button key={type} type="button" role="radio" aria-checked={on} onClick={() => setType(type)}
        className={cn('inline-flex items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
          on ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>
        <TabIcon className={cn('h-3.5 w-3.5', on ? 'text-indigo-600' : 'text-gray-400')} aria-hidden="true" />
        {NEEDS_YOU_TYPE_LABEL[type]}
        {n !== undefined && (
          <span className={cn('min-w-[1.25rem] rounded-full px-1.5 text-center text-xs font-semibold tabular-nums leading-[18px]',
            on ? 'bg-indigo-100 text-indigo-700' : n > 0 ? 'bg-gray-100 text-gray-700' : 'bg-gray-50 text-gray-400')}>
            {n.toLocaleString()}
          </span>
        )}
      </button>
    );
  };
  const segment = (mine: boolean, label: string, title: string) => {
    const SegIcon = mine ? User : Users;
    return (
      <button type="button" aria-pressed={filters.mine === mine} title={title} onClick={() => onFilters({ ...filters, mine })}
        className={cn('inline-flex items-center gap-1.5 px-3 text-sm font-medium rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
          filters.mine === mine ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>
        <SegIcon className="h-3.5 w-3.5" />
        {label}
      </button>
    );
  };

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
          <div role="radiogroup" aria-label="What needs you" className="inline-flex h-8 rounded-lg border border-gray-200 bg-white p-0.5">
            {types.map(tab)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Whose cards" className="inline-flex h-8 rounded-lg border border-gray-200 bg-white p-0.5">
            {segment(true, 'Mine', 'AI replies and website chats assigned to you, and everything that is assigned to nobody')}
            {segment(false, 'All', 'Everything you are allowed to act on')}
          </div>
          {showWhere && <WherePicker value={filters.where} onChange={(where) => onFilters({ ...filters, where })} groups={groups} whereName={whereName} />}
        </div>
      </div>
    </div>
  );
}
