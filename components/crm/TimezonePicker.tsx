'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CUSTOM_TZ, allTimezones, tzOffsetLabel, tzPresets, tzShort } from '@/lib/crm/timezones';
import { cn } from '@/lib/utils';
import { Globe, Search } from 'lucide-react';

// One control for "which time zone am I looking at": a select with the team presets (default, India, US, UK) and a
// "Custom…" entry that opens a searchable list of every IANA zone. Used on the calendar toolbar and in the event form.

export function TimezonePicker({ value, onChange, teamTz, className, selectClassName, compact = false }: {
  value: string; onChange: (tz: string) => void; teamTz: string; className?: string; selectClassName?: string;
  /** compact: the toolbar style (small, with a globe); otherwise the form-field style. */
  compact?: boolean;
}) {
  const groups = useMemo(() => tzPresets(teamTz), [teamTz]);
  const preset = groups.some((g) => g.items.some((i) => i.tz === value));
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const openSearch = () => { setQ(''); setOpen(true); };
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => input.current?.focus(), 0);
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const hits = useMemo(() => {
    const all = allTimezones();
    const s = q.trim().toLowerCase().replace(/\s+/g, '_');
    const list = s ? all.filter((z) => z.toLowerCase().includes(s) || tzOffsetLabel(z).toLowerCase().includes(q.trim().toLowerCase())) : all;
    return list.slice(0, 60);
  }, [q]);

  return (
    <div ref={wrap} className={cn('relative', className)}>
      <div className={cn('flex items-center', compact && 'gap-1.5 rounded-md border border-gray-200 bg-white pl-2 text-xs text-gray-700')}>
        {compact && <Globe className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden />}
        <select
          aria-label="Time zone"
          title={`${value} · ${tzOffsetLabel(value)}`}
          value={value}
          onChange={(e) => { if (e.target.value === CUSTOM_TZ) openSearch(); else { setOpen(false); onChange(e.target.value); } }}
          className={cn(compact ? 'bg-transparent py-1 pr-1.5 text-xs focus:outline-none max-w-[13rem]' : 'w-full px-2.5 py-1.5 text-sm rounded-md border border-gray-300 bg-white', selectClassName)}>
          {groups.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.items.map((i) => <option key={i.tz} value={i.tz}>{i.label} ({tzOffsetLabel(i.tz)})</option>)}
            </optgroup>
          ))}
          <optgroup label="Custom">
            {!preset && <option value={value}>{value.replace(/_/g, ' ')} ({tzOffsetLabel(value)})</option>}
            <option value={CUSTOM_TZ}>Other time zone…</option>
          </optgroup>
        </select>
      </div>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-72 max-w-[90vw] rounded-md border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-100">
            <Search className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="City, region or UTC offset…" className="w-full text-sm focus:outline-none" aria-label="Search time zones"
              onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) { onChange(hits[0]); setOpen(false); } }} />
          </div>
          <ul className="max-h-56 overflow-y-auto py-1 text-sm">
            {hits.length === 0 && <li className="px-3 py-2 text-gray-400">No zone matches “{q}”.</li>}
            {hits.map((z) => (
              <li key={z}>
                <button type="button" onClick={() => { onChange(z); setOpen(false); }} className={cn('w-full text-left px-3 py-1 flex items-center justify-between gap-2 hover:bg-gray-50', z === value && 'bg-indigo-50 text-indigo-800')}>
                  <span className="truncate">{z.replace(/_/g, ' ')}</span><span className="text-[11px] text-gray-500 tabular-nums shrink-0">{tzOffsetLabel(z)}</span>
                </button>
              </li>
            ))}
            {hits.length === 60 && <li className="px-3 py-1 text-[11px] text-gray-400">Keep typing to narrow the list.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

export { tzShort };
