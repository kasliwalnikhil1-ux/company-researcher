'use client';

import { Check } from 'lucide-react';
import { FLAG_LABEL } from '@/lib/outreach/aiReplies';
import type { PromptSettings } from '@/lib/outreach/aiReplies';
import { Select } from '@/components/outreach/ui';
import { SettingRow, Switch } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';
import { SKIP_FLAGS } from './promptModel';

function NumberInput({ label, value, min, max, disabled, onChange }: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (v: number) => void }) {
  const bad = !Number.isInteger(value) || value < min || value > max;
  return (
    <div className="flex flex-col items-end">
      <input type="number" inputMode="numeric" min={min} max={max} step={1} disabled={disabled} aria-label={label} aria-invalid={bad}
        value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        className={cn('w-24 px-3 py-1.5 text-sm text-right tabular-nums rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50', bad ? 'border-red-400' : 'border-gray-300')} />
      {bad && <span className="text-xs mt-1 text-red-600">From {min} to {max}</span>}
    </div>
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
    <div className="divide-y divide-gray-100">
      <SettingRow title="Longest reply" description="In characters, from 100 to 1000."
        control={<NumberInput label="Longest reply (characters)" value={value.max_length} min={100} max={1000} disabled={disabled} onChange={(v) => onChange({ max_length: v })} />} />

      <SettingRow title={'When they ask "Are you a bot?"'} description="What the AI does when a prospect asks if they are talking to a person."
        control={(
          <Select aria-label='When they ask "Are you a bot?"' value={value.bot_question} disabled={disabled} className="w-72 py-1.5"
            onChange={(e) => onChange({ bot_question: e.target.value as PromptSettings['bot_question'] })}>
            <option value="escalate">Hand the chat to a person</option>
            <option value="disclose">Say replies are AI-assisted and keep going</option>
          </Select>
        )} />

      <div className="py-3 space-y-2">
        <div>
          <div className="text-sm font-medium text-gray-900">Skip ahead to the pitch when they</div>
          <div className="text-xs text-gray-500 mt-0.5">Any of these moves the AI straight to the pitch stage, even before the set number of replies.</div>
        </div>
        <div role="group" aria-label="Skip ahead to the pitch when they" className="flex flex-wrap gap-1.5">
          {SKIP_FLAGS.map((f) => {
            const on = value.skip_to_pitch_when.includes(f);
            return (
              <button key={f} type="button" aria-pressed={on} disabled={disabled} onClick={() => toggleFlag(f, !on)}
                className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 text-sm rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  on ? 'border-indigo-200 bg-indigo-50 text-indigo-700 font-medium' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50')}>
                {on && <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                {FLAG_LABEL[f] ?? f}
              </button>
            );
          })}
        </div>
      </div>

      <SettingRow title="Vary the approach in early stages" description="The AI does not repeat the same kind of reply twice in a row while getting to know them."
        control={<Switch label="Vary the approach in early stages" checked={value.vary_moves_in_early_stages} disabled={disabled} onChange={(v) => onChange({ vary_moves_in_early_stages: v })} />} />
      <SettingRow title="Reply in their language" description="If they switch to another language on the sequence's list, the AI switches too."
        control={<Switch label="Reply in their language" checked={value.allow_language_switch} disabled={disabled} onChange={(v) => onChange({ allow_language_switch: v })} />} />
    </div>
  );
}
