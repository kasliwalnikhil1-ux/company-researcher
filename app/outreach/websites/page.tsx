'use client';

// Website agents (web-chat-PRD.md §12): one website inbox per site. List + create; everything else on /websites/[id].

import { useState } from 'react';
import Link, { modeHref } from '@/lib/outreach/nav';
import { Globe, Plus } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { useClients } from '@/lib/outreach/queries';
import { useCreateInbox, useWebchatInboxes } from '@/lib/outreach/webchat';
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Modal, Select, Spinner, timeAgo, useToast } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { MemberAvatar } from '@/components/outreach/members';
import WebsitesFrame, { WEBSITES_PATH } from '@/components/outreach/settings/websites/WebsitesFrame';
import { websiteHubMode, websiteModeText } from '@/lib/outreach/aiHub';
import { usePlanFeature } from '@/lib/outreach/billing';

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
  // how many websites the plan allows (null = no limit, also while billing is not enforced)
  const sites = usePlanFeature(ws, 'webchat_inboxes');
  const atLimit = sites.limit != null && (q.data?.length ?? 0) >= sites.limit;

  const submit = async () => {
    try {
      const r = await create.mutateAsync({ name: name.trim(), domains: domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean), client_id: client || null });
      setOpen(false); setName(''); setDomains(''); setClient('');
      toast.show('Website added. Install the snippet to go live.');
      window.location.href = modeHref(`${WEBSITES_PATH}/${r.id}?tab=install`);
    } catch (e) { toast.show(parseError(e).message, 'error'); }
  };

  return (
    <WebsitesFrame
      subtitle={<span className="block max-w-3xl">A chat widget per website. Conversations land in the inbox next to LinkedIn, email, WhatsApp and Instagram; a visitor who matches a lead stops their sequences like any other reply.</span>}
      actions={isManager && <Button onClick={() => setOpen(true)}><Plus className="w-4 h-4 mr-1" />Add website</Button>}>
      <div className="space-y-5">
        {q.isLoading && <Spinner />}
        {q.error && <ErrorBox message={parseError(q.error).message} />}
        {q.data && q.data.length === 0 && <EmptyState icon={<Globe className="w-6 h-6" />} title="No websites yet" description="Add your site, paste one script tag, and start answering visitors from the inbox." action={isManager ? <Button onClick={() => setOpen(true)}>Add website</Button> : undefined} />}
        {q.data && q.data.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {q.data.map((i) => {
              const seen = Object.entries(i.installed_origins ?? {}).sort((a, b) => (a[1] < b[1] ? 1 : -1))[0];
              const aiOn = websiteHubMode({ ai_enabled: i.ai_enabled, mode: i.settings.ai.mode }).mode !== 'off';
              const { accent, logo_url } = i.settings.appearance;
              const stats: Array<{ label: string; value: number; tip: string; warn?: boolean }> = [
                { label: 'Open', value: i.stats.open, tip: 'Conversations still open or pending a reply on this website.' },
                { label: 'Waiting', value: i.stats.unassigned, tip: 'Open conversations nobody is assigned to yet. These need someone to pick them up.', warn: i.stats.unassigned > 0 },
                { label: 'Today', value: i.stats.today, tip: 'New conversations started today (since midnight UTC).' },
                { label: 'Visitors', value: i.stats.visitors_30d, tip: 'Visitors seen on the website in the last 30 days, whether or not they chatted.' },
              ];
              return (
                <Link key={i.id} href={`${WEBSITES_PATH}/${i.id}`} className="group block">
                  <Card className="h-full transition-all group-hover:border-indigo-300 group-hover:shadow-md">
                    <div className="flex items-start gap-3">
                      {/* the logo never gets a background tile; without one, a globe on a tint of the widget accent */}
                      {logo_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={logo_url} alt="" className="w-10 h-10 object-contain flex-shrink-0" />
                        : <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `color-mix(in srgb, ${accent} 12%, white)`, color: accent }} aria-hidden="true"><Globe className="w-5 h-5" /></div>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-900 truncate">{i.name}</span>
                          <span className="ml-auto flex items-center gap-1.5 text-xs text-gray-500 flex-shrink-0" title={i.availability.online ? 'A teammate is online to answer chats' : 'No teammate is online right now'}>
                            <span className={`w-2 h-2 rounded-full ${i.availability.online ? 'bg-green-500' : 'bg-gray-300'}`} />{i.availability.online ? 'Online' : 'Offline'}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5 truncate" title={i.allowed_domains.join(', ') || undefined}>{i.allowed_domains.join(', ') || 'No domains yet'}</div>
                        {(!i.is_active || aiOn) && (
                          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                            {!i.is_active && <Badge tone="gray">Widget off</Badge>}
                            {aiOn && <Badge tone="indigo">AI agent: {websiteModeText({ ai_enabled: i.ai_enabled, mode: i.settings.ai.mode })}</Badge>}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="mt-4 grid grid-cols-4 divide-x divide-gray-100 rounded-lg bg-gray-50/80 py-2.5">
                      {stats.map((s) => (
                        <div key={s.label} className="px-2 text-center cursor-help" title={s.tip}>
                          <div className={`text-xl font-semibold tabular-nums ${s.warn ? 'text-amber-600' : 'text-gray-900'}`}>{s.value}</div>
                          <div className="text-[11px] text-gray-500">{s.label}{s.label === 'Visitors' && <span className="text-gray-400"> · 30d</span>}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3 text-xs text-gray-500">
                      {seen
                        ? <span className="min-w-0 truncate" title={`Widget last loaded on ${seen[0]}`}><span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5 align-middle" />Seen on <span className="text-gray-700">{seen[0].replace(/^https?:\/\//, '')}</span> {timeAgo(seen[1])}</span>
                        : <span className="text-amber-700"><span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5 align-middle" />Not installed yet</span>}
                      <span className="flex items-center gap-1.5 flex-shrink-0" title={i.members.map((m) => m.name).join(', ') || 'No collaborators yet'}>
                        <span className="flex -space-x-1.5">
                          {i.members.slice(0, 3).map((m) => <span key={m.user_id} className="flex rounded-full ring-2 ring-white"><MemberAvatar userId={m.user_id} name={m.name} size={6} /></span>)}
                        </span>
                        {i.members.length} collaborator{i.members.length === 1 ? '' : 's'}
                      </span>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
        {!sites.loading && (
          <Note>
            {sites.limit == null ? 'Your plan has no limit on websites.' : `Your plan includes ${sites.limit} website${sites.limit === 1 ? '' : 's'}.`}
            {atLimit && sites.minPlanLabel && <> <Link href={sites.upgradeHref} className="font-medium text-indigo-700 hover:underline">{sites.minPlanLabel} has more</Link>.</>}
            {' '}AI answers draw from the workspace&apos;s AI allowance.
          </Note>
        )}
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
    </WebsitesFrame>
  );
}
