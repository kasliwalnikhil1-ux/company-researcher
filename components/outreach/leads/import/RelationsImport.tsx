'use client';

import { useState } from 'react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSenders } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { Button, ErrorBox } from '@/components/outreach/ui';
import { Info } from 'lucide-react';
import { SenderPicker, importableSenders } from './SenderPicker';
import { EMPTY_COMMON, ImportOptions, importStartedMessage, useImportCreator, type ImportCommon } from './ImportOptions';
import { formatNumber, type ToastFn } from '../helpers';

export function RelationsImport({ toast, onCreated }: { toast: ToastFn; onCreated: () => void }) {
  const { workspace } = useWorkspace();
  const senders = useSenders(workspace?.id);
  const ready = importableSenders(senders.data);
  const createImport = useImportCreator();
  const [senderId, setSenderId] = useState('');
  const [common, setCommon] = useState<ImportCommon>(EMPTY_COMMON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sender = ready.find((s) => s.id === senderId);
  const hours = sender?.connections_count ? Math.ceil(sender.connections_count / 100) : null;

  const create = async () => {
    if (!workspace || !senderId) return;
    setBusy(true); setError(null);
    try {
      const r = await createImport({ kind: 'relations', sender_id: senderId, name: `Connections of ${sender?.display_name ?? 'sender'}` }, common);
      const m = importStartedMessage('Connections import started.', r);
      toast(m.message, m.type);
      setSenderId(''); setCommon((c) => ({ ...c, tagIds: [], cadence: '' }));
      onCreated();
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <SenderPicker senders={ready} allSenders={senders.data ?? []} value={senderId} onChange={setSenderId} hint="Imports this account's existing 1st-degree connections as leads. Their relation state is set to connected for this sender." />
      {sender && (
        <p className="text-xs text-gray-600 flex items-start gap-1.5"><Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>{sender.connections_count != null ? <>About {formatNumber(sender.connections_count)} connections</> : <>Connection count unknown</>}. The job reads one page of up to 100 connections per hour{hours ? <>, so expect roughly {hours} hour{hours === 1 ? '' : 's'}</> : null}. It does not use invite, message or profile-view allowance.</span>
        </p>
      )}
      <ImportOptions kind="relations" value={common} onChange={setCommon} />
      {error && <ErrorBox message={error} />}
      <Button onClick={create} loading={busy} disabled={!senderId}>Import connections</Button>
    </div>
  );
}
