'use client';

import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { Button, ErrorBox, Modal, PageHeader, Spinner } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import type { Role } from '@/lib/outreach/types';
import SettingsTabs, { roleAtLeast } from './SettingsTabs';

export { roleAtLeast };

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the textarea fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button type="button" aria-label={label} title={state === 'fail' ? 'Copy failed. Select the text and copy it by hand.' : label}
      onClick={async () => { const ok = await copyText(value); setState(ok ? 'ok' : 'fail'); setTimeout(() => setState('idle'), 1800); }}
      className={cn('inline-flex items-center justify-center w-8 h-8 rounded-lg border border-gray-300 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-800 flex-shrink-0', state === 'fail' && 'border-red-300 text-red-600', className)}>
      {state === 'ok' ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
      <span className="sr-only" aria-live="polite">{state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : ''}</span>
    </button>
  );
}

/** Read-only value with a copy button. `secret` masks the text on screen; the copy button still copies the real value. */
export function CopyField({ label, value, secret, hint, mono = true }: { label?: string; value: string; secret?: boolean; hint?: string; mono?: boolean }) {
  return (
    <div>
      {label && <div className="text-xs font-medium text-gray-600 mb-1">{label}</div>}
      <div className="flex gap-2">
        <input readOnly aria-label={label ?? 'Value'} type={secret ? 'password' : 'text'} value={value} onFocus={(e) => e.currentTarget.select()}
          className={cn('flex-1 min-w-0 px-3 py-2 text-xs rounded-lg border border-gray-300 bg-gray-50 text-gray-700', mono && 'font-mono')} />
        <CopyButton value={value} label={label ? `Copy ${label.toLowerCase()}` : 'Copy'} />
      </div>
      {hint && <div className="text-xs text-gray-500 mt-1">{hint}</div>}
    </div>
  );
}

/** Page frame shared by every settings screen: header, tabs and the role gate. */
export function SettingsFrame({ children, min, deniedMessage }: { children: React.ReactNode; min?: Role; deniedMessage?: string }) {
  const { workspace, role } = useWorkspace();
  if (!workspace) return <Spinner />;
  const allowed = !min || roleAtLeast(role, min);
  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <SettingsTabs />
      {allowed ? children : <ErrorBox message={deniedMessage ?? (min === 'owner' ? 'Only the workspace owner can open this page.' : 'Only owners and managers can open this page.')} />}
    </div>
  );
}

export function ConfirmModal({ open, onClose, onConfirm, title, children, confirmLabel = 'Confirm', danger = true, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; children: React.ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean }) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<><Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button></>}>
      <div className="text-sm text-gray-700 space-y-2">{children}</div>
    </Modal>
  );
}

/** Accessible on/off switch. Same look as `Toggle` in ui.tsx, plus `role="switch"` and a name for screen readers. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className="inline-flex items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed">
      <span className={cn('relative inline-block w-9 h-5 rounded-full transition-colors', checked ? 'bg-indigo-600' : 'bg-gray-300')}>
        <span className={cn('absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform', checked && 'translate-x-4')} />
      </span>
    </button>
  );
}

/** A labelled row with a control on the right, used for on/off settings. */
export function SettingRow({ title, description, control }: { title: string; description?: React.ReactNode; control: React.ReactNode }) {
  return (
    <div className="py-3 flex items-start justify-between gap-4">
      <div className="min-w-0"><div className="text-sm font-medium text-gray-900">{title}</div>{description && <div className="text-xs text-gray-500 mt-0.5">{description}</div>}</div>
      <div className="flex-shrink-0">{control}</div>
    </div>
  );
}

export function Note({ tone = 'gray', children, className }: { tone?: 'gray' | 'amber' | 'indigo' | 'green'; children: React.ReactNode; className?: string }) {
  const tones = { gray: 'bg-gray-50 border-gray-200 text-gray-700', amber: 'bg-amber-50 border-amber-200 text-amber-900', indigo: 'bg-indigo-50 border-indigo-200 text-indigo-900', green: 'bg-green-50 border-green-200 text-green-900' };
  return <div className={cn('text-sm rounded-lg border px-3 py-2', tones[tone], className)}>{children}</div>;
}

export const isEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
export const isHostname = (v: string) => /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(v.trim().toLowerCase());
