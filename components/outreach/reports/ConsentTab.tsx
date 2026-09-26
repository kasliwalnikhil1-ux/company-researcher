'use client';

// Reports → Consent (PRD §12): who was contacted on WhatsApp in the period and on what basis, with evidence links.
// This is the artefact a client hands over if a number is challenged, so it exports as it is shown.
import Link from 'next/link';
import { AlertTriangle, ExternalLink, ShieldCheck } from 'lucide-react';
import { Badge, EmptyState, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import { csvFileName, downloadCsv, fmtInt, fmtRate } from '@/lib/outreach/reports';
import { CONSENT_BASIS_LABELS, CONSENT_BASIS_TONE, evidenceNote, evidenceUrl, useConsentReport, type ConsentReportRow } from '@/lib/outreach/channels';
import { CONSENT_BASES, type ConsentBasis } from '@/lib/outreach/types';
import { ExportButton, KpiTile, Refreshing, RetryError, Section, SortTh, TableSkeleton, TilesSkeleton, useSort } from './primitives';
import type { TabProps } from './OverviewTab';

const ACCESSORS: Record<string, (r: ConsentReportRow) => string | number | null> = {
  lead: (r) => (r.lead_name ?? '').toLowerCase(), basis: (r) => r.basis, obtained_at: (r) => r.obtained_at, contacted: (r) => r.first_new_chat_at, sender: (r) => (r.sender_name ?? '').toLowerCase(), by: (r) => (r.attested_by_email ?? '').toLowerCase(),
};

export default function ConsentTab({ ws, client, range }: TabProps) {
  const q = useConsentReport({ ws, client, range });
  const { sorted, sort, toggle } = useSort(q.data?.rows, { key: 'contacted', dir: 'desc' }, ACCESSORS);

  if (q.isLoading) return <div className="space-y-4"><TilesSkeleton count={4} /><TableSkeleton cols={6} /></div>;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  if (!r) return null;
  const th = { sort, onSort: toggle };
  const byBasis = CONSENT_BASES.map((b) => ({ basis: b, ...(r.by_basis?.[b] ?? { leads: 0, share_pct: null }) })).filter((x) => x.leads > 0);

  const exportCsv = () => downloadCsv<ConsentReportRow>(csvFileName('consent', range), [
    { header: 'Lead', value: (x) => x.lead_name }, { header: 'Basis', value: (x) => CONSENT_BASIS_LABELS[x.basis] ?? x.basis }, { header: 'Obtained on', value: (x) => x.obtained_at },
    { header: 'Evidence link', value: (x) => evidenceUrl(x.evidence) }, { header: 'Evidence note', value: (x) => evidenceNote(x.evidence) }, { header: 'Recorded by', value: (x) => x.attested_by_email },
    { header: 'First contacted on WhatsApp', value: (x) => x.first_new_chat_at }, { header: 'Sender', value: (x) => x.sender_name },
  ], sorted);

  return (
    <div className="space-y-4">
      {r.alert && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span><span className="font-medium">{fmtRate(r.imported_attested_share_pct)} of the people contacted rely on “attested at import”.</span> That is the weakest basis. Above 30% it is worth replacing it with a form, a reply or a message from the person wherever one exists.</span>
        </div>
      )}
      <Refreshing active={q.isPlaceholderData}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiTile label="Contacted on WhatsApp" value={fmtInt(r.contacted)} sub="People who received a first message in the period" />
          <KpiTile label="Attested at import" value={fmtRate(r.imported_attested_share_pct)} sub={r.alert ? 'Above the 30% line' : 'Share of contacted people'} />
          {byBasis.slice(0, 2).map((b) => <KpiTile key={b.basis} label={CONSENT_BASIS_LABELS[b.basis]} value={fmtInt(b.leads)} sub={`${fmtRate(b.share_pct)} of contacted`} />)}
        </div>
        {byBasis.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {byBasis.map((b) => <Badge key={b.basis} tone={CONSENT_BASIS_TONE[b.basis as ConsentBasis]}>{CONSENT_BASIS_LABELS[b.basis as ConsentBasis]}: {fmtInt(b.leads)} ({fmtRate(b.share_pct)})</Badge>)}
          </div>
        )}
        <Section className="mt-4" title={<span className="inline-flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-gray-400" /> Consent record</span>}
          description="One line per person contacted on WhatsApp, with the basis and the evidence behind it. Export it as the record to hand over if a number is ever challenged."
          actions={<ExportButton onClick={exportCsv} disabled={!sorted.length} />}>
          {!sorted.length ? <EmptyState icon={<ShieldCheck className="w-6 h-6" />} title="Nobody was contacted on WhatsApp in this period" description="Rows appear once a WhatsApp sender starts a conversation. Consent recorded on leads who were not contacted yet shows on the lead page." /> : (
            <div className="[&_td]:px-3 [&_th]:px-3"><Table>
              <thead><tr>
                <SortTh label="Lead" sortKey="lead" align="left" firstDir="asc" {...th} /><SortTh label="Basis" sortKey="basis" align="left" firstDir="asc" {...th} /><SortTh label="Obtained" sortKey="obtained_at" align="left" {...th} />
                <Th>Evidence</Th><SortTh label="Recorded by" sortKey="by" align="left" firstDir="asc" {...th} /><SortTh label="First contacted" sortKey="contacted" align="left" {...th} /><SortTh label="Sender" sortKey="sender" align="left" firstDir="asc" {...th} />
              </tr></thead>
              <tbody>{sorted.map((x, i) => {
                const url = evidenceUrl(x.evidence); const note = evidenceNote(x.evidence);
                return (
                  <tr key={`${x.lead_id}-${i}`} className="hover:bg-gray-50">
                    <Td><Link href={`/outreach/leads/${x.lead_id}`} className="font-medium text-gray-900 hover:underline">{x.lead_name ?? 'Lead'}</Link></Td>
                    <Td><Badge tone={CONSENT_BASIS_TONE[x.basis] ?? 'gray'}>{CONSENT_BASIS_LABELS[x.basis] ?? x.basis}</Badge></Td>
                    <Td className="whitespace-nowrap text-xs">{fmtDate(x.obtained_at, false)}</Td>
                    <Td className="text-xs max-w-[240px]">
                      {url && <a href={url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline inline-flex items-center gap-1"><ExternalLink className="w-3 h-3" /> Link</a>}
                      {note && <span className={url ? 'ml-2 text-gray-600 truncate' : 'text-gray-600 truncate'} title={note}>{note}</span>}
                      {!url && !note && <span className="text-gray-400">—</span>}
                    </Td>
                    <Td className="text-xs text-gray-600">{x.attested_by_email ?? <span className="text-gray-400">automatic</span>}</Td>
                    <Td className="whitespace-nowrap text-xs">{fmtDate(x.first_new_chat_at)}</Td>
                    <Td className="text-xs text-gray-600">{x.sender_name ?? '—'}</Td>
                  </tr>
                );
              })}</tbody>
            </Table></div>
          )}
        </Section>
      </Refreshing>
    </div>
  );
}
