'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button, Select } from '@/components/outreach/ui';
import { CONDITION_FIELDS, CONDITION_OPS } from '@/lib/outreach/nodes';
import type { ConditionRule } from '@/lib/outreach/types';
import { useBuilder } from './context';

const OP_LABEL: Record<ConditionRule['op'], string> = { eq: 'equals', neq: 'does not equal', contains: 'contains', not_contains: 'does not contain', exists: 'exists', not_exists: 'does not exist', gt: 'greater than', lt: 'less than' };
const NO_VALUE: ConditionRule['op'][] = ['exists', 'not_exists'];

function isCustom(field: string) { return field.startsWith('custom.'); }

export default function ConditionEditor({ rules, match, onChange }: { rules: ConditionRule[]; match: 'all' | 'any'; onChange: (rules: ConditionRule[], match: 'all' | 'any') => void }) {
  const { tags, stages } = useBuilder();
  const setRule = (i: number, patch: Partial<ConditionRule>) => onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)), match);
  const remove = (i: number) => onChange(rules.filter((_, idx) => idx !== i), match);
  const add = () => onChange([...rules, { field: 'replied', op: 'eq', value: 'true' }], match);

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
        const meta = CONDITION_FIELDS.find((f) => (f.value === 'custom.' ? isCustom(r.field) : f.value === r.field));
        const selectValue = isCustom(r.field) ? 'custom.' : r.field;
        const showValue = !NO_VALUE.includes(r.op);
        return (
          <div key={i} className="rounded-lg border border-gray-200 p-2 space-y-1.5 bg-gray-50/50">
            <div className="flex items-center gap-1.5">
              <Select value={selectValue} onChange={(e) => setRule(i, { field: e.target.value === 'custom.' ? 'custom.' : e.target.value, value: '' })} aria-label="Field" className="!py-1 !text-xs flex-1">
                {CONDITION_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </Select>
              <button type="button" onClick={() => remove(i)} className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50" aria-label="Remove rule"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            {isCustom(r.field) && (
              <input value={r.field.slice('custom.'.length)} onChange={(e) => setRule(i, { field: `custom.${e.target.value.trim()}` })} placeholder="custom field key" aria-label="Custom field key" className="w-full px-2 py-1 text-xs rounded border border-gray-300 font-mono" />
            )}
            <div className="flex items-center gap-1.5">
              <Select value={r.op} onChange={(e) => setRule(i, { op: e.target.value as ConditionRule['op'] })} aria-label="Operator" className="!py-1 !text-xs flex-1">
                {CONDITION_OPS.map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
              </Select>
              {showValue && (meta?.boolean ? (
                <Select value={r.value ?? 'true'} onChange={(e) => setRule(i, { value: e.target.value })} aria-label="Value" className="!py-1 !text-xs flex-1">
                  <option value="true">true</option>
                  <option value="false">false</option>
                </Select>
              ) : r.field === 'has_tag' && tags.length > 0 ? (
                <Select value={r.value ?? ''} onChange={(e) => setRule(i, { value: e.target.value })} aria-label="Tag" className="!py-1 !text-xs flex-1">
                  <option value="">Select tag…</option>
                  {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              ) : r.field === 'stage_is' && stages.length > 0 ? (
                <Select value={r.value ?? ''} onChange={(e) => setRule(i, { value: e.target.value })} aria-label="Stage" className="!py-1 !text-xs flex-1">
                  <option value="">Select stage…</option>
                  {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              ) : (
                <input value={r.value ?? ''} onChange={(e) => setRule(i, { value: e.target.value })} placeholder={r.field === 'relation' ? 'none / pending_out / first…' : 'value'} aria-label="Value" className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-gray-300" />
              ))}
            </div>
          </div>
        );
      })}
      <Button variant="secondary" size="sm" onClick={add} type="button"><Plus className="w-3.5 h-3.5" /> Add rule</Button>
    </div>
  );
}
