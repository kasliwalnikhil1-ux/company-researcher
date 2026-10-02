'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Save } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError } from '@/lib/outreach/api';
import { qk, useAudit } from '@/lib/outreach/queries';
import { longDate, planLabel, useBilling } from '@/lib/outreach/billing';
import { Badge, Button, Card, ErrorBox, fmtDate, Input, PageHeader, PageLoader, Spinner, Table, Td, Th, useToast } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import { BehaviourCard, RegionalCard } from '@/components/outreach/settings/WorkspacePreferences';
import StageKindsCard from '@/components/outreach/settings/StageKindsCard';

export default function WorkspaceSettingsPage() {
  const { workspace, isOwner, isManager, canWrite, refresh } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(workspace?.name ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setName(workspace?.name ?? ''), [workspace?.name]);
  const audit = useAudit(isManager ? ws : null);
  // The plan card reads billing v2: the plan label always, the trial and payment lines only once billing is switched on.
  const billing = useBilling(ws);
  const [auditOpen, setAuditOpen] = useState<Record<number, boolean>>({});
  // private-notes-PRD §8.5: managers may include internal notes in the messages export (file name gets -with-notes, audited)
  const [includeNotes, setIncludeNotes] = useState(false);

  async function rename() {
    if (!ws || !name.trim()) return;
    setBusy('rename');
    try { const { error } = await supabase.from('outreach_workspaces').update({ name: name.trim() }).eq('id', ws); if (error) throw error; await refresh(); toast.show('Workspace renamed.'); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  async function exportKind(kind: 'leads' | 'messages' | 'actions' | 'audit') {
    setBusy(`export-${kind}`);
    try { const r = await callFn<{ url: string; rows: number }>('exports-create', { workspace_id: ws, kind, include_notes: kind === 'messages' && includeNotes }); window.open(r.url, '_blank', 'noopener'); toast.show(`${kind} export ready (${r.rows.toLocaleString()} rows${kind === 'messages' && includeNotes ? ', private notes included' : ''}). The link is valid for one hour.`); qc.invalidateQueries({ queryKey: qk.audit(ws ?? '') }); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  if (!workspace) return <PageLoader />;
  const b = billing.data;
  const enforced = !!b?.enforced;
  const trial = enforced && b?.plan === 'trial' ? b.trial ?? null : null;
  const trialAccounts = trial?.account_limit ?? 1;

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
            <div className="flex items-center gap-2"><span className="text-2xl font-bold text-gray-900">{planLabel(b?.plan ?? workspace.plan)}</span>{enforced && workspace.stripe_status && <Badge tone={workspace.stripe_status === 'active' || workspace.stripe_status === 'trialing' ? 'green' : 'amber'}>{workspace.stripe_status}</Badge>}</div>
            {trial && <div className="text-sm text-gray-600 mt-2">{trial.ends_at && <>Trial ends {longDate(trial.ends_at)}{trial.days_left != null && <span className="text-gray-400"> ({trial.days_left > 0 ? `${trial.days_left} day${trial.days_left === 1 ? '' : 's'} left` : 'ends today'})</span>}. </>}{trialAccounts} account{trialAccounts === 1 ? '' : 's'}, no card required.</div>}
            {enforced && workspace.past_due_since && <div className="text-sm text-amber-700 mt-2">Payment past due since {fmtDate(workspace.past_due_since, false)}.</div>}
            {isOwner && <Link href="/outreach/billing" className="inline-block mt-3 text-sm text-indigo-600 hover:underline">Billing</Link>}
          </Card>

          {isManager && (
            <Card title="Exports">
              <p className="text-xs text-gray-500 mb-3">CSV files are generated server-side and opened via a signed link valid for one hour. Exports are recorded in the audit log.</p>
              <div className="grid grid-cols-2 gap-2">
                {(['leads', 'messages', 'actions', 'audit'] as const).map((k) => (
                  <Button key={k} variant="secondary" size="sm" onClick={() => exportKind(k)} loading={busy === `export-${k}`} disabled={!!busy && busy !== `export-${k}`}><Download className="w-3.5 h-3.5" /> {k}</Button>
                ))}
              </div>
              <label className="mt-3 flex items-start gap-2 text-xs text-gray-600 cursor-pointer">
                <input type="checkbox" className="mt-0.5 accent-amber-600" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
                <span><span className="font-medium text-gray-800">Include private notes</span> in the messages export. Internal team notes are left out otherwise; the file is named <code>…-with-notes.csv</code> and the export is audited.</span>
              </label>
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
