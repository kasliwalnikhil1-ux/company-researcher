/**
 * Runtime block (docs/outreach/PRODUCT-TOUR.md §3.4, guard 4). On `/product-tour` it wraps fetch, XMLHttpRequest,
 * WebSocket and sendBeacon and REFUSES any request to the Supabase project's data endpoints (/rest/v1, /functions/v1,
 * /storage/v1, /realtime/v1), to the app's /api routes, or to any host outside the allow-list. It answers nothing:
 * the call throws E_DEMO_BLOCKED, the URL is logged and counted (`window.__gxdemoBlocked`, read by the demo check),
 * and in development a red note appears on screen so a leak is seen at once.
 *
 * Allowed: same-origin pages and static files (Next.js navigation, /_next, /widget/v1, images, fonts), Supabase
 * /auth/v1 (the root providers' session lookup, no data), and Vercel Analytics.
 */
import { IS_DEMO } from '@/lib/outreach/mode';

declare global {
  interface Window { __gxdemoBlocked?: string[]; __gxdemoGuard?: boolean }
}

const SUPABASE_HOST = (() => { try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://invalid.local').host; } catch { return ''; } })();
const ANALYTICS_HOSTS = new Set(['va.vercel-scripts.com', 'vitals.vercel-insights.com']);

export function isAllowed(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw, window.location.href); } catch { return false; }
  if (u.protocol === 'blob:' || u.protocol === 'data:') return true;
  if (u.origin === window.location.origin || (u.protocol.startsWith('ws') && u.host === window.location.host)) return !u.pathname.startsWith('/api/');
  if (u.host === SUPABASE_HOST) return u.pathname.startsWith('/auth/v1/');
  return ANALYTICS_HOSTS.has(u.host);
}

function blocked(url: string): Error {
  (window.__gxdemoBlocked ??= []).push(url);
  console.error(`[product tour] E_DEMO_BLOCKED: refused a request to ${url}`);
  if (process.env.NODE_ENV !== 'production') {
    const el = document.createElement('div');
    el.textContent = `Demo guard blocked a request: ${url}`;
    el.setAttribute('role', 'alert');
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#dc2626;color:#fff;font:12px/1.4 system-ui;padding:8px 10px;border-radius:8px;max-width:420px;word-break:break-all';
    document.body?.appendChild(el);
    setTimeout(() => el.remove(), 8000);
  }
  window.dispatchEvent(new CustomEvent('gxdemo:blocked', { detail: url }));
  return Object.assign(new Error(`E_DEMO_BLOCKED: ${url}`), { code: 'E_DEMO_BLOCKED' });
}

export function installNetworkGuard(): void {
  if (typeof window === 'undefined' || window.__gxdemoGuard) return;
  window.__gxdemoGuard = true;
  window.__gxdemoBlocked = window.__gxdemoBlocked ?? [];

  const origFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isAllowed(url)) return Promise.reject(blocked(url));
    return origFetch(input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function open(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    const u = String(url);
    if (!isAllowed(u)) throw blocked(u);
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;

  const OrigWS = window.WebSocket;
  const GuardedWS = function GuardedWebSocket(this: WebSocket, url: string | URL, protocols?: string | string[]) {
    const u = String(url);
    if (!isAllowed(u)) throw blocked(u);
    return new OrigWS(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(GuardedWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: OrigWS.prototype });
  window.WebSocket = GuardedWS;

  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      const u = String(url);
      if (!isAllowed(u)) { blocked(u); return false; }
      return origBeacon(url, data);
    };
  }

  if (typeof window.EventSource !== 'undefined') {
    const OrigES = window.EventSource;
    const GuardedES = function GuardedEventSource(this: EventSource, url: string | URL, init?: EventSourceInit) {
      const u = String(url);
      if (!isAllowed(u)) throw blocked(u);
      return new OrigES(url, init);
    } as unknown as typeof EventSource;
    Object.assign(GuardedES, { CONNECTING: 0, OPEN: 1, CLOSED: 2, prototype: OrigES.prototype });
    window.EventSource = GuardedES;
  }
}

// Installed as soon as this module loads on /product-tour (the layout imports it), before any screen renders.
if (IS_DEMO) installNetworkGuard();
