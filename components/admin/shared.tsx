'use client';

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Search, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, Button, Input, Modal, useToast } from '@/components/outreach/ui';
import { adminApi, type AdminUser } from '@/lib/platform/admin';
import type { AccessStatus } from '@/lib/platform/access';

// ─── toast shared by every tab ───────────────────────────────────────
const ToastCtx = createContext<((message: string, type?: 'success' | 'error') => void) | undefined>(undefined);

export function AdminToastProvider({ children }: { children: React.ReactNode }) {
  const { show, node } = useToast();
  return <ToastCtx.Provider value={show}>{children}{node}</ToastCtx.Provider>;
}

export function useAdminToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useAdminToast must be used within AdminToastProvider');
  return ctx;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── small helpers ───────────────────────────────────────────────────
export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function fmtDay(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtNum(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString();
}

/** "2026-09-25" for a <input type="date"> from an ISO timestamp. */
export function toDateInput(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

// ─── badges ──────────────────────────────────────────────────────────
export function StatusBadge({ status, banned }: { status: AccessStatus; banned?: boolean }) {
  if (banned) return <Badge tone="red">Banned</Badge>;
  if (status === 'active') return <Badge tone="green">Active</Badge>;
  if (status === 'pending') return <Badge tone="amber">Pending approval</Badge>;
  return <Badge tone="red">Blocked</Badge>;
}

export function PlanBadge({ plan }: { plan: string | null | undefined }) {
  const p = plan ?? 'free';
  const tone = p === 'pro' ? 'indigo' : p === 'basic' ? 'blue' : 'gray';
  return <Badge tone={tone} className="capitalize">{p}</Badge>;
}

export function WsPlanBadge({ plan }: { plan: string }) {
  const tone = plan === 'suspended' ? 'red' : plan === 'trial' ? 'amber' : plan === 'team' ? 'blue' : 'indigo';
  return <Badge tone={tone}>{plan === 'agency_plus' ? 'agency+' : plan}</Badge>;
}

/** The three products + admin, at a glance. */
export function AccessChips({ user, className }: { user: AdminUser; className?: string }) {
  const f = user.features ?? {};
  const on = (k: string) => (typeof f[k] === 'boolean' ? f[k] : true);
  const chip = (label: string, active: boolean, title: string) => (
    <span title={title} className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold border', active ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-gray-50 border-gray-200 text-gray-400 line-through')}>
      {label}
    </span>
  );
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {chip('Fund', on('fundraising'), 'Fundraising')}
      {chip('Outreach', on('outreach'), 'Outreach')}
      {chip('CRM', !!user.crm?.is_active, 'Sales CRM team')}
      {user.is_admin && <Badge tone="purple">Admin</Badge>}
    </span>
  );
}

// ─── layout pieces ───────────────────────────────────────────────────
export function Section({ title, description, actions, children, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('bg-white border border-gray-200 rounded-xl', className)}>
      <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-gray-100">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="text-sm text-gray-900 mt-0.5 break-words">{children}</dd>
    </div>
  );
}

/** Right-side drawer, the shape the rest of the app uses for record detail. */
export function Drawer({ open, onClose, title, subtitle, children, actions }: { open: boolean; onClose: () => void; title: React.ReactNode; subtitle?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 w-full max-w-3xl bg-gray-50 shadow-2xl flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 py-4 bg-white border-b border-gray-200">
          <div className="min-w-0">
            <div className="text-base font-semibold text-gray-900 truncate">{title}</div>
            {subtitle && <div className="text-xs text-gray-500 mt-0.5">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {actions}
            <button onClick={onClose} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500" aria-label="Close"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}

type ConfirmProps = { open: boolean; title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean; requireText?: string; onConfirm: () => Promise<void> | void; onClose: () => void };

/** Mounted only while open, so its typed text / error / busy state starts fresh every time. */
export function ConfirmModal(props: ConfirmProps) {
  return props.open ? <ConfirmModalInner {...props} /> : null;
}

function ConfirmModalInner({ open, title, message, confirmLabel = 'Confirm', danger, requireText, onConfirm, onClose }: ConfirmProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const blocked = !!requireText && typed.trim().toLowerCase() !== requireText.trim().toLowerCase();
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" footer={
      <>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={blocked} onClick={async () => {
          setBusy(true); setErr(null);
          try { await onConfirm(); onClose(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
        }}>{confirmLabel}</Button>
      </>
    }>
      <div className="text-sm text-gray-700 space-y-3">
        <div>{message}</div>
        {requireText && <Input label={`Type ${requireText} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />}
        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}

/** Tri-state switch: Default / On / Off. */
export function TriState({ value, onChange, disabled }: { value: boolean | undefined; onChange: (v: boolean | undefined) => void; disabled?: boolean }) {
  const opts: { v: boolean | undefined; label: string; cls: string }[] = [
    { v: undefined, label: 'Default', cls: 'data-[on=true]:bg-gray-200 data-[on=true]:text-gray-900' },
    { v: true, label: 'On', cls: 'data-[on=true]:bg-emerald-600 data-[on=true]:text-white' },
    { v: false, label: 'Off', cls: 'data-[on=true]:bg-rose-600 data-[on=true]:text-white' },
  ];
  return (
    <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
      {opts.map((o) => (
        <button key={o.label} type="button" disabled={disabled} data-on={value === o.v} onClick={() => onChange(o.v)} className={cn('px-2.5 py-1 text-gray-500 hover:bg-gray-50 disabled:opacity-50', o.cls)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Search accounts by email and pick one. */
export function AccountPicker({ onPick, placeholder = 'Search accounts by email…', exclude = [], autoFocus }: { onPick: (u: AdminUser) => void; placeholder?: string; exclude?: string[]; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300).trim();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const search = useQuery({ queryKey: ['admin', 'pick', dq], queryFn: () => adminApi.listUsers(dq, { sort: 'email' }, 8, 0), enabled: dq.length > 0, placeholderData: (p) => p });
  const busy = search.isFetching;
  const rows = dq ? (search.data?.rows ?? []).filter((u) => !exclude.includes(u.id)) : [];

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div ref={box} className="relative">
      <div className="relative">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={q} autoFocus={autoFocus} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder={placeholder}
          className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        {busy && <Loader2 className="w-4 h-4 text-gray-400 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
      </div>
      {open && q.trim() && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {rows.length === 0 && !busy && <div className="px-3 py-2 text-sm text-gray-500">No account matches “{q}”. The person has to sign up first.</div>}
          {rows.map((u) => (
            <button key={u.id} type="button" onClick={() => { onPick(u); setQ(''); setOpen(false); }} className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center justify-between gap-2">
              <span className="text-sm text-gray-900 truncate">{u.email}</span>
              <span className="flex items-center gap-1 flex-shrink-0"><StatusBadge status={u.status} banned={u.banned} /></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {label && <div className="text-xs font-medium text-gray-600 mb-1">{label}</div>}
      <div className="flex items-center gap-2">
        <input readOnly value={value} className="flex-1 px-3 py-2 text-xs rounded-lg border border-gray-300 bg-gray-50 text-gray-700 font-mono" onFocus={(e) => e.currentTarget.select()} />
        <Button size="sm" variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } }}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
    </div>
  );
}
