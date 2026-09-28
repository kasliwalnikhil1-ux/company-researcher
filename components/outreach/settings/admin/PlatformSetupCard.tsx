'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Copy, RefreshCw, XCircle } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError } from '@/lib/outreach/api';
import { Badge, Button, Card, ErrorBox, Spinner, useToast } from '@/components/outreach/ui';
import { copyText } from '@/components/outreach/settings/shared';

type SetupStatus = { unipile: boolean; unipile_dsn?: string | null; webhook_secret: boolean; cookie_key: boolean; cron_secret?: boolean; ai: boolean; ai_model?: string; resend: boolean; stripe: boolean; stripe_webhook?: boolean; webhook_url: string; unipile_error?: string };
type SetupResp = { status: SetupStatus; webhooks: Array<{ id: string; source: string; events?: string[]; request_url?: string; enabled?: boolean }> };

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

/**
 * Deployment checklist + connector webhook registration. The same for every workspace, so it lives in Settings → Admin.
 * The edge function needs a workspace the caller owns (for the audit row), the platform admin email and a localhost origin.
 */
export default function PlatformSetupCard() {
  const { workspace, isOwner, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const toast = useToast();
  const [registering, setRegistering] = useState(false);
  const setup = useQuery({ queryKey: ['outreach', ws ?? '', 'platform-setup'], enabled: !!ws && isOwner, staleTime: 60_000, retry: 0, queryFn: () => callFn<SetupResp>('unipile-setup', { workspace_id: ws, action: 'status' }) });

  async function registerWebhooks() {
    setRegistering(true);
    try { const r = await callFn<{ created: string[] }>('unipile-setup', { workspace_id: ws, action: 'register' }); toast.show(r.created.length ? `Registered: ${r.created.join(', ')}` : 'All webhooks were already registered.'); await setup.refetch(); }
    catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setRegistering(false); }
  }

  return (
    <Card title="Platform setup" actions={isOwner ? <Button size="sm" variant="secondary" onClick={() => setup.refetch()} loading={setup.isFetching}><RefreshCw className="w-3.5 h-3.5" /> Re-check</Button> : undefined}>
      {!isOwner ? <div className="text-sm text-gray-500">Switch to a workspace you own to run the deployment checks.</div>
        : setup.isLoading ? <Spinner /> : setup.isError ? <ErrorBox message={parseError(setup.error).message} /> : setup.data ? (
        <>
          <div className="divide-y divide-gray-100">
            <StatusRow ok={setup.data.status.unipile} label="Account connector API" hint={setup.data.status.unipile ? (setup.data.status.unipile_dsn ?? 'Connected') : 'UNIPILE_DSN and UNIPILE_API_KEY'} />
            <StatusRow ok={setup.data.status.webhook_secret} label="Connector webhook secret" hint="UNIPILE_WEBHOOK_SECRET" />
            <StatusRow ok={setup.data.status.cookie_key} label="Cookie encryption key" hint="OUTREACH_COOKIE_KEY" />
            {setup.data.status.cron_secret != null && <StatusRow ok={setup.data.status.cron_secret} label="Cron secret" hint="OUTREACH_CRON_SECRET" />}
            <StatusRow ok={setup.data.status.ai} label="AI (classify / drafts)" hint={setup.data.status.ai_model ?? 'GEMINI_API_KEY'} />
            <StatusRow ok={setup.data.status.resend} label="Resend (email notifications)" hint="RESEND_API_KEY. Optional: reconnect and invite links can be copied from the app instead" optional />
            <StatusRow ok={setup.data.status.stripe} label="Stripe (billing)" hint="STRIPE_SECRET_KEY. Optional: billing and trial limits are off while it is unset" optional />
          </div>
          {setup.data.status.unipile_error && <ErrorBox className="mt-3" message={`Connector: ${setup.data.status.unipile_error}`} />}
          <div className="mt-4">
            <div className="text-xs font-medium text-gray-600 mb-1">Inbound webhook URL</div>
            <div className="flex gap-2">
              <input readOnly value={setup.data.status.webhook_url} onFocus={(e) => e.currentTarget.select()} aria-label="Webhook URL" className="flex-1 min-w-0 px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 bg-gray-50 text-gray-700" />
              <Button size="sm" variant="secondary" onClick={async () => toast.show((await copyText(setup.data!.status.webhook_url)) ? 'Copied.' : 'Copy failed.')}><Copy className="w-3.5 h-3.5" /></Button>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div className="text-sm font-medium text-gray-900">Registered connector webhooks</div>
            <Button size="sm" onClick={registerWebhooks} loading={registering} disabled={!setup.data.status.unipile || !setup.data.status.webhook_secret || !canWrite}>Register webhooks</Button>
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
      {toast.node}
    </Card>
  );
}
