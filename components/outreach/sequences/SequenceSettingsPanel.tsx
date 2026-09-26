'use client';

// Sequence settings (plan items 1, 13, 14): reply scope, hold mode, out-of-office, enrichment and AI-review gates.
// On a running sequence the values travel with the publish call (p_settings); before that they are part of Save.
import { Info } from 'lucide-react';
import { Input, Select, Textarea, Toggle } from '@/components/outreach/ui';
import type { Client } from '@/lib/outreach/types';
import type { Draft } from './draft';
import type { SequenceSettingsExt } from './publishTypes';

const clampInt = (v: string, min: number, max: number, fallback: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{title}</h4>
      {children}
    </section>
  );
}

function Radio({ name, checked, onSelect, title, help }: { name: string; checked: boolean; onSelect: () => void; title: string; help?: string }) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="mt-0.5 text-indigo-600 focus:ring-indigo-500" />
      <span className="min-w-0"><span className="block text-sm text-gray-800">{title}</span>{help && <span className="block text-xs text-gray-500">{help}</span>}</span>
    </label>
  );
}

export default function SequenceSettingsPanel({ draft, clients, onChange, disabled, live }: { draft: Draft; clients: Client[]; onChange: (patch: Partial<Draft>) => void; disabled: boolean; live: boolean }) {
  const s = (draft.settings ?? {}) as SequenceSettingsExt;
  const set = (patch: Partial<SequenceSettingsExt>) => onChange({ settings: { ...s, ...patch } as Draft['settings'] });
  const stop = s.stop_on_reply !== false;
  const scope = s.stop_on_reply_scope === 'sender' ? 'sender' : 'lead';
  const onReply = s.on_reply === 'hold' ? 'hold' : 'exit';
  const resumeOoo = s.resume_after_ooo !== false;

  return (
    <fieldset disabled={disabled} className="space-y-4">
      {live && (
        <p className="flex items-start gap-1.5 text-xs text-gray-600 bg-gray-50 rounded-lg px-2.5 py-2"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-gray-400" /> This sequence has leads. Changes here take effect when you publish.</p>
      )}

      <Section title="AI brief">
        <Textarea label="Brief for AI (context for drafts and checks)" value={draft.brief} onChange={(e) => onChange({ brief: e.target.value })} rows={4} placeholder="Who we are, who we target, the offer, the tone." />
      </Section>

      <Section title="When a lead replies">
        <Toggle checked={stop} onChange={(v) => set({ stop_on_reply: v })} label="Stop the sequence for that lead" disabled={disabled} />
        {stop ? (
          <div className="space-y-2 pl-1">
            <Radio name="reply-scope" checked={scope === 'lead'} onSelect={() => set({ stop_on_reply_scope: 'lead' })} title="Stop this lead everywhere" help="A reply on any channel, to any sender, stops every sequence the lead is in." />
            <Radio name="reply-scope" checked={scope === 'sender'} onSelect={() => set({ stop_on_reply_scope: 'sender' })} title="Only stop the sender they replied to" help="Other senders and mailboxes keep going. Rarely what you want." />
          </div>
        ) : <p className="text-xs text-amber-700">Leads keep getting steps after they reply.</p>}
        <div className="pt-1 space-y-1">
          <Toggle checked={s.channel_independent_continuation === true} onChange={(v) => set({ channel_independent_continuation: v })} label="Keep going on the other channels" disabled={disabled} />
          <p className="text-xs text-gray-500">Off: a reply on any channel stops the lead on every channel. On: only the channel they replied on stops.</p>
          {s.channel_independent_continuation === true && (
            <p className="text-xs text-amber-700">A reply on one channel will not stop this lead on the others, so two accounts can end up talking to the same person at once. Leave this off unless each channel is a separate conversation on purpose.</p>
          )}
        </div>
      </Section>

      {stop && (
        <Section title="After a reply">
          <div className="space-y-2 pl-1">
            <Radio name="on-reply" checked={onReply === 'exit'} onSelect={() => set({ on_reply: 'exit' })} title="Exit the lead" help="The sequence ends for this lead. You carry on in the inbox." />
            <Radio name="on-reply" checked={onReply === 'hold'} onSelect={() => set({ on_reply: 'hold' })} title="Hold for review" help="The lead waits on the attention list. One click resumes the sequence or exits the lead." />
          </div>
          {onReply === 'hold' && (
            <Input type="number" min={1} max={365} label="Exit held leads after (days)" value={s.hold_max_days ?? 30} onChange={(e) => set({ hold_max_days: clampInt(e.target.value, 1, 365, 30) })} hint="Nobody stays held forever. After this many days the lead is exited." />
          )}
        </Section>
      )}

      <Section title="Out-of-office replies">
        <Toggle checked={resumeOoo} onChange={(v) => set({ resume_after_ooo: v })} label="Resume the lead later" disabled={disabled} />
        {resumeOoo
          ? <Input type="number" min={1} max={90} label="Resume after (days)" value={s.ooo_resume_days ?? 7} onChange={(e) => set({ ooo_resume_days: clampInt(e.target.value, 1, 90, 7) })} hint="If the reply names a return date, that date is used instead." />
          : <p className="text-xs text-gray-500">An out-of-office reply ends the sequence like any other reply.</p>}
      </Section>

      <Section title="Before the first step">
        <Toggle checked={!!s.wait_for_enrichment} onChange={(v) => set({ wait_for_enrichment: v })} label="Wait for profile enrichment before the first step" disabled={disabled} />
        <p className="text-xs text-gray-500">Profile details are fetched within the sender's daily profile-view limit. A lead starts anyway after 72 hours.</p>
        <Toggle checked={!!s.hold_for_ai_review} onChange={(v) => set({ hold_for_ai_review: v })} label="Hold leads until AI-written lines are approved" disabled={disabled} />
        <p className="text-xs text-gray-500">Nothing AI-written is sent before a person approves it. With this on, the lead waits instead of using the fallback text.</p>
      </Section>

      <Section title="General">
        <Select label="Client" value={draft.clientId ?? ''} onChange={(e) => onChange({ clientId: e.target.value || null })}>
          {!draft.clientId && <option value="">No client</option>}
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Input type="number" min={0} max={90} label="Withdraw pending invitations after (days)" value={s.withdraw_after_days ?? 21} onChange={(e) => set({ withdraw_after_days: clampInt(e.target.value, 0, 90, 21) })} hint="0 turns automatic withdrawal off." />
      </Section>
    </fieldset>
  );
}
