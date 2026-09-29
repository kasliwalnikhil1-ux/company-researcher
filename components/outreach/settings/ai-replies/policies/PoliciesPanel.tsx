'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Plus } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { useClients, useSenders, useSequences } from '@/lib/outreach/queries';
import { MODE_LABEL, useClearReplyPolicy, useReplyPolicies, type PolicyFields, type PolicyRow, type PolicyScope } from '@/lib/outreach/aiReplies';
import { Badge, Button, Card, ErrorBox, Spinner, Table, Td, Th } from '@/components/outreach/ui';
import { ConfirmModal } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';
import { SCOPE_LABEL, countriesText, fmtSeconds } from '../format';
import { inheritedFields, rowFields } from './policyForm';
import PolicyEditor, { type PolicyTarget } from './PolicyEditor';
import AddOverrideModal from './AddOverrideModal';

const SCOPE_ORDER: Record<PolicyScope, number> = { workspace: 0, client: 1, sender: 2, sequence: 3 };
const keyOf = (scope: PolicyScope, id: string | null) => `${scope}:${id ?? ''}`;

/** Reply policies: the workspace row (always shown) plus client / sender / sequence overrides. Managers edit; members read. */
export default function PoliciesPanel({ ws, canEdit, focus, notify }: {
  ws: string; canEdit: boolean; focus: { scope: PolicyScope; scopeId: string | null } | null;
  notify: (m: string, t?: 'success' | 'error') => void;
}) {
  const q = useReplyPolicies(ws);
  const clients = useClients(ws);
  const sequences = useSequences(ws);
  const senders = useSenders(ws);
  const clear = useClearReplyPolicy(ws);
  const [editing, setEditing] = useState<{ scope: PolicyScope; scopeId: string | null } | null>(focus);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PolicyRow | null>(null);

  const entities = useMemo(() => ({
    client: (clients.data ?? []).map((c) => ({ id: c.id, label: c.name })),
    sequence: (sequences.data ?? []).map((s) => ({ id: s.id, label: s.name })),
    sender: (senders.data ?? []).map((s) => ({ id: s.id, label: s.display_name || s.public_identifier || 'Sender', hint: s.provider })),
  }), [clients.data, sequences.data, senders.data]);

  const rows = useMemo(() => {
    const list = [...(q.data?.rows ?? [])];
    if (!list.some((r) => r.scope === 'workspace')) {
      list.push({ id: '', scope: 'workspace', scope_id: null, scope_label: 'Workspace', ...rowFields(null), downgraded_at: null, downgrade_reason: null, note: null, updated_at: '' });
    }
    return list.sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || (a.scope_label ?? '').localeCompare(b.scope_label ?? ''));
  }, [q.data]);
  const taken = useMemo(() => new Set(rows.map((r) => keyOf(r.scope, r.scope_id))), [rows]);

  const labelFor = (scope: PolicyScope, id: string | null): string => {
    if (scope === 'workspace') return 'Workspace';
    const row = rows.find((r) => r.scope === scope && r.scope_id === id);
    if (row?.scope_label) return row.scope_label;
    return entities[scope].find((e) => e.id === id)?.label ?? SCOPE_LABEL[scope];
  };

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox message={parseError(q.error).message} />;

  const editRow = editing ? rows.find((r) => r.scope === editing.scope && r.scope_id === editing.scopeId && r.id !== '') ?? null : null;
  const editTarget: PolicyTarget | null = editing ? { ...editing, label: labelFor(editing.scope, editing.scopeId) } : null;
  const inh = editing ? inheritedFields(editing.scope, q.data) : null;

  async function doRemove() {
    if (!removing?.scope_id || removing.scope === 'workspace') return;
    try {
      await clear.mutateAsync({ scope: removing.scope, scopeId: removing.scope_id });
      notify(`Override for ${removing.scope_label} removed`);
      setRemoving(null);
    } catch (e) { notify(parseError(e).message, 'error'); }
  }

  return (
    <Card title="Reply policies" actions={canEdit && <Button size="sm" onClick={() => setAdding(true)}><Plus className="w-3.5 h-3.5" />Add override</Button>}>
      <p className="text-sm text-gray-600 mb-4">
        Mode, timing and limits for AI replies. Set them for the whole workspace, then override for a client, a sender or a sequence. Grey values are inherited.
      </p>
      <Table>
        <thead>
          <tr>
            <Th>Applies to</Th><Th>Mode</Th><Th title="Random wait before an autopilot send">Hold</Th><Th>AI sends / day</Th>
            <Th title="Autopilot pauses this long after a person replies">Pause after a person</Th><Th>Disclosure</Th><Th>Blocked</Th><Th className="text-right"> </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const own = rowFields(r);
            const { fields: parent } = inheritedFields(r.scope, q.data);
            const v = <K extends keyof PolicyFields>(k: K) => ({ value: own[k] ?? parent[k], inherited: own[k] == null });
            const mode = v('mode'); const lo = v('delay_min_s'); const hi = v('delay_max_s'); const sends = v('max_ai_sends_per_sender_day');
            const pause = v('human_takeover_pause_h'); const disc = v('disclosure'); const bc = v('blocked_countries');
            return (
              <tr key={keyOf(r.scope, r.scope_id)} className="align-top">
                <Td>
                  <div className="font-medium text-gray-900">{r.scope === 'workspace' ? 'Workspace' : r.scope_label}</div>
                  <div className="text-xs text-gray-500">{SCOPE_LABEL[r.scope]}</div>
                  {r.downgraded_at && (
                    <div className="mt-1 flex items-start gap-1 text-xs text-red-700 max-w-xs">
                      <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" aria-hidden="true" />
                      <span>Switched back to Draft: {r.downgrade_reason || 'too many cancelled or edited replies'}</span>
                    </div>
                  )}
                </Td>
                <Td><Val inherited={mode.inherited}>{mode.value ? <Badge tone={mode.value === 'autopilot' ? 'purple' : mode.value === 'draft' ? 'indigo' : 'gray'}>{MODE_LABEL[mode.value]}</Badge> : '—'}</Val></Td>
                <Td><Val inherited={lo.inherited && hi.inherited}>{fmtSeconds(lo.value)}–{fmtSeconds(hi.value)}</Val></Td>
                <Td><Val inherited={sends.inherited}>{sends.value ?? '—'}</Val></Td>
                <Td><Val inherited={pause.inherited}>{pause.value != null ? `${pause.value} h` : '—'}</Val></Td>
                <Td><Val inherited={disc.inherited}><span className="block max-w-[12rem] truncate" title={disc.value ?? undefined}>{disc.value || 'None'}</span></Val></Td>
                <Td><Val inherited={bc.inherited}>{countriesText(bc.value)}</Val></Td>
                <Td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="secondary" onClick={() => setEditing({ scope: r.scope, scopeId: r.scope_id })}>{canEdit ? 'Edit' : 'View'}</Button>
                  {canEdit && r.scope !== 'workspace' && <Button size="sm" variant="ghost" className="ml-1 text-red-600 hover:bg-red-50" onClick={() => setRemoving(r)}>Remove</Button>}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      {editTarget && inh && (
        <PolicyEditor key={keyOf(editTarget.scope, editTarget.scopeId)} ws={ws} target={editTarget} row={editRow}
          inherited={inh.fields} inheritedFrom={inh.from} canEdit={canEdit} onClose={() => setEditing(null)} notify={notify} />
      )}
      {adding && (
        <AddOverrideModal entities={entities} taken={taken} onClose={() => setAdding(false)}
          onPick={(t) => { setAdding(false); setEditing({ scope: t.scope, scopeId: t.scopeId }); }} />
      )}
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} onConfirm={doRemove} loading={clear.isPending}
        title="Remove this override?" confirmLabel="Remove">
        <p><strong>{removing?.scope_label}</strong> will follow the workspace policy again.</p>
      </ConfirmModal>
    </Card>
  );
}

function Val({ inherited, children }: { inherited: boolean; children: ReactNode }) {
  return <span className={cn('text-sm', inherited ? 'text-gray-400' : 'text-gray-900')} title={inherited ? 'Inherited' : undefined}>{children}</span>;
}
