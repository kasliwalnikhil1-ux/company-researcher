'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { LayoutTemplate } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk, useClients } from '@/lib/outreach/queries';
import { BackLink, Button, Card, EmptyState, ErrorBox, Input, Select } from '@/components/outreach/ui';
import TemplatePicker from '@/components/outreach/sequences/TemplatePicker';

export default function NewSequencePage() {
  const { workspace, isManager, suspended } = useWorkspace();
  const ws = workspace?.id ?? null;
  const router = useRouter();
  const qc = useQueryClient();
  const clients = useClients(ws);
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);

  if (!isManager || suspended) {
    return <EmptyState title="Managers only" description="Ask a workspace owner or manager to create sequences." action={<Link href="/outreach/sequences"><Button variant="secondary">Back to sequences</Button></Link>} />;
  }

  const create = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!ws || !name.trim()) return;
    setBusy(true); setError(null);
    try {
      const id = await rpc<string>('create_sequence', { p_workspace: ws, p_name: name.trim(), p_client_id: client || null });
      qc.invalidateQueries({ queryKey: qk.sequences(ws) });
      router.push(`/outreach/sequences/${id}`);
    } catch (err) { setError(parseError(err).message); setBusy(false); }
  };

  return (
    <div className="max-w-lg mx-auto">
      <BackLink href="/outreach/sequences">Back to sequences</BackLink>
      <Card title="New sequence">
        <form onSubmit={create} className="space-y-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Founders — invite + 2 follow-ups" autoFocus required />
          <Select label="Client (optional)" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">No client</option>
            {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {error && <ErrorBox message={error} />}
          <div className="flex justify-end gap-2">
            <Link href="/outreach/sequences"><Button type="button" variant="secondary">Cancel</Button></Link>
            <Button type="submit" loading={busy} disabled={!name.trim()}>Create and open builder</Button>
          </div>
        </form>
      </Card>
      <div className="mt-4 rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">Not sure where to start?</p>
          <p className="text-xs text-gray-500">Pick a ready-made flow: connect, follow up, rotate senders or nurture. You can change every step afterwards.</p>
        </div>
        <Button type="button" variant="secondary" onClick={() => setTemplateOpen(true)}><LayoutTemplate className="w-4 h-4" /> Start from a template</Button>
      </div>
      <TemplatePicker open={templateOpen} onClose={() => setTemplateOpen(false)} />
    </div>
  );
}
