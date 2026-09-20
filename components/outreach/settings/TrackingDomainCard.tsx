'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, Globe, Plus, Trash2 } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { Badge, Button, Card, ErrorBox, Input, Spinner, fmtDate, useToast } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { ConfirmModal, CopyField, Note, isHostname } from './shared';
import { sk, useTrackingDomains } from './hooks';
import type { TrackingDomain, TrackingDomainStatus } from './types';

const STEPS: Array<{ key: TrackingDomainStatus; label: string }> = [{ key: 'pending_dns', label: 'DNS pending' }, { key: 'awaiting_approval', label: 'Awaiting approval' }, { key: 'active', label: 'Active' }];
const STATUS_TEXT: Record<TrackingDomainStatus, string> = {
  pending_dns: 'Add the CNAME record below. We check it on our own, usually within the hour.',
  awaiting_approval: 'The CNAME resolves. The email provider now authorises the domain by hand, which can take a few working days. Nothing for you to do.',
  active: 'Open and click links in your emails use this domain.',
  failed: 'The domain could not be set up. Remove it and add it again, or contact support.',
};

function Steps({ status }: { status: TrackingDomainStatus }) {
  if (status === 'failed') return <Badge tone="red">Failed</Badge>;
  const at = STEPS.findIndex((s) => s.key === status);
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Setup progress">
      {STEPS.map((s, i) => {
        const done = i < at || status === 'active';
        return <li key={s.key} aria-current={i === at ? 'step' : undefined} className={cn('flex items-center gap-1 text-xs', done ? 'text-green-700' : i === at ? 'text-indigo-700 font-medium' : 'text-gray-400')}>{done ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5" />}{s.label}</li>;
      })}
    </ol>
  );
}

/** Workspace-level tracking domain (item 20). A mailbox can have its own domain on the sender's page; that one wins for that mailbox. */
export default function TrackingDomainCard() {
  const { workspace, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useTrackingDomains(ws);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upsell, setUpsell] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<TrackingDomain | null>(null);

  const mine = (domains.data ?? []).filter((d) => !d.sender_id);
  const perMailbox = (domains.data ?? []).length - mine.length;
  const clean = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const hostError = host && !isHostname(clean) ? 'Enter a hostname such as link.agency.com' : undefined;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!ws || !clean || hostError) return;
    setBusy(true); setError(null); setUpsell(null);
    try {
      await rpc('add_tracking_domain', { p_ws: ws, p_hostname: clean, p_sender: null });
      setHost('');
      await qc.invalidateQueries({ queryKey: sk.trackingDomains(ws) });
      toast.show('Domain added. Now create the CNAME record shown below.');
    } catch (er) {
      const pe = parseError(er);
      if (pe.code === 'E_PLAN_REQUIRED') setUpsell(pe.message); else setError(pe.message);
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!toRemove || !ws) return;
    setBusy(true);
    try { await rpc('remove_tracking_domain', { p_id: toRemove.id }); await qc.invalidateQueries({ queryKey: sk.trackingDomains(ws) }); toast.show('Domain removed. Emails use the default tracking domain again.'); setToRemove(null); }
    catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><Globe className="w-4 h-4" /> Tracking domain</span>}>
      <p className="text-xs text-gray-500 mb-4">Open and click tracking rewrites the links in your emails. With your own domain those links read <code>link.youragency.com</code> instead of a shared one, which looks better to people and to spam filters. Until a domain is active, the default tracking domain is used, so nothing breaks while you wait.</p>
      {domains.isLoading ? <Spinner /> : domains.isError ? <ErrorBox message={parseError(domains.error).message} /> : (
        <div className="space-y-4">
          {mine.map((d) => (
            <div key={d.id} className="border border-gray-200 rounded-lg p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-mono text-sm text-gray-900 break-all">{d.hostname}</div>
                <div className="flex items-center gap-3"><Steps status={d.status} />{canWrite && <Button size="sm" variant="ghost" onClick={() => setToRemove(d)} aria-label={`Remove ${d.hostname}`}><Trash2 className="w-4 h-4 text-red-500" /></Button>}</div>
              </div>
              <p className="text-xs text-gray-600">{STATUS_TEXT[d.status]}{d.note ? ` ${d.note}` : ''}</p>
              {d.status !== 'active' && (
                <div className="grid grid-cols-1 sm:grid-cols-[90px_1fr_1fr] gap-3 bg-gray-50 rounded-lg p-3">
                  <div><div className="text-xs font-medium text-gray-600 mb-1">Type</div><div className="px-3 py-2 text-xs font-mono text-gray-700">CNAME</div></div>
                  <CopyField label="Name / host" value={d.hostname} />
                  <CopyField label="Value / points to" value={d.cname_target || 's1.lnk-fllw.com'} />
                </div>
              )}
              <div className="text-[11px] text-gray-400">Added {fmtDate(d.created_at, false)}{d.checked_at ? ` · last checked ${fmtDate(d.checked_at)}` : ''}{d.approved_at ? ` · approved ${fmtDate(d.approved_at, false)}` : ''}</div>
            </div>
          ))}

          {mine.length === 0 && canWrite && (
            <form onSubmit={add} className="flex flex-col sm:flex-row sm:items-start gap-2" noValidate>
              <div className="flex-1"><Input label="Your tracking hostname" value={host} onChange={(e) => { setHost(e.target.value); setError(null); }} placeholder="link.agency.com" error={hostError} hint="Use a subdomain you do not use for anything else. You will point it at s1.lnk-fllw.com with a CNAME." spellCheck={false} /></div>
              <Button type="submit" className="sm:mt-5" loading={busy} disabled={!clean || !!hostError}><Plus className="w-4 h-4" /> Add domain</Button>
            </form>
          )}
          {mine.length === 0 && !canWrite && <div className="text-sm text-gray-500">No tracking domain set. The default one is used.</div>}

          {upsell && (
            <Note tone="indigo">
              <strong>Custom tracking domains are part of the Agency and white-label plans.</strong> Each domain is approved by hand by the email provider, so we offer it where it matters most. <Link href="/outreach/settings/billing" className="underline font-medium">See plans</Link>
            </Note>
          )}
          {error && <ErrorBox message={error} />}
          {!upsell && mine.length === 0 && workspace && !['agency', 'agency_plus'].includes(workspace.plan) && <div className="text-xs text-gray-400">Available on the Agency and white-label plans.</div>}
          {perMailbox > 0 && <div className="text-xs text-gray-500">{perMailbox} mailbox{perMailbox === 1 ? ' has' : 'es have'} a domain of {perMailbox === 1 ? 'its' : 'their'} own. Those are managed on the sender&apos;s page and win over this one.</div>}
        </div>
      )}
      <ConfirmModal open={!!toRemove} onClose={() => setToRemove(null)} onConfirm={remove} loading={busy} title="Remove this tracking domain?" confirmLabel="Remove domain">
        <p>Emails go back to the default tracking domain straight away. Links in emails that were already sent keep working as long as the CNAME record exists.</p>
        <p>Adding the same domain again later means a new approval by the email provider.</p>
      </ConfirmModal>
      {toast.node}
    </Card>
  );
}
