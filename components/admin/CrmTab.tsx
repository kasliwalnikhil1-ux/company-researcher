'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Badge, Button, Table, Th, Td, ErrorBox, fmtDate } from '@/components/outreach/ui';
import { adminApi } from '@/lib/platform/admin';
import { AccountPicker, ConfirmModal, errMsg, fmtNum, useAdminToast } from './shared';

export default function CrmTab({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useAdminToast();
  const q = useQuery({ queryKey: ['admin', 'crm'], queryFn: adminApi.crmMembers });
  const rows = q.data ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState<{ id: string; label: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const act = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); toast(label); refresh(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  };
  const active = rows.filter((r) => r.is_active).length;

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-gray-900">Add someone to the sales CRM team</h3>
        <p className="text-xs text-gray-500 mt-0.5 mb-3">The CRM is one internal team: every active member sees every deal, meeting and transcript. The person needs an account first.</p>
        <div className="max-w-md">
          <AccountPicker exclude={rows.filter((r) => r.is_active).map((r) => r.user_id)} onPick={(u) => act('add', `${u.email} added to the team`, () => adminApi.setCrmMember(u.id, { active: true }))} />
        </div>
      </div>

      <div className="flex items-center justify-between text-sm text-gray-600">
        <span>{fmtNum(active)} active member{active === 1 ? '' : 's'}{rows.length > active ? ` · ${rows.length - active} deactivated` : ''}</span>
        <Button variant="secondary" size="sm" onClick={refresh}><RefreshCw className={`w-4 h-4 ${q.isFetching ? 'animate-spin' : ''}`} /></Button>
      </div>

      {q.error && <ErrorBox message={errMsg(q.error)} />}

      <Table>
        <thead><tr><Th>Member</Th><Th>Status</Th><Th className="text-right">Deals owned</Th><Th className="text-right">Meetings logged</Th><Th>Since</Th><Th /></tr></thead>
        <tbody>
          {q.isLoading && <tr><Td colSpan={6} className="text-center text-gray-500 py-8">Loading…</Td></tr>}
          {!q.isLoading && rows.length === 0 && <tr><Td colSpan={6} className="text-center text-gray-500 py-8">Nobody on the team yet.</Td></tr>}
          {rows.map((m) => (
            <tr key={m.user_id} className="hover:bg-gray-50">
              <Td>
                <button type="button" className="font-medium text-gray-900 hover:underline" onClick={() => onOpenUser(m.user_id)}>{m.display_name}</button>
                <div className="text-xs text-gray-400">{m.email ?? m.user_id}</div>
              </Td>
              <Td><Badge tone={m.is_active ? 'green' : 'gray'}>{m.is_active ? 'Active' : 'Deactivated'}</Badge></Td>
              <Td className="text-right tabular-nums">{fmtNum(m.deals_owned)}</Td>
              <Td className="text-right tabular-nums">{fmtNum(m.meetings)}</Td>
              <Td className="text-gray-500 whitespace-nowrap">{fmtDate(m.created_at, false)}</Td>
              <Td className="text-right">
                {m.is_active
                  ? <Button size="sm" variant="secondary" loading={busy === m.user_id} onClick={() => setDeactivating({ id: m.user_id, label: m.display_name })}>Deactivate</Button>
                  : <Button size="sm" loading={busy === m.user_id} onClick={() => act(m.user_id, 'Reactivated', () => adminApi.setCrmMember(m.user_id, { active: true }))}>Reactivate</Button>}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>

      <ConfirmModal open={!!deactivating} onClose={() => setDeactivating(null)} title="Deactivate this member?" confirmLabel="Deactivate"
        message={<>{deactivating?.label} loses access to the CRM. Their deals, meetings and history stay and still show their name.</>}
        onConfirm={() => act(deactivating!.id, 'Member deactivated', () => adminApi.setCrmMember(deactivating!.id, { active: false }))} />
    </div>
  );
}
