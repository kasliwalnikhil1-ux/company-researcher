'use client';

// Consent (PRD §6): the active basis per channel, a grant form, and revoke with a reason. WhatsApp needs a recorded
// basis before a new conversation can be started; Instagram consent is recorded and shown but does not block.
import { useMemo, useState } from 'react';
import { ExternalLink, ShieldCheck, ShieldOff } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import {
  CONSENT_BASES_NEED_EVIDENCE, CONSENT_BASIS_HELP, CONSENT_BASIS_LABELS, CONSENT_BASIS_TONE, activeConsentByChannel, channelLabel, consentIsActive, evidenceNote, evidenceUrl,
  useConsentGrant, useConsentRevoke, useLeadConsent,
} from '@/lib/outreach/channels';
import { CONSENT_BASES, type ConsentBasis, type LeadConsent, type Provider } from '@/lib/outreach/types';
import { Badge, Button, Card, ErrorBox, Input, Modal, Select, Spinner, Textarea, fmtDate } from '@/components/outreach/ui';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import type { ToastFn } from '../helpers';

const CONSENT_CHANNELS: Provider[] = ['WHATSAPP', 'INSTAGRAM'];
const REVOKE_REASONS: Array<{ value: string; label: string }> = [
  { value: 'manual', label: 'Removed by our team' },
  { value: 'lead_request', label: 'The person asked us to stop' },
  { value: 'mistake', label: 'Recorded by mistake' },
  { value: 'expired', label: 'No longer valid' },
];

/** Small chip: "WhatsApp consent: they messaged first" (amber when attested at import). */
export function ConsentBadge({ consent, showChannel = true, className }: { consent: LeadConsent; showChannel?: boolean; className?: string }) {
  const tone = consentIsActive(consent) ? CONSENT_BASIS_TONE[consent.basis] : 'gray';
  return (
    <Badge tone={tone} className={className}>
      <span title={`${CONSENT_BASIS_LABELS[consent.basis]} · ${fmtDate(consent.obtained_at, false)}${consent.revoked_at ? ' · revoked' : ''}`}>
        {showChannel ? `${channelLabel(consent.channel)} consent: ` : ''}{CONSENT_BASIS_LABELS[consent.basis].toLowerCase()}{consent.revoked_at ? ' (revoked)' : ''}
      </span>
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Grant form (shared with the inbox)
// ---------------------------------------------------------------------------
export function ConsentGrantModal({ open, onClose, leadId, ws, defaultChannel = 'WHATSAPP', toast }: { open: boolean; onClose: () => void; leadId: string; ws: string | null | undefined; defaultChannel?: Provider; toast: ToastFn }) {
  const grant = useConsentGrant();
  const [channel, setChannel] = useState<Provider>(defaultChannel);
  const [basis, setBasis] = useState<ConsentBasis>('explicit_share');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [obtained, setObtained] = useState(() => new Date().toISOString().slice(0, 10));
  const [expires, setExpires] = useState('');
  const [error, setError] = useState<string | null>(null);
  const needsEvidence = CONSENT_BASES_NEED_EVIDENCE.includes(basis);
  const evidenceOk = !needsEvidence || !!url.trim() || !!note.trim();
  const urlOk = !url.trim() || /^https?:\/\/\S+$/i.test(url.trim());

  async function submit() {
    setError(null);
    if (!evidenceOk) { setError('This basis needs a link or a note as evidence.'); return; }
    if (!urlOk) { setError('The evidence link must start with http:// or https://'); return; }
    const evidence: Record<string, unknown> = {};
    if (url.trim()) evidence.url = url.trim();
    if (note.trim()) evidence.note = note.trim();
    try {
      await grant.mutateAsync({ leadId, channel, basis, evidence, obtainedAt: obtained ? `${obtained}T00:00:00Z` : null, expiresAt: expires ? `${expires}T23:59:59Z` : null, ws });
      toast(`${channelLabel(channel)} consent recorded.`);
      onClose();
      setUrl(''); setNote(''); setExpires('');
    } catch (e) { setError(parseError(e).message); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Record consent" size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={grant.isPending}>Cancel</Button><Button loading={grant.isPending} onClick={submit}>Record consent</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">Say how this person agreed to hear from you. WhatsApp needs a recorded basis before a new conversation can start. For Instagram the basis is kept for the record and does not block anything.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as Provider)}>
            {CONSENT_CHANNELS.map((c) => <option key={c} value={c}>{channelLabel(c)}{c === 'INSTAGRAM' ? ' (advisory)' : ''}</option>)}
          </Select>
          <Select label="Basis" value={basis} onChange={(e) => setBasis(e.target.value as ConsentBasis)}>
            {CONSENT_BASES.map((b) => <option key={b} value={b}>{CONSENT_BASIS_LABELS[b]}</option>)}
          </Select>
        </div>
        <div className={basis === 'imported_attested' ? 'text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2' : 'text-xs text-gray-500'}>{CONSENT_BASIS_HELP[basis]}</div>
        <Input label={`Evidence link${needsEvidence ? '' : ' (optional)'}`} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} error={!urlOk ? 'Must start with http:// or https://' : undefined} hint="A form submission, an order, a message: anything you could show if asked." />
        <Textarea label={`Note${needsEvidence ? ' (or a link above)' : ' (optional)'}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Gave the number on the call on 12 Sept" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Obtained on" type="date" value={obtained} onChange={(e) => setObtained(e.target.value)} />
          <Input label="Expires on (optional)" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} hint="Leave empty if it does not run out." />
        </div>
        <p className="text-xs text-gray-500">Recorded with your name and the date. It appears in the client consent report.</p>
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Revoke confirmation (shared with the inbox)
// ---------------------------------------------------------------------------
export function ConsentRevokeModal({ consent, onClose, leadId, ws, toast }: { consent: LeadConsent | null; onClose: () => void; leadId: string; ws: string | null | undefined; toast: ToastFn }) {
  const revoke = useConsentRevoke();
  const [reason, setReason] = useState('manual');
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!consent) return;
    setError(null);
    try {
      await revoke.mutateAsync({ id: consent.id, leadId, reason, ws });
      toast(`${channelLabel(consent.channel)} consent revoked.`);
      onClose();
    } catch (e) { setError(parseError(e).message); }
  }
  return (
    <Modal open={!!consent} onClose={onClose} title="Revoke consent?" size="sm"
      footer={<><Button variant="secondary" onClick={onClose} disabled={revoke.isPending}>Cancel</Button><Button variant="danger" loading={revoke.isPending} onClick={submit}>Revoke</Button></>}>
      {consent && (
        <div className="space-y-3">
          <p className="text-sm text-gray-700">No {channelLabel(consent.channel)} conversation will be started with this person. Live sequences on that channel exit now and queued messages are cancelled. Replies to messages they send stay possible. A new basis can be recorded later.</p>
          <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>{REVOKE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select>
          {error && <ErrorBox message={error} />}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The card on the lead page
// ---------------------------------------------------------------------------
function ConsentRow({ c, canWrite, onRevoke }: { c: LeadConsent; canWrite: boolean; onRevoke: (c: LeadConsent) => void }) {
  const url = evidenceUrl(c.evidence);
  const note = evidenceNote(c.evidence);
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${c.basis === 'imported_attested' ? 'border-amber-200 bg-amber-50/60' : 'border-gray-200'}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0"><ProviderLogo provider={c.channel} className="w-4 h-4" /><span className="text-sm font-medium text-gray-900">{channelLabel(c.channel)}</span><ConsentBadge consent={c} showChannel={false} /></div>
        {canWrite && <button type="button" onClick={() => onRevoke(c)} className="text-xs text-red-600 hover:underline inline-flex items-center gap-1"><ShieldOff className="w-3 h-3" /> Revoke</button>}
      </div>
      <div className="text-xs text-gray-600 mt-1">Obtained {fmtDate(c.obtained_at, false)}{c.attested_by_email ? ` · recorded by ${c.attested_by_email}` : ''}{c.expires_at ? ` · expires ${fmtDate(c.expires_at, false)}` : ''}</div>
      {(url || note) && (
        <div className="text-xs text-gray-600 mt-1 flex items-center gap-2 flex-wrap">
          {url && <a href={url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline inline-flex items-center gap-1"><ExternalLink className="w-3 h-3" /> Evidence</a>}
          {note && <span className="truncate" title={note}>{note}</span>}
        </div>
      )}
      {c.basis === 'imported_attested' && <div className="text-[11px] text-amber-800 mt-1">Weakest basis: attested at import. Prefer a form, a reply or a message from the person when you have one.</div>}
    </div>
  );
}

export function LeadConsentCard({ leadId, ws, canWrite, toast }: { leadId: string; ws: string | null | undefined; canWrite: boolean; toast: ToastFn }) {
  const q = useLeadConsent(leadId, ws);
  const active = useMemo(() => activeConsentByChannel(q.data), [q.data]);
  const activeList = CONSENT_CHANNELS.map((c) => active[c]).filter((c): c is LeadConsent => !!c);
  const history = useMemo(() => (q.data ?? []).filter((c) => !consentIsActive(c)), [q.data]);
  const [grantOpen, setGrantOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<LeadConsent | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-gray-400" /> Consent</span>}
      actions={canWrite ? <Button size="sm" variant="secondary" onClick={() => setGrantOpen(true)}>Record consent</Button> : undefined}>
      {q.isLoading ? <Spinner className="py-4" /> : q.isError ? <ErrorBox message={parseError(q.error).message} /> : (
        <div className="space-y-2">
          {activeList.length === 0 && (
            <div className="text-sm text-gray-600">
              <div className="flex items-center gap-2"><Badge tone="gray">No consent recorded</Badge></div>
              <p className="text-xs text-gray-500 mt-2">A WhatsApp sequence cannot start a conversation with this person until a basis is recorded. Someone who writes in on WhatsApp is recorded automatically.</p>
            </div>
          )}
          {activeList.map((c) => <ConsentRow key={c.id} c={c} canWrite={canWrite} onRevoke={setRevokeTarget} />)}
          {activeList.length > 0 && !active.WHATSAPP && <p className="text-xs text-gray-500">No WhatsApp consent yet: WhatsApp sequences cannot start a conversation.</p>}
          {history.length > 0 && (
            <div>
              <button type="button" onClick={() => setShowHistory((v) => !v)} className="text-xs text-gray-500 hover:text-gray-800">{showHistory ? 'Hide' : 'Show'} earlier records ({history.length})</button>
              {showHistory && (
                <ul className="mt-2 space-y-1 text-xs text-gray-500">
                  {history.map((c) => <li key={c.id}>{channelLabel(c.channel)} · {CONSENT_BASIS_LABELS[c.basis]} · obtained {fmtDate(c.obtained_at, false)} · {c.revoked_at ? `revoked ${fmtDate(c.revoked_at, false)}${c.revoked_reason ? ` (${c.revoked_reason.replace(/_/g, ' ')})` : ''}` : 'expired'}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      <ConsentGrantModal open={grantOpen} onClose={() => setGrantOpen(false)} leadId={leadId} ws={ws} toast={toast} />
      <ConsentRevokeModal consent={revokeTarget} onClose={() => setRevokeTarget(null)} leadId={leadId} ws={ws} toast={toast} />
    </Card>
  );
}

export default LeadConsentCard;
