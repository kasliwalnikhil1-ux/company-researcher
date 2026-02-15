import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const GETSALES_BASE = 'https://amazing.getsales.io';

/** Auth client (anon key + user token) for verifying user identity */
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
 * GET /api/linkedin-conversations
 * Proxy to GetSales: GET /flows/api/linkedin-messages
 * Query params: limit, offset, order_field, order_type, filter[...]
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

    // Forward all query params to GetSales
    const url = new URL(req.url);
    const params = new URLSearchParams();
    url.searchParams.forEach((value, key) => {
      params.append(key, value);
    });

    // Defaults
    if (!params.has('limit')) params.set('limit', '50');
    if (!params.has('offset')) params.set('offset', '0');
    if (!params.has('order_field')) params.set('order_field', 'created_at');
    if (!params.has('order_type')) params.set('order_type', 'desc');

    const gsUrl = `${GETSALES_BASE}/flows/api/linkedin-messages?${params.toString()}`;
    const gsRes = await fetch(gsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${getGetsalesKey()}`,
        'Content-Type': 'application/json',
      },
    });

    if (!gsRes.ok) {
      const errText = await gsRes.text();
      console.error('[linkedin-conversations] GetSales GET error:', gsRes.status, errText);
      return NextResponse.json(
        { error: `GetSales API error: ${gsRes.status}`, details: errText },
        { status: gsRes.status }
      );
    }

    const data = await gsRes.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[linkedin-conversations] Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/linkedin-conversations
 * Proxy to GetSales: POST /flows/api/linkedin-messages
 * Body: { sender_profile_uuid, lead_uuid, text, template_uuid?, attachments? }
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

    const gsRes = await fetch(`${GETSALES_BASE}/flows/api/linkedin-messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getGetsalesKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!gsRes.ok) {
      const errText = await gsRes.text();
      console.error('[linkedin-conversations] GetSales POST error:', gsRes.status, errText);
      return NextResponse.json(
        { error: `GetSales API error: ${gsRes.status}`, details: errText },
        { status: gsRes.status }
      );
    }

    const data = await gsRes.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[linkedin-conversations] POST Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}
