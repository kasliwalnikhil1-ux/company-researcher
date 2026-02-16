import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/** Auth client (anon key + user token) for verifying user identity */
function getAuthClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!url || !anonKey) throw new Error('Missing Supabase environment variables');
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Service client (service role key) for DB operations that bypass RLS */
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase service role environment variables');
  return createClient(url, key);
}

const VALID_STAGES = [
  'reply_received',
  'meeting_scheduled',
  'demo_completed',
  'proposal_sent',
  'negotiating',
  'closed_won',
  'closed_lost',
];

/**
 * POST /api/linkedin-conversations/stages
 * Bulk fetch stages for a list of (lead_uuid, sender_profile_id) pairs.
 *
 * Body: { pairs: Array<{ lead_uuid: string; sender_profile_id: string }> }
 * Returns: { stages: Record<string, string> }
 *   where key = "lead_uuid::sender_profile_id" and value = stage
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
    const pairs: Array<{ lead_uuid: string; sender_profile_id: string }> = body.pairs || [];

    if (pairs.length === 0) {
      return NextResponse.json({ stages: {} });
    }

    const uniqueLeadUuids = [...new Set(pairs.map((p) => p.lead_uuid).filter(Boolean))];
    if (uniqueLeadUuids.length === 0) {
      return NextResponse.json({ stages: {} });
    }

    const supabase = getServiceClient();

    const { data, error } = await supabase
      .from('outreach_contacts')
      .select('lead_uuid, sender_profile_id, stage')
      .in('lead_uuid', uniqueLeadUuids);

    if (error) {
      console.error('[stages] Supabase query error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch stages', details: error.message },
        { status: 500 }
      );
    }

    const stages: Record<string, string> = {};
    for (const row of data || []) {
      const key = `${row.lead_uuid}::${row.sender_profile_id}`;
      if (row.stage) {
        stages[key] = row.stage;
      }
    }

    return NextResponse.json({ stages });
  } catch (err) {
    console.error('[stages] Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/linkedin-conversations/stages
 * Upsert a stage for a given (lead_uuid, sender_profile_id) pair.
 *
 * Body: { lead_uuid: string; sender_profile_id: string; stage: string }
 */
export async function PUT(req: NextRequest) {
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
    const { lead_uuid, sender_profile_id, stage } = body;

    if (!lead_uuid || !sender_profile_id) {
      return NextResponse.json(
        { error: 'Missing required fields: lead_uuid and sender_profile_id' },
        { status: 400 }
      );
    }

    if (!stage || !VALID_STAGES.includes(stage)) {
      return NextResponse.json(
        { error: `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}` },
        { status: 400 }
      );
    }

    const supabase = getServiceClient();

    const { error } = await supabase
      .from('outreach_contacts')
      .upsert(
        { lead_uuid, sender_profile_id, stage },
        { onConflict: 'lead_uuid,sender_profile_id' }
      );

    if (error) {
      console.error('[stages] Supabase upsert error:', error);
      return NextResponse.json(
        { error: 'Failed to update stage', details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, lead_uuid, sender_profile_id, stage });
  } catch (err) {
    console.error('[stages] PUT Unexpected error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    );
  }
}
