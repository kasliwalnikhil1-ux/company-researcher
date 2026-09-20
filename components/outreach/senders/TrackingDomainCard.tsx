'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Globe, Sparkles, Trash2, XCircle } from 'lucide-react';
import { parseError, rpc } from '@/lib/outreach/api';
import { Badge, Button, Card, ErrorBox, Input, Modal, Spinner, timeAgo } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { copyText } from './helpers';
import { sk, useTrackingDomains, type SenderV2, type TrackingDomain } from './insights';

type Notify = (message: string, type?: 'success' | 'error') => void;

const STEPS: Array<{ key: TrackingDomain['status']; label: string; help: string }> = [
  { key: 'pending_dns', label: 'DNS pending', help: 'Add the CNAME record below. We check it for you every few minutes.' },
  { key: 'awaiting_approval', label: 'Awaiting approval', help: 'The record resolves. The email provider now approves the domain by hand, which can take a few working days.' },
  { key: 'active', label: 'Active', help: 'Opens and clicks are tracked under this domain.' },
];

function Progress({ status }: { status: TrackingDomain['status'] }) {
  const idx = status === 'failed' ? 0 : STEPS.findIndex((s) => s.key === status);
  return (
    <ol className="flex flex-col sm:flex-row gap-2 sm:gap-0" aria-label="Tracking domain progress">
      {STEPS.map((s, i) => {
        const done = i < idx || status === 'active'; const current = i === idx && status !== 'active';
        return (
          <li key={s.key} className="flex-1 flex sm:flex-col items-center sm:items-stretch gap-2" aria-current={current ? 'step' : undefined}>
            <div className="flex items-center sm:w-full">
              <span className={cn('w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0', done ? 'bg-green-600 text-white' : current ? (status === 'failed' ? 'bg-red-600 text-white' : 'bg-indigo-600 text-white') : 'bg-gray-200 text-gray-500')}>
                {done ? <Check className="w-3.5 h-3.5" aria-hidden /> : i + 1}
              </span>
              {i < STEPS.length - 1 && <span className={cn('hidden sm:block h-0.5 flex-1 mx-2', i < idx || status === 'active' ? 'bg-green-600' : 'bg-gray-200')} aria-hidden />}
            </div>
            <span className={cn('text-xs', done || current ? 'text-gray-900 font-medium' : 'text-gray-500')}>{s.label}<span className="sr-only">{done ? ' (done)' : current ? ' (current step)' : ' (not started)'}</span></span>
          </li>
        );
      })}
    </ol>
  );
}

function CopyField({ label, value, notify }: { label: string; value: string; notify: Notify }) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-600 mb-1">{label}</div>
      <div className="flex gap-2">
        <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-0 px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 bg-gray-50 text-gray-800" />
        <Button size="sm" variant="secondary" aria-label={`Copy ${label.toLowerCase()}`} onClick={async () => notify((await copyText(value)) ? `${label} copied.` : 'Copy failed. Select the text and copy it by hand.', 'success')}><Copy className="w-3.5 h-3.5" /> Copy</Button>
      </div>
    </div>
  );
}

function DomainRow({ d, own, canManage, notify, onRemove }: { d: TrackingDomain; own: boolean; canManage: boolean; notify: Notify; onRemove: (d: TrackingDomain) => void }) {
  const step = STEPS.find((s) => s.key === d.status);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Globe className="w-4 h-4 text-gray-400" aria-hidden />
        <span className="text-sm font-semibold text-gray-900 break-all">{d.hostname}</span>
        <Badge tone={own ? 'indigo' : 'gray'}>{own ? 'This mailbox' : 'Workspace default'}</Badge>
        {d.status === 'failed' && <Badge tone="red">Check failed</Badge>}
        {own && canManage && <Button size="sm" variant="ghost" className="ml-auto text-red-600 hover:bg-red-50" onClick={() => onRemove(d)}><Trash2 className="w-3.5 h-3.5" /> Remove</Button>}
      </div>
      <Progress status={d.status} />
      {d.status === 'failed'
        ? <div className="flex items-start gap-2 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg p-3"><XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden /><span>{d.note || 'The domain could not be verified.'} Check the CNAME record, or remove the domain and add it again.</span></div>
        : <p className="text-sm text-gray-700">{step?.help}{d.note && d.status !== 'active' ? ` ${d.note}` : ''}</p>}
      {d.status !== 'active' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div><div className="text-xs font-medium text-gray-600 mb-1">Type</div><div className="px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 bg-gray-50 text-gray-800">CNAME</div></div>
          <CopyField label="Name" value={d.hostname} notify={notify} />
          <CopyField label="Value" value={d.cname_target} notify={notify} />
        </div>
      )}
      <div className="text-xs text-gray-500">
        {d.status !== 'active' && 'The default tracking domain is used until this one is active. '}
        {d.checked_at ? `Last checked ${timeAgo(d.checked_at)}.` : d.status === 'pending_dns' ? 'Not checked yet.' : ''}
        {!own && <> Manage the workspace default in <Link href="/outreach/settings/email" className="text-indigo-600 hover:underline">Settings → Email &amp; booking</Link>.</>}
      </div>
    </div>
  );
}

/** Custom open / click tracking domain of one mailbox (falls back to the workspace default, then to the platform default). */
export default function TrackingDomainCard({ sender, canManage, notify }: { sender: SenderV2; canManage: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const domains = useTrackingDomains(sender.workspace_id);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upsell, setUpsell] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TrackingDomain | null>(null);

  const own = (domains.data ?? []).find((d) => d.sender_id === sender.id);
  const fallback = (domains.data ?? []).find((d) => d.sender_id === null);
  const refresh = () => qc.invalidateQueries({ queryKey: sk.trackingDomains(sender.workspace_id) });

  async function add(e: FormEvent) {
    e.preventDefault();
    const h = hostname.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!h) return;
    setBusy(true); setError(null); setUpsell(null);
    try {
      await rpc('add_tracking_domain', { p_ws: sender.workspace_id, p_hostname: h, p_sender: sender.id });
      setHostname(''); notify('Domain added. Add the CNAME record next.'); refresh();
    } catch (err) {
      const pe = parseError(err);
      if (pe.code === 'E_PLAN_REQUIRED') setUpsell(pe.message); else setError(pe.message);
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try { await rpc('remove_tracking_domain', { p_id: removing.id }); notify('Tracking domain removed. The default domain is used from now on.'); setRemoving(null); refresh(); }
    catch (err) { notify(parseError(err).message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Card title="Tracking domain">
      {domains.isLoading ? <Spinner className="py-6" /> : domains.isError ? <ErrorBox message={parseError(domains.error).message} /> : (
        <div className="space-y-5">
          {own ? <DomainRow d={own} own canManage={canManage} notify={notify} onRemove={setRemoving} />
            : fallback ? <DomainRow d={fallback} own={false} canManage={canManage} notify={notify} onRemove={setRemoving} />
            : <p className="text-sm text-gray-700">Opens and clicks are tracked under the default tracking domain. With your own domain, for example <span className="font-mono text-xs">link.agency.com</span>, tracked links carry your name instead.</p>}

          {!own && canManage && (
            <form onSubmit={add} className="space-y-2 pt-4 border-t border-gray-100">
              <div className="flex flex-col sm:flex-row sm:items-end gap-2">
                <div className="flex-1"><Input label={fallback ? 'Use a different domain for this mailbox' : 'Your tracking domain'} value={hostname} onChange={(e) => { setHostname(e.target.value); setError(null); }} placeholder="link.agency.com" autoComplete="off" spellCheck={false} error={error ?? undefined} hint="A subdomain you control. You add one CNAME record, then the email provider approves it." /></div>
                <Button type="submit" loading={busy} disabled={!hostname.trim() || busy} className="sm:mb-5">Add domain</Button>
              </div>
              {upsell && (
                <div role="note" className="flex items-start gap-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
                  <Sparkles className="w-4 h-4 mt-0.5 flex-shrink-0 text-indigo-600" aria-hidden />
                  <div><span className="first-letter:uppercase inline-block">{upsell}.</span> <Link href="/outreach/settings/billing" className="font-medium underline">See plans</Link></div>
                </div>
              )}
            </form>
          )}
          {!own && !canManage && !fallback && <p className="text-xs text-gray-500">A manager can add a tracking domain.</p>}
        </div>
      )}

      <Modal open={!!removing} onClose={() => setRemoving(null)} size="sm" title="Remove this tracking domain?"
        footer={<><Button variant="secondary" onClick={() => setRemoving(null)} disabled={busy}>Keep it</Button><Button variant="danger" onClick={remove} loading={busy}>Remove</Button></>}>
        <p className="text-sm text-gray-700">Emails from this mailbox go back to the {fallback ? 'workspace default' : 'default'} tracking domain. Links in emails that were already sent keep working only while the CNAME record stays in place.</p>
      </Modal>
    </Card>
  );
}
