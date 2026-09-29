'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { FLAG_LABEL } from '@/lib/outreach/aiReplies';
import type { PromptSettings } from '@/lib/outreach/aiReplies';
import type { Stage } from '@/lib/outreach/types';
import { Select } from '@/components/outreach/ui';
import { SettingRow, Switch } from '@/components/outreach/settings/shared';
import { LANG_RE, SKIP_FLAGS } from './promptModel';

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

function LanguageChips({ value, disabled, onChange }: { value: string[]; disabled?: boolean; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('');
  const code = text.trim().toLowerCase();
  const valid = LANG_RE.test(code) && !value.includes(code);
  const add = () => { if (valid) { onChange([...value, code]); setText(''); } };
  return (
    <div>
      <span className="block text-xs font-medium text-gray-600 mb-1">Languages the AI replies in</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((l) => (
          <span key={l} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-indigo-50 text-indigo-800 text-xs font-medium">
            {l}
            {!disabled && value.length > 1 && (
              <button type="button" aria-label={`Remove ${l}`} onClick={() => onChange(value.filter((x) => x !== l))} className="p-0.5 rounded-full hover:bg-indigo-100"><X className="w-3 h-3" /></button>
            )}
          </span>
        ))}
        {!disabled && (
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={3} placeholder="add, e.g. hi" aria-label="Add a language code"
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} onBlur={add}
            className="w-28 px-2 py-1 text-xs rounded-md border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        )}
      </div>
      <span className="block text-xs text-gray-500 mt-1">Two-letter codes (en, hi, de). A message in another language goes to a person.</span>
    </div>
  );
}

/** The structured settings of PRD §8.2, shown beside the text in both editor modes. */
export default function PromptSettingsForm({ value, pipelineStages, disabled, onChange }: {
  value: PromptSettings;
  pipelineStages: Stage[];
  disabled?: boolean;
  onChange: (patch: Partial<PromptSettings>) => void;
}) {
  const toggleFlag = (f: string, on: boolean) =>
    onChange({ skip_to_pitch_when: on ? [...value.skip_to_pitch_when.filter((x) => x !== f), f] : value.skip_to_pitch_when.filter((x) => x !== f) });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-6">
        <NumberField label="Exchanges before pitching" hint="0 to 10" value={value.min_exchanges_before_pitch} min={0} max={10} disabled={disabled}
          onChange={(v) => onChange({ min_exchanges_before_pitch: v })} />
        <NumberField label="AI replies per chat" hint="Then a person takes over" value={value.max_ai_replies_per_chat} min={1} max={10} disabled={disabled}
          onChange={(v) => onChange({ max_ai_replies_per_chat: v })} />
        <NumberField label="Longest reply (characters)" hint="100 to 1000" value={value.max_length} min={100} max={1000} disabled={disabled}
          onChange={(v) => onChange({ max_length: v })} />
      </div>

      <fieldset>
        <legend className="text-xs font-medium text-gray-600 mb-1.5">Skip ahead to the pitch when they…</legend>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
          {SKIP_FLAGS.map((f) => (
            <label key={f} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" className="rounded border-gray-300" disabled={disabled} checked={value.skip_to_pitch_when.includes(f)} onChange={(e) => toggleFlag(f, e.target.checked)} />
              {FLAG_LABEL[f] ?? f}
            </label>
          ))}
        </div>
      </fieldset>

      <LanguageChips value={value.languages} disabled={disabled} onChange={(languages) => onChange({ languages })} />

      <div className="divide-y divide-gray-100 border-y border-gray-100">
        <SettingRow title="Vary the approach in early stages" description="The AI does not repeat the same kind of reply twice in a row while getting to know them."
          control={<Switch label="Vary the approach in early stages" checked={value.vary_moves_in_early_stages} disabled={disabled} onChange={(v) => onChange({ vary_moves_in_early_stages: v })} />} />
        <SettingRow title="Reply in their language" description="If they switch to another language on the list, the AI switches too."
          control={<Switch label="Reply in their language" checked={value.allow_language_switch} disabled={disabled} onChange={(v) => onChange({ allow_language_switch: v })} />} />
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Select label='When they ask "Are you a bot?"' value={value.bot_question} disabled={disabled}
          onChange={(e) => onChange({ bot_question: e.target.value as PromptSettings['bot_question'] })}>
          <option value="escalate">Hand the chat to a person</option>
          <option value="disclose">Say replies are AI-assisted and keep going</option>
        </Select>
        <Select label="Hand over once the lead reaches (pipeline stage)" value={value.handoff_stage_id ?? ''} disabled={disabled}
          onChange={(e) => onChange({ handoff_stage_id: e.target.value || null })}>
          <option value="">Never, based on the pipeline stage</option>
          {pipelineStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </div>
    </div>
  );
}
