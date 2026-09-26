'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useCeilings, useSenders, useWarmupCaps } from '@/lib/outreach/queries';
import { Badge, Card, ErrorBox, PageHeader, PageLoader, Spinner, StatusPill, Table, Td, Th } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import { ACTION_LABELS, BUDGET_ACTION_TYPES, PROVIDER_LABELS } from '@/components/outreach/senders/helpers';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { CHANNEL_PROVIDERS, CONSENT_BASIS_HELP, CONSENT_BASIS_LABELS, CONSENT_BASIS_TONE, WA_GOVERNOR_DEMOTION, WA_GOVERNOR_LEVELS } from '@/lib/outreach/channels';
import { CONSENT_BASES, type ActionType, type PlatformCeiling, type Provider, type WarmupCap } from '@/lib/outreach/types';
import { cn } from '@/lib/utils';

// 025 adds a `provider` column to both tables; rows without one are LinkedIn (the pre-channels seed).
type CeilingRow = PlatformCeiling & { provider?: Provider };
type WarmupRow = WarmupCap & { provider?: Provider };
const rowProvider = (r: { provider?: Provider }) => r.provider ?? 'LINKEDIN';

const PAUSE_RULES: Array<{ condition: string; effect: string; resume: string }> = [
  { condition: 'Health score < 50', effect: 'Sender auto-paused for 24h (paused_until)', resume: 'Next health recompute scores ≥ 50' },
  { condition: 'Health 50–69', effect: 'All daily caps scaled ×0.6', resume: 'Health recompute ≥ 70' },
  { condition: '≥3 × HTTP 429/500 from the channel within 1 hour', effect: 'Sender auto-paused for 24h', resume: 'Automatic after 24h' },
  { condition: 'LinkedIn “cannot resend yet” on an invite', effect: 'Invitations blocked until next Monday (sender-local)', resume: 'Automatic' },
  { condition: 'Instagram: “we suspect automated behaviour” warning', effect: 'One warm-up level lost and outreach paused for 48h', resume: 'Automatic after 48h, or a manager clicks Resume anyway' },
  { condition: 'Instagram: 10 metered actions in the same hour', effect: 'The rest of the hour’s actions move to the next hour', resume: 'Automatic at the top of the hour' },
  { condition: 'WhatsApp / Instagram account just connected', effect: 'Quiet period: no outreach for 24h (replies still go out)', resume: 'Automatic' },
  { condition: 'WhatsApp: a block is detected', effect: 'The number drops one governor level straight away', resume: 'Climbs back as the reply rate recovers' },
  { condition: 'Sender status ≠ ok (credentials, error, connecting)', effect: 'All actions held — they stay queued', resume: 'Status returns to ok' },
  { condition: 'Manual pause', effect: 'status = paused; planner skips the sender', resume: 'A manager clicks Resume' },
  { condition: 'Workspace suspended (billing)', effect: 'All senders paused, workspace read-only', resume: 'Subscription active again' },
];

const WARMUP_INTRO: Record<Provider, string> = {
  LINKEDIN: 'Every LinkedIn sender starts at level 0 (mailboxes start at 3). A level is gained after 14 consecutive days at health ≥ 85; accounts with fewer than 150 connections (or unknown) stay at level 0 for at least 28 days.',
  INSTAGRAM: 'Every Instagram account starts at level 0, where it can follow, like and view profiles but not send direct messages. A level is gained after 14 consecutive days at health ≥ 85. Every level keeps to 10 metered actions an hour and to a daily total for all metered actions together.',
  WHATSAPP: 'WhatsApp numbers start at level 0 (2 new conversations a day). Levels follow the reply rate, not time: the governor promotes nightly and demotes at once on a block or a poor fortnight. Messages into existing conversations and replies are not limited by level.',
  GMAIL: '', OUTLOOK: '', IMAP: '',
};

export default function SafetySettingsPage() {
  const { workspace, role } = useWorkspace();
  const ws = workspace?.id;
  const ceilings = useCeilings();
  const warmup = useWarmupCaps();
  const senders = useSenders(role === 'client_viewer' ? null : ws);
  const [channel, setChannel] = useState<Provider>('LINKEDIN');

  const ceilingList = useMemo(() => ((ceilings.data ?? []) as CeilingRow[]).filter((c) => rowProvider(c) === channel && c.per_day < 100000).sort((a, b) => BUDGET_ACTION_TYPES.indexOf(a.action_type) - BUDGET_ACTION_TYPES.indexOf(b.action_type)), [ceilings.data, channel]);
  const warmupRows = useMemo(() => ((warmup.data ?? []) as WarmupRow[]).filter((w) => rowProvider(w) === channel), [warmup.data, channel]);
  const capTypes = useMemo(() => { const set = new Set<ActionType>(warmupRows.map((w) => w.action_type)); return BUDGET_ACTION_TYPES.filter((t) => set.has(t)); }, [warmupRows]);
  const levels = channel === 'WHATSAPP' ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5];
  const withCaps = useMemo(() => (senders.data ?? []).filter((s) => s.status !== 'disabled'), [senders.data]);

  if (!workspace) return <PageLoader />;

  const channelTabs = (
    <div className="flex flex-wrap gap-1.5 mb-3" role="tablist" aria-label="Channel">
      {CHANNEL_PROVIDERS.map((p) => (
        <button key={p} type="button" role="tab" aria-selected={channel === p} onClick={() => setChannel(p)}
          className={cn('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border', channel === p ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50')}>
          <ProviderLogo provider={p} className="w-3.5 h-3.5" /> {PROVIDER_LABELS[p]}
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <SettingsTabs />
      <div className="flex items-start gap-2 p-3 mb-6 rounded-lg bg-indigo-50 text-indigo-900 text-sm border border-indigo-100"><ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>Safety limits are enforced in the database, not just the UI: every action reserves budget atomically, nothing lands on a round minute, and no cap can exceed the platform ceiling. You can only lower limits per sender. Limits are per channel: pick one below.</span></div>

      {channelTabs}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title={`${PROVIDER_LABELS[channel]} ceilings (read-only)`}>
          <p className="text-xs text-gray-500 mb-3">Hard maximums per sender per day, regardless of level or manual caps. Editable only by the platform operator.{channel === 'INSTAGRAM' ? ' On top of these, at most 10 metered actions an hour and 100 a day in total.' : ''}</p>
          {ceilings.isLoading ? <Spinner /> : ceilings.isError ? <ErrorBox message={(ceilings.error as Error).message} /> : ceilingList.length === 0 ? <div className="text-sm text-gray-500 py-2">No ceilings seeded for this channel yet.</div> : (
            <Table>
              <thead><tr><Th>Action</Th><Th className="text-right">Per day</Th><Th className="text-right">Per week</Th></tr></thead>
              <tbody>{ceilingList.map((c) => <tr key={c.action_type}><Td className="font-medium text-gray-900">{ACTION_LABELS[c.action_type] ?? c.action_type}</Td><Td className="text-right tabular-nums">{c.per_day}</Td><Td className="text-right tabular-nums">{c.per_week ?? <span className="text-gray-300">—</span>}</Td></tr>)}</tbody>
            </Table>
          )}
        </Card>

        <Card title="Pause and resume rules">
          <Table>
            <thead><tr><Th>Condition</Th><Th>Effect</Th><Th>Resume</Th></tr></thead>
            <tbody>{PAUSE_RULES.map((r) => <tr key={r.condition}><Td className="text-gray-900">{r.condition}</Td><Td>{r.effect}</Td><Td className="text-gray-600">{r.resume}</Td></tr>)}</tbody>
          </Table>
        </Card>
      </div>

      <Card className="mt-6" title={`${PROVIDER_LABELS[channel]} warm-up caps by level (read-only)`}>
        <p className="text-xs text-gray-500 mb-3">{WARMUP_INTRO[channel]}</p>
        {warmup.isLoading ? <Spinner /> : warmup.isError ? <ErrorBox message={(warmup.error as Error).message} /> : capTypes.length === 0 ? <div className="text-sm text-gray-500 py-2">No warm-up caps seeded for this channel yet.</div> : (
          <Table>
            <thead><tr><Th>Level</Th>{capTypes.map((t) => <Th key={t} className="text-right">{ACTION_LABELS[t]}</Th>)}</tr></thead>
            <tbody>
              {levels.map((lvl) => (
                <tr key={lvl}>
                  <Td className="font-medium text-gray-900">Level {lvl}</Td>
                  {capTypes.map((t) => <Td key={t} className="text-right tabular-nums">{warmupRows.find((w) => w.level === lvl && w.action_type === t)?.per_day ?? '—'}</Td>)}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {channel === 'WHATSAPP' && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">How a number moves up</div>
            <Table>
              <thead><tr><Th>Level</Th><Th className="text-right">New conversations a day</Th><Th>To reach the next level</Th></tr></thead>
              <tbody>{WA_GOVERNOR_LEVELS.map((l) => <tr key={l.level}><Td className="font-medium text-gray-900">Level {l.level}</Td><Td className="text-right tabular-nums">{l.new_chats}</Td><Td className="text-gray-600 text-xs">{l.level < 4 ? WA_GOVERNOR_LEVELS[l.level + 1].promotion : 'Top level. Stays while the reply rate holds at 50% or more with no blocks.'}{l.level === 0 ? ` Leaving level 0 also needs: ${l.promotion}.` : ''}</Td></tr>)}</tbody>
            </Table>
            <p className="text-xs text-amber-800 mt-2">{WA_GOVERNOR_DEMOTION}</p>
          </div>
        )}
      </Card>

      <Card className="mt-6" title="Consent">
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
        <Card className="mt-6" title="Manual caps per sender" actions={<span className="text-xs text-gray-400">edit on each sender’s Budgets tab</span>}>
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
                      <Td className="text-right"><Link href={`/outreach/senders/${s.id}?tab=Budgets`} className="text-sm text-indigo-600 hover:underline whitespace-nowrap">Budgets →</Link></Td>
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
