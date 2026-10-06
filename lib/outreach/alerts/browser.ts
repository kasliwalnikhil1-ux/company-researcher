'use client';

/**
 * Reply alerts — what lives in THIS browser (reply-notifications-PRD.md D1, §4.2, §5, §7.1). No React here.
 *
 *   support / permission   can this browser show notifications, and what has the person answered
 *   desktop switch         "Desktop notifications on for this browser" — per browser and per signed-in user (kv)
 *   service worker         /outreach-sw.js, scope /outreach: shows, updates and clears notifications, handles clicks
 *   sound                  the four built-in sounds, unlocked by the first click / key press in the tab, rate-limited
 *   alerting tab           of all open app tabs only the most recently used one alerts (shared registry + a claim under
 *                          a Web Lock, so a reply never alerts twice even while tabs disagree for a moment)
 *
 * Nothing here runs in the product tour (IS_DEMO): no service worker, no permission prompt, no sound.
 */
import { IS_DEMO } from '../mode';
import { kv } from '../storage';

// ------------------------------------------------------------------------------------------------ support + permission
export type NotifyUnsupportedReason = 'private' | 'ios_home_screen' | 'https' | 'unsupported' | 'demo';
export type NotifySupport = { ok: true } | { ok: false; reason: NotifyUnsupportedReason };
export type NotifyPermission = 'default' | 'granted' | 'denied';

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone(): boolean {
  try { return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true; } catch { return false; }
}

export function notifySupport(): NotifySupport {
  if (IS_DEMO) return { ok: false, reason: 'demo' };
  if (typeof window === 'undefined') return { ok: false, reason: 'unsupported' };
  if (!window.isSecureContext) return { ok: false, reason: 'https' };
  if (isIos() && !isStandalone()) return { ok: false, reason: 'ios_home_screen' };
  if (!('Notification' in window)) return { ok: false, reason: 'unsupported' };
  // Firefox private windows (and some locked-down profiles) have no service workers
  if (!('serviceWorker' in navigator)) return { ok: false, reason: 'private' };
  return { ok: true };
}

export function notifyPermission(): NotifyPermission {
  try { return (window.Notification?.permission ?? 'default') as NotifyPermission; } catch { return 'default'; }
}

export const UNSUPPORTED_TEXT: Record<NotifyUnsupportedReason, string> = {
  private: 'This looks like a private window. Browsers do not show notifications there.',
  ios_home_screen: 'On iPhone and iPad, add the app to your Home Screen first (Share → Add to Home Screen), then open it from there.',
  https: 'Notifications need a secure (https) page.',
  unsupported: 'This browser cannot show notifications.',
  demo: 'Notifications are switched off in the product tour.',
};

/** "Chrome on Windows" — for Settings and the list of your browsers. */
export function browserLabel(): string {
  if (typeof navigator === 'undefined') return 'This browser';
  const ua = navigator.userAgent;
  const nav = navigator as Navigator & { brave?: unknown };
  const browser = nav.brave ? 'Brave' : /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : isIos() ? (/iPad/.test(ua) || navigator.maxTouchPoints > 1 ? 'iPad' : 'iPhone') : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// ------------------------------------------------------------------------------------------------ small shared store
type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;
function emit() { version++; listeners.forEach((l) => l()); }
export function subscribeAlertsBrowser(l: Listener): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key && e.key.startsWith('outreach-alerts-')) emit(); };
  const onVis = () => emit();   // re-read the permission when the person comes back from browser settings
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', onVis);
  return () => { listeners.delete(l); window.removeEventListener('storage', onStorage); document.removeEventListener('visibilitychange', onVis); };
}
export const alertsBrowserVersion = () => version;
export function notifyAlertsBrowserChanged() { emit(); }

function kvGet(k: string): string | null { try { return kv.getItem(k); } catch { return null; } }
function kvSet(k: string, v: string | null) { try { if (v === null) kv.removeItem(k); else kv.setItem(k, v); } catch { /* storage blocked */ } }

// ------------------------------------------------------------------------------------------------ desktop switch (this browser)
const desktopKey = (userId: string) => `outreach-alerts-desktop:${userId}`;
export function desktopSwitchOn(userId: string | null | undefined): boolean { return !!userId && kvGet(desktopKey(userId)) === '1'; }
export function setDesktopSwitch(userId: string, on: boolean) { kvSet(desktopKey(userId), on ? '1' : '0'); emit(); }

// sound blocked by the browser's autoplay rule (shown on the Settings page until a sound plays)
const SOUND_BLOCKED_KEY = 'outreach-alerts-sound-blocked';
export function soundWasBlocked(): boolean { return !!kvGet(SOUND_BLOCKED_KEY); }

// ------------------------------------------------------------------------------------------------ service worker
const SW_URL = '/outreach-sw.js';
const SW_SCOPE = '/outreach';
let regPromise: Promise<ServiceWorkerRegistration | null> | null = null;

function activeWorker(reg: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  if (reg.active) return Promise.resolve(reg.active);
  const w = reg.installing ?? reg.waiting;
  if (!w) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(reg.active ?? null), 10_000);
    w.addEventListener('statechange', () => { if (w.state === 'activated') { clearTimeout(t); resolve(w); } });
  });
}

/** Registers the alerts service worker once per page load (no-op in the tour or where it is not supported). */
export function alertsRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (IS_DEMO || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(null);
  if (!regPromise) {
    regPromise = navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE, updateViaCache: 'none' })
      .then(async (reg) => { await activeWorker(reg); return reg; })
      .catch(() => { regPromise = null; return null; });
  }
  return regPromise;
}

async function post(msg: Record<string, unknown>): Promise<boolean> {
  const reg = await alertsRegistration();
  const w = reg ? await activeWorker(reg) : null;
  if (!w) return false;
  w.postMessage(msg);
  return true;
}

/** What a desktop notification shows (the service worker composes the body: count, text, "LinkedIn · to Naman"). */
export interface DesktopAlert {
  id: string; kind: string; title: string; text?: string | null; count?: number; channel?: string | null; to?: string | null;
  ws_name?: string | null; preview?: boolean; chat_id?: string | null; message_id?: string | null; note_id?: string | null; ws?: string | null; at?: string | null;
}
export const showDesktopAlert = (data: DesktopAlert, opts: { silent?: boolean; update?: boolean } = {}) => post({ type: 'gx-alert-show', data, silent: !!opts.silent, update: !!opts.update });
export const clearDesktopAlert = (chatId: string) => post({ type: 'gx-alert-clear', chat_id: chatId });
export const showTestNotification = (silent: boolean) => post({ type: 'gx-alert-test', silent });

/** Clicks on a notification: the service worker focuses this tab and asks it to open the conversation. */
export function onNotificationOpen(cb: (m: { url: string; ws: string | null; chat_id: string | null }) => void): () => void {
  if (IS_DEMO || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  const h = (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: string; ws?: string | null; chat_id?: string | null } | null;
    if (d?.type === 'gx-alert-open' && typeof d.url === 'string' && d.url.startsWith('/outreach')) cb({ url: d.url, ws: d.ws ?? null, chat_id: d.chat_id ?? null });
  };
  navigator.serviceWorker.addEventListener('message', h);
  try { navigator.serviceWorker.startMessages(); } catch { /* older browsers start on their own */ }
  return () => navigator.serviceWorker.removeEventListener('message', h);
}

// ------------------------------------------------------------------------------------------------ sound
export type SoundName = 'ping' | 'chime' | 'pop' | 'knock';
export const SOUNDS: Array<{ value: SoundName; label: string }> = [
  { value: 'ping', label: 'Ping' }, { value: 'chime', label: 'Chime' }, { value: 'pop', label: 'Pop' }, { value: 'knock', label: 'Knock' },
];
const audio = new Map<SoundName, HTMLAudioElement>();
function audioFor(name: SoundName): HTMLAudioElement {
  let a = audio.get(name);
  if (!a) { a = new Audio(`/sounds/alerts/${name}.wav`); a.preload = 'auto'; audio.set(name, a); }
  return a;
}
let lastSoundAt = 0;
const lastSoundByChat = new Map<string, number>();
export type SoundResult = 'played' | 'blocked' | 'rate_limited' | 'off';

/**
 * Play an alert sound. Limits (§4.2): one sound every 3 s, one per conversation every 30 s (`chatId`; tests pass none).
 * A blocked play (the tab has not been clicked yet) fails quietly, is not retried, and the Settings page shows the hint.
 */
export async function playAlertSound(name: SoundName, volume: number, chatId?: string | null, opts: { test?: boolean } = {}): Promise<SoundResult> {
  if (IS_DEMO && !opts.test) return 'off';
  if (volume <= 0) return 'off';
  const now = Date.now();
  if (!opts.test) {
    if (now - lastSoundAt < 3000) return 'rate_limited';
    if (chatId && now - (lastSoundByChat.get(chatId) ?? 0) < 30_000) return 'rate_limited';
  }
  const a = audioFor(name);
  a.volume = Math.max(0, Math.min(1, volume / 100));
  try { a.currentTime = 0; } catch { /* not loaded yet */ }
  try {
    await a.play();
    lastSoundAt = now;
    if (chatId) lastSoundByChat.set(chatId, now);
    if (soundWasBlocked()) { kvSet(SOUND_BLOCKED_KEY, null); emit(); }
    return 'played';
  } catch (e) {
    if ((e as DOMException)?.name === 'NotAllowedError') { kvSet(SOUND_BLOCKED_KEY, String(now)); emit(); return 'blocked'; }
    return 'blocked';
  }
}

/** Load the sounds on the first click / key press so the first alert plays without a delay. */
export function installSoundUnlock(): () => void {
  if (IS_DEMO || typeof window === 'undefined') return () => {};
  const warm = () => { SOUNDS.forEach((s) => { try { audioFor(s.value).load(); } catch { /* ignore */ } }); };
  window.addEventListener('pointerdown', warm, { once: true, capture: true });
  window.addEventListener('keydown', warm, { once: true, capture: true });
  return () => { window.removeEventListener('pointerdown', warm, { capture: true }); window.removeEventListener('keydown', warm, { capture: true }); };
}

// ------------------------------------------------------------------------------------------------ the alerting tab
const TABS_KEY = 'outreach-alerts-tabs';
const CLAIMS_KEY = 'outreach-alerts-claims';
const ALIVE_MS = 90_000;   // background tabs beat about once a minute when the browser throttles them
export const TAB_ID: string = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `t${Math.random().toString(36).slice(2)}`;
type TabRow = { active: number; beat: number };

function readJson<T>(k: string, fallback: T): T { try { const v = kvGet(k); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } }

function touch(active: boolean) {
  const now = Date.now();
  const tabs = readJson<Record<string, TabRow>>(TABS_KEY, {});
  for (const [id, t] of Object.entries(tabs)) if (now - t.beat > ALIVE_MS * 3) delete tabs[id];
  tabs[TAB_ID] = { active: active ? now : tabs[TAB_ID]?.active ?? now, beat: now };
  kvSet(TABS_KEY, JSON.stringify(tabs));
}

/** True when this tab is the most recently used live app tab (ties: the lower id). */
export function isAlertingTab(): boolean {
  const now = Date.now();
  const tabs = readJson<Record<string, TabRow>>(TABS_KEY, {});
  const live = Object.entries(tabs).filter(([, t]) => now - t.beat <= ALIVE_MS);
  if (!live.some(([id]) => id === TAB_ID)) return live.length === 0;
  live.sort((a, b) => b[1].active - a[1].active || (a[0] < b[0] ? -1 : 1));
  return live[0][0] === TAB_ID;
}

/** Joins the registry: beats every 5 s, becomes the most recent on focus / click / key, leaves on close. */
export function joinAlertingTabs(): () => void {
  if (IS_DEMO || typeof window === 'undefined') return () => {};
  touch(document.visibilityState === 'visible' && document.hasFocus());
  let last = 0;
  const used = () => { const n = Date.now(); if (n - last > 1000) { last = n; touch(true); } };
  const onVis = () => { if (document.visibilityState === 'visible') used(); else touch(false); };
  const beat = window.setInterval(() => touch(false), 5000);
  const leave = () => { const tabs = readJson<Record<string, TabRow>>(TABS_KEY, {}); delete tabs[TAB_ID]; kvSet(TABS_KEY, JSON.stringify(tabs)); };
  window.addEventListener('focus', used);
  window.addEventListener('pointerdown', used, { capture: true });
  window.addEventListener('keydown', used, { capture: true });
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', leave);
  return () => {
    window.clearInterval(beat);
    window.removeEventListener('focus', used);
    window.removeEventListener('pointerdown', used, { capture: true });
    window.removeEventListener('keydown', used, { capture: true });
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pagehide', leave);
    leave();
  };
}

/** Exactly one tab handles an alert: the first to claim its key (under a Web Lock where available). */
export async function claimAlert(key: string): Promise<boolean> {
  const run = () => {
    const now = Date.now();
    const claims = readJson<Record<string, number>>(CLAIMS_KEY, {});
    for (const [k, at] of Object.entries(claims)) if (now - at > 10 * 60_000) delete claims[k];
    if (claims[key]) return false;
    claims[key] = now;
    kvSet(CLAIMS_KEY, JSON.stringify(claims));
    return true;
  };
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks?.request) {
    try { return await locks.request('gx-alert-claim', () => run()); } catch { /* fall through */ }
  }
  return run();
}
