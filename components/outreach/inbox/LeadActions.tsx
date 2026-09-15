'use client';

import { useEffect, useState } from 'react';
import type { Member, Sequence } from '@/lib/outreach/types';
import { Button, Input, Modal, Select, Textarea } from '@/components/outreach/ui';
import { memberLabel } from './hooks';

export interface CreateTaskInput { title: string; body: string | null; due_at: string | null; assigned_to: string | null }

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CreateTaskModal({ open, onClose, onCreate, members, currentUserId, defaultTitle }: {
  open: boolean; onClose: () => void; onCreate: (t: CreateTaskInput) => Promise<void>; members: Member[] | undefined; currentUserId: string | null; defaultTitle: string;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState('');
  const [due, setDue] = useState(() => toLocalInput(new Date(Date.now() + 24 * 3600 * 1000)));
  const [assignee, setAssignee] = useState(currentUserId ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setTitle(defaultTitle); setBody(''); setDue(toLocalInput(new Date(Date.now() + 24 * 3600 * 1000))); setAssignee(currentUserId ?? ''); } }, [open, defaultTitle, currentUserId]);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try { await onCreate({ title: title.trim(), body: body.trim() || null, due_at: due ? new Date(due).toISOString() : null, assigned_to: assignee || null }); onClose(); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Create follow-up task" size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!title.trim()} onClick={submit}>Create task</Button></>}>
      <div className="space-y-3">
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <Textarea label="Notes (optional)" value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[70px]" />
        <Input label="Due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        <Select label="Assign to" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Unassigned</option>
          {members?.map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}{m.user_id === currentUserId ? ' (me)' : ''}</option>)}
        </Select>
      </div>
    </Modal>
  );
}

export function ReenrolModal({ open, onClose, sequences, senderId, senderName, onEnrol }: {
  open: boolean; onClose: () => void; sequences: Sequence[] | undefined; senderId: string; senderName: string; onEnrol: (sequenceId: string, withSender: boolean) => Promise<void>;
}) {
  const active = (sequences ?? []).filter((s) => s.status === 'active');
  const [seqId, setSeqId] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setSeqId(active[0]?.id ?? ''); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  const chosen = active.find((s) => s.id === seqId);
  const inPool = !!chosen && chosen.sender_pool.includes(senderId);
  const submit = async () => {
    if (!chosen) return;
    setBusy(true);
    try { await onEnrol(chosen.id, inPool); onClose(); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Re-enrol in a sequence" size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!chosen} onClick={submit}>Enrol</Button></>}>
      {active.length === 0 ? (
        <p className="text-sm text-gray-600">No active sequences. Activate a sequence first.</p>
      ) : (
        <div className="space-y-3">
          <Select label="Sequence" value={seqId} onChange={(e) => setSeqId(e.target.value)}>
            {active.map((s) => <option key={s.id} value={s.id}>{s.name}{s.sender_pool.includes(senderId) ? '' : ' (sender not in pool)'}</option>)}
          </Select>
          {chosen && (
            <p className="text-xs text-gray-500">
              {inPool
                ? <>The lead will be enrolled with <span className="font-medium text-gray-700">{senderName}</span>, the sender of this conversation.</>
                : <><span className="font-medium text-gray-700">{senderName}</span> is not in this sequence's pool; a sender will be assigned from the pool using the sequence's assignment strategy.</>}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

export function ConfirmModal({ open, onClose, title, message, confirmLabel = 'Confirm', danger, onConfirm }: {
  open: boolean; onClose: () => void; title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>{confirmLabel}</Button></>}>
      <div className="text-sm text-gray-700">{message}</div>
    </Modal>
  );
}
