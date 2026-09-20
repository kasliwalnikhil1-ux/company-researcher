'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button, Select } from '@/components/outreach/ui';
import { CONDITION_FIELDS, CONDITION_FIELD_GROUPS, conditionFieldMeta, conditionOpsFor } from '@/lib/outreach/nodes';
import type { ConditionOp, ConditionRule } from '@/lib/outreach/types';
import { useBuilder } from './context';

const OP_LABEL: Record<ConditionOp, string> = {
  eq: 'is', neq: 'is not', contains: 'contains', not_contains: 'does not contain', exists: 'has a value', not_exists: 'is empty',
  gt: 'more than', lt: 'less than', gte: 'at least', lte: 'at most',
};
const NO_VALUE: ConditionOp[] = ['exists', 'not_exists'];
const inputCls = 'flex-1 min-w-0 px-2 py-1 text-xs rounded border border-gray-300 bg-white';

function isCustom(field: string) { return field.startsWith('custom.'); }

export default function ConditionEditor({ rules, match, onChange }: { rules: ConditionRule[]; match: 'all' | 'any'; onChange: (rules: ConditionRule[], match: 'all' | 'any') => void }) {
  const { tags, stages } = useBuilder();
  const setRule = (i: number, patch: Partial<ConditionRule>) => onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)), match);
  const remove = (i: number) => onChange(rules.filter((_, idx) => idx !== i), match);
  const add = () => onChange([...rules, { field: 'replied', op: 'eq', value: 'true' }], match);

  const changeField = (i: number, field: string) => {
    const meta = conditionFieldMeta(field);
    const value = meta?.kind === 'boolean' ? 'true' : meta?.kind === 'select' ? meta.options?.[0]?.value ?? '' : field === 'enrich.posted_within_days' ? '30' : '';
    setRule(i, { field, op: meta?.defaultOp ?? 'eq', value });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-gray-600">
        <span>Match</span>
        <select value={match} onChange={(e) => onChange(rules, e.target.value as 'all' | 'any')} aria-label="Match mode" className="px-2 py-1 text-xs rounded border border-gray-300 bg-white">
          <option value="all">all rules</option>
          <option value="any">any rule</option>
        </select>
        <span>→ true branch</span>
      </div>
      {rules.length === 0 && <p className="text-xs text-gray-500">No rules: every lead takes the <span className="font-medium">true</span> branch.</p>}
      {rules.map((r, i) => {
        const meta = conditionFieldMeta(r.field);
        const selectValue = isCustom(r.field) ? 'custom.' : r.field;
        const ops = conditionOpsFor(r.field);
        const opList = ops.includes(r.op) ? ops : [r.op, ...ops];   // keep an operator saved by an older version selectable
        const showValue = !NO_VALUE.includes(r.op);
        const kind = meta?.kind ?? 'text';
        // Booleans read better as one sentence: "Replied · is · yes".
        return (
          <div key={i} className="rounded-lg border border-gray-200 p-2 space-y-1.5 bg-gray-50/50" role="group" aria-label={`Rule ${i + 1}`}>
            <div className="flex items-center gap-1.5">
              <Select value={selectValue} onChange={(e) => changeField(i, e.target.value)} aria-label="Field" className="!py-1 !text-xs flex-1">
                {!meta && <option value={r.field}>{r.field}</option>}
                {CONDITION_FIELD_GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {CONDITION_FIELDS.filter((f) => f.group === g).map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </optgroup>
                ))}
              </Select>
              <button type="button" onClick={() => remove(i)} className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50" aria-label={`Remove rule ${i + 1}`}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            {isCustom(r.field) && (
              <input value={r.field.slice('custom.'.length)} onChange={(e) => setRule(i, { field: `custom.${e.target.value.trim()}` })} placeholder="custom field key" aria-label="Custom field key" className="w-full px-2 py-1 text-xs rounded border border-gray-300 font-mono" />
            )}
            <div className="flex items-center gap-1.5">
              <Select value={r.op} onChange={(e) => setRule(i, { op: e.target.value as ConditionOp })} aria-label="Operator" className="!py-1 !text-xs flex-1">
                {opList.map((op) => <option key={op} value={op}>{OP_LABEL[op] ?? op}</option>)}
              </Select>
              {showValue && (kind === 'boolean' ? (
                <Select value={r.value ?? 'true'} onChange={(e) => setRule(i, { value: e.target.value })} aria-label="Value" className="!py-1 !text-xs flex-1">
                  <option value="true">yes</option>
                  <option value="false">no</option>
                </Select>
              ) : kind === 'select' ? (
                <Select value={r.value ?? ''} onChange={(e) => setRule(i, { value: e.target.value })} aria-label="Value" className="!py-1 !text-xs flex-1">
                  {!meta?.options?.some((o) => o.value === (r.value ?? '')) && <option value={r.value ?? ''}>{r.value || 'Select…'}</option>}
                  {meta?.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : kind === 'tag' && tags.length > 0 ? (
                <Select value={r.value ?? ''} onChange={(e) => setRule(i, { value: e.target.value })} aria-label="Tag" className="!py-1 !text-xs flex-1">
                  <option value="">Select tag…</option>
                  {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              ) : kind === 'stage' && stages.length > 0 ? (
                <Select value={r.value ?? ''} onChange={(e) => setRule(i, { value: e.target.value })} aria-label="Stage" className="!py-1 !text-xs flex-1">
                  <option value="">Select stage…</option>
                  {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              ) : kind === 'number' ? (
                <span className="flex-1 min-w-0 flex items-center gap-1">
                  <input type="number" min={0} step={1} inputMode="numeric" value={r.value ?? ''} onChange={(e) => setRule(i, { value: e.target.value === '' ? '' : String(Math.max(0, Math.round(Number(e.target.value)) || 0)) })} placeholder="0" aria-label={`Value${meta?.unit ? ` in ${meta.unit}` : ''}`} className={`${inputCls} tabular-nums`} />
                  {meta?.unit && <span className="text-[11px] text-gray-500 flex-shrink-0">{meta.unit}</span>}
                </span>
              ) : (
                <input value={r.value ?? ''} onChange={(e) => setRule(i, { value: e.target.value })} placeholder={kind === 'tag' ? 'tag id' : kind === 'stage' ? 'stage id' : 'value'} aria-label="Value" className={inputCls} />
              ))}
            </div>
            {meta?.hint && <p className="text-[11px] text-gray-500 leading-4">{meta.hint}</p>}
            {kind === 'number' && showValue && (r.value ?? '') === '' && <p className="text-[11px] text-amber-700">Enter a number, or the rule is false for everyone.</p>}
          </div>
        );
      })}
      <Button variant="secondary" size="sm" onClick={add} type="button"><Plus className="w-3.5 h-3.5" /> Add rule</Button>
    </div>
  );
}
