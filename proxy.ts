/**
 * proxy.ts (Next.js 16: the file that used to be `middleware.ts`)
 *
 * ONE job: white-label custom domains for the Outreach client portal (product plan item 23).
 *
 * What it does
 *   1. Runs only for `/` and `/outreach/*` (see `config.matcher`). `/_next`, `/api`, static files and every other
 *      route of the app are never touched.
 *   2. If the request host is one of the app's own hosts, it does nothing and the request passes through unchanged.
 *      Own hosts are: the host of NEXT_PUBLIC_APP_URL, anything in OUTREACH_APP_HOSTS (comma separated),
 *      localhost / 127.0.0.1 / *.localhost, Vercel preview hosts (*.vercel.app and the VERCEL_* URLs) and bare IPs.
 *   3. Any other host MAY be an agency's custom domain. It is looked up with the anon RPC
 *      `outreach_branding_for_host` (only domains with status `active` resolve).
 *        - unknown host  -> the request passes through unchanged
 *        - lookup fails  -> the request passes through unchanged (fail open; the app keeps working)
 *        - known host    -> the request header `x-outreach-host` is set (plus `x-outreach-workspace` and, when the
 *                           domain belongs to one client, `x-outreach-client`), and `/` is rewritten to the portal
 *                           entry: `/outreach/c/<client id>` for a client domain, `/outreach/c` otherwise.
 *                           The browser URL stays `/`.
 *
 * What it does NOT do
 *   - No authentication, no redirects, no cookies. This app signs in on the client (Supabase session in the browser,
 *     `components/ProtectedRoute`), and there was no middleware before this file, so nothing here can break sign-in.
 *     Note that a browser session belongs to one origin: a client signs in once on the custom domain.
 *   - It never trusts an incoming `x-outreach-*` header. They are removed before ours are set, so a page can rely on them.
 *
 * Client components cannot read request headers. They use `useHostBranding()` / `brandingForHost(window.location.hostname)`
 * from `lib/outreach/branding.ts`, which calls the same RPC. The header is for server components and route handlers.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const config = {
  // Keep this list short and literal: it is analysed at build time and is the only thing standing between
  // this file and the rest of the app.
  matcher: ['/', '/outreach/:path*'],
};

const HOST_HEADER = 'x-outreach-host';
const WORKSPACE_HEADER = 'x-outreach-workspace';
const CLIENT_HEADER = 'x-outreach-client';
const OUR_HEADERS = [HOST_HEADER, WORKSPACE_HEADER, CLIENT_HEADER];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function hostOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try { return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase(); } catch { return null; }
}

const OWN_HOSTS: Set<string> = new Set(
  [
    hostOf(process.env.NEXT_PUBLIC_APP_URL) ?? 'app.capitalxai.com',
    hostOf(process.env.VERCEL_URL), hostOf(process.env.VERCEL_BRANCH_URL), hostOf(process.env.VERCEL_PROJECT_PRODUCTION_URL),
    ...(process.env.OUTREACH_APP_HOSTS ?? '').split(',').map((h) => hostOf(h.trim())),
  ].filter((h): h is string => !!h),
);

function isOwnHost(host: string): boolean {
  if (OWN_HOSTS.has(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.vercel.app')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return true;   // IPv4 / IPv6 literals
  return !HOSTNAME.test(host);   // anything that is not a plain DNS name is not a custom domain
}

type Resolved = { workspace_id: string; client_id: string | null } | null;
const cache = new Map<string, { at: number; value: Resolved }>();
const TTL_HIT = 5 * 60_000;
const TTL_MISS = 60_000;
const CACHE_MAX = 500;

/** Returns null for an unknown host, and undefined when the lookup itself failed (so the caller can fail open without caching). */
async function resolveHost(host: string): Promise<Resolved | undefined> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < (hit.value ? TTL_HIT : TTL_MISS)) return hit.value;

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !anon) return undefined;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/rest/v1/rpc/outreach_branding_for_host`, {
      method: 'POST', cache: 'no-store', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${anon}` },
      body: JSON.stringify({ p_hostname: host }),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { workspace_id?: unknown; client_id?: unknown } | null;
    const value: Resolved = data && typeof data.workspace_id === 'string' && UUID.test(data.workspace_id)
      ? { workspace_id: data.workspace_id, client_id: typeof data.client_id === 'string' && UUID.test(data.client_id) ? data.client_id : null }
      : null;
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(host, { at: Date.now(), value });
    return value;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Belt and braces: the matcher already limits this, the check keeps a future matcher edit from widening the effect.
  if (pathname !== '/' && pathname !== '/outreach' && !pathname.startsWith('/outreach/')) return NextResponse.next();

  const spoofed = OUR_HEADERS.some((h) => request.headers.has(h));
  const passThrough = () => {
    if (!spoofed) return NextResponse.next();
    const headers = new Headers(request.headers);
    for (const h of OUR_HEADERS) headers.delete(h);
    return NextResponse.next({ request: { headers } });
  };

  const host = (request.headers.get('host') ?? request.nextUrl.host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host || isOwnHost(host)) return passThrough();

  const resolved = await resolveHost(host);
  if (!resolved) return passThrough();          // unknown host, or the lookup failed: leave the request alone

  const headers = new Headers(request.headers);
  for (const h of OUR_HEADERS) headers.delete(h);
  headers.set(HOST_HEADER, host);
  headers.set(WORKSPACE_HEADER, resolved.workspace_id);
  if (resolved.client_id) headers.set(CLIENT_HEADER, resolved.client_id);

  if (pathname === '/') {
    const url = request.nextUrl.clone();
    url.pathname = resolved.client_id ? `/outreach/c/${resolved.client_id}` : '/outreach/c';
    return NextResponse.rewrite(url, { request: { headers } });
  }
  return NextResponse.next({ request: { headers } });
}
