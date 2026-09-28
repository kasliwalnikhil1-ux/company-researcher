'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Save } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError } from '@/lib/outreach/api';
import { qk, useAudit } from '@/lib/outreach/queries';
import { Badge, Button, Card, ErrorBox, fmtDate, Input, PageHeader, PageLoader, Spinner, Table, Td, Th, useToast } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import { BehaviourCard, RegionalCard } from '@/components/outreach/settings/WorkspacePreferences';
import StageKindsCard from '@/components/outreach/settings/StageKindsCard';

const PLAN_LABEL: Record<string, string> = { trial: 'Trial', team: 'Team', agency: 'Agency', agency_plus: 'Agency Plus', suspended: 'Suspended' };

export default function WorkspaceSettingsPage() {
  const { workspace, isOwner, isManager, canWrite, refresh } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(workspace?.name ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setName(workspace?.name ?? ''), [workspace?.name]);
  const audit = useAudit(isManager ? ws : null);
  const [auditOpen, setAuditOpen] = useState<Record<number, boolean>>({});

  async function rename() {
    if (!ws || !name.trim()) return;
    setBusy('rename');
    try { const { error } = await supabase.from('outreach_workspaces').update({ name: name.trim() }).eq('id', ws); if (error) throw error; await refresh(); toast.show('Workspace renamed.'); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  async function exportKind(kind: 'leads' | 'messages' | 'actions' | 'audit') {
    setBusy(`export-${kind}`);
    try { const r = await callFn<{ url: string; rows: number }>('exports-create', { workspace_id: ws, kind }); window.open(r.url, '_blank', 'noopener'); toast.show(`${kind} export ready (${r.rows.toLocaleString()} rows). The link is valid for one hour.`); qc.invalidateQueries({ queryKey: qk.audit(ws ?? '') }); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  if (!workspace) return <PageLoader />;
  const trialDaysLeft = workspace.trial_ends_at ? Math.ceil((new Date(workspace.trial_ends_at).getTime() - Date.now()) / 86_400_000) : null;

  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <SettingsTabs />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card title="Workspace">
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="flex-1"><Input label="Name" value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner || !canWrite} /></div>
              {isOwner && <Button onClick={rename} loading={busy === 'rename'} disabled={!canWrite || !name.trim() || name.trim() === workspace.name}><Save className="w-4 h-4" /> Rename</Button>}
            </div>
            <div className="text-xs text-gray-400 mt-2">Slug: <code>{workspace.slug}</code> · id <code>{workspace.id}</code></div>
          </Card>

          <RegionalCard />
          <BehaviourCard />
          <StageKindsCard />
        </div>

        <div className="space-y-6">
          <Card title="Plan">
            <div className="flex items-center gap-2"><span className="text-2xl font-bold text-gray-900">{PLAN_LABEL[workspace.plan] ?? workspace.plan}</span>{workspace.stripe_status && <Badge tone={workspace.stripe_status === 'active' || workspace.stripe_status === 'trialing' ? 'green' : 'amber'}>{workspace.stripe_status}</Badge>}</div>
            {workspace.plan === 'trial' && <div className="text-sm text-gray-600 mt-2">Trial ends {fmtDate(workspace.trial_ends_at, false)}{trialDaysLeft != null && <span className="text-gray-400"> ({trialDaysLeft > 0 ? `${trialDaysLeft} day${trialDaysLeft === 1 ? '' : 's'} left` : 'expired'})</span>}. Up to 3 senders, no card required.</div>}
            {workspace.past_due_since && <div className="text-sm text-amber-700 mt-2">Payment past due since {fmtDate(workspace.past_due_since, false)}.</div>}
            {isOwner && <a href="/outreach/settings/billing" className="inline-block mt-3 text-sm text-indigo-600 hover:underline">Manage billing</a>}
          </Card>

          {isManager && (
            <Card title="Exports">
              <p className="text-xs text-gray-500 mb-3">CSV files are generated server-side and opened via a signed link valid for one hour. Exports are recorded in the audit log.</p>
              <div className="grid grid-cols-2 gap-2">
                {(['leads', 'messages', 'actions', 'audit'] as const).map((k) => (
                  <Button key={k} variant="secondary" size="sm" onClick={() => exportKind(k)} loading={busy === `export-${k}`} disabled={!!busy && busy !== `export-${k}`}><Download className="w-3.5 h-3.5" /> {k}</Button>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {isManager && (
        <Card className="mt-6" title="Audit log" actions={<span className="text-xs text-gray-400">latest 300</span>}>
          {audit.isLoading ? <Spinner /> : audit.isError ? <ErrorBox message={(audit.error as Error).message} /> : !audit.data?.length ? <div className="text-sm text-gray-500 py-4">No audit entries yet.</div> : (
            <Table>
              <thead><tr><Th>When</Th><Th>Action</Th><Th>Entity</Th><Th>Actor</Th><Th>Details</Th></tr></thead>
              <tbody>
                {audit.data.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap">{fmtDate(r.at)}</Td>
                    <Td className="font-medium text-gray-900">{r.action}</Td>
                    <Td><span className="text-gray-700">{r.entity ?? '—'}</span>{r.entity_id && <span className="text-[11px] text-gray-400 font-mono ml-1">{r.entity_id.slice(0, 8)}</span>}</Td>
                    <Td><Badge tone={r.actor_type === 'system' ? 'gray' : r.actor_type === 'ai' ? 'purple' : 'blue'}>{r.actor_type}</Badge></Td>
                    <Td>
                      {r.diff != null ? (
                        <>
                          <button type="button" onClick={() => setAuditOpen({ ...auditOpen, [r.id]: !auditOpen[r.id] })} className="text-xs text-indigo-600 hover:underline">{auditOpen[r.id] ? 'hide' : 'show'}</button>
                          {auditOpen[r.id] && <pre className="mt-1 p-2 rounded bg-gray-50 border border-gray-200 text-[11px] text-gray-700 max-w-md overflow-x-auto">{JSON.stringify(r.diff, null, 2)}</pre>}
                        </>
                      ) : <span className="text-gray-300">—</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      {toast.node}
    </div>
  );
}
