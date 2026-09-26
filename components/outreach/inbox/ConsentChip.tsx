'use client';

// WhatsApp thread header chip (PRD §10): basis, date, evidence link and a revoke action. Grey when nothing is recorded.
import { useMemo, useState } from 'react';
import { ExternalLink, ShieldCheck, ShieldOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CONSENT_BASIS_LABELS, CONSENT_BASIS_TONE, activeConsentByChannel, evidenceUrl, useLeadConsent } from '@/lib/outreach/channels';
import type { LeadConsent } from '@/lib/outreach/types';
import { fmtDate } from '@/components/outreach/ui';
import { ConsentGrantModal, ConsentRevokeModal } from '@/components/outreach/leads/detail/LeadConsentCard';

export function ConsentChip({ leadId, ws, canWrite, toast }: { leadId: string | null; ws: string; canWrite: boolean; toast: (m: string, t?: 'success' | 'error') => void }) {
  const q = useLeadConsent(leadId, ws);
  const active = useMemo(() => activeConsentByChannel(q.data).WHATSAPP ?? null, [q.data]);
  const [grantOpen, setGrantOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<LeadConsent | null>(null);
  if (!leadId) return <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500" title="Link this conversation to a lead to record consent">No consent recorded</span>;
  if (q.isLoading) return null;

  if (!active) {
    return (
      <>
        <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600" title="No WhatsApp consent recorded. Replies are always allowed; a sequence cannot start a new conversation.">
          <ShieldOff className="w-3 h-3" /> No consent recorded
          {canWrite && <button type="button" onClick={() => setGrantOpen(true)} className="ml-1 text-indigo-600 hover:underline">Record</button>}
        </span>
        <ConsentGrantModal open={grantOpen} onClose={() => setGrantOpen(false)} leadId={leadId} ws={ws} toast={toast} />
      </>
    );
  }

  const tone = CONSENT_BASIS_TONE[active.basis];
  const url = evidenceUrl(active.evidence);
  const cls = tone === 'amber' ? 'bg-amber-100 text-amber-800' : tone === 'green' ? 'bg-green-100 text-green-800' : tone === 'blue' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-700';
  return (
    <>
      <span className={cn('inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full', cls)}
        title={`WhatsApp consent: ${CONSENT_BASIS_LABELS[active.basis]}, obtained ${fmtDate(active.obtained_at, false)}${active.attested_by_email ? ` (recorded by ${active.attested_by_email})` : ''}${active.basis === 'imported_attested' ? '. Weakest basis: attested at import.' : ''}`}>
        <ShieldCheck className="w-3 h-3" />
        <span>{CONSENT_BASIS_LABELS[active.basis]} · {fmtDate(active.obtained_at, false)}</span>
        {url && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center hover:underline" title="Open the evidence"><ExternalLink className="w-3 h-3" /></a>}
        {canWrite && <button type="button" onClick={() => setRevokeTarget(active)} className="ml-1 hover:underline" title="Revoke this consent">Revoke</button>}
      </span>
      <ConsentRevokeModal consent={revokeTarget} onClose={() => setRevokeTarget(null)} leadId={leadId} ws={ws} toast={toast} />
    </>
  );
}

export default ConsentChip;
