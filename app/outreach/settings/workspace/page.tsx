'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Download, RefreshCw, Save, XCircle } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError } from '@/lib/outreach/api';
import { qk, useAudit } from '@/lib/outreach/queries';
import { useLocalhostOnly } from '@/lib/outreach/platformAdmin';
import { Badge, Button, Card, ErrorBox, fmtDate, Input, PageHeader, PageLoader, Spinner, Table, Td, Th, useToast } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import { copyText } from '@/components/outreach/settings/shared';
import { BehaviourCard, RegionalCard } from '@/components/outreach/settings/WorkspacePreferences';
import StageKindsCard from '@/components/outreach/settings/StageKindsCard';

type SetupStatus = { unipile: boolean; unipile_dsn?: string | null; webhook_secret: boolean; cookie_key: boolean; cron_secret?: boolean; ai: boolean; ai_model?: string; resend: boolean; stripe: boolean; stripe_webhook?: boolean; webhook_url: string; unipile_error?: string };
type SetupResp = { status: SetupStatus; webhooks: Array<{ id: string; source: string; events?: string[]; request_url?: string; enabled?: boolean }> };

const PLAN_LABEL: Record<string, string> = { trial: 'Trial', team: 'Team', agency: 'Agency', agency_plus: 'Agency Plus', suspended: 'Suspended' };

function StatusRow({ ok, label, hint, optional }: { ok: boolean; label: string; hint?: string; optional?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0"><div className="text-sm text-gray-800">{label}</div>{hint && <div className="text-xs text-gray-400 truncate" title={hint}>{hint}</div>}</div>
      {ok
        ? <Badge tone="green"><CheckCircle2 className="w-3 h-3 mr-1" /> configured</Badge>
        : optional
          ? <Badge tone="gray"><XCircle className="w-3 h-3 mr-1" /> not set</Badge>
          : <Badge tone="red"><XCircle className="w-3 h-3 mr-1" /> missing</Badge>}
    </div>
  );
}

export default function WorkspaceSettingsPage() {
  const { workspace, isOwner, isManager, canWrite, refresh } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(workspace?.name ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setName(workspace?.name ?? ''), [workspace?.name]);
  const audit = useAudit(isManager ? ws : null);
  // Deployment-level configuration (secrets, connector webhooks) is operated from a local checkout only: never shown on a deployed host.
  const isLocal = useLocalhostOnly();
  const [auditOpen, setAuditOpen] = useState<Record<number, boolean>>({});

  const setup = useQuery({ queryKey: ['outreach', ws ?? '', 'platform-setup'], enabled: !!ws && isOwner && isLocal, staleTime: 60_000, retry: 0, queryFn: () => callFn<SetupResp>('unipile-setup', { workspace_id: ws, action: 'status' }) });

  async function rename() {
    if (!ws || !name.trim()) return;
    setBusy('rename');
    try { const { error } = await supabase.from('outreach_workspaces').update({ name: name.trim() }).eq('id', ws); if (error) throw error; await refresh(); toast.show('Workspace renamed.'); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  }

  async function registerWebhooks() {
    setBusy('register');
    try { const r = await callFn<{ created: string[] }>('unipile-setup', { workspace_id: ws, action: 'register' }); toast.show(r.created.length ? `Registered: ${r.created.join(', ')}` : 'All webhooks were already registered.'); await setup.refetch(); }
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

          {isOwner && isLocal && (
            <Card title="Platform setup" actions={<Button size="sm" variant="secondary" onClick={() => setup.refetch()} loading={setup.isFetching}><RefreshCw className="w-3.5 h-3.5" /> Re-check</Button>}>
              {setup.isLoading ? <Spinner /> : setup.isError ? <ErrorBox message={parseError(setup.error).message} /> : setup.data ? (
                <>
                  <div className="divide-y divide-gray-100">
                    <StatusRow ok={setup.data.status.unipile} label="Account connector API" hint={setup.data.status.unipile ? 'Connected' : 'Not configured on this deployment. Contact support.'} />
                    <StatusRow ok={setup.data.status.webhook_secret} label="Connector webhook secret" hint={setup.data.status.webhook_secret ? 'Set' : 'Not set on this deployment. Contact support.'} />
                    <StatusRow ok={setup.data.status.cookie_key} label="Cookie encryption key" hint="OUTREACH_COOKIE_KEY" />
                    {setup.data.status.cron_secret != null && <StatusRow ok={setup.data.status.cron_secret} label="Cron secret" hint="OUTREACH_CRON_SECRET" />}
                    <StatusRow ok={setup.data.status.ai} label="Gemini (AI classify / drafts)" hint={setup.data.status.ai_model ?? 'GEMINI_API_KEY'} />
                    <StatusRow ok={setup.data.status.resend} label="Resend (email notifications)" hint="RESEND_API_KEY. Optional: reconnect and invite links can be copied from the app instead" optional />
                    <StatusRow ok={setup.data.status.stripe} label="Stripe (billing)" hint="STRIPE_SECRET_KEY. Optional: billing and trial limits are off while it is unset" optional />
                  </div>
                  {setup.data.status.unipile_error && <ErrorBox className="mt-3" message={`Connector: ${setup.data.status.unipile_error}`} />}
                  <div className="mt-4">
                    <div className="text-xs font-medium text-gray-600 mb-1">Inbound webhook URL</div>
                    <div className="flex gap-2">
                      <input readOnly value={setup.data.status.webhook_url} onFocus={(e) => e.currentTarget.select()} aria-label="Webhook URL" className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 bg-gray-50 text-gray-700" />
                      <Button size="sm" variant="secondary" onClick={async () => toast.show((await copyText(setup.data!.status.webhook_url)) ? 'Copied.' : 'Copy failed.')}><Copy className="w-3.5 h-3.5" /></Button>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <div className="text-sm font-medium text-gray-900">Registered connector webhooks</div>
                    <Button size="sm" onClick={registerWebhooks} loading={busy === 'register'} disabled={!setup.data.status.unipile || !setup.data.status.webhook_secret || !canWrite}>Register webhooks</Button>
                  </div>
                  {setup.data.webhooks.length === 0 ? <div className="text-sm text-gray-500 mt-2">None registered yet. Click “Register webhooks” to create the account_status, messaging, users, email and email_tracking hooks.</div> : (
                    <ul className="mt-2 divide-y divide-gray-100">
                      {setup.data.webhooks.map((w) => (
                        <li key={w.id} className="py-2 flex flex-wrap items-center gap-2 text-sm">
                          <Badge tone={w.enabled === false ? 'gray' : 'green'}>{w.source}</Badge>
                          <span className="text-xs text-gray-500">{(w.events ?? []).join(', ') || 'all events'}</span>
                          <span className="text-[11px] text-gray-400 ml-auto font-mono">{w.id}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : null}
            </Card>
          )}
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
