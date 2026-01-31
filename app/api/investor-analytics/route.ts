// Fetch investor analytics for fundraising dashboard
// Uses get_investor_analytics() RPC scoped to the authenticated user
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabaseAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const supabase = getSupabaseAuthClient(token);
    if (!supabase) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 500 });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    const { data, error } = await supabase.rpc('get_investor_analytics');

    if (error) {
      console.error('[investor-analytics] RPC error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch investor analytics', details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json(data ?? {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[investor-analytics] Error:', msg);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
