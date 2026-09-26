'use client';

import { PenLine, Plus, Trash2 } from 'lucide-react';
import { Button, Input, Select, Textarea, Toggle } from '@/components/outreach/ui';
import { NODE_CATALOG, TEXT_LIMITS, messageTextLimit, syncNodeBranches } from '@/lib/outreach/nodes';
import { CHANNEL_PROVIDERS, type GraphNode, type MessageVariant, type Provider } from '@/lib/outreach/types';
import { PROVIDER_LABELS } from '@/components/outreach/senders/helpers';
import TemplateField from './TemplateField';
import VariantEditor from './VariantEditor';
import { Callout, Note } from './FormsShared';
import { useBuilder } from './context';
import { senderName } from './helpers';

export interface FormProps {
  node: GraphNode;
  cfg: Record<string, any>;
  /** Set one config key (undefined removes it). */
  set: (key: string, value: unknown) => void;
  /** Set several config keys in ONE change. Calling `set` twice in a row loses the first value. */
  patch: (values: Record<string, unknown>) => void;
  /** Replace the whole node: for forms that also change exits (node.branches). */
  update: (next: GraphNode) => void;
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

export function SendInviteForm({ node, cfg, set, patch }: FormProps) {
  const { poolSenders } = useBuilder();
  const hasFree = poolSenders.some((s) => s.provider === 'LINKEDIN' && !s.is_premium);
  const limit = hasFree ? TEXT_LIMITS.invite_note_free : TEXT_LIMITS.invite_note;
  return (
    <div className="space-y-3">
      <VariantEditor node={node} cfg={cfg} patch={patch} textKey="note" label="Invitation note" max={limit} rows={5} placeholder="Hi {{first_name|there}}, …"
        hint={hasFree ? 'The limit is 200 characters because a free LinkedIn account is in the pool. Premium accounts allow 300.' : 'Premium accounts allow 300 characters. Free accounts allow 200.'} />
      <Toggle checked={!!cfg.require_note_for_free} onChange={(v) => set('require_note_for_free', v)} label="Require the note for free accounts" />
      <Note>Free LinkedIn accounts have a small monthly quota of invitations with notes. When off, the note is dropped for free senders once the quota is exhausted instead of failing.</Note>
      <AiBriefField cfg={cfg} set={set} what="note" />
    </div>
  );
}

const channelName = (p: Provider) => (PROVIDER_LABELS as Partial<Record<Provider, string>>)[p] ?? p;

/** The channels of the pool a message / voice-note step can go out on, and the one it is pinned to (empty = the account working the lead). */
export function useMessageChannels(node: GraphNode, cfg: FormProps['cfg']): { poolChannels: Provider[]; channel: Provider | ''; effective: Provider[] } {
  const { poolSenders } = useBuilder();
  const supported = NODE_CATALOG[node.type]?.channels ?? CHANNEL_PROVIDERS;
  const poolChannels = CHANNEL_PROVIDERS.filter((p) => supported.includes(p) && poolSenders.some((s) => s.provider === p));
  const channel: Provider | '' = typeof cfg.channel === 'string' && (supported as string[]).includes(cfg.channel) ? (cfg.channel as Provider) : '';
  const effective = channel ? [channel] : poolChannels.length ? poolChannels : ['LINKEDIN' as Provider];
  return { poolChannels, channel, effective };
}

/**
 * Channel choice and the "new conversation" switch shared by "Send message" and "Send voice note". The channel select only
 * appears when the pool has more than one channel; turning new conversations off adds the "no chat" exit to the step.
 */
export function MessageChannelFields({ node, cfg, patch, update, what = 'message' }: Pick<FormProps, 'node' | 'cfg' | 'patch' | 'update'> & { what?: string }) {
  const { poolChannels, channel, effective } = useMessageChannels(node, cfg);
  const newChat = cfg.new_chat_allowed !== false;
  const setNewChat = (v: boolean) => update(syncNodeBranches({ ...node, config: { ...cfg, new_chat_allowed: v } }));
  const onWhatsApp = effective.includes('WHATSAPP');
  return (
    <div className="space-y-3">
      {poolChannels.length > 1 && (
        <Select label="Channel" value={channel} onChange={(e) => patch({ channel: e.target.value || undefined })}>
          <option value="">The account working the lead ({poolChannels.map(channelName).join(' or ')})</option>
          {poolChannels.map((p) => <option key={p} value={p}>{channelName(p)} only</option>)}
        </Select>
      )}
      <Toggle checked={newChat} onChange={setNewChat} label="Start a new conversation if none exists yet" />
      <Note>
        A new conversation is counted separately from {what}s in an existing one, with its own daily allowance{onWhatsApp ? ', and on WhatsApp it only happens for leads with a recorded consent' : ''}.
        {newChat ? '' : ' Leads with no conversation yet take the “no chat” exit, or skip this step when nothing is connected there.'}
      </Note>
    </div>
  );
}

export function SendMessageForm({ node, cfg, set, patch, update }: FormProps) {
  const { effective } = useMessageChannels(node, cfg);
  const max = messageTextLimit(effective);
  const owner = effective.includes('INSTAGRAM') ? 'Instagram' : effective.includes('WHATSAPP') ? 'WhatsApp' : 'LinkedIn';
  const onLinkedIn = effective.includes('LINKEDIN');
  return (
    <div className="space-y-3">
      <MessageChannelFields node={node} cfg={cfg} patch={patch} update={update} />
      <VariantEditor node={node} cfg={cfg} patch={patch} textKey="text" label="Message" max={max} rows={8} placeholder="Hi {{first_name|there}}, …"
        hint={max < TEXT_LIMITS.message ? `${owner} allows ${max.toLocaleString('en-US')} characters.` : undefined} />
      <Toggle checked={!!cfg.send_always} onChange={(v) => set('send_always', v)} label="Send even after the lead replied" />
      <Note>{onLinkedIn ? 'On LinkedIn, messages require a 1st-degree connection. ' : ''}Without “send always”, the step is skipped when the lead already replied (stop-on-reply).</Note>
      <AiBriefField cfg={cfg} set={set} what="message" />
    </div>
  );
}

export function SendInmailForm({ node, cfg, set, patch }: FormProps) {
  return (
    <div className="space-y-3">
      <VariantEditor node={node} cfg={cfg} patch={patch} textKey="text" label="Body" max={TEXT_LIMITS.inmail_body} rows={7} subject={{ label: 'Subject', max: TEXT_LIMITS.inmail_subject }} />
      <Select label="InMail API" value={cfg.api ?? 'classic'} onChange={(e) => set('api', e.target.value)}>
        <option value="classic">Classic</option>
        <option value="sales_navigator">Sales Navigator</option>
        <option value="recruiter">Recruiter</option>
      </Select>
      <Toggle checked={!!cfg.open_profile_only} onChange={(v) => set('open_profile_only', v)} label="Only send to open profiles (free InMail)" />
      <Note>When the sender has no InMail credits left, the lead takes the <span className="font-medium">no credit</span> branch.</Note>
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

type MailboxMode = 'own' | 'one' | 'pool';
const MAILBOX_MODES: Array<{ value: MailboxMode; title: string; help: string }> = [
  { value: 'own', title: 'The sender’s own mailboxes', help: 'The mailboxes linked to the lead’s LinkedIn sender. If there are none, the mailboxes in the sequence pool.' },
  { value: 'one', title: 'One mailbox', help: 'Every email of this step leaves from the same mailbox.' },
  { value: 'pool', title: 'A pool of mailboxes', help: 'Split evenly across the mailboxes you tick.' },
];

export function SendEmailForm({ node, cfg, set, patch }: FormProps) {
  const { senders } = useBuilder();
  const mailboxes = senders.filter((s) => s.provider !== 'LINKEDIN');
  const pool: string[] = Array.isArray(cfg.mailbox_pool) ? cfg.mailbox_pool : [];
  const mode: MailboxMode = cfg.mailbox_sender_id ? 'one' : Array.isArray(cfg.mailbox_pool) ? 'pool' : 'own';
  const setMode = (m: MailboxMode) => {
    if (m === 'own') patch({ mailbox_sender_id: null, mailbox_pool: undefined });
    else if (m === 'one') patch({ mailbox_sender_id: cfg.mailbox_sender_id ?? mailboxes[0]?.id ?? null, mailbox_pool: undefined });
    else patch({ mailbox_sender_id: null, mailbox_pool: pool });
  };
  const togglePool = (id: string) => patch({ mailbox_sender_id: null, mailbox_pool: pool.includes(id) ? pool.filter((x) => x !== id) : [...pool, id] });
  const mailboxLabel = (m: (typeof mailboxes)[number]) => `${senderName(m)} (${m.provider}${m.status !== 'ok' ? `, ${m.status}` : ''})`;

  const variants: MessageVariant[] = Array.isArray(cfg.variants) ? cfg.variants : [];
  const bodies: string[] = variants.length > 0 ? variants.map((v) => v.html ?? '') : [cfg.html ?? ''];
  const written = bodies.filter((b) => b.trim() !== '');
  const noUnsubscribe = written.some((b) => !b.includes('unsubscribe_link'));
  const hasSignature = written.length > 0 && written.every((b) => b.includes('sender.signature'));
  /** Append a snippet to the body (to every variant when the step is an A/B test) unless it is already there. */
  const addToBodies = (snippet: string, marker: string) => {
    const add = (b: string) => (b.includes(marker) ? b : `${b}${b && !b.endsWith('\n') ? '\n' : ''}${snippet}`);
    if (variants.length > 0) { const next = variants.map((v) => ({ ...v, html: add(v.html ?? '') })); patch({ variants: next, html: next[0].html }); }
    else patch({ html: add(cfg.html ?? '') });
  };

  return (
    <div className="space-y-3">
      <VariantEditor node={node} cfg={cfg} patch={patch} textKey="html" label="Body (HTML allowed)" rows={8} placeholder="<p>Hi {{first_name|there}},</p>" channel="email" subject={{ label: 'Subject', max: 200 }} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="secondary" size="sm" disabled={hasSignature} onClick={() => addToBodies('{{sender.signature}}', 'sender.signature')} title="Adds {{sender.signature}}: the signature saved on the mailbox that sends the email"><PenLine className="w-3.5 h-3.5" aria-hidden /> Insert signature</Button>
        {noUnsubscribe && <Button type="button" variant="secondary" size="sm" onClick={() => addToBodies('<p><a href="{{unsubscribe_link}}">Unsubscribe</a></p>', 'unsubscribe_link')}>Add unsubscribe link</Button>}
      </div>
      {noUnsubscribe && <Callout tone="warn">This email has no <span className="font-mono">{'{{unsubscribe_link}}'}</span>. Cold email with no way to opt out hurts deliverability and breaks anti-spam rules in most countries.{variants.length > 0 ? ' Add the link to every variant.' : ''}</Callout>}
      <Note>Signatures are saved per mailbox under Senders. A mailbox without one leaves the spot empty. The unsubscribe and booking links are never rewritten for click tracking.</Note>
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
      <fieldset className="rounded-lg border border-gray-200 p-2.5 space-y-2">
        <legend className="px-1 text-xs font-medium text-gray-600">Send from</legend>
        {MAILBOX_MODES.map((m) => (
          <label key={m.value} className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
            <input type="radio" name={`${node.id}-mailbox-mode`} checked={mode === m.value} onChange={() => setMode(m.value)} className="mt-0.5 text-indigo-600" />
            <span><span className="font-medium">{m.title}</span><span className="block text-gray-500 leading-4">{m.help}</span></span>
          </label>
        ))}
        {mode === 'one' && (
          <Select aria-label="Mailbox" value={cfg.mailbox_sender_id ?? ''} onChange={(e) => patch({ mailbox_sender_id: e.target.value || null, mailbox_pool: undefined })} className="!py-1.5 !text-xs">
            {mailboxes.length === 0 && <option value="">No mailbox connected</option>}
            {mailboxes.map((m) => <option key={m.id} value={m.id}>{mailboxLabel(m)}</option>)}
          </Select>
        )}
        {mode === 'pool' && (
          <div className="space-y-1 pl-5">
            {mailboxes.length === 0 && <p className="text-xs text-gray-500">No mailbox connected.</p>}
            {mailboxes.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-xs text-gray-700">
                <input type="checkbox" checked={pool.includes(m.id)} onChange={() => togglePool(m.id)} className="rounded border-gray-300 text-indigo-600" />
                <span className="truncate">{mailboxLabel(m)}</span>
              </label>
            ))}
            {mailboxes.length > 0 && pool.length === 0 && <p className="text-xs text-amber-700">Tick at least one mailbox. With none ticked, the sender&apos;s own mailboxes are used.</p>}
          </div>
        )}
        <p className="text-[11px] text-gray-500 leading-4">A contact who was emailed before always gets the same mailbox again.</p>
      </fieldset>
      {mailboxes.length === 0 && <Note>No mailbox connected yet. Connect a Gmail, Outlook or IMAP sender to send emails. The sequence cannot go live until a mailbox is in the pool or chosen here.</Note>}
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
      <Note>The lead waits here until a teammate marks the task done, then moves on to the next step.</Note>
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
      <Input label="Completion reason (optional)" value={cfg.reason ?? ''} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. no_connect, nurtured" hint="Saved with the lead as the reason the sequence ended; handy in reports." />
    </div>
  );
}
