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
 * GET /api/linkedin-conversations/sender-profiles
 * Proxy to GetSales: GET /flows/api/sender-profiles
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
    const params = new URLSearchParams();
    url.searchParams.forEach((value, key) => {
      params.append(key, value);
    });

    if (!params.has('limit')) params.set('limit', '50');
    if (!params.has('offset')) params.set('offset', '0');

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
      console.error('[sender-profiles] GetSales error:', gsRes.status, errText);
      return NextResponse.json(
        { error: `GetSales API error: ${gsRes.status}`, details: errText },
        { status: gsRes.status }
      );
    }

    const data = await gsRes.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[sender-profiles] Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}
