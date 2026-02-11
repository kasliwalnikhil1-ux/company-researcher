// /app/api/admin-stats/route.ts
// Returns investor admin stats via Supabase RPC (service role).
// Restricted to ME_DATA_ALLOWED_USER_IDS.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

function getSupabaseServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
}

function getSupabaseAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export async function GET(req: NextRequest) {
  try {
    // Authenticate user
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const authClient = getSupabaseAuthClient(token);
    if (!authClient) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 });
    }

    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    if (!ALLOWED_USER_IDS.has(user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Call the RPC with service role
    const serviceClient = getSupabaseServiceClient();
    if (!serviceClient) {
      return NextResponse.json({ error: 'Service role not configured' }, { status: 500 });
    }

    const { data, error } = await serviceClient.rpc('get_investor_admin_stats');

    if (error) {
      console.error('RPC error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // RPC may return a single object, an array with one element, or a JSON string
    let result = data;
    if (Array.isArray(result)) {
      result = result[0] ?? {};
    }
    if (typeof result === 'string') {
      try { result = JSON.parse(result); } catch { /* keep as-is */ }
    }

    return NextResponse.json(result ?? {});
  } catch (err) {
    console.error('Admin stats error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
