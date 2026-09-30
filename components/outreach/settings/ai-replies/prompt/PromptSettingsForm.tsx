'use client';

import { FLAG_LABEL } from '@/lib/outreach/aiReplies';
import type { PromptSettings } from '@/lib/outreach/aiReplies';
import { Select } from '@/components/outreach/ui';
import { SettingRow, Switch } from '@/components/outreach/settings/shared';
import { SKIP_FLAGS } from './promptModel';

function NumberField({ label, hint, value, min, max, disabled, onChange }: { label: string; hint?: string; value: number; min: number; max: number; disabled?: boolean; onChange: (v: number) => void }) {
  const bad = !Number.isInteger(value) || value < min || value > max;
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      <input type="number" inputMode="numeric" min={min} max={max} step={1} disabled={disabled}
        value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        className={`w-28 px-3 py-2 text-sm rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 ${bad ? 'border-red-400' : 'border-gray-300'}`} />
      <span className={`block text-xs mt-1 ${bad ? 'text-red-600' : 'text-gray-500'}`}>{bad ? `From ${min} to ${max}` : hint}</span>
    </label>
  );
}

/**
 * The prompt-level settings that travel with the prompt (v2): how the AI moves between stages, the bot question and the
 * reply length. Numbers per sequence (pitch after, replies per conversation, languages, hand-off stage) live on the
 * sequence card, not here.
 */
export default function PromptSettingsForm({ value, disabled, onChange }: {
  value: PromptSettings;
  disabled?: boolean;
  onChange: (patch: Partial<PromptSettings>) => void;
}) {
  const toggleFlag = (f: string, on: boolean) =>
    onChange({ skip_to_pitch_when: on ? [...value.skip_to_pitch_when.filter((x) => x !== f), f] : value.skip_to_pitch_when.filter((x) => x !== f) });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-6">
        <NumberField label="Longest reply (characters)" hint="100 to 1000" value={value.max_length} min={100} max={1000} disabled={disabled}
          onChange={(v) => onChange({ max_length: v })} />
        <Select label='When they ask "Are you a bot?"' value={value.bot_question} disabled={disabled} className="w-72"
          onChange={(e) => onChange({ bot_question: e.target.value as PromptSettings['bot_question'] })}>
          <option value="escalate">Hand the chat to a person</option>
          <option value="disclose">Say replies are AI-assisted and keep going</option>
        </Select>
      </div>

      <fieldset>
        <legend className="text-xs font-medium text-gray-600 mb-1.5">Skip ahead to the pitch when they</legend>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
          {SKIP_FLAGS.map((f) => (
            <label key={f} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" className="rounded border-gray-300" disabled={disabled} checked={value.skip_to_pitch_when.includes(f)} onChange={(e) => toggleFlag(f, e.target.checked)} />
              {FLAG_LABEL[f] ?? f}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="divide-y divide-gray-100 border-y border-gray-100">
        <SettingRow title="Vary the approach in early stages" description="The AI does not repeat the same kind of reply twice in a row while getting to know them."
          control={<Switch label="Vary the approach in early stages" checked={value.vary_moves_in_early_stages} disabled={disabled} onChange={(v) => onChange({ vary_moves_in_early_stages: v })} />} />
        <SettingRow title="Reply in their language" description="If they switch to another language on the sequence's list, the AI switches too."
          control={<Switch label="Reply in their language" checked={value.allow_language_switch} disabled={disabled} onChange={(v) => onChange({ allow_language_switch: v })} />} />
      </div>
    </div>
  );
}
