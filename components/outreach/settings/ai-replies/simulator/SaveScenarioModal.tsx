'use client';

import { useState } from 'react';
import type { Scenario } from '@/lib/outreach/aiReplies';
import { Button, ErrorBox, Input, Modal } from '@/components/outreach/ui';
import { DECISION_LABEL } from './simModel';

/** Mount with a fresh `key` each time it opens. */
export default function SaveScenarioModal({ onClose, data, defaultName, loading, error, onSave, stageLabel }: {
  onClose: () => void;
  data: { turns: Scenario['turns']; expected: Scenario['expected'] };
  defaultName: string;
  loading: boolean;
  error: string | null;
  onSave: (name: string) => void;
  stageLabel: (k: string | null | undefined) => string;
}) {
  const [name, setName] = useState(defaultName);
  const ok = name.trim().length > 0 && data.expected.length > 0;

  return (
    <Modal open onClose={onClose} title="Save as a test conversation" size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button><Button loading={loading} disabled={!ok} onClick={() => onSave(name.trim())}>Save</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-gray-700">
          The conversation is kept with what the AI decided at each step. Run the saved set after a prompt change to see any step that now
          decides differently or lands in another stage.
        </p>
        <Input label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
        <div>
          <div className="text-xs font-medium text-gray-600 mb-1">What we&apos;ll expect ({data.turns.length} lines)</div>
          {data.expected.length ? (
            <ol className="text-sm text-gray-700 space-y-0.5 list-decimal pl-5">
              {data.expected.map((e) => (
                <li key={e.after_turn}>After line {e.after_turn + 1}: {DECISION_LABEL[e.decision]}{e.stage_after ? `, stage ${stageLabel(e.stage_after)}` : ''}</li>
              ))}
            </ol>
          ) : <p className="text-sm text-gray-500">Get at least one AI reply first.</p>}
        </div>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}
