'use client';

// Queued text and timing for the selected step on a live sequence (plan item 7).
// The builder mounts this above the step settings panel. The "update them too / leave as they are"
// decision itself is made in the publish dialog.
import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Clock, MessageSquare, Pencil } from 'lucide-react';
import { parseError, rpc } from '@/lib/outreach/api';
import type { GraphNode, Sender } from '@/lib/outreach/types';
import { Badge, Button, EmptyState, ErrorBox, fmtDate, Input, Spinner, Textarea, useToast } from '@/components/outreach/ui';
import { Drawer } from './Modals';
import { sqk, useQueuedActions, useWaitingInDelay } from './hooks';
import { nodeTitle, senderName } from './helpers';
import { fmtInt, isDelayStep, isTextStep, plural, type QueuedActionRow } from './publishTypes';

const NOUN: Record<string, [string, string]> = {
  send_invite: ['invitation', 'invitations'], send_inmail: ['InMail', 'InMails'], send_email: ['email', 'emails'],
  comment_latest_post: ['comment', 'comments'], send_voice_note: ['voice note', 'voice notes'],
};
const TEXT_LIMIT: Record<string, number> = { send_invite: 300, send_message: 8000, send_inmail: 1900, comment_latest_post: 1250 };

const stripHtml = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function queuedText(p: QueuedActionRow['payload']): string | null {
  if (!p) return null;
  if (typeof p.text === 'string' && p.text) return p.text;
  if (typeof p.note === 'string' && p.note) return p.note;
  if (typeof p.html === 'string' && p.html) return stripHtml(p.html);
  return null;
}

function Row({ row, node, senders, canEdit, onSaved }: { row: QueuedActionRow; node: GraphNode; senders: Sender[]; canEdit: boolean; onSaved: () => void }) {
  const toast = useToast();
  const current = queuedText(row.payload);
  const hasSubject = node.type === 'send_email' || node.type === 'send_inmail';
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(current ?? '');
  const [subject, setSubject] = useState<string>(typeof row.payload?.subject === 'string' ? row.payload.subject : '');
  const [busy, setBusy] = useState(false);
  const limit = TEXT_LIMIT[node.type as string];
  const isVoice = !!row.payload?.voice;
  const sender = senders.find((s) => s.id === row.sender_id);

  const save = async () => {
    setBusy(true);
    try {
      const ok = await rpc<boolean>('set_action_text', { p_action: row.action_id, p_text: text, p_subject: hasSubject ? subject : null });
      if (ok) { toast.show('Queued text updated'); setEditing(false); onSaved(); }
      else { toast.show('This one is already being sent, so it was left as it is', 'error'); setEditing(false); onSaved(); }
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {row.lead_id ? <Link href={`/outreach/leads/${row.lead_id}`} className="font-medium text-gray-900 hover:text-indigo-700">{row.lead_name || 'Lead'}</Link> : <span className="font-medium text-gray-900">{row.lead_name || 'Lead'}</span>}
        <span className="text-xs text-gray-500">via {sender ? senderName(sender) : 'sender'}</span>
        <span className="text-xs text-gray-500 inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtDate(row.scheduled_for)}</span>
        {row.variant_id && <Badge tone="indigo">Variant {row.variant_id}</Badge>}
        {row.payload?.edited_by && <Badge tone="amber">Edited by hand</Badge>}
        {canEdit && !editing && !isVoice && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => { setText(current ?? ''); setEditing(true); }}><Pencil className="w-3.5 h-3.5" /> Edit</Button>}
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          {hasSubject && <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />}
          <Textarea label="Text for this lead" value={text} onChange={(e) => setText(e.target.value)} rows={5} autoFocus counter={limit ? { max: limit, value: text.length } : undefined} hint="Sent exactly as written here. Variables are not filled in again." />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
            <Button size="sm" loading={busy} disabled={!text.trim() || (!!limit && text.length > limit)} onClick={save}>Save text</Button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 text-sm text-gray-700 whitespace-pre-wrap break-words bg-gray-50 rounded-lg px-3 py-2">
          {hasSubject && typeof row.payload?.subject === 'string' && row.payload.subject && <span className="block text-xs font-medium text-gray-500 mb-1">Subject: {row.payload.subject}</span>}
          {isVoice ? <span className="text-gray-500">Voice note. The sender's recorded clip is used.</span> : current ?? <span className="text-gray-500">Not written yet. It is filled in from the live step text when it sends.</span>}
        </div>
      )}
      {toast.node}
    </li>
  );
}

export default function QueuedNotice({ sequenceId, node, live, canManage, senders }: { sequenceId: string; node: GraphNode; live: boolean; canManage: boolean; senders: Sender[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const texty = isTextStep(node);
  const delay = isDelayStep(node);
  const queuedQ = useQueuedActions(sequenceId, node.id, live && canManage && texty);
  const waitingQ = useWaitingInDelay(sequenceId, node.id, live && delay);
  if (!live || (!texty && !delay)) return null;

  const queued = queuedQ.data?.length ?? 0;
  const waiting = waitingQ.data ?? 0;
  const [one, many] = NOUN[node.type as string] ?? ['message', 'messages'];
  const showQueued = texty && canManage && queued > 0;
  const showWaiting = delay && waiting > 0;
  if (!showQueued && !showWaiting) return null;

  return (
    <div className="border-l border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-1.5 flex-shrink-0" role="status">
      {showQueued && (
        <div className="flex items-start gap-2">
          <MessageSquare className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{fmtInt(queued)}{queued >= 2000 ? '+' : ''} {queued === 1 ? one : many} already queued with the current text</p>
            <p className="opacity-80">When you publish a text change, you choose whether these are updated too.</p>
          </div>
          <button type="button" onClick={() => setOpen(true)} className="font-medium underline underline-offset-2 whitespace-nowrap hover:text-amber-950">View / edit</button>
        </div>
      )}
      {showWaiting && (
        <div className="flex items-start gap-2">
          <Clock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{fmtInt(waiting)} {plural(waiting, 'lead')} {waiting === 1 ? 'is' : 'are'} waiting in this delay</p>
            <p className="opacity-80">When you publish a new delay, you choose whether they are rescheduled.</p>
          </div>
        </div>
      )}

      <Drawer open={open} onClose={() => setOpen(false)} title={`Queued at “${nodeTitle(node)}”`} subtitle={`${fmtInt(queued)} ${queued === 1 ? one : many} waiting to send, soonest first. Edits apply to that lead only.`}>
        {queuedQ.isLoading ? <Spinner /> : queuedQ.error ? <ErrorBox message={parseError(queuedQ.error).message} /> : queued === 0 ? (
          <EmptyState title="Nothing queued" description="Everything planned for this step has been sent." />
        ) : (
          <ul className="divide-y divide-gray-100 -my-3 text-gray-900">
            {(queuedQ.data ?? []).slice(0, 300).map((r) => (
              <Row key={r.action_id} row={r} node={node} senders={senders} canEdit={canManage} onSaved={() => qc.invalidateQueries({ queryKey: sqk.queued(sequenceId, node.id) })} />
            ))}
            {queued > 300 && <li className="py-3 text-xs text-gray-500">Showing the next 300 of {fmtInt(queued)}.</li>}
          </ul>
        )}
      </Drawer>
    </div>
  );
}
