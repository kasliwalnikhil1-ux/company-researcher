'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { parseError } from '@/lib/outreach/api';
import { MODE_LABEL, useSetReplyPolicy, type PolicyFields, type PolicyRow, type PolicyScope, type ReplyMode } from '@/lib/outreach/aiReplies';
import { Button, ErrorBox, Modal, Select, Textarea } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { SCOPE_LABEL, countriesText, secToMin } from '../format';
import { diffPatch, fieldsFromForm, formFromFields, rowFields, validate, type PolicyForm } from './policyForm';
import { ClearButton, CountryChips, InheritField } from './PolicyFields';

export interface PolicyTarget { scope: PolicyScope; scopeId: string | null; label: string }

/**
 * Edit one reply-policy row. Mount with a `key` per target so the form starts from the saved row.
 * Empty fields inherit (`inherited` holds what they fall back to). Members see it read-only.
 */
export default function PolicyEditor({ ws, target, row, inherited, inheritedFrom, canEdit, onClose, notify }: {
  ws: string; target: PolicyTarget; row: PolicyRow | null; inherited: PolicyFields; inheritedFrom: string;
  canEdit: boolean; onClose: () => void; notify: (m: string, t?: 'success' | 'error') => void;
}) {
  const saved = useMemo(() => rowFields(row), [row]);
  const [form, setForm] = useState<PolicyForm>(() => formFromFields(saved));
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const save = useSetReplyPolicy(ws);

  const set = <K extends keyof PolicyForm>(k: K, v: PolicyForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const errors = validate(form, inherited);
  const next = fieldsFromForm(form, saved);
  const patch = diffPatch(saved, next);
  const dirty = Object.keys(patch).length > 0;
  const reEnabling = !!row?.downgraded_at && patch.mode === 'autopilot';
  const noteMissing = reEnabling && note.trim() === '';
  const hasErrors = Object.keys(errors).length > 0;
  const isWs = target.scope === 'workspace';
  const inh = (v: string | number | null | undefined, unit = '') => (v == null || v === '' ? 'Not set' : `${inheritedFrom === 'default' ? 'Default' : 'Inherits'}: ${v}${unit}`);

  async function submit() {
    setTried(true);
    if (hasErrors || noteMissing || !dirty) return;
    try {
      await save.mutateAsync({ scope: target.scope, scopeId: target.scopeId, patch, note: reEnabling ? note.trim() : null });
      notify(`${target.label} policy saved`);
      onClose();
    } catch (e) { notify(parseError(e).message, 'error'); }
  }

  const title = `${SCOPE_LABEL[target.scope]}${isWs ? ' policy' : ` · ${target.label}`}`;
  return (
    <Modal open onClose={onClose} size="lg" title={title}
      footer={canEdit ? (
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending} disabled={!dirty || (tried && (hasErrors || noteMissing))}>Save</Button>
        </>
      ) : <Button variant="secondary" onClick={onClose}>Close</Button>}>
      <fieldset disabled={!canEdit || save.isPending} className="space-y-5">
        <p className="text-xs text-gray-500">
          Empty fields inherit {isWs ? 'the platform default' : 'from the workspace policy (or a more specific client, sender or sequence setting)'}. Most specific wins: chat → sequence → sender → client → workspace.
        </p>

        {row?.downgraded_at && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            Autopilot was switched back to Draft automatically: {row.downgrade_reason || 'too many held replies were cancelled or edited'}.
            Turning autopilot on again needs a short note on what you changed.
          </div>
        )}

        <div className="flex items-end gap-1.5">
          <div className="flex-1">
            <Select label="Mode" value={form.mode} onChange={(e) => set('mode', e.target.value as ReplyMode | '')}>
              <option value="">{isWs ? `Default (${MODE_LABEL[(inherited.mode ?? 'draft') as ReplyMode]})` : `Inherit (${inherited.mode ? MODE_LABEL[inherited.mode] : 'Draft'})`}</option>
              {(['off', 'draft', 'autopilot'] as ReplyMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </Select>
          </div>
          <ClearButton show={form.mode !== ''} onClick={() => set('mode', '')} label="Inherit mode" />
        </div>
        {form.mode === 'autopilot' && (
          <Note tone="indigo">Autopilot only runs for senders whose owner has consented, on a master prompt that has graduated. Everything else keeps drafting.</Note>
        )}
        {reEnabling && canEdit && (
          <Textarea label="Note (required)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="min-h-[60px]"
            placeholder="What changed since it was switched back to Draft?" hint={tried && noteMissing ? 'Add a note to turn autopilot back on.' : undefined} />
        )}

        <Section title="Hold before an autopilot send" hint="The AI waits a random time between these two before sending. Shorter waits are more likely.">
          <InheritField label="Shortest wait" unit="min" step="0.5" value={form.delay_min} onChange={(v) => set('delay_min', v)} placeholder={inh(secToMin(inherited.delay_min_s), ' min')} error={errors.delay_min} />
          <InheritField label="Longest wait" unit="min" step="0.5" value={form.delay_max} onChange={(v) => set('delay_max', v)} placeholder={inh(secToMin(inherited.delay_max_s), ' min')} error={errors.delay_max} />
        </Section>

        <Section title="Wait for them to finish typing" hint="Replies start after the prospect has been quiet this long, but never later than the maximum.">
          <InheritField label="Quiet time" unit="s" value={form.debounce_quiet} onChange={(v) => set('debounce_quiet', v)} placeholder={inh(inherited.debounce_quiet_s, ' s')} error={errors.debounce_quiet} hint="30–600 seconds" />
          <InheritField label="Maximum wait" unit="s" value={form.debounce_max} onChange={(v) => set('debounce_max', v)} placeholder={inh(inherited.debounce_max_s, ' s')} error={errors.debounce_max} hint="60–1800 seconds" />
        </Section>

        <Section title="Limits">
          <InheritField label="AI sends per sender per day" value={form.sends} onChange={(v) => set('sends', v)} placeholder={inh(inherited.max_ai_sends_per_sender_day)} error={errors.sends} hint="1–40" />
          <InheritField label="Skip messages older than" unit="h" value={form.stale} onChange={(v) => set('stale', v)} placeholder={inh(inherited.stale_after_h, ' h')} error={errors.stale} hint="1–72 hours" />
          <InheritField label="Pause autopilot after a person replies" unit="h" value={form.takeover} onChange={(v) => set('takeover', v)} placeholder={inh(inherited.human_takeover_pause_h, ' h')} error={errors.takeover} hint="1–720 hours. Drafts keep coming." />
        </Section>

        <div>
          <div className="flex items-end gap-1.5">
            <div className="flex-1">
              <Textarea label="Disclosure line" value={form.disclosure} onChange={(e) => set('disclosure', e.target.value)} rows={2} className="min-h-[60px]"
                counter={{ max: 200, value: form.disclosure.trim().length }} placeholder={inherited.disclosure ? `Inherits: ${inherited.disclosure}` : 'e.g. Sent with the help of an AI assistant.'} />
            </div>
            <ClearButton show={form.disclosure !== ''} onClick={() => set('disclosure', '')} label="Inherit disclosure" />
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Added by the system to the end of every message the AI sends on its own — the AI never writes it. Setting one lifts the default autopilot block for EU/EEA leads.
          </p>
          {errors.disclosure && <p className="text-xs text-red-600 mt-1">{errors.disclosure}</p>}
        </div>

        <div>
          <CountryChips value={form.countries} inherited={inherited.blocked_countries} onChange={(v) => set('countries', v)} error={errors.countries} disabled={!canEdit} />
          <p className="text-xs text-gray-500 mt-1">
            Autopilot stays off for leads in these countries while no disclosure line is set; drafts are unaffected. {form.countries == null && `Inherited: ${countriesText(inherited.blocked_countries)}.`}
          </p>
        </div>

        {save.error && <ErrorBox message={parseError(save.error).message} />}
      </fieldset>
    </Modal>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-sm font-medium text-gray-900">{title}</div>
      {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      <div className="grid sm:grid-cols-2 gap-3 mt-2">{children}</div>
    </div>
  );
}
