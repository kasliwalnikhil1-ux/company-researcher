'use client';

// Identities (PRD §8): one handle or number per channel for a lead. LinkedIn comes from the lead itself; Instagram
// handles and WhatsApp numbers are added here (or arrive from imports, inbound messages and profile reads).
import { useState } from 'react';
import { AtSign, Check, Trash2 } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { channelLabel, useIdentityAdd, useIdentityRemove, useIdentityVerify, useLeadIdentities } from '@/lib/outreach/channels';
import type { LeadIdentity, Provider } from '@/lib/outreach/types';
import { Badge, Button, Card, ErrorBox, Input, Select, Spinner, fmtDate } from '@/components/outreach/ui';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import type { ToastFn } from '../helpers';

const ADDABLE: Provider[] = ['INSTAGRAM', 'WHATSAPP'];
const ORDER: Provider[] = ['LINKEDIN', 'INSTAGRAM', 'WHATSAPP', 'GMAIL', 'OUTLOOK', 'IMAP'];

const SOURCE_LABELS: Record<string, string> = {
  import: 'from an import', inbound: 'from a message they sent', profile_fetch: 'from their profile', operator: 'added by hand', enrichment: 'from enrichment', backfill: 'from the lead',
};

function WhatsAppCheck({ i }: { i: LeadIdentity }) {
  if (i.provider !== 'WHATSAPP') return null;
  if (i.is_valid === true) return <Badge tone="green"><span title={i.last_checked_at ? `Checked ${fmtDate(i.last_checked_at)}` : undefined}>On WhatsApp</span></Badge>;
  if (i.is_valid === false) return <Badge tone="red"><span title={i.last_checked_at ? `Checked ${fmtDate(i.last_checked_at)}` : undefined}>Not on WhatsApp</span></Badge>;
  return <Badge tone="gray"><span title="Checked automatically before the first conversation">Not checked yet</span></Badge>;
}

export function identityHref(i: LeadIdentity): string | null {
  if (i.provider === 'LINKEDIN') return `https://www.linkedin.com/in/${i.identifier}`;
  if (i.provider === 'INSTAGRAM') return `https://www.instagram.com/${i.identifier.replace(/^@/, '')}/`;
  if (i.provider === 'WHATSAPP') return `https://wa.me/${i.identifier.replace(/[^\d]/g, '')}`;
  return null;
}

/** Compact list for side panels: one line per identity. */
export function IdentityList({ identities, className }: { identities: LeadIdentity[] | undefined; className?: string }) {
  if (!identities?.length) return <p className={`text-xs text-gray-500 ${className ?? ''}`}>No handles or numbers on file.</p>;
  const rows = [...identities].sort((a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));
  return (
    <ul className={`space-y-1 ${className ?? ''}`}>
      {rows.map((i) => {
        const href = identityHref(i);
        return (
          <li key={i.id ?? `${i.provider}:${i.identifier}`} className="flex items-center gap-1.5 text-xs min-w-0">
            <ProviderLogo provider={i.provider} className="w-3.5 h-3.5" />
            {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-gray-800 hover:text-indigo-600 truncate">{i.identifier}</a> : <span className="text-gray-800 truncate">{i.identifier}</span>}
            {!i.verified && <span className="text-amber-700">unverified</span>}
            <WhatsAppCheck i={i} />
          </li>
        );
      })}
    </ul>
  );
}

export function LeadIdentitiesCard({ leadId, ws, canWrite, toast }: { leadId: string; ws: string | null | undefined; canWrite: boolean; toast: ToastFn }) {
  const q = useLeadIdentities(leadId);
  const add = useIdentityAdd();
  const verify = useIdentityVerify();
  const remove = useIdentityRemove();
  const [provider, setProvider] = useState<Provider>('INSTAGRAM');
  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const rows = [...(q.data ?? [])].sort((a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const v = identifier.trim();
    if (!v) return;
    if (provider === 'WHATSAPP' && !/^(\+|00)\s*\d/.test(v)) { setError('Phone numbers need the country code, for example +91 98765 43210'); return; }
    try {
      await add.mutateAsync({ leadId, provider, identifier: v, ws });
      toast(`${channelLabel(provider)} ${provider === 'WHATSAPP' ? 'number' : 'handle'} added.`);
      setIdentifier('');
    } catch (err) { setError(parseError(err).message); }
  }

  async function act(i: LeadIdentity, kind: 'verify' | 'remove') {
    setBusyId(i.id);
    try {
      if (kind === 'verify') { await verify.mutateAsync({ id: i.id, leadId, ws }); toast('Marked as verified.'); }
      else { await remove.mutateAsync({ id: i.id, leadId, ws }); toast('Removed.'); }
    } catch (err) { toast(parseError(err).message, 'error'); }
    finally { setBusyId(null); }
  }

  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><AtSign className="w-4 h-4 text-gray-400" /> Handles and numbers</span>}>
      {q.isLoading ? <Spinner className="py-4" /> : q.isError ? <ErrorBox message={parseError(q.error).message} /> : (
        <ul className="divide-y divide-gray-100 -mt-2">
          {rows.length === 0 && <li className="py-2 text-sm text-gray-500">Nothing on file yet.</li>}
          {rows.map((i) => {
            const href = identityHref(i);
            const removable = !!i.id && i.provider !== 'LINKEDIN';
            return (
              <li key={i.id ?? `${i.provider}:${i.identifier}`} className="py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <ProviderLogo provider={i.provider} className="w-4 h-4" />
                    <span className="text-xs text-gray-500">{channelLabel(i.provider)}</span>
                    {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-gray-900 hover:text-indigo-600 truncate">{i.identifier}</a> : <span className="text-sm font-medium text-gray-900 truncate">{i.identifier}</span>}
                    {i.verified ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Unverified</Badge>}
                    <WhatsAppCheck i={i} />
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5">{i.source ? SOURCE_LABELS[i.source] ?? i.source : ''}{i.created_at ? ` · ${fmtDate(i.created_at, false)}` : ''}</div>
                </div>
                {canWrite && !!i.id && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {!i.verified && <Button size="sm" variant="secondary" loading={busyId === i.id && verify.isPending} onClick={() => act(i, 'verify')} title="Confirm this really is the person’s handle or number"><Check className="w-3.5 h-3.5" /> Verify</Button>}
                    {removable && <Button size="sm" variant="ghost" className="text-red-600" loading={busyId === i.id && remove.isPending} onClick={() => act(i, 'remove')} title="Remove"><Trash2 className="w-3.5 h-3.5" /></Button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canWrite && (
        <form onSubmit={submit} className="mt-3 pt-3 border-t border-gray-100 space-y-2">
          <div className="grid grid-cols-[minmax(0,7rem),minmax(0,1fr)] gap-2">
            <Select label="Channel" value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>{ADDABLE.map((p) => <option key={p} value={p}>{channelLabel(p)}</option>)}</Select>
            <Input label={provider === 'WHATSAPP' ? 'WhatsApp number' : 'Instagram handle'} value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder={provider === 'WHATSAPP' ? '+91 98765 43210' : '@handle or instagram.com/handle'} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-500">{provider === 'WHATSAPP' ? 'Phone numbers need the country code, for example +91 98765 43210' : 'The @ and the instagram.com/ part are optional.'}</span>
            <Button type="submit" size="sm" loading={add.isPending} disabled={!identifier.trim()}>Add</Button>
          </div>
          {error && <ErrorBox message={error} />}
        </form>
      )}
    </Card>
  );
}

export default LeadIdentitiesCard;
