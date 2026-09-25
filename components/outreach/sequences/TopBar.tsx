'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Archive, ArrowLeft, Check, CloudOff, HelpCircle, Loader2, Pause, Pencil, Play, RotateCcw, Save, Undo2, UploadCloud, UserX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, Button } from '@/components/outreach/ui';
import type { Draft } from './draft';
import type { DraftSaveStatus } from './DraftAutosave';
import { STATUS_TONE } from './helpers';
import { fmtClock, fmtInt, plural, type SequenceExt } from './publishTypes';

export type StatusAction = 'activate' | 'pause' | 'resume' | 'archive' | 'draft';

/** Sections of the builder shown as tabs, in the order of the tab row. */
export type BuilderTab = 'steps' | 'senders' | 'leads' | 'auto' | 'settings' | 'versions';
export const BUILDER_TABS: BuilderTab[] = ['steps', 'senders', 'leads', 'auto', 'settings', 'versions'];
const TAB_LABEL: Record<BuilderTab, string> = { steps: 'Steps', senders: 'Senders', leads: 'Leads', auto: 'Auto-enrol', settings: 'Settings', versions: 'Versions' };

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
  inflight: number | undefined;
  failedCount: number | undefined;
  tab: BuilderTab;
  onTab: (tab: BuilderTab) => void;
  onChange: (patch: Partial<Draft>) => void;
  onSave: () => Promise<boolean>;
  onPublish: () => void;
  onDiscard: () => void;
  onStatus: (action: StatusAction) => void;
  onWhy: () => void;
  onFailed: () => void;
  onNavigate: (href: string) => void;
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

function DraftStatusText({ i, dirty, publishMode, readOnly }: { i: DraftIndicator; dirty: boolean; publishMode: boolean; readOnly: boolean }) {
  // Fixed box: the text changes every few seconds while editing and must not push the buttons around.
  const box = 'text-xs inline-flex items-center gap-1.5 md:w-[20rem] min-w-0 h-5 whitespace-nowrap';
  if (readOnly) return <span className={cn(box, 'text-gray-500')}>Read-only</span>;
  if (i.status === 'error') {
    return <span className={cn(box, 'text-red-700 font-medium')} role="status" title={i.error ?? undefined}><CloudOff className="w-3.5 h-3.5 flex-shrink-0" /><span className="truncate">{i.retrying ? 'Draft not saved — retrying' : `Draft not saved. ${i.error ?? ''}`}</span></span>;
  }
  if (i.status === 'saving' || i.status === 'pending') {
    return <span className={cn(box, 'text-gray-500')} role="status"><Loader2 className={cn('w-3.5 h-3.5 flex-shrink-0', i.status === 'saving' && 'animate-spin')} /><span className="truncate">Saving draft…</span></span>;
  }
  const n = i.unpublished;
  const tail = !dirty ? (publishMode ? 'No unpublished changes' : '')
    : publishMode ? (n && n > 0 ? `${fmtInt(n)} unpublished ${plural(n, 'change')}` : i.layoutOnly ? 'Layout changes not published' : 'Unpublished changes')
    : 'Not saved as a version yet';
  const head = i.savedAt && dirty ? `Draft saved ${fmtClock(i.savedAt)}` : '';
  const text = [head, tail].filter(Boolean).join(' · ');
  return (
    <span className={cn(box, dirty ? 'text-amber-700' : 'text-gray-400')} role="status" title={text}>
      {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />}
      <span className="truncate">{text}</span>
    </span>
  );
}

const tabClass = (active: boolean) => cn('px-3.5 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors', active ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800');

export default function TopBar(p: Props) {
  const { sequence, draft, dirty, saving, version, readOnly, canManage, publishMode, modeKnown, canDiscard, indicator, inflight, failedCount, tab, onTab, onChange, onSave, onPublish, onDiscard, onStatus, onWhy, onFailed, onNavigate } = p;
  const status = sequence.status;
  const live = status === 'active' || status === 'paused';
  // Everyone who can edit enrols; readers still see the leads of a running sequence.
  const showLeads = !readOnly || status !== 'archived';

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
          {status !== 'draft' && <Button variant="ghost" size="sm" onClick={onWhy} title="Check what is holding this sequence back"><HelpCircle className="w-4 h-4" /><span className="hidden xl:inline">Why isn't this sending?</span></Button>}
          {!readOnly && (
            <Button variant="ghost" size="sm" disabled={!canDiscard || saving} onClick={onDiscard} title={publishMode ? 'Throw away every unpublished change' : 'Go back to the last saved version'}><Undo2 className="w-4 h-4" /><span className="hidden lg:inline">Discard draft</span></Button>
          )}
          {!readOnly && (publishMode
            ? <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || !modeKnown} loading={saving} onClick={onPublish} title="Review who is affected, then publish (Ctrl/Cmd+S)" className="min-w-[5.75rem]"><UploadCloud className="w-4 h-4" /> Publish</Button>
            : <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || !modeKnown} loading={saving} onClick={() => onSave()} title="Save (Ctrl/Cmd+S)" className="min-w-[5.75rem]"><Save className="w-4 h-4" /> Save</Button>)}
          {canManage && status === 'draft' && <Button size="sm" onClick={() => onStatus('activate')} title="Start the sequence: leads in it begin getting messages on your senders' schedule, and auto-enrol rules start adding leads" className="bg-green-600 hover:bg-green-700"><Play className="w-4 h-4" /> Activate</Button>}
          {canManage && status === 'active' && <Button size="sm" variant="secondary" onClick={() => onStatus('pause')}><Pause className="w-4 h-4" /> Pause</Button>}
          {canManage && status === 'paused' && <Button size="sm" onClick={() => onStatus('resume')} className="bg-green-600 hover:bg-green-700"><Play className="w-4 h-4" /> Resume</Button>}
          {canManage && live && <Button size="sm" variant="secondary" onClick={() => onStatus('archive')} title="Archive and take every lead out of the sequence"><Archive className="w-4 h-4" /><span className="hidden sm:inline">Archive</span></Button>}
          {canManage && status === 'archived' && <Button size="sm" variant="secondary" onClick={() => onStatus('draft')} title="Move back to draft"><RotateCcw className="w-4 h-4" /> Move to draft</Button>}
        </div>
      </div>
      <div className="flex items-center gap-2 px-3">
        <div role="tablist" aria-label="Sequence section" className="flex gap-1 overflow-x-auto overflow-y-hidden min-w-0">
          {BUILDER_TABS.filter((t) => t !== 'leads' || showLeads).map((t) => (
            <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => onTab(t)} className={tabClass(tab === t)}>{TAB_LABEL[t]}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0 pb-1">
          {typeof inflight === 'number' && live && <span className="text-xs text-gray-500 hidden sm:inline-flex items-center gap-1 tabular-nums"><Check className="w-3.5 h-3.5 text-green-600" /> {inflight.toLocaleString()} in flight</span>}
          {!!failedCount && failedCount > 0 && (
            <button type="button" onClick={onFailed} title="See why they failed, then retry, skip or exit them" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 hover:bg-red-200 tabular-nums"><UserX className="w-3 h-3" /> {fmtInt(failedCount)} failed</button>
          )}
        </div>
      </div>
    </div>
  );
}
