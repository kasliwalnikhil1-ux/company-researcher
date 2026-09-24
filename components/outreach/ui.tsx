'use client';

import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Loader2, X, AlertCircle, Inbox, ChevronDown, Check, Search, ArrowLeft } from 'lucide-react';
import type { SenderStatus, EnrollmentStatus, Intent } from '@/lib/outreach/types';

export function Button({ variant = 'primary', size = 'md', loading, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'sm' | 'md'; loading?: boolean }) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
  const sizes = { sm: 'px-2.5 py-1.5 text-xs', md: 'px-4 py-2 text-sm' };
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
    secondary: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    ghost: 'text-gray-600 hover:bg-gray-100',
  };
  return (
    <button className={cn(base, sizes[size], variants[variant], className)} disabled={loading || rest.disabled} {...rest}>
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ className, children, title, actions }: { className?: string; children: React.ReactNode; title?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className={cn('bg-white border border-gray-200 rounded-xl', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}

export function Input({ className, label, hint, error, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }) {
  return (
    <label className="block">
      {label && <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>}
      <input className={cn('w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500', error && 'border-red-400', className)} {...rest} />
      {hint && !error && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
      {error && <span className="block text-xs text-red-600 mt-1">{error}</span>}
    </label>
  );
}

export function Textarea({ className, label, hint, counter, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: string; counter?: { max: number; value: number } }) {
  const over = counter && counter.value > counter.max;
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1">
        {label && <span className="block text-xs font-medium text-gray-600">{label}</span>}
        {counter && <span className={cn('text-xs', over ? 'text-red-600 font-medium' : 'text-gray-400')}>{counter.value}/{counter.max}</span>}
      </div>
      <textarea className={cn('w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 min-h-[90px]', over && 'border-red-400', className)} {...rest} />
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
    </label>
  );
}

export function Select({ className, label, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <label className="block">
      {label && <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>}
      <select className={cn('w-full px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500', className)} {...rest}>
        {children}
      </select>
    </label>
  );
}

/** `keywords` are matched by the search box but never rendered (aliases, old names, country). */
export type SelectOption = { value: string; label?: string; hint?: string; keywords?: string };

function normalizeSearch(s: string): string {
  return s.toLowerCase().replace(/[_/\-().,]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A `<select>` replacement for long lists (timezones, countries, currencies…): a button that opens a
 * searchable list. Type to filter, arrow keys to move, Enter to pick, Escape to close.
 * The list renders in a portal with fixed positioning so it is never clipped by a scrolling modal body.
 */
export function SearchableSelect({ label, value, onChange, options, placeholder = 'Select…', searchPlaceholder = 'Type to search…', emptyOption, disabled, className, hint, error, 'aria-label': ariaLabel, id: idProp }: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<SelectOption | string>;
  placeholder?: string;
  searchPlaceholder?: string;
  /** Render a first option that sets the value to '' (e.g. "No client"). */
  emptyOption?: string;
  disabled?: boolean;
  className?: string;
  hint?: string;
  error?: string;
  'aria-label'?: string;
  id?: string;
}) {
  const reactId = useId();
  const id = idProp ?? `ss-${reactId}`;
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const all = useMemo<SelectOption[]>(() => {
    const base = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
    const list = emptyOption != null ? [{ value: '', label: emptyOption }, ...base] : base;
    // Keep an unknown current value selectable so it is never silently dropped.
    if (value && !list.some((o) => o.value === value)) list.unshift({ value, label: value });
    return list;
  }, [options, emptyOption, value]);

  const selected = all.find((o) => o.value === value);
  const selectedLabel = selected ? (selected.label ?? selected.value) : '';

  const filtered = useMemo(() => {
    const q = normalizeSearch(query);
    if (!q) return all;
    const tokens = q.split(' ');
    return all.filter((o) => {
      const hay = normalizeSearch(`${o.label ?? ''} ${o.value} ${o.hint ?? ''} ${o.keywords ?? ''}`);
      return tokens.every((t) => hay.includes(t));
    });
  }, [all, query]);

  function place() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 300 && r.top > below;
    setPos({ top: up ? r.top - 4 : r.bottom + 4, left: r.left, width: r.width, up });
  }

  function openList() {
    if (disabled) return;
    setQuery('');
    const idx = Math.max(0, all.findIndex((o) => o.value === value));
    setActive(idx);
    place();
    setOpen(true);
  }

  function pick(v: string) {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  // Keep the highlighted row in view while navigating.
  useEffect(() => {
    if (!open) return;
    const row = panelRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => { if (panelRef.current?.contains(e.target as Node)) return; place(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(filtered.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(Math.max(0, filtered.length - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = filtered[active]; if (o) pick(o.value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
    else if (e.key === 'Tab') { setOpen(false); }
  }

  const panel = open && pos && typeof document !== 'undefined' ? createPortal(
    <div ref={panelRef} role="dialog" aria-label={ariaLabel ?? label ?? 'Options'}
      style={{ position: 'fixed', left: pos.left, width: Math.max(pos.width, 240), ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
      className="z-[70] rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden" onKeyDown={onKey}>
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-gray-100">
        <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
        <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder}
          role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
          className="w-full text-sm bg-transparent text-gray-900 placeholder-gray-400 focus:outline-none" />
        {query && <button type="button" onClick={() => setQuery('')} className="text-gray-400 hover:text-gray-600" aria-label="Clear search"><X className="w-3.5 h-3.5" /></button>}
      </div>
      <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1 text-sm">
        {filtered.length === 0 && <li className="px-3 py-2 text-gray-500">No matches</li>}
        {filtered.map((o, i) => {
          const isSel = o.value === value;
          return (
            <li key={o.value || '__empty'} id={`${listId}-${i}`} data-index={i} role="option" aria-selected={isSel}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o.value)}
              className={cn('flex items-center justify-between gap-3 px-3 py-1.5 cursor-pointer', i === active ? 'bg-indigo-50 text-indigo-900' : 'text-gray-900', isSel && 'font-medium')}>
              <span className="truncate">{o.label ?? o.value}{o.hint && <span className="ml-2 text-xs text-gray-500 font-normal">{o.hint}</span>}</span>
              {isSel && <Check className="w-4 h-4 text-indigo-600 flex-shrink-0" />}
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  ) : null;

  return (
    <div className={cn('block', className)}>
      {label && <label htmlFor={id} className="block text-xs font-medium text-gray-600 mb-1">{label}</label>}
      <button ref={triggerRef} id={id} type="button" disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openList(); } }}
        className={cn('w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-left rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed',
          error ? 'border-red-300' : 'border-gray-300', selectedLabel ? 'text-gray-900' : 'text-gray-400')}>
        <span className="truncate">{selectedLabel || placeholder}</span>
        <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
      </button>
      {error ? <span className="block text-xs text-red-600 mt-1">{error}</span> : hint ? <span className="block text-xs text-gray-500 mt-1">{hint}</span> : null}
      {panel}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-sm text-gray-700 disabled:opacity-50">
      <span className={cn('relative inline-block w-9 h-5 rounded-full transition-colors', checked ? 'bg-indigo-600' : 'bg-gray-300')}>
        <span className={cn('absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform', checked && 'translate-x-4')} />
      </span>
      {label}
    </button>
  );
}

export function Badge({ children, tone = 'gray', className }: { children: React.ReactNode; tone?: 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo' | 'purple' | 'pink'; className?: string }) {
  const tones = {
    gray: 'bg-gray-100 text-gray-700', green: 'bg-green-100 text-green-800', red: 'bg-red-100 text-red-800', amber: 'bg-amber-100 text-amber-800',
    blue: 'bg-blue-100 text-blue-800', indigo: 'bg-indigo-100 text-indigo-800', purple: 'bg-purple-100 text-purple-800', pink: 'bg-pink-100 text-pink-800',
  };
  return <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', tones[tone], className)}>{children}</span>;
}

export function StatusPill({ status, reason }: { status: SenderStatus; reason?: string | null }) {
  const map: Record<SenderStatus, { tone: any; label: string }> = {
    ok: { tone: 'green', label: 'Connected' }, connecting: { tone: 'blue', label: 'Connecting' }, credentials: { tone: 'red', label: 'Re-login needed' },
    error: { tone: 'red', label: 'Error' }, paused: { tone: 'amber', label: 'Paused' }, disabled: { tone: 'gray', label: 'Disabled' },
  };
  const m = map[status] ?? { tone: 'gray', label: status };
  return <Badge tone={m.tone} className={reason ? 'cursor-help' : ''}><span title={reason ?? undefined}>{m.label}</span></Badge>;
}

export function EnrollmentBadge({ status }: { status: EnrollmentStatus }) {
  const tone: any = status === 'active' ? 'green' : status.startsWith('waiting') ? 'blue' : status === 'paused' ? 'amber' : status === 'completed' ? 'indigo' : status === 'exited_replied' ? 'purple' : status === 'failed' ? 'red' : 'gray';
  return <Badge tone={tone}>{status.replace(/_/g, ' ')}</Badge>;
}

export function IntentBadge({ intent }: { intent: Intent | null | undefined }) {
  if (!intent || intent === 'unclassified') return <Badge tone="gray">unclassified</Badge>;
  const tone: any = intent === 'interested' ? 'green' : intent === 'question' ? 'blue' : intent === 'not_interested' ? 'red' : intent === 'not_now' ? 'amber' : intent === 'ooo' ? 'purple' : 'gray';
  return <Badge tone={tone}>{intent.replace(/_/g, ' ')}</Badge>;
}

export function HealthBar({ score, className }: { score: number; className?: string }) {
  const color = score >= 85 ? 'bg-green-500' : score >= 70 ? 'bg-lime-500' : score >= 50 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="w-20 h-2 bg-gray-200 rounded-full overflow-hidden"><div className={cn('h-full', color)} style={{ width: `${score}%` }} /></div>
      <span className="text-xs text-gray-600 tabular-nums">{score}</span>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <div className={cn('flex items-center justify-center py-12', className)}><Loader2 className="w-6 h-6 text-indigo-500 animate-spin" /></div>;
}

/** Whole-page loader: fills the visible height (minus the shell's padding and the mobile top bar) so the spinner sits in the middle of the screen instead of at the top. */
export function PageLoader({ className }: { className?: string }) {
  return <div className={cn('flex items-center justify-center min-h-[calc(100dvh-6.5rem)] md:min-h-[calc(100dvh-3rem)]', className)}><Loader2 className="w-7 h-7 text-indigo-500 animate-spin" /></div>;
}

export function ErrorBox({ message, className }: { message: string; className?: string }) {
  return <div className={cn('flex items-start gap-2 p-3 rounded-lg bg-red-50 text-red-700 text-sm', className)}><AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>{message}</span></div>;
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 mb-3">{icon ?? <Inbox className="w-6 h-6" />}</div>
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      {description && <p className="text-sm text-gray-500 mt-1 max-w-md">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const sizes = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className={cn('relative bg-white rounded-xl shadow-xl w-full max-h-[90vh] flex flex-col', sizes[size])}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-gray-100 text-gray-500"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/** Page-level "back" breadcrumb, always placed above the page title. Use for navigating up one level, not for in-page steps. */
export function BackLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn('inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 rounded-md -ml-1 px-1 py-0.5 mb-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500', className)}>
      <ArrowLeft className="w-4 h-4" aria-hidden="true" />{children}
    </Link>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('overflow-x-auto border border-gray-200 rounded-xl bg-white', className)}><table className="min-w-full text-sm">{children}</table></div>;
}
export function Th({ children, className, title }: { children?: React.ReactNode; className?: string; title?: string }) {
  return <th title={title} className={cn('text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-2.5 bg-gray-50 border-b border-gray-200', title && 'cursor-help', className)}>{children}</th>;
}
export function Td({ children, className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-4 py-2.5 border-b border-gray-100 text-gray-700 align-middle', className)} {...rest}>{children}</td>;
}

function safeImageUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  try { return new URL(src).protocol === 'https:' ? src : null; } catch { return null; }
}

export function Avatar({ src, name, size = 8 }: { src?: string | null; name?: string | null; size?: number }) {
  const initials = (name ?? '?').split(' ').map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const cls = `w-${size} h-${size}`;
  const url = safeImageUrl(src);
  // Remember a failed load (e.g. an expired LinkedIn CDN link) and fall back to initials.
  const [failed, setFailed] = React.useState<string | null>(null);
  if (url && failed !== url) {
    return <img src={url} alt={name ?? ''} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(url)} className={cn(cls, 'rounded-full object-cover flex-shrink-0 bg-gray-100')} />;
  }
  return <div className={cn(cls, 'rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold flex-shrink-0')}>{initials || '?'}</div>;
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900 mt-0.5">{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-0.5">{hint}</div>}
    </div>
  );
}

export function fmtDate(v: string | null | undefined, withTime = true): string {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return withTime ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function timeAgo(v: string | null | undefined): string {
  if (!v) return '—';
  const diff = Date.now() - new Date(v).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return fmtDate(v, false);
}

export function useToast() {
  const [toast, setToast] = React.useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = React.useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), type === 'error' ? 5000 : 2500);
  }, []);
  const node = toast ? (
    <div className="fixed bottom-4 right-4 z-[60]">
      <div className={cn('px-4 py-3 rounded-lg shadow-lg text-sm text-white max-w-md', toast.type === 'error' ? 'bg-red-600' : 'bg-gray-900')}>{toast.message}</div>
    </div>
  ) : null;
  return { show, node };
}
