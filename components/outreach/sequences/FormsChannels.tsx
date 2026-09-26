'use client';

// Forms for the Instagram and WhatsApp steps (docs/outreach/CHANNELS-BUILD-CONTRACT.md §3): follow / unfollow, like recent
// posts, comment on a post, wait for follow-back, check the number, check consent, wait for a reply, switch channel.
import { Input, Select } from '@/components/outreach/ui';
import { CONSENT_BASIS_LABELS, TEXT_LIMITS } from '@/lib/outreach/nodes';
import { PITCH_RE } from '@/lib/outreach/graph';
import { CHANNEL_PROVIDERS, CONSENT_BASES, type ConsentBasis, type Provider } from '@/lib/outreach/types';
import { PROVIDER_LABELS } from '@/components/outreach/senders/helpers';
import TemplateField from './TemplateField';
import { Callout, Note } from './FormsShared';
import { useBuilder } from './context';
import { AiBriefField, type FormProps } from './FormsOutreach';

const channelName = (p: Provider) => (PROVIDER_LABELS as Partial<Record<Provider, string>>)[p] ?? p;
const clampInt = (v: string, min: number, max: number, fallback: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };

export function FollowForm() {
  return (
    <div className="space-y-2">
      <Note>Follows the lead from the sender’s Instagram account. It is the usual first touch there: the lead sees the follow, and a follow-back opens the door to a message.</Note>
      <Note>Every Instagram action counts against the account’s 10 actions per hour and its daily allowance. Leads the account already follows are skipped.</Note>
    </div>
  );
}

export function UnfollowForm() {
  return (
    <div className="space-y-2">
      <Note>Stops following the lead from the sender’s Instagram account, for example once the conversation has ended or the lead did not follow back.</Note>
      <Note>Counts as one of the account’s 10 actions per hour. Where unfollowing is not available yet, the step is skipped and the lead moves on.</Note>
    </div>
  );
}

export function LikeRecentPostsForm({ cfg, set }: FormProps) {
  const count = Math.min(3, Math.max(1, Number(cfg.count) || 1));
  return (
    <div className="space-y-3">
      <Input type="number" min={1} max={3} label="Posts to like (1–3)" value={count} onChange={(e) => set('count', clampInt(e.target.value, 1, 3, 2))} hint="Each like is one action of the 10 an Instagram account can do per hour." />
      <Input type="number" min={1} max={365} label="Only posts newer than (days)" value={cfg.max_age_days ?? 60} onChange={(e) => set('max_age_days', clampInt(e.target.value, 1, 365, 60))} />
      <Note>Likes the lead’s most recent posts, newest first. When the lead has fewer recent posts than this, the ones there are get liked and the step moves on. No recent post: the step is skipped.</Note>
    </div>
  );
}

export function CommentPostForm({ cfg, set }: FormProps) {
  const pitch = PITCH_RE.test(String(cfg.text ?? ''));
  return (
    <div className="space-y-3">
      <TemplateField label="Comment" value={cfg.text ?? ''} onChange={(v) => set('text', v)} max={TEXT_LIMITS.ig_comment} rows={4} placeholder="Great point about … Thanks for sharing." />
      {pitch && <Callout tone="warn">This comment reads like a pitch. Instagram comments are public: keep them about their post, not your offer. Save the offer for the message.</Callout>}
      <Input type="number" min={1} max={365} label="Only posts newer than (days)" value={cfg.max_age_days ?? 60} onChange={(e) => set('max_age_days', clampInt(e.target.value, 1, 365, 60))} />
      <Note>A public comment on the lead’s latest post, seen by everyone who reads it. Best kept short and about the post. Skipped when the lead has no recent post or the post does not accept comments.</Note>
      <AiBriefField cfg={cfg} set={set} what="comment" />
    </div>
  );
}

export function WaitFollowBackForm({ cfg, set }: FormProps) {
  return (
    <div className="space-y-3">
      <Input type="number" min={1} max={30} label="Wait window (days)" value={cfg.window_days ?? 5} onChange={(e) => set('window_days', clampInt(e.target.value, 1, 30, 5))} hint="Takes the “followed back” exit as soon as the follow-back is noticed; the “no follow back” exit when the window ends." />
      <Input type="number" min={1} max={3} label="Checks per day (1–3)" value={cfg.poll_budget ?? 2} onChange={(e) => set('poll_budget', clampInt(e.target.value, 1, 3, 2))} hint="How many times a day this sequence may ask the account to check. Each check is one Instagram action." />
      <Note>Follow-backs are detected by reading the account’s own followers list up to three times a day and matching it against the leads waiting here, so one check covers every waiting lead. Detection can therefore lag by up to about 12 hours, and the first message after a follow-back goes out at least two hours later, never instantly.</Note>
    </div>
  );
}

export function CheckIdentifierForm() {
  return (
    <div className="space-y-2">
      <Note>Checks whether the lead’s phone number is on WhatsApp, without starting a chat or sending anything. Numbers that are not on WhatsApp take the <span className="font-medium">invalid</span> exit and are marked so no later step tries them.</Note>
      <Note>Needs a phone number with a country code on the lead (for example +91 98765 43210). Leads without one take the invalid exit too. The check has its own daily allowance and does not count as a new conversation.</Note>
    </div>
  );
}

export function RequireConsentForm({ cfg, set }: FormProps) {
  const bases: ConsentBasis[] = Array.isArray(cfg.bases) ? cfg.bases.filter((b: unknown): b is ConsentBasis => (CONSENT_BASES as string[]).includes(String(b))) : [];
  const toggle = (b: ConsentBasis) => set('bases', bases.includes(b) ? bases.filter((x) => x !== b) : [...bases, b]);
  const attestedOnly = bases.length === 1 && bases[0] === 'imported_attested';
  return (
    <div className="space-y-3">
      <Note>WhatsApp messages only go to people who agreed to hear from you. This step checks the consent recorded on the lead: leads with one take <span className="font-medium">has consent</span>, everyone else <span className="font-medium">no consent</span>.</Note>
      <fieldset className="rounded-lg border border-gray-200 p-2.5 space-y-1.5">
        <legend className="px-1 text-xs font-medium text-gray-600">Accepted ways of agreeing</legend>
        {CONSENT_BASES.map((b) => (
          <label key={b} className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
            <input type="checkbox" checked={bases.includes(b)} onChange={() => toggle(b)} className="mt-0.5 rounded border-gray-300 text-indigo-600" />
            <span className={b === 'imported_attested' ? 'text-amber-800' : ''}>{CONSENT_BASIS_LABELS[b]}</span>
          </label>
        ))}
        <p className="text-[11px] text-gray-500 leading-4">{bases.length === 0 ? 'Nothing ticked: any recorded consent counts.' : `Only leads whose consent was recorded ${bases.length === 1 ? 'this way' : 'one of these ways'} continue.`}</p>
      </fieldset>
      {bases.includes('imported_attested') && (
        <Callout tone="warn">{attestedOnly ? 'Only “attested at import” is ticked. ' : ''}Consent attested at import rests on whoever imported the list saying the person agreed. It is the weakest basis and the one reports flag when it makes up too much of your outreach. Prefer people who messaged first, opted in on a form, or shared their number in a conversation.</Callout>
      )}
      <Note>Consent is recorded on the lead (Leads → the lead → Consent), or automatically when the person messages the account first. Withdrawn consent and “stop” replies remove the lead from every WhatsApp sequence.</Note>
    </div>
  );
}

export function WaitForReplyForm({ cfg, set }: FormProps) {
  const hours = Number(cfg.window_hours) || 96;
  return (
    <div className="space-y-3">
      <Input type="number" min={1} max={720} label="Wait for a reply (hours)" value={hours} onChange={(e) => set('window_hours', clampInt(e.target.value, 1, 720, 96))} hint={hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}. Takes “replied” the moment the lead answers; “no reply” when the time is up.` : 'Takes “replied” the moment the lead answers; “no reply” when the time is up.'} />
      <Note>While a lead waits here, a reply moves them down the <span className="font-medium">replied</span> exit instead of stopping the sequence, so you can decide what happens next. A reply at any other step still stops the lead as set under sequence settings.</Note>
      <Note>Put “End” on the replied exit to hand the conversation to the inbox, or carry on with a step that fits an interested lead.</Note>
    </div>
  );
}

export function ChannelSwitchForm({ cfg, set }: FormProps) {
  const { poolSenders } = useBuilder();
  const poolChannels = CHANNEL_PROVIDERS.filter((p) => poolSenders.some((s) => s.provider === p));
  const to: Provider | '' = typeof cfg.to_channel === 'string' && (CHANNEL_PROVIDERS as string[]).includes(cfg.to_channel) ? (cfg.to_channel as Provider) : '';
  const options = poolChannels.length ? poolChannels : CHANNEL_PROVIDERS;
  const missing = !!to && !poolChannels.includes(to);
  return (
    <div className="space-y-3">
      <Select label="Continue on" value={to} onChange={(e) => set('to_channel', e.target.value || undefined)}>
        {!to && <option value="">Choose a channel</option>}
        {options.map((p) => <option key={p} value={p}>{channelName(p)}</option>)}
      </Select>
      {missing && <Callout tone="warn">The sender pool has no {channelName(to)} account. Add one under Senders, or the sequence cannot go live.</Callout>}
      <Note>Moves the lead to the {to ? channelName(to) : 'chosen'} account in the pool and carries on from the next step with it. This needs three things: a verified {to === 'WHATSAPP' ? 'phone number' : to === 'INSTAGRAM' ? 'Instagram handle' : 'profile'} on the lead, an available {to ? channelName(to) : ''} account in the pool that is not already working this lead, and{to === 'WHATSAPP' ? ' a recorded WhatsApp consent' : ', on WhatsApp, a recorded consent'}.</Note>
      <Note>When any of those is missing the lead takes the <span className="font-medium">unavailable</span> exit rather than failing: a lead reachable on only one channel is the normal case. Nothing is sent by this step itself.</Note>
      <Note>The best-working pattern is the compliant one: reach WhatsApp through a reply on LinkedIn that produced a number and a consent, never in parallel with it.</Note>
    </div>
  );
}
