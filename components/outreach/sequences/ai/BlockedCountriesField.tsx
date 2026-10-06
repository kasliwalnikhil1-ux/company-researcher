'use client';

// Blocked countries (the sequence AI tab → Rules): flag chips, search-to-add and an EU / EEA preset instead of typed codes. Empty = none.
import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Button, SearchableSelect } from '@/components/outreach/ui';
import { COUNTRY_LIST, EU_EEA, countryName, flagSrc } from '@/components/outreach/settings/ai-replies/format';

const CHIP = 'inline-flex items-center gap-1.5 pl-1 pr-1 py-1 rounded-full text-xs';
const REMOVE = 'p-0.5 rounded-full hover:bg-black/5 disabled:opacity-50';

const Flag = ({ code, className = 'w-4 h-4' }: { code: string; className?: string }) => (
  <img src={flagSrc(code)} alt="" loading="lazy" decoding="async" className={`${className} rounded-full flex-none bg-gray-200`} />
);

function Chip({ code, onRemove }: { code: string; onRemove: () => void }) {
  const name = countryName(code);
  return (
    <span className={`${CHIP} bg-white border border-gray-200 text-gray-800`}>
      <Flag code={code} />{name}
      <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} title={`Remove ${name}`} className={`${REMOVE} text-gray-400 hover:text-gray-700`}><X className="w-3 h-3" /></button>
    </span>
  );
}

export default function BlockedCountriesField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [expandEu, setExpandEu] = useState(false);
  const chosen = new Set(value);
  const hasEu = EU_EEA.every((c) => chosen.has(c));
  const grouped = hasEu && !expandEu;
  const singles = (grouped ? value.filter((c) => !EU_EEA.includes(c)) : value).slice().sort((a, b) => countryName(a).localeCompare(countryName(b)));
  const options = useMemo(() => COUNTRY_LIST.filter((c) => !value.includes(c.code))
    .map((c) => ({ value: c.code, label: c.name, hint: c.code, icon: <Flag code={c.code} /> })), [value]);

  const add = (code: string) => { if (code && !chosen.has(code)) onChange([...value, code]); };
  const remove = (codes: string[]) => onChange(value.filter((c) => !codes.includes(c)));
  const addEu = () => onChange([...value, ...EU_EEA.filter((c) => !chosen.has(c))]);

  return (
    <div className="space-y-2 sm:col-span-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="block text-xs font-medium text-gray-600">Blocked countries</span>
        {value.length > 0 && <span className="text-xs text-gray-500">{value.length} {value.length === 1 ? 'country' : 'countries'}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 min-h-[42px] p-2 rounded-lg border border-gray-200 bg-gray-50">
        {grouped && (
          <span className={`${CHIP} pl-1.5 bg-indigo-50 border border-indigo-100 text-indigo-700`}>
            <span className="flex -space-x-1.5" aria-hidden="true">{['DE', 'FR', 'IT'].map((c) => <Flag key={c} code={c} className="w-4 h-4 ring-2 ring-indigo-50" />)}</span>
            <span className="font-medium">EU / EEA</span><span className="text-indigo-500">{EU_EEA.length} countries</span>
            <button type="button" onClick={() => setExpandEu(true)} className="px-1 rounded hover:underline">Show</button>
            <button type="button" onClick={() => remove(EU_EEA)} aria-label="Remove EU / EEA" title="Remove EU / EEA" className={`${REMOVE} text-indigo-400 hover:text-indigo-700`}><X className="w-3 h-3" /></button>
          </span>
        )}
        {singles.map((c) => <Chip key={c} code={c} onRemove={() => remove([c])} />)}
        {hasEu && expandEu && <button type="button" onClick={() => setExpandEu(false)} className="px-1.5 text-xs text-indigo-700 hover:underline">Group EU / EEA</button>}
        {value.length === 0 && <span className="px-1 text-xs text-gray-500">None. Auto replies to prospects in every country.</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchableSelect value="" onChange={add} options={options} placeholder="Add a country…" searchPlaceholder="Search country or code…" aria-label="Add a country" className="w-56" />
        {!hasEu && <Button size="sm" variant="secondary" onClick={addEu}>Add all EU / EEA</Button>}
        {value.length > 0 && <Button size="sm" variant="ghost" onClick={() => onChange([])}>Clear all</Button>}
      </div>
      <span className="block text-xs text-gray-500">
        Auto never replies to prospects in these countries. Their replies wait as drafts for a person. Everyone else, including prospects whose country is unknown, gets Auto.
      </span>
    </div>
  );
}
