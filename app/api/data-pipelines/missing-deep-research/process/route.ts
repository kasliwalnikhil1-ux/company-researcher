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

export const maxDuration = 120;

/**
 * POST /api/data-pipelines/missing-deep-research/process
 *
 * Process a single investor by calling the investor-research API endpoint
 * with the investor's domain or linkedin_url as input. This runs the full
 * research pipeline (Step 1 + Step 2 + Step 3) to populate the deep_research column.
 *
 * Body: { investorId: string }
 * Returns: { success: true, investorId, name, result } or { error: string }
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

    const supabase = getServiceClient();

    const body = await request.json();
    const { investorId } = body;

    if (!investorId || typeof investorId !== 'string') {
      return NextResponse.json({ error: 'investorId is required' }, { status: 400 });
    }

    // Fetch investor record to get domain or linkedin_url
    const { data: investor, error: fetchError } = await supabase
      .from('investors')
      .select('id, name, type, domain, linkedin_url')
      .eq('id', investorId)
      .single();

    if (fetchError || !investor) {
      return NextResponse.json({ error: 'Investor not found' }, { status: 404 });
    }

    // Determine input for investor-research API: prefer domain, fallback to linkedin_url
    const input = investor.domain || (investor.linkedin_url ? `https://www.linkedin.com/${investor.linkedin_url}` : null);

    if (!input) {
      return NextResponse.json(
        { error: 'Investor has no domain or linkedin_url to research' },
        { status: 400 }
      );
    }

    console.log(`[missing-deep-research/process] Processing investor ${investorId} (${investor.name}) | input=${input}`);

    // Call the investor-research API endpoint
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
    const researchRes = await fetch(`${baseUrl}/api/investor-research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input,
        skipExisting: false, // We want to re-research even if it exists (since deep_research is missing)
      }),
    });

    const contentType = researchRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const errText = await researchRes.text();
      console.error('[missing-deep-research/process] Non-JSON response:', researchRes.status, errText.substring(0, 200));
      return NextResponse.json(
        { error: `Research API returned non-JSON response (${researchRes.status})` },
        { status: 502 }
      );
    }

    const researchData = await researchRes.json();

    if (!researchRes.ok) {
      console.error('[missing-deep-research/process] Research API error:', researchRes.status, researchData);
      return NextResponse.json(
        {
          error: researchData?.error || `Research API failed (${researchRes.status})`,
          details: researchData?.details,
        },
        { status: researchRes.status }
      );
    }

    // Check if skipped (already exists with deep_research) or completed
    if (researchData?.skipped) {
      console.log(`[missing-deep-research/process] Skipped investor ${investorId} (${investor.name}): ${researchData.reason}`);
      return NextResponse.json({
        success: true,
        investorId,
        name: investor.name,
        skipped: true,
        reason: researchData.reason,
      });
    }

    console.log(`[missing-deep-research/process] Completed investor ${investorId} (${investor.name})`);

    return NextResponse.json({
      success: true,
      investorId,
      name: investor.name,
      deepResearchComplete: researchData?.deep_research_complete || false,
      result: {
        entity_type: researchData?.summary?.entity_type,
        is_investor: researchData?.summary?.is_investor,
        clean_name: researchData?.summary?.clean_name,
      },
    });
  } catch (error) {
    console.error('[missing-deep-research/process] error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: 'Internal server error', details: msg }, { status: 500 });
  }
}
