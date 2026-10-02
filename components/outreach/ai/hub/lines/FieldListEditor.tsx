'use client';

import { useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import {
  FIELD_OPTIONS_MAX, FIELD_OPTIONS_MIN, FIELD_OPTION_MAX_CHARS, FIELD_TEXT_MAX, FIELD_TEXT_MIN, FIELD_TYPES, FIELD_TYPE_LABEL, MAX_FIELDS,
  fieldKeyFromName, fieldToken, newFieldDraft, type FieldDraft, type FieldProblem,
} from '@/lib/outreach/aiFields';
import type { AiField, AiFieldType } from '@/lib/outreach/types';
import { Button } from '@/components/outreach/ui';
import { copyText } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';

const cell = 'w-full min-w-0 px-2 py-1.5 text-sm rounded-md border bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
const COLS = 'md:grid-cols-[minmax(0,1.1fr)_6.75rem_minmax(0,1fr)_minmax(0,1.3fr)_2rem]';
const KEY_LOCKED = 'To rename a key, delete the field and add it again.';

const Problem = ({ text }: { text?: string }) => (text ? <span role="alert" className="block text-[11px] leading-4 text-red-600 mt-0.5">{text}</span> : null);
/** The column name of a cell, shown above it where the table is stacked (narrow screens). */
const Stacked = ({ children }: { children: string }) => <span className="md:hidden block text-[11px] font-medium text-gray-500 mb-0.5" aria-hidden="true">{children}</span>;

/**
 * The fields of a Fields variable: one row per field (name and key · type · the type's setting · description · delete),
 * up to 8. A new field's key follows its name until a key is typed; a saved field's key is locked.
 *   problems   per field, in the order of the list (the caller passes none until the form was submitted once)
 *   general    what is wrong with the list as a whole
 */
export default function FieldListEditor({ fields, onChange, problems, general, readOnly, variableKey }: {
  fields: FieldDraft[]; onChange: (fields: FieldDraft[]) => void; problems?: FieldProblem[]; general?: string; readOnly?: boolean;
  /** The variable's key, for the example of a field's token. */
  variableKey: string;
}) {
  const patch = (uid: string, p: Partial<FieldDraft>) => onChange(fields.map((f) => (f.uid === uid ? { ...f, ...p } : f)));
  const full = fields.length >= MAX_FIELDS;
  const ro = readOnly ? 'bg-gray-50 text-gray-700' : undefined;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span id="variable-fields-title" className="block text-xs font-medium text-gray-600">Fields</span>
        <span className={cn('text-xs tabular-nums', fields.length > MAX_FIELDS ? 'text-red-600 font-medium' : 'text-gray-400')} aria-label={`${fields.length} of ${MAX_FIELDS} fields`}>{fields.length} / {MAX_FIELDS}</span>
      </div>
      <div role="group" aria-labelledby="variable-fields-title" className="rounded-lg border border-gray-200 divide-y divide-gray-100">
        <div className={cn('hidden md:grid gap-2 px-2.5 py-1.5 bg-gray-50 rounded-t-lg text-[11px] font-semibold uppercase tracking-wide text-gray-500', COLS)} aria-hidden="true">
          <span>Name</span><span>Type</span><span>Setting</span><span>Description</span><span />
        </div>
        {fields.length === 0 && <p className="px-2.5 py-3 text-sm text-gray-500">No fields yet. {readOnly ? '' : 'Add the first one below.'}</p>}
        {fields.map((f, i) => {
          const p = problems?.[i] ?? {};
          const label = f.name.trim() || `field ${i + 1}`;
          return (
            <div key={f.uid} role="group" aria-label={`Field ${i + 1}${f.name.trim() ? `: ${f.name.trim()}` : ''}`} className={cn('grid grid-cols-1 gap-2 px-2.5 py-2 items-start', COLS)}>
              <div className="min-w-0">
                <Stacked>Name</Stacked>
                <input value={f.name} aria-label={`Name of field ${i + 1}`} placeholder="ICP fit" maxLength={60} readOnly={readOnly} aria-invalid={!!p.name || undefined}
                  onChange={(e) => patch(f.uid, { name: e.target.value, key: !f.saved && !f.keyTyped ? fieldKeyFromName(e.target.value) : f.key })}
                  className={cn(cell, p.name ? 'border-red-400' : 'border-gray-300', ro)} />
                <Problem text={p.name} />
                {f.saved || readOnly ? (
                  <span className="block mt-1 font-mono text-[11px] text-gray-500 truncate" title={f.saved ? KEY_LOCKED : undefined}>{f.key || 'key'}</span>
                ) : (
                  <input value={f.key} aria-label={`Key of ${label}`} placeholder="key" spellCheck={false} maxLength={30} aria-invalid={!!p.key || undefined}
                    title="Used in messages. It follows the name until you type your own. It cannot change after saving."
                    onChange={(e) => patch(f.uid, { key: e.target.value.toLowerCase().replace(/\s+/g, '_'), keyTyped: true })}
                    className={cn('mt-1 w-full min-w-0 px-1.5 py-0.5 font-mono text-[11px] rounded border bg-white text-gray-600 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500', p.key ? 'border-red-400' : 'border-gray-200')} />
                )}
                <Problem text={p.key} />
              </div>
              <div className="min-w-0">
                <Stacked>Type</Stacked>
                <select value={f.type} aria-label={`Type of ${label}`} disabled={readOnly} onChange={(e) => patch(f.uid, { type: e.target.value as AiFieldType })}
                  title={f.saved ? 'The type cannot change while a sequence uses this field.' : undefined}
                  className={cn(cell, 'border-gray-300 disabled:opacity-100', ro)}>
                  {FIELD_TYPES.map((t) => <option key={t} value={t}>{FIELD_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
              <div className={cn('min-w-0', f.type !== 'text' && f.type !== 'choice' && 'hidden md:block')}>
                {f.type === 'text' && (
                  <>
                    <Stacked>Max characters</Stacked>
                    <div className="flex items-center gap-1.5">
                      <input value={f.max_chars} inputMode="numeric" aria-label={`Max characters of ${label}`} readOnly={readOnly} aria-invalid={!!p.max_chars || undefined}
                        title={`${FIELD_TEXT_MIN} to ${FIELD_TEXT_MAX.toLocaleString()} characters`}
                        onChange={(e) => patch(f.uid, { max_chars: e.target.value.replace(/[^0-9]/g, '').slice(0, 4) })}
                        className={cn(cell, 'max-w-[4.5rem] tabular-nums', p.max_chars ? 'border-red-400' : 'border-gray-300', ro)} />
                      <span className="text-xs text-gray-500" aria-hidden="true">characters</span>
                    </div>
                    <Problem text={p.max_chars} />
                  </>
                )}
                {f.type === 'choice' && (
                  <>
                    <Stacked>Options</Stacked>
                    <input value={f.options} aria-label={`Options of ${label}, separated by commas`} placeholder="high, medium, low" readOnly={readOnly} aria-invalid={!!p.options || undefined}
                      title={`${FIELD_OPTIONS_MIN} to ${FIELD_OPTIONS_MAX} options, separated by commas. Up to ${FIELD_OPTION_MAX_CHARS} characters each.`}
                      onChange={(e) => patch(f.uid, { options: e.target.value })}
                      className={cn(cell, p.options ? 'border-red-400' : 'border-gray-300', ro)} />
                    <Problem text={p.options} />
                  </>
                )}
              </div>
              <div className="min-w-0">
                <Stacked>Description</Stacked>
                <input value={f.description} aria-label={`Description of ${label}`} readOnly={readOnly} aria-invalid={!!p.description || undefined}
                  placeholder={f.type === 'yes_no' ? 'When is it yes?' : f.type === 'number' ? 'Which number, and where it comes from' : 'What the AI should put here'}
                  onChange={(e) => patch(f.uid, { description: e.target.value })}
                  className={cn(cell, p.description ? 'border-red-400' : 'border-gray-300', ro)} />
                <Problem text={p.description} />
              </div>
              <div className="flex md:justify-end">
                {!readOnly && (
                  <button type="button" onClick={() => onChange(fields.filter((x) => x.uid !== f.uid))} aria-label={`Delete ${label}`}
                    title={f.saved ? 'Delete this field. A field that a sequence still uses cannot be deleted.' : 'Delete this field'}
                    className="inline-flex items-center justify-center gap-1 h-8 md:w-8 px-2 md:px-0 rounded-md text-xs text-gray-500 hover:bg-red-50 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                    <Trash2 className="w-4 h-4" aria-hidden="true" /><span className="md:hidden">Delete field</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {general && <span role="alert" className="block text-xs text-red-600 mt-1">{general}</span>}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
          <Button type="button" size="sm" variant="secondary" disabled={full} onClick={() => onChange([...fields, newFieldDraft()])} title={full ? `A variable can have up to ${MAX_FIELDS} fields` : undefined}>
            <Plus className="w-3.5 h-3.5" /> Add field
          </Button>
          <span className="text-xs text-gray-500">
            {full ? `A variable can have up to ${MAX_FIELDS} fields.` : 'One AI call fills every field for a lead. A field the profile says nothing about stays empty.'}
          </span>
        </div>
      )}
      {fields.some((f) => f.saved) && !readOnly && <p className="text-xs text-gray-500 mt-1.5">{KEY_LOCKED} A field that a sequence uses cannot be deleted or change its type.</p>}
      <p className="text-xs text-gray-500 mt-1.5">
        A Fields variable has no fallback text of its own. Write the fallback in the message, inside the token: <code className="text-[11px] bg-gray-50 border border-gray-200 rounded px-1 break-all">{fallbackExample(variableKey, fields)}</code>
      </p>
    </div>
  );
}

/** {{ai.research.pain|growing outbound}}, with this variable's key and its first printable field when they are known. */
function fallbackExample(variableKey: string, fields: FieldDraft[]): string {
  const f = fields.find((x) => x.type !== 'yes_no' && x.key);
  return variableKey && f ? `{{ai.${variableKey}.${f.key}|your fallback}}` : '{{ai.research.pain|growing outbound}}';
}

/** What a field's chip shows: its token; a Yes/No field shows the conditional with … where the text goes. */
export const fieldTokenLabel = (varKey: string, f: Pick<AiField, 'key' | 'type'>) => {
  const token = fieldToken(varKey, f);
  return f.type === 'yes_no' ? token.replace('}}{{/if}}', '}}…{{/if}}') : token;
};

/** One click-to-copy chip per field: the token that goes into a message. */
export function FieldTokenChips({ varKey, fields, className }: { varKey: string; fields: Array<Pick<AiField, 'key' | 'name' | 'type'>>; className?: string }) {
  const [copied, setCopied] = useState<{ key: string; ok: boolean } | null>(null);
  const copy = async (f: Pick<AiField, 'key' | 'name' | 'type'>) => {
    const ok = await copyText(fieldToken(varKey, f));
    setCopied({ key: f.key, ok });
    setTimeout(() => setCopied((c) => (c?.key === f.key ? null : c)), 1800);
  };
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)}>
      {fields.map((f) => {
        const state = copied?.key === f.key ? copied : null;
        const label = fieldTokenLabel(varKey, f);
        return (
          <li key={f.key} className="max-w-full min-w-0">
            <button type="button" onClick={() => void copy(f)} aria-label={`Copy the token of ${f.name || f.key}`}
              title={state ? (state.ok ? 'Copied' : 'Copy failed. Select the text and copy it by hand.') : `${f.name || f.key}: click to copy`}
              className={cn('max-w-full inline-flex items-center gap-1 rounded border px-1.5 py-1 text-xs font-mono text-gray-800 bg-gray-50 hover:bg-white hover:border-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                state && !state.ok ? 'border-red-300' : 'border-gray-200')}>
              <span className="truncate select-all">{label}</span>
              {state?.ok && <Check className="w-3 h-3 text-green-600 flex-shrink-0" aria-hidden="true" />}
              <span className="sr-only" aria-live="polite">{state ? (state.ok ? 'Copied' : 'Copy failed') : ''}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
