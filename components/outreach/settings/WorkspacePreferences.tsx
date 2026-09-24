'use client';

import { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { Button, Card, Input, SearchableSelect, useToast } from '@/components/outreach/ui';
import { timezoneChoices } from '@/components/outreach/senders/helpers';
import { SettingRow, Switch } from './shared';
import { CURRENCIES, isValidTimezone, nowIn, saveWorkspaceSettings, timezoneOptions } from './workspaceSettings';

/** Timezone, currency and the default sender cost: the three values every report reads. */
export function RegionalCard() {
  const { workspace, isOwner, canWrite, refresh } = useWorkspace();
  const toast = useToast();
  const settings = (workspace?.settings ?? {}) as Record<string, unknown>;
  const saved = useMemo(() => ({
    timezone: typeof settings.timezone === 'string' && settings.timezone ? settings.timezone : 'UTC',
    currency: typeof settings.currency === 'string' && settings.currency ? settings.currency : 'USD',
    cost: settings.sender_monthly_cost == null || settings.sender_monthly_cost === '' ? '' : String(settings.sender_monthly_cost),
  }), [settings.timezone, settings.currency, settings.sender_monthly_cost]);
  const [form, setForm] = useState(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(saved), [saved]);

  const zones = useMemo(() => timezoneChoices(timezoneOptions(saved.timezone)), [saved.timezone]);
  const costNum = form.cost.trim() === '' ? null : Number(form.cost);
  const costError = costNum != null && (!Number.isFinite(costNum) || costNum < 0 || costNum > 100000) ? 'Enter a number between 0 and 100,000' : undefined;
  const tzError = !isValidTimezone(form.timezone) ? 'Unknown timezone' : undefined;
  const dirty = form.timezone !== saved.timezone || form.currency !== saved.currency || form.cost.trim() !== saved.cost;
  const editable = isOwner && canWrite;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace || costError || tzError || !dirty) return;
    setBusy(true);
    try {
      await saveWorkspaceSettings(workspace.id, { timezone: form.timezone, currency: form.currency, sender_monthly_cost: costNum });
      await refresh();
      toast.show('Saved. Reports now use these values.');
    } catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title="Timezone and money">
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <SearchableSelect label="Timezone" value={form.timezone} onChange={(tz) => setForm({ ...form, timezone: tz })} options={zones} disabled={!editable}
              searchPlaceholder="Search city, region or GMT offset…" error={tzError} hint={`Reports and "today" use this timezone. It is ${nowIn(form.timezone)} there now.`} />
          </div>
          <div>
            <SearchableSelect label="Currency" value={form.currency} onChange={(c) => setForm({ ...form, currency: c })} options={CURRENCIES} disabled={!editable}
              searchPlaceholder="Search currency code…" hint="Used for deal values and the cost report." />
          </div>
          <Input label={`Default monthly cost per sender (${form.currency})`} inputMode="decimal" placeholder="e.g. 99" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} error={costError}
            hint="Covers the seat, LinkedIn plan and tools. A sender can carry its own cost; this fills the gaps in the cost report." disabled={!editable} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-400">{editable ? 'Senders keep their own timezone for sending hours. This one is only for counting.' : 'Only the workspace owner can change these.'}</span>
          {editable && <Button type="submit" loading={busy} disabled={!dirty || !!costError || !!tzError}><Save className="w-4 h-4" /> Save</Button>}
        </div>
      </form>
      {toast.node}
    </Card>
  );
}

interface ToggleDef { key: string; label: string; description: React.ReactNode; defaultValue: boolean }

const TOGGLES: ToggleDef[] = [
  { key: 'auto_stage_interested', defaultValue: true, label: 'Move a lead to the Interested stage when a reply is classified interested',
    description: 'Uses the pipeline stage whose kind is "Interested". A lead never moves backwards: someone already at Meeting or Won stays there.' },
  { key: 'enrich_on_import', defaultValue: false, label: 'Enrich imported leads automatically',
    description: <>Fetches the full LinkedIn profile of new leads in the background. It only spends leftover profile views, never more than 30% of a sender&apos;s daily allowance, and never on a sender at warm-up level 0 or 1. Sequences always come first.</> },
  { key: 'track_replies', defaultValue: false, label: 'Track opens and clicks on manual replies',
    description: 'Off by default. A one-to-one reply does not need a tracking pixel, and it can hurt deliverability. Sequence emails are tracked either way. A mailbox can override this in its own settings.' },
  { key: 'create_leads_from_inbound', defaultValue: true, label: 'Create leads from inbound messages',
    description: 'When someone who is not yet a lead messages one of your senders, a lead is created so the conversation shows up in the inbox with a profile.' },
  { key: 'recruiter_enabled', defaultValue: false, label: 'Recruiter features',
    description: 'Lets the connect wizard keep LinkedIn Recruiter on for senders with a Recruiter seat. Off by default because Recruiter automation carries extra risk.' },
  { key: 'cookie_mode_opt_in', defaultValue: true, label: 'Cookie-mode opt-in',
    description: 'Lets the Chrome extension keep senders connected by syncing their LinkedIn session cookie. Cookies are encrypted at rest and every access is logged.' },
];

export function BehaviourCard() {
  const { workspace, isOwner, canWrite, refresh } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const settings = (workspace?.settings ?? {}) as Record<string, unknown>;
  const editable = isOwner && canWrite;

  async function set(key: string, value: boolean) {
    if (!workspace) return;
    setBusy(key);
    try { await saveWorkspaceSettings(workspace.id, { [key]: value }); await refresh(); toast.show('Setting saved.'); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  return (
    <Card title="Behaviour">
      <div className="divide-y divide-gray-100">
        {TOGGLES.map((t) => {
          const value = typeof settings[t.key] === 'boolean' ? (settings[t.key] as boolean) : t.defaultValue;
          return <SettingRow key={t.key} title={t.label} description={t.description} control={<Switch label={t.label} checked={value} onChange={(v) => set(t.key, v)} disabled={!editable || busy === t.key} />} />;
        })}
      </div>
      <div className="text-xs text-gray-400 mt-2">
        AI-written text is never sent on its own: every AI line and draft waits for a person to approve it.
        {!isOwner && ' Only the workspace owner can change these settings.'}
      </div>
      {toast.node}
    </Card>
  );
}
