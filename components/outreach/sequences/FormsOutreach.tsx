'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button, Input, Select, Textarea, Toggle } from '@/components/outreach/ui';
import { TEXT_LIMITS } from '@/lib/outreach/nodes';
import type { GraphNode } from '@/lib/outreach/types';
import TemplateField from './TemplateField';
import { useBuilder } from './context';
import { senderName } from './helpers';

export interface FormProps { node: GraphNode; cfg: Record<string, any>; set: (key: string, value: unknown) => void }

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-gray-500 leading-5">{children}</p>;
}

/** Optional AI drafting brief: when enabled the text is drafted by AI and routed to a review task before sending. */
export function AiBriefField({ cfg, set, what }: { cfg: Record<string, any>; set: FormProps['set']; what: string }) {
  const enabled = !!cfg.ai;
  return (
    <div className="rounded-lg border border-fuchsia-100 bg-fuchsia-50/40 p-2.5 space-y-2">
      <Toggle checked={enabled} onChange={(v) => set('ai', v ? { brief: cfg.ai?.brief ?? '' } : undefined)} label={`Let AI draft the ${what}`} />
      {enabled && (
        <>
          <Textarea label="AI brief" value={cfg.ai?.brief ?? ''} onChange={(e) => set('ai', { ...(cfg.ai ?? {}), brief: e.target.value })} rows={3} placeholder="Who we are, what we offer, tone, what to avoid…" />
          <Note>AI drafts are never sent automatically: each one becomes a review task where a teammate can edit, approve or reject it before it goes out.</Note>
        </>
      )}
    </div>
  );
}

export function SendInviteForm({ cfg, set }: FormProps) {
  const { poolSenders } = useBuilder();
  const hasFree = poolSenders.some((s) => s.provider === 'LINKEDIN' && !s.is_premium);
  const limit = hasFree ? TEXT_LIMITS.invite_note_free : TEXT_LIMITS.invite_note;
  return (
    <div className="space-y-3">
      <TemplateField label="Invitation note" value={cfg.note ?? ''} onChange={(v) => set('note', v)} max={limit} rows={5} placeholder="Hi {{first_name|there}}, …"
        hint={hasFree ? `Limit is 200 characters because a free LinkedIn account is in the pool (300 for premium).` : `Premium accounts allow 300 characters; free accounts only 200.`} />
      <Toggle checked={!!cfg.require_note_for_free} onChange={(v) => set('require_note_for_free', v)} label="Require the note for free accounts" />
      <Note>Free LinkedIn accounts have a small monthly quota of invitations with notes. When off, the note is dropped for free senders once the quota is exhausted instead of failing.</Note>
      <AiBriefField cfg={cfg} set={set} what="note" />
    </div>
  );
}

export function SendMessageForm({ cfg, set }: FormProps) {
  return (
    <div className="space-y-3">
      <TemplateField label="Message" value={cfg.text ?? ''} onChange={(v) => set('text', v)} max={TEXT_LIMITS.message} rows={8} placeholder="Hi {{first_name|there}}, …" />
      <Toggle checked={!!cfg.send_always} onChange={(v) => set('send_always', v)} label="Send even after the lead replied" />
      <Note>Messages require a 1st-degree connection. Without “send always”, the step is skipped when the lead already replied (stop-on-reply).</Note>
      <AiBriefField cfg={cfg} set={set} what="message" />
    </div>
  );
}

export function SendInmailForm({ cfg, set }: FormProps) {
  return (
    <div className="space-y-3">
      <TemplateField label="Subject" value={cfg.subject ?? ''} onChange={(v) => set('subject', v)} max={TEXT_LIMITS.inmail_subject} multiline={false} />
      <TemplateField label="Body" value={cfg.text ?? ''} onChange={(v) => set('text', v)} max={TEXT_LIMITS.inmail_body} rows={7} />
      <Select label="InMail API" value={cfg.api ?? 'classic'} onChange={(e) => set('api', e.target.value)}>
        <option value="classic">Classic</option>
        <option value="sales_navigator">Sales Navigator</option>
        <option value="recruiter">Recruiter</option>
      </Select>
      <Toggle checked={!!cfg.open_profile_only} onChange={(v) => set('open_profile_only', v)} label="Only send to open profiles (free InMail)" />
      <Note>When the sender has no InMail credits the enrollment takes the <span className="font-medium">no credit</span> branch.</Note>
    </div>
  );
}

export function CommentForm({ cfg, set }: FormProps) {
  return (
    <div className="space-y-3">
      <TemplateField label="Comment" value={cfg.text ?? ''} onChange={(v) => set('text', v)} max={TEXT_LIMITS.comment} rows={4} />
      <Input type="number" min={1} max={365} label="Only posts newer than (days)" value={cfg.max_age_days ?? 90} onChange={(e) => set('max_age_days', Math.max(1, Number(e.target.value) || 1))} />
      <AiBriefField cfg={cfg} set={set} what="comment" />
    </div>
  );
}

export function LikeForm({ cfg, set }: FormProps) {
  return (
    <div className="space-y-3">
      <Select label="Reaction" value={cfg.reaction ?? 'like'} onChange={(e) => set('reaction', e.target.value)}>
        {['like', 'celebrate', 'support', 'love', 'insightful', 'funny'].map((r) => <option key={r} value={r}>{r}</option>)}
      </Select>
      <Input type="number" min={1} max={365} label="Only posts newer than (days)" value={cfg.max_age_days ?? 90} onChange={(e) => set('max_age_days', Math.max(1, Number(e.target.value) || 1))} />
      <Note>Skipped silently when the lead has no recent post.</Note>
    </div>
  );
}

export function EndorseForm({ cfg, set }: FormProps) {
  return (
    <div className="space-y-3">
      <Input type="number" min={1} max={5} label="Skills to endorse (1–5)" value={cfg.count ?? 1} onChange={(e) => set('count', Math.min(5, Math.max(1, Number(e.target.value) || 1)))} />
    </div>
  );
}

export function VisitProfileForm({ cfg, set }: FormProps) {
  return (
    <div className="space-y-3">
      <Toggle checked={cfg.notify !== false} onChange={(v) => set('notify', v)} label="Notify the lead of the visit" />
      <Note>A visible profile view is a soft touchpoint before an invitation; silent visits only refresh profile data.</Note>
    </div>
  );
}

const SUBTASK_TYPES = [{ value: 'visit_profile', label: 'Visit profile' }, { value: 'like_latest_post', label: 'Like latest post' }] as const;

export function WaitConnectionForm({ cfg, set }: FormProps) {
  const subtasks: Array<{ type: string }> = Array.isArray(cfg.subtasks) ? cfg.subtasks : [];
  const update = (next: Array<{ type: string }>) => set('subtasks', next);
  return (
    <div className="space-y-3">
      <Input type="number" min={1} max={90} label="Wait window (days)" value={cfg.window_days ?? 14} onChange={(e) => set('window_days', Math.min(90, Math.max(1, Number(e.target.value) || 1)))} hint="Takes the connected branch as soon as the invite is accepted; the no-connect branch when the window ends." />
      <div>
        <div className="text-xs font-medium text-gray-600 mb-1">Subtasks while waiting</div>
        <div className="space-y-1.5">
          {subtasks.length === 0 && <p className="text-xs text-gray-500">None. Light-touch actions (spread across the window, at most one every two days) can nudge the lead to accept.</p>}
          {subtasks.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Select value={s.type} onChange={(e) => update(subtasks.map((x, idx) => (idx === i ? { ...x, type: e.target.value } : x)))} aria-label="Subtask type" className="!py-1 !text-xs flex-1">
                {SUBTASK_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
              <button type="button" onClick={() => update(subtasks.filter((_, idx) => idx !== i))} className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50" aria-label="Remove subtask"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
        <Button type="button" variant="secondary" size="sm" className="mt-2" disabled={subtasks.length >= 5} onClick={() => update([...subtasks, { type: subtasks.length === 0 ? 'visit_profile' : 'like_latest_post' }])}><Plus className="w-3.5 h-3.5" /> Add subtask</Button>
      </div>
    </div>
  );
}

export function WithdrawForm() {
  return <Note>Withdraws the pending invitation sent by this sender. Typically placed on the <span className="font-medium">no connect</span> branch of “Wait for connection”. LinkedIn blocks re-inviting the same person for several weeks after a withdrawal.</Note>;
}

export function SendEmailForm({ cfg, set }: FormProps) {
  const { senders } = useBuilder();
  const mailboxes = senders.filter((s) => s.provider !== 'LINKEDIN');
  return (
    <div className="space-y-3">
      <TemplateField label="Subject" value={cfg.subject ?? ''} onChange={(v) => set('subject', v)} multiline={false} max={200} />
      <TemplateField label="Body (HTML allowed)" value={cfg.html ?? ''} onChange={(v) => set('html', v)} rows={8} placeholder="<p>Hi {{first_name|there}},</p>" />
      <div className="grid grid-cols-2 gap-2">
        <Select label="Send to" value={cfg.to ?? 'any'} onChange={(e) => set('to', e.target.value)}>
          <option value="any">Any email (work first)</option>
          <option value="work">Work email only</option>
          <option value="personal">Personal email only</option>
        </Select>
        <Select label="Threading" value={cfg.thread ?? 'continue'} onChange={(e) => set('thread', e.target.value)}>
          <option value="continue">Continue thread</option>
          <option value="new">New thread</option>
        </Select>
      </div>
      <Select label="Mailbox" value={cfg.mailbox_sender_id ?? ''} onChange={(e) => set('mailbox_sender_id', e.target.value || null)}>
        <option value="">Mailbox from the sender pool</option>
        {mailboxes.map((m) => <option key={m.id} value={m.id}>{senderName(m)} ({m.provider}{m.status !== 'ok' ? `, ${m.status}` : ''})</option>)}
      </Select>
      {mailboxes.length === 0 && <Note>No mailbox connected yet. Connect a Gmail, Outlook or IMAP sender to send emails; activation is blocked until a mailbox is in the pool or selected here.</Note>}
      <Toggle checked={cfg.track !== false} onChange={(v) => set('track', v)} label="Track opens and clicks" />
      <Note>Leads without a matching email take the <span className="font-medium">no email</span> branch; hard bounces take <span className="font-medium">bounced</span>.</Note>
    </div>
  );
}

export function ManualTaskForm({ cfg, set }: FormProps) {
  return (
    <div className="space-y-3">
      <TemplateField label="Task title" value={cfg.title ?? ''} onChange={(v) => set('title', v)} multiline={false} max={200} placeholder="Call {{first_name}} at {{company}}" />
      <TemplateField label="Instructions" value={cfg.body ?? ''} onChange={(v) => set('body', v)} rows={4} />
      <Note>The enrollment waits until a teammate completes the task, then continues to the next step.</Note>
    </div>
  );
}

export function AiDraftApprovalForm({ cfg, set }: FormProps) {
  return (
    <div className="space-y-3">
      <Select label="What to draft" value={cfg.kind ?? 'message'} onChange={(e) => set('kind', e.target.value)}>
        <option value="invite_note">Invitation note</option>
        <option value="message">Message</option>
        <option value="comment">Post comment</option>
      </Select>
      <Textarea label="Brief" value={cfg.brief ?? ''} onChange={(e) => set('brief', e.target.value)} rows={5} placeholder="Context, value proposition, tone, things to avoid… The sequence brief (top bar → settings) is also passed to the model." />
      <Note>Creates a “review AI draft” task with the generated text. Approving sends it through the matching action (with normal budgets); rejecting skips the step.</Note>
    </div>
  );
}

export function EndForm({ cfg, set }: FormProps) {
  return (
    <div className="space-y-3">
      <Input label="Completion reason (optional)" value={cfg.reason ?? ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. no_connect, nurtured" hint="Stored on the enrollment as the exit reason; useful for reporting." />
    </div>
  );
}
