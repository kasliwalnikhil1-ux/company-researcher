'use client';

import { ChevronDown, Search } from 'lucide-react';
import { ESCALATION_LABEL, GATE_LABEL, MODE_LABEL, STATUS_LABEL, type RunStatus } from '@/lib/outreach/aiReplies';
import { SearchableSelect, Select } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { SINCE_OPTIONS, statusList, type RunFilterState } from './runsData';

const STATUSES = Object.keys(STATUS_LABEL) as RunStatus[];
const REASON_OPTIONS = [...Object.entries(ESCALATION_LABEL), ...Object.entries(GATE_LABEL)].map(([value, label]) => ({ value, label }));
const small = 'py-1.5 text-xs';

export default function ActivityFilters({ f, patch, reset, senders, sequences, stages }: {
  f: RunFilterState; patch: (p: Partial<RunFilterState>) => void; reset: () => void;
  senders: Array<{ id: string; label: string }>; sequences: Array<{ id: string; label: string }>; stages: Array<{ key: string; label: string }>;
}) {
  const st = statusList(f.status);
  const toggle = (s: RunStatus) => patch({ status: (st.includes(s) ? st.filter((x) => x !== s) : [...st, s]).join(',') });
  const active = (Object.keys(f) as Array<keyof RunFilterState>).some((k) => k !== 'since' && k !== 'q' && f[k]) || f.since !== '30';
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="relative block w-full sm:w-56">
        <span className="sr-only">Search loaded runs</span>
        <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
        <input value={f.q} onChange={(e) => patch({ q: e.target.value })} placeholder="Search lead or message…"
          className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      </label>

      <details className="relative">
        <summary className={cn('list-none cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border bg-white', st.length ? 'border-indigo-300 text-indigo-700' : 'border-gray-300 text-gray-700')}>
          {st.length ? `Status (${st.length})` : 'Any status'}<ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
        </summary>
        <div className="absolute z-30 mt-1 w-60 rounded-lg border border-gray-200 bg-white shadow-lg p-2 space-y-0.5">
          {STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 text-xs text-gray-700 cursor-pointer">
              <input type="checkbox" checked={st.includes(s)} onChange={() => toggle(s)} className="rounded border-gray-300 text-indigo-600" />{STATUS_LABEL[s]}
            </label>
          ))}
          {st.length > 0 && <button type="button" onClick={() => patch({ status: '' })} className="w-full text-left px-2 py-1 text-xs text-indigo-600 hover:underline">Clear</button>}
        </div>
      </details>

      <Select aria-label="Decision" value={f.decision} onChange={(e) => patch({ decision: e.target.value })} className={small}>
        <option value="">Any decision</option><option value="send">Reply</option><option value="escalate">Hand to a person</option><option value="no_reply">No reply</option>
      </Select>
      <Select aria-label="Mode" value={f.mode} onChange={(e) => patch({ mode: e.target.value })} className={small}>
        <option value="">Any mode</option>{(['draft', 'autopilot'] as const).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
      </Select>
      <SearchableSelect aria-label="Sender" className="w-44" value={f.sender_id} onChange={(v) => patch({ sender_id: v })} emptyOption="Any sender"
        placeholder="Any sender" options={senders.map((s) => ({ value: s.id, label: s.label }))} />
      <SearchableSelect aria-label="Sequence" className="w-44" value={f.sequence_id} onChange={(v) => patch({ sequence_id: v })} emptyOption="Any sequence"
        placeholder="Any sequence" options={sequences.map((s) => ({ value: s.id, label: s.label }))} />
      <Select aria-label="Stage" value={f.stage} onChange={(e) => patch({ stage: e.target.value })} className={small}>
        <option value="">Any stage</option>{stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </Select>
      <SearchableSelect aria-label="Reason" className="w-48" value={f.reason} onChange={(v) => patch({ reason: v })} emptyOption="Any reason" placeholder="Any reason" options={REASON_OPTIONS} />
      <Select aria-label="Since" value={f.since} onChange={(e) => patch({ since: e.target.value })} className={small}>
        {SINCE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </Select>
      {active && <button type="button" onClick={reset} className="px-2 py-1.5 text-xs text-gray-600 hover:text-gray-900 hover:underline">Reset filters</button>}
    </div>
  );
}
