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
 * POST /api/sender-profiles/connect-external
 * Proxy to GetSales: POST /flows/client-api/sender-profiles/connect-external
 *
 * Creates a sender profile AND automatically connects it to a LinkedIn
 * Browser using the GoLogin external ID.
 *
 * Body (required):
 *   first_name, last_name, gologin_external_id
 * Body (optional):
 *   label, schedule, smart_limits_enabled, notification_emails, browser_owner
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

    // Validate required fields
    if (!body.first_name || !body.last_name || !body.gologin_external_id) {
      return NextResponse.json(
        { error: 'Missing required fields: first_name, last_name, gologin_external_id' },
        { status: 400 }
      );
    }

    const gsRes = await fetch(
      `${GETSALES_BASE}/flows/client-api/sender-profiles/connect-external`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getGetsalesKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!gsRes.ok) {
      const errText = await gsRes.text();
      console.error('[sender-profiles/connect-external] GetSales POST error:', gsRes.status, errText);
      return NextResponse.json(
        { error: `GetSales API error: ${gsRes.status}`, details: errText },
        { status: gsRes.status }
      );
    }

    const data = await gsRes.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error('[sender-profiles/connect-external] POST Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}
