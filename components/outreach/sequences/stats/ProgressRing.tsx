'use client';

// The progress ring in the Sequence column of the Sequences list (PRD §6.1): the share of enrolments that are done,
// with the percent inside. Accent while running, green once everyone is done, an empty dashed ring for a draft.
import React from 'react';
import { cn } from '@/lib/utils';
import type { Rate } from '@/lib/outreach/reports';

export function ProgressRing({ pct, size = 40, stroke = 3.5, title, className }: { pct: Rate | undefined; size?: number; stroke?: number; title?: string; className?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const known = typeof pct === 'number' && Number.isFinite(pct);
  const p = known ? Math.max(0, Math.min(100, pct)) : 0;
  const complete = known && p >= 100;
  const color = complete ? '#10b981' : 'var(--outreach-accent, #4f46e5)';
  return (
    <span className={cn('relative inline-flex items-center justify-center shrink-0', title && 'cursor-help', className)} style={{ width: size, height: size }} title={title}
      role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(p) : undefined} aria-label="Share of enrolments that are done">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e5e7eb" strokeWidth={stroke} strokeDasharray={known ? undefined : '3 3'} />
        {known && p > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${(c * p) / 100} ${c}`} className="transition-[stroke-dasharray] duration-300" />}
      </svg>
      <span className={cn('relative text-[10px] font-semibold leading-none', !known ? 'text-gray-300' : complete ? 'text-emerald-700' : 'text-gray-700')}>{known ? `${Math.round(p)}%` : '—'}</span>
    </span>
  );
}
