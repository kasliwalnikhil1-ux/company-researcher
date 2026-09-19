'use client';

import React, { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, X, AlertCircle, Inbox, ChevronLeft, ChevronRight } from 'lucide-react';
import { STAGE_LABELS, type DealStage } from '@/lib/crm/types';

// Small, dense primitives for the CRM screens (fast over pretty, keyboard-friendly, no modal stacking).

export function Button({ variant = 'primary', size = 'md', loading, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'xs' | 'sm' | 'md'; loading?: boolean }) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-indigo-500';
  const sizes = { xs: 'px-2 py-1 text-xs', sm: 'px-2.5 py-1.5 text-xs', md: 'px-3.5 py-2 text-sm' };
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
    secondary: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    ghost: 'text-gray-600 hover:bg-gray-100',
  };
  return (
    <button className={cn(base, sizes[size], variants[variant], className)} disabled={loading || rest.disabled} {...rest}>
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ className, children, title, actions, dense }: { className?: string; children: React.ReactNode; title?: React.ReactNode; actions?: React.ReactNode; dense?: boolean }) {
  return (
    <div className={cn('bg-white border border-gray-200 rounded-lg flex flex-col min-h-0', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 flex-shrink-0">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      )}
      <div className={cn(dense ? 'p-0' : 'p-3', 'min-h-0 flex-1')}>{children}</div>
    </div>
  );
}

const fieldCls = 'w-full px-2.5 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';

export function Field({ label, hint, error, children, className }: { label?: string; hint?: string; error?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      {label && <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>}
      {children}
      {hint && !error && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
      {error && <span className="block text-xs text-red-600 mt-1">{error}</span>}
    </label>
  );
}

export function Input({ className, label, hint, error, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }) {
  return <Field label={label} hint={hint} error={error}><input className={cn(fieldCls, error && 'border-red-400', className)} {...rest} /></Field>;
}

export function Textarea({ className, label, hint, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: string }) {
  return <Field label={label} hint={hint}><textarea className={cn(fieldCls, 'min-h-[72px]', className)} {...rest} /></Field>;
}

export function Select({ className, label, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return <Field label={label}><select className={cn(fieldCls, className)} {...rest}>{children}</select></Field>;
}

export type Tone = 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo' | 'purple' | 'pink';
export function Badge({ children, tone = 'gray', className, title }: { children: React.ReactNode; tone?: Tone; className?: string; title?: string }) {
  const tones: Record<Tone, string> = {
    gray: 'bg-gray-100 text-gray-700', green: 'bg-green-100 text-green-800', red: 'bg-red-100 text-red-800', amber: 'bg-amber-100 text-amber-800',
    blue: 'bg-blue-100 text-blue-800', indigo: 'bg-indigo-100 text-indigo-800', purple: 'bg-purple-100 text-purple-800', pink: 'bg-pink-100 text-pink-800',
  };
  return <span title={title} className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium leading-tight', tones[tone], className)}>{children}</span>;
}

const STAGE_TONE: Record<DealStage, Tone> = { new: 'gray', contacted: 'blue', replied: 'indigo', meeting_booked: 'purple', meeting_held: 'purple', proposal_sent: 'amber', negotiation: 'amber', won: 'green', lost: 'red' };
export function StageBadge({ stage }: { stage: DealStage }) {
  return <Badge tone={STAGE_TONE[stage] ?? 'gray'}>{STAGE_LABELS[stage] ?? stage}</Badge>;
}

export function Flags({ stale, stuck, slipping }: { stale?: boolean; stuck?: boolean; slipping?: boolean }) {
  if (!stale && !stuck && !slipping) return null;
  return (
    <span className="inline-flex gap-1">
      {stale && <Badge tone="red" title="No activity for too long">stale</Badge>}
      {stuck && <Badge tone="amber" title="No next step / date">stuck</Badge>}
      {slipping && <Badge tone="pink" title="Next step date is in the past">slipping</Badge>}
    </span>
  );
}

// Free mailboxes say nothing about the company — keep in sync with crm_company_logo_domain() in migrations/crm/002_functions.sql.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'zoho.com', 'zohomail.com', 'rediffmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru', 'hey.com', 'fastmail.com', 'qq.com', '163.com']);

/** Domain to fetch a logo for: the company's own domain, else the first contact email domain that is not a free mailbox. */
export function logoDomain(domain: string | null | undefined, emails: Array<string | null | undefined> = []): string | null {
  const own = domain?.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?:]/)[0];
  if (own) return own;
  for (const e of emails) {
    const d = e?.split('@')[1]?.trim().toLowerCase();
    if (d && d.includes('.') && !FREE_MAIL.has(d)) return d;
  }
  return null;
}

/** Company logo via Google's favicon service (same source as the investor logos), falling back to the initial. */
export function CompanyLogo({ name, domain, size = 'sm', className }: { name: string; domain?: string | null; size?: 'xs' | 'sm' | 'lg'; className?: string }) {
  const [failed, setFailed] = React.useState(false);
  useEffect(() => setFailed(false), [domain]);
  const sizes = { xs: 'w-4 h-4 text-[9px] rounded', sm: 'w-6 h-6 text-[11px] rounded-md', lg: 'w-10 h-10 text-base rounded-lg' };
  const showLogo = !!domain && !failed;
  // Logos sit on a transparent background with no frame; only the initial fallback gets a tile so it still reads as an avatar.
  return (
    <span className={cn('inline-flex items-center justify-center flex-shrink-0 font-semibold text-gray-500 select-none', !showLogo && 'bg-gray-100', sizes[size], className)} aria-hidden>
      {showLogo ? (
        // Unknown domains come back as Google's 16px placeholder globe rather than an error — treat that as a miss too.
        <img src={`https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`} alt="" loading="lazy" draggable={false} className="w-full h-full object-contain"
          onError={() => setFailed(true)} onLoad={(e) => { if (e.currentTarget.naturalWidth <= 16) setFailed(true); }} />
      ) : (name.trim().charAt(0).toUpperCase() || '?')}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <div className={cn('flex items-center justify-center py-12', className)}><Loader2 className="w-6 h-6 text-indigo-500 animate-spin" /></div>;
}

export function ErrorBox({ message, className }: { message: string; className?: string }) {
  return <div className={cn('flex items-start gap-2 p-3 rounded-md bg-red-50 text-red-700 text-sm', className)}><AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span className="whitespace-pre-wrap">{message}</span></div>;
}

export function EmptyState({ title, description, action, icon, compact }: { title: string; description?: string; action?: React.ReactNode; icon?: React.ReactNode; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center px-4', compact ? 'py-6' : 'py-14')}>
      {!compact && <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 mb-2">{icon ?? <Inbox className="w-5 h-5" />}</div>}
      <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      {description && <p className="text-xs text-gray-500 mt-1 max-w-md">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
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
      <div className={cn('relative bg-white rounded-lg shadow-xl w-full max-h-[90vh] flex flex-col', sizes[size])}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-500" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-4 py-3 overflow-y-auto">{children}</div>
        {footer && <div className="px-4 py-2.5 border-t border-gray-100 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-bold text-gray-900">{title}</h1>
        {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('overflow-auto border border-gray-200 rounded-lg bg-white', className)}><table className="min-w-full text-sm">{children}</table></div>;
}
export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cn('text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wide px-3 py-1.5 bg-gray-50 border-b border-gray-200 whitespace-nowrap', className)}>{children}</th>;
}
export function Td({ children, className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-1.5 border-b border-gray-100 text-gray-700 align-top', className)} {...rest}>{children}</td>;
}

export function Pagination({ page, pageSize, total, onPage, onPageSize, pageSizes = [25, 50, 100], loading }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (n: number) => void; pageSizes?: number[]; loading?: boolean }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mt-2 text-xs text-gray-500">
      <div className="flex items-center gap-2">
        <span className="tabular-nums">{from}–{to} of {total}</span>
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" />}
      </div>
      <div className="flex items-center gap-2">
        {onPageSize && (
          <select aria-label="Rows per page" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className="border border-gray-300 rounded-md px-1.5 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
            {pageSizes.map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        )}
        <Button variant="secondary" size="xs" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft className="w-3.5 h-3.5" /> Prev</Button>
        <span className="tabular-nums whitespace-nowrap">Page {page} of {pages}</span>
        <Button variant="secondary" size="xs" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next <ChevronRight className="w-3.5 h-3.5" /></Button>
      </div>
    </div>
  );
}

export function fmtDate(v: string | null | undefined, opts: { time?: boolean; tz?: string | null } = {}): string {
  if (!v) return '—';
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  if (isNaN(d.getTime())) return '—';
  const o: Intl.DateTimeFormatOptions = opts.time ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'short', day: 'numeric' };
  if (opts.tz) o.timeZone = opts.tz;
  try { return d.toLocaleString('en-GB', o); } catch { return d.toLocaleString('en-GB', { ...o, timeZone: undefined }); }
}

export function fmtTime(v: string | null | undefined, tz?: string | null): string {
  if (!v) return '—';
  try { return new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz ?? undefined }); } catch { return new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }); }
}

export function daysAgo(v: string | null | undefined): string {
  if (!v) return 'never';
  const d = Math.floor((Date.now() - new Date(v).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
}

export const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const addDaysISO = (n: number, from = todayISO()) => { const d = new Date(`${from}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function useToast() {
  const [toast, setToast] = React.useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const show = React.useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), type === 'error' ? 6000 : 2500);
  }, []);
  const node = toast ? (
    <div className="fixed bottom-4 right-4 z-[60]">
      <div className={cn('px-4 py-3 rounded-md shadow-lg text-sm text-white max-w-md whitespace-pre-wrap', toast.type === 'error' ? 'bg-red-600' : 'bg-gray-900')}>{toast.message}</div>
    </div>
  ) : null;
  return { show, node };
}

/** Keyboard shortcut helper: `g` then a letter navigates (ignored while typing in a field). */
export function useGoShortcuts(map: Record<string, () => void>) {
  useEffect(() => {
    let pending = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') { pending = true; clearTimeout(timer); timer = setTimeout(() => { pending = false; }, 1200); return; }
      if (pending && map[e.key]) { e.preventDefault(); pending = false; map[e.key](); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(timer); };
  }, [map]);
}
