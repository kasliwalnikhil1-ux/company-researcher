'use client';

import { useState } from 'react';
import { Button, Input, Modal, Textarea } from '@/components/outreach/ui';
import { parseError } from '@/lib/outreach/api';
import { REFUSED_LABEL, uniqueEnrollments, useSentAction, type SentAction, type SentItem } from '@/lib/outreach/inboxSent';
import { CancelRunModal } from '../ai/AiComposerPanel';

/** What a Sent row can do, by segment and kind (inbox-replies-sent-PRD.md §4.3). Each calls the existing function. */
export type RowActionKey = 'open_chat' | 'open_lead' | 'copy' | 'edit_text' | 'pause_lead' | 'remove_from_sequence' | 'ai_send_now' | 'ai_edit' | 'ai_cancel' | 'retry' | 'skip' | 'remove_failed';
export interface RowAction { key: RowActionKey; label: string; danger?: boolean; title?: string }

export function rowActions(it: SentItem, can: { write: boolean; manager: boolean }): RowAction[] {
  const out: RowAction[] = [];
  if (it.chat_id) out.push({ key: 'open_chat', label: 'Open conversation' });
  if (it.lead?.id) out.push({ key: 'open_lead', label: it.status === 'bounced' ? 'Open lead (fix the address)' : 'Open lead' });
  if (it.segment === 'sent' && it.body) out.push({ key: 'copy', label: 'Copy text' });
  if (!can.write) return out;
  if (it.src === 'queued' && it.enrollment_id && it.status !== 'sending') {
    if (can.manager) out.push({ key: 'edit_text', label: 'Edit text', title: 'Changes the text of this planned step for this lead only' });
    if (it.enrollment_status !== 'paused') out.push({ key: 'pause_lead', label: 'Pause this lead' });
    out.push({ key: 'remove_from_sequence', label: 'Remove from sequence', danger: true });
  }
  if (it.src === 'ai_hold' && it.status === 'scheduled') {
    out.push({ key: 'ai_send_now', label: 'Send now' });
    if (it.chat_id) out.push({ key: 'ai_edit', label: 'Edit', title: 'Opens the conversation: Edit there cancels the automatic send and puts the text in the box' });
    out.push({ key: 'ai_cancel', label: 'Cancel', danger: true });
  }
  if (it.src === 'failed' && it.recoverable && it.enrollment_id) {
    out.push({ key: 'retry', label: 'Retry' });
    out.push({ key: 'skip', label: 'Skip this step' });
    out.push({ key: 'remove_failed', label: 'Remove from sequence', danger: true });
  }
  return out;
}

/** Plain-language "what to do about it" under a failed or held row. */
export function remedyFor(it: SentItem): string | null {
  const code = it.status_reason ?? '';
  if (it.status === 'bounced') return 'The address is wrong or no longer exists. Fix it on the lead page; the sequence takes the "bounced" branch if it has one.';
  if (it.status === 'held') {
    if (code === 'sender_reconnect') return 'Reconnect the sender on its page. Its leads wait and carry on from where they stopped.';
    if (code === 'sender_paused') return 'A manager resumes the sender on its page.';
    if (code === 'sequence_paused') return 'Resume the sequence (or the lead) and it goes out at the next free slot.';
    if (code === 'allowance_used' || code === 'hourly_allowance') return "Nothing to fix: it goes out in the sender's next slot.";
    return "Nothing to fix: it goes out inside the sender's working hours, when there is a free slot.";
  }
  if (it.status !== 'failed') return null;
  if (!it.enrollment_id) return it.source === 'ai' ? 'Open the conversation to write the reply yourself.' : 'Open the conversation and send it again.';
  if (!it.recoverable) return 'The sequence already moved on for this lead.';
  if (code === 'E_RELATION_REQUIRED' || code.includes('no_connection_with_recipient')) return 'They have not accepted your invitation. Skip this step to move on, or remove them.';
  if (code === 'E_SENDER_NOT_OK' || code.startsWith('401:')) return 'Reconnect the sender, then Retry.';
  if (code.startsWith('429:') || code.startsWith('5')) return 'A temporary problem at the provider. Retry sends it again at the next free slot.';
  if (code === 'E_PAYLOAD_INVALID' || code.includes('payload_invalid')) return 'The step had no usable text for this lead. Fix the step or the lead, then Retry, or Skip it.';
  return 'Retry sends it again at the next free slot; Skip moves the lead to the next step; Remove takes them out of the sequence.';
}

type Pending = { kind: 'pause_lead' | 'remove_from_sequence' | 'retry' | 'skip' | 'remove_failed'; items: SentItem[] } | null;
type ModalRequest = { kind: 'edit_text'; item: SentItem } | { kind: 'ai_cancel'; item: SentItem } | { kind: NonNullable<Pending>['kind']; items: SentItem[] } | null;

/**
 * Runs a row action (or a bulk one) for the Sent list and the detail pane: navigation and copy happen at once, the rest
 * open their modal. Render `modals` once.
 */
export function useSentRowActions({ ws, toast, onOpenChat, onOpenLead }: {
  ws: string; toast: (m: string, kind?: 'error') => void;
  onOpenChat: (it: SentItem) => void; onOpenLead: (it: SentItem) => void;
}) {
  const [request, setRequest] = useState<ModalRequest>(null);
  const act = useSentAction(ws);
  const run = (key: RowActionKey, items: SentItem[]) => {
    const it = items[0];
    if (!it) return;
    switch (key) {
      case 'open_chat': case 'ai_edit': onOpenChat(it); return;
      case 'open_lead': onOpenLead(it); return;
      case 'copy':
        navigator.clipboard?.writeText(it.body ?? it.preview).then(() => toast('Text copied'), () => toast('Could not copy the text', 'error'));
        return;
      case 'ai_send_now':
        act.mutate({ kind: 'ai_send_now', item: it }, { onSuccess: () => toast('AI reply sent'), onError: (e) => toast(parseError(e).message, 'error') });
        return;
      case 'edit_text': setRequest({ kind: 'edit_text', item: it }); return;
      case 'ai_cancel': setRequest({ kind: 'ai_cancel', item: it }); return;
      default: setRequest({ kind: key, items });
    }
  };
  const modals = <SentActionModals ws={ws} request={request} onClose={() => setRequest(null)} onDone={(m) => toast(m)} onError={(m) => toast(m, 'error')} />;
  return { run, modals, busy: act.isPending };
}

const CONFIRM: Record<NonNullable<Pending>['kind'], { title: string; verb: string; text: string; danger?: boolean }> = {
  pause_lead: { title: 'Pause these leads?', verb: 'Pause', text: 'Their next steps wait until someone resumes them. Nothing already sent changes.' },
  remove_from_sequence: { title: 'Remove from the sequence?', verb: 'Remove', text: 'They leave the sequence: their planned steps are cancelled. Conversations and history stay.', danger: true },
  retry: { title: 'Retry these steps?', verb: 'Retry', text: 'Each lead goes back to the failed step; it is sent again at the next free slot within the usual limits.' },
  skip: { title: 'Skip the failed step?', verb: 'Skip', text: 'Each lead moves on to the step after the one that failed.' },
  remove_failed: { title: 'Remove from the sequence?', verb: 'Remove', text: 'They leave the sequence for good. Conversations and history stay.', danger: true },
};

/**
 * The modals behind the row and bulk actions: Edit text, the confirmation with who is affected (lead-level actions,
 * single or bulk), and the AI cancel reason. `request` opens one; `onDone` gets a short result line for a toast.
 */
export function SentActionModals({ ws, request, onClose, onDone, onError }: {
  ws: string;
  request: ModalRequest;
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const act = useSentAction(ws);

  const run = (a: SentAction, okText: (done: number) => string) => act.mutate(a, {
    onSuccess: (r) => {
      const refused = r.refused.length ? ` ${r.refused.length} not changed (${[...new Set(r.refused.map((x) => REFUSED_LABEL[x.reason] ?? x.reason))].join(', ')}).` : '';
      onDone(okText(r.done) + refused);
      onClose();
    },
    onError: (e) => onError(parseError(e).message),
  });

  if (!request) return null;
  if (request.kind === 'edit_text') return <EditTextModal key={request.item.id} it={request.item} busy={act.isPending} onClose={onClose} onSave={(text, subject) => run({ kind: 'edit_text', item: request.item, text, subject }, () => 'Planned text updated')} />;
  if (request.kind === 'ai_cancel') {
    const it = request.item;
    return <CancelRunModal open onClose={onClose} busy={act.isPending} onConfirm={(reason, note) => run({ kind: 'ai_cancel', item: it, reason, note }, () => 'AI reply cancelled')} />;
  }
  const c = CONFIRM[request.kind];
  const leads = uniqueEnrollments(request.items).map((id) => request.items.find((i) => i.enrollment_id === id)!);
  const noLead = request.items.length - request.items.filter((i) => i.enrollment_id).length;
  return (
    <Modal open onClose={onClose} title={c.title} size="sm" footer={<>
      <Button variant="secondary" onClick={onClose}>Keep as is</Button>
      <Button variant={c.danger ? 'danger' : 'primary'} loading={act.isPending} disabled={!leads.length}
        onClick={() => run({ kind: request.kind, items: request.items }, (n) => `${c.verb === 'Pause' ? 'Paused' : c.verb === 'Remove' ? 'Removed' : c.verb === 'Retry' ? 'Retrying' : 'Skipped'} ${n} lead${n === 1 ? '' : 's'}`)}>
        {c.verb} {leads.length} lead{leads.length === 1 ? '' : 's'}
      </Button>
    </>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">{c.text}</p>
        <ul className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm">
          {leads.slice(0, 50).map((i) => (
            <li key={i.enrollment_id} className="px-3 py-1.5 flex items-center gap-2 min-w-0">
              <span className="font-medium text-gray-900 truncate">{i.lead?.name ?? 'Lead'}</span>
              {i.lead?.company && <span className="text-gray-500 truncate">· {i.lead.company}</span>}
              {i.sequence?.name && <span className="ml-auto text-xs text-gray-400 truncate">{i.sequence.name}</span>}
            </li>
          ))}
        </ul>
        {leads.length > 50 && <p className="text-xs text-gray-500">…and {leads.length - 50} more.</p>}
        {noLead > 0 && <p className="text-xs text-gray-500">{noLead} selected row{noLead === 1 ? ' is' : 's are'} not part of a sequence and {noLead === 1 ? 'is' : 'are'} left alone.</p>}
      </div>
    </Modal>
  );
}

/** Edit the planned text of one queued step (outreach_set_action_text; managers). */
function EditTextModal({ it, busy, onClose, onSave }: { it: SentItem; busy: boolean; onClose: () => void; onSave: (text: string, subject: string | null) => void }) {
  const [text, setText] = useState(it.body ?? '');
  const [subject, setSubject] = useState(it.subject ?? '');
  const email = it.type === 'email';
  const limit = it.type === 'connection_request' ? 300 : it.type === 'inmail' ? 1900 : email ? 100000 : 8000;
  return (
    <Modal open onClose={onClose} title={`Edit the planned ${it.type === 'connection_request' ? 'note' : 'text'} for ${it.lead?.name ?? 'this lead'}`} size="lg" footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={busy} disabled={!text.trim() || text.length > limit} onClick={() => onSave(text, email ? subject : null)}>Save</Button>
    </>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">Changes this step for this lead only; the sequence keeps its own text. It still goes out at its planned time.</p>
        {email && <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={500} />}
        <Textarea label="Text" value={text} onChange={(e) => setText(e.target.value)} rows={8} className="min-h-[160px]" />
        <div className={text.length > limit ? 'text-xs text-rose-600' : 'text-xs text-gray-400'}>{text.length.toLocaleString()} / {limit.toLocaleString()} characters</div>
      </div>
    </Modal>
  );
}
