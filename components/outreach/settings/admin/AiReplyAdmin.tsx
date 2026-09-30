'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { parseError, rpc } from '@/lib/outreach/api';
import { Badge, Button, Card, ErrorBox, Input, Modal, Spinner, Table, Td, Textarea, Th, timeAgo, useToast } from '@/components/outreach/ui';

/** One row of `outreach_ai_reply_admin_list`. `graduation_bypass` is legacy (v2 has no graduation gate) and is passed back unchanged. */
interface AdminRow {
  workspace_id: string;
  workspace_name: string;
  graduation_bypass?: boolean;
  monthly_limit: number | null;
  used_this_month: number;
  note: string | null;
  updated_at: string | null;
}

const KEY = ['outreach', 'platform', 'ai-reply-admin'] as const;

/** '' = platform default (null); otherwise a whole number ≥ 0. Returns undefined for an invalid entry. */
function parseLimit(v: string): number | null | undefined {
  const t = v.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : undefined;
}

function EditModal({ row, onClose }: { row: AdminRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [limit, setLimit] = useState(row.monthly_limit == null ? '' : String(row.monthly_limit));
  const [note, setNote] = useState('');
  const parsed = parseLimit(limit);
  const changed = parsed !== undefined && parsed !== row.monthly_limit;

  const save = useMutation({
    // the RPC still takes the legacy bypass flag: it is passed back as it is so nothing else changes
    mutationFn: () => rpc<unknown>('ai_reply_admin_set', { p_ws: row.workspace_id, p_bypass: row.graduation_bypass ?? false, p_monthly_limit: parsed ?? null, p_note: note.trim() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); onClose(); },
    onError: (e) => toast.show(parseError(e).message, 'error'),
  });

  return (
    <Modal open onClose={onClose} title={`AI Auto Replies: ${row.workspace_name}`} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!changed || parsed === undefined || !note.trim()}>Save</Button>
      </>}>
      <div className="space-y-4">
        <Input type="number" min={0} step={1} inputMode="numeric" label="Monthly AI draft limit" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Platform default"
          error={parsed === undefined ? 'Enter a whole number, or leave it empty.' : undefined}
          hint={`Empty uses the platform default. 0 stops AI drafts. Used this month: ${row.used_this_month}. Workspaces on their own AI key are never limited.`} />
        <Textarea label="Note (required)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Why this change, and for how long." />
      </div>
      {toast.node}
    </Modal>
  );
}

/**
 * Per-workspace AI replies override that only a platform admin may set: the monthly AI draft allowance. Every change is
 * audited with a note. Lives in Settings → Admin (localhost only).
 */
export default function AiReplyAdmin() {
  const list = useQuery({ queryKey: KEY, staleTime: 30_000, retry: 0, queryFn: () => rpc<AdminRow[]>('ai_reply_admin_list') });
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<AdminRow | null>(null);

  const rows = useMemo(() => {
    const all = [...(list.data ?? [])].sort((a, b) => (b.monthly_limit != null ? 1 : 0) - (a.monthly_limit != null ? 1 : 0) || a.workspace_name.localeCompare(b.workspace_name));
    const s = q.trim().toLowerCase();
    return s ? all.filter((r) => r.workspace_name.toLowerCase().includes(s) || r.workspace_id.startsWith(s)) : all;
  }, [list.data, q]);

  return (
    <Card className="mt-6" title="AI Auto Replies by workspace"
      actions={<label className="relative block"><Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a workspace" aria-label="Find a workspace" className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-48" /></label>}>
      <p className="text-xs text-gray-500 mb-3">The monthly limit caps AI drafts on the platform AI key. Every change needs a note and is logged.</p>
      {list.isLoading ? <Spinner /> : list.isError ? <ErrorBox message={parseError(list.error).message} /> : rows.length === 0 ? <div className="text-sm text-gray-500 py-2">{q ? 'No workspace matches.' : 'No workspaces yet.'}</div> : (
        <Table>
          <thead><tr><Th>Workspace</Th><Th className="text-right">AI drafts this month</Th><Th>Note</Th><Th>Changed</Th><Th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.workspace_id}>
                <Td className="font-medium text-gray-900">{r.workspace_name}</Td>
                <Td className="text-right tabular-nums whitespace-nowrap">
                  {r.used_this_month} / {r.monthly_limit == null ? <span className="text-gray-400">default</span> : r.monthly_limit}
                  {r.monthly_limit != null && r.used_this_month >= r.monthly_limit && <Badge tone="amber" className="ml-2">used up</Badge>}
                </Td>
                <Td className="text-xs text-gray-600 max-w-xs truncate" title={r.note ?? undefined}>{r.note ?? <span className="text-gray-300">—</span>}</Td>
                <Td className="text-xs text-gray-500 whitespace-nowrap">{r.updated_at ? timeAgo(r.updated_at) : <span className="text-gray-300">—</span>}</Td>
                <Td className="text-right"><Button size="sm" variant="secondary" onClick={() => setEditing(r)}>Edit</Button></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {editing && <EditModal key={editing.workspace_id} row={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
