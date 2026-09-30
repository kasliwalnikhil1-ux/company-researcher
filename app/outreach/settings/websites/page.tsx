'use client';

// Settings → Websites (web-chat-PRD.md §12): one website inbox per site. List + create; everything else on /websites/[id].

import { useState } from 'react';
import Link from 'next/link';
import { Globe, Plus } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { useClients } from '@/lib/outreach/queries';
import { useCreateInbox, useWebchatInboxes } from '@/lib/outreach/webchat';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Modal, Select, Spinner, timeAgo, useToast } from '@/components/outreach/ui';
import { Note, SettingsFrame } from '@/components/outreach/settings/shared';

export default function WebsitesPage() {
  const { workspace, isManager } = useWorkspace();
  const ws = workspace?.id ?? null;
  const q = useWebchatInboxes(ws);
  const clients = useClients(ws);
  const create = useCreateInbox(ws);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [domains, setDomains] = useState('');
  const [client, setClient] = useState('');

  const submit = async () => {
    try {
      const r = await create.mutateAsync({ name: name.trim(), domains: domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean), client_id: client || null });
      setOpen(false); setName(''); setDomains(''); setClient('');
      toast.show('Website added. Install the snippet to go live.');
      window.location.href = `/outreach/settings/websites/${r.id}?tab=install`;
    } catch (e) { toast.show(parseError(e).message, 'error'); }
  };

  return (
    <SettingsFrame min="member">
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Websites</h2>
            <p className="text-sm text-gray-500">A chat widget per website. Conversations land in the inbox next to LinkedIn, email, WhatsApp and Instagram; a visitor who matches a lead stops their sequences like any other reply.</p>
          </div>
          {isManager && <Button onClick={() => setOpen(true)}><Plus className="w-4 h-4 mr-1" />Add website</Button>}
        </div>
        {q.isLoading && <Spinner />}
        {q.error && <ErrorBox message={parseError(q.error).message} />}
        {q.data && q.data.length === 0 && <EmptyState icon={<Globe className="w-6 h-6" />} title="No websites yet" description="Add your site, paste one script tag, and start answering visitors from the inbox." action={isManager ? <Button onClick={() => setOpen(true)}>Add website</Button> : undefined} />}
        {q.data && q.data.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {q.data.map((i) => {
              const seen = Object.entries(i.installed_origins ?? {}).sort((a, b) => (a[1] < b[1] ? 1 : -1))[0];
              return (
                <Link key={i.id} href={`/outreach/settings/websites/${i.id}`} className="block">
                  <Card className="hover:border-indigo-300 transition-colors h-full">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap"><span className="font-medium text-gray-900 truncate">{i.name}</span>{!i.is_active && <Badge tone="gray">Off</Badge>}{i.ai_enabled && i.settings.ai.mode !== 'off' && <Badge tone="indigo">AI {i.settings.ai.mode === 'first' ? 'first' : 'after hours'}</Badge>}{i.availability.online ? <Badge tone="green">Online</Badge> : <Badge tone="gray">Offline</Badge>}</div>
                        <div className="text-xs text-gray-500 mt-0.5 truncate">{i.allowed_domains.join(', ') || 'No domains yet'}</div>
                      </div>
                      <div className="w-8 h-8 rounded-full flex-shrink-0" style={{ background: i.settings.appearance.accent }} aria-hidden="true" />
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                      {[['Open', i.stats.open], ['Waiting', i.stats.unassigned], ['Today', i.stats.today], ['Visitors 30d', i.stats.visitors_30d]].map(([l, v]) => <div key={String(l)}><div className="text-lg font-semibold text-gray-900 tabular-nums">{v as number}</div><div className="text-[11px] text-gray-500">{l}</div></div>)}
                    </div>
                    <div className="mt-3 text-xs text-gray-500">{seen ? <>Seen on <span className="text-gray-700">{seen[0].replace(/^https?:\/\//, '')}</span> {timeAgo(seen[1])}</> : <span className="text-amber-700">Not installed yet</span>} · {i.members.length} collaborator{i.members.length === 1 ? '' : 's'}</div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
        <Note>Plans: Core 1 website, Pro 3, Agency unlimited (one per client workspace). AI answers draw from the workspace&apos;s AI allowance.</Note>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Add a website" size="md" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={submit} loading={create.isPending} disabled={!name.trim()}>Create</Button></>}>
        <div className="space-y-3">
          <Input label="Website name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" maxLength={80} />
          <Input label="Domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="acme.com, *.acme.com" hint="Comma-separated. Use *.example.com for every subdomain. localhost can be allowed later under Security." />
          {(clients.data?.length ?? 0) > 0 && (
            <Select label="Client (agency workspaces)" value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">Whole workspace</option>
              {clients.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
        </div>
      </Modal>
      {toast.node}
    </SettingsFrame>
  );
}
