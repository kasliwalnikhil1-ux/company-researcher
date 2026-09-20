'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Archive, ArrowLeft, Check, ChevronDown, CloudOff, HelpCircle, History, LayoutGrid, Loader2, Maximize2, Pause, Pencil, Play, Plus, RotateCcw, Save, Settings2, Shuffle, TrendingUp, Undo2, UploadCloud, UserPlus, UserX, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, Button, Toggle } from '@/components/outreach/ui';
import type { Client, Sender } from '@/lib/outreach/types';
import type { Draft } from './draft';
import type { DraftSaveStatus } from './DraftAutosave';
import PoolSelector from './PoolSelector';
import { ProjectionModal } from './Projection';
import SequenceSettingsPanel from './SequenceSettingsPanel';
import { STATUS_TONE } from './helpers';
import { ASSIGNMENT_OPTIONS, fmtClock, fmtInt, plural, type SequenceExt, type SetPoolResult } from './publishTypes';

export type StatusAction = 'activate' | 'pause' | 'resume' | 'archive' | 'draft';

export interface DraftIndicator {
  status: DraftSaveStatus;
  savedAt: string | null;
  error: string | null;
  retrying: boolean;
  /** Step changes counted by the database plus changed settings. Null while unknown. */
  unpublished: number | null;
  /** The draft differs from the live version only by layout. */
  layoutOnly: boolean;
}

interface Props {
  sequence: SequenceExt;
  draft: Draft;
  /** The local draft differs from the live sequence. */
  dirty: boolean;
  saving: boolean;
  version: number;
  readOnly: boolean;
  canManage: boolean;
  /** Publish (sequence has or had leads) instead of the simple Save. */
  publishMode: boolean;
  modeKnown: boolean;
  canDiscard: boolean;
  indicator: DraftIndicator;
  senders: Sender[];
  clients: Client[];
  inflight: number | undefined;
  failedCount: number | undefined;
  onChange: (patch: Partial<Draft>) => void;
  onSave: () => Promise<boolean>;
  onPublish: () => void;
  onDiscard: () => void;
  onPoolApplied: (pool: string[], result: SetPoolResult) => void;
  onStatus: (action: StatusAction) => void;
  onWhy: () => void;
  onAutoEnrol: () => void;
  onFailed: () => void;
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

/** Popover shell shared by the settings and assignment menus: closes on outside click and Escape, returns focus. */
function Popover({ button, children, width = 'w-80', align = 'left' }: { button: (p: { open: boolean; toggle: () => void; ref: React.RefObject<HTMLButtonElement> }) => React.ReactNode; children: (close: () => void) => React.ReactNode; width?: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); btn.current?.focus(); };
  return (
    <div className="relative" onKeyDown={(e) => { if (open && e.key === 'Escape') { e.stopPropagation(); close(); } }}>
      {button({ open, toggle: () => setOpen((o) => !o), ref: btn })}
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className={cn('absolute z-30 mt-1 max-w-[92vw] bg-white border border-gray-200 rounded-lg shadow-lg', width, align === 'right' ? 'right-0' : 'right-0 md:left-0 md:right-auto')}>{children(close)}</div>
        </>
      )}
    </div>
  );
}

function AssignmentMenu({ value, onChange, disabled }: { value: string; onChange: (v: Draft['assignment']) => void; disabled: boolean }) {
  const current = ASSIGNMENT_OPTIONS.find((o) => o.value === value) ?? ASSIGNMENT_OPTIONS[0];
  return (
    <Popover width="w-96" button={({ open, toggle, ref }) => (
      <button ref={ref} type="button" disabled={disabled} onClick={toggle} aria-haspopup="listbox" aria-expanded={open} title={`How leads are assigned to senders. ${current.help}`} className="h-9 inline-flex items-center gap-2 px-2.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-60">
        <Shuffle className="w-4 h-4 text-gray-500" /><span className="truncate max-w-[11rem]">{current.label}</span><ChevronDown className="w-4 h-4 text-gray-400" />
      </button>
    )}>
      {(close) => (
        <ul role="listbox" aria-label="Assignment rule" className="py-1">
          {ASSIGNMENT_OPTIONS.map((o) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button type="button" onClick={() => { onChange(o.value as Draft['assignment']); close(); }} className={cn('w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-gray-50', o.value === value && 'bg-indigo-50/60')}>
                <Check className={cn('w-4 h-4 mt-0.5 flex-shrink-0', o.value === value ? 'text-indigo-600' : 'text-transparent')} />
                <span className="min-w-0"><span className="block text-sm text-gray-900">{o.label}</span><span className="block text-xs text-gray-500">{o.help}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

function DraftStatusText({ i, dirty, publishMode, readOnly }: { i: DraftIndicator; dirty: boolean; publishMode: boolean; readOnly: boolean }) {
  // Fixed box: the text changes every few seconds while editing and must not push the buttons around.
  const box = 'text-xs inline-flex items-center gap-1.5 md:w-[19rem] min-w-0 h-5';
  if (readOnly) return <span className={cn(box, 'text-gray-500')}>Read-only</span>;
  if (i.status === 'error') {
    return <span className={cn(box, 'text-red-700 font-medium')} role="status" title={i.error ?? undefined}><CloudOff className="w-3.5 h-3.5 flex-shrink-0" /><span className="truncate">{i.retrying ? 'Draft not saved — retrying' : `Draft not saved. ${i.error ?? ''}`}</span></span>;
  }
  if (i.status === 'saving' || i.status === 'pending') {
    return <span className={cn(box, 'text-gray-500')} role="status"><Loader2 className={cn('w-3.5 h-3.5 flex-shrink-0', i.status === 'saving' && 'animate-spin')} /><span className="truncate">Saving draft…</span></span>;
  }
  const n = i.unpublished;
  const tail = !dirty ? (publishMode ? 'No unpublished changes' : '')
    : publishMode ? (n && n > 0 ? `${fmtInt(n)} unpublished ${plural(n, 'change')}` : i.layoutOnly ? 'Layout changes not published' : n === null ? 'Unpublished changes' : 'Unpublished changes')
    : 'Not saved as a version yet';
  const head = i.savedAt && dirty ? `Draft saved ${fmtClock(i.savedAt)}` : '';
  const text = [head, tail].filter(Boolean).join(' · ');
  return (
    <span className={cn(box, dirty ? 'text-amber-700' : 'text-gray-400')} role="status" title={text}>
      {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />}
      <span className="truncate tabular-nums">{text}</span>
    </span>
  );
}

export default function TopBar(p: Props) {
  const { sequence, draft, dirty, saving, version, readOnly, canManage, publishMode, modeKnown, canDiscard, indicator, senders, clients, inflight, failedCount, onChange, onSave, onPublish, onDiscard, onPoolApplied, onStatus, onWhy, onAutoEnrol, onFailed, onAutoLayout, onFit, onNavigate, onOpenPalette } = p;
  const [projOpen, setProjOpen] = useState(false);
  const status = sequence.status;
  const base = `/outreach/sequences/${sequence.id}`;
  const live = status === 'active' || status === 'paused';

  return (
    <div className="bg-white border-b border-gray-200">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => onNavigate('/outreach/sequences')} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500" title="Back to sequences" aria-label="Back to sequences"><ArrowLeft className="w-4 h-4" /></button>
        <NameEditor value={draft.name} onChange={(name) => onChange({ name })} disabled={readOnly} />
        <Badge tone={STATUS_TONE[status]} className="capitalize">{status}</Badge>
        {sequence.stalled_at && status === 'active' && (
          <button type="button" onClick={onWhy} title={sequence.stalled_reason ?? 'Nothing was sent in the last sending window'} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 hover:bg-red-200"><AlertTriangle className="w-3 h-3" /> Stalled</button>
        )}
        {sequence.throttled_reason && <Badge tone="amber" className="cursor-help"><span title={sequence.throttled_reason} className="inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> throttled</span></Badge>}
        <span className="text-xs text-gray-400 tabular-nums">v{version}</span>
        <DraftStatusText i={indicator} dirty={dirty} publishMode={publishMode} readOnly={readOnly} />
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          {sequence.status !== 'draft' && <Button variant="ghost" size="sm" onClick={onWhy} title="Check what is holding this sequence back"><HelpCircle className="w-4 h-4" /><span className="hidden xl:inline">Why isn't this sending?</span></Button>}
          <Button variant="ghost" size="sm" onClick={() => onNavigate(`${base}/versions`)} title="Version history"><History className="w-4 h-4" /><span className="hidden lg:inline">Versions</span></Button>
          <Button variant="ghost" size="sm" onClick={onAutoEnrol} title="Rules that enrol leads on their own"><Zap className="w-4 h-4" /><span className="hidden lg:inline">Auto-enrol</span></Button>
          {!readOnly && <Button variant="ghost" size="sm" onClick={() => onNavigate(`${base}/enroll`)} title="Enrol leads"><UserPlus className="w-4 h-4" /><span className="hidden sm:inline">Enrol</span></Button>}
          {readOnly && sequence.status !== 'archived' && <Button variant="ghost" size="sm" onClick={() => onNavigate(`${base}/enroll`)} title="Enrollments"><UserPlus className="w-4 h-4" /><span className="hidden sm:inline">Enrollments</span></Button>}
          {!readOnly && (
            <Button variant="ghost" size="sm" disabled={!canDiscard || saving} onClick={onDiscard} title={publishMode ? 'Throw away every unpublished change' : 'Go back to the last saved version'}><Undo2 className="w-4 h-4" /><span className="hidden lg:inline">Discard draft</span></Button>
          )}
          {!readOnly && (publishMode
            ? <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || !modeKnown} loading={saving} onClick={onPublish} title="Review who is affected, then publish (Ctrl/Cmd+S)" className="min-w-[5.75rem]"><UploadCloud className="w-4 h-4" /> Publish</Button>
            : <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || !modeKnown} loading={saving} onClick={() => onSave()} title="Save (Ctrl/Cmd+S)" className="min-w-[5.75rem]"><Save className="w-4 h-4" /> Save</Button>)}
          {canManage && status === 'draft' && <Button size="sm" onClick={() => onStatus('activate')} className="bg-green-600 hover:bg-green-700"><Play className="w-4 h-4" /> Activate</Button>}
          {canManage && status === 'active' && <Button size="sm" variant="secondary" onClick={() => onStatus('pause')}><Pause className="w-4 h-4" /> Pause</Button>}
          {canManage && status === 'paused' && <Button size="sm" onClick={() => onStatus('resume')} className="bg-green-600 hover:bg-green-700"><Play className="w-4 h-4" /> Resume</Button>}
          {canManage && live && <Button size="sm" variant="secondary" onClick={() => onStatus('archive')} title="Archive and exit all enrollments"><Archive className="w-4 h-4" /><span className="hidden sm:inline">Archive</span></Button>}
          {canManage && status === 'archived' && <Button size="sm" variant="secondary" onClick={() => onStatus('draft')} title="Move back to draft"><RotateCcw className="w-4 h-4" /> Move to draft</Button>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
        <PoolSelector pool={draft.pool} senders={senders} onChange={(pool) => onChange({ pool })} disabled={readOnly} live={publishMode ? { sequenceId: sequence.id, onApplied: onPoolApplied } : undefined} />
        <AssignmentMenu value={draft.assignment as string} onChange={(assignment) => onChange({ assignment })} disabled={readOnly} />
        <div className={cn('h-9 inline-flex items-center px-2 rounded-lg border border-gray-300 bg-white', readOnly && 'opacity-60')}>
          <Toggle checked={draft.useSenderSchedule} onChange={(v) => onChange({ useSenderSchedule: v })} label="Use sender schedule" disabled={readOnly} />
        </div>
        <Popover width="w-[26rem]" button={({ open, toggle, ref }) => (
          <button ref={ref} type="button" onClick={toggle} title="Replies, out-of-office, enrichment, client and brief" aria-expanded={open} aria-haspopup="dialog" className="h-9 inline-flex items-center gap-2 px-2.5 text-xs font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"><Settings2 className="w-4 h-4" /><span className="hidden lg:inline">Settings</span></button>
        )}>
          {() => <div className="p-3 max-h-[70vh] overflow-y-auto" role="dialog" aria-label="Sequence settings"><SequenceSettingsPanel draft={draft} clients={clients} onChange={onChange} disabled={readOnly} live={publishMode} /></div>}
        </Popover>
        <Button variant="secondary" size="sm" className="h-9" onClick={() => setProjOpen(true)} title="Estimate how long N leads take on this pool"><TrendingUp className="w-4 h-4" /> Projection</Button>
        {typeof inflight === 'number' && live && <span className="text-xs text-gray-500 inline-flex items-center gap-1 tabular-nums"><Check className="w-3.5 h-3.5 text-green-600" /> {inflight.toLocaleString()} in flight</span>}
        {!!failedCount && failedCount > 0 && (
          <button type="button" onClick={onFailed} title="See why they failed, then retry, skip or exit them" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 hover:bg-red-200 tabular-nums"><UserX className="w-3 h-3" /> {fmtInt(failedCount)} failed</button>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!readOnly && <Button variant="ghost" size="sm" className="md:hidden" onClick={onOpenPalette} title="Add a step"><Plus className="w-4 h-4" /> Add step</Button>}
          {!readOnly && <Button variant="ghost" size="sm" onClick={onAutoLayout} title="Auto-arrange steps left to right"><LayoutGrid className="w-4 h-4" /><span className="hidden lg:inline">Auto-layout</span></Button>}
          <Button variant="ghost" size="sm" onClick={onFit} title="Zoom to fit"><Maximize2 className="w-4 h-4" /><span className="hidden lg:inline">Fit</span></Button>
        </div>
      </div>
      <ProjectionModal open={projOpen} onClose={() => setProjOpen(false)} sequenceId={sequence.id} beforeRun={dirty && !readOnly && !publishMode ? onSave : undefined} />
    </div>
  );
}
