'use client';

// Controls for the sequence studio, styled like the /outreach app (components/outreach/ui.tsx):
// indigo primary buttons, rounded-lg fields with an indigo focus ring, segmented controls on a
// gray track, switch toggles and rounded-full badges.

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export { Toggle } from '@/components/outreach/ui';

const cx = (...c: (string | false | null | undefined)[]) => cn(...c);

export function Btn({ className, tone = 'default', size = 'md', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2 text-sm',
        tone === 'primary' && 'bg-indigo-600 text-white hover:bg-indigo-700',
        tone === 'default' && 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
        tone === 'ghost' && 'text-gray-600 hover:bg-gray-100',
        tone === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        className,
      )}
    />
  );
}

export function IconBtn({ label, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...p}
      className={cx(
        'inline-flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-30 disabled:hover:bg-transparent',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Badge({ tone = 'gray', children, title }: { tone?: 'gray' | 'amber' | 'red' | 'indigo' | 'green' | 'violet' | 'sky'; children: ReactNode; title?: string }) {
  const tones = {
    gray: 'bg-gray-100 text-gray-700',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
    indigo: 'bg-indigo-100 text-indigo-800',
    green: 'bg-green-100 text-green-800',
    violet: 'bg-purple-100 text-purple-800',
    sky: 'bg-blue-100 text-blue-800',
  };
  return (
    <span title={title} className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone])}>
      {children}
    </span>
  );
}

/** Quiet marker for values the source file does not specify (the tool filled in a default). */
export function ToolDefault({ what = 'default' }: { what?: string }) {
  return (
    <span title="The source file does not specify this. The tool filled in a default; edit it to make it yours." className="cursor-help text-[11px] font-normal text-amber-700">
      · {what}
    </span>
  );
}

/** Segmented control, same look as the outreach reports toggles (indigo-50 on a white track). */
export function Seg<T extends string>({ value, options, onChange, label, size = 'md' }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label: string; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 whitespace-nowrap',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
            value === o.value ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-gray-600 hover:bg-gray-50',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 flex items-center gap-2 text-xs font-medium text-gray-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return (
    <input
      ref={ref}
      {...p}
      className={cx(
        'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500',
        className,
      )}
    />
  );
});

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...p}
      className={cx('rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500', className)}
    >
      {children}
    </select>
  );
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-2 mt-6 flex items-center justify-between gap-2 first:mt-0">
      <h3 className="text-sm font-semibold text-gray-900">{children}</h3>
      {actions && <div className="flex items-center gap-1">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-gray-300 p-4 text-center text-sm text-gray-500">{children}</div>;
}

/** Underlined tab strip, same look as the outreach settings tabs. */
export function TabButton({ active, onClick, children, className, label }: { active: boolean; onClick: () => void; children: ReactNode; className?: string; label?: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-label={label}
      title={label}
      aria-selected={active}
      onClick={onClick}
      className={cx(
        'inline-flex flex-none items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
        active ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800',
        className,
      )}
    >
      {children}
    </button>
  );
}

export { cx };
