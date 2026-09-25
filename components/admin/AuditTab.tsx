'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, Table, Th, Td, ErrorBox, fmtDate } from '@/components/outreach/ui';
import { adminApi, actionLabel, describeDetails } from '@/lib/platform/admin';
import { errMsg, fmtNum } from './shared';

const PAGE = 100;

export default function AuditTab({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const [page, setPage] = useState(0);
  const q = useQuery({ queryKey: ['admin', 'audit', page], queryFn: () => adminApi.auditLog(PAGE, page * PAGE), placeholderData: (p) => p });
  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">Every change made through this page or the admin API, newest first. Changes people make to their own account (sign-ups, self-serve billing) are not admin actions and are not listed.</p>
      {q.error && <ErrorBox message={errMsg(q.error)} />}
      <Table>
        <thead><tr><Th>When</Th><Th>Admin</Th><Th>Action</Th><Th>Account</Th><Th>Details</Th></tr></thead>
        <tbody>
          {q.isLoading && <tr><Td colSpan={5} className="text-center text-gray-500 py-8">Loading…</Td></tr>}
          {!q.isLoading && rows.length === 0 && <tr><Td colSpan={5} className="text-center text-gray-500 py-8">Nothing yet.</Td></tr>}
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-gray-50 align-top">
              <Td className="whitespace-nowrap text-gray-500">{fmtDate(r.created_at)}</Td>
              <Td className="whitespace-nowrap">{r.admin_email ?? <span className="text-gray-400">system</span>}</Td>
              <Td className="whitespace-nowrap font-medium text-gray-900">{actionLabel(r.action)}</Td>
              <Td>{r.target_user_id ? <button type="button" className="hover:underline" onClick={() => onOpenUser(r.target_user_id as string)}>{r.target_email ?? r.target_user_id}</button> : <span className="text-gray-400">—</span>}</Td>
              <Td className="text-xs text-gray-600 break-words max-w-[420px]">{describeDetails(r.details)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>{total === 0 ? 'No entries' : `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${fmtNum(total)}`}</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="w-4 h-4" /></Button>
          <span className="px-2">Page {page + 1} / {pages}</span>
          <Button size="sm" variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="w-4 h-4" /></Button>
        </div>
      </div>
    </div>
  );
}
