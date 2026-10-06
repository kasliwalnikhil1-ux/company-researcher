'use client';

import { newFieldDraft } from '@/lib/outreach/aiFields';
import type { AiVariableOutput } from '@/lib/outreach/types';
import { Input, Textarea } from '@/components/outreach/ui';
import { CopyButton, SettingRow, Switch } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';
import FieldListEditor from './FieldListEditor';
import { PROMPT_MAX, keyFromName, variableToken, type VariableDraft, type VariableProblems } from './variableModel';

/** The token of a variable, {{ai.<key>|<fallback>}}, with a copy button. `sm` is the one-line size of a list row. */
export function VariableToken({ varKey, fallback, size = 'md', className }: { varKey: string; fallback?: string | null; size?: 'sm' | 'md'; className?: string }) {
  const token = variableToken(varKey, fallback);
  return (
    <div className={cn('flex items-center gap-2 min-w-0', className)}>
      <code title={token} className={cn('min-w-0 text-xs bg-gray-50 border border-gray-200 text-gray-800 truncate', size === 'sm' ? 'rounded px-1.5 py-1' : 'flex-1 rounded-lg px-3 py-2')}>{token}</code>
      <CopyButton value={token} label={`Copy the token of ${varKey}`} className={size === 'sm' ? 'w-7 h-7' : undefined} />
    </div>
  );
}

const OUTPUTS: Array<{ id: AiVariableOutput; label: string; line: string }> = [
  { id: 'text', label: 'One line', line: 'One sentence per lead, used in a message as one token.' },
  { id: 'fields', label: 'Fields', line: 'Up to 8 named values per lead from one AI call. Print each one in a message, or route leads on it with a Condition step.' },
];

/** One line · Fields. Picked when the variable is created; a saved variable shows it locked. */
function OutputPicker({ value, onChange, locked, disabled }: { value: AiVariableOutput; onChange: (o: AiVariableOutput) => void; locked: boolean; disabled?: boolean }) {
  const current = OUTPUTS.find((o) => o.id === value) ?? OUTPUTS[0];
  return (
    <div>
      <span id="variable-output-title" className="block text-xs font-medium text-gray-600 mb-1">Output</span>
      <div role="radiogroup" aria-labelledby="variable-output-title" aria-describedby="variable-output-hint" className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
        {OUTPUTS.map((o) => {
          const on = value === o.id;
          return (
            <button key={o.id} type="button" role="radio" aria-checked={on} disabled={(locked || disabled) && !on} aria-disabled={locked || disabled || undefined} title={locked && !on ? 'To switch, create a new variable' : o.line}
              onClick={() => { if (!on && !locked && !disabled) onChange(o.id); }}
              className={cn('px-3.5 py-1 text-sm rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                on ? (locked || disabled ? 'bg-gray-100 text-gray-800 font-medium cursor-default' : 'bg-indigo-50 text-indigo-700 font-medium') : 'text-gray-600 hover:bg-gray-50',
                !on && (locked || disabled) && 'opacity-50 cursor-not-allowed hover:bg-transparent')}>
              {o.label}
            </button>
          );
        })}
      </div>
      <span id="variable-output-hint" className="block text-xs text-gray-500 mt-1">{current.line}{locked ? ' The output cannot change. To switch, create a new variable.' : ' It cannot be changed later.'}</span>
    </div>
  );
}

/**
 * The form of a variable: name, key, output (One line · Fields), what the AI should write, then
 *   One line   fallback, max characters
 *   Fields     the field list (each text field has its own limit; the fallback is written in the token)
 * and "Needs recent posts". Used by the "New variable" dialog and by the variable page. The key and the output of a
 * saved variable cannot change.
 *   errors      the problems to show (the caller passes none until the form was submitted once)
 *   autoKey     a new variable: the key follows the name until someone types a key
 *   readOnly    members see the settings but cannot change them
 */
export default function VariableFields({ draft, onChange, errors, readOnly, autoKey, onKeyTyped, autoFocus }: {
  draft: VariableDraft; onChange: (d: VariableDraft) => void; errors: VariableProblems;
  readOnly?: boolean; autoKey?: boolean; onKeyTyped?: () => void; autoFocus?: boolean;
}) {
  const saved = !!draft.id;
  const typed = draft.output === 'fields';
  const ro = readOnly ? 'bg-gray-50 text-gray-700' : undefined;
  // Picking Fields for the first time starts the list with one empty row, so there is something to fill in.
  const pickOutput = (output: AiVariableOutput) => onChange({ ...draft, output, fields: output === 'fields' && draft.fields.length === 0 ? [newFieldDraft()] : draft.fields });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Name" value={draft.name} placeholder={typed ? 'Research' : 'Opening line'} error={errors.name} autoFocus={autoFocus} readOnly={readOnly} className={ro}
          onChange={(e) => onChange({ ...draft, name: e.target.value, key: !saved && autoKey ? keyFromName(e.target.value) : draft.key })} />
        <Input label="Key" value={draft.key} placeholder={typed ? 'research' : 'opening_line'} readOnly={saved || readOnly} error={errors.key} spellCheck={false} className={saved || readOnly ? 'bg-gray-50 text-gray-700 font-mono' : 'font-mono'}
          hint={saved ? 'The key cannot change: sequences already use it.' : 'Used in messages. It cannot be changed later.'}
          onChange={(e) => { onKeyTyped?.(); onChange({ ...draft, key: e.target.value.toLowerCase() }); }} />
      </div>
      <OutputPicker value={draft.output} onChange={pickOutput} locked={saved} disabled={readOnly} />
      <div>
        {typed ? (
          <Textarea label="What should the AI work out?" value={draft.prompt} readOnly={readOnly} onChange={(e) => onChange({ ...draft, prompt: e.target.value })} counter={{ value: draft.prompt.length, max: PROMPT_MAX }} className={cn('min-h-[120px]', ro)}
            placeholder="Judge this lead against our ideal customer: B2B software companies with 20 to 500 people that sell outbound."
            hint="The AI only sees facts from the lead's profile. A field the profile says nothing about stays empty." />
        ) : (
          <Textarea label="What should the AI write?" value={draft.prompt} readOnly={readOnly} onChange={(e) => onChange({ ...draft, prompt: e.target.value })} counter={{ value: draft.prompt.length, max: PROMPT_MAX }} className={cn('min-h-[120px]', ro)}
            placeholder="One friendly sentence that refers to their current role and company. No flattery, no questions, no exclamation marks."
            hint="The AI only sees facts from the lead's profile. If the profile has nothing useful it leaves the line blank and the fallback is used." />
        )}
        {errors.prompt && <span className="block text-xs text-red-600 mt-1">{errors.prompt}</span>}
      </div>
      {typed ? (
        <FieldListEditor fields={draft.fields} onChange={(fields) => onChange({ ...draft, fields })} problems={errors.fields} general={errors.fieldList} readOnly={readOnly} variableKey={draft.key} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_160px] gap-3">
          <Input label="Fallback text" value={draft.fallback} readOnly={readOnly} className={ro} onChange={(e) => onChange({ ...draft, fallback: e.target.value })} placeholder="I came across your profile and wanted to reach out." error={errors.fallback}
            hint="Sent when a lead has no approved line. Leave empty to send nothing in its place." />
          <Input label="Max characters" inputMode="numeric" value={draft.max_chars} readOnly={readOnly} className={ro} onChange={(e) => onChange({ ...draft, max_chars: e.target.value.replace(/[^0-9]/g, '') })} error={errors.max_chars} />
        </div>
      )}
      <div className="border border-gray-200 rounded-lg px-3">
        <SettingRow title="Needs recent posts" control={<Switch label="Needs recent posts" checked={draft.needs_posts} disabled={readOnly} onChange={(v) => onChange({ ...draft, needs_posts: v })} />}
          description={typed
            ? 'Turn this on when a field should come from something the lead posted. Fetching posts has its own small daily limit per sender, separate from profile views, so values for a large list arrive over a few days.'
            : 'Turn this on when the line should mention something the lead posted. Fetching posts has its own small daily limit per sender, separate from profile views, so lines for a large list arrive over a few days.'} />
      </div>
    </div>
  );
}
