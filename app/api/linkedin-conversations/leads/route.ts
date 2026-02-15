import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const GETSALES_BASE = 'https://amazing.getsales.io';

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
 * GET /api/linkedin-conversations/leads?uuid=...
 * Proxy to GetSales: GET /leads/api/leads/{uuid}
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

    const url = new URL(req.url);
    const uuid = url.searchParams.get('uuid');
    if (!uuid) {
      return NextResponse.json({ error: 'Missing uuid parameter' }, { status: 400 });
    }

    const gsUrl = `${GETSALES_BASE}/leads/api/leads/${encodeURIComponent(uuid)}`;
    const gsRes = await fetch(gsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${getGetsalesKey()}`,
        'Content-Type': 'application/json',
      },
    });

    if (!gsRes.ok) {
      const errText = await gsRes.text();
      console.error('[leads] GetSales GET error:', gsRes.status, errText);
      return NextResponse.json(
        { error: `GetSales API error: ${gsRes.status}`, details: errText },
        { status: gsRes.status }
      );
    }

    const data = await gsRes.json();
    // GetSales wraps in { lead: {...}, markers: [...], ... }
    // Return just the lead object to the frontend
    const lead = data?.lead || data;
    return NextResponse.json({ lead });
  } catch (err) {
    console.error('[leads] Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/linkedin-conversations/leads
 * Proxy to GetSales: POST /leads/api/leads/search
 * Body: { filter, limit, offset, order_field, order_type }
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

    const gsRes = await fetch(`${GETSALES_BASE}/leads/api/leads/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getGetsalesKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!gsRes.ok) {
      const errText = await gsRes.text();
      console.error('[leads] GetSales search error:', gsRes.status, errText);
      return NextResponse.json(
        { error: `GetSales API error: ${gsRes.status}`, details: errText },
        { status: gsRes.status }
      );
    }

    const data = await gsRes.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[leads] POST Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}
