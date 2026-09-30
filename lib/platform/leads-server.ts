// Server-only helpers behind app/api/leads/*: request geo, client IP, CORS for the marketing site.
// SQL side: migrations/platform/002_leads.sql. Client side: lib/platform/leads.ts.
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export type LeadSource = 'website_waitlist' | 'website_demo' | 'website_integration' | 'website_contact' | 'website_other' | 'app_signup';

export interface Geo {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
}

export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function authClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── CORS: the marketing site (growthxai.com) posts forms here ───────────────
const ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*growthxai\.com$/i;
const DEV_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

export function allowedOrigin(req: NextRequest): string | null {
  const origin = req.headers.get('origin');
  if (!origin) return null;
  if (ORIGIN_RE.test(origin) || DEV_RE.test(origin)) return origin;
  const extra = (process.env.LEADS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin) ? origin : null;
}

export function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = allowedOrigin(req);
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(req: NextRequest, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(req) });
}

// ─── geo ─────────────────────────────────────────────────────────────────────
function dec(v: string | null): string | null {
  if (!v) return null;
  try { return decodeURIComponent(v).trim() || null; } catch { return v.trim() || null; }
}
function num(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  const first = fwd?.split(',')[0]?.trim();
  const ip = first || req.headers.get('x-real-ip') || req.headers.get('cf-connecting-ip') || null;
  if (!ip || ip === '::1' || ip === '127.0.0.1') return null;
  return ip;
}

/** Location from the platform's geo headers (Vercel, else Cloudflare). Everything is optional. */
export function geoFromHeaders(req: NextRequest): Geo {
  const h = req.headers;
  return {
    ip: clientIp(req),
    country: dec(h.get('x-vercel-ip-country')) ?? dec(h.get('cf-ipcountry')) ?? null,
    region: dec(h.get('x-vercel-ip-country-region')),
    city: dec(h.get('x-vercel-ip-city')),
    timezone: dec(h.get('x-vercel-ip-timezone')),
    latitude: num(h.get('x-vercel-ip-latitude')),
    longitude: num(h.get('x-vercel-ip-longitude')),
  };
}

/** Best effort: fill what the headers did not give from a public IP lookup (2.5 s budget, silent on failure). */
export async function geoLookup(geo: Geo): Promise<Geo> {
  if (geo.country || !geo.ip) return geo;
  if (process.env.LEADS_GEO_LOOKUP === 'off') return geo;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(geo.ip)}/json/`, { signal: ctrl.signal, headers: { 'User-Agent': 'growthxai-leads/1.0' } });
    clearTimeout(t);
    if (!res.ok) return geo;
    const d = (await res.json()) as Record<string, unknown>;
    if (d.error) return geo;
    const s = (k: string) => (typeof d[k] === 'string' && (d[k] as string).trim() ? (d[k] as string).trim() : null);
    const n = (k: string) => (typeof d[k] === 'number' && Number.isFinite(d[k] as number) ? (d[k] as number) : null);
    return {
      ...geo,
      country: geo.country ?? s('country_code'),
      region: geo.region ?? s('region'),
      city: geo.city ?? s('city'),
      timezone: geo.timezone ?? s('timezone'),
      latitude: geo.latitude ?? n('latitude'),
      longitude: geo.longitude ?? n('longitude'),
    };
  } catch {
    return geo;
  }
}

// ─── tiny in-memory rate limit (best effort on serverless) ───────────────────
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimited(key: string, max = 20, windowMs = 10 * 60_000): boolean {
  const now = Date.now();
  const cur = hits.get(key);
  if (!cur || cur.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  cur.n += 1;
  if (hits.size > 5000) hits.clear();
  return cur.n > max;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function str(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}
