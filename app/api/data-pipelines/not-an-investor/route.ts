import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/** Allowed user IDs (same as other data-pipelines tools) */
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

export async function POST(req: NextRequest) {
  try {
    // Auth check
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
    if (!ALLOWED_USER_IDS.has(userData.user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const statusFilter: string | undefined = body?.statusFilter; // 'all' | 'not-investor' | specific error status

    const service = getServiceClient();

    // Build query
    let query = service
      .from('not_an_investor')
      .select('*')
      .order('domain', { ascending: true, nullsFirst: false });

    if (statusFilter === 'not-investor') {
      query = query.is('status', null);
    } else if (statusFilter && statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }
    // 'all' or undefined = no filter, return everything

    const { data, error } = await query;

    if (error) {
      console.error('[not-an-investor] Query error:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Compute summary counts from full data (unfiltered) for the stat cards
    const { data: allData, error: allError } = await service
      .from('not_an_investor')
      .select('status');

    let totalCount = 0;
    let notInvestorCount = 0;
    const errorCounts: Record<string, number> = {};

    if (!allError && allData) {
      totalCount = allData.length;
      for (const row of allData) {
        if (!row.status) {
          notInvestorCount++;
        } else {
          errorCounts[row.status] = (errorCounts[row.status] || 0) + 1;
        }
      }
    }

    return NextResponse.json({
      rows: data || [],
      summary: {
        totalCount,
        notInvestorCount,
        errorCount: totalCount - notInvestorCount,
        errorCounts,
      },
    });
  } catch (err) {
    console.error('[not-an-investor] Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}
