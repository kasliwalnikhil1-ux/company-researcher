'use client';

import type { Sender } from '@/lib/outreach/types';
import { Input, Select } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { EXAMPLES } from './simModel';
import type { ExampleProspect, SimLead } from './simModel';

export type PromptSource = 'saved' | 'draft' | 'version';

export default function SimSetup({ testingLabel, source, sources, onSource, senders, senderId, onSender, lead, onLead, onExample, activeExample, disabled }: {
  testingLabel: string;
  source: PromptSource;
  sources: Array<{ key: PromptSource; label: string; disabled?: boolean; hint?: string }>;
  onSource: (s: PromptSource) => void;
  senders: Sender[];
  senderId: string;
  onSender: (id: string) => void;
  lead: SimLead;
  onLead: (l: SimLead) => void;
  onExample: (e: ExampleProspect) => void;
  activeExample: string | null;
  disabled?: boolean;
}) {
  const field = (k: keyof SimLead, label: string, placeholder: string) => (
    <Input label={label} value={lead[k]} placeholder={placeholder} maxLength={120} disabled={disabled} onChange={(e) => onLead({ ...lead, [k]: e.target.value })} />
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-gray-700">Testing the <span className="font-medium">{testingLabel}</span> prompt with</span>
        <div role="radiogroup" aria-label="Which prompt to test" className="inline-flex flex-wrap rounded-lg border border-gray-300 p-0.5 bg-gray-50">
          {sources.map((s) => (
            <button key={s.key} type="button" role="radio" aria-checked={source === s.key} disabled={s.disabled || disabled} title={s.hint}
              onClick={() => onSource(s.key)}
              className={cn('px-3 py-1 text-sm rounded-md disabled:opacity-40 disabled:cursor-not-allowed', source === s.key ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-900')}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-xs font-medium text-gray-600 mb-1.5">Start from an example prospect</div>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button key={e.key} type="button" disabled={disabled} onClick={() => onExample(e)} aria-pressed={activeExample === e.key}
              className={cn('px-3 py-1.5 text-xs rounded-full border disabled:opacity-50', activeExample === e.key ? 'border-indigo-400 bg-indigo-50 text-indigo-900' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')}>
              {e.title}
            </button>
          ))}
        </div>
      </div>

      <details className="rounded-lg border border-gray-200">
        <summary className="px-3 py-2 text-sm text-gray-700 cursor-pointer select-none">Lead and sender (optional)</summary>
        <div className="px-3 pb-3 pt-1 grid sm:grid-cols-2 gap-3">
          {field('full_name', 'Name', 'Priya Nair')}
          {field('title', 'Title', 'Marketing Director')}
          {field('company', 'Company', 'Brightline Foods')}
          {field('location', 'Location', 'Mumbai, India')}
          <Select label="Sender (LinkedIn)" value={senderId} disabled={disabled} onChange={(e) => onSender(e.target.value)}>
            <option value="">Any sender</option>
            {senders.map((s) => <option key={s.id} value={s.id}>{s.display_name ?? s.public_identifier ?? 'Unnamed sender'}</option>)}
          </Select>
          <p className="text-xs text-gray-500 self-end pb-2">The sender fills in {'{{sender.first_name}}'} and similar fields in your prompt.</p>
        </div>
      </details>
    </div>
  );
}
