'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { Button, ErrorBox, Select, Spinner, Toggle, fmtDate } from '@/components/outreach/ui';
import { parseError } from '@/lib/outreach/api';
import { useClients } from '@/lib/outreach/queries';
import { useDeleteSchedule, useReportSchedules, useSaveSchedule, type ReportSchedule, type ScheduleKind } from '@/lib/outreach/reports';

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
function parseRecipients(text: string): { emails: string[]; bad: string[] } {
  const parts = text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const emails = Array.from(new Set(parts.filter((p) => EMAIL.test(p))));
  return { emails, bad: parts.filter((p) => !EMAIL.test(p)) };
}

function RecipientsField({ schedule, onSave, busy, label }: { schedule: ReportSchedule; onSave: (emails: string[]) => void; busy: boolean; label: string }) {
  const [text, setText] = useState(schedule.recipients.join(', '));
  useEffect(() => { setText(schedule.recipients.join(', ')); }, [schedule.recipients]);
  const { emails, bad } = parseRecipients(text);
  const dirty = emails.join(',') !== schedule.recipients.join(',');
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <div className="flex items-start gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="name@company.com, other@company.com" className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        <Button size="sm" variant="secondary" className="mt-0.5" disabled={!dirty || bad.length > 0} loading={busy} onClick={() => onSave(emails)}>Save</Button>
      </div>
      {bad.length > 0 && <p className="text-xs text-red-600 mt-1">Not an email address: {bad.join(', ')}</p>}
    </div>
  );
}

export default function SchedulesDrawer({ open, onClose, ws, onNotice }: { open: boolean; onClose: () => void; ws: string; onNotice: (m: string, t?: 'success' | 'error') => void }) {
  const schedules = useReportSchedules(ws, open);
  const clients = useClients(open ? ws : null);
  const save = useSaveSchedule(ws);
  const remove = useDeleteSchedule(ws);
  const [newClient, setNewClient] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const rows = schedules.data ?? [];
  const workspaceRow = (kind: ScheduleKind) => rows.find((r) => r.kind === kind && !r.client_id);
  const clientRows = rows.filter((r) => r.kind === 'client_report' && r.client_id);
  const clientName = useMemo(() => Object.fromEntries((clients.data ?? []).map((c) => [c.id, c.name])), [clients.data]);
  const freeClients = (clients.data ?? []).filter((c) => !clientRows.some((r) => r.client_id === c.id));

  async function run(p: Promise<unknown>, ok: string) {
    try { await p; onNotice(ok); } catch (e) { onNotice(parseError(e).message, 'error'); }
  }
  const patch = (row: ReportSchedule | undefined, kind: ScheduleKind, clientId: string | null, change: Parameters<typeof save.mutateAsync>[0]['patch'], ok: string) =>
    run(save.mutateAsync({ id: row?.id, kind, client_id: clientId, patch: change }), ok);

  if (!open) return null;
  const WORKSPACE_REPORTS: Array<{ kind: ScheduleKind; title: string; text: string }> = [
    { kind: 'digest', title: 'Weekly digest', text: 'Every Monday: last week’s touches, replies, positive reply rate and meetings, with anything that needs attention. Goes to owners and managers.' },
    { kind: 'sender_report', title: 'Weekly sender report', text: 'Every Monday: health, acceptance rate, restrictions and senders running out of leads. Goes to owners and managers.' },
  ];

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label="Report schedules" className="absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div><h2 className="text-base font-semibold text-gray-900">Report schedules</h2><p className="text-xs text-gray-500">Sent by email at 08:00 in the workspace timezone. The numbers match this page.</p></div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-8">
          {schedules.isLoading ? <Spinner /> : schedules.isError ? <ErrorBox message={(schedules.error as Error).message} /> : (
            <>
              <section className="space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">For your team</h3>
                {WORKSPACE_REPORTS.map((w) => {
                  const row = workspaceRow(w.kind);
                  return (
                    <div key={w.kind} className="rounded-xl border border-gray-200 p-4 space-y-3">
                      <div className="flex items-start justify-between gap-4">
                        <div><div className="text-sm font-medium text-gray-900">{w.title}</div><p className="text-xs text-gray-500 mt-0.5">{w.text}</p></div>
                        <Toggle checked={!!row?.active} disabled={save.isPending} onChange={(v) => patch(row, w.kind, null, { active: v, cadence: 'weekly' }, v ? `${w.title} turned on.` : `${w.title} turned off.`)} />
                      </div>
                      {row?.active && (
                        <>
                          <RecipientsField schedule={row} busy={save.isPending} label="Also send to (optional)" onSave={(emails) => patch(row, w.kind, null, { recipients: emails }, 'Recipients saved.')} />
                          <p className="text-xs text-gray-400">{row.last_sent_at ? `Last sent ${fmtDate(row.last_sent_at)}` : 'Not sent yet'}</p>
                        </>
                      )}
                    </div>
                  );
                })}
              </section>

              <section className="space-y-4">
                <div><h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Client reports</h3><p className="text-xs text-gray-500 mt-1">A branded report for one client: headline numbers, replies by intent and top sequences. It uses the branding from Settings.</p></div>
                {!clients.data?.length ? <p className="text-sm text-gray-500">Create a client first. Then you can send that client a report on a schedule.</p> : (
                  <>
                    {clientRows.map((row) => (
                      <div key={row.id} className="rounded-xl border border-gray-200 p-4 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium text-gray-900 truncate">{clientName[row.client_id!] ?? 'Client'}</div>
                          <div className="flex items-center gap-3">
                            <Toggle checked={row.active} disabled={save.isPending} onChange={(v) => patch(row, 'client_report', row.client_id, { active: v }, v ? 'Report turned on.' : 'Report paused.')} />
                            <button type="button" aria-label="Delete this schedule" disabled={remove.isPending} onClick={() => run(remove.mutateAsync(row.id), 'Schedule deleted.')} className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
                          </div>
                        </div>
                        <Select label="How often" value={row.cadence} onChange={(e) => patch(row, 'client_report', row.client_id, { cadence: e.target.value as 'weekly' | 'monthly' }, 'Saved.')}>
                          <option value="weekly">Every week (Monday)</option><option value="monthly">Every month (on the 1st)</option>
                        </Select>
                        <RecipientsField schedule={row} busy={save.isPending} label="Send to" onSave={(emails) => patch(row, 'client_report', row.client_id, { recipients: emails }, 'Recipients saved.')} />
                        <Toggle checked={row.include_client_viewers} disabled={save.isPending} label="Also send to this client’s viewers" onChange={(v) => patch(row, 'client_report', row.client_id, { include_client_viewers: v }, 'Saved.')} />
                        {!row.recipients.length && !row.include_client_viewers && <p className="text-xs text-amber-700">Nobody receives this report yet. Add an email address or include the client’s viewers.</p>}
                        <p className="text-xs text-gray-400">{row.last_sent_at ? `Last sent ${fmtDate(row.last_sent_at)}` : 'Not sent yet'}</p>
                      </div>
                    ))}
                    {freeClients.length > 0 && (
                      <div className="flex items-end gap-2">
                        <div className="flex-1"><Select label="Add a report for" value={newClient} onChange={(e) => setNewClient(e.target.value)}><option value="">Choose a client</option>{freeClients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
                        <Button variant="secondary" disabled={!newClient} loading={save.isPending} onClick={async () => { await patch(undefined, 'client_report', newClient, { cadence: 'weekly', active: true, include_client_viewers: true, recipients: [] }, 'Report scheduled. It goes out next Monday.'); setNewClient(''); }}>Add</Button>
                      </div>
                    )}
                  </>
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
