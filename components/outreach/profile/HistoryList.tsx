'use client';

// Change history with per-field rollback fidelity (PRD §7.2): the revert screen shows exactly what can be restored,
// how faithfully, and what cannot, before anything is queued.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { callFn, parseError, rpc } from '@/lib/outreach/api';
import { reasonText } from '@/lib/outreach/reasons';
import { Badge, Button, Card, Modal, Spinner, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import { FIDELITY, GROUP_LABELS, SOURCE_LABELS, STATUS_LABELS, STATUS_TONE, payloadKeyLabel, payloadValueText, profileKeysFor, useProfileHistory, type ProfileChange, type RevertBuild } from '@/lib/outreach/profile';

type Notify = (message: string, type?: 'success' | 'error') => void;

export function DiffRows({ change }: { change: Pick<ProfileChange, 'payload' | 'assets' | 'before'> }) {
  const p = change.payload as Record<string, unknown>;
  const b = change.before;
  const beforeOf = (k: string): unknown => {
    if (!b) return null;
    if (k === 'headline') return b.headline; if (k === 'summary') return b.summary; if (k === 'location') return b.location; if (k === 'skills') return b.skills?.map((s) => s.name);
    if (k === 'experience') { const id = (p.experience as { id?: string })?.id; return id ? (b.experience ?? []).find((e) => e.id === id) ?? null : null; }
    if (k === 'education') { const id = (p.education as { id?: string })?.id; return id ? (b.education ?? []).find((e) => e.id === id) ?? null : null; }
    return null;
  };
  const rows = [...Object.keys(p).map((k) => ({ k, before: beforeOf(k), after: p[k] })), ...(change.assets?.picture || change.assets?.picture_url ? [{ k: 'picture', before: b?.picture_url ? 'previous photo' : null, after: 'new image' }] : []), ...(change.assets?.cover_picture || change.assets?.cover_url ? [{ k: 'cover_picture', before: b?.cover_url ? 'previous cover' : null, after: 'new image' }] : [])];
  return (
    <Table>
      <thead><tr><Th>Field</Th><Th>Before</Th><Th>After</Th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.k}><Td className="font-medium text-gray-900 whitespace-nowrap align-top">{payloadKeyLabel(r.k)}</Td><Td className="text-gray-500 align-top whitespace-pre-line max-w-xs">{payloadValueText(r.k, r.before)}</Td><Td className="align-top whitespace-pre-line max-w-xs">{payloadValueText(r.k, r.after)}</Td></tr>)}</tbody>
    </Table>
  );
}

export default function HistoryList({ senderId, ws, canWrite, notify }: { senderId: string; ws: string; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const history = useProfileHistory(senderId);
  const [revert, setRevert] = useState<{ change: ProfileChange; build: RevertBuild | null; loading: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const invalidate = () => { for (const k of profileKeysFor(senderId, ws)) qc.invalidateQueries({ queryKey: k }); };

  async function openRevert(change: ProfileChange) {
    setRevert({ change, build: null, loading: true });
    try { setRevert({ change, build: await rpc<RevertBuild>('profile_revert_build', { p_change: change.id }), loading: false }); }
    catch (e) { notify(parseError(e).message, 'error'); setRevert(null); }
  }
  async function doRevert() {
    if (!revert) return;
    setBusy(true);
    try {
      const r = await callFn<{ status: string; scheduled_for?: string; approval?: { email_sent: boolean; link?: string } }>('profile', { action: 'revert', change_id: revert.change.id });
      notify(r.status === 'queued' ? `Rollback scheduled for ${fmtDate(r.scheduled_for)}.` : r.status === 'awaiting_owner' ? (r.approval?.email_sent ? 'Rollback proposed to the owner by email.' : 'Rollback drafted; the owner has to approve it.') : `Rollback ${r.status}.`);
      setRevert(null); invalidate();
    } catch (e) { notify(parseError(e).message, 'error'); } finally { setBusy(false); }
  }

  const rows = history.data ?? [];
  return (
    <Card title="History">
      {history.isLoading ? <Spinner /> : rows.length === 0 ? <div className="text-sm text-gray-500">No profile changes yet.</div> : (
        <ul className="divide-y divide-gray-100">
          {rows.map((c) => (
            <li key={c.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABELS[c.status]}</Badge>
                <span className="font-medium text-gray-900">{c.field_groups.map((g) => GROUP_LABELS[g]).join(', ')}</span>
                <span className="text-xs text-gray-500">{SOURCE_LABELS[c.source] ?? c.source}{c.requested_by_email ? ` · ${c.requested_by_email}` : ''}{c.approved_by_email && c.mode === 'propose_only' ? ` · approved by ${c.approved_by_email}` : ''}</span>
                <span className="text-xs text-gray-400 ml-auto">{fmtDate(c.applied_at ?? c.scheduled_for ?? c.created_at)}</span>
                <button className="text-xs text-indigo-700" onClick={() => setOpenId(openId === c.id ? null : c.id)}>{openId === c.id ? 'Hide' : 'Details'}</button>
                {canWrite && c.can_revert && !c.reverted_at && <Button size="sm" variant="secondary" onClick={() => openRevert(c)}><RotateCcw className="w-3.5 h-3.5" /> Revert</Button>}
              </div>
              {c.status === 'partially_applied' && <div className="text-xs text-amber-700 mt-1">LinkedIn did not accept: {Object.keys(c.failed_fields).filter((k) => k !== '_all').map(payloadKeyLabel).join(', ')}. Nothing is retried on its own.</div>}
              {c.status === 'failed' && <div className="text-xs text-red-700 mt-1">{reasonText(c.error_code) ?? 'Failed'}</div>}
              {c.status === 'applied' && !c.verified_at && <div className="text-xs text-gray-500 mt-1">Applied; the platform reads the profile back within a few minutes to confirm each field.</div>}
              {c.owner_notified_at && <div className="text-[11px] text-gray-400 mt-0.5">Owner emailed {fmtDate(c.owner_notified_at)} with a revert link.</div>}
              {openId === c.id && <div className="mt-2"><DiffRows change={c} />{c.note && <div className="text-xs text-gray-600 mt-2">Note: {c.note}</div>}</div>}
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!revert} onClose={() => setRevert(null)} title="Revert this change" size="lg"
        footer={<><Button variant="secondary" onClick={() => setRevert(null)}>Cancel</Button><Button loading={busy} disabled={!revert?.build?.possible} onClick={doRevert}><RotateCcw className="w-4 h-4" /> Queue the rollback</Button></>}>
        {revert?.loading ? <Spinner /> : revert?.build && (
          <div className="space-y-3 text-sm">
            <p className="text-gray-700">A rollback is an ordinary change: it uses a profile-edit slot, follows the same limits and permission, and the owner is emailed again. What can be restored, and how faithfully:</p>
            <ul className="space-y-1.5">
              {revert.build.fields.map((f) => <li key={f.key} className="flex items-start gap-2"><Badge tone={FIDELITY[f.fidelity].tone}>{FIDELITY[f.fidelity].label}</Badge><div><span className="font-medium text-gray-900">{payloadKeyLabel(f.key)}</span><div className="text-xs text-gray-600">{f.note}</div></div></li>)}
              {revert.build.unrecoverable.map((u) => <li key={u.key} className="flex items-start gap-2"><Badge tone="red">Not restorable</Badge><div><span className="font-medium text-gray-900">{payloadKeyLabel(u.key)}</span><div className="text-xs text-gray-600">{u.why}</div></div></li>)}
            </ul>
            {!revert.build.possible && <div className="text-sm text-red-700">Nothing in this change can be restored automatically. Fix it on LinkedIn directly.</div>}
          </div>
        )}
      </Modal>
    </Card>
  );
}
