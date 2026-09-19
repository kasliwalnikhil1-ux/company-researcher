'use client';

import React, { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, X, AlertCircle, Inbox } from 'lucide-react';
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
export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cn('text-left text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-2.5 bg-gray-50 border-b border-gray-200', className)}>{children}</th>;
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
