'use client';

/**
 * Reply alerts (reply-notifications-PRD.md): settings, the permission flow and Web Push, for React.
 * The person's choices live on the user (outreach_alert_settings_* / outreach_alert_pref_set, migration 076); this
 * browser's permission and on/off switch live in this browser (./browser.ts).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { callFn, rpc } from '../api';
import { IS_DEMO } from '../mode';
import { kv } from '../storage';
import {
  alertsBrowserVersion, alertsRegistration, browserLabel, desktopSwitchOn, notifyAlertsBrowserChanged, notifyPermission, notifySupport,
  setDesktopSwitch, showTestNotification, soundWasBlocked, subscribeAlertsBrowser, type NotifyPermission, type NotifySupport, type SoundName,
} from './browser';

export * from './browser';

// ------------------------------------------------------------------------------------------------ types
export type AlertKind = 'reply_new' | 'webchat_message' | 'note_mention' | 'ai_handoff' | 'assigned';
export type AlertScope = 'mine' | 'mine_unassigned' | 'all';
export interface QuietHours { days: number[]; start: string; end: string; tz: string }
export interface AlertSettings {
  scope: AlertScope;
  include_ai_handled: boolean;
  sound_enabled: boolean;
  sound_name: SoundName;
  sound_volume: number;
  show_preview: boolean;
  alert_when_visible: boolean;
  quiet_hours: QuietHours | null;
  /** ISO time, 'infinity' (until turned back on) or null */
  paused_until: string | null;
  enabled_at: string | null;
  prompt_dismissed_at: string | null;
  prompt_dismiss_count: number;
  kinds: Record<AlertKind, { desktop: boolean; sound: boolean }>;
  /** paused or outside quiet hours right now */
  muted: boolean;
  now: string;
}
export type AlertSettingsPatch = Partial<Pick<AlertSettings, 'scope' | 'include_ai_handled' | 'sound_enabled' | 'sound_name' | 'sound_volume' | 'show_preview' | 'alert_when_visible' | 'quiet_hours' | 'paused_until'>>
  & { enabled?: boolean; prompt?: 'dismissed' | 'answered' };

export const ALERT_KINDS: Array<{ kind: AlertKind; label: string }> = [
  { kind: 'reply_new', label: 'New reply' },
  { kind: 'webchat_message', label: 'Website chat message' },
  { kind: 'note_mention', label: 'Mention in a private note' },
  { kind: 'ai_handoff', label: 'AI handed a conversation to me' },
  { kind: 'assigned', label: 'Conversation assigned to me' },
];

export const SCOPES: Array<{ value: AlertScope; label: string; hint: string }> = [
  { value: 'mine', label: 'Conversations assigned to me', hint: 'Assigned to you, or unassigned on a sender you own.' },
  { value: 'mine_unassigned', label: 'Assigned to me and unassigned', hint: 'Plus any conversation nobody has picked up yet.' },
  { value: 'all', label: 'Every conversation I can see', hint: 'Everything your role and clients let you see.' },
];

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  scope: 'mine_unassigned', include_ai_handled: false, sound_enabled: false, sound_name: 'ping', sound_volume: 70, show_preview: true,
  alert_when_visible: false, quiet_hours: null, paused_until: null, enabled_at: null, prompt_dismissed_at: null, prompt_dismiss_count: 0,
  kinds: {
    reply_new: { desktop: true, sound: true }, webchat_message: { desktop: true, sound: true }, note_mention: { desktop: true, sound: true },
    ai_handoff: { desktop: true, sound: true }, assigned: { desktop: true, sound: false },
  },
  muted: false, now: new Date(0).toISOString(),
};

// ------------------------------------------------------------------------------------------------ settings (on the user)
export const alertKeys = {
  settings: (ws: string) => ['outreach', ws, 'alerts', 'settings'] as const,
  browsers: () => ['outreach', 'alerts', 'browsers'] as const,
};

export function useAlertSettings(ws: string | null | undefined) {
  return useQuery({
    queryKey: alertKeys.settings(ws ?? ''), enabled: !!ws, staleTime: 60_000, refetchOnWindowFocus: true, retry: 1,
    queryFn: () => rpc<AlertSettings>('alert_settings_get', { p_ws: ws }),
  });
}

/** Every change saves at once (§6): the page updates optimistically and settles on the server's answer. */
export function useSaveAlertSettings(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    // one at a time, in click order: two quick changes can never reach the server the other way round
    scope: { id: `alert-settings:${ws}` },
    mutationFn: (patch: AlertSettingsPatch) => rpc<AlertSettings>('alert_settings_save', { p_ws: ws, p_patch: patch }),
    onMutate: async (patch) => {
      const prev = qc.getQueryData<AlertSettings>(alertKeys.settings(ws));
      if (prev) {
        const rest: Partial<AlertSettings> = { ...patch };
        delete (rest as AlertSettingsPatch).enabled;
        delete (rest as AlertSettingsPatch).prompt;
        qc.setQueryData<AlertSettings>(alertKeys.settings(ws), { ...prev, ...rest });
      }
      // the optimistic value goes in first (a controlled radio must not flick back); an in-flight read is dropped, not reverted
      await qc.cancelQueries({ queryKey: alertKeys.settings(ws) }, { revert: false });
      return { prev };
    },
    onError: (_e, _p, ctx) => { if (ctx?.prev) qc.setQueryData(alertKeys.settings(ws), ctx.prev); },
    onSuccess: (s) => qc.setQueryData(alertKeys.settings(ws), s),
  });
}

export function useSetAlertPref(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    scope: { id: `alert-settings:${ws}` },
    mutationFn: (a: { kind: AlertKind; desktop?: boolean; sound?: boolean }) =>
      rpc<AlertSettings>('alert_pref_set', { p_ws: ws, p_kind: a.kind, p_desktop: a.desktop ?? null, p_sound: a.sound ?? null }),
    onMutate: async (a) => {
      const prev = qc.getQueryData<AlertSettings>(alertKeys.settings(ws));
      if (prev) {
        const cur = prev.kinds[a.kind];
        qc.setQueryData<AlertSettings>(alertKeys.settings(ws), { ...prev, kinds: { ...prev.kinds, [a.kind]: { desktop: a.desktop ?? cur.desktop, sound: a.sound ?? cur.sound } } });
      }
      await qc.cancelQueries({ queryKey: alertKeys.settings(ws) }, { revert: false });
      return { prev };
    },
    onError: (_e, _a, ctx) => { if (ctx?.prev) qc.setQueryData(alertKeys.settings(ws), ctx.prev); },
    onSuccess: (s) => qc.setQueryData(alertKeys.settings(ws), s),
  });
}

// ------------------------------------------------------------------------------------------------ this browser
export interface BrowserAlertState {
  support: NotifySupport;
  permission: NotifyPermission;
  /** the person switched desktop notifications on in this browser (and the browser allows them) */
  desktopOn: boolean;
  /** the switch is on but the browser no longer allows notifications (blocked later in browser settings) */
  switchOnButBlocked: boolean;
  soundBlocked: boolean;
  label: string;
}

const SERVER_SNAPSHOT = 0;
export function useBrowserAlertState(userId: string | null | undefined): BrowserAlertState {
  const v = useSyncExternalStore(subscribeAlertsBrowser, alertsBrowserVersion, () => SERVER_SNAPSHOT);
  return useMemo(() => {
    const support = typeof window === 'undefined' ? ({ ok: false, reason: 'unsupported' } as NotifySupport) : notifySupport();
    const permission = support.ok ? notifyPermission() : 'default';
    const sw = desktopSwitchOn(userId);
    return {
      support, permission,
      desktopOn: support.ok && permission === 'granted' && sw,
      switchOnButBlocked: support.ok && sw && permission === 'denied',
      soundBlocked: typeof window !== 'undefined' && soundWasBlocked(),
      label: typeof window === 'undefined' ? 'This browser' : browserLabel(),
    };
  }, [v, userId]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Old Safari only has the callback form of requestPermission. */
function askPermission(): Promise<NotifyPermission> {
  return new Promise((resolve) => {
    try {
      const p = window.Notification.requestPermission((r) => resolve(r as NotifyPermission));
      if (p && typeof (p as Promise<NotificationPermission>).then === 'function') (p as Promise<NotificationPermission>).then((r) => resolve(r as NotifyPermission), () => resolve(notifyPermission()));
    } catch { resolve(notifyPermission()); }
  });
}

export type TurnOnResult = 'granted' | 'denied' | 'dismissed' | 'unsupported';

/**
 * The **Turn on** click (§5.2). Call it straight from the click handler: the browser's prompt has to come from the click.
 *   granted   → desktop on for this browser, sound if ticked, a test notification, choices saved, Web Push subscribed
 *   denied    → nothing on (the caller shows the steps to allow); sound can still be turned on — it needs no permission
 *   dismissed → closed without answering: counts as "Not now"
 */
export async function turnOnAlerts(a: { userId: string; withSound: boolean; save: (p: AlertSettingsPatch) => Promise<unknown> }): Promise<TurnOnResult> {
  const support = notifySupport();
  if (!support.ok) return 'unsupported';
  const already = notifyPermission();
  const answer = already === 'granted' ? 'granted' : await askPermission();
  notifyAlertsBrowserChanged();
  if (answer === 'granted') {
    setDesktopSwitch(a.userId, true);
    await a.save({ enabled: true, prompt: 'answered', ...(a.withSound ? { sound_enabled: true } : {}) }).catch(() => undefined);
    await showTestNotification(false);
    enablePush().catch(() => undefined);
    return 'granted';
  }
  if (answer === 'denied') {
    await a.save({ prompt: 'answered', ...(a.withSound ? { sound_enabled: true, enabled: true } : {}) }).catch(() => undefined);
    return 'denied';
  }
  await a.save({ prompt: 'dismissed' }).catch(() => undefined);
  return 'dismissed';
}

/** Turn desktop notifications off for this browser only (the choices on the user stay). */
export async function turnOffDesktop(userId: string): Promise<void> {
  setDesktopSwitch(userId, false);
  await disablePush().catch(() => undefined);
}

/** Switched off earlier and the browser still allows it: no prompt needed. */
export async function turnOnDesktopAgain(userId: string, save: (p: AlertSettingsPatch) => Promise<unknown>): Promise<void> {
  setDesktopSwitch(userId, true);
  await save({ enabled: true }).catch(() => undefined);
  await enablePush().catch(() => undefined);
}

// ------------------------------------------------------------------------------------------------ Web Push (step 2)
function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const t = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

const PUSH_SYNC_KEY = 'outreach-alerts-push-synced';

/** Subscribe this browser to Web Push and save it on the server (refreshes "last used"). */
export async function enablePush(): Promise<'subscribed' | 'unsupported'> {
  if (IS_DEMO) return 'unsupported';
  const reg = await alertsRegistration();
  if (!reg || !('pushManager' in reg) || notifyPermission() !== 'granted') return 'unsupported';
  const r = await callFn<{ public_key: string }>('notify-push', {}, { method: 'GET', query: { action: 'public_key' } });
  const key = keyBytes(r.public_key);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => false); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const j = sub.toJSON();
  await rpc('push_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh, p_auth: j.keys?.auth, p_label: browserLabel() });
  try { kv.setItem(PUSH_SYNC_KEY, String(Date.now())); } catch { /* ignore */ }
  return 'subscribed';
}

/** Remove this browser's subscription (turned off here). Log out does the same in AuthContext. */
export async function disablePush(): Promise<void> {
  if (IS_DEMO) return;
  const reg = await alertsRegistration();
  const sub = reg && 'pushManager' in reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  await rpc('push_unsubscribe', { p_endpoint: sub.endpoint, p_id: null }).catch(() => undefined);
  await sub.unsubscribe().catch(() => false);
}

/** Once a day per browser: keep the saved subscription fresh (or recreate one the browser dropped). */
export async function syncPushIfDue(userId: string): Promise<void> {
  if (IS_DEMO || !desktopSwitchOn(userId) || notifyPermission() !== 'granted') return;
  let last = 0;
  try { last = Number(kv.getItem(PUSH_SYNC_KEY) ?? 0); } catch { /* ignore */ }
  if (Date.now() - last < 24 * 3600_000) return;
  await enablePush().catch(() => undefined);
}

export interface PushBrowser { id: string; label: string | null; endpoint: string; created_at: string; last_seen_at: string; failing: boolean }

export function usePushBrowsers(enabled = true) {
  return useQuery({ queryKey: alertKeys.browsers(), enabled, staleTime: 30_000, queryFn: () => rpc<PushBrowser[]>('push_subscriptions_list', {}) });
}
export function useRemovePushBrowser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rpc<number>('push_unsubscribe', { p_endpoint: null, p_id: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: alertKeys.browsers() }),
  });
}
/** This browser's push endpoint (to mark "this browser" in the list). */
export function useThisPushEndpoint() {
  return useQuery({
    queryKey: ['outreach', 'alerts', 'this-endpoint'], staleTime: 60_000,
    queryFn: async () => {
      const reg = await alertsRegistration();
      const sub = reg && 'pushManager' in reg ? await reg.pushManager.getSubscription() : null;
      return sub?.endpoint ?? null;
    },
  });
}

// ------------------------------------------------------------------------------------------------ pause
export function isPaused(s: Pick<AlertSettings, 'paused_until'> | null | undefined, now = Date.now()): boolean {
  if (!s?.paused_until) return false;
  return s.paused_until === 'infinity' || Date.parse(s.paused_until) > now;
}

/** "25 min left" · "Until 9:00 tomorrow" · "Paused"; `compact` (beside the bell): "25m" · "1h 5m" · "until 9:00" · "paused" */
export function pauseLeftLabel(s: Pick<AlertSettings, 'paused_until'> | null | undefined, now = Date.now(), compact = false): string | null {
  if (!isPaused(s, now)) return null;
  if (s!.paused_until === 'infinity') return compact ? 'paused' : 'Paused';
  const until = Date.parse(s!.paused_until!);
  const mins = Math.ceil((until - now) / 60_000);
  if (compact) {
    if (mins < 60) return `${mins}m`;
    if (mins < 180) return `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`;
    return `until ${new Date(until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (mins < 60) return `${mins} min left`;
  if (mins < 180) return `${Math.floor(mins / 60)} h ${mins % 60 ? `${mins % 60} min ` : ''}left`;
  const d = new Date(until);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === tomorrow.toDateString() ? `Until ${time} tomorrow` : `Until ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

export const PAUSE_OPTIONS: Array<{ value: '30m' | '1h' | 'tomorrow' | 'forever'; label: string }> = [
  { value: '30m', label: '30 minutes' }, { value: '1h', label: '1 hour' }, { value: 'tomorrow', label: 'Until tomorrow 9:00' }, { value: 'forever', label: 'Until I turn it back on' },
];
export function pauseUntil(v: (typeof PAUSE_OPTIONS)[number]['value'], now = new Date()): string {
  if (v === 'forever') return 'infinity';
  if (v === '30m') return new Date(now.getTime() + 30 * 60_000).toISOString();
  if (v === '1h') return new Date(now.getTime() + 60 * 60_000).toISOString();
  const t = new Date(now); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0);
  return t.toISOString();
}

/** Inbox prompt (§5.1): shown once; after one "Not now" it comes back once, 7 days later; never after the second. */
export function shouldShowPrompt(s: AlertSettings | null | undefined, b: BrowserAlertState, now = Date.now()): boolean {
  if (IS_DEMO || !s || !b.support.ok || b.permission !== 'default') return false;
  if (s.enabled_at) return false;
  if (s.prompt_dismiss_count >= 2) return false;
  if (s.prompt_dismiss_count === 1) return !!s.prompt_dismissed_at && now - Date.parse(s.prompt_dismissed_at) >= 7 * 24 * 3600_000;
  return true;
}

/** Saves through the mutation and resolves with the server's settings (for the turn-on flow). */
export function useAlertSaver(ws: string) {
  const m = useSaveAlertSettings(ws);
  return useCallback((p: AlertSettingsPatch) => m.mutateAsync(p), [m]);
}
