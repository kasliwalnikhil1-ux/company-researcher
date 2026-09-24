'use client';

import Link from 'next/link';
import type { Client, Lead, List, Stage, Tag } from '@/lib/outreach/types';
import { Avatar, Badge, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import { Briefcase, Mail, MessageSquare, ShieldOff, Sparkles } from 'lucide-react';
import { profileOf, type LeadIntelFields, type LeadProfileSummary } from '@/lib/outreach/intel';
import { chipStyle, leadName } from './helpers';

export type LeadRow = Lead & LeadIntelFields & { outreach_lead_tags: { tag_id: string }[]; outreach_lead_profiles?: LeadProfileSummary | LeadProfileSummary[] | null };

function compact(n: number): string { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

export function TagChip({ tag, size = 'xs' }: { tag: Tag; size?: 'xs' | 'sm' }) {
  return <span className={size === 'xs' ? 'inline-flex items-center px-1.5 py-0.5 rounded-full text-[11px] font-medium border' : 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border'} style={chipStyle(tag.color)}>{tag.name}</span>;
}
export function StageChip({ stage }: { stage: Stage }) {
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border" style={chipStyle(stage.color)}>{stage.name}</span>;
}

export function EmailIcons({ lead }: { lead: Partial<Lead> }) {
  if (!lead.email_work && !lead.email_personal) return <span className="text-gray-300">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {lead.email_work && <a href={`mailto:${lead.email_work}`} title={`Work: ${lead.email_work}`} className="text-indigo-600 hover:text-indigo-800" onClick={(e) => e.stopPropagation()}><Briefcase className="w-4 h-4" /></a>}
      {lead.email_personal && <a href={`mailto:${lead.email_personal}`} title={`Personal: ${lead.email_personal}`} className="text-gray-500 hover:text-gray-800" onClick={(e) => e.stopPropagation()}><Mail className="w-4 h-4" /></a>}
    </span>
  );
}

export function LeadsTable({ rows, selected, onToggle, onToggleAll, clients, lists, stages, tags, selectable }: {
  rows: LeadRow[]; selected: Set<string>; onToggle: (id: string) => void; onToggleAll: () => void;
  clients?: Client[]; lists?: List[]; stages?: Stage[]; tags?: Tag[]; selectable: boolean;
}) {
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someOnPage = rows.some((r) => selected.has(r.id));
  const tagMap = new Map((tags ?? []).map((t) => [t.id, t]));
  const stageMap = new Map((stages ?? []).map((s) => [s.id, s]));
  const listMap = new Map((lists ?? []).map((l) => [l.id, l]));
  const clientMap = new Map((clients ?? []).map((c) => [c.id, c]));

  return (
    <Table>
      <thead>
        <tr>
          {selectable && (
            <Th className="w-10">
              <input type="checkbox" aria-label="Select all on page" checked={allOnPage} ref={(el) => { if (el) el.indeterminate = !allOnPage && someOnPage; }} onChange={onToggleAll} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
            </Th>
          )}
          <Th>Lead</Th>
          <Th className="hidden lg:table-cell">Headline</Th>
          <Th>Company / title</Th>
          <Th className="hidden xl:table-cell">Location</Th>
          <Th>Emails</Th>
          <Th className="hidden md:table-cell">Tags</Th>
          <Th className="hidden lg:table-cell">Signals</Th>
          <Th>Stage</Th>
          <Th className="hidden lg:table-cell">List</Th>
          {clients && clients.length > 0 && <Th className="hidden xl:table-cell">Client</Th>}
          <Th className="hidden md:table-cell" title="Do not contact — flagged leads are excluded from every sequence">DNC</Th>
          <Th className="hidden lg:table-cell">Created</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => {
          const stage = l.stage_id ? stageMap.get(l.stage_id) : undefined;
          const list = l.list_id ? listMap.get(l.list_id) : undefined;
          const client = l.client_id ? clientMap.get(l.client_id) : undefined;
          const leadTags = (l.outreach_lead_tags ?? []).map((t) => tagMap.get(t.tag_id)).filter((t): t is Tag => !!t);
          const isSel = selected.has(l.id);
          const prof = profileOf(l);
          return (
            <tr key={l.id} className={isSel ? 'bg-indigo-50/40' : 'hover:bg-gray-50'}>
              {selectable && (
                <Td className="w-10"><input type="checkbox" aria-label={`Select ${leadName(l)}`} checked={isSel} onChange={() => onToggle(l.id)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /></Td>
              )}
              <Td>
                <Link href={`/outreach/leads/${l.id}`} className="flex items-center gap-2.5 min-w-[160px] group">
                  <Avatar src={l.picture_url} name={leadName(l)} size={8} />
                  <span className="min-w-0">
                    <span className="block font-medium text-gray-900 group-hover:text-indigo-700 truncate max-w-[220px]">{leadName(l)}</span>
                    {l.public_identifier && <span className="block text-xs text-gray-400 truncate max-w-[220px]">in/{l.public_identifier}</span>}
                  </span>
                </Link>
              </Td>
              <Td className="hidden lg:table-cell"><span className="block max-w-[260px] truncate text-gray-600" title={l.headline ?? undefined}>{l.headline ?? '—'}</span></Td>
              <Td>
                <span className="block max-w-[200px] truncate text-gray-900">{l.company ?? '—'}</span>
                {l.title && <span className="block max-w-[200px] truncate text-xs text-gray-500">{l.title}</span>}
              </Td>
              <Td className="hidden xl:table-cell"><span className="block max-w-[160px] truncate text-gray-600">{l.location ?? '—'}</span></Td>
              <Td><EmailIcons lead={l} /></Td>
              <Td className="hidden md:table-cell">
                <span className="flex flex-wrap gap-1 max-w-[220px]">
                  {leadTags.slice(0, 3).map((t) => <TagChip key={t.id} tag={t} />)}
                  {leadTags.length > 3 && <span className="text-[11px] text-gray-500" title={leadTags.slice(3).map((t) => t.name).join(', ')}>+{leadTags.length - 3}</span>}
                  {leadTags.length === 0 && <span className="text-gray-300">—</span>}
                </span>
              </Td>
              <Td className="hidden lg:table-cell">
                <span className="flex flex-wrap items-center gap-1 max-w-[200px]">
                  {l.last_replied_at && <Badge tone="purple"><span title={`Last replied ${fmtDate(l.last_replied_at)}${l.last_replied_channel ? ` on ${l.last_replied_channel}` : ''}`} className="inline-flex items-center"><MessageSquare className="w-3 h-3 mr-1" />Replied</span></Badge>}
                  {l.enrich_status === 'done' || l.enriched_at ? <Badge tone="green"><span title={l.enriched_at ? `Enriched ${fmtDate(l.enriched_at)}` : 'Enriched'} className="inline-flex items-center"><Sparkles className="w-3 h-3 mr-1" />Enriched</span></Badge>
                    : l.enrich_status === 'waiting' ? <Badge tone="blue">Enrichment waiting</Badge> : l.enrich_status === 'failed' ? <Badge tone="red">Enrichment failed</Badge> : null}
                  {prof?.follower_count != null && <span className="text-[11px] text-gray-500 tabular-nums" title={`${prof.follower_count.toLocaleString()} followers`}>{compact(prof.follower_count)} followers</span>}
                  {!l.last_replied_at && !l.enriched_at && (!l.enrich_status || l.enrich_status === 'none') && <span className="text-gray-300">—</span>}
                </span>
              </Td>
              <Td>{stage ? <StageChip stage={stage} /> : <span className="text-gray-300">—</span>}</Td>
              <Td className="hidden lg:table-cell"><span className="block max-w-[140px] truncate text-gray-600">{list?.name ?? '—'}</span></Td>
              {clients && clients.length > 0 && <Td className="hidden xl:table-cell"><span className="block max-w-[140px] truncate text-gray-600">{client?.name ?? '—'}</span></Td>}
              <Td className="hidden md:table-cell">{l.do_not_contact ? <span title="Do not contact — this lead is excluded from every sequence" className="cursor-help"><Badge tone="red"><ShieldOff className="w-3 h-3 mr-1" /> DNC</Badge></span> : l.unsubscribed ? <span title="Unsubscribed — this lead opted out of emails" className="cursor-help"><Badge tone="amber">unsubscribed</Badge></span> : <span className="text-gray-300">—</span>}</Td>
              <Td className="hidden lg:table-cell whitespace-nowrap text-gray-500 text-xs">{fmtDate(l.created_at, false)}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
