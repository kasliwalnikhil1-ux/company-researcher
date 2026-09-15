'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, Save, Trash2, Info } from 'lucide-react';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import { Button, Card, ErrorBox, Select } from '@/components/outreach/ui';
import { WEEKDAYS, localTime, normalizeSchedule, scheduleSummary, timezoneCountryHint, timezoneOptions } from './helpers';
import type { Schedule, ScheduleWindow, Sender } from '@/lib/outreach/types';

type Notify = (message: string, type?: 'success' | 'error') => void;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validate(s: Schedule): string | null {
  for (const d of WEEKDAYS) {
    const wins = s[d.key];
    for (const [a, b] of wins) {
      if (!TIME_RE.test(a) || !TIME_RE.test(b)) return `${d.label}: times must be HH:MM`;
      if (a >= b) return `${d.label}: window start (${a}) must be before end (${b})`;
    }
    const sorted = [...wins].sort((x, y) => x[0].localeCompare(y[0]));
    for (let i = 1; i < sorted.length; i++) if (sorted[i][0] < sorted[i - 1][1]) return `${d.label}: windows overlap`;
  }
  return null;
}

export default function ScheduleEditor({ sender, isManager, canWrite, notify }: { sender: Sender; isManager: boolean; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const canEdit = isManager && canWrite;
  const [schedule, setSchedule] = useState<Schedule>(() => normalizeSchedule(sender.schedule));
  const [timezone, setTimezone] = useState(sender.timezone || 'UTC');
  const [saving, setSaving] = useState(false);
  const tzList = useMemo(() => timezoneOptions(), []);
  useEffect(() => { setSchedule(normalizeSchedule(sender.schedule)); setTimezone(sender.timezone || 'UTC'); }, [sender.id, sender.schedule, sender.timezone]);

  const error = useMemo(() => validate(schedule), [schedule]);
  const dirty = JSON.stringify(schedule) !== JSON.stringify(normalizeSchedule(sender.schedule)) || timezone !== sender.timezone;
  const tzCountry = timezoneCountryHint(timezone);
  const mismatch = !!sender.proxy_country && !!tzCountry && tzCountry !== sender.proxy_country.toUpperCase();

  const setDay = (day: keyof Schedule, wins: ScheduleWindow[]) => setSchedule({ ...schedule, [day]: wins });
  const update = (day: keyof Schedule, i: number, idx: 0 | 1, v: string) => setDay(day, schedule[day].map((w, j) => (j === i ? ((idx === 0 ? [v, w[1]] : [w[0], v]) as ScheduleWindow) : w)));
  const addWindow = (day: keyof Schedule) => { const last = schedule[day][schedule[day].length - 1]; setDay(day, [...schedule[day], last ? [last[1] < '23:00' ? last[1] : '22:00', '23:00'] : ['09:00', '18:00']]); };
  const copyMonday = () => setSchedule({ ...schedule, tue: [...schedule.mon], wed: [...schedule.mon], thu: [...schedule.mon], fri: [...schedule.mon] });

  async function save() {
    if (error) return;
    setSaving(true);
    try {
      await rpc('set_sender_schedule', { p_sender: sender.id, p_schedule: schedule, p_timezone: timezone });
      notify('Schedule saved. The planner uses it from the next run.');
      qc.invalidateQueries({ queryKey: qk.sender(sender.id) });
      qc.invalidateQueries({ queryKey: qk.senders(sender.workspace_id) });
      qc.invalidateQueries({ queryKey: qk.senderEvents(sender.id) });
    } catch (e) { notify(parseError(e).message, 'error'); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-6">
      <Card title="Working hours" actions={canEdit ? (
        <>
          <Button size="sm" variant="secondary" onClick={copyMonday} title="Copy Monday's windows to Tuesday–Friday"><Copy className="w-3.5 h-3.5" /> Copy Monday to Tue–Fri</Button>
          <Button size="sm" onClick={save} loading={saving} disabled={!dirty || !!error}><Save className="w-3.5 h-3.5" /> Save</Button>
        </>
      ) : undefined}>
        <p className="text-sm text-gray-500 mb-4">Actions are only scheduled inside these local-time windows, with random jitter so nothing lands on a round minute. Summary: <span className="text-gray-800 font-medium">{scheduleSummary(schedule)}</span>.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <Select label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!canEdit}>
            {!tzList.includes(timezone) && <option value={timezone}>{timezone}</option>}
            {tzList.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </Select>
          <div className="text-xs text-gray-500 md:pt-6">Sender-local time now: <span className="text-gray-800 font-medium">{localTime(timezone)}</span></div>
        </div>
        {mismatch && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 text-amber-800 text-sm mb-4"><Info className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>Heads-up: this timezone looks like <strong>{tzCountry}</strong> but the proxy is pinned to <strong>{sender.proxy_country}</strong>. LinkedIn sees activity at odd hours for the proxy's location. Double-check where the account owner works.</span></div>
        )}
        {error && <ErrorBox message={error} className="mb-4" />}
        <div className="divide-y divide-gray-100">
          {WEEKDAYS.map((d) => (
            <div key={d.key} className="py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
              <div className="w-24 flex-shrink-0 pt-1.5 text-sm font-medium text-gray-800">{d.label}</div>
              <div className="flex-1 space-y-2">
                {schedule[d.key].length === 0 && <div className="text-sm text-gray-400 pt-1.5">Off</div>}
                {schedule[d.key].map((w, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input type="time" aria-label={`${d.label} window ${i + 1} start`} value={w[0]} onChange={(e) => update(d.key, i, 0, e.target.value)} disabled={!canEdit} className="px-2 py-1.5 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50" />
                    <span className="text-gray-400">–</span>
                    <input type="time" aria-label={`${d.label} window ${i + 1} end`} value={w[1]} onChange={(e) => update(d.key, i, 1, e.target.value)} disabled={!canEdit} className="px-2 py-1.5 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50" />
                    {canEdit && <button type="button" aria-label="Remove window" onClick={() => setDay(d.key, schedule[d.key].filter((_, j) => j !== i))} className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>}
                  </div>
                ))}
                {canEdit && <button type="button" onClick={() => addWindow(d.key)} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"><Plus className="w-3 h-3" /> Add window</button>}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
