'use client';

// Small pieces shared by the AI replies tab of the sequence builder.
import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';

export function Section({ title, help, actions, children, className }: { title: ReactNode; help?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('bg-white border border-gray-200 rounded-xl p-4 space-y-3', className)}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-[1_1_16rem]">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          {help && <p className="text-xs text-gray-500 mt-0.5">{help}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Right-side drawer. `data-outreach-drawer` keeps Delete / Backspace away from the canvas while it is open. */
export function Drawer({ open, onClose, title, subtitle, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" data-outreach-drawer>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside role="dialog" aria-modal="true" className={cn('relative h-full w-full bg-white shadow-2xl flex flex-col', wide ? 'max-w-4xl' : 'max-w-2xl')}>
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-gray-200">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900">{title}</h2>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

/** Error text for a failed call, in plain words. */
export function errText(e: unknown): string {
  const err = parseError(e);
  if (err.code === 'E_AI_UNAVAILABLE') return 'AI is not set up for this workspace yet. Add an AI key in AI → Setup → General, or ask the platform team to switch it on.';
  return err.message || 'Something went wrong';
}

export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export const clampInt = (v: string, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** "12 Sep" style short date. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
