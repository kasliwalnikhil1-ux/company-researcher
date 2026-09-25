'use client';

// The Senders and Settings tabs of the builder. Both edit the draft: changes are saved or published from the top bar.
import { useState } from 'react';
import { Check, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Toggle } from '@/components/outreach/ui';
import type { Client, Sender } from '@/lib/outreach/types';
import type { Draft } from './draft';
import PoolSelector from './PoolSelector';
import { ProjectionModal } from './Projection';
import SequenceSettingsPanel from './SequenceSettingsPanel';
import { ASSIGNMENT_OPTIONS, type SetPoolResult } from './publishTypes';

/** Scrollable page-like area under the tabs, shared by every non-canvas tab. */
export function TabPage({ title, subtitle, wide, children }: { title: string; subtitle?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div role="tabpanel" className="flex-1 min-h-0 overflow-y-auto">
      <div className={cn('mx-auto px-4 py-5 md:px-6', wide ? 'max-w-5xl' : 'max-w-2xl')}>
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function Section({ title, help, children }: { title: string; help?: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {help && <p className="text-xs text-gray-500 mt-0.5">{help}</p>}
      </div>
      {children}
    </section>
  );
}

interface SendersProps {
  sequenceId: string;
  draft: Draft;
  senders: Sender[];
  readOnly: boolean;
  publishMode: boolean;
  dirty: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onPoolApplied: (pool: string[], result: SetPoolResult) => void;
  onSave: () => Promise<boolean>;
}

export function SendersTab({ sequenceId, draft, senders, readOnly, publishMode, dirty, onChange, onPoolApplied, onSave }: SendersProps) {
  const [projOpen, setProjOpen] = useState(false);
  return (
    <TabPage title="Senders" subtitle="Who sends this sequence, how leads are shared between them, and when they send.">
      <div className="space-y-4">
        <Section title="Sender pool" help={publishMode ? 'This sequence has leads, so a pool change is applied at once: you review who moves before it is saved.' : 'Pick the accounts that send this sequence. Only connected senders can be added.'}>
          <PoolSelector pool={draft.pool} senders={senders} onChange={(pool) => onChange({ pool })} disabled={readOnly} live={publishMode ? { sequenceId, onApplied: onPoolApplied } : undefined} />
        </Section>

        <Section title="How leads are shared" help="Which sender each new lead goes to.">
          <ul role="radiogroup" aria-label="Assignment rule" className="space-y-1">
            {ASSIGNMENT_OPTIONS.map((o) => {
              const on = o.value === draft.assignment;
              return (
                <li key={o.value}>
                  <button type="button" role="radio" aria-checked={on} disabled={readOnly} onClick={() => onChange({ assignment: o.value })} className={cn('w-full text-left px-3 py-2 rounded-lg flex items-start gap-2 border transition-colors disabled:opacity-60', on ? 'border-indigo-300 bg-indigo-50/60' : 'border-transparent hover:bg-gray-50')}>
                    <Check className={cn('w-4 h-4 mt-0.5 flex-shrink-0', on ? 'text-indigo-600' : 'text-transparent')} />
                    <span className="min-w-0"><span className="block text-sm text-gray-900">{o.label}</span><span className="block text-xs text-gray-500">{o.help}</span></span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title="Sending hours" help="With the sender schedule on, steps go out only in each sender's working hours and days. Off, they go out whenever the sequence's own timing says.">
          <Toggle checked={draft.useSenderSchedule} onChange={(v) => onChange({ useSenderSchedule: v })} label="Use each sender's schedule" disabled={readOnly} />
        </Section>

        <Section title="How long will it take?" help="Estimate how long a number of leads takes to get through this sequence with the current pool.">
          <Button variant="secondary" size="sm" onClick={() => setProjOpen(true)}><TrendingUp className="w-4 h-4" /> Estimate</Button>
        </Section>
      </div>
      <ProjectionModal open={projOpen} onClose={() => setProjOpen(false)} sequenceId={sequenceId} beforeRun={dirty && !readOnly && !publishMode ? onSave : undefined} />
    </TabPage>
  );
}

export function SettingsTab({ draft, clients, readOnly, publishMode, onChange }: { draft: Draft; clients: Client[]; readOnly: boolean; publishMode: boolean; onChange: (patch: Partial<Draft>) => void }) {
  return (
    <TabPage title="Settings" subtitle="What happens on replies and out-of-office, what to wait for before the first step, the client and the AI brief.">
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <SequenceSettingsPanel draft={draft} clients={clients} onChange={onChange} disabled={readOnly} live={publishMode} />
      </div>
    </TabPage>
  );
}
