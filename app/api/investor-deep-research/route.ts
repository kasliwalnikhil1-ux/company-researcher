// Fetch investor deep_research for display in drawer
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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

export async function POST(req: NextRequest) {
  try {
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

    const body = await req.json();
    const investorId = typeof body?.investorId === 'string' ? body.investorId : undefined;

    if (!investorId) {
      return NextResponse.json({ error: 'investorId is required' }, { status: 400 });
    }

    const supabase = getSupabaseServiceClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Database not configured' }, { status: 500 });
    }

    const { data: investor, error: fetchError } = await supabase
      .from('investors')
      .select('deep_research')
      .eq('id', investorId)
      .single();

    if (fetchError || !investor) {
      return NextResponse.json(
        { error: 'Investor not found', details: fetchError?.message },
        { status: 404 }
      );
    }

    const deepResearch =
      investor.deep_research && typeof investor.deep_research === 'string'
        ? investor.deep_research
        : null;

    return NextResponse.json({ deep_research: deepResearch });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[investor-deep-research] Error:', msg);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
