import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const GETSALES_BASE = 'https://amazing.getsales.io';
const MAX_SENDER_PROFILES_LIMIT = 1000;

/* ──────────────────────────────────────────────────────────────
 * Email → Sender-Profile Access Map
 *
 *   '*'           → user can see ALL sender profiles
 *   string[]      → user can only see profiles whose `label`
 *                    (case-insensitive) is in the array
 *
 * Add new entries here as needed.
 * Any authenticated email NOT in this map is denied access (403).
 * ────────────────────────────────────────────────────────────── */
const EMAIL_ACCESS_MAP: Record<string, '*' | string[]> = {
  'founders@capitalxai.com': '*',
  'kasliwalnikhil1@gmail.com': ['kaptured'],
};

function getAllowedLabels(email: string): '*' | string[] | null {
  const entry = EMAIL_ACCESS_MAP[email.toLowerCase()];
  return entry ?? null;
}

function getAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !anonKey) throw new Error('Missing Supabase environment variables');
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function getGetsalesKey() {
  const key = process.env.GETSALES_KEY;
  if (!key) throw new Error('Missing GETSALES_KEY environment variable');
  return key;
}

/**
 * GET /api/sender-profiles
 * Proxy to GetSales: GET /flows/api/sender-profiles
 * Supports pagination, ordering, and filtering via query params.
 *
 * Access control: each user only sees the sender profiles they are
 * allowed to, based on the hard-coded EMAIL_ACCESS_MAP above.
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    if (!accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const authClient = getAuthClient(accessToken);
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userEmail = userData.user.email?.toLowerCase() || '';
    const allowedLabels = getAllowedLabels(userEmail);

    if (allowedLabels === null) {
      return NextResponse.json(
        { error: 'Forbidden – your account does not have access to sender profiles' },
        { status: 403 }
      );
    }

    // Forward all query params to GetSales
    const url = new URL(req.url);
    const params = new URLSearchParams();
    url.searchParams.forEach((value, key) => {
      params.append(key, value);
    });

    // Defaults
    if (!params.has('limit')) params.set('limit', String(MAX_SENDER_PROFILES_LIMIT));
    if (!params.has('offset')) params.set('offset', '0');
    if (!params.has('order_field')) params.set('order_field', 'created_at');
    if (!params.has('order_type')) params.set('order_type', 'desc');

    // ── Unrestricted user ('*') → pass through as-is ──
    if (allowedLabels === '*') {
      const gsUrl = `${GETSALES_BASE}/flows/api/sender-profiles?${params.toString()}`;
      const gsRes = await fetch(gsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${getGetsalesKey()}`,
          'Content-Type': 'application/json',
        },
      });

      if (!gsRes.ok) {
        const errText = await gsRes.text();
        console.error('[sender-profiles] GetSales GET error:', gsRes.status, errText);
        return NextResponse.json(
          { error: `GetSales API error: ${gsRes.status}`, details: errText },
          { status: gsRes.status }
        );
      }

      const data = await gsRes.json();
      return NextResponse.json(data);
    }

    // ── Restricted user → fetch all, filter by allowed labels, then paginate ──
    const requestedLimit = parseInt(params.get('limit') || String(MAX_SENDER_PROFILES_LIMIT), 10);
    const requestedOffset = parseInt(params.get('offset') || '0', 10);

    const fetchParams = new URLSearchParams(params);
    fetchParams.set('limit', String(MAX_SENDER_PROFILES_LIMIT));
    fetchParams.set('offset', '0');

    const gsUrl = `${GETSALES_BASE}/flows/api/sender-profiles?${fetchParams.toString()}`;
    const gsRes = await fetch(gsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${getGetsalesKey()}`,
        'Content-Type': 'application/json',
      },
    });

    if (!gsRes.ok) {
      const errText = await gsRes.text();
      console.error('[sender-profiles] GetSales GET error:', gsRes.status, errText);
      return NextResponse.json(
        { error: `GetSales API error: ${gsRes.status}`, details: errText },
        { status: gsRes.status }
      );
    }

    const rawData = await gsRes.json();
    const allProfiles: Array<{ label?: string; [key: string]: unknown }> = rawData.data || [];

    const allowedLower = allowedLabels.map((l) => l.toLowerCase());
    const filtered = allProfiles.filter(
      (p) => p.label && allowedLower.includes(p.label.toLowerCase())
    );

    const paginated = filtered.slice(requestedOffset, requestedOffset + requestedLimit);

    return NextResponse.json({
      data: paginated,
      total: filtered.length,
      limit: requestedLimit,
      offset: requestedOffset,
      has_more: requestedOffset + requestedLimit < filtered.length,
    });
  } catch (err) {
    console.error('[sender-profiles] GET Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/sender-profiles
 * Proxy to GetSales: POST /flows/api/sender-profiles
 * Body: { assignee_user_id, first_name, last_name, label }
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    if (!accessToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const authClient = getAuthClient(accessToken);
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();

    const gsRes = await fetch(`${GETSALES_BASE}/flows/api/sender-profiles`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getGetsalesKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!gsRes.ok) {
      const errText = await gsRes.text();
      console.error('[sender-profiles] GetSales POST error:', gsRes.status, errText);
      return NextResponse.json(
        { error: `GetSales API error: ${gsRes.status}`, details: errText },
        { status: gsRes.status }
      );
    }

    const data = await gsRes.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[sender-profiles] POST Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}
