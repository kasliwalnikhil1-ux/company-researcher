'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Archive, Check, History, LayoutGrid, Maximize2, Pause, Pencil, Play, Plus, RotateCcw, Save, Settings2, TrendingUp, UserPlus, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, Button, Input, Select, Textarea, Toggle } from '@/components/outreach/ui';
import type { Client, Sender, Sequence } from '@/lib/outreach/types';
import type { Draft } from './draft';
import PoolSelector from './PoolSelector';
import { ProjectionModal } from './Projection';
import { STATUS_TONE } from './helpers';

export type StatusAction = 'activate' | 'pause' | 'resume' | 'archive' | 'draft';

interface Props {
  sequence: Sequence;
  draft: Draft;
  dirty: boolean;
  saving: boolean;
  version: number;
  readOnly: boolean;
  canManage: boolean;
  senders: Sender[];
  clients: Client[];
  inflight: number | undefined;
  onChange: (patch: Partial<Draft>) => void;
  onSave: () => Promise<boolean>;
  onStatus: (action: StatusAction) => void;
  onAutoLayout: () => void;
  onFit: () => void;
  onNavigate: (href: string) => void;
  onOpenPalette: () => void;
}

function NameEditor({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setText(value); }, [value, editing]);
  useEffect(() => { if (editing) ref.current?.select(); }, [editing]);
  const commit = () => { const t = text.trim(); if (t && t !== value) onChange(t); setEditing(false); };
  if (editing) {
    return <input ref={ref} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setText(value); setEditing(false); } }} aria-label="Sequence name" className="text-base font-semibold text-gray-900 px-2 py-0.5 rounded-md border border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 min-w-0 w-64 max-w-full" />;
  }
  return (
    <button type="button" disabled={disabled} onClick={() => setEditing(true)} title={disabled ? value : 'Rename'} className="group inline-flex items-center gap-1.5 min-w-0 text-base font-semibold text-gray-900 px-2 py-0.5 rounded-md hover:bg-gray-100 disabled:hover:bg-transparent">
      <span className="truncate max-w-[40vw] md:max-w-md">{value}</span>
      {!disabled && <Pencil className="w-3.5 h-3.5 text-gray-400 opacity-0 group-hover:opacity-100 flex-shrink-0" />}
    </button>
  );
}

function SettingsPopover({ draft, clients, onChange, disabled }: { draft: Draft; clients: Client[]; onChange: Props['onChange']; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const s = draft.settings ?? {};
  return (
    <div className="relative">
      <Button variant="secondary" size="sm" className="h-9" onClick={() => setOpen((o) => !o)} title="Sequence settings" aria-expanded={open}><Settings2 className="w-4 h-4" /><span className="hidden lg:inline">Settings</span></Button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 md:left-0 md:right-auto z-30 mt-1 w-80 max-w-[92vw] bg-white border border-gray-200 rounded-lg shadow-lg p-3">
            <fieldset disabled={disabled} className="space-y-3">
              <Select label="Client" value={draft.clientId ?? ''} onChange={(e) => onChange({ clientId: e.target.value || null })}>
                {!draft.clientId && <option value="">No client</option>}
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              <Toggle checked={s.stop_on_reply !== false} onChange={(v) => onChange({ settings: { ...s, stop_on_reply: v } })} label="Stop when the lead replies" />
              <Input type="number" min={0} max={90} label="Withdraw pending invitations after (days)" value={s.withdraw_after_days ?? 21} onChange={(e) => onChange({ settings: { ...s, withdraw_after_days: Math.max(0, Number(e.target.value) || 0) } })} hint="0 disables automatic withdrawal." />
              <Textarea label="Brief for AI (context for drafts and QA)" value={draft.brief} onChange={(e) => onChange({ brief: e.target.value })} rows={4} placeholder="Who we are, who we target, offer, tone…" />
            </fieldset>
          </div>
        </>
      )}
    </div>
  );
}

export default function TopBar(p: Props) {
  const { sequence, draft, dirty, saving, version, readOnly, canManage, senders, clients, inflight, onChange, onSave, onStatus, onAutoLayout, onFit, onNavigate, onOpenPalette } = p;
  const [projOpen, setProjOpen] = useState(false);
  const status = sequence.status;
  const base = `/outreach/sequences/${sequence.id}`;

  return (
    <div className="bg-white border-b border-gray-200">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => onNavigate('/outreach/sequences')} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500" title="Back to sequences" aria-label="Back to sequences"><ArrowLeft className="w-4 h-4" /></button>
        <NameEditor value={draft.name} onChange={(name) => onChange({ name })} disabled={readOnly} />
        <Badge tone={STATUS_TONE[status]} className="capitalize">{status}</Badge>
        {sequence.throttled_reason && <Badge tone="amber" className="cursor-help"><span title={sequence.throttled_reason} className="inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> throttled</span></Badge>}
        <span className="text-xs text-gray-400">v{version}</span>
        {dirty && <span className="text-xs text-amber-700 inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Unsaved</span>}
        {readOnly && <span className="text-xs text-gray-500">Read-only</span>}
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          <Button variant="ghost" size="sm" onClick={() => onNavigate(`${base}/versions`)} title="Version history"><History className="w-4 h-4" /><span className="hidden sm:inline">Versions</span></Button>
          {!readOnly && <Button variant="ghost" size="sm" onClick={() => onNavigate(`${base}/enroll`)} title="Enrol leads"><UserPlus className="w-4 h-4" /><span className="hidden sm:inline">Enrol</span></Button>}
          {readOnly && sequence.status !== 'archived' && <Button variant="ghost" size="sm" onClick={() => onNavigate(`${base}/enroll`)} title="Enrollments"><UserPlus className="w-4 h-4" /><span className="hidden sm:inline">Enrollments</span></Button>}
          {!readOnly && (
            <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} loading={saving} onClick={() => onSave()} title="Save (Ctrl/Cmd+S)"><Save className="w-4 h-4" /> Save</Button>
          )}
          {canManage && status === 'draft' && <Button size="sm" onClick={() => onStatus('activate')} className="bg-green-600 hover:bg-green-700"><Play className="w-4 h-4" /> Activate</Button>}
          {canManage && status === 'active' && <Button size="sm" variant="secondary" onClick={() => onStatus('pause')}><Pause className="w-4 h-4" /> Pause</Button>}
          {canManage && status === 'paused' && <Button size="sm" onClick={() => onStatus('resume')} className="bg-green-600 hover:bg-green-700"><Play className="w-4 h-4" /> Resume</Button>}
          {canManage && (status === 'active' || status === 'paused') && <Button size="sm" variant="secondary" onClick={() => onStatus('archive')} title="Archive and exit all enrollments"><Archive className="w-4 h-4" /><span className="hidden sm:inline">Archive</span></Button>}
          {canManage && status === 'archived' && <Button size="sm" variant="secondary" onClick={() => onStatus('draft')} title="Move back to draft"><RotateCcw className="w-4 h-4" /> Move to draft</Button>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
        <PoolSelector pool={draft.pool} senders={senders} onChange={(pool) => onChange({ pool })} disabled={readOnly} />
        <select value={draft.assignment} disabled={readOnly} onChange={(e) => onChange({ assignment: e.target.value as Draft['assignment'] })} aria-label="Assignment strategy" title="How leads are assigned to senders in the pool" className="h-9 px-2.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-700 disabled:opacity-60">
          <option value="round_robin">Round robin</option>
          <option value="least_loaded">Least loaded</option>
          <option value="fixed">Fixed sender</option>
        </select>
        <div className={cn('h-9 inline-flex items-center px-2 rounded-lg border border-gray-300 bg-white', readOnly && 'opacity-60')}>
          <Toggle checked={draft.useSenderSchedule} onChange={(v) => onChange({ useSenderSchedule: v })} label="Use sender schedule" disabled={readOnly} />
        </div>
        <SettingsPopover draft={draft} clients={clients} onChange={onChange} disabled={readOnly} />
        <Button variant="secondary" size="sm" className="h-9" onClick={() => setProjOpen(true)} title="Estimate how long N leads take on this pool"><TrendingUp className="w-4 h-4" /> Projection</Button>
        {typeof inflight === 'number' && (status === 'active' || status === 'paused') && <span className="text-xs text-gray-500 inline-flex items-center gap-1"><Check className="w-3.5 h-3.5 text-green-600" /> {inflight.toLocaleString()} in flight</span>}
        <div className="ml-auto flex items-center gap-1">
          {!readOnly && <Button variant="ghost" size="sm" className="md:hidden" onClick={onOpenPalette} title="Add a step"><Plus className="w-4 h-4" /> Add step</Button>}
          {!readOnly && <Button variant="ghost" size="sm" onClick={onAutoLayout} title="Auto-arrange steps left to right"><LayoutGrid className="w-4 h-4" /><span className="hidden lg:inline">Auto-layout</span></Button>}
          <Button variant="ghost" size="sm" onClick={onFit} title="Zoom to fit"><Maximize2 className="w-4 h-4" /><span className="hidden lg:inline">Fit</span></Button>
        </div>
      </div>
      <ProjectionModal open={projOpen} onClose={() => setProjOpen(false)} sequenceId={sequence.id} beforeRun={dirty && !readOnly ? onSave : undefined} />
    </div>
  );
}
