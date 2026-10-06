'use client';

// The value of a Fields variable for one lead, as a person reads it (a Field · Value table) and as a person edits it
// (one typed input per field). Shared by the Line card of Needs you, the All lines table, "Try on a lead" and the lead page.
import { useId } from 'react';
import { FIELD_TEXT_DEFAULT, editProblems, fieldValueText, type FieldEdit } from '@/lib/outreach/aiFields';
import type { AiField, AiFieldType, AiFieldValue } from '@/lib/outreach/types';
import { cn } from '@/lib/utils';

const TYPES: AiFieldType[] = ['text', 'number', 'yes_no', 'choice'];

/** A field list that came out of jsonb (the `meta` of a Needs you row): only well-formed fields are kept. */
export function readFields(v: unknown): AiField[] {
  if (!Array.isArray(v)) return [];
  const out: AiField[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (typeof o.key !== 'string' || !o.key || !TYPES.includes(o.type as AiFieldType)) continue;
    out.push({
      key: o.key, name: typeof o.name === 'string' && o.name.trim() ? o.name : o.key, type: o.type as AiFieldType,
      description: typeof o.description === 'string' ? o.description : undefined,
      options: Array.isArray(o.options) ? o.options.filter((s): s is string => typeof s === 'string') : undefined,
      max_chars: Number.isFinite(Number(o.max_chars)) && Number(o.max_chars) > 0 ? Number(o.max_chars) : undefined,
    });
  }
  return out;
}

/** The stored object of a value ({ <field key>: text | number | yes/no | null }), or null when there is none. */
export function readFieldData(v: unknown): Record<string, AiFieldValue> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, AiFieldValue> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? x : null;
  }
  return out;
}

/** True when no field holds a value. */
export const fieldDataEmpty = (fields: AiField[], data: Record<string, AiFieldValue> | null | undefined): boolean =>
  fields.every((f) => data?.[f.key] === null || data?.[f.key] === undefined || data?.[f.key] === '');

/**
 * Field · Value, one row per field. Yes/No reads Yes / No, an empty field reads —.
 *   compact   no visible header row (a table cell, a small card)
 */
export function FieldValueTable({ fields, data, compact, className }: {
  fields: AiField[]; data: Record<string, AiFieldValue> | null | undefined; compact?: boolean; className?: string;
}) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-gray-200 bg-white', className)}>
      <table className="w-full text-sm">
        <thead className={compact ? 'sr-only' : undefined}>
          <tr>
            <th scope="col" className="w-2/5 max-w-[14rem] text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 px-2.5 py-1.5 border-b border-gray-200">Field</th>
            <th scope="col" className="text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 px-2.5 py-1.5 border-b border-gray-200">Value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {fields.map((f) => {
            const text = fieldValueText(data?.[f.key]);
            return (
              <tr key={f.key} className="align-top">
                <th scope="row" title={f.description || undefined} className="w-2/5 max-w-[14rem] text-left font-normal text-gray-500 px-2.5 py-1.5 break-words [overflow-wrap:anywhere]">{f.name}</th>
                <td className="px-2.5 py-1.5 text-gray-900 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {text ? text : <><span className="text-gray-400" aria-hidden="true">—</span><span className="sr-only">Empty</span></>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const control = 'w-full px-2.5 py-1.5 text-sm rounded-lg border bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';

/**
 * One typed input per field: text with a character counter, a number, Yes / No / Empty, a choice with an empty option.
 * The values live in the caller (`edit`), so a list can tell which rows carry an unsaved edit.
 *   showProblems   after the first try to save: say per field what does not fit
 *   onSave         Ctrl+Enter (or Cmd+Enter) anywhere in the editor
 *   onDiscard      Esc anywhere in the editor
 */
export function FieldValueEditor({ fields, edit, onChange, onSave, onDiscard, showProblems, who, autoFocus, disabled, className }: {
  fields: AiField[]; edit: FieldEdit; onChange: (e: FieldEdit) => void; onSave: () => void; onDiscard: () => void;
  showProblems?: boolean;
  /** The lead's name, for the names of the inputs ("Pain for Priya Sharma"). */
  who?: string;
  autoFocus?: boolean; disabled?: boolean; className?: string;
}) {
  const base = useId();
  const problems = showProblems ? editProblems(fields, edit) : {};
  const set = (key: string, value: string) => onChange({ ...edit, [key]: value });
  const suffix = who ? ` for ${who}` : '';

  return (
    <div className={cn('space-y-2.5', className)}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSave(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDiscard(); }
      }}>
      {fields.map((f, i) => {
        const id = `${base}-${f.key}`;
        const value = edit[f.key] ?? '';
        const problem = problems[f.key];
        const limit = f.max_chars ?? FIELD_TEXT_DEFAULT;
        const over = f.type === 'text' && value.length > limit;
        const focus = autoFocus && i === 0;
        return (
          <div key={f.key} className="grid grid-cols-1 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
            <div className="sm:pt-1.5 min-w-0">
              {f.type === 'yes_no'
                ? <span id={`${id}-label`} className="block text-xs font-medium text-gray-600 break-words">{f.name}</span>
                : <label htmlFor={id} className="block text-xs font-medium text-gray-600 break-words">{f.name}</label>}
              {f.description && <span className="block text-[11px] text-gray-400 break-words line-clamp-2" title={f.description}>{f.description}</span>}
            </div>
            <div className="min-w-0">
              {f.type === 'text' && (
                <>
                  <textarea id={id} value={value} rows={limit > 120 || value.length > 80 ? 2 : 1} autoFocus={focus} disabled={disabled} aria-label={`${f.name}${suffix}`}
                    aria-invalid={!!problem || undefined} aria-describedby={`${id}-count`} onChange={(e) => set(f.key, e.target.value)}
                    className={cn(control, 'resize-y min-h-[34px]', problem || over ? 'border-red-400' : 'border-gray-300')} />
                  <span id={`${id}-count`} className={cn('block text-right text-[11px] tabular-nums', over ? 'text-red-600 font-medium' : 'text-gray-400')}>{value.length}/{limit}</span>
                </>
              )}
              {f.type === 'number' && (
                <input id={id} type="text" inputMode="decimal" value={value} autoFocus={focus} disabled={disabled} aria-label={`${f.name}${suffix}`} aria-invalid={!!problem || undefined}
                  onChange={(e) => set(f.key, e.target.value)} placeholder="Leave empty when not known" className={cn(control, 'sm:max-w-[14rem] tabular-nums', problem ? 'border-red-400' : 'border-gray-300')} />
              )}
              {f.type === 'yes_no' && (
                <div role="radiogroup" aria-labelledby={`${id}-label`} className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
                  {([['true', 'Yes'], ['false', 'No'], ['', 'Empty']] as const).map(([v, label], j) => {
                    const on = value === v;
                    return (
                      <button key={label} type="button" role="radio" aria-checked={on} disabled={disabled} autoFocus={focus && j === 0} onClick={() => set(f.key, v)}
                        className={cn('px-3 py-1 text-sm rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed',
                          on ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50')}>
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
              {f.type === 'choice' && (
                <select id={id} value={(f.options ?? []).find((o) => o.toLowerCase() === value.toLowerCase()) ?? value} autoFocus={focus} disabled={disabled} aria-label={`${f.name}${suffix}`} aria-invalid={!!problem || undefined}
                  onChange={(e) => set(f.key, e.target.value)} className={cn(control, 'sm:max-w-[18rem]', problem ? 'border-red-400' : 'border-gray-300')}>
                  <option value="">Empty</option>
                  {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  {/* a stored value that is no longer one of the options stays visible until another one is picked */}
                  {value && !(f.options ?? []).some((o) => o.toLowerCase() === value.toLowerCase()) && <option value={value}>{value} (no longer an option)</option>}
                </select>
              )}
              {problem && <span role="alert" className="block text-xs text-red-600 mt-0.5">{problem}</span>}
            </div>
          </div>
        );
      })}
      {problems._ && <p role="alert" className="text-xs text-red-600">{problems._}</p>}
    </div>
  );
}
