import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/** Allowed user IDs (same as Data Pipelines page) */
const ALLOWED_USER_IDS = new Set([
  '2793f3da-9340-44f4-b285-b7836bfb8591',
  'e25d5e21-13fd-46ee-a39a-4c3386b77b65',
]);

/** Auth client (anon key + user token) for verifying user identity */
function getAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !anonKey) throw new Error('Missing Supabase environment variables');
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Service role client for data queries (bypasses RLS) */
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase service role key');
  return createClient(url, key);
}

/**
 * POST /api/data-pipelines/rerun-contacts
 *
 * Fetch firms from the investors table filtered by updated_at range.
 * Body: { updatedAtFrom?: string, updatedAtTo?: string }
 * Returns: { count: number, firms: { id, name, domain, updated_at }[] }
 */
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');
    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    // Auth check with anon key
    const authClient = getAuthClient(token);
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser(token);

    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }

    if (!ALLOWED_USER_IDS.has(user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Use service role client for data queries (bypasses RLS)
    const supabase = getServiceClient();

    const body = await request.json();
    const { updatedAtFrom, updatedAtTo } = body;

    // Fetch firms filtered by updated_at
    let query = supabase
      .from('investors')
      .select('id, name, domain, updated_at, linkedin_url')
      .eq('type', 'firm')
      .not('domain', 'is', null)
      .order('updated_at', { ascending: false });

    if (updatedAtFrom) {
      query = query.gte('updated_at', updatedAtFrom);
    }
    if (updatedAtTo) {
      query = query.lte('updated_at', updatedAtTo);
    }

    const { data: firms, error: fetchError } = await query;

    if (fetchError) {
      console.error('Failed to fetch firms:', fetchError);
      return NextResponse.json({ error: 'Failed to fetch firms' }, { status: 500 });
    }

    return NextResponse.json({
      count: (firms || []).length,
      firms: firms || [],
    });
  } catch (error) {
    console.error('rerun-contacts error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
