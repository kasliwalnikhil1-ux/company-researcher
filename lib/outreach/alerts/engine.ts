'use client';

/**
 * Reply alerts — the page side of step 1 (reply-notifications-PRD.md §3.3, §4, §7.1). Mounted once in the outreach Shell.
 *
 * The database decides IF an alert may sound or show (alert_sound / alert_desktop / alert_muted on the notification row,
 * D5). This hook decides whether THIS moment on THIS device is right:
 *   reading that conversation (tab visible + focused)  → mark it read, nothing else
 *   elsewhere in the app                                → toast + sound (+ desktop only with "Notify even when I'm looking")
 *   app in a background tab / minimised window          → sound + desktop
 *   paused / quiet hours (alert_muted)                  → bell only
 * Only the alerting tab (most recently used) acts; a claim under a Web Lock makes sure one tab, once.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../api';
import { IS_DEMO } from '../mode';
import { usePathname, useRouter } from '../nav';
import {
  alertsRegistration, claimAlert, clearDesktopAlert, desktopSwitchOn, installSoundUnlock, isAlertingTab, joinAlertingTabs, notifyPermission,
  notifySupport, onNotificationOpen, playAlertSound, showDesktopAlert, type DesktopAlert, type SoundResult,
} from './browser';
import { syncPushIfDue, type AlertSettings } from './index';

/** A row of outreach_notifications as Realtime delivers it (RLS: the signed-in user's own rows). */
export interface AlertRow {
  id: string; workspace_id: string; user_id: string; kind: string; chat_id: string | null; note_id: string | null; message_id?: string | null;
  title: string; body: string | null; count?: number; data?: Record<string, unknown> | null;
  alert_desktop?: boolean; alert_sound?: boolean; alert_muted?: boolean; alerted_at?: string | null; read_at: string | null; created_at: string; updated_at?: string;
}

const CHAT_KINDS = ['reply_new', 'webchat_message', 'assigned'];
const FRESH_MS = 2 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chatIdOf = (path: string | null): string | null => /^\/outreach\/inbox\/([0-9a-f-]{36})/i.exec(path ?? '')?.[1] ?? null;

export function toDesktop(row: AlertRow, preview: boolean): DesktopAlert {
  const d = row.data ?? {};
  return {
    id: row.id, kind: row.kind, title: row.title, text: (d.text as string | undefined) ?? row.body, count: row.count ?? 1,
    channel: (d.channel as string | undefined) ?? null, to: (d.to as string | undefined) ?? null, ws_name: (d.ws_name as string | undefined) ?? null,
    preview, chat_id: row.chat_id, message_id: row.message_id ?? null, note_id: row.note_id, ws: row.workspace_id, at: row.alerted_at ?? row.created_at,
  };
}

export function useAlertEngine(a: {
  ws: string | null | undefined; userId: string | null | undefined; settings: AlertSettings | undefined;
  workspaces: Array<{ id: string }>; switchWorkspace: (id: string) => void;
  toast: (row: AlertRow) => void; untoast: (chatId: string) => void;
}) {
  const { userId } = a;
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const live = useRef(a);
  const path = useRef(pathname);
  useEffect(() => { live.current = a; });
  useEffect(() => { path.current = pathname; }, [pathname]);
  const seen = useRef(new Map<string, { at: string | null; count: number }>());

  // this tab joins the alerting-tab registry, sounds unlock on the first click, the service worker is ready for clicks
  useEffect(() => {
    if (IS_DEMO) return;
    const leave = joinAlertingTabs();
    const unlock = installSoundUnlock();
    if (notifySupport().ok) alertsRegistration().catch(() => null);
    return () => { leave(); unlock(); };
  }, []);
  useEffect(() => { if (userId) syncPushIfDue(userId).catch(() => undefined); }, [userId]);

  // a click on a notification: switch to its workspace when needed, then open the conversation in this tab
  useEffect(() => onNotificationOpen(({ url, ws: target }) => {
    const cur = live.current;
    if (target && target !== cur.ws && cur.workspaces.some((w) => w.id === target)) cur.switchWorkspace(target);
    router.push(url);
  }), [router]);

  // ?ws=<id> on a conversation link opened from a notification in a new tab
  useEffect(() => {
    if (IS_DEMO || typeof window === 'undefined') return;
    const target = new URLSearchParams(window.location.search).get('ws');
    const cur = live.current;
    if (target && target !== cur.ws && cur.workspaces.some((w) => w.id === target)) cur.switchWorkspace(target);
  }, [a.workspaces.length]);

  return useCallback(async (row: AlertRow, event: 'INSERT' | 'UPDATE') => {
    if (!row || !userId || row.user_id !== userId) return;
    // the tour: the in-app toast only (no sound, no desktop notification, no permission prompt)
    if (IS_DEMO) {
      if (event === 'INSERT' && !row.read_at && row.workspace_id === live.current.ws) live.current.toast(row);
      return;
    }
    // the inbox badges and the tab title follow every change
    qc.invalidateQueries({ queryKey: ['outreach', row.workspace_id, 'inbox-counts'] });
    if (row.read_at) {
      seen.current.delete(row.id);
      if (row.chat_id) { clearDesktopAlert(row.chat_id).catch(() => false); live.current.untoast(row.chat_id); }
      return;
    }
    const prev = seen.current.get(row.id);
    const count = row.count ?? 1;
    seen.current.set(row.id, { at: row.alerted_at ?? null, count });
    const fresh = !!row.alerted_at && Date.now() - Date.parse(row.alerted_at) < FRESH_MS;
    const isNew = fresh && (event === 'INSERT' || !prev || prev.at !== row.alerted_at);
    const s = live.current.settings;
    const desktopOk = !!row.alert_desktop && desktopSwitchOn(userId) && notifySupport().ok && notifyPermission() === 'granted';

    if (!isNew) {
      // a merged message inside 30 s: refresh the text of a notification that is still on screen, silently
      if (prev && count !== prev.count && desktopOk && isAlertingTab()) showDesktopAlert(toDesktop(row, s?.show_preview ?? true), { update: true }).catch(() => false);
      return;
    }
    // one tab alerts: the most recent one at once; any other only if nobody claimed the alert within 2 s
    if (!isAlertingTab()) await sleep(2000);
    if (!(await claimAlert(`${row.id}|${row.alerted_at}`))) return;

    const visible = document.visibilityState === 'visible' && document.hasFocus();
    if (visible && row.chat_id && chatIdOf(path.current) === row.chat_id) {
      if (CHAT_KINDS.includes(row.kind)) rpc('alerts_mark_chat_read', { p_chat: row.chat_id }).catch(() => undefined);
      return;
    }
    if (row.alert_muted) return;
    let sound: SoundResult = 'off';
    if (row.alert_sound && s) sound = await playAlertSound(s.sound_name, s.sound_volume, row.chat_id);
    // the app's own sound replaces the notification's; a sound the browser blocked falls back to the system sound
    const silent = !(row.alert_sound && sound === 'blocked');
    if (visible) {
      if (row.workspace_id === live.current.ws) live.current.toast(row);
      if (desktopOk && s?.alert_when_visible) showDesktopAlert(toDesktop(row, s.show_preview), { silent }).catch(() => false);
    } else if (desktopOk) {
      showDesktopAlert(toDesktop(row, s?.show_preview ?? true), { silent }).catch(() => false);
    }
  }, [userId, qc]);
}

// ------------------------------------------------------------------------------------------------ tab title, icon dot, app badge
const ICON_SELECTOR = 'link[rel~="icon"]';

function dotIcon(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 32; c.height = 32;
        const g = c.getContext('2d');
        if (!g) return resolve(null);
        g.drawImage(img, 0, 0, 32, 32);
        g.beginPath(); g.arc(24, 8, 7.5, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
        g.beginPath(); g.arc(24, 8, 6, 0, Math.PI * 2); g.fillStyle = '#ef4444'; g.fill();
        resolve(c.toDataURL('image/png'));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * "(3) Inbox · …" in the tab title, a red dot on the tab icon while anything is unread, and the number on the installed
 * app's icon (§4.3). `count` = unread conversations, the same number as the Replies badge.
 */
export function useTabBadge(count: number | null | undefined) {
  const n = Math.max(0, count ?? 0);
  useEffect(() => {
    if (IS_DEMO || typeof document === 'undefined') return;
    const strip = (t: string) => t.replace(/^\(\d+\+?\)\s/, '');
    const apply = () => {
      const base = strip(document.title);
      const want = n > 0 ? `(${n > 99 ? '99+' : n}) ${base}` : base;
      if (document.title !== want) document.title = want;
    };
    apply();
    const titleEl = document.querySelector('title');
    const mo = titleEl ? new MutationObserver(apply) : null;
    if (titleEl && mo) mo.observe(titleEl, { childList: true, characterData: true, subtree: true });
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (n > 0) nav.setAppBadge?.(n).catch(() => undefined); else nav.clearAppBadge?.().catch(() => undefined);
    return () => { mo?.disconnect(); document.title = strip(document.title); };
  }, [n]);

  const dotted = n > 0;
  useEffect(() => {
    if (IS_DEMO || typeof document === 'undefined' || !dotted) return;
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>(ICON_SELECTOR));
    if (!links.length) return;
    const originals = links.map((l) => l.href);
    let cancelled = false;
    dotIcon('/favicon-32x32.png').then((url) => { if (url && !cancelled) links.forEach((l) => { l.href = url; }); });
    return () => { cancelled = true; links.forEach((l, i) => { l.href = originals[i]; }); };
  }, [dotted]);
}
