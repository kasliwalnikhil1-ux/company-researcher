'use client';

/**
 * Settings → Notifications, reply alerts part (reply-notifications-PRD.md §5.3, §6). Every change saves at once.
 *   This browser   permission + this browser's switch (stored in the browser), test notification
 *   Sound          on/off, sound, volume, Test
 *   Notify me about  scope + "also when the AI is handling the reply"
 *   Alert table    In app (always) · Desktop · Sound per kind
 *   Options        message text, notify while looking at the app, quiet hours
 *   Pause          30 minutes · 1 hour · until tomorrow 9:00 · until turned back on
 *   Your browsers  where Web Push reaches you; remove any
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Check, Laptop, Play, Smartphone, Trash2 } from 'lucide-react';
import { Button, Card, Select, timeAgo } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import {
  ALERT_KINDS, DEFAULT_ALERT_SETTINGS, PAUSE_OPTIONS, SCOPES, SOUNDS, UNSUPPORTED_TEXT, isPaused, pauseLeftLabel, pauseUntil, playAlertSound,
  showTestNotification, turnOffDesktop, turnOnAlerts, turnOnDesktopAgain, useAlertSaver, useAlertSettings, useBrowserAlertState, usePushBrowsers,
  useRemovePushBrowser, useSaveAlertSettings, useSetAlertPref, useThisPushEndpoint, type AlertKind, type AlertSettings, type AlertSettingsPatch, type QuietHours, type SoundName,
} from '@/lib/outreach/alerts';
import { BLOCKED_STEPS } from './AlertPromptBanner';
import AlertKindIcon from './AlertKindIcon';

type Toast = (msg: string, kind?: 'success' | 'error') => void;

const DAYS: Array<{ n: number; short: string }> = [
  { n: 1, short: 'Mon' }, { n: 2, short: 'Tue' }, { n: 3, short: 'Wed' }, { n: 4, short: 'Thu' }, { n: 5, short: 'Fri' }, { n: 6, short: 'Sat' }, { n: 7, short: 'Sun' },
];
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

function Row({ title, hint, children, className }: { title: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5', className)}>
      <div className="min-w-0 flex-[1_1_14rem]">
        <div className="text-sm font-medium text-gray-900">{title}</div>
        {hint && <div className="text-xs text-gray-500 mt-0.5">{hint}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2 ml-auto">{children}</div>}
    </div>
  );
}

function Check2({ checked, onChange, label, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className={cn('inline-flex items-start gap-2 text-sm text-gray-700 select-none', disabled ? 'opacity-60' : 'cursor-pointer')} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
      <span>{label}</span>
    </label>
  );
}

// ------------------------------------------------------------------------------------------------ This browser
function BrowserSection({ ws, userId, settings, toast }: { ws: string; userId: string; settings: AlertSettings; toast: Toast }) {
  const b = useBrowserAlertState(userId);
  const save = useAlertSaver(ws);
  const [busy, setBusy] = useState(false);
  const status = !b.support.ok ? 'Not available here' : b.permission === 'denied' ? 'Blocked by your browser' : b.desktopOn ? 'On' : 'Off';

  const turnOn = async () => {
    setBusy(true);
    try {
      if (b.permission === 'granted') { await turnOnDesktopAgain(userId, save); toast('Desktop notifications are on for this browser'); }
      else {
        const r = await turnOnAlerts({ userId, withSound: settings.sound_enabled, save });
        if (r === 'granted') toast('Desktop notifications are on for this browser');
        else if (r === 'dismissed') toast('Nothing changed: the browser\'s question was closed.');
      }
    } finally { setBusy(false); }
  };
  const turnOff = async () => { setBusy(true); try { await turnOffDesktop(userId); toast('Desktop notifications are off for this browser'); } finally { setBusy(false); } };
  const test = async () => {
    const ok = await showTestNotification(false);
    if (!ok) toast('The notification helper is not ready yet. Reload the page and try again.', 'error');
  };

  return (
    <Card title={<span className="inline-flex items-center gap-2"><Laptop className="w-4 h-4 text-gray-400" /> This browser · {b.label}</span>}>
      <Row title="Desktop notifications" hint={!b.support.ok ? UNSUPPORTED_TEXT[b.support.reason] : b.permission === 'denied' ? BLOCKED_STEPS : 'Shown by your browser, even when the app is in another tab. This switch is for this browser only.'}>
        <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', status === 'On' ? 'bg-green-100 text-green-800' : status === 'Off' ? 'bg-gray-100 text-gray-700' : 'bg-amber-100 text-amber-800')}>{status}</span>
        {b.support.ok && b.permission !== 'denied' && (b.desktopOn
          ? <Button size="sm" variant="secondary" onClick={turnOff} loading={busy}>Turn off</Button>
          : <Button size="sm" onClick={turnOn} loading={busy}>Turn on</Button>)}
      </Row>
      <div className="pt-1">
        <Button size="sm" variant="secondary" onClick={test} disabled={!b.support.ok || b.permission !== 'granted'}><BellRing className="w-3.5 h-3.5" /> Send a test notification</Button>
        <p className="text-xs text-gray-500 mt-1.5">Didn&apos;t see it? Check your computer&apos;s notification settings for this browser (and Do not disturb / Focus).</p>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ Sound
function SoundSection({ userId, settings, ctl }: { userId: string; settings: AlertSettings; ctl: Ctl }) {
  const b = useBrowserAlertState(userId);
  // while dragging, the slider shows the local value; it saves 400 ms after the last move
  const [draft, setDraft] = useState<number | null>(null);
  const vol = draft ?? settings.sound_volume;
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const setVolume = (v: number) => {
    setDraft(v);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => ctl.save({ sound_volume: v }, () => setDraft(null)), 400);
  };
  const [testState, setTestState] = useState<string | null>(null);
  const test = async () => {
    const r = await playAlertSound(settings.sound_name, vol, null, { test: true });
    setTestState(r === 'blocked' ? 'Your browser blocked the sound. Click anywhere in the app once, then try again.' : vol === 0 ? 'Volume is at 0.' : null);
  };
  return (
    <Card title="Sound">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Check2 checked={settings.sound_enabled} onChange={(v) => ctl.save({ sound_enabled: v })} label="Play a sound" />
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <span>Sound</span>
          <Select aria-label="Sound" value={settings.sound_name} disabled={!settings.sound_enabled} onChange={(e) => ctl.save({ sound_name: e.target.value as SoundName })} className="text-sm">
            {SOUNDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <span>Volume</span>
          <input type="range" min={0} max={100} step={5} value={vol} disabled={!settings.sound_enabled} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume" className="w-32 accent-indigo-600" />
          <span className="w-8 text-xs text-gray-500 tabular-nums">{vol}</span>
        </label>
        <Button size="sm" variant="secondary" onClick={test}><Play className="w-3.5 h-3.5" /> Test</Button>
      </div>
      {(testState || (settings.sound_enabled && b.soundBlocked)) && <p className="text-xs text-amber-700 mt-2">{testState ?? 'Click anywhere in the app once so it can play sounds.'}</p>}
      <p className="text-xs text-gray-500 mt-2">One tab plays it, at most once every 3 seconds. Sounds need no browser permission.</p>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ Notify me about
function ScopeSection({ settings, ctl }: { settings: AlertSettings; ctl: Ctl }) {
  return (
    <Card title="Notify me about">
      <div role="radiogroup" aria-label="Notify me about" className="space-y-2">
        {SCOPES.map((s) => (
          <label key={s.value} className="flex items-start gap-2 cursor-pointer">
            <input type="radio" name="alert-scope" checked={settings.scope === s.value} onChange={() => ctl.save({ scope: s.value })} className="mt-1 border-gray-300 text-indigo-600 focus:ring-indigo-500" />
            <span><span className="block text-sm text-gray-900">{s.label}</span><span className="block text-xs text-gray-500">{s.hint}</span></span>
          </label>
        ))}
      </div>
      <div className="mt-3 pt-3 border-t border-gray-100">
        <Check2 checked={settings.include_ai_handled} onChange={(v) => ctl.save({ include_ai_handled: v })}
          label={<><span className="text-gray-900">Also when the AI is handling the reply</span><span className="block text-xs text-gray-500">Off: you hear about it when the AI hands the conversation to you.</span></>} />
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ alert table
function KindsSection({ settings, ctl }: { settings: AlertSettings; ctl: Ctl }) {
  return (
    <Card title="What alerts you">
      <div className="overflow-x-auto scroll-shadow-x">
        <table className="w-full text-sm min-w-[26rem]">
          <thead>
            <tr className="text-xs text-gray-500">
              <th className="text-left font-medium py-1.5" />
              <th className="font-medium py-1.5 w-20">In app</th>
              <th className="font-medium py-1.5 w-20">Desktop</th>
              <th className="font-medium py-1.5 w-20">Sound</th>
            </tr>
          </thead>
          <tbody>
            {ALERT_KINDS.map((k) => {
              const p = settings.kinds[k.kind] ?? DEFAULT_ALERT_SETTINGS.kinds[k.kind];
              return (
                <tr key={k.kind} className="border-t border-gray-100">
                  <td className="py-2 pr-2"><span className="inline-flex items-center gap-2 text-gray-900"><AlertKindIcon kind={k.kind} /> {k.label}</span></td>
                  <td className="py-2 text-center"><Check className="w-4 h-4 inline text-gray-400" aria-label="Always on" /></td>
                  <td className="py-2 text-center"><input type="checkbox" aria-label={`${k.label}: desktop`} checked={p.desktop} onChange={(e) => ctl.setPref(k.kind, { desktop: e.target.checked })} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /></td>
                  <td className="py-2 text-center"><input type="checkbox" aria-label={`${k.label}: sound`} checked={p.sound} disabled={!settings.sound_enabled} title={settings.sound_enabled ? undefined : 'Turn on Play a sound first'} onChange={(e) => ctl.setPref(k.kind, { sound: e.target.checked })} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40" /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-2">In app (the bell, unread counts and the toast) is always on.</p>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ options + quiet hours
function QuietHoursEditor({ value, onChange }: { value: QuietHours; onChange: (q: QuietHours) => void }) {
  const toggleDay = (n: number) => {
    const has = value.days.includes(n);
    const days = has ? value.days.filter((d) => d !== n) : [...value.days, n].sort();
    if (days.length) onChange({ ...value, days });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 pl-6 mt-2 text-sm text-gray-700">
      <span>between</span>
      <input type="time" aria-label="From" value={value.start} onChange={(e) => e.target.value && onChange({ ...value, start: e.target.value })} className="border border-gray-300 rounded-md px-2 py-1 text-sm" />
      <span>and</span>
      <input type="time" aria-label="Until" value={value.end} onChange={(e) => e.target.value && onChange({ ...value, end: e.target.value })} className="border border-gray-300 rounded-md px-2 py-1 text-sm" />
      <span>on</span>
      <div role="group" aria-label="Days" className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
        {DAYS.map((d) => {
          const on = value.days.includes(d.n);
          return <button key={d.n} type="button" aria-pressed={on} onClick={() => toggleDay(d.n)} className={cn('px-2 py-0.5 rounded-md text-xs transition-colors', on ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50')}>{d.short}</button>;
        })}
      </div>
      <span className="text-xs text-gray-500">({value.tz})</span>
    </div>
  );
}

function OptionsSection({ settings, ctl }: { settings: AlertSettings; ctl: Ctl }) {
  const q = settings.quiet_hours;
  return (
    <Card title="Options">
      <div className="space-y-3">
        <Check2 checked={settings.show_preview} onChange={(v) => ctl.save({ show_preview: v })}
          label={<><span className="text-gray-900">Show the message text in notifications</span><span className="block text-xs text-gray-500">Off: &ldquo;New reply on LinkedIn&rdquo;. Useful when you share your screen.</span></>} />
        <Check2 checked={settings.alert_when_visible} onChange={(v) => ctl.save({ alert_when_visible: v })}
          label={<><span className="text-gray-900">Notify even when I&apos;m looking at the app</span><span className="block text-xs text-gray-500">Off: while the app is in front of you, a toast and the sound are enough.</span></>} />
        <div>
          <Check2 checked={!!q} onChange={(v) => ctl.save({ quiet_hours: v ? { days: [1, 2, 3, 4, 5], start: '09:00', end: '19:00', tz: localTz() } : null })}
            label={<span className="text-gray-900">Only notify me at set times</span>} />
          {q && <QuietHoursEditor value={q} onChange={(nq) => ctl.save({ quiet_hours: nq })} />}
          <p className="text-xs text-gray-500 mt-1 pl-6">Outside these times the bell still collects; nothing sounds or pops up, and nothing is replayed later.</p>
        </div>
      </div>
    </Card>
  );
}

function PauseSection({ settings, ctl }: { settings: AlertSettings; ctl: Ctl }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const paused = isPaused(settings, now);
  return (
    <Card title="Pause">
      <Row title={paused ? `Paused · ${pauseLeftLabel(settings, now)}` : 'Sounds and desktop notifications'} hint="Also in the bell menu. The bell and unread counts keep collecting while paused.">
        {paused
          ? <Button size="sm" variant="secondary" onClick={() => ctl.save({ paused_until: null })} loading={ctl.busy}>Resume now</Button>
          : (
            <Select aria-label="Pause" value="" onChange={(e) => { const v = e.target.value as (typeof PAUSE_OPTIONS)[number]['value']; if (v) ctl.save({ paused_until: pauseUntil(v) }); }} className="text-sm">
              <option value="">Pause for…</option>
              {PAUSE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          )}
      </Row>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ Your browsers
function BrowsersSection({ toast }: { toast: Toast }) {
  const list = usePushBrowsers();
  const mine = useThisPushEndpoint();
  const remove = useRemovePushBrowser();
  const rows = useMemo(() => list.data ?? [], [list.data]);
  return (
    <Card title="Your browsers">
      <p className="text-xs text-gray-500 mb-2">Where replies reach you when no tab of the app is open. A browser is added when you turn desktop notifications on in it, and removed when you turn them off or log out.</p>
      {list.isLoading && <div className="text-xs text-gray-500 py-2">Loading…</div>}
      {list.error && <div className="text-xs text-red-600 py-2">{parseError(list.error).message}</div>}
      {!list.isLoading && !rows.length && <div className="text-sm text-gray-500 py-2">No browser yet.</div>}
      <ul className="divide-y divide-gray-100">
        {rows.map((r) => {
          const self = !!mine.data && mine.data === r.endpoint;
          const phone = /Android|iPhone|iPad/.test(r.label ?? '');
          const Icon = phone ? Smartphone : Laptop;
          return (
            <li key={r.id} className="flex items-center gap-3 py-2">
              <Icon className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <span className="min-w-0 flex-1 text-sm text-gray-900">
                {r.label ?? 'Browser'}{self ? <span className="text-gray-500"> · this browser</span> : <span className="text-gray-500"> · last used {timeAgo(r.last_seen_at)}</span>}
                {r.failing && <span className="block text-xs text-amber-700">The last notification could not be delivered here.</span>}
              </span>
              {!self && <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.id, { onSuccess: () => toast('Browser removed'), onError: (e) => toast(parseError(e).message, 'error') })}><Trash2 className="w-3.5 h-3.5" /> Remove</Button>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ page part
/** How the sections save: the page shows the new value in the same frame (a local overlay), the server settles it. */
interface Ctl {
  save: (patch: AlertSettingsPatch, onSettled?: () => void) => void;
  setPref: (kind: AlertKind, v: { desktop?: boolean; sound?: boolean }) => void;
  busy: boolean;
}
type Overlay = { s: Partial<AlertSettings>; kinds: Partial<Record<AlertKind, { desktop?: boolean; sound?: boolean }>> };

export default function AlertSettingsSections({ ws, userId, toast }: { ws: string; userId: string; toast: Toast }) {
  const q = useAlertSettings(ws);
  const saveM = useSaveAlertSettings(ws);
  const prefM = useSetAlertPref(ws);
  const [over, setOver] = useState<Overlay>({ s: {}, kinds: {} });
  const ctl: Ctl = {
    busy: saveM.isPending,
    save: (patch, onSettled) => {
      const shown: Partial<AlertSettings> = { ...patch };
      delete (shown as AlertSettingsPatch).enabled;
      delete (shown as AlertSettingsPatch).prompt;
      setOver((o) => ({ ...o, s: { ...o.s, ...shown } }));
      saveM.mutate(patch, {
        onError: (e) => toast(parseError(e).message, 'error'),
        onSettled: () => {
          setOver((o) => { const s = { ...o.s }; for (const k of Object.keys(shown)) delete (s as Record<string, unknown>)[k]; return { ...o, s }; });
          onSettled?.();
        },
      });
    },
    setPref: (kind, v) => {
      setOver((o) => ({ ...o, kinds: { ...o.kinds, [kind]: { ...o.kinds[kind], ...v } } }));
      prefM.mutate({ kind, ...v }, {
        onError: (e) => toast(parseError(e).message, 'error'),
        onSettled: () => setOver((o) => { const kinds = { ...o.kinds }; delete kinds[kind]; return { ...o, kinds }; }),
      });
    },
  };
  const settings = useMemo<AlertSettings | undefined>(() => {
    if (!q.data) return undefined;
    const kinds = { ...q.data.kinds };
    for (const [k, v] of Object.entries(over.kinds)) kinds[k as AlertKind] = { ...kinds[k as AlertKind], ...v };
    return { ...q.data, ...over.s, kinds };
  }, [q.data, over]);
  if (q.error) return <Card title="Reply alerts"><p className="text-sm text-red-600">{parseError(q.error).message}</p></Card>;
  if (!settings) return null;
  return (
    <div className="space-y-4">
      <BrowserSection ws={ws} userId={userId} settings={settings} toast={toast} />
      <SoundSection userId={userId} settings={settings} ctl={ctl} />
      <ScopeSection settings={settings} ctl={ctl} />
      <KindsSection settings={settings} ctl={ctl} />
      <OptionsSection settings={settings} ctl={ctl} />
      <PauseSection settings={settings} ctl={ctl} />
      <BrowsersSection toast={toast} />
    </div>
  );
}
