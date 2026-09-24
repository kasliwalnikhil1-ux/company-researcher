'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useCeilings, useSenders, useWarmupCaps } from '@/lib/outreach/queries';
import { Badge, Card, ErrorBox, PageHeader, PageLoader, Spinner, StatusPill, Table, Td, Th } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import { ACTION_LABELS, BUDGET_ACTION_TYPES } from '@/components/outreach/senders/helpers';
import type { ActionType } from '@/lib/outreach/types';

const PAUSE_RULES: Array<{ condition: string; effect: string; resume: string }> = [
  { condition: 'Health score < 50', effect: 'Sender auto-paused for 24h (paused_until)', resume: 'Next health recompute scores ≥ 50' },
  { condition: 'Health 50–69', effect: 'All daily caps scaled ×0.6', resume: 'Health recompute ≥ 70' },
  { condition: '≥3 × HTTP 429/500 from LinkedIn within 1 hour', effect: 'Sender auto-paused for 24h', resume: 'Automatic after 24h' },
  { condition: 'LinkedIn “cannot resend yet” on an invite', effect: 'Invitations blocked until next Monday (sender-local)', resume: 'Automatic' },
  { condition: 'Sender status ≠ ok (credentials, error, connecting)', effect: 'All actions held — they stay queued', resume: 'Status returns to ok' },
  { condition: 'Manual pause', effect: 'status = paused; planner skips the sender', resume: 'A manager clicks Resume' },
  { condition: 'Workspace suspended (billing)', effect: 'All senders paused, workspace read-only', resume: 'Subscription active again' },
];

export default function SafetySettingsPage() {
  const { workspace, role } = useWorkspace();
  const ws = workspace?.id;
  const ceilings = useCeilings();
  const warmup = useWarmupCaps();
  const senders = useSenders(role === 'client_viewer' ? null : ws);
  const ceilingList = useMemo(() => (ceilings.data ?? []).filter((c) => c.per_day < 100000).sort((a, b) => BUDGET_ACTION_TYPES.indexOf(a.action_type) - BUDGET_ACTION_TYPES.indexOf(b.action_type)), [ceilings.data]);
  const capTypes = useMemo(() => { const set = new Set<ActionType>((warmup.data ?? []).map((w) => w.action_type)); return BUDGET_ACTION_TYPES.filter((t) => set.has(t)); }, [warmup.data]);
  const withCaps = useMemo(() => (senders.data ?? []).filter((s) => s.status !== 'disabled'), [senders.data]);

  if (!workspace) return <PageLoader />;

  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <SettingsTabs />
      <div className="flex items-start gap-2 p-3 mb-6 rounded-lg bg-indigo-50 text-indigo-900 text-sm border border-indigo-100"><ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>Safety limits are enforced in the database, not just the UI: every action reserves budget atomically, nothing lands on a round minute, and no cap can exceed the platform ceiling. You can only lower limits per sender.</span></div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Platform ceilings (read-only)">
          <p className="text-xs text-gray-500 mb-3">Hard maximums per sender per day, regardless of level or manual caps. Editable only by the platform operator.</p>
          {ceilings.isLoading ? <Spinner /> : ceilings.isError ? <ErrorBox message={(ceilings.error as Error).message} /> : (
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

      <Card className="mt-6" title="Warm-up caps by level (read-only)">
        <p className="text-xs text-gray-500 mb-3">Every LinkedIn sender starts at level 0 (mailboxes start at 3). A level is gained after 14 consecutive days at health ≥ 85; accounts with fewer than 150 connections (or unknown) stay at level 0 for at least 28 days.</p>
        {warmup.isLoading ? <Spinner /> : warmup.isError ? <ErrorBox message={(warmup.error as Error).message} /> : (
          <Table>
            <thead><tr><Th>Level</Th>{capTypes.map((t) => <Th key={t} className="text-right">{ACTION_LABELS[t]}</Th>)}</tr></thead>
            <tbody>
              {[0, 1, 2, 3, 4, 5].map((lvl) => (
                <tr key={lvl}>
                  <Td className="font-medium text-gray-900">Level {lvl}</Td>
                  {capTypes.map((t) => <Td key={t} className="text-right tabular-nums">{(warmup.data ?? []).find((w) => w.level === lvl && w.action_type === t)?.per_day ?? '—'}</Td>)}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {role !== 'client_viewer' && (
        <Card className="mt-6" title="Manual caps per sender" actions={<span className="text-xs text-gray-400">edit on each sender’s Budgets tab</span>}>
          {senders.isLoading ? <Spinner /> : senders.isError ? <ErrorBox message={(senders.error as Error).message} /> : withCaps.length === 0 ? <div className="text-sm text-gray-500 py-4">No senders yet.</div> : (
            <Table>
              <thead><tr><Th>Sender</Th><Th>Status</Th><Th>Level</Th><Th>Manual caps</Th><Th></Th></tr></thead>
              <tbody>
                {withCaps.map((s) => {
                  const caps = Object.entries(s.manual_caps ?? {}).filter(([, v]) => typeof v === 'number') as Array<[string, number]>;
                  return (
                    <tr key={s.id}>
                      <Td className="font-medium text-gray-900">{s.display_name ?? 'Unnamed sender'}</Td>
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
