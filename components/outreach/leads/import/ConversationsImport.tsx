'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSenders } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { Button, ErrorBox, Select } from '@/components/outreach/ui';
import { senderLabel } from './SenderPicker';
import { EMPTY_COMMON, ImportOptions, importStartedMessage, useImportCreator, type ImportCommon } from './ImportOptions';
import { formatNumber, type ToastFn } from '../helpers';

export function ConversationsImport({ toast, onCreated }: { toast: ToastFn; onCreated: () => void }) {
  const { workspace } = useWorkspace();
  const ws = workspace?.id;
  const senders = useSenders(ws);
  const linkedIn = (senders.data ?? []).filter((s) => s.provider === 'LINKEDIN');
  const create = useImportCreator();
  const [senderId, setSenderId] = useState('');
  const [onlyReplied, setOnlyReplied] = useState(true);
  const [common, setCommon] = useState<ImportCommon>(EMPTY_COMMON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // How many LinkedIn conversations have no lead yet (the rows this import looks at).
  const countQ = useQuery({
    queryKey: ['outreach', ws ?? '', 'conversations-without-lead', senderId], enabled: !!ws,
    queryFn: async () => {
      let q = supabase.from('outreach_chats').select('id', { count: 'exact', head: true }).eq('workspace_id', ws!).is('lead_id', null).eq('provider', 'LINKEDIN');
      if (senderId) q = q.eq('sender_id', senderId);
      const { count, error: err } = await q;
      if (err) throw parseError(err);
      return count ?? 0;
    },
  });

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r = await create({ kind: 'conversations', sender_id: senderId || null, fields: { only_replied: onlyReplied } }, common);
      const m = importStartedMessage('Creating leads from conversations. This takes a minute or two.', r);
      toast(m.message, m.type);
      onCreated();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-600 flex items-start gap-1.5 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span><span className="font-medium text-gray-800">Cost and speed:</span> free and fast. No LinkedIn call is made. Leads are created from conversations that are already synced, and each conversation is linked to its new lead. Up to 2,000 per run, newest first.</span>
      </p>
      <Select label="Sender" value={senderId} onChange={(e) => setSenderId(e.target.value)}>
        <option value="">All LinkedIn senders</option>
        {linkedIn.map((s) => <option key={s.id} value={s.id}>{senderLabel(s)}</option>)}
      </Select>
      <label className="flex items-start gap-2.5 text-sm text-gray-800 cursor-pointer">
        <input type="checkbox" checked={onlyReplied} onChange={(e) => setOnlyReplied(e.target.checked)} className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
        <span>Only conversations where they replied<span className="block text-xs text-gray-500">Leaves out threads where only the sender wrote, such as old unanswered messages.</span></span>
      </label>
      <p className="text-xs text-gray-600">
        {countQ.isLoading ? 'Counting conversations without a lead…' : countQ.error ? `Could not count conversations: ${parseError(countQ.error).message}` : <><span className="font-medium text-gray-900 tabular-nums">{formatNumber(countQ.data)}</span> LinkedIn conversation{countQ.data === 1 ? '' : 's'} without a lead{senderId ? ' for this sender' : ''}{onlyReplied ? '. Fewer will be imported, because only threads with a reply count.' : '.'}</>}
      </p>
      <ImportOptions kind="conversations" value={common} onChange={setCommon} />
      {error && <ErrorBox message={error} />}
      <Button onClick={submit} loading={busy} disabled={countQ.data === 0}>Create leads</Button>
    </div>
  );
}
