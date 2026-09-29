'use client';

import { Badge, Button, Card, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import type { ConsentRow, ConsentSender, PromptListRow } from '@/lib/outreach/aiReplies';
import { isPast } from '../format';

type Tone = 'green' | 'amber' | 'red' | 'gray';

export function consentStatus(c: ConsentRow | undefined): { label: string; tone: Tone } {
  if (!c) return { label: 'No consent', tone: 'gray' };
  if (c.needs_reconsent) return { label: 'Needs re-consent', tone: 'amber' };
  if (c.valid) return { label: 'Valid', tone: 'green' };
  if (isPast(c.expires_at)) return { label: 'Expired', tone: 'red' };
  return { label: 'Not valid', tone: 'red' };
}

/** One sender: consent per master prompt, pending links and the actions a manager can take. */
export default function ConsentSenderCard({ sender, prompts, canEdit, granting, onRequest, onGrant, onRevoke }: {
  sender: ConsentSender; prompts: PromptListRow[]; canEdit: boolean; granting: string | null;
  onRequest: (promptId: string | null) => void; onGrant: (promptId: string) => void; onRevoke: (c: ConsentRow) => void;
}) {
  // Every saved master prompt gets a row, plus any consent for a prompt no longer in the list.
  const rows: Array<{ promptId: string; label: string; version: number | null; consent?: ConsentRow }> = prompts.map((p) => ({
    promptId: p.id, label: p.scope_label, version: p.version, consent: sender.consents.find((c) => c.master_prompt_id === p.id),
  }));
  for (const c of sender.consents) if (!rows.some((r) => r.promptId === c.master_prompt_id)) rows.push({ promptId: c.master_prompt_id, label: c.scope_label, version: null, consent: c });
  const promptLabel = (id: string) => prompts.find((p) => p.id === id)?.scope_label ?? sender.consents.find((c) => c.master_prompt_id === id)?.scope_label ?? 'Master prompt';

  return (
    <Card
      title={<span className="flex flex-wrap items-center gap-2">{sender.sender_name}<Badge>{sender.provider}</Badge>{sender.owner_is_me && <Badge tone="indigo">Yours</Badge>}</span>}
      actions={canEdit && <Button size="sm" variant="secondary" onClick={() => onRequest(null)} disabled={!prompts.length}>Request consent</Button>}>
      <div className="text-xs text-gray-500 mb-3">Owner: {sender.owner_email ?? <span className="text-amber-700">no email on file — requests give you a link to pass on</span>}</div>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">No master prompt saved yet.</p>
      ) : (
        <Table>
          <thead><tr><Th>Master prompt</Th><Th>Status</Th><Th>Version agreed</Th><Th>Expires</Th><Th>Granted</Th><Th className="text-right"> </Th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const st = consentStatus(r.consent);
              const needs = !r.consent || !r.consent.valid || r.consent.needs_reconsent;
              return (
                <tr key={r.promptId}>
                  <Td><span className="font-medium text-gray-900">{r.label}</span>{r.version != null && <span className="text-xs text-gray-500 ml-1">v{r.version}</span>}</Td>
                  <Td><Badge tone={st.tone}>{st.label}</Badge></Td>
                  <Td>{r.consent ? `v${r.consent.master_prompt_version}` : '—'}</Td>
                  <Td>{r.consent ? fmtDate(r.consent.expires_at, false) : '—'}</Td>
                  <Td className="text-xs">
                    {r.consent ? (
                      <>
                        <div>{r.consent.granted_via === 'owner_is_operator' ? 'By the owner, in the app' : 'Signed link'}</div>
                        <div className="text-gray-500">{r.consent.granted_by_email} · {fmtDate(r.consent.granted_at, false)}</div>
                      </>
                    ) : '—'}
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    {canEdit && needs && sender.owner_is_me && (
                      <Button size="sm" onClick={() => onGrant(r.promptId)} loading={granting === `${sender.sender_id}:${r.promptId}`}>I own this account — grant now</Button>
                    )}
                    {canEdit && needs && !sender.owner_is_me && <Button size="sm" variant="secondary" onClick={() => onRequest(r.promptId)}>{r.consent ? 'Request again' : 'Request'}</Button>}
                    {canEdit && r.consent && <Button size="sm" variant="ghost" className="ml-1 text-red-600 hover:bg-red-50" onClick={() => onRevoke(r.consent!)}>Revoke</Button>}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {sender.pending_links.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Waiting for the owner</div>
          <ul className="space-y-1 text-sm text-gray-700">
            {sender.pending_links.map((l) => (
              <li key={l.id}>
                {promptLabel(l.master_prompt_id)} — sent {l.email ? `to ${l.email} ` : ''}{fmtDate(l.created_at)}, expires {fmtDate(l.expires_at)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
