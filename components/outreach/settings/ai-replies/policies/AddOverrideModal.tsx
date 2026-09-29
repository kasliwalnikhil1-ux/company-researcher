'use client';

import { useState } from 'react';
import { Button, Modal, SearchableSelect, Select, type SelectOption } from '@/components/outreach/ui';
import type { PolicyScope } from '@/lib/outreach/aiReplies';
import type { PolicyTarget } from './PolicyEditor';

type OverrideScope = Exclude<PolicyScope, 'workspace'>;

/** Pick a client, sequence or sender to give its own reply policy. Entities that already have one are left out. */
export default function AddOverrideModal({ entities, taken, onPick, onClose }: {
  entities: Record<OverrideScope, Array<{ id: string; label: string; hint?: string }>>;
  taken: Set<string>;
  onPick: (t: PolicyTarget) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<OverrideScope>('sequence');
  const [id, setId] = useState('');
  const options: SelectOption[] = entities[scope].filter((e) => !taken.has(`${scope}:${e.id}`)).map((e) => ({ value: e.id, label: e.label, hint: e.hint }));
  const picked = entities[scope].find((e) => e.id === id);
  return (
    <Modal open onClose={onClose} size="sm" title="Add an override"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!picked} onClick={() => picked && onPick({ scope, scopeId: picked.id, label: picked.label })}>Continue</Button></>}>
      <div className="space-y-3">
        <Select label="Applies to" value={scope} onChange={(e) => { setScope(e.target.value as OverrideScope); setId(''); }}>
          <option value="sequence">A sequence</option>
          <option value="sender">A sender</option>
          <option value="client">A client</option>
        </Select>
        <SearchableSelect label={scope === 'sequence' ? 'Sequence' : scope === 'sender' ? 'Sender' : 'Client'} value={id} onChange={setId} options={options}
          placeholder={options.length ? 'Choose…' : 'Nothing left to add'} disabled={!options.length} />
        <p className="text-xs text-gray-500">Only the fields you fill in are overridden; the rest keep following the workspace policy.</p>
      </div>
    </Modal>
  );
}
