'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useClients, useLists, useSenders, useTags } from '@/lib/outreach/queries';
import { callFn, parseError } from '@/lib/outreach/api';
import { Button, ErrorBox, Select } from '@/components/outreach/ui';
import { Info } from 'lucide-react';
import { TagMultiSelect } from './TagMultiSelect';
import { SenderPicker, importableSenders } from './SenderPicker';
import { formatNumber, type ToastFn } from '../helpers';

export function RelationsImport({ toast, onCreated }: { toast: ToastFn; onCreated: () => void }) {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const senders = useSenders(workspace?.id);
  const clients = useClients(workspace?.id);
  const lists = useLists(workspace?.id);
  const tags = useTags(workspace?.id);
  const ready = importableSenders(senders.data);
  const [senderId, setSenderId] = useState('');
  const [clientId, setClientId] = useState('');
  const [listId, setListId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sender = ready.find((s) => s.id === senderId);
  const hours = sender?.connections_count ? Math.ceil(sender.connections_count / 100) : null;

  const create = async () => {
    if (!workspace || !senderId) return;
    setBusy(true); setError(null);
    try {
      await callFn('imports-create', { workspace_id: workspace.id, kind: 'relations', sender_id: senderId, client_id: clientId || null, list_id: listId || null, tag_ids: tagIds });
      qc.invalidateQueries({ queryKey: qk.imports(workspace.id) });
      toast('Connections import started');
      setSenderId(''); setTagIds([]);
      onCreated();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <SenderPicker senders={ready} allSenders={senders.data ?? []} value={senderId} onChange={setSenderId} hint="Imports this account's existing 1st-degree connections as leads. Their relation state is set to connected for this sender." />
      {sender && (
        <p className="text-xs text-gray-600 flex items-start gap-1.5"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          {sender.connections_count != null ? <>About {formatNumber(sender.connections_count)} connections</> : <>Connection count unknown</>}; the job reads one page of up to 100 connections per hour{hours ? <>, so expect roughly {hours} hour{hours === 1 ? '' : 's'}</> : null}. It does not consume invite or message budget.
        </p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Select label="Client (optional)" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">No client</option>
          {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select label="Add to list (optional)" value={listId} onChange={(e) => setListId(e.target.value)}>
          <option value="">No list</option>
          {lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
      </div>
      <TagMultiSelect tags={tags.data ?? []} value={tagIds} onChange={setTagIds} />
      {error && <ErrorBox message={error} />}
      <Button onClick={create} loading={busy} disabled={!senderId}>Import connections</Button>
    </div>
  );
}
