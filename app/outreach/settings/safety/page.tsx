'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSenders } from '@/lib/outreach/queries';
import { Badge, Card, ErrorBox, PageHeader, PageLoader, Spinner, StatusPill, Table, Td, Th } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import { ACTION_LABELS, PROVIDER_LABELS } from '@/components/outreach/senders/helpers';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { CONSENT_BASIS_HELP, CONSENT_BASIS_LABELS, CONSENT_BASIS_TONE } from '@/lib/outreach/channels';
import { CONSENT_BASES, type ActionType } from '@/lib/outreach/types';

export default function SafetySettingsPage() {
  const { workspace, role } = useWorkspace();
  const ws = workspace?.id;
  const senders = useSenders(role === 'client_viewer' ? null : ws);

  const withCaps = useMemo(() => (senders.data ?? []).filter((s) => s.status !== 'disabled'), [senders.data]);

  if (!workspace) return <PageLoader />;

  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <SettingsTabs />
      <div className="flex items-start gap-2 p-3 mb-6 rounded-lg bg-indigo-50 text-indigo-900 text-sm border border-indigo-100"><ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>Safety limits are enforced in the database, not just the UI: every action reserves its slot atomically, nothing lands on a round minute, and no cap can exceed the channel ceiling. You can only lower limits per sender: each sender’s Limits tab shows the cap that applies to it today.</span></div>

      <Card title="Consent">
        <div className="space-y-3 text-sm text-gray-700">
          <p><span className="font-medium text-gray-900">The WhatsApp rule:</span> a sequence may only start a WhatsApp conversation with someone who has a recorded reason to hear from you. No basis, no first message. The check runs when the message is planned and again when it is sent. Replies to people who write in are always allowed, and anyone who writes in on WhatsApp is recorded automatically.</p>
          <p>Instagram is different: consent is recorded and shown where known, but does not block anything. Instagram accounts are kept safe by the engagement ladder (follow, like, comment, then message) and the hourly limit instead.</p>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">The six bases</div>
            <ul className="space-y-2">
              {CONSENT_BASES.map((b) => (
                <li key={b} className="flex items-start gap-2">
                  <Badge tone={CONSENT_BASIS_TONE[b]} className="mt-0.5 whitespace-nowrap">{CONSENT_BASIS_LABELS[b]}</Badge>
                  <span className="text-gray-600">{CONSENT_BASIS_HELP[b]}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs">“Attested at import” is the weakest basis. It records who attested and when, but nothing from the person themselves, so it is flagged amber everywhere it appears and the Consent report warns when more than 30% of the people contacted rely on it.</p>
          <p className="text-xs text-gray-500">Anyone who replies with “stop”, “unsubscribe” or the like has their consent revoked and their number suppressed at once; live sequences on that channel exit. The <Link href="/outreach/reports?tab=consent" className="text-indigo-600 hover:underline">Consent report</Link> lists everyone contacted on WhatsApp with the basis and evidence, ready to export.</p>
        </div>
      </Card>

      {role !== 'client_viewer' && (
        <Card className="mt-6" title="Manual caps per sender" actions={<span className="text-xs text-gray-400">edit on each sender’s Limits tab</span>}>
          {senders.isLoading ? <Spinner /> : senders.isError ? <ErrorBox message={(senders.error as Error).message} /> : withCaps.length === 0 ? <div className="text-sm text-gray-500 py-4">No senders yet.</div> : (
            <Table>
              <thead><tr><Th>Sender</Th><Th>Channel</Th><Th>Status</Th><Th>Level</Th><Th>Manual caps</Th><Th></Th></tr></thead>
              <tbody>
                {withCaps.map((s) => {
                  const caps = Object.entries(s.manual_caps ?? {}).filter(([, v]) => typeof v === 'number') as Array<[string, number]>;
                  return (
                    <tr key={s.id}>
                      <Td className="font-medium text-gray-900">{s.display_name ?? 'Unnamed sender'}</Td>
                      <Td><span className="inline-flex items-center gap-1.5 text-xs text-gray-700"><ProviderLogo provider={s.provider} className="w-3.5 h-3.5" /> {PROVIDER_LABELS[s.provider]}</span></Td>
                      <Td><StatusPill status={s.status} reason={s.status_reason} /></Td>
                      <Td><Badge tone="indigo">L{s.warmup_level}</Badge></Td>
                      <Td>{caps.length === 0 ? <span className="text-gray-400 text-xs">automatic</span> : <div className="flex flex-wrap gap-1">{caps.map(([k, v]) => <Badge key={k} tone="gray">{ACTION_LABELS[k as ActionType] ?? k}: {v}/day</Badge>)}</div>}</Td>
                      <Td className="text-right"><Link href={`/outreach/senders/${s.id}?tab=Limits`} className="text-sm text-indigo-600 hover:underline whitespace-nowrap">Limits →</Link></Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}
