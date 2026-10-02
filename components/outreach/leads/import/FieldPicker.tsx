'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlignLeft, ArrowLeftRight, AtSign, Briefcase, Building2, Check, ChevronDown, CircleSlash, Globe, Linkedin, Mail, MapPin, MessageCircle, Phone, Plus, Search, User, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LEAD_FIELDS } from '../helpers';

const ICON: Record<string, LucideIcon> = {
  '': CircleSlash, linkedin_url: Linkedin, email_work: Mail, email_personal: Mail, first_name: User, last_name: User, full_name: User, headline: AlignLeft,
  title: Briefcase, location: MapPin, phone: Phone, company: Building2, company_domain: Globe, instagram_handle: AtSign, whatsapp_phone: MessageCircle, custom: Plus,
};

/**
 * The lead field of one CSV column. A field sits on one column at a time: a field that another column holds stays in the list with
 * that column's name next to it, and choosing it moves it here (the parent clears the other column).
 */
export function FieldPicker({ column, value, onChange, takenBy, invalid }: {
  column: string; value: string; onChange: (field: string) => void;
  /** field → the column that holds it now */
  takenBy: Map<string, string>;
  invalid?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? LEAD_FIELDS.filter((f) => `${f.label} ${f.group ?? ''} ${f.hint ?? ''}`.toLowerCase().includes(q)) : LEAD_FIELDS;
  }, [query]);
  const current = LEAD_FIELDS.find((f) => f.value === value) ?? LEAD_FIELDS[0];
  const CurrentIcon = ICON[current.value] ?? User;

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 380 && r.top > below;
    setPos({ top: up ? r.top - 4 : r.bottom + 4, left: r.left, width: r.width, up });
  };
  const openList = () => { setQuery(''); setActive(Math.max(0, LEAD_FIELDS.findIndex((f) => f.value === value))); place(); setOpen(true); };
  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const pick = (field: string) => { onChange(field); close(); };

  useLayoutEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { if (open) panelRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { const t = e.target as Node; if (!panelRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false); };
    const onScroll = (e: Event) => { if (!panelRef.current?.contains(e.target as Node)) place(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true); };
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const f = rows[active]; if (f) pick(f.value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  const panel = open && pos && typeof document !== 'undefined' ? createPortal(
    <div ref={panelRef} role="dialog" aria-label={`Lead field for ${column}`} onKeyDown={onKey}
      style={{ position: 'fixed', left: pos.left, width: Math.max(pos.width, 360), ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
      className="z-[70] rounded-xl border border-gray-200 bg-white shadow-xl overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
        <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <input ref={inputRef} value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} placeholder="Search fields…" role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={rows[active] ? `${id}-${active}` : undefined} className="w-full text-sm bg-transparent text-gray-900 placeholder-gray-400 focus:outline-none" />
      </div>
      <ul id={`${id}-list`} role="listbox" className="max-h-[340px] overflow-y-auto py-1 text-sm">
        {rows.length === 0 && <li className="px-3 py-2 text-gray-500">No field matches. Choose “Custom field…” to keep this column under your own name.</li>}
        {rows.map((f, i) => {
          const Icon = ICON[f.value] ?? User;
          const isSel = f.value === value;
          const other = f.value && f.value !== 'custom' && !isSel ? takenBy.get(f.value) : undefined;
          const heading = f.group && f.group !== rows[i - 1]?.group ? f.group : null;
          const ruled = !f.group && i > 0;   // "Custom field…" sits under a rule, apart from the lead's own fields
          return (
            <li key={f.value || '__skip'} role="presentation">
              {heading && <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">{heading}</div>}
              {ruled && <div className="my-1 border-t border-gray-100" />}
              <div id={`${id}-${i}`} data-index={i} role="option" aria-selected={isSel} title={other ? `Now on the column “${other}”. Choose it to move it to “${column}”.` : undefined}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(f.value)}
                className={cn('mx-1 flex items-center gap-2.5 rounded-md px-2 py-1.5 cursor-pointer', i === active ? 'bg-indigo-50' : '', isSel ? 'text-indigo-900 font-medium' : f.value ? 'text-gray-900' : 'text-gray-500')}>
                <Icon className={cn('w-4 h-4 flex-shrink-0', isSel ? 'text-indigo-600' : other ? 'text-gray-300' : 'text-gray-400')} />
                <span className="min-w-0 flex-1 truncate">
                  <span className={other ? 'text-gray-500' : undefined}>{f.label}</span>
                  {f.hint && !other && <span className="ml-2 text-xs font-normal text-gray-400">{f.hint}</span>}
                </span>
                {isSel ? <Check className="w-4 h-4 text-indigo-600 flex-shrink-0" /> : other ? (
                  <span className={cn('inline-flex max-w-[150px] flex-shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-normal', i === active ? 'border-indigo-200 bg-white text-indigo-700' : 'border-gray-200 bg-gray-50 text-gray-500')}>
                    <ArrowLeftRight className="w-3 h-3 flex-shrink-0" /><span className="truncate">{i === active ? `Move from ${other}` : other}</span>
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button ref={triggerRef} type="button" aria-label={`Field for ${column}`} aria-haspopup="listbox" aria-expanded={open} data-field={value}
        onClick={() => (open ? setOpen(false) : openList())} onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openList(); } }}
        className={cn('w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-left rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500',
          invalid ? 'border-red-400 bg-white text-gray-900' : value ? 'border-gray-300 bg-white text-gray-900 hover:border-gray-400' : 'border-dashed border-gray-300 bg-gray-50 text-gray-500 hover:bg-white')}>
        <CurrentIcon className={cn('w-4 h-4 flex-shrink-0', value ? 'text-indigo-500' : 'text-gray-400')} />
        <span className="min-w-0 flex-1 truncate">{current.label}</span>
        <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
      </button>
      {panel}
    </>
  );
}
