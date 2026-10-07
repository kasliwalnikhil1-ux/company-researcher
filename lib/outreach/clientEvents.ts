'use client';

/**
 * What the web app records for Health (health-page-PRD.md §8.3): errors people see and a FIXED list of events, through
 * one RPC (outreach_report_client_event, 30 a minute per person, enforced in SQL). This is not analytics: no message
 * text, no lead data, no field values. For `form_rejected`, only the field names that failed.
 */
import { rpc } from '@/lib/outreach/api';
import { IS_DEMO } from '@/lib/outreach/mode';

export type ProductEvent = 'why_not_sending_opened' | 'form_rejected' | 'rage_click' | 'help_opened' | 'onboarding_step';

let workspaceId: string | null = null;
/** The outreach layout sets this once the workspace is known; events without it are stored without a workspace. */
export function setHealthWorkspace(id: string | null): void { workspaceId = id; }

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev';
const route = () => (typeof window === 'undefined' ? '' : window.location.pathname.replace(/\/[0-9a-f-]{36}(?=\/|$)/g, '/:id').slice(0, 200));

// a small client-side budget on top of the server's, so a render loop cannot even try 30 calls
let sentThisMinute = 0, minuteStart = Date.now();
function budget(): boolean {
  const now = Date.now();
  if (now - minuteStart > 60_000) { minuteStart = now; sentThisMinute = 0; }
  return ++sentThisMinute <= 20;
}

async function send(kind: 'error' | 'event', name: string | null, detail: Record<string, unknown>): Promise<void> {
  if (IS_DEMO || typeof window === 'undefined' || !budget()) return;
  try { await rpc('report_client_event', { p_kind: kind, p_name: name, p_route: route(), p_detail: { ...detail, workspace_id: workspaceId } }); } catch { /* never surfaces */ }
}

/** A stable fingerprint of an error: its name, the first line of the message with numbers and ids removed, and the first frame. */
export function fingerprintOf(err: unknown): { fingerprint: string; message: string } {
  const e = err as { name?: string; message?: string; stack?: string } | null;
  const msg = String(e?.message ?? err ?? 'error').split('\n')[0].slice(0, 300);
  const norm = msg.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id').replace(/\d+/g, '#').toLowerCase();
  const frame = String(e?.stack ?? '').split('\n').find((l) => /\.(js|tsx?):\d+/.test(l))?.replace(/\?.*$/, '').replace(/:\d+:\d+\)?$/, '').trim() ?? '';
  let h = 0;
  for (const ch of `${e?.name ?? ''}|${norm}|${frame}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { fingerprint: h.toString(16), message: msg };
}

const seen = new Map<string, number>();
/** An error boundary caught an error, or a request failed with a 500. The same error is reported at most once a minute per tab. */
export function reportError(err: unknown): void {
  const { fingerprint, message } = fingerprintOf(err);
  const last = seen.get(fingerprint) ?? 0;
  if (Date.now() - last < 60_000) return;
  seen.set(fingerprint, Date.now());
  void send('error', null, { fingerprint, message, app_version: APP_VERSION });
}

/** One of the fixed events. `detail` keys the server keeps: form, fields (names only), control, step, count. */
export function track(name: ProductEvent, detail: Record<string, unknown> = {}): void {
  void send('event', name, detail);
}

/** A form was rejected: pass the names of the fields that failed, never their values. */
export function trackFormRejected(form: string, fields: string[]): void { track('form_rejected', { form: form.slice(0, 60), fields: fields.slice(0, 20) }); }

/**
 * Installs the global listeners once per tab: unhandled errors and rejections (reportError) and rage clicks (four clicks on the same control within two seconds → one `rage_click` event per burst).
 * Returns the uninstall function.
 */
export function installHealthClientEvents(): () => void {
  if (typeof window === 'undefined' || IS_DEMO) return () => {};
  const onError = (ev: ErrorEvent) => { if (ev.error || ev.message) reportError(ev.error ?? ev.message); };
  const onRejection = (ev: PromiseRejectionEvent) => { reportError(ev.reason); };
  // rage clicks
  let lastKey = '', clicks: number[] = [], burstReported = false;
  const controlOf = (t: EventTarget | null): string => {
    const el = (t as HTMLElement | null)?.closest?.('button, a, [role="button"], input[type="submit"], [data-track]') as HTMLElement | null;
    if (!el) return '';
    return (el.getAttribute('data-track') || el.getAttribute('aria-label') || el.id || el.textContent?.trim().slice(0, 40) || el.tagName).slice(0, 80);
  };
  const onClick = (ev: MouseEvent) => {
    const key = controlOf(ev.target);
    if (!key) return;
    const now = Date.now();
    if (key !== lastKey) { lastKey = key; clicks = []; burstReported = false; }
    clicks = clicks.filter((t) => now - t < 2000); clicks.push(now);
    if (clicks.length >= 4 && !burstReported) { burstReported = true; track('rage_click', { control: key, count: clicks.length }); }
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  document.addEventListener('click', onClick, true);
  return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); document.removeEventListener('click', onClick, true); };
}
