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
 * POST /api/data-pipelines/missing-deep-research
 *
 * Find all investors whose deep_research column is null or empty.
 * Optionally filter by type (firm/person).
 *
 * Body: { type?: 'firm' | 'person' }
 * Returns: { count: number, investors: { id, name, type, domain, linkedin_url, updated_at }[] }
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

    const body = await request.json().catch(() => ({}));
    const { type } = body as { type?: string };

    // Fetch investors where deep_research is null
    let queryNull = supabase
      .from('investors')
      .select('id, name, type, domain, linkedin_url, updated_at')
      .is('deep_research', null)
      .order('updated_at', { ascending: false });

    // Fetch investors where deep_research is empty string
    let queryEmpty = supabase
      .from('investors')
      .select('id, name, type, domain, linkedin_url, updated_at')
      .eq('deep_research', '')
      .order('updated_at', { ascending: false });

    if (type && (type === 'firm' || type === 'person')) {
      queryNull = queryNull.eq('type', type);
      queryEmpty = queryEmpty.eq('type', type);
    }

    const [nullResult, emptyResult] = await Promise.all([queryNull, queryEmpty]);

    if (nullResult.error) {
      console.error('[missing-deep-research] Failed to fetch null investors:', nullResult.error);
      return NextResponse.json({ error: 'Failed to fetch investors', details: nullResult.error.message }, { status: 500 });
    }
    if (emptyResult.error) {
      console.error('[missing-deep-research] Failed to fetch empty investors:', emptyResult.error);
      return NextResponse.json({ error: 'Failed to fetch investors', details: emptyResult.error.message }, { status: 500 });
    }

    // Merge and deduplicate by id
    const seenIds = new Set<string>();
    const investors: typeof nullResult.data = [];
    for (const inv of [...(nullResult.data || []), ...(emptyResult.data || [])]) {
      if (!seenIds.has(inv.id)) {
        seenIds.add(inv.id);
        investors.push(inv);
      }
    }

    // Sort by updated_at descending
    investors.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    return NextResponse.json({
      count: investors.length,
      investors,
    });
  } catch (error) {
    console.error('[missing-deep-research] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
