'use client';

import { NEEDS_YOU_TYPES, NEEDS_YOU_TYPE_LABEL, type HubSetup, type NeedsYouCounts, type NeedsYouFilters, type NeedsYouType } from '@/lib/outreach/aiHub';
import { cn } from '@/lib/utils';

type PlaceKind = 'sequence' | 'variable' | 'website';
interface PlaceGroup { kind: PlaceKind; label: string; items: Array<{ id: string; name: string }> }

/** Which kinds of place a type's cards come from. null (All) = every kind; profile cards have none. */
const KINDS: Record<NeedsYouType, PlaceKind[]> = { reply: ['sequence'], draft: ['sequence'], line: ['variable'], website: ['website'], question: ['sequence', 'website'], profile: [] };
const ALL_KINDS: PlaceKind[] = ['sequence', 'variable', 'website'];
const KIND_WORD: Record<PlaceKind, string> = { sequence: 'sequences', variable: 'variables', website: 'websites' };

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

const allPlaces = (type: NeedsYouType | null) => {
  const kinds = type ? KINDS[type] : ALL_KINDS;
  return kinds.length ? `All ${kinds.map((k) => KIND_WORD[k]).join(', ')}` : 'Everywhere';
};

/**
 * The header of Needs you: "Needs you (14)", the type chips with their counts, [Mine | All] and Where.
 * All, Replies and Lines are always there; the other types appear when something of that type waits (or it is selected).
 */
export default function FilterBar({ filters, onFilters, counts, setup, whereName }: {
  filters: NeedsYouFilters; onFilters: (f: NeedsYouFilters) => void;
  /** undefined while the counts load: the chips show without numbers. */
  counts: NeedsYouCounts | undefined;
  setup: HubSetup | undefined;
  /** The name of the selected place as a card shows it, for a place the Where list does not have (an archived sequence). */
  whereName?: string | null;
}) {
  const types = NEEDS_YOU_TYPES.filter((t) => t === 'reply' || t === 'line' || t === filters.type || (counts?.[t] ?? 0) > 0);
  const groups = placeGroups(setup, filters.type);
  const known = !filters.where || groups.some((g) => g.items.some((o) => o.id === filters.where));
  const showWhere = groups.length > 0 || !!filters.where;
  const setType = (type: NeedsYouType | null) => onFilters({ ...filters, type, where: whereFits(setup, type, filters.where) ? filters.where : null });

  const chip = (type: NeedsYouType | null, label: string, n: number | undefined) => {
    const on = filters.type === type;
    return (
      <button key={type ?? 'all'} type="button" aria-pressed={on} onClick={() => setType(type)}
        className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
          on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50')}>
        {label}
        {n !== undefined && <span className={cn('tabular-nums text-xs', on ? 'text-indigo-100' : 'text-gray-500')}>{n.toLocaleString()}</span>}
      </button>
    );
  };
  const segment = (mine: boolean, label: string, title: string) => (
    <button type="button" aria-pressed={filters.mine === mine} title={title} onClick={() => onFilters({ ...filters, mine })}
      className={cn('px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500',
        filters.mine === mine ? 'bg-indigo-50 text-indigo-700' : 'bg-white text-gray-600 hover:bg-gray-50')}>
      {label}
    </button>
  );

  return (
    <div className="mb-4 space-y-3">
      <h2 className="text-lg font-semibold text-gray-900">Needs you{counts && <span className="ml-1.5 font-normal text-gray-500 tabular-nums">({counts.total.toLocaleString()})</span>}</h2>
      <div role="group" aria-label="Type" className="flex flex-wrap items-center gap-1.5">
        {chip(null, 'All', counts?.total)}
        {types.map((t) => chip(t, NEEDS_YOU_TYPE_LABEL[t], counts?.[t]))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Whose cards" className="inline-flex overflow-hidden rounded-lg border border-gray-300 divide-x divide-gray-300">
          {segment(true, 'Mine', 'Replies and website chats assigned to you, and everything that is assigned to nobody')}
          {segment(false, 'All', 'Everything you are allowed to act on')}
        </div>
        {showWhere && (
          <label className="inline-flex items-center gap-2 text-sm text-gray-600">
            <span>Where:</span>
            <select value={filters.where ?? ''} onChange={(e) => onFilters({ ...filters, where: e.target.value || null })}
              className="max-w-[260px] rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="">{allPlaces(filters.type)}</option>
              {!known && filters.where && <option value={filters.where}>{whereName ?? 'The selected place'}</option>}
              {groups.map((g) => groups.length > 1
                ? <optgroup key={g.kind} label={g.label}>{g.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</optgroup>
                : g.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}
