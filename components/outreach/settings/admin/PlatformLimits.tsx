'use client';

import { useMemo, useState } from 'react';
import { useCeilings, useWarmupCaps } from '@/lib/outreach/queries';
import { Card, ErrorBox, Spinner, Table, Td, Th } from '@/components/outreach/ui';
import { ACTION_LABELS, BUDGET_ACTION_TYPES, PROVIDER_LABELS } from '@/components/outreach/senders/helpers';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { CHANNEL_PROVIDERS, WA_GOVERNOR_DEMOTION, WA_GOVERNOR_LEVELS } from '@/lib/outreach/channels';
import type { ActionType, PlatformCeiling, Provider, WarmupCap } from '@/lib/outreach/types';
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
  WEBCHAT: 'Website chat inboxes are not warmed up: the widget has no daily allowance.',
};

/**
 * Limits that are the same for every sender in every workspace: channel ceilings, warm-up caps by level and the engine's
 * pause / resume rules. Moved from Settings → Safety to Settings → Admin (localhost only). Each sender's Limits tab still
 * shows the ceiling and level cap that apply to it.
 */
export default function PlatformLimits() {
  const ceilings = useCeilings();
  const warmup = useWarmupCaps();
  const [channel, setChannel] = useState<Provider>('LINKEDIN');

  const ceilingList = useMemo(() => ((ceilings.data ?? []) as CeilingRow[]).filter((c) => rowProvider(c) === channel && c.per_day < 100000).sort((a, b) => BUDGET_ACTION_TYPES.indexOf(a.action_type) - BUDGET_ACTION_TYPES.indexOf(b.action_type)), [ceilings.data, channel]);
  const warmupRows = useMemo(() => ((warmup.data ?? []) as WarmupRow[]).filter((w) => rowProvider(w) === channel), [warmup.data, channel]);
  const capTypes = useMemo(() => { const set = new Set<ActionType>(warmupRows.map((w) => w.action_type)); return BUDGET_ACTION_TYPES.filter((t) => set.has(t)); }, [warmupRows]);
  const levels = channel === 'WHATSAPP' ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5];

  const channelTabs = (
    <div className="flex flex-wrap gap-1.5 mb-3" role="tablist" aria-label="Channel">
      {CHANNEL_PROVIDERS.map((p) => (
        <button key={p} type="button" role="tab" aria-selected={channel === p} onClick={() => setChannel(p)}
          className={cn('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border', channel === p ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50')}>
          <ProviderLogo provider={p} className="w-3.5 h-3.5" /> {PROVIDER_LABELS[p]}
        </button>
      ))}
    </div>
  );

  return (
    <div>
      {channelTabs}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title={`${PROVIDER_LABELS[channel]} ceilings (read-only)`}>
          <p className="text-xs text-gray-500 mb-3">Hard maximums per sender per day, regardless of level or manual caps. Stored in outreach_platform_ceilings; change them with a migration.{channel === 'INSTAGRAM' ? ' On top of these, at most 10 metered actions an hour and 100 a day in total.' : ''}</p>
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
    </div>
  );
}
