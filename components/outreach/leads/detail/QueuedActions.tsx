'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Clock, Pencil, SkipForward } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import { ik, useLeadQueuedActions, type QueuedAction } from '@/lib/outreach/intel';
import { buildContext, renderTemplate } from '@/lib/outreach/render';
import { Badge, Button, ErrorBox, Input, Modal, Textarea, fmtDate } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import type { ToastFn } from '../helpers';

// Same limits as outreach_set_action_text (012).
const TEXT_LIMIT: Record<string, number> = { invite: 300, message: 8000, inmail: 1900, comment: 1250 };
const ACTION_LABEL: Record<string, string> = {
  invite: 'Connection request', message: 'Message', inmail: 'InMail', email: 'Email', comment: 'Comment', like: 'Like', endorse: 'Endorsement',
  profile_view: 'Profile view', withdraw: 'Withdraw request', follow: 'Follow', post_fetch: 'Post check', find_email: 'Find email', call_api: 'Webhook call',
};

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stepLabel(a: QueuedAction): string {
  return a.node_label || ACTION_LABEL[a.action_type] || a.action_type.replace(/_/g, ' ');
}

export function QueuedActions({ leadId, leadName, compact, toast }: { leadId: string; leadName?: string | null; compact?: boolean; toast: ToastFn }) {
  const { canWrite, isManager } = useWorkspace();
  const qc = useQueryClient();
  const q = useLeadQueuedActions(leadId);
  const [edit, setEdit] = useState<QueuedAction | null>(null);
  const [move, setMove] = useState<QueuedAction | null>(null);
  const [skip, setSkip] = useState<QueuedAction | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ik.queued(leadId) });
    qc.invalidateQueries({ queryKey: qk.lead(leadId) });
    qc.invalidateQueries({ queryKey: ik.timeline(leadId) });
    qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
  };

  const rows = q.data ?? [];
  const btn = 'inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline disabled:opacity-50 disabled:no-underline';

  return (
    <div>
      {q.isLoading && <p className="text-xs text-gray-400">Loading…</p>}
      {q.error && <ErrorBox message={parseError(q.error).message} />}
      {q.data && rows.length === 0 && <p className={cn('text-gray-500', compact ? 'text-xs' : 'text-sm')}>Nothing is queued for this lead right now. Steps are planned a day or two ahead.</p>}
      {rows.length > 0 && (
        <ul className={cn(compact ? 'space-y-2.5' : 'divide-y divide-gray-100 -my-2')}>
          {rows.map((a) => (
            <li key={a.action_id} className={cn(compact ? 'text-xs' : 'py-2.5 text-sm')}>
              <div className="flex items-start gap-2">
                <Clock className={cn('text-blue-500 flex-shrink-0 mt-0.5', compact ? 'w-3.5 h-3.5' : 'w-4 h-4')} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium text-gray-900">{stepLabel(a)}</span>
                    {!compact && <Badge tone="blue">{ACTION_LABEL[a.action_type] ?? a.action_type.replace(/_/g, ' ')}</Badge>}
                    {a.variant_id && <Badge tone="purple">Variant {a.variant_id}</Badge>}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {a.sequence_id ? <Link href={`/outreach/sequences/${a.sequence_id}${a.node_id ? `?node=${encodeURIComponent(a.node_id)}` : ''}`} className="hover:text-indigo-600 hover:underline">{a.sequence_name ?? 'Sequence'}</Link> : 'No sequence'}
                    {' · via '}{a.sender_name ?? 'sender'}{' · '}<span title={new Date(a.scheduled_for).toLocaleString()}>{fmtDate(a.scheduled_for)}</span>
                  </div>
                  {!compact && a.body && <p className="text-xs text-gray-600 mt-1 line-clamp-2 whitespace-pre-wrap">{a.body}</p>}
                  {canWrite && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                      {a.editable && isManager && <button type="button" className={btn} onClick={() => setEdit(a)}><Pencil className="w-3 h-3" /> Edit text</button>}
                      <button type="button" className={btn} onClick={() => setMove(a)}><CalendarClock className="w-3 h-3" /> Move</button>
                      <button type="button" className={cn(btn, 'text-red-600')} onClick={() => setSkip(a)}><SkipForward className="w-3 h-3" /> Skip this step</button>
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {edit && <EditTextModal action={edit} leadId={leadId} onClose={() => setEdit(null)} onSaved={refresh} toast={toast} />}
      {move && <MoveModal action={move} onClose={() => setMove(null)} onSaved={refresh} toast={toast} />}
      {skip && <SkipModal action={skip} leadName={leadName} onClose={() => setSkip(null)} onSaved={refresh} toast={toast} />}
    </div>
  );
}

function EditTextModal({ action, leadId, onClose, onSaved, toast }: { action: QueuedAction; leadId: string; onClose: () => void; onSaved: () => void; toast: ToastFn }) {
  const isEmail = action.action_type === 'email';
  const [text, setText] = useState(action.body ?? '');
  const [subject, setSubject] = useState(action.subject ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limit = TEXT_LIMIT[action.action_type] ?? null;
  const over = limit != null && text.length > limit;

  // The same context the executor uses, so the preview is what gets sent (only approved AI lines resolve).
  const ctxQ = useQuery({
    queryKey: ['outreach', 'lead', leadId, 'render-context', action.sender_id, action.enrollment_id ?? ''], staleTime: 60_000,
    queryFn: () => rpc<Record<string, unknown>>('render_context', { p_lead: leadId, p_sender: action.sender_id, p_enrollment: action.enrollment_id }),
  });
  const preview = useMemo(() => {
    if (!ctxQ.data) return null;
    try {
      const ctx = buildContext(ctxQ.data);
      return { text: renderTemplate(text, ctx), subject: isEmail ? renderTemplate(subject, ctx) : '' };
    } catch { return null; }
  }, [ctxQ.data, text, subject, isEmail]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const ok = await rpc<boolean>('set_action_text', { p_action: action.action_id, p_text: text, p_subject: isEmail ? subject : null });
      if (ok === false) { setError('This step is already being sent, so the text was not changed.'); return; }
      toast('Text updated for this lead');
      onSaved(); onClose();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={() => !busy && onClose()} title={`Edit text: ${stepLabel(action)}`} size="lg"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button loading={busy} disabled={!text.trim() || over} onClick={save}>Save text</Button></>}>
      <div className="space-y-3">
        <p className="text-xs text-gray-500">This changes the queued step for this lead only. The sequence step stays as it is. Going out {fmtDate(action.scheduled_for)} via {action.sender_name ?? 'the sender'}.</p>
        {!action.body && <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">No text is stored on this step yet. It is rendered from the sequence step when it is sent. Text you save here is used for this lead instead.</p>}
        {isEmail && <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />}
        <Textarea label="Template as stored" value={text} onChange={(e) => setText(e.target.value)} className="min-h-[160px] font-mono text-[13px]" counter={limit != null ? { max: limit, value: text.length } : undefined} hint="Variables such as {{first_name|there}} are filled in when the step is sent." />
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">Preview for this lead</div>
          {ctxQ.isLoading ? <p className="text-xs text-gray-400">Loading preview…</p> : ctxQ.error ? <p className="text-xs text-gray-500">Preview is not available: {parseError(ctxQ.error).message}</p> : preview ? (
            <div className="text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-lg p-3 whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
              {isEmail && preview.subject && <div className="font-medium mb-1">{preview.subject}</div>}
              {preview.text || <span className="text-gray-400">Nothing to preview yet.</span>}
            </div>
          ) : null}
        </div>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

function MoveModal({ action, onClose, onSaved, toast }: { action: QueuedAction; onClose: () => void; onSaved: () => void; toast: ToastFn }) {
  const [at, setAt] = useState(() => toLocalInput(new Date(Math.max(Date.now() + 3600_000, new Date(action.scheduled_for).getTime()))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bounds, setBounds] = useState<{ min: string; max: string } | null>(null);
  useEffect(() => { setBounds({ min: toLocalInput(new Date()), max: toLocalInput(new Date(Date.now() + 60 * 86_400_000)) }); }, []);
  const when = at ? new Date(at) : null;
  const valid = !!when && !isNaN(when.getTime()) && when.getTime() > Date.now() - 60_000 && when.getTime() < Date.now() + 60 * 86_400_000;

  const save = async () => {
    if (!when || !valid) return;
    setBusy(true); setError(null);
    try {
      await rpc('reschedule_action', { p_action: action.action_id, p_at: when.toISOString() });
      toast(`Moved to ${fmtDate(when.toISOString())}`);
      onSaved(); onClose();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={() => !busy && onClose()} title={`Move: ${stepLabel(action)}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button loading={busy} disabled={!valid} onClick={save}>Move step</Button></>}>
      <div className="space-y-3">
        <Input label="Send at" type="datetime-local" value={at} min={bounds?.min} max={bounds?.max} onChange={(e) => setAt(e.target.value)} error={at && !valid ? 'Pick a time within the next 60 days.' : undefined} />
        <p className="text-xs text-gray-500">Currently planned for {fmtDate(action.scheduled_for)}. The sender&apos;s working hours and daily limits still decide the exact moment it goes out.</p>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

function SkipModal({ action, leadName, onClose, onSaved, toast }: { action: QueuedAction; leadName?: string | null; onClose: () => void; onSaved: () => void; toast: ToastFn }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try {
      await rpc('skip_action', { p_action: action.action_id });
      toast('Step skipped. The lead moves to the next step.');
      onSaved(); onClose();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={() => !busy && onClose()} title="Skip this step?" size="sm"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Keep it</Button><Button variant="danger" loading={busy} onClick={run}>Skip this step</Button></>}>
      <div className="space-y-2 text-sm text-gray-700">
        <p><span className="font-medium">{stepLabel(action)}</span> will not be sent to {leadName ?? 'this lead'}.</p>
        <p className="text-gray-600">Cancelling a queued step on its own does not work: the planner would queue it again. Skipping marks the step as handled and moves the lead to the next step of {action.sequence_name ?? 'the sequence'}.</p>
        <p className="text-gray-600">To stop the whole sequence for this lead, exit the enrollment instead.</p>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}
