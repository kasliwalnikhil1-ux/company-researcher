'use client';

import Link from 'next/link';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSenders } from '@/lib/outreach/queries';
import type { LeadSenderState, Relation } from '@/lib/outreach/types';
import { Badge, Card, EmptyState, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import { Check, X } from 'lucide-react';

const RELATION: Record<Relation, { tone: 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo' | 'purple'; label: string }> = {
  none: { tone: 'gray', label: 'Not connected' }, pending_out: { tone: 'blue', label: 'Invite pending' }, pending_in: { tone: 'purple', label: 'They invited' },
  first: { tone: 'green', label: '1st degree' }, blocked: { tone: 'red', label: 'Blocked' }, invalid: { tone: 'red', label: 'Invalid profile' },
};

export function RelationBadge({ relation }: { relation: Relation }) {
  const r = RELATION[relation] ?? { tone: 'gray', label: relation };
  return <Badge tone={r.tone}>{r.label}</Badge>;
}

function Bool({ v }: { v: boolean }) {
  return v ? <span className="inline-flex items-center gap-1 text-green-700 text-xs"><Check className="w-3.5 h-3.5" /> yes</span> : <span className="inline-flex items-center gap-1 text-gray-400 text-xs"><X className="w-3.5 h-3.5" /> no</span>;
}

export function LeadRelations({ states }: { states: LeadSenderState[] }) {
  const { workspace } = useWorkspace();
  const senders = useSenders(workspace?.id);
  return (
    <Card title="Senders & relation state" className="[&>div:last-child]:p-0">
      {states.length === 0 ? <EmptyState title="No sender has touched this lead" description="Relation state appears once a sender views, invites or messages this person." /> : (
        <Table className="border-0 rounded-none rounded-b-xl">
          <thead>
            <tr>
              <Th>Sender</Th><Th>Relation</Th>
              <Th className="hidden md:table-cell">Invite sent</Th><Th className="hidden md:table-cell">Accepted</Th><Th className="hidden lg:table-cell">Withdrawn</Th>
              <Th className="hidden lg:table-cell">Last outbound</Th><Th className="hidden lg:table-cell">Last inbound</Th>
              <Th>Replied</Th><Th className="hidden md:table-cell">Bounced</Th>
            </tr>
          </thead>
          <tbody>
            {states.map((s) => {
              const sender = senders.data?.find((x) => x.id === s.sender_id);
              return (
                <tr key={s.sender_id}>
                  <Td>{sender ? <Link href={`/outreach/senders/${sender.id}`} className="font-medium text-gray-900 hover:text-indigo-700">{sender.display_name ?? sender.public_identifier ?? sender.owner_email ?? 'Sender'}</Link> : <span className="text-gray-500">Removed sender</span>}</Td>
                  <Td><RelationBadge relation={s.relation} /></Td>
                  <Td className="hidden md:table-cell text-xs text-gray-600 whitespace-nowrap">{fmtDate(s.invite_sent_at)}{s.invite_sent_at && s.invite_had_note != null ? <span className="text-gray-400"> · {s.invite_had_note ? 'with note' : 'no note'}</span> : null}</Td>
                  <Td className="hidden md:table-cell text-xs text-gray-600 whitespace-nowrap">{fmtDate(s.invite_accepted_at ?? s.invite_detected_at)}</Td>
                  <Td className="hidden lg:table-cell text-xs text-gray-600 whitespace-nowrap">{fmtDate(s.invite_withdrawn_at)}</Td>
                  <Td className="hidden lg:table-cell text-xs text-gray-600 whitespace-nowrap">{fmtDate(s.last_outbound_at)}</Td>
                  <Td className="hidden lg:table-cell text-xs text-gray-600 whitespace-nowrap">{fmtDate(s.last_inbound_at)}</Td>
                  <Td><Bool v={s.replied} /></Td>
                  <Td className="hidden md:table-cell"><Bool v={s.email_bounced} /></Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
